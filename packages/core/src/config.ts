import {
  DEFAULT_LIMITS,
  type ResourceLimits,
} from "@aee/schemas";

/**
 * Runtime configuration, derived entirely from the environment.
 *
 * Every value has a safe default so the service starts in a bare environment.
 * Nothing here reads or logs a secret.
 */
export interface AppConfig {
  serviceName: string;
  serviceVersion: string;
  nodeEnv: string;
  logLevel: LogLevel;

  backendHost: string;
  backendPort: number;
  backendOriginUrl: string;

  /** Server-to-server shared secret. Never logged, never returned to callers. */
  backendAuthSecret: string;

  /**
   * Declared for the shared config contract. The BACKEND does not enforce
   * payment: x402 is enforced at the Cloudflare Worker, which reads its own
   * bindings. These values are the local defaults and must not be logged as if
   * they described the deployed payment configuration.
   */
  x402: {
    network: string;
    recipient: string;
    facilitatorUrl: string;
    priceUsd: string;
  };

  limits: ResourceLimits;

  /**
   * Per-client request-rate limiting (SPEC section 23). `perMinute: 0` turns
   * limiting off entirely; `burst` is the extra headroom above the sustained
   * rate that one client may consume at once.
   */
  rateLimit: {
    perMinute: number;
    burst: number;
  };

  cache: {
    enabled: boolean;
    path: string;
    maxEntries: number;
  };

  /**
   * Append-only record of served (i.e. PAID) requests. Every line is a settled
   * payment, so this is the revenue record. Empty or "off" disables it.
   */
  usageLogPath: string;

  /**
   * Optional semantic reasoning (SPEC section 37). "none" keeps the deterministic
   * lexical scorer as the only ranker, which is the default and reproduces the
   * service's existing behaviour exactly. "laya" refines candidate ORDER using a
   * self-hosted judgement model.
   *
   * Cost of enabling: measured ~410 ms per passage on a 4 vCPU CPU, so a
   * 5-source request costs ~10 s of inference, plus ~2.9 GB resident for the
   * sidecar. It is opt-in for that reason, not for quality reasons.
   */
  reasoning: {
    provider: "none" | "laya";
    url: string;
    timeoutMs: number;
    /**
     * How many lexical candidates to retrieve BEFORE semantic ranking.
     *
     * This must exceed maxEvidenceItems or the model has nothing to work with:
     * reordering a list that already excluded the answer cannot recover it. The
     * measured case needed a pool of ~12 to include a passage the lexical ranker
     * had placed 8th-20th. Cost is linear — one model call per candidate.
     */
    poolSize: number;

    /**
     * Total wall-clock budget for semantic scoring across the WHOLE request.
     *
     * Without this, cost scales as sources x poolSize x ~420 ms: at
     * MAX_SOURCES=25 with a pool of 12 that is roughly 126 seconds, four times
     * the Worker's 30 s origin timeout. The buyer would have paid and received a
     * timeout - the one failure mode this service must never produce.
     *
     * When the budget runs out the remaining sources simply keep their lexical
     * order, so the worst case degrades in quality rather than failing.
     */
    budgetMs: number;
  };

  fetch: {
    userAgent: string;
    robotsPolicy: "ignore" | "warn" | "enforce";
    /**
     * Test-only. Allows the fetcher to reach a loopback fixture server.
     * The fetcher ignores this unless NODE_ENV === "test", so enabling the
     * variable in a deployed environment has no effect.
     */
    allowLoopbackForTests: boolean;
  };
}

export type LogLevel = "debug" | "info" | "warn" | "error";

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`invalid integer for ${name}: ${JSON.stringify(raw)}`);
  }
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

/** Read resource limits from the environment, falling back to safe defaults. */
export function loadLimits(): ResourceLimits {
  return {
    maxConcurrentFetches: int("MAX_CONCURRENT_FETCHES", DEFAULT_LIMITS.maxConcurrentFetches),
    maxUrlsPerRequest: int("MAX_URLS_PER_REQUEST", DEFAULT_LIMITS.maxUrlsPerRequest),
    maxResponseBytes: int("MAX_RESPONSE_BYTES", DEFAULT_LIMITS.maxResponseBytes),
    maxRedirects: int("MAX_REDIRECTS", DEFAULT_LIMITS.maxRedirects),
    requestTimeoutMs: int("REQUEST_TIMEOUT_MS", DEFAULT_LIMITS.requestTimeoutMs),
    connectTimeoutMs: int("CONNECT_TIMEOUT_MS", DEFAULT_LIMITS.connectTimeoutMs),
    cacheTtlSeconds: int("CACHE_TTL_SECONDS", DEFAULT_LIMITS.cacheTtlSeconds),
    maxEvidenceItems: int("MAX_EVIDENCE_ITEMS", DEFAULT_LIMITS.maxEvidenceItems),
    maxExcerptChars: int("MAX_EXCERPT_CHARS", DEFAULT_LIMITS.maxExcerptChars),
  };
}

export function loadConfig(): AppConfig {
  const robots = str("ROBOTS_POLICY", "warn");
  if (!["ignore", "warn", "enforce"].includes(robots)) {
    throw new Error(`ROBOTS_POLICY must be ignore|warn|enforce, got ${robots}`);
  }

  return {
    serviceName: str("SERVICE_NAME", "agent-evidence-api"),
    serviceVersion: str("SERVICE_VERSION", "0.1.1"),
    nodeEnv: str("NODE_ENV", "development"),
    logLevel: str("LOG_LEVEL", "info") as LogLevel,

    backendHost: str("BACKEND_HOST", "127.0.0.1"),
    backendPort: int("BACKEND_PORT", 8080),
    backendOriginUrl: str("BACKEND_ORIGIN_URL", "https://backend.example.invalid"),

    // Deliberately NOT defaulted to a value: an empty secret is what makes the
    // backend refuse to start (fail closed) rather than run unauthenticated.
    backendAuthSecret: str("BACKEND_AUTH_SECRET", ""),

    x402: {
      network: str("X402_NETWORK", "eip155:84532"),
      recipient: str("X402_RECIPIENT", ""),
      facilitatorUrl: str("X402_FACILITATOR_URL", "https://x402.org/facilitator"),
      priceUsd: str("X402_PRICE_USD", "0.03"),
    },

    limits: loadLimits(),

    rateLimit: {
      perMinute: int("RATE_LIMIT_PER_MINUTE", 60),
      burst: int("RATE_LIMIT_BURST", 20),
    },

    cache: {
      enabled: bool("CACHE_ENABLED", true),
      path: str("CACHE_DB_PATH", "./data/cache.sqlite"),
      maxEntries: int("CACHE_MAX_ENTRIES", 5000),
    },

    usageLogPath: str("USAGE_LOG_PATH", "./data/usage.jsonl"),

    reasoning: {
      provider: (str("REASONING_PROVIDER", "none") === "laya" ? "laya" : "none") as "none" | "laya",
      url: str("REASONING_URL", "http://127.0.0.1:8077"),
      timeoutMs: int("REASONING_TIMEOUT_MS", 8000),
      poolSize: int("REASONING_POOL_SIZE", 12),
      budgetMs: int("REASONING_BUDGET_MS", 20000),
    },

    fetch: {
      userAgent: str(
        "FETCH_USER_AGENT",
        "AgentEvidenceAPI/0.1.0 (+https://example.invalid/bot)",
      ),
      robotsPolicy: robots as "ignore" | "warn" | "enforce",
      allowLoopbackForTests: bool("ALLOW_LOOPBACK_FOR_TESTS", false),
    },
  };
}

/** Minimum length for BACKEND_AUTH_SECRET before the backend will start. */
export const MIN_SECRET_LENGTH = 16;

/** True when the configured secret is strong enough to run with. */
export function isSecretUsable(secret: string): boolean {
  return typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH;
}
