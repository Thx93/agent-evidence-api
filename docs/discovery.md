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

> **Status.** Nothing has been published anywhere. The implementation is complete
> and `pnpm typecheck` passes; `server.json` exists and is written against the
> current official schema, and the publish procedure is documented in
> [`registry-publication.md`](./registry-publication.md). SPEC §28 is explicit:
> *"Do NOT automatically publish to the registry unless credentials and
> authorization are explicitly available."* Prepare, validate, then publish by
> hand. Read [§7 Before you publish](#7-before-you-publish) first — the endpoint is
> not deployed, the suites have not been run here, and no on-chain payment has
> been demonstrated.

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
- The test suites and `scripts/smoke.sh` have not been run here, so there is no
  recorded evidence that the end-to-end flow passes.
- No on-chain x402 payment has been demonstrated, and there is no automated
  payment test.
- `apps/worker/wrangler.jsonc` still contains literal test-recipient addresses,
  which must not ship.

A registry entry published now would list a `research_evidence` tool reachable
only at a placeholder host. That is exactly the outcome the honesty rules exist to
prevent: an agent that discovers the tool, pays for it, and receives a transport
error will not retry.

Validate the metadata, deploy the endpoint, run the suites, and only then publish
by hand — once the acceptance criteria in SPEC §42 are genuinely true.
