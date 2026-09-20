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
          "INVALID_REQUEST",
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
