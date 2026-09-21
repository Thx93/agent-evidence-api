# Agent discoverability

SPEC §29 requires a realistic discovery strategy. The audience is not a human
shopper browsing a landing page — it is an AI agent (or the developer configuring
one) deciding, from a tool list and a metadata file, whether this service answers
the question it has.

Discovery here means three things in order of importance:

1. **An agent can find the tool** — through the MCP Registry, a client's tool
   list, or a repository search.
2. **An agent can understand what the tool does from machine-readable metadata
   alone** — without a human reading prose.
3. **The description is true.** A misleading description does not produce a
   sale; it produces a failed tool call, a wrong answer grounded in the wrong
   expectation, and a client that removes the server.

> **Status.** Published and live. The service and its MCP server are deployed at
> `https://agent-evidence-api.thx93.workers.dev`, listed in the CDP Bazaar (HTTP
> route), PayAI's Bazaar (HTTP + MCP), agentic.market, the MCP Registry, Agent402,
> 402 Index and glama.ai (owned, 4.3/5.0), and has passed every readiness check
> (discoverable, gated, payable, safe to charge).
>
> **The open problem is not distribution.** Eight listings — one of them first place
> for five of six buyer queries — have produced zero third-party customers. The
> previously-open MCP gate has moved to the backend so the MCP route can be
> catalogued too; that removes the last structural discovery defect, and the
> sections below are honest about how little that is worth on its own. Read
> [§7 Before you publish](#7-before-you-publish) and
> [`market-analysis.md`](./market-analysis.md) before concluding that more listing
> work is the answer.

---

## 1. Channels

### 1.1 Official MCP Registry

The primary channel, and the only one that puts the tool in front of MCP hosts
directly.

What is required (SPEC §28) and where it stands:

- a `server.json` metadata file using the **current official schema**, with
  server name, description, version, repository metadata, remote transport
  information, package metadata where applicable, and installation information —
  **created**, though `remotes[].url` is still a placeholder;
- validation of that file — see
  [`registry-publication.md`](./registry-publication.md), not yet run;
- documented exact publish steps — **documented**;
- a checklist for namespace ownership and authentication — **documented**;
- **no automatic publication** — nothing publishes.

Do not invent registry fields. The schema is published by the registry project;
read it rather than guessing, and validate against it before publishing.

Two facts about the registry worth planning around:

- **Namespace ownership.** Names include the namespace (`io.github.<owner>/…`).
  Establishing it is the step that blocks most first publications, because the
  registry verifies ownership against the linked repository or domain. Confirm
  that the `name` and `repository.url` currently in `server.json` refer to an
  account you actually control — a fabricated handle fails validation, and SPEC
  §33 forbids inventing identifiers.
- **Remote vs package servers.** This service is a **remote** server: a client
  connects to a URL. It is not installed as a local stdio process. `server.json`
  therefore declares `remotes` and deliberately carries **no `packages` entry**,
  because there is no npm package to install and inventing one would be false
  metadata.

Publish with the official `mcp-publisher` workflow once the namespace is yours.

### 1.2 GitHub repository

The repository is the second discovery path, and the one a developer reads after
a registry hit.

What makes it findable and useful:

- A **public** repository (a registry entry pointing at a private repo is
  rejected by most reviewers of the ecosystem).
- A repository **description** that is the same truthful one-liner used in
  `server.json` and the README — consistency across surfaces is itself a signal.
- **Topics** that name the actual domain: `mcp`, `mcp-server`, `x402`, `base`,
  `usdc`, `ai-agents`, `web-evidence`, `claim-verification`. Topics are
  categorisation, not a keyword dump; keep them few and accurate.
- A README that answers "what does it do, how do I call it, what does it cost,
  what are its limits" in the first screen. The README in this repository covers
  the thirteen points in SPEC §30.
- `AGENTS.md` present, so an agent working *in* the repository follows the right
  rules. AGENTS.md is the sole rules file; do not add `CLAUDE.md`,
  `.cursorrules`, or a competing rule book (SPEC §1 item 12).

SPEC §35 governs how the repository is handled: initialise Git only if it is not
already a repository, do not force-push, do not change remotes, and do not push
automatically.

### 1.3 npm metadata where appropriate

Be honest about what npm is and is not for here.

- This service's consumers connect to a **hosted endpoint**. There is nothing to
  `npm install` in order to *use* it, so package metadata is not a primary
  discovery channel and should not be treated as one.
- However, **if** an MCP client package, a client SDK, or a thin helper is ever
  published, its `package.json` fields are real discovery surface:
  - `name`, `description`, `keywords`, `homepage`, `repository`, `bugs`,
    `license`, `version`.
  - The `description` must match the truthful one-liner used everywhere else.
  - `keywords` should mirror the GitHub topics, not exceed them.
- The workspace packages (`@aee/schemas`, `@aee/core`, `@aee/fetcher`,
  `@aee/extraction`, `@aee/cache`, `@aee/mcp`, `@aee/backend`, `@aee/worker`) are
  currently `private: true` and are not intended for publication. Do not publish
  them accidentally by removing that flag.

If nothing is published to npm, say so plainly rather than implying a package
exists.

### 1.4 Machine-readable metadata

Metadata an agent or a client can consume without a human in the loop:

| Surface | Content | State |
|---|---|---|
| `GET /` | Service description, endpoints, MCP transport, tool payment classes, payment config. | Implemented in the Worker — this is the most useful machine-readable surface today. |
| `GET /health` | Minimal liveness object. | Implemented. |
| MCP `tools/list` | Tool names, descriptions, and input JSON Schemas, served over the MCP transport. | **Implemented** (`packages/mcp`), stateless streamable HTTP. |
| `server.json` | Registry metadata: name, description, version, repository, remote transport. | **Created**; remote URL is still a placeholder. |
| Repository manifest files | `package.json` `description`/`keywords`, GitHub topics. | Partially present. |

`GET /` deserves attention: it is free, unauthenticated, and describes what is
paid and what is free before an agent commits any money. Keep it accurate —
it is quoted directly into agent context.

A `/.well-known/` discovery document is not implemented and SPEC does not require
one. Do not advertise one.

### 1.5 Documentation

`docs/` is written for two readers at once: the human integrating the service and
the agent reasoning about whether a call will succeed.

| Document | Answers |
|---|---|
| [`architecture.md`](./architecture.md) | How the system is put together and where the boundaries are. |
| [`api.md`](./api.md) | Exact request/response shapes, error codes, limits. |
| [`mcp.md`](./mcp.md) | Transport, tools, exact input schema, what is free and what is paid. |
| [`x402.md`](./x402.md) | The payment flow and its configuration. |
| [`security.md`](./security.md) | The threat model and the SSRF controls. |
| [`deployment.md`](./deployment.md) | How to run and deploy it. |
| [`discovery.md`](./discovery.md) | This document. |

Documentation aids discovery indirectly but decisively: an agent that has retrieved
the docs can construct a correct call without trial and error, and tool
descriptions that are backed by precise documentation are the ones that get
selected again.

### 1.6 Agent-oriented tool descriptions

The tool description is the highest-leverage discovery surface, because it is
what the model actually reads when choosing a tool. SPEC §29 asks for
descriptions that explicitly contain the useful phrases below, and SPEC §10
supplies the intended description for `research_evidence`:

> Fetch public web sources and return structured, cited evidence for a question
> or claim. Use this when you need source-grounded verification, comparison, or
> evidence extraction. Returns source URLs, retrieved timestamps, short evidence
> excerpts, metadata, and an explicit supported/contradicted/mixed/inconclusive
> assessment.

That description earns its place because every sentence is actionable:

- It says **what it does** (fetch public web sources, return structured cited
  evidence).
- It says **when to use it** (source-grounded verification, comparison, evidence
  extraction) — which is what a model needs to route a task.
- It says **what comes back** (URLs, timestamps, excerpts, metadata, an explicit
  assessment) — which lets the model plan the next step.
- It names the **exact assessment vocabulary**, so the model can branch on it.

What it deliberately does **not** do: claim truth, claim completeness, claim to
replace reasoning, or promise that a claim will be resolved. The product returns
evidence.

---

## 2. Truthful descriptive phrases worth using

These are accurate descriptions of what the service does. SPEC §29 names them
explicitly. Use them where they genuinely apply — in the tool description,
`server.json`, the repository description, `GET /`, the README, and package
metadata.

| Phrase | Why it is accurate |
|---|---|
| **web evidence** | The output is evidence extracted from public web pages. |
| **source verification** | The service verifies what a given source actually says, and returns the passage it rests on. |
| **claim verification** | A caller submits a claim and receives a supported/contradicted/mixed/inconclusive assessment with citations. |
| **evidence extraction** | Excerpts are extracted from source documents and ranked lexically. |
| **source-grounded research** | Every conclusion is tied to a retrieved source, retrieval timestamp, and content hash. |
| **compare sources** | Cross-source comparison detects agreement and lexical disagreement. |
| **cited evidence** | Each evidence item carries its source URL, final URL, context, and content hash. |
| **fresh web evidence** | Sources are fetched on demand, with per-source retrieval timestamps; cache hits are explicitly flagged rather than presented as fresh. |

Each phrase maps to a mechanism that exists, not to a marketing aspiration. That
is the test for whether a phrase belongs.

**These eight phrases are all present in the shipped `research_evidence` tool
description**, woven into real sentences rather than listed. See
[`mcp.md` §2](./mcp.md#research_evidence) for the exact string, and a note on why
that density is close to the keyword-stuffing boundary even though every clause is
true.

### Phrases to avoid

Do not use, or anything like them: *the world's best*, *100% accurate*,
*hallucination-free*, *guaranteed truth*, *always correct*, *replaces fact
checking*, *knows the truth*. SPEC §30 forbids the first four by name, and the
rest fail the same test — the service provides evidence, not truth, and its
assessment is produced by deterministic lexical matching.

Also avoid positioning it as: a web scraper, an SEO tool, a generic crawler, a
proxy, a browser-automation service, or a search engine (SPEC §3). Those are
wrong descriptions of what it is, and a developer who picks it expecting a
scraper will be disappointed in a way that no description should have invited.

---

## 3. Do not keyword-stuff

SPEC §29: *"Do not keyword-stuff. Descriptions must be truthful."*

Keyword stuffing is not merely bad taste — it actively damages an agent-facing
product:

- **It displaces signal.** Tool descriptions compete for a limited context
  window. A description padded with synonyms pushes out the information the model
  needs to route the task correctly.
- **It corrupts routing.** A model that selects this tool for a *search*-shaped
  or *scraping*-shaped task will call it with the wrong arguments and get a
  failed or unhelpful result. A precise description that causes a model to *not*
  select it is a success, not a lost opportunity.
- **It is verifiable.** Registry reviewers and developers check claims against
  behaviour. An overstated description is a rejected registry entry or a removed
  integration.
- **It compounds.** Metadata is duplicated across `server.json`, the README, the
  tool description, `GET /`, GitHub, and npm. Stuffing one surface means stuffing
  all of them consistently, which is a large amount of committed dishonesty.

Practical rules:

- Use each phrase **once**, in the surface where it is the most natural fit.
  Eight phrases across six surfaces is plenty; eight phrases in one paragraph is
  stuffing.
- Prefer a concrete capability statement over a keyword list:
  *"Returns source URLs, retrieval timestamps, short evidence excerpts, and an
  explicit supported/contradicted/mixed/inconclusive assessment"* beats *"web
  evidence claim verification source verification evidence extraction cited
  evidence fresh web evidence"*.
- Never list a capability the service does not have. Search-backed research, PDF
  evidence, browser rendering, image evidence, and change detection are all
  **future** possibilities listed in SPEC §37, and none of them exist. They are
  legitimate material for a roadmap section clearly labelled as not implemented;
  they are not legitimate material for a description.
- Keep the same truthful one-liner everywhere. Consistency across surfaces is a
  credibility signal; divergence reads as opportunistic.

### The honesty checklist for any description

Before publishing a description, confirm that each claim is backed by code that
exists:

- "cited evidence" — does the response actually carry source URL, final URL,
  retrieval timestamp, and content hash? **Yes**, in `SourceSchema`.
- "compare sources" — does anything actually compare? **Yes**, `assess()` in
  `packages/core`.
- "fresh web evidence" — is freshness real? **Yes**, `retrieved_at` is always the
  actual retrieval time and cache hits are flagged.
- "source verification" — does it verify what a source says? **Yes**, lexically,
  with the limitation stated.
- "web evidence" — does it fetch public web pages? **Yes** — `@aee/fetcher`
  implements SSRF-hardened retrieval and `@aee/extraction` parses the result.
- "cited evidence" — does every excerpt carry a citation? **Yes** — source URL,
  final URL, context, retrieval timestamp, and content hash.
- "compare sources" — is there real comparison? **Yes** — `assess()` classifies
  each source's lexical stance and reports agreement or disagreement.
- can an agent actually call it? **Yes**, once deployed. The tools are
  implemented and `pnpm typecheck` passes, but the endpoint is not deployed and
  the suites have not been run.

Every clause of the shipped description is therefore backed by code. The remaining
reason for caution is deployment and verification, not accuracy — see §7.

---

## 4. Descriptive text to reuse

**One-liner** (repository description, `server.json` description, npm
`description`, `GET /`):

> Evidence infrastructure for AI agents: structured, cited evidence from public
> web pages, so an agent can verify claims and ground its answers in sources.

**Tool description for `research_evidence`** — the shipped string is in
[`mcp.md` §2](./mcp.md#research_evidence). It is **not** the SPEC §10 text
verbatim: SPEC §10 supplies an *example intent*, and the implementation expands it
so that all eight SPEC §29 phrases appear truthfully. If you revise it, cut
phrases rather than adding them, and update
`packages/mcp/src/mcp.test.ts`, which asserts their presence.

**Short-form tags** (GitHub topics, npm keywords — few and accurate):

```text
mcp
mcp-server
ai-agents
x402
base
usdc
web-evidence
claim-verification
```

```text
# DO NOT use these - they describe something this is not
# scraper  web-scraping  seo  crawler  proxy  browser-automation  search-engine
```

---

## 5. Sequence

A realistic order, with the dependency that actually matters:

1. **Make it work locally.** No publication step should happen before the local
   end-to-end flow works (SPEC §40, §42, §43).
2. **Write the truthful description once**, and reuse it. Derive it from the tool
   description and the README, not from a keyword list.
3. **Fill in repository metadata**: description, topics, license, README.
4. **Create `server.json`** and validate it against the current official schema.
5. **Document the exact publish steps** and a namespace-ownership checklist.
6. **Establish namespace ownership** (organisation or domain). This is the
   long-lead item; do it before step 7.
7. **Publish manually** with the official `mcp-publisher` workflow, when
   credentials and authorization are explicitly available.
8. **Re-verify the description against behaviour** after every release. Metadata
   drifts out of date faster than code.

---

## 6. Checklist

Preparation (do now):

- [ ] README covers all thirteen points in SPEC §30.
- [ ] `docs/` complete: architecture, api, mcp, x402, security, deployment,
      discovery.
- [ ] Tool description is the SPEC §10 text, verbatim, in the tool definition.
- [ ] `GET /` capability document is accurate about which tools are free and
      which are paid.
- [ ] One truthful one-liner chosen and reused consistently.
- [ ] GitHub description and topics set.
- [ ] The eight truthful phrases used, once each, where they genuinely apply.
- [ ] No forbidden claim appears anywhere in the repository:
      `grep -ri "world's best\|100% accurate\|hallucination-free\|guaranteed truth"`.

Registry readiness (SPEC §28):

- [x] `server.json` created with the current official schema.
- [ ] `server.json` validated.
- [x] Remote transport described correctly (streamable HTTP, endpoint URL) —
      not a stdio/`npx` invocation.
- [x] Version matches `0.1.0`.
- [ ] Repository metadata confirmed to point at a repository you actually own.
- [ ] Placeholder `remotes[].url` replaced with the real `MCP_PUBLIC_URL`.
- [x] Exact publish steps documented (`docs/registry-publication.md`).
- [x] Namespace ownership/authentication checklist documented.
- [x] `mcp-publisher` workflow documented.
- [x] **Not** published automatically.

Preparation items still open: the GitHub description and topics can only be set
once the repository is public, and `server.json` must be validated against the
registry schema.

Publication (only when the above are true, and only by hand):

- [ ] Local end-to-end flow demonstrated.
- [ ] SSRF, redirect, size, and timeout tests passing.
- [ ] x402 `402` behaviour demonstrated.
- [ ] Deployed endpoint reachable and healthy.
- [ ] Namespace ownership proven.
- [ ] Description re-read against the honesty checklist in §3.

---

## 7. Before you publish

The most important guidance in this document:

**Do not publish until the thing works.** SPEC §42 and §43 are unambiguous: do
not claim success before the complete local end-to-end flow works, and if
credentials are missing, implement everything possible and document precisely
what remains — do not fake it and do not claim the integration works.

The implementation is now complete and typechecks, so the remaining blockers are
configuration and verification rather than missing code. Publishing *today* would
still be premature in specific, checkable ways:

- No deployment exists, so the `remotes[].url` in `server.json` is still
  `https://mcp.example.invalid/mcp` and would be a dead endpoint.
- The `name` and `repository.url` assert a GitHub namespace that has not been
  confirmed as genuinely owned.
- The suites pass locally (199 tests) and both smoke scripts pass against live
  sockets, but no independent party has reproduced that.
- No on-chain x402 payment has been demonstrated: `scripts/worker-smoke.sh`
  covers the 402 gate, not settlement.
- `apps/worker/wrangler.jsonc` still contains literal test-recipient addresses,
  which must not ship.

A registry entry published now would list a `research_evidence` tool reachable
only at a placeholder host. That is exactly the outcome the honesty rules exist to
prevent: an agent that discovers the tool, pays for it, and receives a transport
error will not retry.

Validate the metadata, deploy the endpoint, run the suites, and only then publish
by hand — once the acceptance criteria in SPEC §42 are genuinely true.

## The x402 catalogue is the channel that matters, and a payment is the only way in

Measured directly against the live PayAI discovery API on 2026-09-21
(`https://facilitator.payai.network/discovery/resources`):

| | Value |
|---|---|
| Services listed | **6,600** |
| On Base (`eip155:8453`) | ~66% of a 2,000-entry sample |
| Self-hosted deployments (`*.workers.dev`, Vercel, Netlify, Fly, Render) | ~19% of sample |
| Submission endpoint | **none** — every write path returns 404/405 |
| Our service | **absent** |

Entries are created when a payment settles through a facilitator that declares the
bazaar extension. There is no manual submission, so **a settled payment is the
only route into the catalogue.** It is not merely a test of the service: it is the
distribution event. Until one settles, the service is invisible to the buyers who
browse x402 listings.

The same measurement confirmed our declared metadata is already at or above the
quality of what is listed: `serviceName`, `tags`, the USDC `extra` domain fields,
a full example request body, and a full example response — where a typical listing
carries a placeholder like `{"data": [], "success": true}`.

`resource.description` is the entire pitch in that list, and the catalogue median
is 179 characters. It was 52 and described the product rather than the deliverable;
it now leads with what the caller receives, names the input, and states the
no-charge guarantee.

Read the live list at any time:

```bash
curl -s "https://facilitator.payai.network/discovery/resources?limit=1000" \
| python3 -c "import json,sys; d=json.load(sys.stdin); print(d['pagination']['total'], 'services listed')"
```

To check whether this service has been catalogued yet, search the pages for its
resource URL. An entry appearing is proof a payment settled.

## The catalogue is split by type, and the MCP side is nearly empty

`/discovery/resources` filters on `type`:

```bash
curl -s "https://facilitator.payai.network/discovery/resources?type=mcp&limit=5"   # total: 33
curl -s "https://facilitator.payai.network/discovery/resources?type=http&limit=5"  # total: 6567
```

**33 MCP tools against 6,567 HTTP endpoints.** Those are the two shelves this
service could sit on, and they are not equally crowded.

A service lands on the MCP shelf by declaring the MCP shape in its bazaar
extension:

```json
"extensions": { "bazaar": { "info": { "input": {
  "type": "mcp",
  "toolName": "research_evidence",
  "transport": "streamable-http",
  "inputSchema": { ... }
}}}}
```

The Worker declares this separately per route, so the two paid routes publish
different shapes:

| Route | Declares | Shelf |
|---|---|---|
| `POST /v1/evidence` | `type: "http"` + method + body example | ~6,567 |
| `POST /mcp` | `type: "mcp"` + `toolName` + `transport` + `inputSchema` | ~33 |

So once a payment settles, this service should appear on **both** — including the
MCP shelf, where MCP-aware agents look and where there is far less to compete
with.

`transport` is optional in the SDK's type but present in every MCP entry that is
actually catalogued, so it is declared. Without it the entry describes a tool but
never says how to reach it. Verify what is published:

```bash
curl -sD - -o /dev/null -X POST https://agent-evidence-api.thx93.workers.dev/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"research_evidence","arguments":{"question":"q","urls":["https://example.com"]}}}' \
| grep -i '^payment-required:' | cut -d' ' -f2 | base64 -d | python3 -m json.tool | grep -A5 bazaar
```

## What is actually on the MCP shelf

All 33 MCP-typed entries, examined 2026-09-21:

| | |
|---|---|
| Total MCP entries | **33** |
| Resources whose path ends in `/mcp` | **31** — classification is by path, not by the extension |
| Entries declaring a `toolName` (well-formed) | **11** |
| …of which from a single operator ("Myncellium Paid MCP") | **11** |
| Entries with a description but no tool metadata | **22** |
| Well-formed entries declaring an output example | 5 of 11 |
| Well-formed entries declaring an output schema | 0 |

Three things follow.

**Classification is by resource path.** A paid route whose URL ends in `/mcp`
lands on this shelf. Ours does.

**The shelf is far thinner than the count suggests.** Of 33 entries, 22 describe
an MCP endpoint without saying what tool it offers or what arguments it takes, and
the 11 that are complete all belong to one seller. A well-formed listing here is
not competing with 33 services; it is competing with one operator's suite.

**Our entry would be in the well-formed minority**, and more complete than most:
`serviceName`, `tags`, a resource description, `toolName`, `transport`, an
`inputSchema` with a real example, and an `output.example` showing the actual
deliverable — where only 5 of the 11 complete entries show a buyer any output at
all.

Price calibration: MCP-shelf prices run $0.001–$0.46, mostly $0.002–$0.05. Ours
was $0.03 (mid-range) when this was measured; it was later repriced to $0.003 — see
docs/market-analysis.md, which measured the market at a larger sample.

## Searching the catalogue, and why the wording matters

There is a second endpoint, and it is the one buyers actually use:

```bash
curl -s "https://facilitator.payai.network/discovery/search?query=claim+verification"
```

**`/discovery/resources?query=…` silently ignores the query and returns the default
page.** The real endpoint is `/discovery/search`, reached from the SDK as
`client.extensions.bazaar.search({ query })`. Anyone testing discoverability against
the wrong one would conclude, incorrectly, that search does not exist.

### The search is keyword based, not semantic

Two observations establish this. `"web evidence"` returns `delx.ai` endpoints that
parse Vary headers and Content-Type strings — unrelated to evidence, matched on
shared words. And `"fact check sources"` returns **zero** results, which a semantic
index would not do.

So a natural-language query is really a bag of words, and an entry surfaces only if
its description contains them.

### Where this service sits, by query

Measured 2026-09-21:

| Query | Results | Notes |
|---|---:|---|
| `claim verification` | 4 | two `aiapi.ch` routes ("financial evidence"), one ngrok demo |
| `web evidence` | 20 | mostly noise; one real competitor |
| `verify a company claim` | **0** | nobody matches this |
| `fact check sources` | **0** | nobody matches this |

**One direct competitor exists**: `phion.systems/v1/paid/fetch-evidence` —
*"Independent, prompt-injection-screened, hashed and signed web evidence"* — at
**$0.004** when this was measured. This service was $0.03 then and has since moved to
$0.003; see docs/market-analysis.md.

### The wording of the description is therefore a discovery lever

Terms are rare across the catalogue (sampled 1,000 descriptions): `cited` 69,
`citation` 22, `claim` 17, `verify` 16, `evidence` 16, `verification` 11,
`provenance` 7, `fact check` 0.

The original description was accurate but contained none of `verify`, `web`,
`cited`, `citation` or `sources` — every word a buyer in this niche would type. It
now reads:

> Verify a claim against public web sources: send a question and up to 5 URLs, get
> cited evidence - passages that support, contradict or fail to settle it. Every
> excerpt carries a citation: source URL, retrieval time, content hash. Never
> charges when nothing is retrieved.

and the MCP tool description was aligned the same way. This is not keyword
stuffing: every phrase states what the service does. It is choosing words a buyer
would search with, rather than words that merely describe the product.

Re-measure after cataloguing:

```bash
for q in "claim verification" "verify a company claim" "cited web evidence"; do
  printf '%s -> ' "$q"
  curl -s "https://facilitator.payai.network/discovery/search?query=$(printf '%s' "$q" | tr ' ' '+')" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d.get("resources",[])), "result(s)")'
done
```

## The index does not stem, so every word form is its own key

Verified against the live index by searching morphological variants of a phrase
known to appear in exactly one description ("Perpetual swaps data — pay per
request"):

| Query | Results | Finds that service |
|---|---:|---|
| `perpetual` | 14 | yes |
| `perpetuals` | 19 | yes |
| `perpetually` | 0 | no |
| `swaps` | 10 | yes |
| `swap` | 20 | no |
| `swapping` | 0 | no |

And across the whole catalogue: `cite` returns 4 results while `citation` returns
20. Different answers from the same stem means **no stemming and no substring
matching** — each exact word form is a separate token.

### Which fields are searched

Each field was probed with a word that appears in exactly one of them:

| Field | Indexed |
|---|---|
| `description` | yes |
| `serviceName` | yes |
| `tags` | yes |
| `resource` path | yes |

So all four are worth careful wording, and the resource path matters too — ours is
`…/mcp` and `…/v1/evidence`, both descriptive.

### What this means for the wording

A buyer searching `verification` will not find an entry that says only `verify`.
Both forms have to appear, and they have to read naturally.

The published descriptions now cover 12 of the 13 forms a buyer is likely to type:

`verify` `verification` `claim` `evidence` `cited` `citation` `source` `sources`
`web` `question` `support` `contradict`

The missing one is the bare verb `cite` — the least likely query form, and working
it in would read as stuffing rather than description. Leaving it is a deliberate
choice, not an oversight.

### Multi-word queries are an AND of tokens, order-independent

Established by querying the same words in both orders:

| Query | Results |
|---|---:|
| `cited evidence` | 1 |
| `evidence cited` | 1 |
| `claim verification` | 4 |
| `verification claim` | 4 |

Reversing the word order gives an identical count every time, so the query is a
**bag of tokens**, not a phrase. A multi-word search matches anything containing all
the words, in any order and not necessarily adjacent.

Two practical consequences:

1. **Word order and phrase contiguity do not matter.** Only which tokens are present.
2. **Morphology still does** (see above): `verify` and `verification` remain separate
   keys, so both forms must appear. That is the property worth checking, and the
   token set is what to audit — not whether a particular bigram reads continuously.

This is why the phrase-coverage checks for SPEC §10 and §29 are done on tokens. A
description containing `cited` and `evidence` separately satisfies a buyer searching
"cited evidence", and rewriting prose to place them adjacently would buy nothing and
risk reading as keyword stuffing.

---

# Channel audit: which catalogues can actually find us

Measured 2026-09-21 by querying each catalogue's own search with the phrases a
buyer would type. Earlier rounds added listings and assumed that was the win;
this measures whether a listing is *findable*, which is a different thing.

| catalogue | what its search covers | how we rank |
|---|---|---|
| **x402 Bazaar (PayAI)** | description | **#1 for 5 of 6 buyer queries** |
| 402 Index | description (semantic + LIKE) | 4 of 8 queries, best #1 |
| MCP Registry | **server name only** | description unsearchable |
| Agent402 | description | not in their top 5 |
| glama.ai | crawls the MCP Registry | listed, healthy, 4.3/5.0 |
| CDP Bazaar | exact name only — its search API ignores query params | **listed** (HTTP route, 2026-09-21); findable by enumeration, not by keyword |

## The Bazaar is the strong one

```
web evidence       → 20 results, #1      cited evidence  → 3 results, #1
claim verification →  6 results, #1      evidence        → 20 results, #1
verify a claim     →  4 results, #1      fact check      →  3 results, absent
```

Five of six at position one. The description work in earlier rounds did its job,
and "fact check" was the one gap — now added to the manifest (live) and to the
Bazaar description (which only re-catalogues on a settled payment, so it lands on
the next paid call rather than immediately).

## The MCP Registry's search is name-only, which changes what it is for

Proof: our description contains "source-grounded". Searching that returns **zero**
servers; searching "grounded" returns nine and we are not among them; searching
"MCP-native", the first words of our description, does not return us either.

So the registry is a **namespace and provenance record, not a discovery channel**.
Nothing written in its `description` field is searchable, and optimising it — as I
had been treating it — is wasted effort. Discoverability there depends entirely on
the name `io.github.Thx93/agent-evidence-api`, which matches only the word
"evidence".

## Agent402 is not a discovery channel yet either

Its `/api/find` is a real search (different results per query), but it returns five
results and ours is never among them for our own subject matter. Its `/index` does
carry us — two tools, network read correctly — but routing requires 50 settlements
from 3 distinct payers, which is a bar a first customer cannot have cleared. That
gate is deliberate and sensible; it just means Agent402 is a channel we grow into,
not one that finds us a first buyer.

## glama.ai already carries us, and it is the one with human traffic

It crawls the MCP Registry, so our listing propagated there without any action:

```
Agent Evidence API · Status Healthy · Transport Streamable HTTP · MCP 2025-11-25
URL: https://agent-evidence-api.thx93.workers.dev/mcp   (correct)
Score 4.3/5.0 across 2 tools
  Disambiguation      5/5
  Naming Consistency  4/5   "'health' is a bare noun; research_evidence is verb_noun"
  Tool Count          3/5   "only two tools… the set feels thin"
  Completeness        4/5   Behavior 4/5
```

Claiming the connector would unlock **usage reports**, which is the only way to
learn whether anyone is finding us. It cannot be done from here: the GitHub method
needs a public repository (ours is private) and the HTTP challenge needs a token
from Glama's sign-in flow. Both are operator actions.

The Tool Count score is left alone deliberately. The obvious way to raise it is to
add a bare fetch or scrape tool, and SPEC section 1 says in as many words that this
is not a web scraper. Trading a product boundary for 0.4 of a directory score is a
bad trade.

## What this means

Discovery is no longer the constraint on the channels we can reach. We rank first
on the catalogue with the most buyers, we are listed and healthy on the one with
human traffic, and the two channels we are missing from — the CDP Bazaar and
Agent402's router — are both gated on credentials or on having customers already.

Four rounds of listing work have produced: four listings, one of them first place,
and zero customers. The remaining levers are not listing quality.

## glama.ai ownership: how it is verified, and what must not be removed

Glama carries this MCP server (crawled from the official registry) and scores it
4.3/5.0. Claiming it unlocks **usage reports** — the only analytics available to us,
and the only way to find out whether anyone is finding this service at all.

Ownership is proven by publishing an exact JSON document on the connector's own
origin, at a URL Glama fetches:

    https://agent-evidence-api.thx93.workers.dev/.well-known/glama.json

Three methods exist; only one is available to this project:

| method | requirement | usable |
|---|---|---|
| GitHub repo file | `glama.json` in the repo root, **public** repo | no — ours is private |
| **HTTP challenge** | serve the token JSON at `/.well-known/glama.json` | **yes** |
| DNS record | control of a DNS zone | no — `workers.dev` has none |

The file is served by the Worker as a literal route. **The token is not a secret** —
the entire scheme is that it is published publicly so Glama can read it — which is
why committing it is correct rather than a leak. It is unlike an API key, which must
never be committed.

**Do not remove this route.** Glama re-checks periodically, and ownership lapses if
the file stops being discoverable; the usage reports lapse with it.

### Claimed: 2026-09-21

The HTTP challenge verified and the listing now reads **"Ownership verified"**
publicly, with the "claim ownership" prompt gone and an **Admin** tab available to
the operator. Status stayed Healthy (last tested 13:05 UTC) and the TDQS score is
unchanged at **4.3/5.0 (A)** across 2 tools:

| dimension | score | note |
|---|---|---|
| Disambiguation | 5/5 | "the two tools are completely distinct… no ambiguity" |
| Completeness | 4/5 | covers the primary domain |
| Behavior | 4/5 | |
| Naming Consistency | 4/5 | "`health` is a bare noun; `research_evidence` is verb_noun" |
| Tool Count | 3/5 | "only two tools… the set feels thin" |

The two low scores are deliberately left alone. Raising Tool Count means adding a
bare fetch or scrape tool, and SPEC section 1 says this is not a web scraper;
renaming `health` to satisfy a naming convention that no agent consumes would churn
a working tool for part of a point. A directory score is not worth a product
boundary.

**What claiming is actually for here: usage reports.** They are visible only in the
authenticated Admin tab — the public page payload carries a `recentToolCallCount`
key with no value, which is consistent with zero recorded calls, but that is an
inference from a serialised payload and not a measurement. The Admin tab is the
first place in this project where real traffic, if any exists, can be observed.

## Checked: the three x402-README directories do not carry us, and the Bazaar does not reach them

The previous version of this section said the status of these three directories was
"unknown, not absent", because all three render client-side and a homepage grep proves
nothing. That was correct, and it was then fixed properly: each was loaded in a real
headless browser (Playwright/Chromium), each was searched through its own UI, and the
HTTP endpoint its front-end actually calls was captured from live network traffic and
queried directly. Measured 2026-09-21.

| directory | data endpoint actually used | verdict |
|---|---|---|
| [x402scan.com](https://www.x402scan.com) | `POST /api/trpc/public.origins.search` + `public.resources.search` (tRPC batch) | **absent** |
| [pay.sh](https://pay.sh) → `/api` | `GET https://pay.sh/api/catalog` | **absent** |
| [app.ampersend.ai/discover](https://app.ampersend.ai/discover) | `GET /api/trpc/marketplace.list` (tRPC batch) | **absent** |

The hard evidence, not the fuzzy search box:

- **x402scan** — `public.origins.search` returns `[]` for `thx93`,
  `agent-evidence` and the full worker hostname. Its rendered search for `evidence`
  returned unrelated services (`evidence.regulavita.com`, TempoChan, Agent Guild).
- **pay.sh** — `GET /api/catalog` is a plain JSON document (74 providers,
  snapshot dated 2026-09-01). `thx93`, `agent-evidence`, `workers.dev` and even
  `evidence` each occur **zero** times. Its own directory search renders
  "No services match these filters."
- **ampersend** — `marketplace.list` returns 55 curated services; an empty search
  returns all 55 and none is ours, and searching `evidence` or `thx93` returns `[]`.
  The rendered page reads "No services match these filters."

**A CDP Bazaar listing does not propagate to any of them.** That was the open question,
and it is now answered in the negative. x402scan auto-ingests *part* of the Bazaar — in
a controlled sample of 100 CDP-Bazaar resources, 66 were also present in x402scan's
origins table and 34 were not, and this service is in the missing 34. pay.sh is a dated
curated catalogue with a "Get listed" submission path; ampersend is a curated
marketplace whose `source` field reads `catalog`, not a Bazaar feed. Two of the three
are therefore separate submissions, and the third is an incomplete mirror.

Two honest caveats, both of which could change the answer: pay.sh's catalogue snapshot
is dated 2026-09-01, so it lags; and x402scan's ingestion is demonstrably partial and
may catch up. Neither is a reason to have skipped the check or to overstate the result.

This is also the second time a "listing" has been confused with reach in this project's
history. The correction is the same both times: the question is not whether a catalogue
contains us, it is whether a *buyer* can arrive through it.

## Community channels: what actually exists

- **x402 Slack** - the only community channel. No GitHub Discussions (disabled on both
  `x402-foundation/x402` and `coinbase/x402`), no forum, no Telegram.
- **GitHub Issues** - open on `x402-foundation/x402`; suitable for defects, not for a
  launch post.

## The question behind all of this: how many buyers are there?

Every listing in this document is a route to a buyer. [`buyer-pool.md`](./buyer-pool.md)
measures how many buyers there are to route to, from the whole catalogue rather than a
sample, with wallet counts verified on-chain. The short version: **2,764 distinct
wallets** paid the 75 sellers that take ~80% of x402's call volume in a week, the
retrieval pool is a strict subset of them, and the evidence-shaped pool is 228. There
is no larger pool of this kind of buyer to find, which is why more listing work is not
the lever it looks like.
