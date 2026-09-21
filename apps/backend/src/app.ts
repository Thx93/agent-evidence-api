import { readFileSync } from "node:fs";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  SERVICE_NAME,
  SERVICE_VERSION,
  ERROR_HTTP_STATUS,
  errorResponse,
  type ErrorCode,
} from "@aee/schemas";
import {
  EvidenceService,
  ServiceError,
  type AppConfig,
  type Logger,
} from "@aee/core";
import type { EvidenceMcpServer } from "@aee/mcp";
import { extractCredential, isPublicPath, secretMatches } from "./auth.js";
import { createRateLimiter } from "./rate-limit.js";

export interface BuildAppDeps {
  config: AppConfig;
  logger: Logger;
  service: EvidenceService;
  mcp: EvidenceMcpServer;
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
    });
  });

  // ------------------------------------------------------------- routes ----
  /** Free liveness probe. Never reports secrets or infrastructure detail. */
  app.get("/health", async (_req, reply) =>
    reply.send({ status: "ok" as const, service: SERVICE_NAME, version: SERVICE_VERSION }),
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
    try {
      const result = await service.execute(req.body, requestId);
      return reply.code(200).send(result);
    } catch (err) {
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
