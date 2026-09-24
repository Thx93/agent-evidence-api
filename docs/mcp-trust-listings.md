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

| | weather MCP | paid service (agent-evidence-api) |
|---|---|---|
| M8ven | **74/100, grade C** (code sub-score **96**) | **listed but unscored** |
| M8ven detail | `/mcp/thx93/mcp-weather-server` | `/mcp/thx93-agent-evidence-api-1id76y` |
| claimed | no | no |
| live monitored | not connected | not connected |
| in the official MCP Registry | **no** — `server.json` validates but was never published | yes (0.1.0–0.1.3) |
| on npm | **no** | **no** |

The weather score is capped by *adoption*, not by code: 96 for code, but "Grades
remain capped until the project builds reputation through adoption" — 0 stars, 1
contributor. No amount of tidying moves it past C.

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

## The ordered fix for the paid service

Everything below is blocked on one thing: **a working npm token** (see
[`access-and-credentials.md`](./access-and-credentials.md)).

1. Publish the MCP server to npm. An npm package name is accepted by M8ven, and it
   gives the listing a real install path instead of a private repo.
2. *Then* publish to the official MCP Registry — `bin/mcp-publisher` is authenticated
   and `server.json` already validates. Doing this first would point the registry
   entry at a package that does not exist, which is the "dead endpoint" failure this
   project has already written up once.
3. Re-submit and let the score attach.

Until step 1, a paid MCP listing in any of these directories is a page that leads
nowhere — which is worse than not being listed, because the one thing a trust index
is for is checking that a server can actually be installed.
