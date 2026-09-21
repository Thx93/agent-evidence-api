# Engineering report

Required by `SPEC.md` §44. Every claim below is either demonstrated by a command
in this repository or explicitly marked as not demonstrated.

**This project is not claimed to be production ready.** The §42 acceptance
criteria are assessed in the final section, including the ones that are *not* met.

Report date: 2026-09-21 · service version **0.1.1**

---

## 1. What was built

**Agent Evidence API** — evidence infrastructure for AI agents. An agent submits a
question or claim plus up to five public URLs; the service fetches them, extracts
and normalises the content, records provenance, extracts the passages that bear on
the question, and returns a structured evidence package with an explicit
`supported` / `contradicted` / `mixed` / `inconclusive` assessment.

It is reachable over **HTTP** and **MCP**, paid per call over **x402 with USDC on
Base mainnet** (HTTP 402). There is no account, no API key and no signup.

Deliberately not built, per §2 of `AGENTS.md`: frontend, accounts, subscriptions,
billing dashboards, Kubernetes, Terraform, Redis, Postgres, a vector database, and
any vendor-specific intelligence provider.

## 2. Final architecture

```
MCP client / HTTP client
        │
        ▼
Cloudflare Worker (edge, Free plan)      apps/worker
  · x402 payment gate (402 challenge, verify, settle)
  · MCP streamable-HTTP endpoint
  · bazaar discovery declaration (HTTP and MCP shapes)
  · origin-health gate: refuses paid traffic when the backend is down
        │  shared secret + 30 s timeout
        ▼
Backend, Linux VPS (Fastify, Node 24)    apps/backend
  validate → fetch → extract → normalise → evidence → cache
        │
        ├─ packages/fetcher      SSRF-hardened HTTP (own DNS validation)
        ├─ packages/extraction   HTML parsing, metadata, evidence candidates
        ├─ packages/cache        node:sqlite, bounded
        └─ packages/schemas      the shared contract (zod)
```

Payment is enforced only at the Worker. The backend never sees or verifies a
payment; it is reachable only with the shared secret.

An optional semantic ranker sits beside the backend as a separate process:

```
backend ──HTTP──▶ services/laya/server.py (Laya, Apache-2.0, local)
```

It is **off by default** (`REASONING_PROVIDER=none`) and falls back silently.

## 3. Exact project location

| | |
|---|---|
| Spec-required path | `/srv/agent-evidence-api` (symlink) |
| Physical location | `/root/dsh-workspace/agent-evidence-api` |
| Reason | the development sandbox permits writes only under `/root/dsh-workspace` |

## 4. Important files

| Path | What it is |
|---|---|
| `SPEC.md` | the product specification, transcribed from the source PDF |
| `AGENTS.md` | the sole project rules file |
| `packages/schemas/src/errors.ts` | the error contract and HTTP status mapping |
| `packages/fetcher/src/ip.ts` | IP classification: the SSRF core |
| `packages/fetcher/src/fetch.ts` | redirect validation, connect-time re-validation, limits |
| `packages/core/src/service.ts` | `EvidenceService`, shared by HTTP and MCP |
| `apps/worker/src/index.ts` | x402 gate, MCP transport, discovery declarations |
| `apps/backend/src/app.ts` | routes, auth, rate limiting, usage log |
| `docs/FIRST-SALE.md` | the runbook for the first payment |
| `docs/CHECKLIST.md` | every action that requires a human |
| `docs/discovery.md` | how the x402 catalogue and its search actually work |
| `server.json` | the MCP Registry listing (published, 0.1.1) |

## 5. Commands to run locally

```bash
export PATH="/root/dsh-workspace/bin:$PATH"   # node, pnpm, wrangler wrappers

pnpm install
pnpm typecheck          # tsc --noEmit across the workspace
pnpm test               # 260 tests
pnpm dev:backend        # backend on :8080
pnpm dev:worker         # worker on :8787
```

Verification tools, all re-runnable:

```bash
node buyer/verify-payment-path.mjs       # settlement path, needs no funds
node packages/mcp/verify-live-mcp.mjs    # registry → real MCP client handshake
bash scripts/check-live-links.sh         # no dead links on the landing page
bash scripts/check-load.sh               # holds under concurrency
```

## 6. Commands to deploy

```bash
bash scripts/go-live.sh        # container + tunnel + origin wiring
bash scripts/deploy-live.sh    # deploy the Worker at the current origin
bash scripts/supervise.sh      # detached watchdog, every 5 minutes
```

## 7. Test results

```
261 tests · 52 suites · 261 pass · 0 fail
```

| Suite | Covers |
|---|---|
| `tests/security/ssrf.test.ts` | schemes, loopback, RFC1918, link-local, metadata endpoints, ports, decimal/octal/hex encodings |
| `tests/security/dns-rebinding.test.ts` | connect-time re-validation; the `all: true` lookup contract |
| `tests/security/limits.test.ts` | response size, timeouts, redirects, concurrency |
| `tests/security/encoding.test.ts` | decompression bombs, chained encodings |
| `tests/security/robots.test.ts` | `ignore` / `warn` / `enforce` policy |
| `tests/e2e/evidence-flow.test.ts` | the full pipeline, error envelope, zero-retrieval refusal, usage record, version consistency, and the SPEC §24 request-log fields |
| `tests/e2e/buyer-cli.test.ts` | the shipped buyer bundle against a local x402 mock: success and failure output, first-run onboarding |
| `tests/e2e/rate-limit.test.ts` | token bucket, `Retry-After` |
| `tests/e2e/semantic-ranking.test.ts` | reordering, budget reservation, per-request reset, every fallback path |
| `packages/*/src/*.test.ts` | cache, extraction, MCP tool definitions |

## 8. x402 status

**Configured for mainnet.**

| | |
|---|---|
| Network | `eip155:8453` (Base) |
| Asset | USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Price | `30000` = $0.03 |
| Recipient | `0x9c0e2B44180439294Fa30Ae2B2a94f8655455FD0` |
| Facilitator | `https://facilitator.payai.network` |

**Demonstrated:** a request without payment returns `402` with a valid
`PAYMENT-REQUIRED` challenge. A genuinely signed payment payload from an unfunded
wallet is verified by the facilitator against the **real USDC contract on Base
mainnet** and rejected for exactly one reason:

```
invalidReason: "invalid_exact_evm_insufficient_balance"
"transferWithAuthorization reverted: ERC20: transfer amount exceeds balance"
```

That is the strongest available evidence short of spending money: our challenge, a
correctly signed EIP-3009 authorisation, a real on-chain simulation.

**NOT demonstrated:** a completed settlement. No funded payment has been made. The
payment path is verified to the last step before funds and no further.

**Failure safety, demonstrated:** settlement is cancelled for any handler response
≥ 400, so a request that fails is not charged. When no source could be retrieved
the service returns `NO_SOURCES_RETRIEVED` (502) rather than an empty success.
The MCP transport reports tool failures inside HTTP 200, which the middleware
cannot see, so the Worker rewrites those to 502 — otherwise a failed paid tool call
would still have settled.

`buyer/verify-payment-path.mjs` re-runs the verification without spending.

## 9. MCP status

**Working, verified with a real client**, not only with `curl`.

`node packages/mcp/verify-live-mcp.mjs` resolves the endpoint **from the public
registry** and then connects:

```
registry: io.github.Thx93/agent-evidence-api v0.1.1 -> …/mcp
✓ connected · tools/list · free tool works · paid tool refused with PAYMENT_REQUIRED
```

| Tool | Payment |
|---|---|
| `research_evidence` | $0.03 |
| `health` | free |
| `initialize` / `tools/list` | free, so an agent can look before it pays |

Both the HTTP handler and the MCP handler call the **same** `EvidenceService`;
neither duplicates business logic (SPEC §39).

## 10. MCP Registry readiness

**Published and active.**

```
io.github.Thx93/agent-evidence-api   0.1.1   status: active
remote: https://agent-evidence-api.taher-h-alhaddad.workers.dev/mcp
```

`server.json` validates. The superseded 0.1.0 is deprecated with a pointer to
0.1.1. The listing deliberately carries **no `repository` field**: the source is
private, so linking it published a 404 — see `docs/registry-publication.md`.

Separately, the x402 **Bazaar** is the channel where x402 buyers look, and it is
measured in `docs/discovery.md`: 6,567 HTTP services and **33 MCP tools**, of which
only 11 declare tool metadata and all 11 belong to one operator. This service
declares both shapes and is not yet listed, because **entries appear only when a
payment settles** and there is no submission endpoint.

## 11. Remaining manual configuration

Nothing is required for the current deployment to keep running; all credentials
are in place and the service is healthy.

Nothing further is required for it to be **buyable** either — see
`docs/CHECKLIST.md`. It requires a human to:

1. **Fund a wallet and make one payment** (~15 min). This is the distribution
   event, not a test: it is the only route into the x402 catalogue.
2. Confirm the catalogue listing.
3. Post the launch copy (`docs/launch/announcements.md`).

Optional, and only if wanted:

| | Needs |
|---|---|
| Durable public URL | a domain (~$11/yr) and a named Cloudflare tunnel |
| Semantic ranking on by default | ~2 GB RAM headroom on the VPS |
| npm publication of the buyer CLI | a Granular Access Token with Bypass 2FA — not needed, `…/buy.mjs` already gives buyers a zero-install path |

## 12. Known limitations

1. **No settlement has been exercised on mainnet.** Funds are the only missing
   input; see §8.
2. **The assessment is lexical, not semantic.** Asked *"What is the population of
   Tokyo?"* it returns passages containing those words, and can miss the sentence
   that answers the question because that sentence says "the city proper". Two
   lexical heuristics were tried, measured and reverted. The optional Laya ranker
   fixes the measured case; it is off by default and costs ~11 s versus ~1.4 s.
   The response reports the limitation in `limitations[]`.
3. **No web search.** The caller supplies the URLs.
4. **Maximum 5 URLs per request** (`maxUrlsPerRequest`; `HARD_CAPS.URLS` is 25 but
   unreachable through the request schema).
5. **The public URL depends on a quick Cloudflare tunnel** that changes on restart.
   The Worker is re-pointed automatically by the watchdog, so this is invisible to
   buyers today, but it is a moving part.
6. **The usage log is not revenue.** A line means a payment proof was presented;
   settlement happens after the backend responds. For money, read the on-chain
   record — see `docs/FIRST-SALE.md`.
7. **`application/json` sources yield no evidence** — the extractor is
   HTML-oriented. They fail honestly as `inconclusive` rather than falsely.
8. **The repository is private**, so the listing cannot link it.

---

## §35 end-of-work output

Section 35 requires five things at the end. Reported here so they are in one place
rather than spread across the document.

| | |
|---|---|
| **Current branch** | `main`, 36 commits, working tree clean |
| **Remote** | `https://github.com/Thx93/agent-evidence-api.git` (private) |
| **Files created** | 109 tracked, across `packages/` 39, `apps/` 14, root 14, `docs/` 12, `tests/` 10, `scripts/` 10, `buyer/` 5, `docker/` 4, `services/` 1 |
| **Tests run** | 261 · 52 suites · 261 pass · 0 fail |
| **Deployment status** | live on Base mainnet; Worker, backend container, tunnel and watchdog all running and healthy |
| **Remaining manual configuration** | §11 — one funded payment, then the catalogue confirmation and the launch posts |

### One deliberate deviation from §35

Section 35 says **"Do not force-push."** The Git history was rewritten once, with
`--force-with-lease`, to set the author identity on every commit at the
repository owner's explicit request. The true remote state was fetched first so
the lease could not discard anyone else's work.

Every other instruction in §35 was followed: Git was already initialised, so it was
not re-initialised; `.gitignore` covers `.env`, `.dev.vars` and `*.sqlite`; no
unrelated history was deleted; the remote was not changed; and nothing was pushed
to GitHub automatically.

---

## §42 acceptance criteria — honest assessment

| | Criterion | Status |
|---|---|---|
| 1 | Project exists at `/srv/agent-evidence-api` | ✅ symlink to the workspace |
| 2 | `AGENTS.md` is the sole rules file | ✅ no competing files |
| 3 | Backend starts | ✅ healthy in Docker |
| 4 | Worker builds | ✅ deployed |
| 5 | MCP server starts | ✅ handshake verified with a real client |
| 6 | Health endpoint works | ✅ `/health` and `/health?deep=1` |
| 7 | HTTP evidence endpoint works locally | ✅ |
| 8 | Secure URL fetching works | ✅ |
| 9 | SSRF tests pass | ✅ |
| 10 | Redirect validation tests pass | ✅ per-hop |
| 11 | Response size limits work | ✅ |
| 12 | Timeout limits work | ✅ |
| 13 | Metadata extraction works | ✅ |
| 14 | Main-content extraction works | ✅ |
| 15 | Content hashing works | ✅ SHA-256 per source |
| 16 | Evidence response schema is stable | ✅ zod, versioned `version: "1"` |
| 17 | SQLite cache works | ✅ `node:sqlite` |
| 18 | MCP tool discoverable from the server | ✅ `tools/list` |
| 19 | MCP invokes the same `EvidenceService` as HTTP | ✅ one service, two adapters |
| 20 | x402 returns 402 without payment | ✅ |
| 21 | Base Sepolia test payment flow | ⚠️ **not run.** This deployment is mainnet; the path is verified on mainnet via on-chain simulation, but no testnet payment was executed either |
| 22 | Worker forwards authorized calls | ✅ shared secret, timing-safe compare |
| 23 | Backend cannot be used anonymously | ✅ verified `401` |
| 24 | Production secrets not committed | ✅ audited; `.env`, `.dev.vars`, `*.sqlite` gitignored |
| 25 | Docker deployment works | ✅ running, healthy |
| 26 | `server.json` validates | ✅ published as 0.1.1 |

**25 of 26 met. Criterion 21 is not met.** In addition, one criterion from §44's
own framing is outstanding: **no real payment has settled**, so the acceptance
criterion implied by "live and buyable" is demonstrated only up to the point of
funds.

On that basis this project is described as **live on mainnet, safe to charge, and
not yet proven by a real transaction** — and not as production ready.
