# AGENTS.md — Agent Evidence API

This is the **sole** project rule book. Do not create `CLAUDE.md`, `.cursorrules`,
`GEMINI.md`, or any competing instruction file. All project-specific engineering
rules live here.

The full product specification is [`SPEC.md`](./SPEC.md) (transcribed from the
source PDF). This file is the operational summary an agent needs to work in the
repository; `SPEC.md` is the authority on product requirements.

---

## 1. What this product is

**Agent Evidence API** — evidence infrastructure for AI agents.

An agent submits a question/claim plus optional URLs. The service fetches those
public sources, extracts and normalises content, records provenance, and returns
a structured evidence package so the agent can ground its answer in sources.

The single capability of v0.1.0:

> agent-accessible web evidence and claim verification

It is reachable by agents over **both** HTTP and MCP. Payment is **x402 + USDC on
Base**. The public edge is a **Cloudflare Worker (Free plan)**; heavy work runs on
the Linux VPS.

### It is NOT

A web scraper, SEO tool, generic crawler, proxy, browser-automation service, or
search engine. Do not position or build it as one.

---

## 2. Hard constraints (do not violate)

1. **Do not build**: frontend/dashboard, user accounts, passwords, social login,
   subscriptions, organisations, teams, billing dashboards, email, CRM, mobile
   apps, browser extension, admin panel, job marketplace, NFT/token, or a
   proprietary autonomous agent.
2. **Do not introduce**: Kubernetes, Terraform, Redis, PostgreSQL, Elasticsearch,
   a vector database, Kafka, a full observability stack, or self-hosted CI. A
   hosted workflow file (GitHub Actions) is not what "a complex CI platform"
   meant here: it is a committed YAML file and no infrastructure to run. Both
   projects ship one and are expected to keep their suites green in it — a
   public repository with no CI reads as unmaintained. (Amended 2026-09-24 at the
   operator's explicit instruction.)
3. **Do not** install large unnecessary system packages.
4. **Do not** modify unrelated DSH, Kilo Code, SSH, or repository configuration.
5. Keep the architecture **model/harness/vendor agnostic**. Never hard-code
   DeepSeek (or any vendor) as the production intelligence provider.
6. Prefer **interfaces and adapters** over vendor-specific implementation.
7. Do not silently substitute an obsolete x402 or MCP implementation. Verify
   against current official package documentation rather than guessing APIs.
8. **Do not claim success until the complete local end-to-end flow works.**
9. Never state "production ready" unless the acceptance criteria in `SPEC.md`
   §42 have actually been demonstrated.
10. Do not fabricate credentials, wallet addresses, or domains. Use placeholders
    (`PUBLIC_API_DOMAIN`, `BACKEND_ORIGIN_URL`, `MCP_PUBLIC_URL`).

---

## 3. Architecture

```
        ┌──────────────┐
        │  MCP client  │
        └──────┬───────┘
               │  streamable HTTP
┌──────────────▼───────────────┐        ┌───────────────┐
│  Cloudflare Worker (edge)    │◀───────│  HTTP client  │
│  · x402 payment gating       │        └───────────────┘
│  · request shape validation  │
│  · MCP endpoint              │
└──────────────┬───────────────┘
               │  shared-secret / HMAC (server-to-server)
┌──────────────▼───────────────┐
│  Backend VPS (Fastify + TS)  │
│  validate → fetch → extract  │
│  → normalise → evidence      │
│  → cache (SQLite)            │
└──────────────────────────────┘
```

The pipeline, in order:

```
request → validation → source acquisition → redirect validation → HTTP fetch
→ content-type detection → HTML parsing → metadata extraction
→ main-content extraction → normalisation → evidence candidate extraction
→ cross-source comparison → structured response
```

**Layering rule (from SPEC §39).** HTTP and MCP adapters must not duplicate
business logic; both call the same core application service:

```
HTTP adapter ─┐
              ├─→ EvidenceService ─→ Fetch / Extract / Cache
MCP adapter ──┘
```

x402 belongs at the **payment boundary**, never inside the core evidence engine.

---

## 4. Repository layout

```
agent-evidence-api/
├── AGENTS.md            # sole rules file (this)
├── SPEC.md              # transcribed product specification
├── README.md
├── .env.example
├── pnpm-workspace.yaml
├── docs/                # architecture, api, mcp, x402, security, deployment, discovery
├── apps/
│   ├── backend/         # Fastify service — the VPS workload
│   └── worker/          # Cloudflare Worker — the public edge
├── packages/
│   ├── schemas/         # zod schemas + inferred types (the shared contract)
│   ├── core/            # EvidenceService and domain logic
│   ├── fetcher/         # SSRF-hardened HTTP fetching
│   ├── extraction/      # HTML parsing, metadata, main content, normalisation
│   ├── cache/           # SQLite-backed bounded cache
│   └── mcp/             # MCP server + tool definitions
├── tests/               # cross-package integration + e2e
└── docker/              # Dockerfile, compose, env templates
```

Imports between workspaces use `@aee/*` package names, never relative paths that
escape a package root.

---

## 5. Security rules (non-negotiable)

The fetcher is a **security-sensitive component**. Treat every URL as hostile.

Required defences — each needs a test (SPEC §18, §26):

- allow only `http` and `https` schemes; reject `file://` and everything else
- reject localhost and localhost aliases
- reject loopback, RFC1918/private, link-local, multicast, unspecified addresses
- reject IPv6 loopback, IPv6 link-local, and private IPv6 ranges
- block cloud metadata endpoints (e.g. `169.254.169.254`)
- validate hostname resolution and the resolved IPs
- **validate every redirect hop**, not just the first URL
- defend against DNS rebinding (re-check the resolved IP at connect time)
- restrict ports to an allowlist
- enforce connection timeout **and** total request timeout
- enforce maximum redirects
- enforce maximum response bytes
- prevent decompression bombs
- enforce concurrency limits
- **never** pass a raw URL into a shell command
- sanitise logs; never log payment secrets or origin secrets

Also: do not bypass authentication, paywalls, CAPTCHAs, or anti-bot mechanisms;
do not automate login. Use a clearly identifiable User-Agent. Only publicly
accessible resources are in scope.

---

## 6. Secrets and credentials

- **Never** hard-code, commit, or log a private key, seed phrase, wallet secret,
  origin secret, or API token.
- Never request or store a customer wallet private key.
- The recipient wallet needs only its **public address** (`X402_RECIPIENT`).
- `X402_TEST_PRIVATE_KEY` is Base Sepolia only, lives in the local env file, and
  must never be used with mainnet funds.
- `.env` files, `.dev.vars`, and `*.sqlite` databases are gitignored.
- Provide `.env.example` and `.dev.vars.example` with placeholders only.
- Testnet and production wallet configuration must be clearly separate; never mix.
- If credentials are unavailable: implement everything possible locally, then
  document precisely what remains. Do not fake it and do not claim it works.

---

## 7. Coding standards

- **Strict TypeScript** everywhere. No `any` without a written justification.
- Validate all external input with **zod** schemas from `packages/schemas`.
- Typed errors with stable, machine-readable codes (SPEC §22).
- Modular services; environment-driven configuration; secure defaults.
- Prefer boring, maintainable code. No clever abstractions without need.
- Bounded everything: memory, concurrency, response size, browser use, cache size.
- Deterministic processing wherever practical.
- Never expose stack traces in production responses.
- Structured JSON logs with a request ID on every request.

### Response schema statuses

Use exactly: `supported` | `contradicted` | `mixed` | `inconclusive`.

Never invent facts, never pretend a source says something it does not, and never
emit unsupported confidence scores. When semantic interpretation is uncertain,
return `inconclusive`. Every evidence item must be traceable to a real source
URL, final URL, retrieval timestamp, short excerpt, and content hash.

---

## 8. Testing bar

Testing is a **hard acceptance criterion**, not optional. Use Node's built-in
test runner (`node --test`). Cover:

- **URL validation / SSRF** — valid http/https, malformed, localhost, private IP,
  IPv6 loopback, metadata endpoint, dangerous port, unsupported scheme, encoded
  bypass attempts, decimal/octal/hex IP tricks, redirect-to-private, DNS rebinding
- **HTTP** — 200, 3xx, redirect chains, 4xx, 5xx, timeout, oversized response,
  wrong content type, malformed HTML
- **Extraction** — title, description, canonical, Open Graph, JSON-LD, language,
  dates, main text, headings, content hashing
- **Evidence** — relevant, irrelevant, conflicting, insufficient, agreeing sources
- **Cache** — miss, hit, expiry, invalidation, bounded retention
- **x402** — request without payment → 402; valid testnet payment → success
- **MCP** — startup, tool listing, tool schema, invocation, payment-required,
  paid flow, malformed arguments, error handling

Use a **deterministic local fixture server** rather than depending on live sites.
Never put a production private key into an automated test.

**Development loop (SPEC §41)** — after each meaningful phase: typecheck → unit
tests → integration tests → inspect failures → fix → continue. Do not accumulate
dozens of unchecked changes.

---

## 9. Commands

Run from the repository root. `pnpm` here is the workspace-local wrapper.

```bash
pnpm install            # install workspace deps
pnpm typecheck          # tsc --noEmit across packages
pnpm test               # unit + integration tests
pnpm test:security      # SSRF / URL validation suite
pnpm test:e2e           # end-to-end acceptance flow
pnpm dev:backend        # backend on :8080
pnpm dev:worker         # worker on :8787
pnpm build              # build all packages
pnpm validate           # typecheck + tests (use before declaring anything done)
```

### Sandbox note

This development environment only permits writes under
`/root/dsh-workspace`. The project physically lives at
`/root/dsh-workspace/agent-evidence-api` and is exposed at the spec-required path
`/srv/agent-evidence-api` via a symlink. All tooling must therefore run with the
workspace wrappers on `PATH`:

```bash
export PATH="/root/dsh-workspace/bin:$PATH"   # node, npm, pnpm, wrangler, cloudflared
```

---

## 10. Versioning

Product version starts at `0.1.0`. API version is `v1`. Keep schemas stable and
include a `version` field in responses. Do not support multiple major API
versions prematurely.

`schemas/` changes are contract changes: update the schema, the tests, and
`docs/api.md` in the same change.

---

## 11. Definition of done

The project is complete only when every box in `SPEC.md` §42 is genuinely true —
including: backend starts, worker builds, MCP server starts, health works, the
HTTP evidence endpoint works locally, SSRF and redirect tests pass, the SQLite
cache works, the MCP tool invokes the same `EvidenceService` as HTTP, x402
returns 402 without payment, the backend cannot be used anonymously to bypass
payment, no production secret is committed, Docker deployment works,
`server.json` validates, and the documentation is complete.

Finish with the engineering report required by `SPEC.md` §44, distinguishing
clearly between **implemented**, **tested**, **externally blocked**, and
**requires manual production configuration**.
