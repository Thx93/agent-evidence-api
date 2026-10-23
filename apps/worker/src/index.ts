import { Hono } from "hono";
import type { Context } from "hono";
import {
  SERVICE_NAME,
  SERVICE_VERSION,
  errorResponse,
  ERROR_HTTP_STATUS,
  priceString,
  type ErrorCode,
} from "@aee/schemas";

import { DEMO_SAMPLE } from "./demo-sample.js";

/**
 * Escape text before it goes into an HTML page.
 *
 * The demo page interpolates content fetched from a third-party page, so this is
 * load-bearing rather than decorative: without it, a page we happen to retrieve
 * could inject markup into our own origin. Everything interpolated into an HTML
 * response goes through here.
 */
function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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
  /** Canonical public origin, e.g. https://agent-evidence.thx93.dev. */
  PUBLIC_ORIGIN: string;
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

/**
 * The one place the public origin comes from.
 *
 * Every URL this Worker renders - landing page, demo, llms.txt, OpenAPI, og:url -
 * is built from this, so changing the domain is one variable rather than a search
 * for seven literals that will drift apart.
 */
const publicOrigin = (env: Env): string =>
  (env.PUBLIC_ORIGIN || "https://agent-evidence.thx93.dev").replace(/\/+$/, "");

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

  // The free preview tier is quota'd per caller address, and only the edge knows that
  // address - the backend would otherwise see this Worker and count every preview
  // against one quota. cf-connecting-ip is set by Cloudflare and cannot be forged by
  // the client.
  const clientIp = c.req.header("cf-connecting-ip");
  if (clientIp) headers["x-forwarded-for"] = clientIp;

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
  const origin = publicOrigin(env);
  const net = env.X402_NETWORK === MAINNET ? "Base mainnet" : "Base Sepolia (testnet)";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Evidence API — cited web evidence and US weather for AI agents</title>
<!-- Social/SEO metadata. Without it a shared link renders as a bare URL with no
     title, description or card - which is how this service was being passed around
     before anyone looked. Text-only cards (summary) rather than a large image: an
     og:image needs a raster asset we do not have, and a card with an accurate
     description beats one with a placeholder graphic. -->
<meta name="description" content="Cited, source-grounded web evidence and claim verification plus US weather for AI agents. Paid per call in USDC on Base over x402. No API key, no account.">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Agent Evidence API">
<meta property="og:title" content="Agent Evidence API — cited evidence and US weather for agents">
<meta property="og:description" content="Send a question and up to 5 URLs; get cited passages with source URL, retrieval time and content hash, plus a supported/contradicted/mixed/inconclusive assessment. Also serves US weather alerts and forecasts. ${price} per call, no API key.">
<meta property="og:url" content="${origin}/">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="Agent Evidence API — cited evidence and US weather for agents">
<meta name="twitter:description" content="Cited, source-grounded web evidence and US weather for AI agents, ${price} per call over x402. No API key, no account. Free sample at /demo.">
<meta name="robots" content="index,follow">
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
<p class="sub">Cited, timestamped web evidence and National Weather Service data for agents. No account, no API key.</p>

<p>Send a question and the public pages you want checked. You get back short
quoted excerpts with their source URL, retrieval time and content hash, plus an
explicit <code>supported</code> / <code>contradicted</code> / <code>mixed</code> /
<code>inconclusive</code> assessment.</p>

<p class="price">${price} USDC per request · ${net} · paid over HTTP 402 (x402)</p>

<h2>Weather, too</h2>
<p>The same wallet pays for US weather from the National Weather Service. Useful when an
agent needs a forecast or an active alert and has no way to sign up for an API key:</p>
<pre><code>curl -X POST ${origin}/v1/weather/alerts \
  -H 'content-type: application/json' -d '{"state":"TX"}'

curl -X POST ${origin}/v1/weather/forecast \
  -H 'content-type: application/json' -d '{"latitude":37.7749,"longitude":-122.4194}'</code></pre>
<p>Both are over MCP as well, at <code>/weather/mcp</code> (<code>get-alerts</code> and
<code>get-forecast</code>). US locations only.</p>

<h2>See the paywall — no wallet needed</h2>
<pre><code>curl -X POST ${origin}/v1/evidence \
  -H 'content-type: application/json' \
  -d '{"question":"Is Rotamech a manufacturer of centrifugal pumps?","urls":["https://example.com"]}'</code></pre>
<p>You get a <code>402</code> with the price and the payment address. Nothing is charged.</p>
<p><strong>You are only charged when evidence is actually delivered.</strong> If every
source you asked for turns out to be unreachable, blocked, or unsupported, the request
fails and <em>no payment is taken</em> — x402 cancels settlement whenever the service
returns an error. Partial success does bill, because you received real evidence.</p>

<h2>Buy something (zero install)</h2>
<pre><code>curl -fsSL ${origin}/buy.mjs -o buy.mjs

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
  "url": "${origin}/mcp" } } }</code></pre>
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

<p><strong><a href="/demo">See a real sample first</a></strong> — an unedited
response from an actual paid call, with every source URL, retrieval time and
content hash. No wallet needed to look.</p>

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

/**
 * A free sample of real output (`/demo` for a human, `/demo.json` for an agent).
 *
 * Every other route here asks a visitor to take the service on faith: to judge
 * whether the evidence is any good you had to fund a wallet, install a client and
 * pay, then look. That is a lot of friction to evaluate a three-tenths-of-a-cent
 * call, and it is the friction that matters — the listings are already in place
 * and nobody has converted.
 *
 * So this serves one genuinely-produced package, verbatim, with the pipeline it
 * came from. It is a sample, not a live call, and the page says so plainly.
 */
function demoHtml(price: string, origin: string): string {
  const sources = DEMO_SAMPLE.sources
    .map((source) => {
      const excerpts = source.evidence
        .map(
          (item) =>
            `<blockquote><p>${escapeHtml(item.excerpt)}</p><cite>${escapeHtml(item.relevance)} · <code>${escapeHtml(item.context)}</code></cite></blockquote>`,
        )
        .join("\n");
      return `<section>
  <h3>${escapeHtml(source.title || "(untitled)")}</h3>
  <p class="meta"><a href="${escapeHtml(source.final_url)}" rel="noreferrer nofollow">${escapeHtml(source.final_url)}</a></p>
  <p class="meta">retrieved ${escapeHtml(source.retrieved_at)} · sha256 <code>${escapeHtml(source.content_hash_sha256.slice(0, 16))}…</code> · HTTP ${source.status}</p>
  ${excerpts}
</section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Evidence API — a real sample</title>
<style>
:root{color-scheme:light dark}
body{font:16px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:44rem;margin:2.5rem auto;padding:0 1.25rem}
h1{font-size:1.6rem;margin-bottom:.25rem}
h2{font-size:1.15rem;margin-top:2.25rem}
h3{font-size:1rem;margin-bottom:.2rem}
.meta{color:#666;font-size:.85rem;margin:.15rem 0}
.verdict{display:inline-block;padding:.15rem .6rem;border-radius:999px;background:#0a7d33;color:#fff;font-size:.85rem;font-weight:600}
blockquote{margin:.6rem 0;padding:.6rem .9rem;border-left:3px solid #8884;background:#8881}
blockquote p{margin:0}
cite{display:block;color:#666;font-size:.8rem;font-style:normal;margin-top:.35rem}
section{border-top:1px solid #8883;padding-top:1rem;margin-top:1rem}
code{font-size:.85em}
pre{background:#8881;padding:.85rem;border-radius:8px;overflow-x:auto;font-size:.82rem}
footer{margin-top:2.5rem;border-top:1px solid #8883;padding-top:1rem;color:#666;font-size:.85rem}
</style></head><body>
<h1>A real sample, unedited</h1>
<p class="meta">Produced by an actual paid call on 2026-10-18. Not a mock-up — this is the
exact response body, which is why every excerpt carries the URL, retrieval time and content hash it came from.</p>

<h2>The question</h2>
<p><strong>${escapeHtml(DEMO_SAMPLE.question)}</strong></p>
<p class="meta">Retrieved from <a href="${escapeHtml(DEMO_SAMPLE.sources[0]?.requested_url ?? "")}" rel="noreferrer nofollow">${escapeHtml(DEMO_SAMPLE.sources[0]?.requested_url ?? "")}</a></p>

<h2>The verdict</h2>
<p><span class="verdict">${escapeHtml(DEMO_SAMPLE.assessment.status)}</span></p>
<p>${escapeHtml(DEMO_SAMPLE.assessment.basis)}</p>

<h2>The cited evidence</h2>
${sources}

<h2>What it does not claim</h2>
<ul>${DEMO_SAMPLE.limitations.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>

<h2>Get this for your own question</h2>
<p>Discovery is free. You pay ${price} in USDC on Base only when a call returns
something, and never when nothing is retrieved.</p>
<pre>curl -s -X POST ${origin}/mcp \\
  -H 'content-type: application/json' \\
  -H 'accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'</pre>
<p class="meta">That call is free and lists the tools. The paid tool is
<code>research_evidence</code>. Raw JSON of this sample: <a href="/demo.json">/demo.json</a></p>

<footer>
<p><a href="/">Agent Evidence API</a> ·
<a href="/x402-market">market notes</a> ·
<a href="https://github.com/Thx93/agent-evidence-api">source</a> ·
<a href="/health?deep=1">status</a></p>
<p>No customer data appears on this page: the question was asked by the operator,
and every excerpt is public page content that the source already publishes.</p>
</footer>
</body></html>`;
}

app.get("/demo", (c) =>
  c.html(demoHtml(priceString(c.env.X402_PRICE_USD), publicOrigin(c.env)), 200, { "cache-control": "public, max-age=600" }),
);

/** The same sample as raw JSON, for an agent that would rather parse than read. */
app.get("/demo.json", (c) =>
  c.json(DEMO_SAMPLE, 200, {
    "cache-control": "public, max-age=600",
    "access-control-allow-origin": "*",
  }),
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
      "Evidence and US weather for AI agents. Returns structured, cited, freshly-retrieved " +
      "evidence from public web pages so an agent can verify claims and ground answers in " +
      "sources, and serves National Weather Service alerts and forecasts so an agent can " +
      "answer weather questions without an API key or an account.",
    // This is the free description of the service - what a caller reads before deciding
    // whether to pay for anything. It described only the evidence capability for as long
    // as the weather routes existed, which is the one place a buyer looks first.
    endpoints: {
      health: "GET /health (free)",
      /** A real response, served free so it can be judged before paying. */
      demo: "GET /demo (free HTML) and GET /demo.json (free JSON)",
      evidence: "POST /v1/evidence (paid, x402)",
      weatherAlerts:
        "POST /v1/weather/alerts (paid, x402) - active NWS alerts for a two-letter state code",
      weatherForecast:
        "POST /v1/weather/forecast (paid, x402) - five forecast periods for a latitude and longitude",
      mcp: "POST /mcp (MCP streamable HTTP; initialize and tools/list are free)",
      weatherMcp: "POST /weather/mcp (MCP; exposes get-alerts and get-forecast)",
    },
    mcp: {
      transport: "streamable-http",
      endpoints: { evidence: "POST /mcp", weather: "POST /weather/mcp" },
      tools: {
        research_evidence: "paid",
        sample: "free",
        health: "free",
        "get-alerts": "paid",
        "get-forecast": "paid",
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

/**
 * Put the x402 terms in the 402 BODY, not only in a header.
 *
 * x402 v2 carries the PaymentRequired object in the `payment-required` response
 * header, and that is what the backend emits. But a validator that reads the body -
 * which is what most catalogue checkers do - sees only a generic error and concludes
 * the endpoint is not payable. payforapi.com's checker said exactly that: "expected
 * HTTP 402 with payment details", against a 402 whose header held a perfectly
 * well-formed challenge.
 *
 * Their own endpoints put the object in the body. So this promotes the header into
 * the body and keeps the human-readable error alongside it, which is additive: any
 * client reading either place finds the terms.
 */
/**
 * True when the request came in on the legacy workers.dev host rather than the
 * canonical domain. Used only to decide whether to advertise for cataloguing.
 */
function isAliasHost(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(".workers.dev");
  } catch {
    return false;
  }
}

async function withPaymentBody(
  res: Response,
  opts: { stripBazaar?: boolean } = {},
): Promise<Response> {
  if (res.status !== 402) return res;
  const encoded = res.headers.get("payment-required");
  if (!encoded) return res;

  let required: Record<string, unknown>;
  try {
    const bytes = Uint8Array.from(atob(encoded), (ch) => ch.charCodeAt(0));
    required = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return res;
  }

  if (opts.stripBazaar && required.extensions && typeof required.extensions === "object") {
    const extensions = { ...(required.extensions as Record<string, unknown>) };
    delete extensions.bazaar;
    if (Object.keys(extensions).length === 0) delete required.extensions;
    else required.extensions = extensions;
  }

  let existing: Record<string, unknown> = {};
  try {
    existing = (await res.clone().json()) as Record<string, unknown>;
  } catch {
    // A non-JSON body is left alone; the terms are still in the header.
  }

  const headers = new Headers(res.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  // The body changed shape, so a cached length would be wrong.
  headers.delete("content-length");

  if (opts.stripBazaar) {
    // The header carries the same object, so it has to lose the declaration too or
    // a crawler reading the header would still catalogue the old URL.
    const bytes = new TextEncoder().encode(JSON.stringify(required));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    headers.set("payment-required", btoa(binary));
  }

  return new Response(JSON.stringify({ ...required, ...existing }), {
    status: 402,
    headers,
  });
}


/**
 * Present the payment challenge to GET and HEAD.
 *
 * These routes are POST-only, but answering GET with 404 made a payable endpoint
 * look dead to every prober that checks it the simple way. payforapi.com's validator
 * does exactly that: it GETs the URL and expects `402 PaymentRequired`, and their own
 * endpoints answer 402 on GET. Ours returned 404, so the listing was rejected with
 * "the service does not respond over the x402 protocol" even though a POST returns a
 * perfectly well-formed challenge.
 *
 * The proxy call is made as a POST because that is the declared route; the challenge
 * it returns is method-agnostic in x402 - it names the resource, the price and the
 * payTo, not the verb. A caller that then POSTs proceeds normally.
 */
for (const path of ["/v1/evidence", "/v1/weather/alerts", "/v1/weather/forecast"]) {
  const internal = `/internal${path}`;
  app.on(["GET", "HEAD"], path, async (c) => {
    const res = await proxyToBackend(c, internal, { method: "POST", body: "", contentType: "application/json" });
    res.headers.set("allow", "POST, GET, HEAD");
    return withPaymentBody(res, { stripBazaar: isAliasHost(c.req.url) });
  });
}

/**
 * The weather capabilities over plain HTTP, forwarded like the evidence route.
 *
 * The same origin-health gate applies: a 402 here would quote terms we cannot honour
 * if the backend is down.
 */
for (const path of ["/v1/weather/alerts", "/v1/weather/forecast"]) {
  app.use(path, async (c, next) => {
    if (c.req.method !== "POST") return next();
    if (!(await originHealthy(c.env))) {
      return fail(
        c,
        "BACKEND_UNREACHABLE",
        newRequestId(),
        "The weather service is temporarily unavailable; no payment was taken.",
      );
    }
    return next();
  });

  app.post(path, async (c) => {
    // Raw body, unparsed: see the note on the evidence route. A probe that posts
    // nothing must still receive the 402 challenge, not a 400 about its body.
    const raw = await c.req.text();
    return withPaymentBody(
      await proxyToBackend(c, `/internal${path}`, {
        method: "POST",
        body: raw,
        contentType: "application/json",
      }),
      { stripBazaar: isAliasHost(c.req.url) },
    );
  });
}

// ---------------------------------------------------------------- free preview
//
// Deliberately outside the paywall: these return a bounded, real result so a buyer
// can judge the output before spending anything. They are NOT in the x402 manifest
// and never answer a bare 402-less probe on the paid paths, because cataloguing
// depends on the paid routes answering 402.
app.post("/v1/evidence/preview", async (c) => {
  const raw = await c.req.text();
  return proxyToBackend(c, "/internal/v1/evidence/preview", {
    method: "POST",
    body: raw,
    contentType: "application/json",
  });
});

for (const path of ["/v1/weather/alerts/preview", "/v1/weather/forecast/preview"]) {
  app.get(path, (c) => {
    const search = new URL(c.req.url).search;
    return proxyToBackend(c, `/internal${path}${search}`, { method: "GET" });
  });
}

app.post("/v1/evidence", async (c) => {
  // The raw body is forwarded unparsed, deliberately.
  //
  // Parsing here answered 400 to a probe that posts an empty body - before the
  // caller had been shown the price - which is how an x402 prober concludes the
  // endpoint simply is not payable. payforapi.com's validator does exactly that and
  // reported "the service does not respond over x402: expected HTTP 402". The
  // backend's paywall runs in an `onRequest` hook, which is before body parsing, so
  // forwarding raw gives the documented order: challenge first, validation second,
  // and settlement cancelled if validation then fails.
  const raw = await c.req.text();

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
  return withPaymentBody(
    await proxyToBackend(c, "/internal/v1/evidence", {
      method: "POST",
      body: raw,
      contentType: "application/json",
    }),
    { stripBazaar: isAliasHost(c.req.url) },
  );
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
/**
 * Both MCP services — `/mcp` for evidence, `/weather/mcp` for weather — share one
 * gate at the edge: a body size cap and an origin health check. Which tools cost
 * money is decided in the backend, per route, so this stays a pass-through.
 */
const MCP_PATHS = ["/mcp", "/weather/mcp"] as const;

for (const path of MCP_PATHS) {
  app.use(path, async (c, next) => {
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

  app.post(path, async (c) => {
    const raw = (c.get("mcpBody" as never) as string | undefined) ?? "";
    // Same treatment as the HTTP routes: the canonical host advertises itself for
    // cataloguing, the workers.dev alias does not. Without this the alias would keep
    // publishing declarations for tools the catalogue has already attributed to it,
    // and the custom-domain entries could never take those names.
    return withPaymentBody(
      await proxyToBackend(c, path, {
        method: "POST",
        body: raw,
        contentType: "application/json",
      }),
      { stripBazaar: isAliasHost(c.req.url) },
    );
  });

  /** SSE stream for server-initiated messages. Free. */
  app.get(path, (c) => proxyToBackend(c, path, { method: "GET" }));

  /** Session teardown. Free. */
  app.delete(path, (c) => proxyToBackend(c, path, { method: "DELETE" }));
}

/**
 * The zero-install buyer CLI. Free, public, and proxied from the origin so the
 * Worker bundle stays small (the CLI is ~380 KB; inlining it here would bloat
 * every deploy for no benefit).
 */
app.get("/buy.mjs", (c) => proxyToBackend(c, "/buy.mjs", { method: "GET" }));

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
 *
 * The body is built in the BACKEND and proxied here. It used to be assembled in
 * this file from the Worker's own X402_* variables, which are display-only — a
 * second copy of the terms that could drift from what the backend actually
 * charges. Worse, both resources were described with one shared `accepts` entry
 * hard-coded to `/v1/evidence`, so the MCP resource advertised the wrong
 * `resource` and a crawler could not tell how to pay for `/mcp`.
 */

/**
 * mcprush.com domain-ownership proof.
 *
 * mcprush lists MCP servers and groups a publisher's listings by what proves
 * ownership. The GitHub proof already verified (@Thx93 owns both repositories),
 * which is what filed the Weather MCP claim (CLM-9988). This host is a second
 * listing under a *domain* proof, and mcprush asks for a token file at this path
 * on the connector's own origin before it will accept that claim:
 *
 *   "There is no file at that address yet. Your server has to answer it over
 *    HTTPS with the token in the body."
 *
 * The token is not a secret in the usual sense - the entire scheme is that it is
 * published at a public URL so mcprush can fetch it and confirm the file is on the
 * origin it is claiming. Deleting this route unfiles the listing.
 *
 * One token per line, plain text, exactly as they ask.
 */
app.get("/.well-known/mcprush.com-claim.txt", (c) =>
  c.text("mcprush.com-bb0130b229fe1d48a31fbb1c\n", 200, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "public, max-age=300",
  }),
);

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
 * URL so Glama can fetch it. This is the method that needs no DNS zone, which
 * matters because a workers.dev subdomain has none. The GitHub method is open now
 * that the repository is public (since 2026-09-24), but it would mean a second
 * copy of the token in the repo root kept in step with this route. One method is
 * enough.
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

/**
 * The x402 capability manifest, proxied from the backend.
 *
 * The body is built where the paywall lives, from the same `config.x402` the 402
 * challenge is built from, so the two cannot diverge. This route only decides how
 * the manifest is *served*: public, cacheable, and readable cross-origin by the
 * crawlers and indexes that fetch it.
 */
app.get("/.well-known/x402", async (c) => {
  const res = await proxyToBackend(c, "/.well-known/x402", { method: "GET" });
  // A crawler and any page may read this cross-origin.
  res.headers.set("access-control-allow-origin", "*");
  // proxyToBackend forces `no-store`, which is right for a paid response and
  // wrong for a public manifest a crawler is expected to cache. Only a good
  // response gets the cacheable policy - an upstream failure stays uncached.
  if (res.ok) {
    res.headers.set("cache-control", "public, max-age=300");
  }
  return res;
});

/**
 * A favicon, because discovery warns without one.
 *
 * x402scan's audit reports FAVICON_MISSING as its only complaint about this origin.
 * An API has no tab to decorate, but the check exists for a reason: a listing that
 * looks unfinished is a listing a buyer trusts less, and this clears the last
 * warning standing between us and a clean record. Served as SVG, which is what the
 * one icon we have is - the .ico path returns the same bytes rather than pretending
 * to be a bitmap format we did not generate.
 */
const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
  '<rect width="32" height="32" rx="7" fill="#0f172a"/>' +
  '<path d="M9 8h10l4 4v12H9z" fill="none" stroke="#e2e8f0" stroke-width="2" stroke-linejoin="round"/>' +
  '<path d="M12 18l3 3 6-6" fill="none" stroke="#34d399" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
  "</svg>";

app.get("/favicon.svg", (c) =>
  c.body(FAVICON_SVG, 200, {
    "content-type": "image/svg+xml; charset=utf-8",
    "cache-control": "public, max-age=86400",
  }),
);

app.get("/favicon.ico", (c) =>
  c.body(FAVICON_SVG, 200, {
    "content-type": "image/svg+xml; charset=utf-8",
    "cache-control": "public, max-age=86400",
  }),
);

/**
 * `/llms.txt` — the generative-engine surface.
 *
 * Answer engines and agent crawlers look for this file by convention (llmstxt.org):
 * a short, plain-text, unambiguous statement of what a site offers, so a model can
 * cite it accurately instead of inferring from marketing HTML. We published none, so
 * the only thing a crawler could read was the landing page and the OpenAPI spec.
 *
 * Written for extraction, not persuasion: one sentence defining the service, the
 * exact prices, the exact paths, and the limits stated plainly. A model that quotes
 * this should be correct, including about what the service cannot do.
 */
const llmsTxt = (price: string, origin: string): string => `# Agent Evidence API

> Cited, source-grounded web evidence and US weather for AI agents. Paid per call in
> USDC on Base over x402. No API key, no account, no signup.

## What this is

Agent Evidence API is an HTTP and MCP service for AI agents. It has two capabilities:

1. **Evidence and claim verification.** You send a question and up to five public URLs.
   It fetches those pages, extracts the passages that bear on the question, and returns
   them with the source URL, retrieval time and content hash, plus an assessment of
   \`supported\` / \`contradicted\` / \`mixed\` / \`inconclusive\`.
2. **US weather.** Active National Weather Service alerts for a state, and five-period
   forecasts for a latitude and longitude.

It is not a web scraper, a search engine, or a crawler. You supply the URLs; the
service does not find sources for you.

## Price

${price} USDC per call, on Base (\`eip155:8453\`), paid through x402. Nothing is charged
when nothing is retrieved: if a request cannot be served, settlement is cancelled.

## Origin

\`${origin}\`

## Endpoints

- \`POST /v1/evidence\` — paid. Body: \`{"question": string, "urls": string[]}\` (1-5 URLs).
- \`POST /v1/weather/alerts\` — paid. Body: \`{"state": "TX"}\` (two-letter US state).
- \`POST /v1/weather/forecast\` — paid. Body: \`{"latitude": number, "longitude": number}\`.
- \`POST /mcp\` — paid MCP over streamable HTTP. Tools: \`research_evidence\` (paid),
  \`sample\` (free), \`health\` (free).
- \`POST /weather/mcp\` — paid MCP. Tools: \`get-alerts\`, \`get-forecast\`, \`health\`.

## Free, without paying

- \`GET /health\` — liveness.
- \`GET /demo\` and \`GET /demo.json\` — one complete, unedited evidence package produced
  by a real paid call, so the output can be judged before anything is bought.
- \`GET /\` — a capability document listing every endpoint and price.
- MCP \`initialize\`, \`tools/list\` and the \`sample\` tool are free on both MCP endpoints.
- \`POST /v1/evidence/preview\` — free. One source, up to three excerpts with full
  provenance, no assessment. Twenty-five previews per address per day.
- \`GET /v1/weather/alerts/preview?state=TX\` and
  \`GET /v1/weather/forecast/preview?latitude=..&longitude=..\` — free, same quota.

## Machine-readable

- \`/.well-known/x402\` — the x402 capability manifest, all five paid resources.
- \`/openapi.json\` — the OpenAPI 3.1 discovery contract.

## Limits, stated plainly

- Weather is US only: it is the US National Weather Service's data.
- Evidence is retrieved from the URLs you supply; there is no built-in search.
- Assessment uses deterministic lexical matching, not semantic reasoning. When a
  question asks more than one thing and only one source contributed a matching
  passage, the service answers \`inconclusive\` rather than guessing.

## Source

https://github.com/Thx93/agent-evidence-api
`;

app.get("/llms.txt", (c) =>
  c.body(llmsTxt(priceString(c.env.X402_PRICE_USD), publicOrigin(c.env)), 200, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "public, max-age=3600",
    "access-control-allow-origin": "*",
  }),
);

/**
 * The OpenAPI discovery contract, at the path the crawlers ask for.
 *
 * x402scan will not list an origin without it ("Publish your spec at
 * /openapi.json"), and Agent402 reads it beside `/.well-known/x402` and reported
 * "Source URL returned HTTP 404" for us while it was missing. Served from the
 * backend so the prices and version in it come from the same configuration as the
 * live challenge, and cached like the manifest because it is a public document a
 * crawler is expected to re-read.
 */
app.get("/openapi.json", async (c) => {
  const res = await proxyToBackend(c, "/openapi.json", { method: "GET" });
  res.headers.set("access-control-allow-origin", "*");
  if (res.ok) {
    res.headers.set("cache-control", "public, max-age=300");
  }
  return res;
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
