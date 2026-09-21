# Agent Evidence API

**Evidence infrastructure for AI agents.** Give it a question or a claim plus the
public web pages you want checked, and it returns structured, cited evidence:
source URLs, retrieval timestamps, short evidence excerpts, metadata, and an
explicit `supported` / `contradicted` / `mixed` / `inconclusive` assessment.

It is reachable by agents over **both** HTTP and **MCP**, and it is paid per
request with **x402 + USDC on Base**. There are no accounts, no passwords, and no
API keys — the payment is the authentication.

- Product specification: [`SPEC.md`](./SPEC.md) — the authority on requirements.
- Engineering rules: [`AGENTS.md`](./AGENTS.md) — the **sole** project rule book.
- Architecture: [`docs/architecture.md`](./docs/architecture.md)

> **It provides evidence, not truth.** The assessment is produced by deterministic
> lexical matching, and the service says `inconclusive` rather than guessing. Do
> not treat a `supported` status as proof.

> **Implementation status — read this first.** Every package and both apps are
> implemented, and `pnpm typecheck` passes across the whole workspace. `pnpm test`
> covers ~147 cases in six suites, including a cross-package end-to-end flow test.
>
> What is **not** done: no on-chain x402 payment has been demonstrated, there is
> no automated x402 payment test, `ROBOTS_POLICY` is configured but inert, and two
> committed literal test wallet addresses in `apps/worker/wrangler.jsonc` need
> replacing before any deployment. See
> [Implementation status](#implementation-status).

---

## 1. What the service does

An agent submits:

- a **question or claim**, and
- one or more **public URLs** to use as sources.

The service then:

1. validates the URL and rejects anything unsafe (SSRF defences),
2. fetches the page with bounded timeouts, redirects, and response size,
3. detects the content type and parses the HTML,
4. extracts metadata (title, description, canonical URL, Open Graph, JSON-LD,
   language, publication and modification dates, headings, word count),
5. normalises the main content and produces a SHA-256 content hash,
6. extracts short evidence excerpts that match the question, with their position
   in the document,
7. compares the sources and reaches an assessment,
8. returns a structured response with full provenance.

It is **not** a web scraper, an SEO tool, a generic crawler, a proxy, a
browser-automation service, or a search engine. It is evidence infrastructure:
the thing an agent calls when it needs to *show its work*.

### What comes back

```json
{
  "request_id": "req_3f9c1a7b2e4d4a6f8b0c1d2e",
  "version": "1",
  "question": "Is Rotamech Industries a manufacturer of centrifugal pumps?",
  "assessment": {
    "status": "supported",
    "basis": "1 source(s) contained passages matching the question (example.invalid) with no contradicting passages found."
  },
  "sources": [
    {
      "requested_url": "https://example.invalid/products",
      "final_url": "https://example.invalid/products",
      "status": 200,
      "content_type": "text/html; charset=utf-8",
      "title": "Rotamech Industries — Products",
      "canonical_url": "https://example.invalid/products",
      "description": "Rotamech Industries manufactures centrifugal pumps for industrial use.",
      "publisher": "Rotamech Industries",
      "language": "en",
      "published_at": "2024-03-01T09:00:00.000Z",
      "modified_at": null,
      "retrieved_at": "2026-09-20T21:16:07.412Z",
      "word_count": 63,
      "content_hash_sha256": "3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b",
      "evidence": [
        {
          "excerpt": "Rotamech Industries is a manufacturer of centrifugal pumps.",
          "context": "h2:Products > p[1]",
          "relevance": "direct"
        }
      ],
      "structured_data": { "json_ld": [], "open_graph": {} },
      "warnings": [],
      "from_cache": false,
      "redirect_chain": []
    }
  ],
  "limitations": [
    "Assessment is derived from deterministic lexical matching, not semantic reasoning. A configured reasoning provider may refine it, but never replaces source evidence."
  ],
  "processing_ms": 412
}
```

Every field is documented in [`docs/api.md`](./docs/api.md#42-response-schema-exact).

---

## 2. Why an agent would use it

Because an agent that cites sources is more useful than one that asserts them.

- **Grounding.** Instead of generating a plausible sentence, the agent can attach
  a real URL, a retrieval timestamp, a content hash, and the passage the claim
  rests on.
- **Verification.** An agent can check what a specific page actually says, rather
  than trusting a summary.
- **Comparison.** Multiple sources are compared, and disagreement is reported as
  `mixed` instead of being averaged away.
- **Honesty by construction.** When nothing matches closely enough, the answer is
  `inconclusive`. The service never invents a fact, never pretends a source says
  something it does not, and never emits a confidence score.
- **No onboarding.** No signup, no key, no plan. Discover the tool, call it, pay
  per request, get evidence.

---

## 3. Example use case

An agent has been asked: *"Is Rotamech Industries actually a manufacturer of
centrifugal pumps, or just a reseller?"*

Its own model knowledge is stale and unverifiable, so it gathers candidate URLs,
then calls this service:

```json
{
  "question": "Is Rotamech Industries a manufacturer of centrifugal pumps?",
  "urls": [
    "https://example.invalid/products",
    "https://example.invalid/about",
    "https://example.invalid/registry-record"
  ],
  "max_sources": 5,
  "language": "auto",
  "mode": "evidence"
}
```

The company site supports the claim; the registry page negates it. The service
returns:

```json
{
  "assessment": {
    "status": "mixed",
    "basis": "Sources disagreed: 2 leaning to support (example.invalid) and 1 leaning against (example.invalid)."
  }
}
```

with short cited excerpts from each side, their retrieval timestamps, and their
content hashes.

The agent now has something it did not have before: **a defensible answer that
names both sides and shows where each came from**, plus honest limitations. It can
tell the human "the company claims this; a registry record disputes it; here are
both sources", instead of picking one and sounding confident.

---

## 4. MCP usage

Transport: **streamable HTTP**. Endpoint: `/mcp` on the same host as the API.

```text
${MCP_PUBLIC_URL}          e.g. https://${PUBLIC_API_DOMAIN}/mcp
```

### Tools

| Tool | Payment | Purpose |
|---|---|---|
| `research_evidence` | **paid (x402)** | Fetch public sources and return structured, cited evidence. |
| `health` | free | Status check. |

### Example client configuration

```json
{
  "mcpServers": {
    "agent-evidence-api": {
      "type": "http",
      "url": "${MCP_PUBLIC_URL}",
      "headers": {
        "Accept": "application/json, text/event-stream"
      }
    }
  }
}
```

There is nothing to put in `headers` for authentication. There is no key.

### `initialize` and `tools/list` are free

This matters for autonomous agents, and it is deliberate:

| JSON-RPC method | Paid? |
|---|---|
| `initialize` | **free** |
| `tools/list` | **free** |
| `tools/call` → `health` | **free** |
| `tools/call` → `research_evidence` | **paid** |
| everything else | free |

An agent must be able to **discover** the tools before it can decide to pay for
one. Only an actual invocation of the paid tool requires payment. A JSON-RPC
batch is charged if *any* element is a paid call.

### Example tool call

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "research_evidence",
    "arguments": {
      "question": "Is Rotamech Industries a manufacturer of centrifugal pumps?",
      "urls": ["https://example.invalid/products"],
      "max_sources": 5,
      "language": "auto",
      "mode": "evidence"
    }
  }
}
```

Tool input schema (identical to the HTTP request body):

| Field | Type | Required | Notes |
|---|---|---|---|
| `question` | `string` | **yes** | 1–2000 characters. |
| `urls` | `string[]` | no | At most 25 in the schema, 5 by default at runtime. |
| `max_sources` | `integer` | no | Positive, ≤ 25. |
| `language` | `string` | no | `"auto"` or a BCP-47 tag. |
| `mode` | `"evidence"` | no | The only value in v0.1.0. |

Full details, including what a payment-required response looks like to an MCP
client: [`docs/mcp.md`](./docs/mcp.md).

---

## 5. HTTP usage

```text
GET  /health       free   liveness
GET  /             free   capabilities
POST /v1/evidence  paid   the evidence resource
```

### `GET /health`

```bash
curl -s https://${PUBLIC_API_DOMAIN}/health
```

```json
{ "status": "ok", "service": "agent-evidence-api", "version": "0.1.0" }
```

### `GET /`

A free capability description, useful for discovery before paying.

```bash
curl -s https://${PUBLIC_API_DOMAIN}/
```

```json
{
  "service": "agent-evidence-api",
  "version": "0.1.0",
  "description": "Evidence infrastructure for AI agents. Returns structured, cited, freshly-retrieved evidence from public web pages so an agent can verify claims and ground answers in sources.",
  "endpoints": {
    "health": "GET /health (free)",
    "evidence": "POST /v1/evidence (paid, x402)",
    "mcp": "POST /mcp (MCP streamable HTTP; initialize and tools/list are free)"
  },
  "mcp": { "transport": "streamable-http", "tools": { "research_evidence": "paid", "health": "free" } },
  "payment": {
    "protocol": "x402",
    "scheme": "exact",
    "network": "eip155:84532",
    "asset": "USDC",
    "price_usd": "0.03",
    "recipient": "0x…",
    "facilitator": "https://x402.org/facilitator"
  }
}
```

### `POST /v1/evidence`

```http
POST /v1/evidence HTTP/1.1
Host: ${PUBLIC_API_DOMAIN}
Content-Type: application/json
payment-signature: <x402 payment proof>

{
  "question": "Is Rotamech Industries a manufacturer of centrifugal pumps?",
  "urls": ["https://example.invalid/products", "https://example.invalid/about"],
  "max_sources": 5,
  "language": "auto",
  "mode": "evidence"
}
```

Returns the `EvidenceResponse` document shown in §1.

Without valid payment you get HTTP `402` with a `PAYMENT_REQUIRED` error envelope
and the x402 payment requirements:

```json
{
  "error": {
    "code": "PAYMENT_REQUIRED",
    "message": "Payment is required to access this resource.",
    "request_id": "req_5c4b3a291807f6e5d4c3b2a1"
  }
}
```

### Errors

Every failure uses one envelope. Codes are stable — switch on `error.code`.

```json
{
  "error": {
    "code": "INVALID_URL",
    "message": "The supplied URL is invalid or unsupported.",
    "request_id": "req_3f9c1a7b2e4d4a6f8b0c1d2e"
  }
}
```

| Code | HTTP |
|---|---|
| `INVALID_REQUEST` | 400 |
| `INVALID_URL` | 400 |
| `BLOCKED_URL` | 400 |
| `SSRF_ATTEMPT` | 400 |
| `PAYMENT_REQUIRED` / `PAYMENT_INVALID` / `PAYMENT_EXPIRED` | 402 |
| `UNAUTHORIZED` | 401 |
| `UNSUPPORTED_CONTENT` | 415 |
| `RATE_LIMIT` | 429 |
| `EXTRACTION_FAILURE` / `INTERNAL_ERROR` | 500 |
| `TIMEOUT` | 504 |
| `REDIRECT_LIMIT` / `RESPONSE_TOO_LARGE` / `UPSTREAM_HTTP_FAILURE` / `BACKEND_UNREACHABLE` | 502 |
| `NOT_CONFIGURED` | 503 |

Full table with meanings: [`docs/api.md` §5](./docs/api.md#5-error-codes).

### A source that fails does not fail the request

If one of five URLs is unreachable, you still get the other four. The failed
source appears with `status: null`, empty `evidence`, and a warning carrying the
reason:

```json
{
  "requested_url": "https://example.invalid/gone",
  "status": null,
  "evidence": [],
  "warnings": [
    { "code": "UPSTREAM_HTTP_FAILURE", "message": "The source returned an error status." }
  ]
}
```

and `limitations` gains: *"1 of 2 source(s) could not be retrieved; see per-source
warnings."*

---

## 6. The x402 payment flow

```text
Agent
  │  1. POST /v1/evidence   (or tools/call research_evidence)
  ▼
Worker ──▶ 402 Payment Required + payment requirements
  │
Agent
  │  2. pays USDC on Base / Base Sepolia to the recipient address
  │  3. retries the same request with  payment-signature: <proof>
  ▼
Worker ──▶ 4. verifies via the x402 facilitator
  │           invalid → 402 PAYMENT_INVALID
  │           expired → 402 PAYMENT_EXPIRED
  ▼
Backend ──▶ 5. runs the evidence pipeline
  ▼
Worker ──▶ 6. 200 + EvidenceResponse
```

- **No API keys. No user accounts.** By design (SPEC §11, §38). An agent should
  never have to sign up, request a key, or subscribe.
- **The recipient needs only a public address.** Receiving USDC requires no
  private key, because the service never signs anything — the paying client does.
- **Never commit a private key.** Not to `wrangler.jsonc`, not to `.env`, not
  anywhere. `X402_TEST_PRIVATE_KEY` is a disposable Base Sepolia key for local
  testing only, must never hold mainnet funds, and must never be committed.
- **Dev bypass is doubly guarded.** Locally, `DEV_BYPASS_PAYMENT=true` skips
  gating — but only when the network is *not* Base mainnet. On `eip155:8453`
  payment can never be bypassed, even if the flag leaks into production config.

Full detail: [`docs/x402.md`](./docs/x402.md).

---

## 7. Base and Base Sepolia

| Environment | Network | CAIP-2 identifier |
|---|---|---|
| Test | **Base Sepolia** | `eip155:84532` |
| Production | **Base** | `eip155:8453` |

The settlement token is **USDC** in both cases.

Testnet and production configuration are kept in separate Worker environments and
must never be mixed. The safe default in `packages/core/src/config.ts` is Base
Sepolia, so an unconfigured deployment is on testnet rather than accidentally on
mainnet.

`apps/worker/wrangler.jsonc` provides three environments:

| Environment | Activation | Network | Payment |
|---|---|---|---|
| production | `wrangler deploy` | `eip155:8453` (Base) | required |
| dev | `wrangler dev --env dev` | `eip155:84532` (Sepolia) | bypassed |
| test | `wrangler dev --env test` | `eip155:84532` (Sepolia) | required |

---

## 8. Pricing configuration

Pricing is environment-driven, never hard-coded.

| Variable | Default | Meaning |
|---|---|---|
| `X402_PRICE_USD` | `0.03` | Price per evidence request, in USD. |
| `X402_NETWORK` | `eip155:84532` | Settlement network. |
| `X402_RECIPIENT` | *(empty)* | **Public** receiving address. |
| `X402_FACILITATOR_URL` | `https://x402.org/facilitator` | Facilitator used for verification. |

The MVP default is approximately **$0.03 per evidence request**. That is a
starting point, not a fixed commercial price.

The price string is normalised before use: a leading `$` is optional, and the
value is rendered to two decimals. Note that an unparseable value does **not**
stop the Worker — it silently falls back to `$0.03`. Verify the value after any
change.

---

## 9. Local development

Requires **Node.js ≥ 22.6** (the cache uses the built-in `node:sqlite` module, so
there is no native dependency to compile) and `pnpm`.

```bash
pnpm install

cp .env.example .env               # placeholders only; fill in locally, never commit
openssl rand -hex 32               # → BACKEND_AUTH_SECRET

pnpm typecheck
pnpm test
```

| Script | Purpose |
|---|---|
| `pnpm typecheck` | Typecheck every workspace from source. |
| `pnpm test` | All `*.test.ts` files. |
| `pnpm test:security` | SSRF / URL validation suite. |
| `pnpm test:e2e` | End-to-end acceptance flow. |
| `pnpm fixtures` | Deterministic local fixture server. |
| `pnpm dev:backend` | Backend on `:8080`. |
| `pnpm dev:worker` | Worker on `:8787`. |
| `pnpm validate` | `typecheck && test`. |

The fixture server (`tests/fixtures/server.ts`) is offline and deterministic — no
dependency on live websites. It serves content pages, redirect chains,
redirect-to-private and redirect-to-metadata traps, a never-responding route, an
8 MiB streaming route, and 404/500 responses, so the SSRF and limit controls can
be exercised against a real socket.

```bash
pnpm fixtures
# [fixtures] listening on http://127.0.0.1:<port>
```

> **Both dev commands work, with one caveat.** `pnpm dev:backend` starts the
> Fastify backend on `:8080`; `pnpm dev:worker` starts the Worker. Pointing the
> Worker at the backend and calling `/v1/evidence` also requires the x402 leg to
> settle, or `DEV_BYPASS_PAYMENT=true` with a non-mainnet network. See
> [Implementation status](#implementation-status).

---

## 10. Deployment

```text
Cloudflare Worker (public edge)  →  protected origin  →  Docker container  →  Fastify backend  →  SQLite
```

1. **Backend on the VPS.** A Node.js + Fastify service built from `docker/` and
   run with `docker compose`, with `restart: unless-stopped` and a persistent
   volume mounted at `/app/data` for the SQLite cache.
2. **Cloudflare Worker.** `wrangler deploy` ships the production environment
   (Base mainnet).
3. **The shared secret.** `BACKEND_AUTH_SECRET` is deliberately absent from
   `wrangler.jsonc` so it can never be committed:

   ```bash
   wrangler secret put BACKEND_AUTH_SECRET
   ```

   It must match the backend's own `BACKEND_AUTH_SECRET`. Generate it with
   `openssl rand -hex 32`.
4. **Origin protection** — the preferred option is a **Cloudflare Tunnel**, so
   the backend has no public listener and no public DNS record. The alternative
   is an authenticated origin behind a firewall restricted to Cloudflare's
   egress ranges. In both cases the shared secret is validated on every internal
   request, because network restriction and request authentication are
   independent layers.

Use placeholders — `PUBLIC_API_DOMAIN`, `BACKEND_ORIGIN_URL`, `MCP_PUBLIC_URL`
— and never invent a real domain.

Full instructions, environment variable tables, health checks, and the manual
credential checklist: [`docs/deployment.md`](./docs/deployment.md).

> **Deployable in principle, not yet deployed or exercised end to end.** The
> Docker artifacts, the backend, and the Worker all exist. Nothing has been
> deployed from this repository, and two config defects must be fixed first (see
> [Implementation status](#implementation-status)). See
> [`docs/deployment.md`](./docs/deployment.md).

---

## 11. Security

The fetcher treats every URL as hostile input. Required defences (SPEC §18), all
enforced in the `@aee/fetcher` package:

- **Scheme allowlist** — `http` and `https` only; `file://` and everything else
  rejected.
- **Address rejection** — localhost and its aliases, loopback, RFC1918/private
  IPv4, link-local, multicast, unspecified, IPv6 loopback, IPv6 link-local,
  private IPv6 ranges, and cloud metadata endpoints (`169.254.169.254` and
  friends).
- **Encoded evasion** — decimal, octal, hexadecimal, short-form, and
  IPv4-mapped-IPv6 representations are range-checked after parsing, never matched
  as strings.
- **DNS** — resolve explicitly, validate every resolved address, and **revalidate
  at connect time** to close the DNS-rebinding window.
- **Redirects** — validate **every hop**, not just the first URL, and enforce
  `MAX_REDIRECTS`.
- **Ports** — allowlist only.
- **Bounds** — connect timeout, total request timeout, maximum response bytes
  enforced while streaming, decompression-bomb defence, concurrency limits.
- **No shell execution of URLs**, ever. No `child_process` in the fetch path.
- **Logs** — structured JSON with secret-key redaction. Never log payment or
  origin secrets, private keys, or wallet secrets.

Separately, **origin protection** ensures a caller cannot skip the Worker and
call the backend directly to avoid paying: a Cloudflare Tunnel (preferred) or a
firewalled origin, plus server-to-server authentication on every internal
request. `BACKEND_AUTH_SECRET` has no default precisely so a misconfigured
backend fails closed instead of running unauthenticated.

And the access rules from SPEC §19: no bypassing access controls, no defeating
bot protections, no login automation, no paywall circumvention, no CAPTCHA
solving. A clearly identifiable `User-Agent` is used, `robots.txt` behaviour is
configurable via `ROBOTS_POLICY`, and only publicly accessible resources are in
scope. Submit only URLs you are permitted to access.

> **These controls are implemented in `packages/fetcher` and unit-tested in
> `tests/security/`**, which passes locally (92 security cases). No independent
> audit has been performed. `ROBOTS_POLICY` is enforced. See
> [`docs/security.md`](./docs/security.md) for the per-control status table, what
> is enforced where, and the honest list of gaps.

---

## 12. Limitations

Stated plainly, because you should know these before you rely on the output.

| Limitation | Detail |
|---|---|
| **Deterministic lexical matching only** | The assessment comes from term matching plus a fixed negation-cue list. There is no semantic understanding. A paraphrased contradiction that shares no vocabulary will not be detected; a negated passage that shares many terms will be. |
| **No semantic reasoning unless a provider is configured** | The `ReasoningProvider` extension point in SPEC §37 exists in the design and is **not implemented**. Even when it is, it may decompose, rank, compare, and synthesise — but it must never replace source evidence with unsupported prose. |
| **Only agent-supplied URLs in v0.1.0** | You must supply the URLs. There is no search provider, so the service cannot discover sources for you. `urls` is required in practice. |
| **Excerpts are short by design** | Default `MAX_EXCERPT_CHARS` is 600 (schema cap 4000). This is a cited-evidence service, not a content-dump service, and it does not reproduce whole documents. |
| **`inconclusive` is common and correct** | If the question shares no significant terms with the retrieved text, the honest answer is `inconclusive`. That is the service working, not failing. |
| **Tokens shorter than 3 characters are ignored** | They are dropped from question terms, so very short or acronym-only questions may match poorly. |
| **Stemming is crude** | One trailing `ing`/`ed`/`es`/`s` is stripped. No stemming library, no irregular forms. |
| **Stopwords are a fixed English list** | Non-English questions lose little (the list is English-specific and mostly inert elsewhere), but ranking quality for non-English questions is not tuned. |
| **No PDF, image, or JavaScript-rendered evidence** | `DocumentProvider` and `BrowserProvider` are future extension points and are **not implemented**. Static HTML only. |
| **No source-change detection or trust scoring** | `SourceTrustProvider` is not implemented; the service reports what a page says, not how much to trust the publisher. |
| **Cache hits are flagged, not hidden** | `from_cache: true` plus a `SERVED_FROM_CACHE` warning, and `retrieved_at` is always the real retrieval time. Evidence up to `CACHE_TTL_SECONDS` (default 24 h) old may be served. |
| **One bad source does not fail the request** | Failures are reported per source in `warnings`, and a failure count is added to `limitations`. Read those arrays. |
| **Rate limiting is per-backend-process** | A token bucket keyed on `CF-Connecting-IP` enforces `RATE_LIMIT` (429) with a bounded bucket map. It is in-process, so multiple backend replicas each hold their own budget; edge-level limiting would need Durable Objects. |
| **Non-HTML content is not processed** | An unsupported content type yields a source with a `null` body and an `UNSUPPORTED_CONTENT_TYPE` warning rather than an error. HTML, plain text, XML, and JSON are the processed types. |
| **Robots matching is prefix/wildcard, not full RFC 9309** | `ROBOTS_POLICY=ignore\|warn\|enforce` is enforced, with a bounded per-origin cache. Ambiguous rules resolve to *allow* and are warned about rather than silently refused. A clearly identifiable `User-Agent` is sent on every request. |
| **No on-chain payment has been demonstrated** | The x402 gate is implemented; a funded Base Sepolia or mainnet settlement has not been executed against a deployment. |
| **No independent security review** | The SSRF controls are implemented and unit-tested in source; they have not been audited adversarially. |

### And, right now

**Implemented and typechecking:** all six packages (`schemas`, `core`, `fetcher`,
`extraction`, `cache`, `mcp`), both apps (`backend`, `worker`), the Docker
artifacts, and `server.json`. `pnpm typecheck` passes across the workspace, and
six test suites cover roughly 147 cases, including an end-to-end flow test that
drives the real backend over HTTP against the fixture server.

**Still open:**

| Gap | Detail |
|---|---|
| Literal test wallet addresses | `apps/worker/wrangler.jsonc` has the same literal recipient address in both `env.dev` and `env.test`. Replace with placeholders before deploying. |
| Robots matching is simplified | `ROBOTS_POLICY` is enforced; matching is prefix/wildcard rather than full RFC 9309, and ambiguity resolves to allow. |
| No on-chain payment verification | The x402 gate is implemented and reviewed; no funded Base Sepolia or mainnet settlement has been executed. |
| No automated x402 payment test | SPEC §26 asks for a `402` test and a valid-testnet-payment test. Neither exists. |
| Rate limiting is in-process | Enforced per backend replica, not globally at the edge. |
| `server.json` remote URL is a placeholder | The namespace is confirmed (`io.github.Thx93/`), but `remotes[].url` must be replaced, and `repository.url` references a repo that does not exist yet. |
| No independent security review | The SSRF controls are implemented and unit-tested in source; nobody has audited them adversarially. |

**Verified locally:** `pnpm typecheck` exits 0, `pnpm test` reports 199 passing
tests, and both `scripts/smoke.sh` and `scripts/worker-smoke.sh` pass against
live sockets. Re-run them and report the actual output rather than assuming a
pass — these results are from a single machine.

---

## 13. Registry publication

SPEC §28 requires the project to be **registry-ready, not auto-published**. That
means:

- a `server.json` metadata file using the current official schema,
- validation of that file,
- documented exact publish steps,
- a namespace ownership and authentication checklist,
- publication by hand with the official `mcp-publisher` workflow, and only when
  credentials and authorization are explicitly available.

[`server.json`](./server.json) now exists and declares this as a **remote**
streamable-HTTP server (no `packages` entry, because there is no npm package to
install). Two things remain before it is publishable:

- `remotes[].url` is still `https://mcp.example.invalid/mcp`; replace it with your
  real `MCP_PUBLIC_URL`.
- the `name` and `repository.url` assert a GitHub namespace — confirm they are
  genuinely yours, because namespace ownership is validated and a fabricated
  handle fails.

Nothing has been published. The exact publish procedure, validation steps, and
namespace checklist are in
[`docs/registry-publication.md`](./docs/registry-publication.md).

The discovery strategy — the MCP Registry, the GitHub repository, npm metadata
where appropriate, machine-readable metadata, documentation, and agent-oriented
tool descriptions — is in [`docs/discovery.md`](./docs/discovery.md). It also
lists the truthful descriptive phrases worth using (*web evidence*, *source
verification*, *claim verification*, *evidence extraction*, *source-grounded
research*, *compare sources*, *cited evidence*, *fresh web evidence*), and states
plainly that descriptions must be truthful and must not be keyword-stuffed.

**Do not publish until the service actually works.** A registry entry listing a
tool that cannot be called is worse than no entry. Two concrete blockers remain:
the placeholder `remotes[].url` must be replaced with a live endpoint, and the
`name`/`repository.url` namespace must be confirmed as genuinely yours.

---

## Project layout

```text
agent-evidence-api/
├── AGENTS.md            # sole project rules file
├── SPEC.md              # product specification (authority on requirements)
├── README.md
├── server.json          # MCP Registry metadata (remote streamable-HTTP server)
├── .env.example         # environment template, placeholders only
├── pnpm-workspace.yaml
├── package.json
├── docs/
│   ├── architecture.md          # architecture, pipeline, layering rule
│   ├── api.md                   # HTTP endpoints, exact schemas, error codes, limits
│   ├── mcp.md                   # MCP transport, tools, free vs paid, client config
│   ├── x402.md                  # payment flow and configuration
│   ├── security.md              # SSRF controls, origin protection, secrets
│   ├── deployment.md            # local, Docker, Worker, origin protection
│   ├── discovery.md             # agent discoverability strategy
│   └── registry-publication.md  # exact MCP Registry publish steps
├── apps/
│   ├── backend/         # Fastify service — the VPS workload
│   │   └── src/         # app.ts, auth.ts, server.ts
│   └── worker/          # Cloudflare Worker — the public edge
│       ├── src/index.ts
│       ├── wrangler.jsonc
│       └── .dev.vars.example
├── packages/
│   ├── schemas/         # zod schemas + types (the shared wire contract)
│   ├── core/            # EvidenceService, config, logger, assessment
│   ├── fetcher/         # SSRF-hardened HTTP fetching (ip.ts, fetch.ts)
│   ├── extraction/      # HTML parsing, metadata, main content, lexical ranking
│   ├── cache/           # SQLite-backed bounded cache (node:sqlite)
│   └── mcp/             # MCP server + tool definitions (streamable HTTP)
├── tests/
│   ├── fixtures/        # deterministic local fixture server
│   ├── security/        # ssrf.test.ts, limits.test.ts
│   └── e2e/             # evidence-flow.test.ts (cross-package)
├── scripts/
│   ├── run-tests.mjs    # test runner (node --test + tsx)
│   └── smoke.sh         # live socket smoke test against the built backend
├── .dockerignore
└── docker/
    ├── Dockerfile
    ├── docker-compose.yml
    ├── env.production.example    # Base mainnet
    └── env.development.example   # Base Sepolia
```

Both the HTTP adapter and the MCP adapter call the **same** `EvidenceService` —
there is no duplicated business logic between them (SPEC §39):

```text
HTTP adapter ─────┐
                  ├──> EvidenceService ──> Fetch / Extract / Cache
MCP adapter ──────┘
```

x402 sits at the payment boundary in the Worker, never inside the core engine.

---

## Implementation status

Snapshot taken while writing the documentation.

**Implemented**

- `packages/schemas` — the complete wire contract (requests, responses, sources,
  evidence items, warnings, errors, limits) with built output.
- `packages/fetcher` — SSRF-hardened retrieval: scheme allowlist, IPv4/IPv6 range
  classification (including decimal/octal/hex/`127.1` forms and IPv4-mapped IPv6),
  hostname rules, port allowlist, resolved-IP validation across all DNS records,
  per-hop redirect validation, connect-time revalidation against DNS rebinding,
  connect and total timeouts, streaming byte cap, and manual decompression.
- `packages/extraction` — HTML parsing, metadata, main-content extraction,
  normalisation, content hashing, deterministic lexical ranking, negation cues.
- `packages/cache` — key normalisation, `CacheProvider`, bounded SQLite adapter.
- `packages/core` — configuration, structured logger with secret redaction,
  cross-source assessment, `EvidenceService`, typed `ServiceError`.
- `packages/mcp` — the remote MCP adapter: streamable HTTP in **stateless** mode
  (`sessionIdGenerator: undefined`, `enableJsonResponse: true`), a fresh
  `Server` + transport pair per HTTP request, `tools/list`, and `tools/call`
  delegating to the same `EvidenceService` the HTTP layer uses. Tool input
  schemas are generated from zod via `z.toJSONSchema`.
- `apps/backend` — Fastify service: fail-closed startup on a missing secret,
  constant-time shared-secret verification on everything except `/health`,
  `GET /health`, `POST /internal/v1/evidence`, and POST/GET/DELETE on `/mcp`.
- `apps/worker` — the full edge: x402 gating, free `/health` and `/`,
  `POST /v1/evidence` forwarding, MCP body inspection and forwarding, guarded dev
  bypass, canonical error envelope.
- `docker/` — multi-stage `Dockerfile`, `docker-compose.yml`, separate
  mainnet/testnet env templates, plus a root `.dockerignore`.
- `server.json`, `apps/worker/.dev.vars.example`, `scripts/smoke.sh`.

**Verified in this environment**

- `pnpm typecheck` — **passes** across the whole workspace (`tsc --noEmit`, exit 0).
- Six test suites exist totalling ~147 cases: `tests/security/ssrf.test.ts` (30),
  `tests/security/limits.test.ts` (16), `tests/e2e/evidence-flow.test.ts` (18),
  `packages/mcp/src/mcp.test.ts` (15), `packages/extraction/src/extraction.test.ts`
  (46), `packages/cache/src/cache.test.ts` (22).

**Verified locally, not independently reproduced**

- `pnpm typecheck` → exit 0; `pnpm test` → 199 passing; `scripts/smoke.sh` and
  `scripts/worker-smoke.sh` → all checks passed. No third party has reproduced
  these results.
- No on-chain x402 payment has been demonstrated (the 402 gate is verified; the
  settlement path needs a funded testnet wallet).

**Open defects**

| Defect | Detail |
|---|---|
| Literal test wallet addresses | `apps/worker/wrangler.jsonc` contains the same literal recipient address in both `env.dev` and `env.test`. SPEC §33 and AGENTS.md §6 forbid committing wallet configuration. |
| Robots matching is simplified | `ROBOTS_POLICY` is enforced in `EvidenceService`; matching is prefix/wildcard, not full RFC 9309. |
| — (fixed) | `UNSUPPORTED_CONTENT` (415) is now emitted per source. |
| No on-chain settlement test | The `402` gate and the free/paid MCP split are covered by `scripts/worker-smoke.sh`; rate limiting is unit- and integration-tested. Actual USDC settlement needs a funded Base Sepolia wallet, which is an external credential. |
| `server.json` not yet publishable | The namespace is confirmed, but `remotes[].url` is a placeholder and the referenced repository does not exist. |
| Port allowlist includes 8080/8443 | Convenient for tooling, but also common internal-interface ports. Narrow if unneeded. |

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/architecture.md`](./docs/architecture.md) | Component map, request pipeline, edge/backend split, auth boundary, layering rule, package ownership, extension points. |
| [`docs/api.md`](./docs/api.md) | `GET /health`, `GET /`, `POST /v1/evidence`; exact request and response schemas; assessment statuses; worked examples; every error code; resource limits and their environment variables. |
| [`docs/mcp.md`](./docs/mcp.md) | Streamable HTTP transport, `/mcp`, both tools, exact input schema, free vs paid discovery, client config, example call, payment-required response. |
| [`docs/x402.md`](./docs/x402.md) | The 402 → pay → retry → verify → execute sequence, configuration variables, CAIP-2 network ids, USDC settlement, test/production separation, the dev bypass, and the private-key rules. |
| [`docs/security.md`](./docs/security.md) | The SSRF control set required by SPEC §18, origin protection, the shared-secret scheme, secret handling, robots/access behaviour, and what is enforced where. |
| [`docs/deployment.md`](./docs/deployment.md) | Local development, Docker on the VPS, the Cloudflare Worker, `wrangler secret put BACKEND_AUTH_SECRET`, health checks, restart policy, the SQLite volume, and origin-protection options. |
| [`docs/discovery.md`](./docs/discovery.md) | Registry, repository, npm, machine-readable metadata, documentation, and agent-oriented tool descriptions. |
| [`docs/registry-publication.md`](./docs/registry-publication.md) | The exact MCP Registry publish steps, validation, and the namespace ownership checklist. |

---

## Contributing rules

[`AGENTS.md`](./AGENTS.md) is the **only** project rule book. It defines the hard
constraints, the security rules, the coding standards, the testing bar, and the
definition of done. Do not create `CLAUDE.md`, `.cursorrules`, `GEMINI.md`, or any
competing instruction file.

Product requirements live in [`SPEC.md`](./SPEC.md). Where this README and the
spec disagree, the spec is authoritative — and any contradiction between the
source code and the spec should be reported rather than silently resolved.

## License

MIT. See `package.json`.
