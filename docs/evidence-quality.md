# What the assessment can and cannot tell you

This document records a measured limitation, because it decides whether the
product is sellable and the honest answer is not a comfortable one.

## The finding

A real paid call, 2026-10-19:

```
question: Who won the 2024 UEFA Euro final and what was the score?
source:   https://en.wikipedia.org/wiki/UEFA_Euro_2024_final
verdict:  supported
excerpts: "England then won the game very late on when Palmer assisted Ollie
           Watkins to score in the 90th minute, sending them through to their
           first major tournament final"          <- labelled "direct"
          "Across men's and women's ... fourth England-Spain tournament final"
          "The UEFA Euro 2024 final was a football match that determined the
           winners of UEFA Euro 2024."           <- true, but says nothing
```

The answer is Spain, 2-1. No returned excerpt states it. The verdict said
`supported`.

## Why

Matching is deterministic and lexical: IDF-weighted term overlap plus an adjacency
bonus, with negation cues. Nothing in that pipeline knows that the passage is about
a *different* match. The excerpt above contains "won", "score" and "final" - three
of the question's six distinctive words - and that is enough to clear any
coverage threshold that still accepts genuine answers.

Two changes were made in response, and neither is a cure:

1. **An absolute coverage floor** (0.75 of the question's distinctive word weight,
   measured per word rather than per surface variant). Before, labels were relative
   to the best passage in the document, so a document whose best passage was weak
   still produced a "direct" one. This rejects passages that merely touch the
   question.
2. **A regression test** built from this exact failure: a document about a
   semi-final must yield no stance-bearing passage for a question about the final.

The floor does not fix the case above, because the off-target passage is not weakly
overlapping - it is strongly overlapping and wrong. That is the lexical ceiling, and
it is why `limitations` has always said the assessment is "deterministic lexical
matching, not semantic reasoning".

## What this means for selling it

An agent that trusts the `status` field on this class of question will be misled.
Until matching is semantic, the verdict is reliable only when the question shares a
distinctive vocabulary with the answer - company facts, defined terms, specific
attributes - and unreliable when it asks about one of several similar events.

The documented path is the optional Laya sidecar (see README). It scores candidate
passages with a typed-decision model instead of term overlap. It is not required to
run the service, which is why this limitation is recorded here rather than papered
over.

## Resolution, 2026-10-19: the engine now abstains on this class

`assess` was claiming a verdict it could not support. It now abstains - but only in
the narrow case where abstaining is demonstrably better than guessing:

- the question asks **more than one thing** (two or more wh-words), **and**
- exactly **one** source contributed a stance-bearing passage.

Verified on the live service, same question, same source:

```
verdict: inconclusive
basis:   "The question asks more than one thing and only one source contributed a
          matching passage, so the passages cannot be shown to answer the part they
          appear to match. No verdict is claimed."
```

And the counter-case still answers, so the abstention is not a way of answering
nothing: "Is the National Weather Service part of NOAA?" against one page still
returns `supported`. Two tests pin both behaviours.

With two agreeing sources the overlap is corroborated and the verdict stands; with a
single-part question the clause ambiguity never arises. This does not make matching
semantic - that is still the Laya sidecar - but it stops the service being
confidently wrong, which is the part that made it unsellable.

## The honest one-line summary

The service is honest about its provenance and its limitations. It no longer claims a
verdict it cannot support; whether it is worth $0.01 to a buyer who checks is the
open question, and nobody has paid to find out.

## A platform limitation found while trying to get catalogued

CDP's catalogue (`api.cdp.coinbase.com/.../discovery/resources`, ~26,800 entries) is
one of the two large x402 discovery surfaces, and this service is not in it. Their
preflight endpoint explains part of why:

```
POST /platform/v2/x402/validate  {"resource": ".../mcp", "method": "POST"}

url_valid, url_https, endpoint_reachable, returns_402, valid_json, x402_version,
payment_required_header, has_accepts, scheme, network, asset, amount, payTo,
maxTimeoutSeconds, has_resource, has_bazaar_extension, bazaar.info, bazaar.schema,
parse                                    ... all pass

bazaar.info.input.method   FAIL (required)   "Skipped: input type is not http"
```

That single required failure makes `valid: false` for **every MCP route**. It is not
about the declaration: the 402 now states `input.method: "POST"` and the shipped
schema allows the field, and the validator answers with the same message. The check
short-circuits on `input.type` rather than on the field, so an MCP resource cannot
pass CDP's preflight at all.

The HTTP route passes all 25 checks, so this is specific to MCP input type.

**Correction, 2026-10-19: the HTTP route IS indexed.** The paragraph that used to sit
here said it was "valid and still absent". That came from scanning the general
`discovery/resources` list, which is a paged browse view - 25,818 entries, filter
params silently ignored - and finding nothing there says nothing about whether a
particular seller is indexed. The authoritative question is merchant-scoped:

```
GET /platform/v2/x402/discovery/merchant?payTo=0x9c0e...55FD0
-> { total: 1 }
   https://agent-evidence-api.thx93.workers.dev/v1/evidence
```

The record carries our current description, the price, Base USDC and our payTo,
so it is live rather than vestigial. This is the same check CDP's maintainer used in
cdp-sdk#849 to tell other sellers their endpoints were indexed.

Accurate position: **the HTTP evidence route is in the CDP Bazaar; the two MCP routes
cannot pass their preflight and are not.**

## Why the CDP Bazaar does not list us — what is actually known

The absence is not specific to this service. Coinbase's issue tracker carries the
same symptom from several sellers, all of them **native MCP** resources:

| issue | state | subject |
| --- | --- | --- |
| cdp-sdk#850 | open | "SI native MCP resource absent after successful CDP settlement" |
| cdp-sdk#844 | closed | "SeekAPI MCP resource remains processing and unindexed" |
| cdp-sdk#849 | closed | "Settled Base mainnet payments not indexed — v2 bazaar extension present" |
| cdp-sdk#843 | closed | "Bazaar discovery: selective ingestion — fresh settlements never index" |

Two causes are documented by CDP's own maintainer, and they are ruled out or
confirmed here:

**1. The MCP handshake must be free.** From #844: *"the MCP initialize handshake
returned HTTP 402, but the CDP Bazaar requires the handshake and `tools/list` to
succeed without payment; it expects x402 payment requirements only from the selected
tools/call request."* Tested against our routes with their own probe pattern
(`User-Agent: CoinbaseBazaarDiscovery/1.0`, `protocolVersion: 2025-03-26`):
`initialize` → **200**, `tools/list` → **200**, on both `/mcp` and `/weather/mcp`. So
this cause does not apply to us.

**2. The settlement payload must carry `resource`.** From #843: *"your settlements
don't appear to have `paymentPayload.resource` attached, which is needed for
discovery"* — alongside `paymentPayload.extensions.bazaar`. **Checked, and we are
not affected.** Intercepting the payload our buyer actually sends to a facilitator
(a verify-only call, so no funds moved) shows both fields present:

```
paymentPayload keys : x402Version, payload, extensions, resource, accepted
resource attached?  : YES
extensions.bazaar?  : YES
```

The `@x402/core` v2 schema models `resource` as optional, which is why this was worth
checking rather than assuming.

**3. Separately, their preflight rejects MCP input types.** Reported to #850 with
reproduction: `bazaar.info.input.method` fails as `"Skipped: input type is not http"`
for every MCP route, and declaring the method does not change it. Whether ingestion
runs the same check is the open question put to them.

Practical consequence: paying again would not help. Cause 1 is excluded, cause 2 is
untested, and cause 3 may be theirs to fix.
