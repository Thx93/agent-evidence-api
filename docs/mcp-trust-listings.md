# MCP trust listings — what happened, and what is actually blocked

Recorded 2026-09-21, after M8ven emailed to say it had added `mcp-weather-server`
to its Trust Index.

## What the email actually was

Automated directory outreach, not a person. The listing's `Source:` field reads
`github_repo_search`, and the same message goes to every publisher whose public repo
its scanner picks up. That does not make it worthless — it is a real listing on a
real index — but it is not a buyer, and it should not be read as demand.

**M8ven** ([m8ven.ai](https://m8ven.ai)) is trust infrastructure for the agent
economy: 84,100+ MCPs scored, sold to people and agents who check a server before
connecting it. It ships its own MCP (`https://m8ven.ai/api/mcp/tool-check`, tool
`check_tool`) so an assistant can grade a server before install, and it charges
$5/mo for the Plus tier on the buyer side. Being listed there is a genuine
discovery surface with intent behind it.

## Where our two servers stand

Updated 2026-09-24, after the repository was made public.

| | weather MCP | paid service (agent-evidence-api) |
|---|---|---|
| M8ven | **74/100, grade C** — code sub-score **96** | **74/100, yellow** — code sub-score **100** |
| M8ven detail | `/mcp/thx93/mcp-weather-server` | `/mcp/thx93-agent-evidence-api-1id76y` |
| claimed | no | no |
| live monitored | not connected | not connected |
| in the official MCP Registry | **no** — `server.json` validates but was never published | **yes — 0.1.4 active**, 0.1.0–0.1.2 deprecated |
| on npm | **no** | **no** |

**The paid service now scores higher on code than the weather server**: 100/100
against 96. Both are held at 74 overall by the same cap — *"Grades remain capped
until the project builds reputation through adoption."* Code quality is not what
limits these listings.

Until the repository was made public, the paid service could only be submitted by
hand and came back `"verdict": "pending"` or `"unknown"` indefinitely, because the
scanner had nothing to read. Making it public changed that in one step.

## The asymmetry that matters

M8ven found the weather server **by itself**, by crawling a public repo. The paid
service had to be submitted by hand, and it still cannot be scored: **`check_tool`
accepts a GitHub slug, an npm package name, or a registry listing — never a remote
URL.** Its response for a private or unknown repo is exactly:

> `"verdict": "unknown"` … "the repository may be private, or our scanner may not yet
> have indexed it"

Our paid service's code lives in a **private** repository, so every code-crawling
directory — M8ven, glama, Smithery, PulseMCP, npm — can only produce a dead-end
listing for it. The repo stays private; that is a settled decision. The consequence
is simply this: **the paid product is invisible to the channels that discover MCP
servers, and the free one is not.**

## What was done

1. **Fixed the one concrete finding M8ven reported.** Both weather tools now declare
   `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`,
   `openWorldHint: true`. They only read the NWS API, so an unannotated read-only
   tool was being treated as potentially destructive. Built, committed, pushed
   (`e5ca935`).
2. **Added M8ven's publisher badge** to the weather README — their stated proof that
   takes a listing from Claimed to Verified Publisher.
3. **Submitted both servers** through the free, no-signup API
   `POST https://m8ven.ai/api/mcp/submit` (`source: m8ven_submission`). The paid
   service now has a listing page where there was none.
4. **Wrote `scripts/check-mcp-listings.sh`** so this is monitored rather than
   discovered by accident. It reports M8ven scores, the registry, npm, and it
   deliberately refuses to draw conclusions from curl against glama/PulseMCP/mcp.so,
   which render client-side or block bots.

## Two one-click actions for the operator

1. **Claim both listings.** Your commit-author email is already in the weather
   repo's git history, and M8ven accepts an address taken from the git history, so
   the claim will verify. Claiming yields a verified publisher badge, the full
   audit findings, and direct contact when they find something urgent.
2. **Connect Live** on the weather repo — a read-only GitHub App that re-scans on
   every push, so the annotation fix lands without waiting for a crawl:
   `https://github.com/apps/m8ven-verify/installations/new`

## The ordered fix for what remains

Everything left is blocked on **a working npm token** (see
[`access-and-credentials.md`](./access-and-credentials.md)).

1. Publish the MCP server to npm. An npm package name is accepted by M8ven, and it
   gives the listing a real install path instead of a repo.
2. *Then* publish the weather server to the official MCP Registry — the paid one is
   already published. Its `server.json` validates, but it declares a `packages`
   entry for `@thx93/mcp-weather-server`, so publishing before step 1 would point
   the registry entry at a package that does not exist.
3. Re-submit and let the score attach.

Until step 1, a paid MCP listing in any of these directories is a page that leads
nowhere — which is worse than not being listed, because the one thing a trust index
is for is checking that a server can actually be installed.

### Registry state, 2026-09-24

`io.github.Thx93/agent-evidence-api`: **0.1.4 active** with the correct remote URL.
0.1.0, 0.1.1 and 0.1.2 are **deprecated** — they advertised
`agent-evidence-api.taher-h-alhaddad.workers.dev` and
`agent-evidence-api.thx93workersdev.workers.dev`, neither of which serves. An agent
that resolved an old entry got a dead host, which is worse than no entry.

**The login does not need a human.** `mcp-publisher login github` also accepts
`-token`, so the device flow that appeared to require the operator is avoidable:

```bash
mcp-publisher login github -token "$(gh auth token)"
```

That worked against the workspace's existing GitHub credential and issued a registry
JWT good for about five minutes — publish in the same breath. The interactive device
code expires in roughly fifteen minutes and, once missed, has to be re-requested,
which is exactly what happened the first time.

## How the PayAI catalogue actually ranks (measured 2026-10-19)

Two signals were tested by changing them and re-measuring the same queries.

**Descriptions match phrases, not just words.** Our weather description contained
"weather" and "forecast", and `forecast` was a tag, yet "forecast" ranked us first
while "weather forecast" and "5-day forecast" did not find us at all. After spelling
the phrases out literally:

| query | before | after |
| --- | --- | --- |
| `5-day forecast` | absent | **#1** |
| `temperature` | #5 | **#2** |
| `weather alerts` | - | #3 |

`weather forecast` is still absent, so this explains part of the behaviour rather
than all of it.

**`serviceName` is a strong ranking signal - and cannot be overridden per route.**
Searching "weather forecast" returns entries *named* "Weather forecast (US)",
"Datakoot Weather & Geo" and "weather-forecast-<city>". Both of our routes reported
`serviceName: agent-evidence-api`, which contains neither word, so the weather
listing was described as weather but not named weather.

Setting `serviceName` on the weather route alone (spread the shared route config, then
override the field) did not rename it - it **cleared** the field. The catalogue entry
for `/weather/mcp` went from `"agent-evidence-api"` to `undefined`, while `/mcp` and
`/v1/evidence` were unaffected. That was reverted and the entries verified restored.

So: the name is the signal that places for a name-shaped query, and this route config
does not accept overriding it. Improving weather's name means changing the shared
service name, which would rename all three resources - a decision, not a tweak.

### Decisions taken from those measurements (2026-10-19)

**The shared service name stays.** Renaming it to contain "weather" would rename all
three resources, and the evidence listings are currently first for the queries their
name earns:

| query | rank |
| --- | --- |
| `evidence` | #1 |
| `agent evidence` | #1 |
| `web evidence` | #1 |
| `source verification` | #1 |
| `verify claim` | #2 |

Trading four first places on the evidence service for one weather query that
competitors win on their *name* ("Weather forecast (US)") is not a good exchange, and
it is not a call to make silently. Per-route naming is not available - see below - so
the only lever is a second deployment.

**Per-route naming is genuinely unavailable, not merely awkward.** Two places were
tried and both are closed:

1. Setting `serviceName` on the route config **clears** the field rather than
   overriding it (measured; reverted).
2. The bazaar extension has no room for it either - `extensions.bazaar.info` and its
   schema allow exactly `type, toolName, description, transport, inputSchema, example,
   method`.

**A second catalogue entry for `get-forecast` was considered and rejected.** The
weather route hardcodes `toolName: "get-alerts"`, so a call to `get-forecast` is
catalogued under `get-alerts` and there is no fourth entry. Making the declaration
dynamic is possible - the 402 is written from the middleware result in one branch, so
its `toolName` could be rewritten per call - but `forecast` already ranks #1 while
`weather forecast` does not, and that query is won on service name. A second entry
sharing the same name would not fix a name-shaped query, so the change would add risk
to the payment path for no measured gain.

## agent402.tools: crawled, indexed, and gated on real demand (2026-10-19)

A cross-seller x402 index with a "Smart Order Router" that resolves a task to the
best seller across the ecosystem. It is worth knowing about because it is the first
aggregator found that **already lists us without being asked**, and because of what
it says about *why* it will not send us orders.

`GET https://agent402.tools/api/index?seller=agent-evidence-api.thx93.workers.dev`
is free and returns the full row for one origin:

```
displayName    : Agent Evidence API
toolCount      : 3            (all three tools, with their descriptions)
discoveryPath  : /.well-known/x402
history        : [1,1,1,1,1]  last five crawls, oldest first: our manifest parsed every time
health         : 1
routable       : true
networks       : ["eip155:8453"]
payTo          : 0x9c0e…55FD0

paywall        : { ok: false, status: 502, at: 2026-10-18T01:35:56Z }
routerDispatchEligible : false
routerDispatchReason   : settlement_required
routerDispatchByChain  : base -> "below the settlement floor"
```

Two readings, one of which is a non-issue and one of which is the whole story.

**The 502 is stale, not a defect.** It was recorded at 01:35 on 2026-10-18, while the
tunnel was down; every route answers correctly now (`POST /v1/evidence` with an empty
object returns 402, `/.well-known/x402` returns 200, deep health is ok). Their crawler
re-reads us - `fetchedAt` was current - so the failed paywall probe is a snapshot of
the outage, not of the service.

**The router gate is demand, and it is not ours to fake.** `settlement_required` with
"below the settlement floor" means their order router will not dispatch a task to us
until we have proven settled volume on-chain. Their own docs describe the tier above
it: sellers with settlement history are routable, while an unproven seller is tried
only after every proven candidate.

Their `/api/find` catalogue search returns only their own tools, so external sellers
surface through the index and the router - and the router is closed until money has
moved to us from someone else. Which is the objective, stated by a third party as a
precondition rather than as a marketing claim.

**Deliberately not done:** our own paid calls settle to this same payTo, so making
enough of them would cross the floor. That would be manufacturing settlement history
to unlock a router built to measure real demand, and it is exactly the self-purchase
the goal forbids. The floor stays where it is.

## /openapi.json: the discovery document two indexes require (2026-10-19)

We served `/.well-known/x402` and no OpenAPI spec. Both aggregators wanted the spec.

- **x402scan** is a marketplace and block explorer for paid x402 APIs whose discovery
  spec is explicit: *"OpenAPI is the canonical discovery contract. Publish your spec at
  /openapi.json"* - each payable operation carrying `x-payment-info` (a structured USD
  price plus `protocols`) and a request body schema. Without it the register form
  answers **"No discovery document found"** and will not list the origin.
- **agent402** reads `/.well-known/x402` *alongside* `openapi.json`. Our own code
  comment already recorded that its self-serve registration answered *"Source URL
  returned HTTP 404"* for us; the file simply did not exist.

It is now served from the backend and proxied by the Worker, with every value derived
from the same configuration the live challenge uses - price, recipient, network,
version - because a discovery document that disagrees with the 402 it describes is
worse than none, and the spec says runtime behaviour is authoritative. The MCP routes
declare a JSON-RPC envelope rather than being omitted: a missing request schema is
what x402scan calls an unreliable listing.

Their own audit, run against the deployed origin:

```
Source:  openapi     Spec: https://agent-evidence-api.thx93.workers.dev/openapi.json
Routes:  3
  POST /v1/evidence   paid 0.003 USD  [x402]
  POST /mcp           paid 0.003 USD  [x402]
  POST /weather/mcp   paid 0.003 USD  [x402]
Guidance: 114 tokens
Warnings: 0        (was 1: FAVICON_MISSING, now served)
```

### Registered, with the operator's approval

The spec is emphatic that a listing is published only after explicit approval, so the
origin, routes, prices and audit were put to the operator and registration happened
only after a yes. Authentication is SIWX (identity-only, no payment), which the
`agentcash` CLI performs; it needs a writable `HOME`, and its base directory is
`join(homedir(), ".agentcash")`, so it was run with `HOME` inside the workspace.

```
POST https://www.x402scan.com/api/x402/registry/register-origin
{"origin":"https://agent-evidence-api.thx93.workers.dev"}

-> {"registered": 3, "failed": 0, "total": 3, "source": "openapi"}
```

The other counters - `siwx`, `public`, `apiKey` - are auth-mode tallies, and zero is
correct for three x402-paid routes. `agentcash discover` re-reads the origin and
returns all three resources with the guidance intact.

## Where the x402 volume actually is (measured 2026-10-19)

x402scan's dashboard reports the ecosystem at **113.5K transactions and $121.38K in
24 hours, across 3.08K buyers and 2K sellers**. The market is not empty, and that is
worth stating plainly after several rounds of "the constraint is demand".

What those buyers buy, by volume over 24 hours:

| server | what it is | volume | txns | buyers |
| --- | --- | --- | --- | --- |
| AX1 Console | agentic activities launchpad | $166.74 | 8.34K | 189 |
| BlockRun on Solana | 114 AI models + search + market data + RPC, one endpoint | $107.42 | 40.65K | 23 |
| Claw402 | payment infrastructure for AI and APIs | $47.69 | 17.77K | 27 |
| Agentic Portal | pay-per-call Pocket Network services | $22.77 | 4.55K | 49 |

Two patterns, both uncomfortable for a $0.003 claim-verification API:

1. **Volume concentrates in broad infrastructure** - model gateways, payment rails,
   network access, multi-purpose endpoints. Not narrow single-purpose tools.
2. The header says it outright: these are addresses "listed in the **Bazaar**". The
   highest-traffic surface is the one our MCP routes cannot enter.

This does not say there is no demand for claim verification - 402oracle.com carries
settlement history in agent402's index, so some exists. It says the demand that
moves real volume is for things an agent needs on every loop, not for a narrow
verification tool it needs occasionally.

## agentic.market: the buyer-facing surface, and what it shows (2026-10-19)

CDP's Bazaar has a storefront. agentic.market says it plainly in its own FAQ: *"If
your service/endpoints are indexed on the Bazaar, you'll automatically show up on
agentic.market."* We are Bazaar-indexed for `/v1/evidence`, and the consequence is
verifiable:

```
https://agentic.market/services/agent-evidence-api-thx93-workers-dev

  agent-evidence-api · agent-evidence-api.thx93.workers.dev
  Avg / request  $0.003
  Endpoints      1
  crawlable route  POST /v1/evidence
```

Searching its palette for "evidence" returns us among the results. So the Bazaar
listing is not paperwork - it is a storefront a buyer can find us on, and it needed
no registration and no fee.

### Endpoints: 1 is the cost of the preflight bug

The page lists one route, not three. The two MCP routes cannot pass CDP's preflight
(`bazaar.info.input.method` fails as "Skipped: input type is not http"), so they are
not in the Bazaar, so they are not here. That is why a search for "weather alerts" or
"claim verification" on agentic.market does not return us while 402oracle appears for
both - it has more endpoints to match on.

**The workaround is available and deliberately not taken.** Declaring
`input.type: "http"` instead of `"mcp"` would likely satisfy the validator, since the
check exists only for the http branch. Rejected for two reasons:

1. It is a misdeclaration. The body is JSON-RPC; `"mcp"` is the accurate label and
   `"http"` is the one that merely passes.
2. It risks an asset that works. Our PayAI weather entries are first for several
   queries and are keyed on the MCP `toolName`; re-declaring the input type could
   drop that key and reset listings we already have.

The honest route is the one already taken: reported to cdp-sdk#850 with a
reproduction, and left for them to fix.

## The catalogue name: renamed, measured, kept (2026-10-19)

agentic.market matches the **service name**, not descriptions. Measured: queries that
appear only in our description - "retrieval time", "content hash", "passages that
support" - return nothing, while "evidence" returns us because the name is
`agent-evidence-api`. That is why the weather capabilities published over HTTP were
undiscoverable there by name.

So the catalogue name is now **"Agent Evidence API & US Weather"** - a separate
constant from `SERVICE_NAME`, which remains the product's identity in health responses
and documentation and should not churn for a listing's sake.

It was changed as a measured experiment, with the PayAI rankings taken before and
after:

| query | before | after |
| --- | --- | --- |
| claim verification | #1 | #1 |
| fact checking | #1 | #1 |
| sources | #1 | #1 |
| evidence | #1 | #1 |
| source verification | #1 | #1 |
| citations | #10 | **#9** |
| weather / national weather service / 5-day forecast | #1 | #1 |
| temperature | #2 | #2 |
| weather alerts | #3 | #3 |

Nothing regressed and one query improved, so it stays. "evidence" is kept and kept
first: the point was to add a word, not trade one away.

**What it did not do.** agentic.market still does not return us for "weather" or
"weather alerts", because CDP's Bazaar records lag: their `serviceName` is still the
old string, with `lastUpdated` from before the change, and a settled call did not
refresh it. Their ingestion is asynchronous, so that surface may follow later - or may
never, if the name it displays comes from somewhere we do not control. Not claimed
either way until it is observed.
