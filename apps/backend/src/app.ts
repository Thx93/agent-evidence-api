import { readFileSync } from "node:fs";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  SERVICE_NAME,
  SERVICE_VERSION,
  ERROR_HTTP_STATUS,
  errorResponse,
  priceString,
  type ErrorCode,
} from "@aee/schemas";
import {
  EvidenceService,
  ServiceError,
  type AppConfig,
  type Logger,
} from "@aee/core";
import type { EvidenceMcpServer } from "@aee/mcp";
import { paymentMiddleware, x402ResourceServer } from "@x402/fastify";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createCdpFacilitatorClient } from "@coinbase/cdp-sdk/x402";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { Network } from "@x402/core/types";
import { extractCredential, isPublicPath, secretMatches } from "./auth.js";
import { createUsageLog } from "./usage-log.js";
import { createRateLimiter } from "./rate-limit.js";

/**
 * What the CDP Bazaar advertises to agents that have never heard of us: the declared
 * input and output is the entire pitch a prospective buyer sees BEFORE paying.
 * Moved here with the paywall, because the discovery declaration and the payment
 * gate have to describe the same route.
 */
const HTTP_DISCOVERY = declareDiscoveryExtension({
  bodyType: "json",
  input: {
    question: "Is Company X a manufacturer of centrifugal pumps?",
    urls: ["https://company.example/about", "https://company.example/products"],
    max_sources: 5,
    language: "auto",
    mode: "evidence",
  },
  output: {
    example: {
      request_id: "req_1f2e3d4c5b6a7988",
      version: "1",
      question: "Is Company X a manufacturer of centrifugal pumps?",
      assessment: {
        status: "supported",
        basis:
          "1 source(s) contained passages matching the question (company.example) with no contradicting passages found.",
      },
      sources: [
        {
          requested_url: "https://company.example/about",
          final_url: "https://company.example/about",
          status: 200,
          content_type: "text/html; charset=utf-8",
          title: "Company X - About",
          canonical_url: "https://company.example/about",
          publisher: "Company X",
          language: "en",
          retrieved_at: "2026-01-01T00:00:00.000Z",
          word_count: 412,
          content_hash_sha256: "9f2c…",
          evidence: [
            {
              excerpt: "Company X manufactures centrifugal pumps at its facility.",
              context: "h2:Products > p[1]",
              relevance: "direct",
            },
          ],
          warnings: [],
        },
      ],
      limitations: [
        "Assessment is derived from deterministic lexical matching, not semantic reasoning.",
      ],
      processing_ms: 812,
    },
  },
});

export interface BuildAppDeps {
  config: AppConfig;
  logger: Logger;
  service: EvidenceService;
  mcp: EvidenceMcpServer;
  /** Shared with the MCP adapter so both routes write to one usage log. */
  usage?: ReturnType<typeof createUsageLog>;
}

function newRequestId(): string {
  return `req_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/**
 * Resolve the rate-limit key for a request.
 *
 * The backend sits behind the Cloudflare Worker, so `req.ip` is the Worker's
 * socket address, not the end client's. The key is chosen in this order:
 *
 *   1. `cf-connecting-ip` — set by Cloudflare to the real client address.
 *   2. the first entry of `x-forwarded-for` — the original client when a proxy
 *      chain is present.
 *   3. `req.ip` — the direct socket peer, i.e. the Worker. A coarse fallback.
 *
 * The Worker must forward `CF-Connecting-IP` for per-client limiting to be
 * meaningful; without it every caller shares the Worker's bucket, which still
 * bounds aggregate load but cannot isolate one noisy client. Because the
 * internal API is authenticated, a caller cannot reach this hook while
 * spoofing the header — only the Worker can.
 */
export function clientKey(req: FastifyRequest): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string") {
    const value = cf.trim();
    if (value.length > 0) return value;
  }

  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    const first = forwarded.split(",")[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }

  return req.ip;
}

/**
 * Build the Fastify instance.
 *
 * Exported separately from `server.ts` so tests can build an app against a
 * stub service and drive it with `app.inject()` — no listening socket needed.
 */
export function buildApp(deps: BuildAppDeps): FastifyInstance {
  const { config, logger, service, mcp } = deps;

  // One line per served request. NOTE: a request carries a payment proof, but
  // settlement happens after this process responds, so these lines are not proof
  // of payment. See usage-log.ts.
  //
  // Injected when the caller also needs it - the MCP adapter reports its paid
  // tool calls through the same instance, so both routes land in one file.
  const usage = deps.usage ?? createUsageLog({ path: config.usageLogPath });

  const app = Fastify({
    // Trust no proxy headers by default; the Worker sets x-request-id itself.
    trustProxy: false,
    disableRequestLogging: true,
    // Bounded body: the API takes a question plus a handful of URLs.
    bodyLimit: 256 * 1024,
    genReqId: () => newRequestId(),
  });

  // ---------------------------------------------------------------- auth ---
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split("?")[0] ?? req.url;
    if (isPublicPath(path)) return;

    const credential = extractCredential(req.headers as Record<string, unknown>);
    if (!secretMatches(credential, config.backendAuthSecret)) {
      logger.warn("unauthenticated request rejected", {
        request_id: req.id,
        method: req.method,
        path,
      });
      // No hint about whether the header was absent, malformed, or wrong.
      return reply
        .code(ERROR_HTTP_STATUS.UNAUTHORIZED)
        .send(errorResponse("UNAUTHORIZED", req.id));
    }
  });

  // ---------------------------------------------------------- rate limit ---
  // Registered AFTER the auth hook, so an unauthenticated request is answered
  // with 401 and never consumes a token. One bounded token bucket per client
  // key; refill is lazy, so this adds no timers or background work.
  const rateLimiter = createRateLimiter(config.rateLimit);
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split("?")[0] ?? req.url;
    // The liveness probe must always answer, even for a throttled client.
    if (path === "/health") return;

    const key = clientKey(req);
    const decision = rateLimiter.check(key);
    if (decision.allowed) return;

    logger.warn("request rate limit exceeded", {
      request_id: req.id,
      // Neutral field name, per AGENTS.md section 7: structured logs are
      // sanitised and the logger redacts keys that look secret-bearing. The
      // address is not logged under an `ip`-style key.
      client: key,
      retry_after_seconds: decision.retryAfterSeconds,
    });

    return reply
      .code(ERROR_HTTP_STATUS.RATE_LIMIT)
      .header("retry-after", String(decision.retryAfterSeconds))
      .send(errorResponse("RATE_LIMIT", req.id));
  });

  // ------------------------------------------------------------ logging ----
  app.addHook("onResponse", async (req: FastifyRequest, reply: FastifyReply) => {
    logger.info("request", {
      request_id: req.id,
      method: req.method,
      path: req.url.split("?")[0],
      status: reply.statusCode,
      duration_ms: Math.round(reply.elapsedTime),
      // SPEC section 24: enough to diagnose a failure without logging secrets.
      // Absent on routes that do no fetching, which keeps the probe quiet.
      ...(summaryFor(req) ?? {}),
    });
  });

  /**
   * SPEC section 24 requires the request log to record the source counts, cache
   * hits, payment outcome and error code. The route knows them; the onResponse
   * hook emits them. A WeakMap keyed by the request carries them between the two
   * without mutating the request object or risking a leak.
   */
  interface RequestSummary {
    sources_total: number;
    sources_ok: number;
    sources_failed: number;
    cache_hits: number;
    /** A payment proof was present. Only the Worker can verify one. */
    payment_provided: boolean;
    error_code: string | null;
  }
  const summaries = new WeakMap<object, RequestSummary>();
  const summaryFor = (req: FastifyRequest): RequestSummary | undefined => summaries.get(req);
  const recordSummary = (req: FastifyRequest, summary: RequestSummary): void => {
    summaries.set(req, summary);
  };

  // ------------------------------------------------------- x402 paywall ---
  //
  // The payment boundary lives HERE rather than at the Cloudflare edge, and that
  // move is the whole point of this block.
  //
  // The CDP Facilitator is the only route into the CDP Bazaar - which reaches tens
  // of thousands of agents through the Bazaar MCP server, Amazon Bedrock AgentCore,
  // and Coinbase's own agentic.market. Two Cloudflare Workers restrictions made it
  // impossible there, neither of them a configuration problem:
  //
  //   1. The CDP SDK's JWT signing reaches an undefined `getRandomValues`, because
  //      `nodejs_compat` selects the Node build of the `uncrypto` shim and workerd's
  //      `node:crypto` has no usable `webcrypto`.
  //   2. The x402 library compiles its bazaar schema with `new Function`, which
  //      Workers forbids by design. No bundler setting changes that.
  //
  // Node has neither restriction. The Worker now forwards, and this enforces.
  // eip155:8453 is Base mainnet. The bypass requires a non-mainnet network as well
  // as the flag, so it cannot silently make the real service free.
  const MAINNET = "eip155:8453";
  const paywallActive = !(config.x402.devBypassPayment && config.x402.network !== MAINNET);

  const useCdp = Boolean(config.x402.cdpApiKeyId && config.x402.cdpApiKeySecret);
  const facilitator = useCdp
    ? createCdpFacilitatorClient({
        apiKeyId: config.x402.cdpApiKeyId,
        apiKeySecret: config.x402.cdpApiKeySecret,
      })
    : new HTTPFacilitatorClient({ url: config.x402.facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitator).register(
    config.x402.network as Network,
    new ExactEvmScheme(),
  );

  if (paywallActive) paymentMiddleware(
    app,
    {
      "POST /internal/v1/evidence": {
        // Advertise the PUBLIC url. Without this the challenge names the internal
        // origin the middleware can see (http://127.0.0.1:8080/internal/...), which
        // would confuse a buyer and fail CDP's validator.
        ...(config.x402.publicResourceUrl
          ? { resource: config.x402.publicResourceUrl }
          : {}),
        accepts: {
          scheme: "exact",
          price: priceString(config.x402.priceUsd),
          network: config.x402.network as Network,
          payTo: config.x402.recipient,
        },
        // Shown to buyers browsing the x402 catalogue, where one line is the whole
        // pitch. The Bazaar's search is keyword based, not semantic, so a buyer
        // searching "verify a claim" or "cited evidence" only finds this if those
        // words appear. Each phrase states what the service does.
        description:
          "Verify a claim or fact check a statement against public web sources: send a " +
          "question and up to 5 URLs, get cited evidence - passages that support, " +
          "contradict or fail to settle it. Claim verification with a citation for every " +
          "excerpt: source URL, retrieval time, content hash. Never charges when nothing " +
          "is retrieved.",
        serviceName: SERVICE_NAME,
        tags: ["web-evidence", "claim-verification", "source-verification"],
        // Without this the validator reports "No bazaar extension in top-level
        // extensions object" and the route is not catalogued.
        extensions: { ...HTTP_DISCOVERY },
      },
    },
    resourceServer,
  );

  logger.info(paywallActive ? "x402 paywall active" : "x402 paywall BYPASSED", {
    facilitator: useCdp ? "cdp" : "http",
    network: config.x402.network,
    price_usd: config.x402.priceUsd,
    bypassed: !paywallActive,
  });

  // ------------------------------------------------------------- routes ----
  /** Free liveness probe. Never reports secrets or infrastructure detail. */
  // Report the CONFIGURED version, not the compiled constant. The MCP server
  // reports `config.serviceVersion` (its serverInfo and its health tool), so
  // using the constant here let the two interfaces disagree: with a stale
  // SERVICE_VERSION in the environment, /health said 0.1.1 while the MCP
  // handshake said 0.1.0. One runtime source removes that class of drift.
  app.get("/health", async (_req, reply) =>
    reply.send({ status: "ok" as const, service: SERVICE_NAME, version: config.serviceVersion }),
  );

  /**
   * The zero-install buyer CLI.
   *
   * Served from here so a buyer needs no npm account and no install step:
   *   curl -fsSL <public-url>/buy.mjs -o buy.mjs && node buy.mjs "question" https://src
   *
   * It is a build artifact (scripts/build-buyer.sh), read once at startup and
   * held in memory. Public by design and contains no secrets.
   */
  app.get("/buy.mjs", async (_req, reply) => {
    const cli = loadBuyerCli();
    if (!cli) {
      return reply
        .code(503)
        .send(errorResponse("NOT_CONFIGURED", "buyer-cli", "The buyer CLI is not bundled in this image."));
    }
    return reply
      .header("content-type", "text/javascript; charset=utf-8")
      .header("cache-control", "public, max-age=300")
      .send(cli);
  });

  /**
   * Internal evidence endpoint.
   *
   * "Internal" in the sense that it requires the Worker's shared secret — it is
   * not callable by customers. The public, x402-gated equivalent is
   * POST /v1/evidence on the Worker.
   */
  app.post("/internal/v1/evidence", async (req: FastifyRequest, reply: FastifyReply) => {
    const requestId = String(req.id);
    const started = Date.now();
    const body = (req.body ?? {}) as { question?: unknown; urls?: unknown };
    const question = typeof body.question === "string" ? body.question : "";
    // The Worker forwards the x402 proof, so this distinguishes a buyer's request
    // from an operator or test call. It does NOT indicate settlement: the
    // facilitator settles after this response. See usage-log.ts.
    const paymentProvided = Boolean(req.headers["payment-signature"]);
    const urlsRequested = Array.isArray(body.urls) ? body.urls.length : 0;

    try {
      const result = await service.execute(req.body, requestId);

      // Reaching this point means the Worker's x402 gate already accepted a
      // payment, so this is a revenue event.
      await usage.record({
        ts: new Date().toISOString(),
        request_id: requestId,
        question_hash: usage.hashQuestion(question),
        question_chars: question.length,
        sources_requested: urlsRequested,
        sources_retrieved: result.sources.filter((s) => s.status === 200).length,
        evidence_items: result.sources.reduce((n, s) => n + s.evidence.length, 0),
        assessment: result.assessment.status,
        processing_ms: result.processing_ms,
        outcome: "ok",
        payment_provided: paymentProvided,
      });

      recordSummary(req, {
        sources_total: result.sources.length,
        // "ok" means usable content. A source that answered 404 has a status but
        // is still a failed fetch, so failed is the complement of ok rather than
        // a count of null-status sources.
        sources_ok: result.sources.filter((s) => s.status === 200).length,
        sources_failed: result.sources.filter((s) => s.status !== 200).length,
        cache_hits: result.sources.filter((s) => s.from_cache).length,
        payment_provided: paymentProvided,
        error_code: null,
      });
      return reply.code(200).send(result);
    } catch (err) {
      await usage.record({
        ts: new Date().toISOString(),
        request_id: requestId,
        question_hash: usage.hashQuestion(question),
        question_chars: question.length,
        sources_requested: urlsRequested,
        sources_retrieved: 0,
        evidence_items: 0,
        assessment: "n/a",
        processing_ms: Date.now() - started,
        outcome: "error",
        error_code: err instanceof ServiceError ? err.code : "INTERNAL_ERROR",
        payment_provided: paymentProvided,
      });
      recordSummary(req, {
        sources_total: urlsRequested,
        sources_ok: 0,
        sources_failed: urlsRequested,
        cache_hits: 0,
        payment_provided: paymentProvided,
        error_code: err instanceof ServiceError ? err.code : "INTERNAL_ERROR",
      });
      return sendServiceError(reply, err, requestId, logger);
    }
  });

  // ---------------------------------------------------------------- MCP ----
  // All MCP verbs are handed to the same server instance the API uses. Payment
  // for the paid tool is enforced at the Worker, before the request gets here.
  const mcpVerbs = ["POST", "GET", "DELETE"] as const;
  for (const verb of mcpVerbs) {
    app.route({
      method: verb,
      url: "/mcp",
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        // Hand the raw sockets to the MCP transport; Fastify must not try to
        // serialise the response itself.
        reply.hijack();
        try {
          await mcp.handleNodeRequest(req.raw, reply.raw, req.body);
        } catch (err) {
          logger.error("mcp handler failed", {
            request_id: req.id,
            error: err instanceof Error ? err.message : String(err),
          });
          if (!reply.raw.headersSent) {
            reply.raw.writeHead(500, { "content-type": "application/json" });
          }
          reply.raw.end(
            JSON.stringify(errorResponse("INTERNAL_ERROR", String(req.id))),
          );
        }
      },
    });
  }

  // ------------------------------------------------------------- errors ----
  app.setNotFoundHandler((req, reply) =>
    reply
      .code(404)
      .send(
        errorResponse(
          "NOT_FOUND",
          String(req.id),
          `No such endpoint: ${req.method} ${req.url.split("?")[0]}`,
        ),
      ),
  );

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    // Never expose a stack trace to a caller.
    logger.error("unhandled error", {
      request_id: req.id,
      error: err.message,
    });
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    const code: ErrorCode = status === 400 ? "INVALID_REQUEST" : "INTERNAL_ERROR";
    return reply.code(status).send(errorResponse(code, String(req.id)));
  });

  return app;
}

/** Read the bundled buyer CLI once and keep it in memory. */
let buyerCliCache: string | null | undefined;
function loadBuyerCli(): string | null {
  if (buyerCliCache !== undefined) return buyerCliCache;
  try {
    buyerCliCache = readFileSync(new URL("../public/x402-evidence.mjs", import.meta.url), "utf8");
  } catch {
    buyerCliCache = null;
  }
  return buyerCliCache;
}

/** Map a thrown error onto the canonical error envelope. */
function sendServiceError(
  reply: FastifyReply,
  err: unknown,
  requestId: string,
  logger: Logger,
) {
  if (err instanceof ServiceError) {
    const status = ERROR_HTTP_STATUS[err.code] ?? 500;
    // Client errors are expected; only log them at debug level.
    if (status >= 500) {
      logger.error("service error", { request_id: requestId, code: err.code });
    } else {
      logger.debug("service rejected request", { request_id: requestId, code: err.code });
    }
    return reply
      .code(status)
      .send(errorResponse(err.code, requestId, err.message, err.details));
  }

  logger.error("unexpected service failure", {
    request_id: requestId,
    error: err instanceof Error ? err.message : String(err),
  });
  return reply.code(500).send(errorResponse("INTERNAL_ERROR", requestId));
}
