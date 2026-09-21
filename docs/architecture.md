# Architecture

Agent Evidence API is evidence infrastructure for AI agents. An agent submits a
question or claim plus the public URLs it wants checked; the service fetches
those sources, extracts and normalises their content, records provenance, and
returns a structured evidence package the agent can cite.

This document describes the system as designed in [`SPEC.md`](../SPEC.md) and
[`AGENTS.md`](../AGENTS.md), and — where it matters — distinguishes that design
from what is already implemented in the repository. See
[Implementation status](#implementation-status) for the honest snapshot.

---

## 1. Component map

```text
        ┌──────────────┐
        │  MCP client  │
        └──────┬───────┘
               │  streamable HTTP  (POST/GET/DELETE /mcp)
┌──────────────▼───────────────┐        ┌───────────────┐
│  Cloudflare Worker (edge)    │◀───────│  HTTP client  │
│  · x402 payment gating       │        └───────────────┘
│  · shallow request shape check│
│  · MCP JSON-RPC endpoint     │
│  · free /health and /        │
└──────────────┬───────────────┘
               │  x-backend-auth: <shared secret>  (server-to-server)
               │  x-request-id, payment-signature
┌──────────────▼───────────────┐
│  Backend VPS (Fastify + TS)  │
│  POST /internal/v1/evidence  │
│  ANY  /mcp                   │
│      │                       │
│      └─▶ EvidenceService ─┬─▶ @aee/fetcher     (SSRF-hardened fetch)
│                           ├─▶ @aee/extraction (parse, normalise, rank)
│                           └─▶ @aee/cache       (bounded SQLite)
└──────────────────────────────┘
```

Two processes, one code path:

- **Cloudflare Worker** (`apps/worker`) — the only public surface. Thin by
  design because it targets the Workers **Free** plan: no HTML parsing, no
  browser, no reasoning, no database.
- **Backend** (`apps/backend`) — the VPS workload. Owns every expensive and
  security-sensitive operation.

The shared wire contract lives in `packages/schemas` and is imported by both, so
the Worker and the backend cannot drift apart silently.

---

## 2. The request pipeline (SPEC §6)

SPEC §6 defines the pipeline the evidence engine must expose. Each stage has a
single owner:

| # | Pipeline stage | Owner | Status |
|---|---|---|---|
| 1 | request | `apps/worker` (edge) → `apps/backend` | Implemented |
| 2 | validation | `packages/schemas` (zod) + `EvidenceService.execute` | Implemented |
| 3 | source acquisition | `@aee/fetcher` (`validateUrl`, `fetchSource`) | Implemented |
| 4 | redirect validation | `@aee/fetcher` (`fetchSource` hop loop) | Implemented |
| 5 | HTTP fetch | `@aee/fetcher` (`requestOnce`) | Implemented |
| 6 | content-type detection | `@aee/fetcher` (`isSupportedContentType`) | Implemented |
| 7 | HTML parsing | `@aee/extraction` (`extractDocument`) | Implemented |
| 8 | metadata extraction | `@aee/extraction` (`extractDocument`) | Implemented |
| 9 | main-content extraction | `@aee/extraction` (`selectContainer`) | Implemented |
| 10 | normalisation | `@aee/extraction` (`text.ts`) | Implemented |
| 11 | evidence candidate extraction | `@aee/extraction` (`findEvidenceCandidates`) | Implemented |
| 12 | cross-source comparison | `packages/core` (`assessment.ts`) | Implemented |
| 13 | structured response | `packages/core` (`EvidenceService`) | Implemented |

Stage 12 is lexical, not semantic: `assess()` matches question terms and looks for
a fixed list of negation cues. There is no model anywhere in the pipeline.

Note the boundary at stages 3–6: `EvidenceService` calls a single injected
function, `fetchSource(...)`, and consumes a `FetchResult`. Everything that
touches the network and everything that must validate a destination address
lives behind that boundary. The service itself never constructs a `fetch` call,
never resolves DNS, and never follows a redirect. This is what makes the SSRF
surface a single, auditable package.

Stages 7–11 are pure functions with no network, filesystem, or clock access,
which is why they can be tested deterministically against fixtures.

### Ordering guarantees inside the service

`EvidenceService.execute()` (in `packages/core/src/service.ts`) runs the
following, in order:

1. `EvidenceRequestSchema.safeParse(input)` — schema validation.
2. URL normalisation and de-duplication, preserving input order. Unparseable
   entries are **kept**, not dropped, so the fetcher can return a precise
   `INVALID_URL` instead of the caller seeing a silently missing source.
3. Policy checks that are not shape checks: at least one URL must be present,
   and the count must not exceed `MAX_URLS_PER_REQUEST`.
4. `max_sources` is clamped to
   `min(max_sources ?? urls.length, urls.length, MAX_URLS_PER_REQUEST, 25)`.
5. Sources are processed with `Promise.all` over a counting semaphore bounded by
   `MAX_CONCURRENT_FETCHES`.
6. Per-source failures are isolated: a source that cannot be retrieved is still
   returned as a `Source` record with `status: null` and a warning, rather than
   failing the whole request. This preserves provenance and stops one bad URL
   from discarding the good sources.
7. Cross-source assessment (`assess`) runs over the retrieved candidates.
8. `limitations` is assembled, including one entry per failure count and one
   when any source was served from cache.

---

## 3. Edge / backend split

The split is not a packaging convenience; it is dictated by the platform:

| Concern | Worker (edge) | Backend (VPS) |
|---|---|---|
| Runtime | Cloudflare Workers, Free plan | Node.js ≥ 22.6, Linux |
| HTTP framework | Hono | Fastify |
| Payment gating (x402) | **yes** | no |
| Public routing | **yes** | no |
| Request shape check | shallow only | authoritative (zod) |
| SSRF defence | no | **yes** (`@aee/fetcher`) |
| Fetching / parsing / extraction | no | **yes** |
| Cache (SQLite) | no | **yes** |
| Reasoning providers | no | **yes** (future) |
| Budget | minimal CPU, no Durable Objects, no Paid-only features | bounded by `MAX_CONCURRENT_FETCHES` |

Two rules follow from this table and are worth stating explicitly:

- **The Worker must not grow business logic.** Its `basicRequestProblem()` check
  exists only to reject obvious junk before spending an x402 verification
  round-trip against the facilitator. Its own source comment says it "must not
  diverge into business logic" — the authoritative validation is the zod schema
  in `@aee/schemas`, applied by the backend.
- **The backend must not be reachable anonymously.** See the next section.

---

## 4. Worker → backend authentication boundary

The backend exposes internal endpoints:

```text
POST /internal/v1/evidence
ANY  /mcp
```

The Worker forwards to these paths and attaches a server-to-server credential:

```http
x-backend-auth: <BACKEND_AUTH_SECRET>
x-request-id: req_<24 hex chars>
accept: application/json
payment-signature: <forwarded, when present>
```

Properties of this scheme as implemented in `apps/worker/src/index.ts`:

- The secret is read from the Worker's `env` binding, attached **only** to the
  outgoing request, and never returned to a client, never echoed in a response
  body, and never written to a log.
- If either `BACKEND_ORIGIN_URL` or `BACKEND_AUTH_SECRET` is missing, the Worker
  logs a message that names the missing variable (but not its value) and returns
  `NOT_CONFIGURED` (HTTP 503). It does not fall through to an unauthenticated
  request.
- `payment-signature` is forwarded so the backend can record settlement if it
  needs to. It is a payment proof, not an account credential.
- The Worker's own timeout on the backend call is 30 s
  (`AbortSignal.timeout(30_000)`); a failure or timeout becomes
  `BACKEND_UNREACHABLE` (HTTP 502).
- Upstream response headers are allow-listed rather than copied wholesale:
  `content-type`, `cache-control: no-store`, `x-request-id`, `payment-response`,
  `mcp-session-id`.

On the backend side, the shared secret is validated on every internal request.
`BACKEND_AUTH_SECRET` is deliberately **not** defaulted in
`packages/core/src/config.ts`: an empty value is what makes the backend fail
closed rather than start unauthenticated. `MIN_SECRET_LENGTH` is 16 and
`isSecretUsable()` gates startup.

SPEC §14 permits either a shared secret or HMAC request signing. The chosen and
implemented mechanism is the shared secret. HMAC signing remains an available
upgrade behind the same boundary; nothing above the boundary changes if it is
adopted.

This is **not** a customer-facing API key. SPEC §11 forbids API keys for paid
access and SPEC §38 forbids accounts. The secret authenticates the *edge*, not
the *caller*; the caller is authenticated by paying.

---

## 5. Why x402 sits at the payment boundary, not in the engine

SPEC §39 states it directly: *"x402 belongs at the payment boundary, not inside
the core evidence engine."* The implementation follows that.

The payment gate is a Hono middleware constructed in `apps/worker/src/index.ts`
from the official `@x402/hono` middleware, an `x402ResourceServer` bound to
`@x402/evm`'s `ExactEvmScheme`, and an `HTTPFacilitatorClient`. It is applied to
two route keys only:

- `POST /v1/evidence`
- `POST /mcp`, and only when the JSON-RPC body contains a paid call

Reasons this boundary is the right one:

1. **`EvidenceService` stays pure and payable-agnostic.** It takes a validated
   request and returns an evidence response. It has no `payment` parameter, no
   payment imports, and no knowledge that money exists. That is why the MCP
   adapter and the HTTP adapter can share it exactly (next section).
2. **The engine stays testable without a chain.** Unit and integration tests
   inject a fetch implementation and call `execute()` directly.
3. **Payment cannot corrupt evidence.** A verification bug can deny a request or
   accidentally allow one; it cannot alter an assessment, an excerpt, or a
   content hash, because it never runs inside that code path.
4. **The gate is memoised, not replicated.** The middleware is rebuilt only when
   `recipient|network|price|facilitator` changes, because rebuilding it per
   request would re-sync with the facilitator every time.

The `PaymentProvider` name in SPEC §37 is a *future* abstraction for swapping
payment rails. No such interface exists in code today; the Worker calls the
official x402 packages directly. See [Extension points](#7-extension-points-spec-37).

---

## 6. The layering rule (SPEC §39)

```text
HTTP adapter ─────┐
                  ├──> EvidenceService ──> Fetch / Extract / Cache
MCP adapter ──────┘
```

Both adapters must call the same core application service. Business logic must
never be duplicated between them. Concretely:

- The **HTTP adapter** is `apps/backend`'s `POST /internal/v1/evidence` handler.
  It parses and validates the body, calls `EvidenceService.execute(body,
  requestId)`, and serialises the `EvidenceResponse`. Typed `ServiceError`s map
  to the canonical error envelope via `ERROR_HTTP_STATUS`.
- The **MCP adapter** is `packages/mcp`. Its `research_evidence` tool handler
  takes the tool arguments, calls the *same* `EvidenceService.execute()`, and
  returns the result as MCP tool content.
- Neither adapter re-implements URL validation, de-duplication, concurrency
  bounding, cache lookup, extraction, or assessment.
- The public route `POST /v1/evidence` is owned by the Worker, which adds
  payment gating and forwards to the backend's internal route. The Worker also
  does not duplicate business logic.

`packages/core/src/index.ts` says the same thing in its header comment and is
worth treating as the authoritative statement.

---

## 7. Package layout and ownership

```text
agent-evidence-api/
├── AGENTS.md            sole rules file
├── SPEC.md              product specification (authority on requirements)
├── README.md
├── .env.example         environment template, placeholders only
├── pnpm-workspace.yaml
├── docs/                this document and its siblings
├── apps/
│   ├── backend/         Fastify service — the VPS workload
│   └── worker/          Cloudflare Worker — the public edge
├── packages/
│   ├── schemas/         zod schemas + inferred types (the shared contract)
│   ├── core/            EvidenceService and domain logic
│   ├── fetcher/         SSRF-hardened HTTP fetching
│   ├── extraction/      HTML parsing, metadata, main content, normalisation, lexical ranking
│   ├── cache/           SQLite-backed bounded cache
│   └── mcp/             MCP server + tool definitions
├── tests/               cross-package integration + e2e (incl. fixtures/)
└── docker/              Dockerfile, compose, env templates
```

Ownership, and a one-line statement of what each package is *not* allowed to do:

| Package | Owns | Must not |
|---|---|---|
| `@aee/schemas` | The wire contract: `EvidenceRequest`, `EvidenceResponse`, `Source`, `EvidenceItem`, `SourceWarning`, `StructuredData`, `Assessment`, `HealthResponse`, `ResourceLimits`, error codes and their HTTP statuses, `HARD_CAPS`, `DEFAULT_LIMITS`. | Import any other workspace package, or perform I/O. |
| `@aee/core` | `EvidenceService`, `AppConfig`/`loadConfig`, `createLogger`, cross-source `assess`, `ServiceError`. Orchestration and policy. | Fetch, parse, or know about x402/HTTP/MCP. |
| `@aee/fetcher` | Scheme allow-listing, address validation, DNS checks, per-hop redirect validation, connect-time revalidation, timeouts, byte caps, decompression limits, and the `FetchError` codes the engine already switches on. | Parse HTML or make evidence judgements. |
| `@aee/extraction` | HTML → `ExtractedDocument` (title, description, canonical, Open Graph, JSON-LD, language, dates, headings, main text, word count, content hash, links, publisher) and deterministic lexical `findEvidenceCandidates` / `hasNegationCue`. | Perform network or filesystem I/O, or make semantic claims. |
| `@aee/cache` | The `CacheProvider` interface, SQLite adapter via Node's built-in `node:sqlite`, `cacheKey` normalisation, TTL expiry, bounded eviction. | Store whole raw pages, or let stale rows appear fresh. |
| `@aee/mcp` | MCP server construction, `research_evidence` and `health` tool definitions, JSON-RPC handling. | Contain business logic; it delegates to `@aee/core`. |
| `@aee/backend` | Fastify server, internal routes, shared-secret verification, error-envelope mapping, health, wiring config + cache + logger + `EvidenceService`. | Be publicly routable without the shared secret. |
| `@aee/worker` | x402 gating, shallow shape check, MCP JSON-RPC paid-call detection, backend forwarding, free `/health` and `/` capabilities. | Fetch or parse evidence, or hold state. |

Cross-package imports use the `@aee/*` package names, never relative paths that
escape a package root. The root `tsconfig.json` maps those names to sources so
`pnpm typecheck` can check the whole tree without a build; `tsconfig.base.json`
deliberately has no `paths` so package builds resolve siblings through their
built `dist/` output.

### Cache design notes

The cache is one `entries` table in SQLite with a `STRICT` schema. Three
decisions are worth knowing when reading the code:

- **`node:sqlite`, not a native module.** Zero native dependencies to compile or
  audit, and no install-step supply-chain surface. The driver is synchronous;
  the `CacheProvider` interface is asynchronous by contract so a network-backed
  store can replace it later without a signature change.
- **Expired rows are invisible.** `get` filters on `expiresAt > now`, and
  `cleanup` deletes expired rows. Stale evidence can never be served as fresh.
- **Only the extracted representation is stored**, never the raw page. `set`
  enforces `maxEntries` on every write (oldest evicted first, tie-broken on key
  so eviction is deterministic), and the parent directory is created if missing.

`EvidenceService` treats the cache as strictly optional and strictly
best-effort: a lookup failure logs a warning and continues with a live fetch, and
a store failure is logged and ignored. A source served from cache is marked
`from_cache: true`, gets a `SERVED_FROM_CACHE` warning, and reports the original
retrieval time in `retrieved_at`.

---

## 8. Extension points (SPEC §37)

SPEC §37 lists eight names to prepare as interfaces without implementing them
all. Here is the exact state of each. Do not read this list as a feature list —
seven of the eight have **no code in the repository**.

| Extension point | Purpose | State |
|---|---|---|
| `CacheProvider` | Replace the storage backend for cached sources. | **Implemented.** The interface is in `packages/cache/src/types.ts` and the SQLite adapter in `sqlite-cache.ts`. |
| `SearchProvider` | `search(query) → normalised source candidates`, so the service can find URLs instead of only accepting them. | **Interface only — not implemented.** No code. v0.1.0 works on agent-supplied URLs (SPEC §8). |
| `BrowserProvider` | Render JavaScript-heavy pages where static HTML is insufficient. | **Interface only — not implemented.** No code. Bounded browser use is a SPEC §2 requirement for any future work here. |
| `ReasoningProvider` | Claim decomposition, relevance ranking, source comparison, structured synthesis behind a vendor-neutral, OpenAI-compatible interface. | **Interface only — not implemented.** No code. The service is fully useful without it; `assess()` is lexical only. |
| `DocumentProvider` | PDF and other non-HTML document parsing for evidence. | **Interface only — not implemented.** No code. |
| `EvidenceRanker` | Replace or refine the deterministic lexical ranking with another strategy. | **Interface only — not implemented.** Today, ranking is the fixed function `findEvidenceCandidates` in `@aee/extraction`. |
| `SourceTrustProvider` | Supply domain/source trust signals independent of the excerpt. | **Interface only — not implemented.** No code. |
| `PaymentProvider` | Swap the payment rail behind the payment boundary. | **Interface only — not implemented.** The Worker calls the official `@x402/*` middleware directly. |

Two constraints apply to every one of these, whenever they are built:

- **No hard-wiring of a vendor.** SPEC §1 and AGENTS.md §2 forbid hard-coding
  DeepSeek, OpenAI, Anthropic, or any other provider as the production
  intelligence provider.
- **Provenance survives.** A reasoning provider may decompose, rank, compare,
  and synthesise, but it must never replace source evidence with unsupported
  prose. Every conclusion must remain traceable to a real source URL, final URL,
  retrieval timestamp, short excerpt, and content hash (SPEC §21).

`CacheProvider` is the one that earned its keep early: it hides a synchronous
driver behind an asynchronous interface, which is a real substitution that a
future network-backed store will use.

---

## 9. Implementation status

Every package and both apps are implemented. `pnpm typecheck` passes across the
workspace.

**Implemented**

- `packages/schemas` — the complete wire contract, plus built `dist/` output.
- `packages/fetcher` — SSRF-hardened retrieval: scheme allowlist, IPv4/IPv6 range
  classification, hostname rules, port allowlist, resolved-IP validation,
  per-hop redirect validation, connect-time revalidation, timeouts, streaming
  byte cap, manual decompression.
- `packages/extraction` — document extraction, metadata, normalisation, lexical
  evidence ranking, negation cues.
- `packages/cache` — key normalisation, `CacheProvider`, bounded SQLite adapter.
- `packages/core` — configuration, structured logger with secret redaction,
  cross-source assessment, `EvidenceService`, `ServiceError`.
- `packages/mcp` — the remote MCP adapter. Streamable HTTP in **stateless** mode
  (`sessionIdGenerator: undefined`, `enableJsonResponse: true`), a fresh
  `Server` + transport pair per request, `tools/list`, and `tools/call`
  delegating to the same `EvidenceService` the HTTP layer uses — which is the
  layering rule of §6 in practice. Tool input schemas are generated from the same
  zod shapes via `z.toJSONSchema`.
- `apps/backend` — the Fastify service: fail-closed startup, constant-time
  shared-secret verification, `GET /health`, `POST /internal/v1/evidence`, and
  all three MCP verbs.
- `apps/worker` — the full edge: x402 gate, free `/health` and `/`
  capabilities, `POST /v1/evidence` forwarding, MCP body inspection and
  forwarding, dev bypass with mainnet guard, error envelope, not-found and
  on-error handlers.
- `docker/` — a multi-stage `Dockerfile`, a single-service `docker-compose.yml`,
  separate production (mainnet) and development (testnet) env templates, and a
  root `.dockerignore`.
- `server.json` — MCP Registry metadata for a remote streamable-HTTP server.
- `apps/worker/.dev.vars.example`, `scripts/smoke.sh`.
- Test suites: `tests/security/ssrf.test.ts`, `tests/security/limits.test.ts`,
  `tests/e2e/evidence-flow.test.ts`, `packages/mcp/src/mcp.test.ts`,
  `packages/extraction/src/extraction.test.ts`,
  `packages/cache/src/cache.test.ts` — about 147 cases in total.

**Verified here**

- `pnpm typecheck` → exit 0.

**Not verified here**

- The test suites and `scripts/smoke.sh` have not been executed, so no pass/fail
  result is known.
- No on-chain x402 payment has been demonstrated.

**Known gaps**

- `ROBOTS_POLICY` is parsed and validated but never consumed, so all three values
  is now honoured by `EvidenceService`. See
  [`security.md`](./security.md#robots_policy).
- `apps/worker/wrangler.jsonc` contains literal test-recipient addresses in
  `env.dev` and `env.test`.
- `UNSUPPORTED_CONTENT` (HTTP 415) is emitted when a source's content type
  cannot be processed. Rate limiting is enforced at the backend, and the
  automated x402 smoke test covers the 402 gate (not on-chain settlement).
- `server.json` uses a confirmed namespace (`io.github.Thx93/`) but a placeholder
  remote URL, and the repository it references does not exist yet.

---

## Related documents

- [`api.md`](./api.md) — HTTP endpoint reference and the exact wire shapes.
- [`mcp.md`](./mcp.md) — MCP transport, tools, and payment behaviour.
- [`x402.md`](./x402.md) — the payment flow and its configuration.
- [`security.md`](./security.md) — the SSRF and origin-protection model.
- [`deployment.md`](./deployment.md) — running and deploying the components.
- [`discovery.md`](./discovery.md) — how agents find this service.
