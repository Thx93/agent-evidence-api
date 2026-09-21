import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
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

/**
 * Cached origin health.
 *
 * Payment is verified BEFORE the request is proxied, so without this a buyer
 * could pay for evidence and receive a 502 from a dead backend. We probe the
 * origin first (10s cache, so it is not a fetch per request) and refuse the
 * paid path outright when it is down.
 */
let originHealthCache: { ok: boolean; at: number } | null = null;
const ORIGIN_HEALTH_TTL_MS = 10_000;

async function originHealthy(env: Env): Promise<boolean> {
  const now = Date.now();
  if (originHealthCache && now - originHealthCache.at < ORIGIN_HEALTH_TTL_MS) {
    return originHealthCache.ok;
  }
  let ok = false;
  try {
    const res = await fetch(new URL("/health", env.BACKEND_ORIGIN_URL).toString(), {
      signal: AbortSignal.timeout(4_000),
    });
    ok = res.ok;
  } catch {
    ok = false;
  }
  originHealthCache = { ok, at: now };
  return ok;
}

function newRequestId(): string {
  return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

// ---------------------------------------------------------------------------
// x402 gate
// ---------------------------------------------------------------------------

/**
 * Bazaar discovery declarations (x402's machine-readable catalog).
 *
 * A facilitator that implements the bazaar extension catalogs a route once a
 * payment settles against it, which makes the endpoint discoverable through
 * `/discovery/resources` to agents that have never heard of us. The declared
 * input/output is what a prospective buyer sees BEFORE paying.
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

const MCP_DISCOVERY = declareDiscoveryExtension({
  toolName: "research_evidence",
  // Optional in the SDK's type, but every MCP entry in the live x402 catalogue
  // declares it, and it is accurate: this endpoint speaks streamable HTTP (the
  // registry listing says so too). Without it the catalogue entry describes the
  // tool but never says how to reach it.
  transport: "streamable-http",
  // Same reasoning as the resource description: the Bazaar searches by keyword,
  // so the tool text has to contain the words a buyer would use. The earlier
  // wording lacked verify, citation, support and contradict.
  // SPEC section 29 asks tool descriptions to contain useful phrases such as
  // "web evidence", "claim verification", "cited evidence" and "compare sources",
  // while warning against keyword stuffing. Six of its eight examples describe
  // this service accurately and appear here reading as prose. Two are omitted
  // deliberately: "source verification" would imply we vouch for a source's
  // trustworthiness, which we do not - we verify a claim against sources - and
  // "fresh web evidence" is marketing rather than description.
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
  // Only 5 of the 11 well-formed MCP entries in the live catalogue show a buyer
  // what a call returns, and none declares an output schema. Reusing the HTTP
  // route's example makes this listing show the actual deliverable - cited
  // excerpts with a hash and an assessment - instead of a tool signature alone.
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
        // Shown to buyers browsing the x402 catalogue, where this one line is the
        // entire pitch. Lead with what the caller GETS, name the input, and state
        // the provenance guarantee. Modelled on the listings that rank well.
        // Wording matters more than it looks. The Bazaar's search is keyword based,
        // not semantic, so a buyer searching "verify a claim" or "cited evidence"
        // only finds this if those words appear. The previous wording described the
        // product accurately but omitted verify, web, cited, citation and sources -
        // every term a buyer in this niche would actually type. They are rare across
        // the catalogue (cited 69/1000 descriptions, citation 22, claim 17,
        // verify 16), so their absence was not neutral.
        //
        // This is not keyword stuffing: each phrase states what the service does.
        description:
          "Verify a claim against public web sources: send a question and up to 5 URLs, " +
          "get cited evidence - passages that support, contradict or fail to settle it. " +
          "Claim verification with a citation for every excerpt: source URL, retrieval " +
          "time, content hash. Never charges when nothing is retrieved.",
        serviceName: "Agent Evidence API",
        tags: ["web-evidence", "claim-verification", "source-verification"],

        // The default 402 body is literally {} — useless to a buyer debugging
        // their payment. Distinguish "you sent nothing" from "what you sent was
        // rejected", and point at the docs either way.
        unpaidResponseBody: ({ paymentHeader }: { paymentHeader?: string }) => ({
          contentType: "application/json",
          body: errorResponse(
            paymentHeader ? "PAYMENT_INVALID" : "PAYMENT_REQUIRED",
            newRequestId(),
            paymentHeader
              ? "The supplied payment could not be verified. It may be malformed, expired, for the wrong network, or for an amount below the quoted price."
              : undefined,
          ),
        }),

        // If verification succeeded but settlement failed, do not leave the
        // buyer guessing why they were not served.
        settlementFailedResponseBody: () => ({
          contentType: "application/json",
          body: errorResponse(
            "PAYMENT_INVALID",
            newRequestId(),
            "The payment was verified but could not be settled on-chain, so the request was not served and you were not charged for a result.",
          ),
        }),
        // Only advertise the discovery payload that matches the route being
        // priced: an HTTP body schema on the MCP route would be wrong.
        extensions: routeKey === "POST /mcp" ? { ...MCP_DISCOVERY } : { ...HTTP_DISCOVERY },
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
app.get("/health", async (c) => {
  // The shallow form is unchanged: three fields, no infrastructure detail.
  if (c.req.query("deep") !== "1") {
    return c.json({ status: "ok" as const, service: SERVICE_NAME, version: SERVICE_VERSION });
  }
  // Deep form additionally reports whether the origin can serve, and returns
  // 503 when it cannot, so monitors and the watchdog see the real state.
  const ok = await originHealthy(c.env);
  return c.json(
    {
      status: ok ? ("ok" as const) : ("degraded" as const),
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      backend: ok ? "ok" : "unreachable",
      payment: c.env.X402_NETWORK === MAINNET ? "mainnet" : "testnet",
    },
    ok ? 200 : 503,
  );
});

/** Human-facing landing page. Plain HTML, no dependencies, no tracking. */
function landingHtml(env: Env): string {
  const price = priceString(env.X402_PRICE_USD);
  const net = env.X402_NETWORK === MAINNET ? "Base mainnet" : "Base Sepolia (testnet)";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Evidence API — cited web evidence for AI agents</title>
<style>
 :root{color-scheme:light dark}
 body{max-width:46rem;margin:3rem auto;padding:0 1.25rem;
      font:16px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif}
 h1{font-size:1.7rem;margin-bottom:.2rem} h2{font-size:1.05rem;margin-top:2rem}
 .sub{opacity:.7;margin-top:0}
 pre{background:rgba(127,127,127,.12);padding:.85rem;border-radius:8px;
     overflow-x:auto;font-size:.86rem}
 code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
 .price{font-weight:700}
 table{border-collapse:collapse;font-size:.92rem} td{padding:.25rem 1rem .25rem 0;vertical-align:top}
 ul{padding-left:1.1rem}
</style></head><body>

<h1>Agent Evidence API</h1>
<p class="sub">Cited, timestamped web evidence for AI agents. No account, no API key.</p>

<p>Send a question and the public pages you want checked. You get back short
quoted excerpts with their source URL, retrieval time and content hash, plus an
explicit <code>supported</code> / <code>contradicted</code> / <code>mixed</code> /
<code>inconclusive</code> assessment.</p>

<p class="price">${price} USDC per request · ${net} · paid over HTTP 402 (x402)</p>

<h2>See the paywall — no wallet needed</h2>
<pre><code>curl -X POST ${"https://agent-evidence-api.thx93workersdev.workers.dev"}/v1/evidence \
  -H 'content-type: application/json' \
  -d '{"question":"Is Rotamech a manufacturer of centrifugal pumps?","urls":["https://example.com"]}'</code></pre>
<p>You get a <code>402</code> with the price and the payment address. Nothing is charged.</p>
<p><strong>You are only charged when evidence is actually delivered.</strong> If every
source you asked for turns out to be unreachable, blocked, or unsupported, the request
fails and <em>no payment is taken</em> — x402 cancels settlement whenever the service
returns an error. Partial success does bill, because you received real evidence.</p>

<h2>Buy something (zero install)</h2>
<pre><code>curl -fsSL ${"https://agent-evidence-api.thx93workersdev.workers.dev"}/buy.mjs -o buy.mjs

# no wallet yet? one command creates one, kept out of your shell history
node -e "console.log('0x'+require('crypto').randomBytes(32).toString('hex'))" \
  > ~/.x402-key && chmod 600 ~/.x402-key
export X402_PRIVATE_KEY_FILE=~/.x402-key
node buy.mjs --address          # send USDC on Base to the address it prints

node buy.mjs "Is Rotamech a manufacturer of centrifugal pumps?" https://example.com</code></pre>
<p>The key is read from a file or the environment, used to sign one payment, and
never sent to us. No ETH is needed — the facilitator submits the transaction.</p>

<h2>Or use it as an MCP tool</h2>
<pre><code>{ "mcpServers": { "evidence": {
  "type": "streamable-http",
  "url": "${"https://agent-evidence-api.thx93workersdev.workers.dev"}/mcp" } } }</code></pre>
<table>
<tr><td><code>research_evidence</code></td><td>${price} — fetch sources, return cited evidence</td></tr>
<tr><td><code>health</code></td><td>free</td></tr>
<tr><td><code>initialize</code> / <code>tools/list</code></td><td>free, so an agent can look before it pays</td></tr>
</table>

<h2>What it does that a plain fetch does not</h2>
<ul>
 <li>Refuses private, loopback, link-local and cloud-metadata addresses — including
     octal, decimal and hex IP encodings, and redirects into any of them.</li>
 <li>Re-validates DNS <em>at connect time</em>, which is what defeats DNS rebinding.</li>
 <li>Returns a citation, not an opinion: URL, final URL, retrieval timestamp, SHA-256.</li>
 <li>Says <code>mixed</code> when sources disagree, and <code>inconclusive</code> when
     the text does not clearly support or contradict.</li>
</ul>

<h2>Honest limitations</h2>
<p>The assessment is deterministic lexical matching, not semantic reasoning. It
never invents a fact and never emits a confidence score. You supply the URLs —
there is no web search. Excerpts are short by design. Evidence, not truth.</p>

<p><a href="/health?deep=1">status</a> ·
<a href="https://facilitator.payai.network/discovery/resources?limit=1000">listed in the x402 catalogue</a> ·
<a href="/buy.mjs">buyer client</a></p>
</body></html>`;
}

/** Capability description, so an agent can discover what this offers for free. */
app.get("/", (c) => {
  // Content negotiation: browsers get a page a human can act on; agents (which
  // send Accept: application/json, or curl's */*) get the JSON contract.
  const accept = c.req.header("accept") ?? "";
  if (accept.includes("text/html")) {
    return c.html(landingHtml(c.env));
  }
  return c.json({
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
  });
});

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
  // Never charge for a request we cannot fulfil: check the origin first.
  if (!(await originHealthy(c.env))) {
    return fail(
      c,
      "BACKEND_UNREACHABLE",
      newRequestId(),
      "The evidence service is temporarily unavailable; no payment was taken.",
    );
  }
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
    if (!(await originHealthy(c.env))) {
      return fail(
        c,
        "BACKEND_UNREACHABLE",
        newRequestId(),
        "The evidence service is temporarily unavailable; no payment was taken.",
      );
    }
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
  const res = await proxyToBackend(c, "/mcp", {
    method: "POST",
    body: raw,
    contentType: "application/json",
  });
  // Only a call that was actually charged needs this correction.
  return needsPayment(raw) ? await cancelSettlementOnToolError(res) : res;
});

/**
 * Stop a failed MCP tool call from taking the buyer's money.
 *
 * The MCP transport reports a failed tool call as a JSON-RPC *result* carrying
 * `isError: true` with HTTP 200 - which is correct MCP behaviour, and invisible
 * to the x402 middleware, which cancels settlement only when the handler returns
 * a status >= 400. So a paid tool call that failed would still settle.
 *
 * This rewrites the status while preserving the JSON-RPC body, so MCP clients
 * still receive a well-formed response and the payment is not taken. Applied
 * only to calls that were gated for payment; free calls are untouched.
 */
async function cancelSettlementOnToolError(res: Response): Promise<Response> {
  if (res.status >= 400) return res; // already cancels settlement

  const contentType = res.headers.get("content-type") ?? "";
  // MCP responses are JSON, or SSE carrying JSON in `data:` lines.
  if (!contentType.includes("json") && !contentType.includes("event-stream")) return res;

  const body = await res.text();
  const headers = new Headers(res.headers);

  if (!/"isError"\s*:\s*true/.test(body)) {
    return new Response(body, { status: res.status, headers });
  }

  headers.set("x-settlement-cancelled", "mcp-tool-error");
  return new Response(body, { status: 502, headers });
}

/**
 * The zero-install buyer CLI. Free, public, and proxied from the origin so the
 * Worker bundle stays small (the CLI is ~380 KB; inlining it here would bloat
 * every deploy for no benefit).
 */
app.get("/buy.mjs", (c) => proxyToBackend(c, "/buy.mjs", { method: "GET" }));

/** SSE stream for server-initiated messages. Free. */
app.get("/mcp", (c) => proxyToBackend(c, "/mcp", { method: "GET" }));

/** Session teardown. Free. */
app.delete("/mcp", (c) => proxyToBackend(c, "/mcp", { method: "DELETE" }));

// ---------------------------------------------------------------------------
// fallthrough
// ---------------------------------------------------------------------------

app.notFound((c) =>
  fail(c, "NOT_FOUND", newRequestId(), `No such endpoint: ${c.req.method} ${c.req.path}`),
);

app.onError((err, c) => {
  // Never surface a stack trace (SPEC section 22).
  console.error("[worker] unhandled error", err);
  return fail(c, "INTERNAL_ERROR", newRequestId());
});

export default app;
