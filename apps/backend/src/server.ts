/**
 * Backend entrypoint.
 *
 * Startup order matters: configuration is loaded and the shared secret is
 * validated BEFORE anything binds a socket. The process refuses to start
 * without a usable secret, so it can never run as an open origin that lets a
 * caller bypass the Worker's payment layer (SPEC section 15).
 */
import { createSqliteCache, type CacheProvider } from "@aee/cache";
import {
  EvidenceService,
  MIN_SECRET_LENGTH,
  createLogger,
  isSecretUsable,
  loadConfig,
} from "@aee/core";
import { createEvidenceMcpServer, type EvidenceMcpServer } from "@aee/mcp";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, {
    service: config.serviceName,
    version: config.serviceVersion,
  });

  // ---- fail closed -------------------------------------------------------
  if (!isSecretUsable(config.backendAuthSecret)) {
    logger.error("refusing to start", {
      reason: `BACKEND_AUTH_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} characters`,
      hint: "generate one with: openssl rand -hex 32",
    });
    process.exit(1);
  }

  // ---- cache -------------------------------------------------------------
  let cache: CacheProvider | null = null;
  if (config.cache.enabled) {
    try {
      cache = createSqliteCache({
        path: config.cache.path,
        ttlSeconds: config.limits.cacheTtlSeconds,
        maxEntries: config.cache.maxEntries,
      });
    } catch (err) {
      // A cache is an optimisation, never a hard dependency: degrade to live
      // fetches rather than refusing to serve.
      logger.warn("cache unavailable; continuing without it", {
        error: err instanceof Error ? err.message : String(err),
        path: config.cache.path,
      });
      cache = null;
    }
  }

  // ---- core service + adapters -------------------------------------------
  const service = new EvidenceService({ config, logger, cache });
  const mcp: EvidenceMcpServer = createEvidenceMcpServer({
    service,
    logger,
    serviceVersion: config.serviceVersion,
  });
  const app = buildApp({ config, logger, service, mcp });

  // ---- startup summary (no secrets) --------------------------------------
  logger.info("starting backend", {
    env: config.nodeEnv,
    host: config.backendHost,
    port: config.backendPort,
    log_level: config.logLevel,
    cache_enabled: cache !== null,
    usage_log: config.usageLogPath || "off",
    x402_network: config.x402.network,
    // Presence only — the value itself is never logged.
    x402_recipient_configured: config.x402.recipient.length > 0,
    limits: config.limits,
  });

  // ---- graceful shutdown --------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal });
    try {
      await app.close();
      await mcp.close();
      await cache?.close();
    } catch (err) {
      logger.error("error during shutdown", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    process.exit(0);
  };

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  // ---- listen -------------------------------------------------------------
  try {
    await app.listen({ host: config.backendHost, port: config.backendPort });
    logger.info("backend listening", {
      url: `http://${config.backendHost}:${config.backendPort}`,
    });
  } catch (err) {
    logger.error("failed to bind", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  // Last-resort handler: the logger may not exist yet, so write to stderr.
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      msg: "fatal startup error",
      error: err instanceof Error ? err.message : String(err),
    }) + "\n",
  );
  process.exit(1);
});
