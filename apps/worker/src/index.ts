import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { Context, MiddlewareHandler } from "hono";
import type { Network } from "@x402/core/types";
import {
  SERVICE_NAME,
  SERVICE_VERSION,
  errorResponse,
  ERROR_HTTP_STATUS,
  type ErrorCode,
} from "@aee/schemas";

/**
 * Cloudflare Worker — the public edge (SPEC section 13).
 *
 *   client ──▶ Worker ──x402 gate──▶ backend origin (X-Backend-Auth)
 *
 * This process stays deliberately thin: it gates payment, validates request
 * shape, and forwards. All fetching, parsing and reasoning happens on the VPS
 * backend. Nothing heavy runs here (Free plan, minimal CPU).
 *
 * The backend shared secret is read from `env`, attached only to the outgoing
 * request, and never returned to a client or written to a log.
 */

export interface Env {
  X402_NETWORK: string;
  X402_RECIPIENT: string;
  X402_FACILITATOR_URL: string;
  X402_PRICE_USD: string;
  BACKEND_ORIGIN_URL: string;
  /** Secret. Set via `wrangler secret put BACKEND_AUTH_SECRET`. */
  BACKEND_AUTH_SECRET: string;
  /** Local-development only; never set in a deployed environment. */
  DEV_BYPASS_PAYMENT?: string;
}

type Ctx = Context<{ Bindings: Env }>;

/** Base mainnet. Payment can never be bypassed on this network. */
const MAINNET = "eip155:8453";

/** MCP tool that requires payment. Every other method is free. */
const PAID_MCP_TOOL = "research_evidence";

/** Hard cap on a JSON-RPC body the edge will buffer. Cheap rejection. */
const MAX_MCP_BODY_BYTES = 64 * 1024;

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Dev bypass, doubly guarded (see the equivalent logic in the x402-worker):
 * it needs the explicit flag AND a non-mainnet network. Production cannot
 * bypass even if the variable leaks into its config.
 */
function devBypassActive(env: Env): boolean {
  return env.DEV_BYPASS_PAYMENT === "true" && env.X402_NETWORK !== MAINNET;
}

function fail(c: Ctx, code: ErrorCode, requestId: string, message?: string) {
  return c.json(errorResponse(code, requestId, message), ERROR_HTTP_STATUS[code] as never);
}

/** Convert "0.03" into the x402 price string "$0.03". */
function priceString(usd: string): string {
  const raw = (usd ?? "").trim().replace(/^\$/, "");
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return "$0.03";
  // x402 accepts a "$" prefixed dollar amount; keep 2 decimals for readability.
  return `$${n.toFixed(2)}`;
}

function newRequestId(): string {
  return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

// ---------------------------------------------------------------------------
// x402 gate
// ---------------------------------------------------------------------------

let cachedKey: string | null = null;
let cachedGate: MiddlewareHandler | null = null;

/**
 * The x402 middleware is built once per distinct configuration and memoised:
 * rebuilding it per request would re-sync with the facilitator every time.
 */
function paymentGate(env: Env, routeKey: string): MiddlewareHandler {
  const key = [
    routeKey,
    env.X402_RECIPIENT,
    env.X402_NETWORK,
    env.X402_PRICE_USD,
    env.X402_FACILITATOR_URL,
  ].join("|");

  if (cachedGate && cachedKey === key) return cachedGate;

  const facilitator = new HTTPFacilitatorClient({ url: env.X402_FACILITATOR_URL });
  const resourceServer = new x402ResourceServer(facilitator).register(
    env.X402_NETWORK as Network,
    new ExactEvmScheme(),
  );

  const gate = paymentMiddleware(
    {
      [routeKey]: {
        accepts: {
          scheme: "exact",
          price: priceString(env.X402_PRICE_USD),
          network: env.X402_NETWORK as Network,
          payTo: env.X402_RECIPIENT,
        },
        description: "Agent Evidence API — structured, cited web evidence",
      },
    },
    resourceServer,
  );

  cachedKey = key;
  cachedGate = gate;
  return gate;
}

// ---------------------------------------------------------------------------
// backend forwarding
// ---------------------------------------------------------------------------

async function proxyToBackend(
  c: Ctx,
  path: string,
  init: { method: string; body?: string; contentType?: string },
): Promise<Response> {
  const origin = c.env.BACKEND_ORIGIN_URL;
  const secret = c.env.BACKEND_AUTH_SECRET;
  const requestId = newRequestId();

  if (!origin || !secret) {
    console.error("[worker] backend not configured (BACKEND_ORIGIN_URL / BACKEND_AUTH_SECRET)");
    return fail(c, "NOT_CONFIGURED", requestId);
  }

  const headers: Record<string, string> = {
    "x-backend-auth": secret,
    "x-request-id": requestId,
    // Forward the CALLER's Accept header. The MCP streamable-HTTP transport
    // requires `application/json, text/event-stream` and answers 406 otherwise,
    // so hard-coding application/json here breaks the free MCP handshake.
    accept: c.req.header("accept") ?? "application/json",
  };
  if (init.contentType) headers["content-type"] = init.contentType;

  // Forward MCP session/protocol headers, otherwise the backend cannot
  // correlate a streamable-HTTP session.
  for (const h of ["mcp-session-id", "mcp-protocol-version"]) {
    const v = c.req.header(h);
    if (v) headers[h] = v;
  }

  // Forward the payment proof so the backend can log settlement if needed.
  const sig = c.req.header("payment-signature");
  if (sig) headers["payment-signature"] = sig;

  let upstream: Response;
  try {
    upstream = await fetch(new URL(path, origin).toString(), {
      method: init.method,
      headers,
      body: init.body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    console.error(`[worker] backend fetch failed request_id=${requestId}`, err);
    return fail(c, "BACKEND_UNREACHABLE", requestId);
  }

  // Pass the backend's response through, preserving its status and body.
  // The backend already emits the canonical error envelope.
  const outHeaders = new Headers();
  outHeaders.set("content-type", upstream.headers.get("content-type") ?? "application/json");
  outHeaders.set("cache-control", "no-store");
  outHeaders.set("x-request-id", requestId);
  for (const h of ["payment-response", "mcp-session-id"]) {
    const v = upstream.headers.get(h);
    if (v) outHeaders.set(h, v);
  }
  if (devBypassActive(c.env) && path !== "/health") {
    outHeaders.set("x-dev-payment-bypass", "active");
  }

  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

// ---------------------------------------------------------------------------
// free endpoints
// ---------------------------------------------------------------------------

/** Free liveness probe. No secrets, no infrastructure detail (SPEC section 4A). */
app.get("/health", (c) =>
  c.json({ status: "ok" as const, service: SERVICE_NAME, version: SERVICE_VERSION }),
);

/** Capability description, so an agent can discover what this offers for free. */
app.get("/", (c) =>
  c.json({
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    description:
      "Evidence infrastructure for AI agents. Returns structured, cited, freshly-retrieved " +
      "evidence from public web pages so an agent can verify claims and ground answers in sources.",
    endpoints: {
      health: "GET /health (free)",
      evidence: "POST /v1/evidence (paid, x402)",
      mcp: "POST /mcp (MCP streamable HTTP; initialize and tools/list are free)",
    },
    mcp: {
      transport: "streamable-http",
      tools: {
        research_evidence: "paid",
        health: "free",
      },
    },
    payment: {
      protocol: "x402",
      scheme: "exact",
      network: c.env.X402_NETWORK,
      asset: "USDC",
      price_usd: c.env.X402_PRICE_USD,
      recipient: c.env.X402_RECIPIENT,
      facilitator: c.env.X402_FACILITATOR_URL,
    },
  }),
);

// ---------------------------------------------------------------------------
// paid HTTP API
// ---------------------------------------------------------------------------

/**
 * Basic shape validation at the edge.
 *
 * Deliberately shallow: the authoritative validation is the zod schema in the
 * backend. This exists only to reject obvious junk before spending an x402
 * verification round-trip. It must not diverge into business logic.
 */
function basicRequestProblem(body: unknown): string | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return "request body must be a JSON object";
  }
  const b = body as Record<string, unknown>;
  if (typeof b.question !== "string" || b.question.trim().length === 0) {
    return "question is required and must be a non-empty string";
  }
  if (b.urls !== undefined) {
    if (!Array.isArray(b.urls) || b.urls.some((u) => typeof u !== "string")) {
      return "urls must be an array of strings";
    }
  }
  return null;
}

app.use("/v1/evidence", async (c, next) => {
  if (c.req.method !== "POST") return next();
  if (devBypassActive(c.env)) return next();
  return paymentGate(c.env, "POST /v1/evidence")(c, next);
});

app.post("/v1/evidence", async (c) => {
  const requestId = newRequestId();

  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    return fail(c, "INVALID_REQUEST", requestId, "Request body must be valid JSON.");
  }

  const problem = basicRequestProblem(parsed);
  if (problem) return fail(c, "INVALID_REQUEST", requestId, problem);

  return proxyToBackend(c, "/internal/v1/evidence", {
    method: "POST",
    body: JSON.stringify(parsed),
    contentType: "application/json",
  });
});

// ---------------------------------------------------------------------------
// MCP endpoint (streamable HTTP)
// ---------------------------------------------------------------------------

interface JsonRpcLike {
  method?: unknown;
  params?: unknown;
}

/**
 * Decide whether a JSON-RPC payload must be paid for.
 *
 * `initialize`, `tools/list` and notifications must be FREE — an agent has to
 * discover the tools before it can decide to pay for one. Only an actual
 * invocation of the paid tool requires payment. A batch is charged if any
 * element in it is a paid call (conservative).
 */
function needsPayment(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false; // malformed JSON: let the backend answer with a proper error
  }

  const isPaidCall = (msg: unknown): boolean => {
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return false;
    const m = msg as JsonRpcLike;
    if (m.method !== "tools/call") return false;
    const params = m.params;
    if (params === null || typeof params !== "object") return false;
    return (params as { name?: unknown }).name === PAID_MCP_TOOL;
  };

  if (Array.isArray(parsed)) return parsed.some(isPaidCall);
  return isPaidCall(parsed);
}

/**
 * Buffer and inspect the JSON-RPC body, then gate only paid calls.
 *
 * The body is read once here and stashed on the context so the downstream
 * proxy can forward the original bytes without re-serialising.
 */
app.use("/mcp", async (c, next) => {
  if (c.req.method !== "POST") return next();

  const raw = await c.req.text();
  if (raw.length > MAX_MCP_BODY_BYTES) {
    return fail(c, "INVALID_REQUEST", newRequestId(), "Request body is too large.");
  }
  c.set("mcpBody" as never, raw as never);

  if (needsPayment(raw)) {
    if (devBypassActive(c.env)) {
      c.header("X-Dev-Payment-Bypass", "active");
      return next();
    }
    return paymentGate(c.env, "POST /mcp")(c, next);
  }
  return next();
});

app.post("/mcp", async (c) => {
  const raw = (c.get("mcpBody" as never) as string | undefined) ?? "";
  return proxyToBackend(c, "/mcp", {
    method: "POST",
    body: raw,
    contentType: "application/json",
  });
});

/** SSE stream for server-initiated messages. Free. */
app.get("/mcp", (c) => proxyToBackend(c, "/mcp", { method: "GET" }));

/** Session teardown. Free. */
app.delete("/mcp", (c) => proxyToBackend(c, "/mcp", { method: "DELETE" }));

// ---------------------------------------------------------------------------
// fallthrough
// ---------------------------------------------------------------------------

app.notFound((c) =>
  fail(c, "INVALID_REQUEST", newRequestId(), `No such endpoint: ${c.req.method} ${c.req.path}`),
);

app.onError((err, c) => {
  // Never surface a stack trace (SPEC section 22).
  console.error("[worker] unhandled error", err);
  return fail(c, "INTERNAL_ERROR", newRequestId());
});

export default app;
