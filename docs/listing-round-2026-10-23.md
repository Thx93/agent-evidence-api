# Listing round — 2026-10-23

Owner: `listing-scout` (team task-2). Everything below was checked **2026-10-23,
~02:50–03:10 Asia/Riyadh (23:50–00:10 UTC)** unless a row states otherwise.

**Money spent: 0.00 USDC.** **Accounts created: none.** **CAPTCHAs solved: none.**
**Bot-protection circumvented: none.** All submissions used routes that openly
document a free, no-account submission path, or the project's own GitHub identity
(`Thx93`).

The deliverable was originally scoped to
`agent-evidence-api/docs/listing-round-2026-10-23.md`; the repo is a symlink into
`/root/Agents Projects` which is outside this session's writable sandbox, so it lives
here instead (Lead's instruction).

## How to read the status column

| Label | Means |
|---|---|
| **LIVE** | Fetched today and the page/API returned *this* listing's content. Nothing here rests on a promise. |
| **MERGED-SOURCE** | Merged into a directory's own index source (merge commit verified), but the rendered profile page does not exist yet. |
| **SUBMITTED** | A submission artefact exists and is verifiable (id, status page, PR number). It is **not** live. |
| **BLOCKED** | No listing, with the evidence that produced the conclusion. |
| **STALE** | Live listing is showing outdated copy or data. |

---

## 0. Baseline re-check (so every row below is comparable)

Both servers still answer `initialize` + `tools/list` anonymously on **both** hostnames:

| Check | Result |
|---|---|
| `POST https://agent-evidence.thx93.dev/mcp` (`initialize`) | **HTTP 200**, `serverInfo: agent-evidence-api **0.1.6**` |
| `POST https://agent-evidence.thx93.dev/weather/mcp` | **HTTP 200**, same serverInfo |
| `POST https://agent-evidence-api.thx93.workers.dev/mcp` and `/weather/mcp` | **HTTP 200** on both (both hostnames serve the same deployment) |
| AEA `tools/list` | `research_evidence`, `sample`, `health` — **each now has `title` + `annotations`** (the old "no title / no annotations" blocker is gone) |
| Weather `tools/list` | `get-alerts`, `get-forecast`, `health` — annotations present, **`title` still missing** on all three |
| `POST /v1/evidence` with no payment | **HTTP 402**, `x402Version: 2`, `amount: "10000"` (=**$0.01** USDC, 6 dp), `network: eip155:8453`, `asset: 0x8335…2913` (USDC), `payTo: 0x9c0e2B44180439294Fa30Ae2B2a94f8655455FD0` |
| `POST /v1/weather/alerts`, `POST /v1/weather/forecast` | **HTTP 402** each, same price/asset/network |
| `POST /health` | **HTTP 404** — there is no HTTP health route (only an MCP `health` tool); do not publish a `/health` URL |

**Version inconsistency to be aware of:** the official registry's latest entries are
`io.github.Thx93/agent-evidence-api` **0.1.7** and `io.github.Thx93/weather` **1.1.3**
(registry API, HTTP 200), and `server.json` in the repo says 0.1.7, but the deployed
worker reports **0.1.6**. So 0.1.7 is published but not deployed. Nothing was claimed
about 0.1.7 anywhere in today's submissions.

---

## 1. Re-verification of the 2026-10-18/19 submissions

### GitHub routes — all five PRs are still open, none merged

Verified with `gh api repos/<repo>/pulls/<n>` plus a raw-README grep for `thx93`
(0 hits in every list README, i.e. none of these lists contains us yet).

| Submission | State today | Evidence |
|---|---|---|
| punkpeye/awesome-remote-mcp-servers **#2214** | **open**, `mergeable: true`, labels `endpoint-ok`, `has-connector` (unchanged since 10-18) | `gh api` state=open, merged=false, updated_at 2026-10-18T20:02:25Z |
| punkpeye/awesome-mcp-servers **#16911** | **open**, `mergeable: true`, labels `has-emoji`, `valid-name`, `has-glama`; 1 bot comment (Glama badge check) | `gh api` state=open, merged=false |
| cline/marketplace **#279** | **open**, no labels, no comments | `gh api` state=open, merged=false |
| docker/mcp-registry **#5839** | **open**, no labels, no comments | `gh api` state=open, merged=false |
| TensorBlock/awesome-mcp-servers **#4090** | **CLOSED 2026-10-19** — maintainer asked for one server per PR. Superseded: see below. | close comment by `wilsonccccc`, "Please submit each server in a separate PR with one entry in one category file" |

**TensorBlock was redone (before this round) and merged.** PRs **#4343** (AEA) and
**#4344** (weather) were merged **2026-10-22 09:05–09:08 UTC**:
`gh api repos/TensorBlock/awesome-mcp-servers/commits?path=docs/search.md` →
`dd1cbb66 Merge pull request #4343 from Thx93:add-thx93-agent-evidence-api`,
`merged: true`. Both entries are in the index source right now:

- `docs/search.md` line 5 — `[Thx93/agent-evidence-api]…` (names tools
  `research_evidence`, `sample`, `health`; states x402 0.01 USDC per call; license MIT).
- `docs/location--maps.md` line 5 — `[Thx93/mcp-weather-server]…`
- Both entries still advertise the **old workers.dev endpoint**
  (`https://agent-evidence-api.thx93.workers.dev/mcp`) rather than `agent-evidence.thx93.dev`.

Status: **MERGED-SOURCE, not yet rendered.** Evidence that the profile page is *not*
live: the bot's own profile URLs
(`https://tensorblock.co/mcp/servers/github-thx93-agent-evidence-api-18a1f241` and
`…-mcp-weather-server-06bfd020`) return the site's generic SPA shell — byte-identical
size 6,609 to a deliberately bogus path — while a real profile
(`…github-dbsxortime-mcp-weather-server-921ab06b`) returns different content. The
index API `GET https://mcp-index.tensorblock.co/v1/servers/github-thx93-agent-evidence-api-18a1f241`
is **HTTP 404**, and its health endpoint says the catalog snapshot was built
`2026-10-20T09:12:54Z` (older than the 10-22 merge). So: in the source, not in the served index.

### Issue / discussion routes — still open, no replies

| Submission | State today | Evidence |
|---|---|---|
| chatmcp/mcpso **#5687** (AEA) | **open**, 0 comments | `gh api repos/chatmcp/mcpso/issues/5687` state=open, updated_at 2026-10-18 |
| chatmcp/mcpso **#5688** (weather) | **open**, 0 comments | same |
| github/github-mcp-server **#3528** (AEA onboarding) | **open**, `isAnswered:false`, 0 comments, category Q&A | GraphQL `discussion(3528)` |
| github/github-mcp-server **#3529** (weather onboarding) | **open**, `isAnswered:false`, 0 comments | GraphQL `discussion(3529)` |

mcp.so still has no page for us: `GET https://mcp.so/server/agent-evidence-api` → **HTTP 404**.

### Directory pages — what is actually live

| Directory | Status today | Evidence |
|---|---|---|
| **mcpservers.org** (AEA) | **LIVE** | `https://mcpservers.org/servers/thx93/agent-evidence-api` → 403 to plain curl (Cloudflare), **HTTP 200 + rendered content via `r.jina.ai`**, title "Agent Evidence API MCP Server" |
| **mcpservers.org** (weather) | **LIVE** | `https://mcpservers.org/servers/thx93/mcp-weather-server` → 200 via `r.jina.ai`, title "NWS Weather MCP Server" |
| **Glama** (AEA connector) | **LIVE but STALE** | 200, "Ownership verified", "Status Healthy", "Uptime 19.0% over 29 days", "Last Tested 2026-10-19". Displays **"No API key: $0.003 USDC per call"** — the old price (see §6) |
| **mcp.directory** | **NOT live** | `GET https://mcp.directory/sitemap.xml` → 200, **13,327** `<loc>` entries, **no** `thx93`/`agent-evidence` URL. Submitted 10-18 with a "review within 24 h" promise; 5 days later, nothing. My duplicate-check `POST /api/submit-server` now answers **HTTP 400** `"A valid GitHub repository URL is required"` (their field contract changed), so the old 409-duplicate proof cannot be re-created — the sitemap is the proof of absence |
| **mcpmarket.com** | **NOT live** | `/search?q=agent+evidence` → 200 but **zero** occurrences of `thx93`; the "Agent Evidence" cards on that page are unrelated third-party products. Free queue (submitted 10-18, quoted 4–6 weeks) still pending |

---

## 2. New submissions made today

All of these are **free**; none required an account, a CAPTCHA, or bypassing anything.

| # | Directory | Route used | Status | Evidence |
|---|---|---|---|---|
| 1 | **402 Index** (`402index.io`) — x402/L402/MPP API directory | `POST /api/v1/register` (documented, open, no auth) | **LIVE** | 3× HTTP **201** `{"message":"Service registered and live"}`; each re-read by id: `GET /api/v1/services/77439ab4-…` etc. → 200 with our name, `price_usd 0.01`, `health_status healthy`, `probe_status probeable`, **`x402_payment_valid 1`** |
| 2 | **x402dash** (`x402dash.com`) | `POST https://api.x402dash.com/v1/register` (its own submit page: "Free & instant · No account needed") | **LIVE** | 3× HTTP **201**, `{"status":"registered","verified":true,"message":"Endpoint verified and registered…"}`; `GET https://api.x402dash.com/v1/endpoints?q=agent-evidence` → 200, all three ids present |
| 3 | **x402 List** (`x402-list.com`) | `POST https://x402-list.com/api/v1/submit` (free from your own domain) | **SUBMITTED** (`pending`, manual review) | HTTP **201**, `{"submission_id":"a9c83066-2493-41bd-b7af-e6fca33f4b23","status":"pending","probe_result":{"endpoints_found":3,"errors":[]}}` |
| 4 | **MCP Collection** (`mcpcollection.com`) | `POST https://mcpcollection.com/api/submit` (JSON API, no auth) | **SUBMITTED** (`pending_review`) | HTTP **201** for AEA `{"id":333,"slug":"agent-evidence-api","status":"pending_review"}` and weather `{"id":334,"slug":"nws-weather"}`. Listing URLs 404 until approved (checked). Manual review "usually within 48 hours" |
| 5 | **mcp.tc** | HTML form `POST https://mcp.tc/submit` (no account; honeypot + timing token left untouched; first attempt answered 422 "Hold on a second", retried with a normal pause) | **SUBMITTED** (waiting for review) | 303 → status pages: `https://mcp.tc/s/jEYzSu0F9YHJhm2A` (AEA, will be `mcp.tc/i/agent-evidence-api`) and `https://mcp.tc/s/SvSxF9_MH5Bi6RoU` (weather, `mcp.tc/i/agent-evidence-weather`), both "Waiting for review / We found the server" |

**Paid routes deliberately not used** (details in §5): 402.ad (`$0.10`, site is dead),
mcp.so (`$39`), MCP Market fast lane (`$29`).

### CDP Bazaar — already indexed, free, no action available

Our three paid endpoints **are** in Coinbase's x402 Bazaar discovery index, verified
today (this is the settlement-index route the task asked about):

```
GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=1000&offset=5000
→ 200; items contain:
  https://agent-evidence.thx93.dev/v1/evidence          amount 10000, payTo 0x9c0e…FD0, lastUpdated 2026-10-21T22:19:04Z
  https://agent-evidence.thx93.dev/v1/weather/alerts     amount 10000, lastUpdated 2026-10-21T22:19:06Z
  https://agent-evidence.thx93.dev/v1/weather/forecast   amount 10000, lastUpdated 2026-10-22T08:32:09Z
```
(pagination.total = 33,505; a full 34-page scan found exactly these 3 hits, at offset 5000.)

**x402scan** has no documented submit route (`/api/…` probes → 404); it indexes the
Bazaar, so it should surface us automatically — **inferred, not verified** (its UI is
client-rendered and I did not find a server-rendered page for us).

---

## 3. What is now live (verified today, with the fetch behind it)

1. **402 Index — 3 listings, live and health-checked** (`x402`, $0.01, USDC/Base)
   - `Agent Evidence API — cited web evidence and claim verification` → `77439ab4-2b18-4b81-938a-72df53cb5011`, category `verification/evidence`
   - `NWS Weather Alerts — active US weather alerts by state` → `7ad39fc4-d8b6-43ea-aff5-3a1454404b71`, category `data/weather`
   - `NWS Weather Forecast — five-period US forecast by lat/lon` → `bc323276-63f1-4455-acca-8903b310cdcc`, category `data/weather`
2. **x402dash — 3 endpoints registered and verified** (`agent-evidence.thx93.dev/v1/{evidence,weather/alerts,weather/forecast}`), each `verified:true` and now liveness-monitored.
3. **CDP Bazaar — 3 endpoints indexed** (see above).
4. **mcpservers.org — both pages** (unchanged, re-verified).
5. **TensorBlock — both entries merged into the index source** (page pending their deploy).
6. **Glama — AEA connector**, with the stale price caveat.

## 4. Submitted, not live (do not describe as listed)

- **x402 List** — pending manual review (submission `a9c83066-2493-41bd-b7af-e6fca33f4b23`).
- **MCP Collection** — pending manual review (ids 333, 334).
- **mcp.tc** — waiting for a human reviewer (two status pages above).
- **punkpeye ×2, Cline, Docker** — PRs open, no reviewer action since 10-18.
- **mcp.so** — open issues on their repo; no page exists.
- **GitHub MCP Registry** — onboarding discussions unanswered.
- **mcp.directory**, **mcpmarket.com** — submitted 10-18/19, still absent.

## 5. Blocked, and exactly why

| Route | Why it stays blocked today |
|---|---|
| **mcpub.dev** (open MCP directory, 6 agent tools) | Its `submit` tool rejects us: `{"status":"error","reason":"well_known_missing","required_url":"https://agent-evidence.thx93.dev/.well-known/mcp.json"}`. That URL currently returns **404** (`{"code":"NOT_FOUND"}`). **One static `/.well-known/mcp.json` route in the worker unlocks it** — code change, outside this task's write scope |
| **402.ad** | Site is **retired**: `/submit` → **HTTP 410** "Thank you — 402.ad … a farewell". Its $0.10 agent submit API is moot |
| **agentndx.ai** | **HTTP 503** today (whole site). Previously advertised a free submit page; retry another day |
| **agenticx402.com** | Cloudflare "Client Challenge" interstitial — reading needs JS; not pursued (that is bot protection; we do not bypass it) |
| **mcpmarket.cn** (`mcpmarket.cn/submit`) | 302 → `/auth/login?next=/submit`. Account-gated; we create no accounts |
| **Smithery, LobeHub, Cursor, Claude Directory, OpenAI** | Unchanged from `docs/listing-campaign.md`: interactive OAuth / paid plan / identity verification |
| **PulseMCP** | Submissions still paused (their own page) |
| **mcp-server-directory.com, mcpjar.com, mcpserver.top, mcpindex.net, mcp-cloud.dev** | Hosts do not resolve / no response (code `000`) |
| **mcpserver.directory** | Root answers **HTTP 402** — paid-only gate |
| **xi8.me/mcp** | Parked domain ("this domain may be for sale") |
| **a2aprotocol.ai** | The only listing route found is `/advertise#submit-product`; no free submission path for a non-product MCP server |
| **agent402.com** | Returns a 114-byte stub; nothing to submit to |
| **Glama claim / Smithery publish** | Both need a human browser sign-in. Claiming Glama is the *only* way to fix its stale price line (§6) |

## 6. Stale-copy audit (the Lead's question: who still says $0.003?)

| Place | What it says | Verdict |
|---|---|---|
| **Glama** `glama.ai/mcp/connectors/io.github.Thx93/agent-evidence-api` | "Cited web evidence and claim verification for AI agents. **No API key: $0.003 USDC per call.**" | **STALE — live page, wrong price.** Mirrors the registry 0.1.7 description; it re-renders when Glama re-crawls (or after a claimed listing is updated) |
| mcpservers.org (both pages) | $0.01 a call | correct (mirrors repo README) |
| TensorBlock `docs/search.md` | 0.01 USDC on Base | correct |
| TensorBlock `docs/location--maps.md` | 0.01 USDC on Base, but endpoint still `…workers.dev/weather/mcp` | endpoint stale (works, just the older hostname) |
| 402 Index / x402dash / Bazaar | `price_usd 0.01` / `amount 10000` / Bazaar `amount "10000"` | correct |
| Official registry 0.1.7 | stale `$0.003` description, no `repository`/`websiteUrl` | Lead is fixing |
| Live worker | `serverInfo.version 0.1.6` while registry `server.json` says 0.1.7 | deployment behind metadata |

## 7. Paid options vs the 0.16 USDC budget

Prices are from each vendor's own page today. **Nothing was bought.**

| Rank | Option | Price | What it buys | Verdict vs 0.16 |
|---|---|---|---|---|
| 1 | **402.ad** agent submit API | **$0.10** USDC | an x402 directory submission | **Dead site (HTTP 410)** — do not spend |
| 2 | **x402 List** paid suggestion | **$0.10** | "a suggestion, not a listing… a reply is not guaranteed" | Useless for discovery — no |
| 3 | **x402 List** free-host fee (vercel.app / workers.dev URLs) | **$1.00** | a place in the review queue only | Over budget, and moot: we submitted the **custom-domain** URL, so it was free |
| 4 | **x402 List** resubmission after a rejection < 14 days | **$0.50** | queue slot | Over budget |
| 5 | **x402 List** support ticket | **$1.00** | 1 problem, human reply | Over budget |
| 6 | **x402 List** sponsor week | **28 – 72+ USDC** (`GET /api/v1/sponsor/weeks`: 28, 32, 36, 40, 45, 51, 57, 64, 72…) | a sponsor row on the directory | Over budget by ~175× |
| 7 | **MCP Market** "Get Listed Now" | **$29** one-time | listed in 24 h, official badge, "Try Now" link | Over budget (free queue already used) |
| 8 | **mcp.so** paid submission | **$39** one-time | instant publish, verified badge, dofollow | Over budget (free issue route used) |
| 9 | **mcp.so** sponsorship | **$699/mo** (Gold), **$1,299/mo** (Platinum) | pinned ad rails | Over budget by 4,000× |
| 10 | **agentndx** API Pro | **$29/mo** | full-index API + featured pin | Over budget; site also 503 today |
| 11 | **mcprush** publisher/listing fees | see `mcprush.com/for-publishers` — no fee at or under 0.16 was found; listing appears free to publish | — | Report only; task-1 owner has the deep mcprush read |

**Conclusion: 0.16 USDC buys nothing worth buying this round.** Every paid route that
could add reach starts at $0.50, and the only $0.10 options are dead or non-listing.
Recommendation: **keep the budget unspent**; the free routes in §2 all cost $0. The
next spend worth considering is a *decision*, not a fee: nothing until a directory
proves it converts a paid call.

Where the same 0.16 could be spent *internally* instead (not recommended without
evidence): three $0.01 USDC calls to our own endpoints — irrelevant for discovery now,
since all three resources are already in the Bazaar.

## 8. Free unlocks that are one small change away (for the Lead, not done here)

1. **Add `/.well-known/mcp.json` to the worker** (any content, even `{}`) → mcpub.dev
   submission goes through, which also puts us in its 6-tool agent directory. Today: 404.
2. **Fix the registry 0.1.7 description** ($0.003 → $0.01, add `repository` +
   `websiteUrl`) → Glama and any other registry-mirroring directory refresh their copy.
3. **Deploy 0.1.7** so `serverInfo.version` matches what the registry advertises.
4. **Add `title` to the three weather tools** (AEA's already have them) — several
   directories, including Anthropic's, care about tool titles.
5. **Human-only, high value:** claim the Glama listing (kills the stale $0.003 line and
   lets us swap the health probe off the paid tools), and `npx -y @smithery/cli auth login`.
6. **Optional republish to their index after deploy:** TensorBlock's entries still point
   at the old `workers.dev` host and its profile pages are pending; nothing to do but
   wait for their registry deploy.

## 9. Honesty ledger

- **No money was spent.** No payment form, no card, no x402 payment was ever signed.
  `/submit` pages that default to a paid tier were never used (mcp.so and MCP Market
  were not touched this round; their free routes were used on 10-18).
- **No account was created.** The only identity used is the existing `Thx93` GitHub
  account (for reads; no new PR was opened this round) and the project's outreach
  mailbox `outreach@agent-evidence-api.thx93.workers.dev` as the contact address on
  the three submissions that require an email (MCP Collection, x402 List).
- **No CAPTCHA was solved and no challenge was bypassed.** mcp.tc's form has a timing
  token and a honeypot; the first POST was rejected with 422 ("Hold on a second") and
  was simply retried after a normal human-length pause, honeypot left empty. The
  Cloudflare challenge on agenticx402.com was **not** bypassed.
- **Nothing submitted is described as live.** Every "LIVE" row above has the fetch and
  code that produced it; every pending row says pending.
- **The one "live but wrong" finding is named**: Glama still advertises $0.003.
- The repo (`agent-evidence-api/`) was **read only** — no file was modified, nothing was
  pushed, no branch was created.

## 10. Full list of URLs touched today

- `https://agent-evidence.thx93.dev/{mcp,weather/mcp,v1/evidence,v1/weather/alerts,v1/weather/forecast}` (probes, 200/402)
- `https://registry.modelcontextprotocol.io/v0/servers?search=Thx93` (200)
- `https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources` (200, 34-page scan)
- `https://402index.io/api/v1/{register,services/{id},categories,openapi.json}` (201/200)
- `https://api.x402dash.com/v1/{register,endpoints?q=agent-evidence}` (201/200)
- `https://x402-list.com/{api/v1/submit,api/v1/sponsor/weeks,pricing,llms.txt,openapi.json}` (201/200)
- `https://mcpcollection.com/api/submit` (201 ×2), `https://mcpcollection.com/server/{agent-evidence-api,nws-weather}` (404, pending)
- `https://mcp.tc/{submit,s/jEYzSu0F9YHJhm2A,s/SvSxF9_MH5Bi6RoU}` (303/200)
- `https://mcpub.dev/mcp` (200, `well_known_missing`), `https://agent-evidence.thx93.dev/.well-known/mcp.json` (404)
- `https://402.ad/submit` (410, retired)
- `https://mcp.directory/sitemap.xml` (200), `https://mcp.so/{submit,advertise,server/agent-evidence-api}` (200/200/404)
- `https://mcpmarket.com/{submit,search?q=agent+evidence}` (200)
- `https://tensorblock.co/mcp/servers/…` (200 SPA shell), `https://mcp-index.tensorblock.co/v1/…` (404/200)
- `https://glama.ai/mcp/connectors/io.github.Thx93/agent-evidence-api` (200)
- `https://mcpservers.org/servers/thx93/{agent-evidence-api,mcp-weather-server}` (200 via `r.jina.ai`)
- `https://github.com/{punkpeye/awesome-remote-mcp-servers/pull/2214, punkpeye/awesome-mcp-servers/pull/16911, cline/marketplace/pull/279, docker/mcp-registry/pull/5839, TensorBlock/awesome-mcp-servers/pull/{4090,4343,4344}, chatmcp/mcpso/issues/{5687,5688}, github/github-mcp-server/discussions/{3528,3529}}`
