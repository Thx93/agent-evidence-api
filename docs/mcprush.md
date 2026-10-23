# MCPRush: claim / publish / edit path, top-downloaded teardown, edit recommendations

**Report date:** 2026-10-23. **Check window:** 02:48–02:57 Asia/Riyadh (23:48–23:57 UTC, 2026-10-22).
**Scope note:** the original deliverable path (`agent-evidence-api/docs/mcprush.md`) is outside the writable
sandbox, so this file lives at `reports/mcprush.md` per the Lead's instruction. Nothing outside this file was modified.
**Money spent:** 0. **Accounts created:** 0. **Logins attempted:** 0. **Bot protection defeated:** 0.

### How these facts were obtained

| Channel | Status | Note |
|---|---|---|
| `curl https://mcprush.com/...` direct | **403** (Cloudflare "Just a moment…") | re-confirmed 02:48 |
| `curl https://r.jina.ai/https://mcprush.com/<path>` | **200**, rendered markdown | the only page-read channel used |
| `https://mcprush.com/robots.txt`, `/sitemap*.xml` | **200** direct | robots explicitly `Allow: /api/catalogue/` |
| `https://mcprush.com/api/catalogue/servers?...` | **200** only through `r.jina.ai` | public read API, 56,231 listings |
| `npx -y mcprush@latest --help` (npm 0.2.6) | **works** | install-side CLI only |
| `registry.npmjs.org` | **works** direct | package metadata |

**Honesty legend:** `[V]` = verified today, with the evidence quoted. `[I]` = inferred by me from the verified facts.
Nothing in the recommendations is claimed to have been tested — we have no account, so no edit was attempted.

---

## 0. Bottom line

1. **Our listings are unclaimed auto-imports and nobody can edit them without an account.** The whole catalogue is
   this way: of 56,231 live listings, **all 50 of the top-downloaded ones are also "Publisher not claimed"** `[V]`.
2. **Claiming is not login-first.** Step 1 is a proof file served from our own host, and the exact file path and
   today's token are published on an open page. Only Step 2 (publisher account) is login-gated `[V]`.
3. **The claim file already exists and contains a stale token** — a prior attempt left
   `mcprush.com-bb0130b229fe1d48a31fbb1c` on disk where today's page asks for `mcprush.com-1fc9eba42f879d96adddfbeb` `[V]`.
4. **Editing our npm package will never change the mcprush listing.** Their docs say source-read fields
   "stays editable and is never re-read" `[V]`. The listing text only changes through a claimed Studio edit.
5. **We cannot enter the Top 50 as currently configured.** The ranking counts npm/PyPI/Docker Hub package downloads
   only, and remote-URL-only servers are explicitly excluded `[V]`. Our two listings have `downloads: null` `[V]`.
6. **No review exists anywhere near the top** — only 3 listings in the entire catalogue have a rating `[V]`. First
   listing with real reviews in the `research` category stands out for free.
7. **Paid promotion exists but has no public price** (§11.5 of the terms): labelled "Promoted", head of the unfiltered
   catalogue or the home page, affects placement only, never grade or reviews `[V]`.

---

## 1. Claim, publish and edit: the exact mechanism

### 1.1 Claiming our existing listing `[V]`

Source checked: `https://r.jina.ai/https://mcprush.com/claim?s=agent-evidence-api-mcp` (200, 02:50), plus the claim
link printed on the listing page itself.

The link on `https://mcprush.com/thx93/agent-evidence-api-mcp` is
**`https://mcprush.com/claim?s=agent-evidence-api-mcp`**. The page, quoted:

> ## Claim Agent Evidence API MCP
> We found this project in public sources. Verify ownership to manage your listing, publish releases, view
> analytics, monetize and much more.
> **Step 1 · Verify ownership** — Domain: **agent-evidence-api.thx93.workers.dev**
> This address is on workers.dev, whose DNS belongs to the platform, so the proof is a file your server answers with.
> `https://agent-evidence-api.thx93.workers.dev/.well-known/mcprush.com-claim.txt`
> `mcprush.com-1fc9eba42f879d96adddfbeb`
> Serve it as plain text over HTTPS. One file can carry the lines for several listings.
> We read that one address and nothing else. Keep the file until we email you the decision — the reviewer reads it
> again — and delete it after that.
> **Step 2 · Publisher account** · **Step 3 · Track calls & Analytics**

There is a **"Check the file"** button on that page (present in the page HTML, 02:56), i.e. the file is re-read on
demand, not on a crawl schedule.

**Current state of the proof file (this is the blocker, and it is a literal file edit):**

| URL | HTTP | Body |
|---|---|---|
| `https://agent-evidence-api.thx93.workers.dev/.well-known/mcprush.com-claim.txt` | **200** `[V]` 02:52 | `mcprush.com-bb0130b229fe1d48a31fbb1c` |
| `https://agent-evidence.thx93.dev/.well-known/mcprush.com-claim.txt` | **200** `[V]` 02:56 | same worker, same file |

So the file route already exists on the worker (both hosts serve it) but carries a **different token** from the one
today's claim page prints. `[I]` Either a previous attempt used a token that has since been rotated, or the page
issues a fresh token per attempt. Either way: **replace the file body with the token the claim page shows at the
moment of claiming, then press "Check the file"** — do not reuse `bb0130…`.

The claim page source domain is `agent-evidence-api.thx93.workers.dev`, **not** `agent-evidence.thx93.dev` the
listing's quickstart advertises. Both return the same service payload `[V]` (`{"service":"agent-evidence-api","version":"0.1.6",…}`),
so a route added on the worker is readable at both names.

**Steps 2 and 3 render no content before Step 1 passes** `[V]` (the HTML after "Step 2 · Publisher account" is empty
until verification), so the account creation and analytics steps are **login-gated and unverified from here**.

**Review latency:** "A person reads each listing you submit within two working days" (`/for-publishers`) `[V]`; a file
claim says "until we email you the decision".

### 1.2 Other accepted proofs of ownership `[V]`

Quoted from `/docs` (publishing section): proof is "the same ways a listing is claimed: sign in with GitHub, a
verification file in the repository, a token in the package release, or your domain."

- **GitHub role:** sign in; they check owner/admin/maintainer "once, keep no access, and change nothing in your
  repository" (this is the method `/claim?s=weather-mcp` demands — see 1.6).
- **Token in the package release:** observed in the wild on npm — `@letoribo/mcp-graphql-enhanced` and
  `@agentbadge/mcp` carry descriptions of the form `mcprush-claim-<slug>-<hex>` `[V]` (npm registry, 02:53).
  `[I]` That is the "token in the package release" proof in its packaged form, which matters for us because we own
  `@thx93/x402-evidence` and `@thx93/mcp-weather-server` — a claim token could be published there instead of, or
  alongside, the worker file.
- **Domain file** (what our evidence listing is bound to).

### 1.3 Publishing a new listing, or editing one: account-gated `[V]`

From `/docs` (Publishing, 10 entries) and `/for-publishers`:

1. **Studio** → `https://mcprush.com/studio` → **New MCP Server** → pick **MCP server** (or **Agent skill**).
2. **Choose your source:** Git repo · npm · PyPI · Container · Hosted URL.
3. **Hosting and connection:** **You run it** or **We host it**.
4. **Create your listing** → **Set your pricing** → **Prove ownership**.
5. **Review and submit** → **Submit for review**. "Nothing is public yet." Decision by email and in Studio; "We don't
   review later releases."
   Common rejection reasons: description not matching the tool, wrong reach, text about another product, an
   unmentioned write. Final and non-appealable: "a description that tells the model to do more than the tool does."

Required content, quoted from the FAQ: "A name, a one-line description, and a paragraph of at least 120 characters on
what it does and who it is for." For a server you host yourself: "an HTTPS endpoint that accepts only our token — you
verify it in the wizard before submitting." Pricing needs "at least one plan with a name, monthly price and call
allowance" (plans are **$5–$999/month**; `$0` = free). Stripe Connect is needed only to be paid.

**Publisher API is read-only** `[V]`: Studio → API keys → `mrp_live_…` (save as `MCPRUSH_PUB_KEY`), and the documented
endpoints are `GET /api/pub/whoami`, `GET /api/pub/listings`, `GET /api/pub/calls`. **There is no documented write,
publish, claim or edit endpoint**, so no programmatic edit path exists.

### 1.4 What is gated and what is not

| Action | Gated by | Verified |
|---|---|---|
| Read any listing page, catalogue, security report, Top 50 | nothing | `[V]` |
| Read public API `GET /api/catalogue/servers` (q, cat, sort, per≤25, ≤500 depth / 23 pages) | nothing (robots `Allow`) | `[V]` |
| Install a listing into a client (`claude mcp add …`, `npx mcprush@latest add`) | nothing for our direct listings; gateway listings need a key | `[V]` |
| **Write the claim proof file on our host** | nothing — we control the host | `[V]` |
| **Press "Check the file"** | nothing to read; open on the claim page | `[V]` (button present) |
| **Create/sign in publisher account (Claim Step 2, Studio)** | email or OAuth sign-in — **login-gated** | `[V]` that it is required; steps themselves not rendered |
| **Edit name/description/tools/pricing/category** | claimed listing + Studio — **login-gated** | `[V]` (Studio is inside the account) |
| Submit a new listing | Studio — **login-gated** | `[V]` |
| Buy promotion / set plans | Studio + Stripe — **login-gated, costs money** | `[V]` that it exists; price unpublished |
| Catalogue MCP (`https://mcprush.com/mcp`, tools `search_servers`, `get_server`, `list_categories`, `search_skills`, `install_command`) | "Buyer key only" — **login-gated** | `[V]` (listing page for `mcpdevpro/mcprush-catalogue`) |

### 1.5 Does editing the registry entry change the mcprush listing? **No.** `[V]`

`/docs`, Git-source section, quoted exactly: **"Every field stays editable and is never re-read. We still re-scan the
repository for the security grade and notice if it is archived, renamed or deleted."**

What the import reads in the first place (`/docs`):
- **npm:** `registry.npmjs.org/<package>/latest` — "name, description, keywords, version, `mcpName`" — then the GitHub
  repository it names. "The tarball is never downloaded."
- **Git:** GitHub at HEAD of the default branch; manifest is the first valid of `server.json`,
  `.well-known/mcp/server.json`, `mcp.json`, `.mcp.json`, `server-card.json`, `package.json`.
- **Container:** only `registry.modelcontextprotocol.io`, matched on the image name; its `server.json` fills the fields.

Recrawl-ish cadences that **do** run `[V]`:
| Thing | Cadence | Source |
|---|---|---|
| Top 50 registry read | once a day, UTC morning (page says "registry read, 21 Oct 2026") | `/top-50-mcp` |
| Tool list re-read / re-grade | "about once a month" | listing Security tab |
| README badge detection | when the studio opens, and once a day | `/docs` |
| Endpoint revalidation GET | "about every 6 days from `mcprush-revalidate/1`" | `/docs` |
| Listing text/fields | **never re-read after creation** | `/docs` |

`[I]` Consequence: fixing `@thx93/x402-evidence`'s description or bumping it to 0.1.7 will *not* touch the mcprush
listing. The stale strings can only be replaced by a claimed edit.

### 1.6 The weather listing is a separate, harder case `[V]`

- `https://mcprush.com/thx93-2/weather-mcp` = our server: `[GitHub](https://github.com/Thx93/mcp-weather-server)`,
  3 tools, `v1.1.3`, category `lifestyle`, "Paid per call" in the tagline.
- `/claim?s=weather-mcp` resolves to a **different** listing: "Repository: **github.com/weather-mcp/weather-mcp** …
  Sign in to verify automatically that you're the repository owner, admin, or maintainer." That is not our repo, so
  that claim is not ours to make.
- The weather listing's own page does not print a claim link in the rendered markdown `[V]` (only the evidence listing
  does). `[I]` For weather the route is therefore Studio/publisher signup + GitHub proof on `Thx93/mcp-weather-server`,
  or the npm-package-token proof, not the worker file.
- **Weather has no grade at all**: page says "not scanned / — trust score", API says `grade: null, gradeBasis: null`,
  while the evidence listing is `grade: A / gradeBasis: tool-list / 93` `[V]`. `[I]` The tool-list grade is computed
  when the server is next asked for `tools/list` (~monthly), so this is a waiting gap, not an error.

### 1.7 How new servers get added — no trigger available to us `[V]`

- Our listing footer: **"Collected from a public index."** No import button, no submit form reachable; `https://mcprush.com/submit`
  is **404** ("Nothing at that address"), `/publish` 404, `/signup` = "Create a Free Account".
- The catalogue holds a publisher literally named `smithery` (e.g. item `Rencosta2025 Context7fork`, `pub: "smithery"`),
  and publishers named after hostnames (`mcp.context7.com`) `[V]` → `[I]` the "public index" is several third-party
  indexes (Smithery and similar) plus domains and GitHub repos, not one registry.
- The only self-service route is the account-gated wizard in 1.3. There is **no unauthenticated way to add, edit,
  correct or claim** a listing — the only unauthenticated lever is "Report this server" / "Report an issue"
  (`/contact?about=legal`).

---

## 2. Top-50 teardown: what the highest-downloaded listings do that ours does not

### 2.1 The ranking rules, quoted `[V]` (`/top-50-mcp`, 02:49)

> "Only registry downloads count. The number beside each server is the figure npm, PyPI or Docker Hub reports for its
> package. Nothing MCPRush measures on its own site — page views, reviews, ratings — has any part in the order."

Excluded from the ranking, quoted: **"Remote servers reached by URL, which have no package to count"**, packages
several listings point to, general-purpose SDKs/proxies (MCP SDK, FastMCP, mcp-remote), **servers MCPRush builds from a
package and runs on its own hosting**, platform builds, GitHub-release downloads, deprecated listings. Top 50 is MCP
servers only (skills have their own catalogue); rebuilt once a day, UTC. "Can a publisher pay for a higher place? No."

Also `[V]`: **the catalogue's default order differs from the Top 50.** Terms §11.3: default order is (a) package
downloads in the last day, then (b) "how many separate readers opened the listing page over the preceding 30 days,
counted once per reader per day", then (c) address. So page views are a real secondary signal in the catalogue even
though they are explicitly not used in the Top 50. `[V]` discrepancy worth knowing: §11.3 also lists "GitHub releases"
as a download source while `/top-50-mcp` says files from GitHub releases are not counted.

### 2.2 Today's leaders (read 02:49, "registry read, 21 Oct 2026")

| # (today) | Listing | Package · registry | Downloads/day | All-time | Tools | Versions | Reviews | Verified |
|---|---|---|---|---|---|---|---|---|
| 1 | Firebase Tools / firebase | `firebase-tools` · npm | 394,294 | 89,264,464 | not listed | 10 | 0 | **not claimed** |
| 2 | Chrome DevTools / ChromeDevTools | `chrome-devtools-mcp` · npm | 277,719 | 62,912,788 | not listed | 6 | 0 | **not claimed** |
| 3 | Browser Use / browser-use | `browser-use` · PyPI | 200,826 | 371,707,901 (all-time #1) | 17 | 3 | 0 | **not claimed** |
| 6 | Color Space / colorjs | `color-space` · npm | 68,912 | 48,783,697 | 10 | 3 | 0 | **not claimed** |
| 21 | Supabase / Supabase | `@supabase/mcp-server-supabase` · npm | 12,847 | 4,512,604 | not listed | 3 | 0 | **not claimed** |
| — | **Agent Evidence API (ours)** | **none — `downloads: null`** | **null** | **null** | 3 | **1** | **0** | **not claimed** |
| — | **Weather (ours)** | **none — `downloads: null`** | **null** | **null** | 3 | 3 | **0** | **not claimed** |

Their install lines vs ours `[V]`:
- `npx -y firebase-tools mcp` · `npx -y chrome-devtools-mcp` · `npx -y color-space mcp` · `npx -y @supabase/mcp-server-supabase`
- ours: `claude mcp add --scope user --transport http agent-evidence-api-mcp https://agent-evidence.thx93.dev/mcp`

### 2.3 Nine differences that repeat across the top listings

1. **A countable package.** Every leader's listing links an npm/PyPI package; ours links none (`downloads: null`).
   This is the single reason none of ours can be ranked `[V]`.
2. **One-line tagline, ~72 chars mean, keyword-dense, one sentence.** Measured on the 21 catalogue cards `[V]`:
   mean 72 chars, range 30–99. Pattern: *capability + concrete surface*, e.g. "Verified conversions across 205 color
   spaces: CSS strings, gamut checks, .cube LUTs" (83), "Open-source SEC EDGAR toolkit — 13 tools, 7 prompts, every
   filing type. No API key required." (92). Ours is 90 chars but spends 45 of them on a **stale price** (`$0.003`).
3. **Concrete, checkable numbers in the copy:** "205 color spaces", "13 tools, 7 prompts", "7 languages and 3
   container backends", "114 tools". Ours has "3 tools" only in the metadata, and "0.1.0" in a tool description.
4. **Version cadence is visible.** Versions tab: Firebase 10, Chrome DevTools 6, Color Space 3, Supabase 3; ours: **1**
   (evidence, `0.1.6`, "No release note was published with this version") and 3 (weather). `[I]` A single
   undated version with no release note reads as abandoned next to a 10-version history.
5. **Rich tool descriptions with units, ranges and examples.** Color Space's `convert` names its ranges
   (`rgb 0-255, oklch L 0-1 …`); the tool names are one short verb (`convert`, `gamut`, `css`, `cube`, `icc`, `shader`).
   Ours: `research_evidence` (good), `sample`, `health` (fine), but the parameter note says **"Version 0.1.0 requires
   at least one such URL"** on a listing that displays v0.1.6 `[V]`.
6. **Concrete trust numbers on the page.** Leaders show "394k downloads a day", "13.47M downloads in 30d", trust score
   93–100. Ours shows "— calls last 7d", no downloads, `installs: 0` `[V]`.
7. **Pricing reads "Free" either way, so price is not the differentiator at the top** — all five leaders are Free
   `[V]`. Our listing's "Free" is fine for installs; the paid story has to live in the copy (see §3.4).
8. **Reviews are not a moat yet: the leaders have zero.** Only **3** listings in 56,231 have a rating `[V]`; the
   listing page states the only requirements are a signed-in account that does not publish the listing. `[I]` First
   reviews in `research` are cheap differentiation — but we cannot write them ourselves without accounts, and
   manufacturing them is explicitly a terms ground for removal (§11.6 + §10.1(h)).
9. **Category choice matters for browse reach.** Ours sits in `research` (1,947 listings) — appropriate; weather sits in
   `lifestyle` ("Lifestyle & Local") `[V]`. The catalogue also has `web` (Web, Search & Scraping, 1,375) and `data`
   (923), which `[I]` would fit the evidence API's actual job better for query-driven discovery than `lifestyle` does
   for weather.

### 2.4 Market context for expectations `[V]` (API summary, 02:51)

`total 56,231` live server listings · `free 56,215` · `subscription 23` · `verified 228` · `rated 3`.
Run modes: remote 27,411 · local 27,135 · both 1,685. Auth: none 42,036 · API key 8,714 · OAuth 5,481.
`installs` is **0 for every listing I sampled, including the leaders** `[V]` → `[I]` the public install counter is not
populated, so "installs" is not a reachable goal; downloads and page views are.

### 2.5 ⚠️ Terms constraint on how we study this `[V]`

Terms §12.2: "Taking the catalogue in bulk is a breach of these terms — scraping the pages, automating a browser
against them, or collecting the listings, their prices or their publishers by any other means." The public API is
explicitly allowed in `robots.txt` and is capped at 500 records / 23 pages, which reads as an intended allowance for
small reads, but **we should not build any pipeline on harvesting catalogue data, and should not automate a browser
against mcprush**. This report used a handful of single-item and one-page API reads only.

---

## 3. Recommended edits — copy-paste ready

Everything below is `[I]` (a recommendation grounded in the `[V]` facts above). Nothing here has been applied: it
requires a claimed listing in Studio.

### 3.1 Agent Evidence API (`https://mcprush.com/thx93/agent-evidence-api-mcp`)

| Field | Now (verified) | Recommended |
|---|---|---|
| Name | `Agent Evidence API` | **keep** `Agent Evidence API` (page H1 renders as "Agent Evidence API MCP", which already matches the leaders' "<Name> MCP" pattern) |
| Tagline (≤100 chars) | "Cited web evidence and claim verification for AI agents. No API key: $0.003 USDC per call." (90) | **"Cited web evidence for agents: fetch sources, quotable excerpts, supported/contradicted verdicts."** (97) |
| Extended description (≥120 chars required) | none visible (What-it-does = the tagline) | see block below |
| Category | `research` | **keep `research`** (1,947 listings); optionally also surface under `web` if the wizard allows a second category `[I]` |
| Tags | `[]` | none to set — the API's `tags` are derived (`['developer-tools','npm']` style), not free text `[V]`; no action |
| Price display | Free, "mcprush charges nothing for it, ever" | **keep Free** on mcprush, and state the x402 price in the copy (3.4) |
| Tool descriptions | `research_evidence` param note says "Version 0.1.0 requires at least one such URL" | replace with the 0.1.6 truth (block below) |
| Release note | "No release note was published with this version." | add a one-line note per release from now on |

**Extended description (copy-paste, 792 chars):**

> Agent Evidence API answers "is this claim true, and what supports it?" — not "here are ten links". Send a question
> or a claim with optional candidate URLs; the server fetches those public pages, records publisher, retrieval
> timestamp and content hash for each, extracts the passages that bear on the claim, and returns a structured package:
> per-source cited excerpts, document metadata, and an explicit assessment of supported, contradicted, mixed or
> inconclusive. Built for research agents, fact-checking pipelines and any answer that has to show its work. Free
> `sample` tool returns a real, previously produced package so you can inspect the exact shape before paying; `health`
> reports the running service version. No account, no OAuth, no key: pay per call in USDC via x402 on Base, $0.01.

**Tool description replacements (copy-paste):**

- `research_evidence` — "Fetch public web sources and return a structured, cited evidence package for a question or
  claim: per-source URLs, retrieval timestamps, content hashes and quoted excerpts, plus an explicit
  supported/contradicted/mixed/inconclusive assessment. Use for claim verification, source comparison and
  source-grounded research. Paid per call ($0.01 USDC, x402 on Base); `urls` is optional in 0.1.6 — omit it to let the
  service pick sources." *(removes the false 0.1.0 constraint, keeps the `openWorldHint`-consistent wording that the
  grader already rewarded)*
- `sample` — keep; add "…always the same package, no payment, no arguments — call it first to see the schema."
- `health` — keep; "Free, no arguments, returns only {status, service, version}."

### 3.2 Weather (`https://mcprush.com/thx93-2/weather-mcp`)

| Field | Now (verified) | Recommended |
|---|---|---|
| Tagline (≤100) | "US weather for AI agents: active NWS alerts by state, 5-period forecasts by lat/lon. Paid per call." (99) | **"US weather for agents: NWS alerts by state, 5-period forecasts by lat/lon. No API key."** (86) |
| Category | `lifestyle` ("Lifestyle & Local") | **try `data` (Databases, 923) or `web` only if the wizard permits**; keep `lifestyle` otherwise `[I]` |
| Grade | `null` / "not scanned" | nothing to edit — `[I]` it arrives on the next monthly `tools/list` read; the evidence listing got its A/93 that way |
| Tool descriptions | "Get weather alerts for a state" / "Get weather forecast for a location" | expand with NWS specifics: "Active NWS alerts for one US state (two-letter code, e.g. CA). Returns alert id, event, severity, onset/ends, areas and the NWS instruction text." / "Five-period NWS forecast for a latitude/longitude (e.g. 39.7456,-104.9833). Returns period name, start time, temperature and unit, wind, short forecast and detailed text." |
| Third tool | `health` counted in the 3 | keep — the leaders' tool counts are not penalised for a health tool |

### 3.3 Three things to do that plausibly move reach, in order

1. **Make each listing point at its own npm package so a download figure exists.** We already own
   `@thx93/x402-evidence` and `@thx93/mcp-weather-server`; today both listings show `downloads: {day: null, total: null}`
   `[V]`. Re-pointing the source to the npm package (source = npm, hosting = "You run it" so the endpoint stays ours)
   is the only way into the download-sorted catalogue order and the Top 50 `[I]`. Watch two documented exclusions:
   the package must belong to exactly one listing, and hosts built by MCPRush hosting are not credited.
   Do **not** create a second listing for the same package — "packages that several listings point to" are dropped.
   Also note the docs' warning that an npm source whose package shows "No `bin` and no other sign of MCP" gets
   "This does not look like an MCP server".
2. **Claim both, then fix the copy — including the price lie.** `$0.003` is wrong twice over: it is stale and it does
   not match $0.01 `[V]` (task-2 context; not re-verified in this report). A wrong price in a tagline is the kind of
   thing the human reviewer rejects listings for ("a description that doesn't match the tool") `[V]`.
3. **Ship visible version cadence and one release note per release.** 1 version with no note vs 10/6/3 on the leaders `[V]`.
   Each bump also re-triggers the tool-list diff surface the Security tab advertises.

### 3.4 Where the price should live (because mcprush cannot express ours) `[V]`

mcprush's only paid shape is a **monthly plan, $5–$999, with a call allowance, billed by Stripe** (`/for-publishers`,
`/docs`, terms fee table). There is no per-call price and no x402 anywhere in their docs. Our listing therefore
renders as **Free — "$0 forever … mcprush charges nothing for it"**, which is accurate for mcprush. So:
keep the listing Free, and put the x402 price in the tagline tail or the extended description as a statement of fact
("pay per call in USDC via x402 on Base, $0.01"), never as an mcprush plan. `[I]` Do not attempt to publish a $5/month
plan: per-call billing would then be double-charged and their gateway would have to be in the path, which the listing
currently and deliberately avoids ("this marketplace is not in the path").

---

## 4. Paid promotion and every cost on mcprush

| Item | Price | Verified |
|---|---|---|
| Listing a server or skill | **free** — "There is no listing fee, and a free listing costs nothing at all." | `[V]` terms §7.2, `/for-publishers` |
| Platform fee on sales | **12% of net** (publisher keeps 88%; 85.1% after card fees) | `[V]` terms §7.2/§7.3 |
| Card processing | 2.9% + 30¢ per charge, to Stripe | `[V]` |
| Disputed charge | $15, won or lost | `[V]` |
| Publisher plans you may charge | you set name + monthly price, **$5–$999**, + call allowance | `[V]` `/for-publishers` |
| Buyer account plans | Free · **Pro $9/mo** (3 seats, then $3/seat) · Enterprise by quote | `[V]` `/pricing` |
| **Promoted placement** | **exists; price is not published anywhere I could read** | `[V]` that it exists |

**Promoted, quoted from the terms (§11.5):** "A listing may be placed for payment at the head of the unfiltered
catalogue or on the home page. It is labelled **Promoted**, appears once, and is not pinned once a reader filters or
searches. Promotion changes where a listing is shown, never its grade or its reviews."
The catalogue API carries a `promoted` boolean per listing; **it is `false` on our two and on every listing I sampled,
including all 21 cards of the trending page** `[V]`. No price appears on `/pricing`, `/for-publishers`, `/docs` or the
terms fee table `[V]`. `[I]` It is probably quoted in Studio after an account exists, or by mail
(`support@mcprush.com`). **Not purchased, not requested.**

Also worth knowing, since it is the only other lever money can buy there: the Top 50 FAQ says outright "Can a
publisher pay for a higher place? No." — so promotion buys a card slot, never rank.

---

## 5. Login-gated and money-gated — what I could not verify

| Question | Why unverified |
|---|---|
| What Claim Step 2 asks for (email code vs GitHub vs Google) | content not rendered before Step 1 passes |
| Whether Studio allows editing **tool descriptions / tool names** by hand | behind sign-in; docs do mention "Enter the tools by hand" when a manifest is not where they looked, so it is plausible `[I]` |
| Whether a claimed listing can be moved from `lifestyle` to `data` | behind sign-in |
| Whether re-pointing the source to npm changes `delivery: direct` or the endpoint | behind sign-in; `[I]` documented as separate concerns (source vs "You run it") |
| Promoted placement price and slot availability | unpublished; needs Studio or support@mcprush.com |
| Any write/claim API | not documented; the publisher API is explicitly read-only `[V]` |
| Whether the reviewer re-read takes >2 working days in practice | needs a real submission |
| `/api/catalogue/servers?q=` is fuzzy OR-search, not exact | observed: `q=agent-evidence-api` returned 995 results `[V]`; fine for lookups, useless for exact counts |
| `epv` (endpoint-verified) flag disagreement | the listing page prints "Endpoint verified" but the API returns `epv: false` for our listing `[V]`; I did not resolve which field the page reads, so treat "endpoint verified" as page-level only |

---

## 6. Exact next actions (for whoever owns the write scope)

1. **Swap the claim token** in the worker's `/.well-known/mcprush.com-claim.txt` to the value the claim page prints
   **at that moment** (today: `mcprush.com-1fc9eba42f879d96adddfbeb`; on file: `mcprush.com-bb0130b229fe1d48a31fbb1c`),
   confirm HTTP 200 on both `agent-evidence-api.thx93.workers.dev` and `agent-evidence.thx93.dev`, then open
   `https://mcprush.com/claim?s=agent-evidence-api-mcp` in a browser and press **"Check the file"**.
   Keep the file until the decision email arrives; delete it after.
2. **Create the publisher account** (this is the first thing that needs a human and a login) and complete the claim.
   The same account then also has to claim `thx93-2/weather-mcp` — via GitHub role on `Thx93/mcp-weather-server`,
   since its claim page wants a repo proof, not a domain file.
3. After the claim: open Studio → the listing → replace tagline + extended description (§3.1/§3.2), fix the
   `Version 0.1.0` parameter note, add a release note, and set the source to the npm package (§3.3 item 1).
4. Independently, and cheap: add the `mcprush` README badge — the badge appears "for every MCP server, from the moment
   you submit it" and "It updates itself", and clicks on it show in Studio as "From your badge". It needs the listing
   id, which we already have: `agent-evidence-api-mcp` and `thx93-weather-mcp` `[V]`.
   `[I]` Badge reads count as "readers opened the listing page"? Not stated — they are counted separately as
   *From your badge*; the catalogue tiebreaker is page readers, so the badge helps indirectly at best.
5. Do **not** write reviews from the same account, and do not seed them: §10.1(h) plus the review rules make
   manufactured signals a removal ground `[V]`.

---

## 7. Source table (every fetch, with time)

All times 2026-10-23, Asia/Riyadh (UTC+3), i.e. 2026-10-22 evening UTC.

| # | URL | Time | Result |
|---|---|---|---|
| 1 | `r.jina.ai/https://mcprush.com/for-publishers` | 02:48 | 200, 10,630 B |
| 2 | `/docs` | 02:48 | 200, 53,919 B |
| 3 | `/pricing` | 02:48 | 200, 15,832 B |
| 4 | `/signin`, `/signup` | 02:48 | 200 (signup: "Create a Free Account") |
| 5 | `/claim` (no `s`) | 02:48 | 200, "Nothing to claim here" |
| 6 | `/submit`, `/publish` | 02:48 | **404** ("Nothing at that address") |
| 7 | `/thx93/agent-evidence-api-mcp` | 02:49 | 200, full listing |
| 8 | `/thx93-2/weather-mcp` | 02:49 | 200, full listing |
| 9 | `/top-50-mcp` | 02:49 | 200; **tables are client-JS-free HTML** — parsed 2×51 rows |
| 10 | `https://mcprush.com/robots.txt` | 02:49 | 200 direct, 105 lines, `Allow: /api/catalogue/` |
| 11 | `/sitemap.xml` → `sitemap-servers-1.xml` (5.16 MB), `sitemap-publishers-1.xml` (3.71 MB) | 02:50 | 200 direct; our entries found |
| 12 | `/api/catalogue/servers?sort=downloads` | 02:51 | 200 via jina; JSON, facets, 56,231 total |
| 13 | `/api/catalogue/servers?q=agent-evidence-api`, `?q=weather-mcp`, `?q=context7`, `?q=thx93`, `?q=smithery`, `?sort=installs` | 02:52 | 200; per-listing JSON |
| 14 | `/firebase/firebase-tools-mcp`, `/chromedevtools/chrome-devtools-mcp`, `/browser-use/browser-use-mcp`, `/colorjs/color-space-mcp`, `/supabase/supabase-mcp` | 02:50 | 200, five full listings |
| 15 | `/claim?s=agent-evidence-api-mcp`, `/claim?s=weather-mcp` (+ HTML variant) | 02:50, 02:56 | 200; token `1fc9eb…` requested; "Check the file" button present |
| 16 | `https://agent-evidence-api.thx93.workers.dev/.well-known/mcprush.com-claim.txt` and same on `agent-evidence.thx93.dev` | 02:52, 02:56 | **200**, body `mcprush.com-bb0130b229fe1d48a31fbb1c` |
| 17 | `/thx93`, `/thx93-2` publisher pages | 02:53 | 200; 0 installs, 0 followers, "not claimed" on thx93 |
| 18 | `/catalog` (HTML) | 02:52 | 200; embedded JSON (pinned, items, facilities), sort options `added/installs/new/price`, `promoted:true` count **0** |
| 19 | `/` homepage, `/terms`, `/mcp`, `/mcpdevpro/mcprush-catalogue` | 02:54–02:56 | 200; terms §7, §11.3, §11.5, §12.2 quoted |
| 20 | `npx -y mcprush@latest --help` (npm `mcprush@0.2.6`) | 02:53 | install-side commands only; no publish/claim |
| 21 | `registry.npmjs.org/-/v1/search?text=mcprush`, `/mcprush/latest` | 02:53 | `mcprush 0.2.6`; two packages carrying `mcprush-claim-…` proofs |

Long page dumps are kept in `/tmp/mcprush/`, not in the repo.
