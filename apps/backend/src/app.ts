import { readFileSync } from "node:fs";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  SERVICE_NAME,
  SERVICE_VERSION,
  ERROR_HTTP_STATUS,
  errorResponse,
  priceAtomicUnits,
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
import {
  FastifyAdapter,
  paymentMiddlewareFromHTTPServer,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/fastify";
import {
  HTTPFacilitatorClient,
  attachBackgroundInitHandler,
  type HTTPRequestContext,
} from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createCdpFacilitatorClient } from "@coinbase/cdp-sdk/x402";
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
  validateBazaarRouteExtensions,
} from "@x402/extensions/bazaar";
import type { Network } from "@x402/core/types";
import { extractCredential, isPublicPath, secretMatches } from "./auth.js";
import { createUsageLog } from "./usage-log.js";
import { createRateLimiter } from "./rate-limit.js";
import {
  captureResponse,
  mcpResponseFailed,
  needsMcpPayment,
  type CapturedResponse,
} from "./mcp-paywall.js";

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

/**
 * The discovery declaration for the MCP route, moved here with its paywall.
 *
 * This is the part that matters for the Bazaar MCP server. The x402 catalogue is
 * populated per route when a payment settles, so while the MCP gate lived at the
 * edge on the generic facilitator, `research_evidence` was never catalogued and
 * therefore never enumerable by the one discovery path that does not depend on a
 * buyer guessing a keyword.
 *
 * `transport` is optional in the SDK's type but present in every MCP entry that is
 * actually catalogued; without it the entry describes a tool but never says how to
 * reach it. Only 5 of the 11 well-formed MCP entries in the live catalogue show a
 * buyer what a call returns, so the `output.example` is deliberate: it shows the
 * actual deliverable (a cited excerpt plus an assessment) instead of a signature.
 */
const MCP_DISCOVERY = declareDiscoveryExtension({
  toolName: "research_evidence",
  transport: "streamable-http",
  // Wording is a discovery lever, not decoration. The Bazaar's search is keyword
  // based and does not stem, so a buyer searching "claim verification" or "cited
  // evidence" only finds this if those exact word forms appear. Every clause below
  // states what the service does; the phrases are rare across the catalogue, so
  // their presence is not neutral.
  description:
    "Claim verification and evidence extraction from public web sources. Fetches " +
    "the URLs you name, compares your sources, and returns source-grounded web " +
    "evidence: cited passages that support or contradict your question, each with " +
    "a citation - source URL, retrieval time, content hash.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", minLength: 1, maxLength: 2000 },
      urls: { type: "array", items: { type: "string" }, maxItems: 25 },
      max_sources: { type: "integer", minimum: 1, maximum: 25 },
      language: { type: "string" },
      mode: { type: "string", enum: ["evidence"] },
    },
    required: ["question"],
    additionalProperties: false,
  },
  example: {
    question: "Is Company X a manufacturer of centrifugal pumps?",
    urls: ["https://company.example/about"],
  },
  output: {
    example: {
      assessment: { status: "supported", basis: "1 source matched the question." },
      sources: [
        {
          final_url: "https://company.example/about",
          status: 200,
          title: "Company X - About",
          retrieved_at: "2026-01-01T00:00:00.000Z",
          content_hash_sha256: "9f2c…",
          evidence: [
            {
              relevance: "direct",
              excerpt: "Company X manufactures centrifugal pumps at its facility.",
            },
          ],
        },
      ],
      limitations: ["Assessment uses deterministic lexical matching, not semantic reasoning."],
    },
  },
});

/**
 * One line shown to buyers browsing the x402 catalogue, where it is the whole
 * pitch. Shared by the HTTP and MCP routes so the two listings cannot drift.
 */
const CATALOGUE_DESCRIPTION =
  "Verify a claim or fact check a statement against public web sources: send a " +
  "question and up to 5 URLs, get cited evidence - passages that support, " +
  "contradict or fail to settle it. Claim verification with a citation for every " +
  "excerpt: source URL, retrieval time, content hash. Never charges when nothing " +
  "is retrieved.";

const CATALOGUE_TAGS = ["web-evidence", "claim-verification", "source-verification"];

/**
 * The x402 context for one verified but not yet settled MCP call.
 *
 * `requestContext` is the HTTP context this backend built, not part of the
 * library's result, but `processSettlement` needs it back for the settlement
 * payload.
 */
interface VerifiedMcpCall {
  result: Extract<
    Awaited<ReturnType<x402HTTPResourceServer["processHTTPRequest"]>>,
    { type: "payment-verified" }
  >;
  requestContext: HTTPRequestContext;
}

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

  // Registered explicitly rather than left to the framework adapter, because two
  // x402 HTTP resource servers (HTTP and MCP) now share this one resource server
  // and the registration must not depend on which adapter ran first.
  resourceServer.registerExtension(bazaarResourceServerExtension);

  /** The single payment option both paid routes quote. */
  const paymentOption = {
    scheme: "exact",
    price: priceString(config.x402.priceUsd),
    network: config.x402.network as Network,
    payTo: config.x402.recipient,
  };

  /**
   * The default 402 body is literally `{}` — useless to a buyer debugging their
   * payment. Distinguish "you sent nothing" from "what you sent was rejected".
   */
  const unpaidResponseBody = ({ paymentHeader }: { paymentHeader?: string }) => ({
    contentType: "application/json",
    body: JSON.stringify(
      errorResponse(
        paymentHeader ? "PAYMENT_INVALID" : "PAYMENT_REQUIRED",
        newRequestId(),
        paymentHeader
          ? "The supplied payment could not be verified. It may be malformed, expired, for the wrong network, or for an amount below the quoted price."
          : "This endpoint requires payment. See https://agent-evidence-api.thx93.workers.dev/ for the terms.",
      ),
    ),
  });

  const HTTP_ROUTES = {
    "POST /internal/v1/evidence": {
      // Advertise the PUBLIC url. Without this the challenge names the internal
      // origin the middleware can see (http://127.0.0.1:8080/internal/...), which
      // would confuse a buyer and fail CDP's validator.
      ...(config.x402.publicResourceUrl ? { resource: config.x402.publicResourceUrl } : {}),
      accepts: paymentOption,
      description: CATALOGUE_DESCRIPTION,
      serviceName: SERVICE_NAME,
      tags: CATALOGUE_TAGS,
      // Without this the validator reports "No bazaar extension in top-level
      // extensions object" and the route is not catalogued.
      extensions: { ...HTTP_DISCOVERY },
      unpaidResponseBody,
    },
  };

  const MCP_ROUTE_KEY = "POST /mcp";
  const MCP_ROUTES = {
    [MCP_ROUTE_KEY]: {
      // Same reasoning as the HTTP route: the request the backend sees is the
      // internal origin, so a buyer or catalogue must be shown the public address.
      // The value is derived from X402_RESOURCE_URL when it is not set explicitly
      // (see deriveMcpResourceUrl).
      ...(config.x402.publicMcpResourceUrl
        ? { resource: config.x402.publicMcpResourceUrl }
        : {}),
      accepts: paymentOption,
      description: CATALOGUE_DESCRIPTION,
      serviceName: SERVICE_NAME,
      tags: CATALOGUE_TAGS,
      extensions: { ...MCP_DISCOVERY },
      unpaidResponseBody,
      // Verification can succeed while settlement fails (for example the buyer's
      // balance moved between the two). Do not leave them guessing.
      settlementFailedResponseBody: () => ({
        contentType: "application/json",
        body: JSON.stringify(
          errorResponse(
            "PAYMENT_INVALID",
            newRequestId(),
            "The payment was verified but could not be settled on-chain, so the request was not served and you were not charged for a result.",
          ),
        ),
      }),
    },
  };

  // Constructing a server validates its routes' scheme and payment flow locally
  // (no facilitator needed). The two are separate so that MCP can be gated from a
  // preHandler — where the body exists — without the HTTP route's global
  // `onRequest` hook ever seeing an MCP request.
  const httpServer = new x402HTTPResourceServer(resourceServer, HTTP_ROUTES);
  const mcpHttpServer = new x402HTTPResourceServer(resourceServer, MCP_ROUTES);

  // Warns (does not throw) on a malformed discovery declaration; it compiles the
  // bazaar schema with Ajv, which is one of the two reasons this cannot run in a
  // Worker. Only the HTTP route is checked: for an MCP route the library's
  // `withSyntheticMethod` injects a `method` field into `info.input` before
  // validating, which the MCP schema (correctly) forbids, so it always reports a
  // false "invalid bazaar extension" for a pattern carrying an HTTP verb. The
  // served declaration is not touched by that copy — the MCP challenge's shape is
  // asserted in tests/e2e/mcp-paywall.test.ts instead.
  validateBazaarRouteExtensions(HTTP_ROUTES);

  /**
   * One facilitator handshake for the process, deferred to the first paid request
   * and retried after a transient failure.
   *
   * Both HTTP resource servers call `initialize()` on the same underlying resource
   * server, so they are run in sequence rather than concurrently: a concurrent
   * pair interleaves `clear()` and repopulate, and the loser's route validation can
   * observe an empty facilitator map and abort startup. Sequentially the second
   * call is a redundant but harmless refetch.
   *
   * Deliberately NOT awaited for the free MCP discovery surface: `tools/list` and
   * `initialize` must answer even when the facilitator is unreachable, or an agent
   * cannot see the tool it would have to pay for.
   */
  let initPromise: Promise<void> | null = null;
  const ensurePaidRoutesReady = (): Promise<void> => {
    if (!initPromise) {
      const attempt = (async () => {
        await httpServer.initialize();
        await mcpHttpServer.initialize();
      })().catch((err: unknown) => {
        // Transient (facilitator timeout) — allow the next paid request to retry.
        initPromise = null;
        throw err;
      });
      initPromise = attempt;
      // Fatal configuration errors (unsupported scheme/network) exit the process
      // instead of leaving a listener that can never charge.
      attachBackgroundInitHandler(attempt);
    }
    return initPromise;
  };

  if (paywallActive) {
    // Must run BEFORE the middleware's own `onRequest` hook, which calls
    // `processHTTPRequest` against the resource server. Scoped to the paid HTTP
    // route so a free request never waits on the facilitator.
    app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
      const path = req.url.split("?")[0] ?? req.url;
      if (path !== "/internal/v1/evidence") return;
      try {
        await ensurePaidRoutesReady();
      } catch (err) {
        logger.error("payment facilitator unavailable", {
          request_id: req.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return reply
          .code(ERROR_HTTP_STATUS.BACKEND_UNREACHABLE)
          .send(
            errorResponse(
              "BACKEND_UNREACHABLE",
              String(req.id),
              "The payment facilitator could not be reached, so no payment was taken. Please retry.",
            ),
          );
      }
    });

    // `syncFacilitatorOnStart: false` — initialization is owned by
    // `ensurePaidRoutesReady` above, so the library's own eager sync (and the
    // concurrent double-init it would cause) is disabled.
    paymentMiddlewareFromHTTPServer(app, httpServer, undefined, undefined, false);
  }

  logger.info(paywallActive ? "x402 paywall active" : "x402 paywall BYPASSED", {
    facilitator: useCdp ? "cdp" : "http",
    network: config.x402.network,
    price_usd: config.x402.priceUsd,
    // Whether each paid route advertises a public address, without printing the
    // address itself. A false here is the defect that a catalogue would index.
    http_resource_public: config.x402.publicResourceUrl.length > 0,
    mcp_resource_public: config.x402.publicMcpResourceUrl.length > 0,
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
   * The host's x402 capability manifest (`draft-hawkins-x402-dns-discovery`) —
   * the machine-readable record of how to pay for this host, which crawlers and
   * indexes fetch directly.
   *
   * Built HERE, from `config.x402`, so the manifest and the 402 challenge cannot
   * disagree. It used to be assembled at the edge from the Worker's own
   * `X402_*` variables: a second, display-only copy of the terms that drifted
   * silently from what was actually charged. That copy also described both
   * resources with one shared `accepts` entry, so the MCP resource advertised
   * `resource: …/v1/evidence` and a crawler could not work out how to pay for
   * `/mcp` at all.
   *
   * Payment terms MUST ride on each resource. A manifest that lists only a URL
   * and a description leaves crawlers unable to learn the chain — Agent402 calls
   * that outcome "listed and unroutable", row `chainless`, reason
   * `network_unknown`. Each entry therefore carries its own `accepts`, in the
   * same shape the live 402 returns, describing the resource it is attached to.
   */
  app.get("/.well-known/x402", async (req: FastifyRequest, reply: FastifyReply) => {
    const httpResource = config.x402.publicResourceUrl;
    const mcpResource = config.x402.publicMcpResourceUrl;

    // The public origin for `docs`. Without an explicit public URL the best we
    // have is the request as this process sees it, which behind the Worker is
    // the internal origin — so prefer the configured one.
    const base = (() => {
      const known = httpResource || mcpResource;
      if (known) {
        try {
          return new URL(known).origin;
        } catch {
          // A malformed setting falls through to the request rather than throwing.
        }
      }
      return `${req.protocol}://${req.hostname}`;
    })();

    /**
     * One `accepts` entry, describing how to pay for a single resource.
     *
     * `resource` is the resource this entry rides on — the same value as its
     * container — so a reader can never pair a price with the wrong endpoint.
     */
    const accept = (resource: string) => ({
      scheme: "exact",
      network: config.x402.network,
      // USDC on Base mainnet is the settlement asset (SPEC section 11).
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: config.x402.recipient,
      amount: priceAtomicUnits(config.x402.priceUsd),
      maxTimeoutSeconds: 300,
      resource,
      extra: { name: "USD Coin", version: "2" },
    });

    return reply
      .header("cache-control", "public, max-age=300")
      // Read cross-origin by crawlers and indexes.
      .header("access-control-allow-origin", "*")
      .send({
        x402Version: 2,
        kind: "resource-server",
        name: "Agent Evidence API",
        description:
          "Cited, source-grounded web evidence for AI agents. Send a question and up to " +
          "5 public URLs; get back the passages that support, contradict or fail to settle " +
          "it, each with its source URL, retrieval time and content hash. Never charges when " +
          "nothing is retrieved.",
        resources: [
          {
            url: httpResource,
            method: "POST",
            // The indexed description IS the search surface. Agent402 reads this into
            // its own index and ranks on match score first, so say what the caller
            // gets using the words a caller would type.
            description:
              "Verify a claim or fact check a statement against public web sources: send a " +
              "question and up to 5 URLs, get cited evidence - the passages that support, " +
              "contradict or fail to settle it, each with its source URL, retrieval time and " +
              "content hash. Claim verification and evidence extraction for AI agents. Never " +
              "charges when nothing is retrieved.",
            accepts: [accept(httpResource)],
          },
          {
            url: mcpResource,
            method: "POST",
            description:
              "MCP tool research_evidence: verify a claim or answer a question against public " +
              "web sources, returning cited evidence with a citation for every excerpt. " +
              "Claim verification, evidence extraction and source-grounded research over MCP " +
              "streamable HTTP. Free tools: health and tools/list.",
            accepts: [accept(mcpResource)],
          },
        ],
        attestation: { type: "none" },
        docs: `${base}/`,
        updated: new Date().toISOString(),
      });
  });

  /**
   * Internal evidence endpoint.
   *
   * "Internal" in the sense that it requires the Worker's shared secret — it is
   * not callable by customers. It is also the route the x402 middleware above
   * protects, so by the time this handler runs a payment has been verified. The
   * public equivalent is `POST /v1/evidence` on the Worker, which proxies here.
   */
  app.post("/internal/v1/evidence", async (req: FastifyRequest, reply: FastifyReply) => {
    const requestId = String(req.id);
    const started = Date.now();
    const body = (req.body ?? {}) as { question?: unknown; urls?: unknown };
    const question = typeof body.question === "string" ? body.question : "";
    // The Worker forwards the x402 proof and the middleware above verified it, so
    // this distinguishes a buyer's request from an operator or test call. It does
    // NOT indicate settlement: the facilitator settles after this response. See
    // usage-log.ts.
    const paymentProvided = Boolean(req.headers["payment-signature"]);
    const urlsRequested = Array.isArray(body.urls) ? body.urls.length : 0;

    try {
      const result = await service.execute(req.body, requestId);

      // Reaching this point means the x402 middleware already accepted a payment
      // for this route.
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
  //
  // The MCP paywall, in the backend. See `mcp-paywall.ts` for why it is a
  // `preHandler` rather than the framework adapter's `onRequest` hook (the body is
  // not parsed yet at `onRequest`, so `tools/list` could not be told from
  // `tools/call`), and why it moved off the edge at all (the CDP Bazaar's MCP
  // server enumerates only routes that settle through the CDP Facilitator).

  /**
   * Verified-but-unsettled payments, keyed by request. A WeakMap rather than a
   * property on the request, so the type augmentation stays local to this file.
   */
  const mcpPayments = new WeakMap<object, VerifiedMcpCall>();

  if (paywallActive) {
    app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.method !== "POST") return;
      const path = req.url.split("?")[0] ?? req.url;
      if (path !== "/mcp") return;
      // The free discovery surface — initialize, tools/list, ping, the free
      // `health` tool — passes without touching the facilitator or the wallet.
      if (!needsMcpPayment(req.body)) return;

      try {
        await ensurePaidRoutesReady();
      } catch (err) {
        logger.error("payment facilitator unavailable", {
          request_id: req.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return reply
          .code(ERROR_HTTP_STATUS.BACKEND_UNREACHABLE)
          .send(
            errorResponse(
              "BACKEND_UNREACHABLE",
              String(req.id),
              "The payment facilitator could not be reached, so no payment was taken. Please retry.",
            ),
          );
      }

      const paymentHeader =
        (req.headers["payment-signature"] as string | undefined) ??
        (req.headers["x-payment"] as string | undefined);

      const requestContext: HTTPRequestContext = {
        adapter: new FastifyAdapter(req),
        path,
        method: req.method,
        ...(paymentHeader ? { paymentHeader } : {}),
      };

      let result: Awaited<ReturnType<typeof mcpHttpServer.processHTTPRequest>>;
      try {
        result = await mcpHttpServer.processHTTPRequest(requestContext);
      } catch (err) {
        // Verification itself failed. The buyer is shown the challenge again by
        // the facilitator's error path, but never charged: settlement only runs
        // after a handler has produced a result.
        logger.warn("mcp payment verification errored", {
          request_id: req.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return reply
          .code(ERROR_HTTP_STATUS.PAYMENT_INVALID)
          .send(
            errorResponse(
              "PAYMENT_INVALID",
              String(req.id),
              "The supplied payment could not be verified. Nothing was charged.",
            ),
          );
      }

      if (result.type === "payment-error") {
        for (const [key, value] of Object.entries(result.response.headers)) {
          reply.header(key, value);
        }
        if (result.response.isHtml) {
          return reply
            .code(result.response.status)
            .type("text/html")
            .send(result.response.body);
        }
        return reply.code(result.response.status).send(result.response.body || {});
      }

      if (result.type === "payment-verified") {
        mcpPayments.set(req, { result, requestContext });
      }
    });
  }

  /** Settle a verified MCP call, or cancel it when the call did not deliver. */
  async function settleOrCancelMcpCall(
    payment: VerifiedMcpCall,
    captured: CapturedResponse,
    handlerThrew: boolean,
    requestId: string,
  ): Promise<void> {
    const { result, requestContext } = payment;
    const failed =
      handlerThrew ||
      captured.statusCode >= 400 ||
      mcpResponseFailed(captured.body(), captured.headers["content-type"] ?? "");

    if (failed) {
      // The MCP transport reports a failed tool call as HTTP 200 with
      // `isError: true`, which settlement cannot see. Cancelling here is what
      // keeps the published guarantee: a buyer is never charged when nothing was
      // retrieved.
      try {
        const cancel = await result.cancellationDispatcher.cancel({
          reason: "handler_failed",
          responseStatus: captured.statusCode,
        });
        const failureHeaders = mcpHttpServer.createFailurePathSettlementHeaders(
          cancel,
          result.beforeHandlerSettlement,
          result.paymentPayload,
          captured.headers["cache-control"] ?? null,
        );
        if (failureHeaders) captured.mergeHeaders(failureHeaders);
      } catch (err) {
        logger.warn("mcp settlement cancellation failed", {
          request_id: requestId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    try {
      const settleResult = await mcpHttpServer.processSettlement(
        result.paymentPayload,
        result.paymentRequirements,
        result.declaredExtensions,
        {
          request: requestContext,
          responseBody: captured.body(),
          responseHeaders: { ...captured.headers },
        },
        undefined,
        result.beforeHandlerSettlement,
      );
      if (settleResult.success) {
        captured.mergeHeaders(settleResult.headers);
        return;
      }
      captured.replace(
        settleResult.response.status,
        JSON.stringify(settleResult.response.body ?? {}),
        settleResult.response.headers,
      );
    } catch (err) {
      logger.error("mcp settlement failed", {
        request_id: requestId,
        error: err instanceof Error ? err.message : String(err),
      });
      // The tool result is not delivered: settlement is what the payment bought.
      captured.replace(
        ERROR_HTTP_STATUS.PAYMENT_INVALID,
        JSON.stringify(
          errorResponse(
            "PAYMENT_INVALID",
            requestId,
            "The payment was verified but could not be settled, so the request was not served.",
          ),
        ),
        { "content-type": "application/json" },
      );
    }
  }

  const mcpVerbs = ["POST", "GET", "DELETE"] as const;
  for (const verb of mcpVerbs) {
    app.route({
      method: verb,
      url: "/mcp",
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        // Hand the raw sockets to the MCP transport; Fastify must not try to
        // serialise the response itself.
        reply.hijack();

        // A paid call's response is buffered so settlement can see both the status
        // and the body. Free calls are written straight through.
        const payment = mcpPayments.get(req);
        const captured = payment ? captureResponse(reply.raw) : null;
        let handlerThrew = false;

        try {
          await mcp.handleNodeRequest(req.raw, reply.raw, req.body);
        } catch (err) {
          handlerThrew = true;
          logger.error("mcp handler failed", {
            request_id: req.id,
            error: err instanceof Error ? err.message : String(err),
          });
          if (!captured && !reply.raw.headersSent) {
            reply.raw.writeHead(500, { "content-type": "application/json" });
            reply.raw.end(JSON.stringify(errorResponse("INTERNAL_ERROR", String(req.id))));
          }
        }

        if (payment && captured) {
          await settleOrCancelMcpCall(payment, captured, handlerThrew, String(req.id));
        }
        captured?.flush();
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
