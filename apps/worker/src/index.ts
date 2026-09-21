import { Hono } from "hono";
import type { Context } from "hono";
import {
  SERVICE_NAME,
  SERVICE_VERSION,
  errorResponse,
  ERROR_HTTP_STATUS,
  priceString,
  priceAtomicUnits,
  type ErrorCode,
} from "@aee/schemas";

/**
 * Cloudflare Worker — the public edge (SPEC section 13).
 *
 *   client ──▶ Worker ──proxy──▶ backend origin (X-Backend-Auth, x402 gate)
 *
 * This process stays deliberately thin: it validates request shape, forwards
 * authorised requests, and serves the free discovery surfaces. All fetching,
 * parsing, reasoning AND payment enforcement happen on the VPS backend.
 *
 * The x402 gate used to run here. It cannot any more, and not for want of
 * configuration: the CDP Facilitator — the only route into the CDP Bazaar, the
 * Bazaar MCP server, Amazon Bedrock AgentCore and agentic.market — cannot run in
 * a Worker at all. Its JWT signing reaches an undefined `getRandomValues`, and
 * the x402 library compiles its bazaar schema with `new Function`, which Workers
 * forbid by design. Both are documented in docs/market-analysis.md. The Worker
 * now forwards the buyer's `payment-signature` and nothing else.
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
}

type Ctx = Context<{ Bindings: Env }>;

/** Base mainnet. */
const MAINNET = "eip155:8453";

/** Hard cap on a JSON-RPC body the edge will buffer. Cheap rejection. */
const MAX_MCP_BODY_BYTES = 64 * 1024;

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function fail(c: Ctx, code: ErrorCode, requestId: string, message?: string) {
  return c.json(errorResponse(code, requestId, message), ERROR_HTTP_STATUS[code] as never);
}

// priceString lives in @aee/schemas so it can be unit-tested; a Worker module
// cannot be imported by the Node test runner.

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

  // Forward the payment proof: the backend's x402 middleware is the only thing
  // that reads it. The Worker no longer parses or verifies a payment at all.
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
  // `payment-required` is the 402 challenge itself; `payment-response` is the
  // settlement receipt. Both are generated by the backend's x402 middleware and
  // have to be forwarded, or a buyer (and CDP's validator) sees a bare 402.
  for (const h of ["payment-required", "payment-response", "mcp-session-id"]) {
    const v = upstream.headers.get(h);
    if (v) outHeaders.set(h, v);
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
<pre><code>curl -X POST ${"https://agent-evidence-api.thx93.workers.dev"}/v1/evidence \
  -H 'content-type: application/json' \
  -d '{"question":"Is Rotamech a manufacturer of centrifugal pumps?","urls":["https://example.com"]}'</code></pre>
<p>You get a <code>402</code> with the price and the payment address. Nothing is charged.</p>
<p><strong>You are only charged when evidence is actually delivered.</strong> If every
source you asked for turns out to be unreachable, blocked, or unsupported, the request
fails and <em>no payment is taken</em> — x402 cancels settlement whenever the service
returns an error. Partial success does bill, because you received real evidence.</p>

<h2>Buy something (zero install)</h2>
<pre><code>curl -fsSL ${"https://agent-evidence-api.thx93.workers.dev"}/buy.mjs -o buy.mjs

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
  "url": "${"https://agent-evidence-api.thx93.workers.dev"}/mcp" } } }</code></pre>
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

/**
 * The x402 market measurement, published.
 *
 * A data-driven post is only actionable if it has somewhere to land, and this is
 * the one artefact this project has that nobody else had published at the time.
 * Deliberately aggregated: it names no seller, because the point is the shape of
 * the market rather than any individual's numbers.
 */
function marketReportHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>The x402 market, measured — 15,228 resources, median seller $0.08/month</title>
<style>
 body{max-width:44rem;margin:3rem auto;padding:0 1.25rem;font:16px/1.65 ui-sans-serif,system-ui,sans-serif;color-scheme:light dark}
 h1{font-size:1.55rem;margin-bottom:.2rem}h2{font-size:1.05rem;margin-top:2rem}
 table{border-collapse:collapse;font-size:.93rem;width:100%}td{padding:.3rem .8rem .3rem 0;vertical-align:top;border-bottom:1px solid rgba(127,127,127,.18)}
 td:last-child{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
 code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
 pre{background:rgba(127,127,127,.12);padding:.85rem;border-radius:8px;overflow-x:auto;font-size:.85rem}
 .sub{opacity:.72;margin-top:0}.big{font-weight:700}
</style></head><body>

<h1>The x402 market, measured</h1>
<p class="sub">Whole catalogue, not a sample. 21 September 2026.</p>

<p>Every x402 catalogue entry that publishes usage, paged in full, then checked
on-chain. The published per-resource payer count overstates the market badly: one
seller publishing ~70 routes behind a single payout address reported ~18,300
payer-slots, while <strong>534 distinct wallets</strong> actually paid that address in
seven days.</p>

<h2>Thirty days</h2>
<table>
<tr><td>resources in the CDP Bazaar</td><td class="big">15,228</td></tr>
<tr><td>distinct payout addresses (sellers)</td><td class="big">1,362</td></tr>
<tr><td>sellers with more than ten buyers</td><td class="big">141</td></tr>
<tr><td>sellers with more than a hundred buyers</td><td class="big">6</td></tr>
<tr><td>volume</td><td>$869k organic</td></tr>
<tr><td>median seller revenue</td><td class="big">$0.08</td></tr>
<tr><td>top 10 sellers' share of volume</td><td class="big">78.9%</td></tr>
</table>

<h2>Seven days, verified from USDC transfers on Base</h2>
<table>
<tr><td>distinct wallets paying the top 15 sellers (76% of calls)</td><td>1,855</td></tr>
<tr><td>union across the top 75 sellers (~80% of calls)</td><td class="big">2,764</td></tr>
<tr><td>of those, wallets making 100+ payments</td><td>421 (22.7%)</td></tr>
<tr><td>…and their share of all payments</td><td class="big">83.7%</td></tr>
<tr><td>wallets paying both a content seller and an assessment seller</td><td>204</td></tr>
<tr><td>wallets in the verification / evidence category</td><td class="big">228</td></tr>
</table>

<p>Read together: this is a few hundred agent loops, not a market. The single largest
endpoint by call volume drew 326,493 calls from 183 wallets — about 1,800 calls per
payer. Independent work reaches the same place: TRM Labs measured that only
<strong>0.6–7.5%</strong> of screened x402 commerce is plausibly agentic.</p>

<h2>Buy the data</h2>
<p>The full dataset and method — the complete catalogue snapshot, distinct paying
wallets per seller read from Base, and the analysis scripts — is
<strong>$25 in USDC on Base</strong>:</p>
<pre><code>0x9c0e2B44180439294Fa30Ae2B2a94f8655455FD0</code></pre>
<p>Send it, then reply to whichever message brought you here with the transaction
hash, and the data plus the scripts follow the same day. If you would rather not pay,
ask and the summary tables are free.</p>

<h2>Reproduce it</h2>
<pre><code>node scripts/analyze-bazaar-demand.mjs --refresh   # pages all 15,228 resources
node scripts/count-x402-payers.mjs &lt;payTo&gt; 7      # distinct wallets, from the chain</code></pre>
<p>Both ship with the service's repository. The chain is the authority, not the
catalogue's own counters.</p>

<p><a href="/">Agent Evidence API</a> · <a href="/health?deep=1">status</a></p>
</body></html>`;
}

app.get("/x402-market", (c) =>
  c.html(marketReportHtml(), 200, { "cache-control": "public, max-age=600" }),
);

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

// NOTE: this route no longer applies the x402 gate. Enforcement moved to the
// backend, because the CDP Facilitator - the only route into the CDP Bazaar - cannot
// run in a Worker at all. See the paywall comment in apps/backend/src/app.ts for the
// two Workers restrictions that made that necessary. The origin check stays: a 402
// here would quote terms we cannot honour if the origin is down.
app.use("/v1/evidence", async (c, next) => {
  if (c.req.method !== "POST") return next();
  if (!(await originHealthy(c.env))) {
    return fail(
      c,
      "BACKEND_UNREACHABLE",
      newRequestId(),
      "The evidence service is temporarily unavailable; no payment was taken.",
    );
  }
  return next();
});

app.post("/v1/evidence", async (c) => {
  const requestId = newRequestId();

  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    return fail(c, "INVALID_REQUEST", requestId, "Request body must be valid JSON.");
  }

  // Shape validation deliberately does NOT happen here any more. The paywall now
  // runs in the backend, so validating first would answer 400 to a caller who has
  // not been shown the price - and CDP's validator probes with a generic body and
  // reported "Endpoint returned HTTP 400 instead of 402" for exactly that reason.
  //
  // The HTTP semantics this service documents are paywall-then-validation: an
  // unpayable request gets the challenge, and an invalid request that pays still
  // fails validation downstream - where the middleware cancels settlement, so it is
  // never charged. The backend validates every request through EvidenceService, so
  // nothing is lost by removing the duplicate check.
  return proxyToBackend(c, "/internal/v1/evidence", {
    method: "POST",
    body: JSON.stringify(parsed),
    contentType: "application/json",
  });
});

// ---------------------------------------------------------------------------
// MCP endpoint (streamable HTTP)
// ---------------------------------------------------------------------------
//
// The MCP paywall lives in the backend, alongside the HTTP one, and for one
// concrete reason beyond tidiness: the x402 catalogue is populated PER ROUTE, so
// only a route that settles through the CDP Facilitator is catalogued. While this
// route was gated at the edge it settled through the generic facilitator, so
// `research_evidence` was absent from what the Bazaar MCP server enumerates — the
// one discovery path that does not depend on a buyer guessing a keyword.
//
// It also has to be in the backend for a mechanical reason: the free/paid decision
// needs the parsed JSON-RPC body. `@x402/fastify` hooks `onRequest`, which runs
// before Fastify parses the body, so a body-aware decision cannot be made there.
//
// Nothing here parses a payment. This route buffers the body (to enforce a size
// cap cheaply and to forward the exact bytes), checks the origin is alive, and
// proxies.

/**
 * Buffer the JSON-RPC body, cap its size, and refuse the paid path when the
 * origin is down.
 *
 * Origin health is checked before forwarding because the 402 challenge must come
 * from the backend: if the origin cannot answer, answering 402 here would quote
 * terms this service cannot honour. A free handshake is not blocked by it — the
 * origin is the thing that would serve it either way.
 */
app.use("/mcp", async (c, next) => {
  if (c.req.method !== "POST") return next();

  const raw = await c.req.text();
  if (raw.length > MAX_MCP_BODY_BYTES) {
    return fail(c, "INVALID_REQUEST", newRequestId(), "Request body is too large.");
  }
  c.set("mcpBody" as never, raw as never);

  if (!(await originHealthy(c.env))) {
    return fail(
      c,
      "BACKEND_UNREACHABLE",
      newRequestId(),
      "The evidence service is temporarily unavailable; no payment was taken.",
    );
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
// x402 well-known manifest
// ---------------------------------------------------------------------------

/**
 * The host's x402 capability manifest.
 *
 * Draft-hawkins-x402-dns-discovery defines this as the authoritative,
 * machine-readable record of a host's x402 capability - the piece x402 does not
 * itself provide, because a 402 only describes payment terms at the moment a
 * client already knows to ask. Crawlers and indexes fetch it directly.
 *
 * This was missing, and it cost us. Agent402's index - which routes matching
 * buyer tasks to sellers and pays them from its own wallet - fetches
 * `/.well-known/x402` plus the origin's openapi.json, and its self-serve
 * registration answered "Source URL returned HTTP 404" for our origin. A Bazaar
 * listing alone does not make an origin legible to a crawler that looks here.
 *
 * `kind` is "resource-server": we consume a facilitator, we do not provide one,
 * so the `facilitator` block the draft requires of facilitators does not apply.
 */
/**
 * One `accepts` entry describing how to pay for a resource.
 *
 * Built from the live bindings, not hard-coded, so the manifest and the 402
 * challenge cannot disagree.
 */
function acceptsEntry(env: Env, base: string): Record<string, unknown> {
  // Same source as the 402 challenge, so the two cannot disagree.
  const amount = priceAtomicUnits(env.X402_PRICE_USD);
  return {
    scheme: "exact",
    network: env.X402_NETWORK,
    asset: USDC_BASE,
    payTo: env.X402_RECIPIENT,
    amount,
    maxTimeoutSeconds: 300,
    resource: `${base}/v1/evidence`,
    extra: { name: "USD Coin", version: "2" },
  };
}

/** USDC on Base mainnet - the settlement asset (SPEC section 11). */
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/**
 * Domain-ownership proof for 402 Index.
 *
 * They verify a domain by asking for a SHA-256 hash at this path - an HTTP
 * challenge, not DNS, which matters because a workers.dev subdomain has no DNS
 * zone we could add a TXT record to. A verified domain is ranked first in their
 * directory, which is the only reason to bother.
 *
 * The file contains the HASH, never the token: the token is the ongoing
 * credential for editing listings and is deliberately not in this repository.
 */
app.get("/.well-known/402index-verify.txt", (c) =>
  c.text("f81447cf52c146a84aa6fb3f2ab6081216d1ff6b0508145e1f851c4455f7d300\n", 200, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "public, max-age=300",
  }),
);

/**
 * glama.ai connector-ownership proof.
 *
 * Glama lists this MCP server (crawled from the official registry, scored 4.3/5.0)
 * and lets the author claim it. Claiming is what unlocks usage reports - the only
 * analytics available to us, and the only way to learn whether anyone is finding
 * this at all.
 *
 * The claim is proven by serving this exact JSON on the connector's own origin.
 * The token is NOT a secret: the whole scheme is that it is published at a public
 * URL so Glama can fetch it. The other two methods are unavailable to us - the
 * GitHub method needs a public repository (ours is private) and the DNS method needs
 * a DNS zone (a workers.dev subdomain has none).
 *
 * DO NOT REMOVE THIS ROUTE. Glama re-checks periodically and ownership lapses if the
 * file stops being discoverable; when it lapses the usage reports go with it.
 */
app.get("/.well-known/glama.json", (c) =>
  c.json(
    {
      $schema: "https://glama.ai/mcp/schemas/connector.json",
      claim: "glama_claim_Q_TR9WzmB7yGxCqFoVqs1uiNipCRlCsO",
    },
    200,
    { "cache-control": "public, max-age=300" },
  ),
);

app.get("/.well-known/x402", (c) => {
  const base = new URL(c.req.url).origin;
  return c.json(
    {
      x402Version: 2,
      kind: "resource-server",
      name: "Agent Evidence API",
      description:
        "Cited, source-grounded web evidence for AI agents. Send a question and up to " +
        "5 public URLs; get back the passages that support, contradict or fail to settle " +
        "it, each with its source URL, retrieval time and content hash. Never charges when " +
        "nothing is retrieved.",
      // Payment terms MUST ride on each resource. A manifest that lists only a
      // URL and a description leaves crawlers unable to learn the chain, and
      // Agent402 names that outcome exactly: "listed and unroutable", row
      // "chainless", reason `network_unknown`. Their reader derives the terms
      // from `resources[].accepts` (the same shape the live 402 returns) or from
      // flat network/asset/payTo/amount fields.
      //
      // Taken from the same bindings the paywall uses, so the manifest cannot
      // drift from the live challenge - the draft calls divergence between the
      // two a misconfiguration.
      resources: [
        {
          url: `${base}/v1/evidence`,
          method: "POST",
          // The indexed description IS the search surface. Agent402 reads this
          // into its own index, and its search ranks on match score first - so a
          // terse "HTTPS evidence endpoint" loses to sellers who say what the
          // caller gets using the words a caller would type. Same lesson as the
          // Bazaar listing, applied to the manifest.
          description:
            "Verify a claim or fact check a statement against public web sources: send a " +
            "question and up to 5 URLs, get cited evidence - the passages that support, " +
            "contradict or fail to settle it, each with its source URL, retrieval time and " +
            "content hash. Claim verification and evidence extraction for AI agents. Never " +
            "charges when nothing is retrieved.",
          accepts: [acceptsEntry(c.env, base)],
        },
        {
          url: `${base}/mcp`,
          method: "POST",
          description:
            "MCP tool research_evidence: verify a claim or answer a question against public " +
            "web sources, returning cited evidence with a citation for every excerpt. " +
            "Claim verification, evidence extraction and source-grounded research over MCP " +
            "streamable HTTP. Free tools: health and tools/list.",
          accepts: [acceptsEntry(c.env, base)],
        },
      ],
      attestation: { type: "none" },
      docs: `${base}/`,
      updated: new Date().toISOString(),
    },
    200,
    {
      // Public data, explicitly so: a crawler must be able to read it cross-origin.
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  );
});

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
