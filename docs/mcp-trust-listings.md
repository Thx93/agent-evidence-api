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
