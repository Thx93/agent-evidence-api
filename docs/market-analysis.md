# What the x402 market actually pays for

Measured 2026-09-21 from Coinbase's CDP Bazaar
(`https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources`), which is
the one catalogue that publishes **real usage**: every entry carries

```json
"quality": { "l30DaysTotalCalls": 985, "l30DaysUniquePayers": 981, "lastCalledAt": "..." }
```

500 entries sampled across five pages. This is the only demand evidence available
anywhere in the ecosystem, and it does not flatter this service.

## The category we are in barely exists

| category | services | total calls | total payers |
|---|---:|---:|---:|
| search | 81 | **84,041** | 1,267 |
| retrieval | 76 | 23,617 | **1,649** |
| crypto-data | 154 | 23,153 | 8,784 |
| other | 159 | 16,669 | 7,788 |
| **verification** | **22** | **833** | **302** |
| social | 8 | 182 | 97 |

**Verification is 1% of search by call volume**: 833 calls across 22 services in
thirty days, roughly **1.3 calls per service per day**. And most of those 22 are
false matches — liquidation maps, marine charts and token registries matched on the
word "verified" or "evidence" appearing in unrelated copy.

The market pays for **finding things** (search) and **fetching things**
(retrieval). It does not visibly pay for adjudicating them.

## Our price band is the weakest of the five

| price band | services | calls/service | payers/service |
|---|---:|---:|---:|
| < $0.003 | 161 | 200 | 29 |
| $0.003–0.01 | 122 | **287** | **105** |
| $0.01–0.03 | 156 | 448 | 11 |
| **$0.03–0.10** | **41** | **151** | **7** |
| ≥ $0.10 | 12 | 379 | 22 |

Median price across all 500 is **$0.005**; in the retrieval category it is
**$0.003**. This service charges **$0.03**, ten times the retrieval median.

Only **9 of 492** services at $0.03 or above clear 200 calls, and every one sells
something genuinely scarce — people search, contact enrichment, Google Trends. Not
generic utilities.

The shape is bimodal and unforgiving: **cheap with many payers, or expensive with
genuinely unique data.** $0.03 for a general-purpose utility sits in the trough —
priced out of the commodity market without being scarce enough to command a premium.

## What the winners do

The retrieval leaders, which is the category this service's capability most
resembles:

| calls | payers | price | what it is |
|---:|---:|---:|---|
| 8,723 | 6 | $0.002 | read a web page, extract content as markdown |
| 6,203 | 84 | $0.002 | Exa Contents — retrieve content from URLs |
| 2,402 | 9 | $0.003 | extract full text from specific URLs |
| 350 | 9 | $0.003 | article/main content from a URL or PDF to markdown |

Every one returns **content**, cheaply. None of them adjudicates anything.

## What this means for this service

Three honest options, in descending order of how much I would recommend them:

**1. Reposition as verified retrieval, and reprice to ~$0.003.** The service does
fetch and extract content, and it returns something the commodity extractors do
not: a content hash, a retrieval timestamp and an assessment per source. "Content
retrieval with provenance" is accurate and sits in the category with the most
distinct payers in the ecosystem (1,649). It requires dropping the price by 10× and
leading with retrieval language rather than verification language.

**2. Find a genuinely scarce angle and charge properly for it.** The ≥$0.10 band
averages 22 payers per service — worse than the cheap band but better than ours.
That band rewards unique data, not better plumbing. I do not currently know what
this service has that would qualify.

**3. Accept that x402 demand is elsewhere.** The service is live, correct, safe to
charge, and verified end to end. It may simply be early for what it sells, and the
honest conclusion is that the market data does not support more distribution work.

## What I did not do

**I did not change the price.** `X402_PRICE_USD` is one environment variable and a
redeploy — about thirty seconds — but pricing is a business decision, and the
evidence above points somewhere that contradicts the current positioning. That is
the operator's call, not mine.

I also did not rewrite the listing to chase retrieval keywords while the price
stays at 10× the category median: that would advertise into a market we cannot
compete in on price, and would misrepresent passages-and-an-assessment as raw
content extraction.

## How to act on this

The price is one variable, set per Worker environment:

```bash
grep -n X402_PRICE_USD apps/worker/wrangler.jsonc
#   33:  "X402_PRICE_USD": "0.003",    <- production (the deploy uses this one)
#   56:  "X402_PRICE_USD": "0.003",    <- env.dev
#   72:  "X402_PRICE_USD": "0.003",    <- env.test

# Change all three (a named environment does NOT inherit from the top level, which
# is why each carries its own copy), then redeploy:
cd apps/worker && wrangler deploy --env="" --var "BACKEND_ORIGIN_URL:$(cat ../../.origin-url)"
```

The manifest at `/.well-known/x402` derives its `accepts` from the same binding, so
it follows automatically and cannot disagree with the live challenge. The browser
landing page reads it too. Nothing else needs touching.

Re-measure the market at any time:

```bash
curl -s "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=100" \
| python3 -c "
import json,sys
for e in json.load(sys.stdin)['items'][:10]:
    q=e.get('quality') or {}
    a=(e.get('accepts') or [{}])[0]
    print(q.get('l30DaysTotalCalls'), 'calls', q.get('l30DaysUniquePayers'), 'payers', a.get('amount'),
          (e.get('resource') or '')[:60])
"
```

---

# The channel that actually matters — and we are not in it

Everything above is about competing in a market. This is about being in one at all.

## The CDP Bazaar is where the volume is

Coinbase's own documentation is blunt about what the Bazaar reaches:

> *"Getting discovered makes your endpoint available to **tens of thousands of
> agents** through CDP APIs, the **Bazaar MCP server**, and **Amazon Bedrock
> AgentCore**, and to people browsing **agentic.market**. The x402 Bazaar lists
> more than **23,000 x402 resources**."*

**This service is not in it.** Verified by sampling 500 of its entries: zero
occurrences. It is listed in the PayAI facilitator catalogue, in the MCP Registry,
in Agent402's index and in 402 Index — but not in the largest catalogue of all,
and not in the one that feeds Amazon Bedrock.

## Why not, and what it costs to fix

The Bazaar is populated through the **CDP Facilitator**, not through the open
catalogue. We settle through PayAI's facilitator, so our routes are invisible to it.

The CDP Facilitator is:

| | |
|---|---|
| Cost | **Free for the first 1,000 onchain transactions per month**, then $0.001 each |
| Extras | OFAC and Know-Your-Transaction screening on every settlement |
| Requirement | A Coinbase CDP account and an **API key ID + secret** |

This service has processed **two** payments in its life. The free tier is 1,000 a
month.

## It is already wired — it needs two environment variables

The Worker now selects its facilitator from credentials:

```ts
const useCdp = Boolean(env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET);
const facilitator = useCdp
  ? createCdpFacilitatorClient({ apiKeyId, apiKeySecret })   // -> CDP, and the Bazaar
  : new HTTPFacilitatorClient({ url: env.X402_FACILITATOR_URL }); // -> PayAI, today
```

Both are an `HTTPFacilitatorClient`, so nothing downstream changes. **Without the
credentials the behaviour is byte-for-byte what it was** — verified after deploying:
same 402, same challenge, same settlement simulation.

To switch settlements to CDP and become eligible for the Bazaar:

1. Create a Coinbase CDP account and an API key (free):
   <https://docs.cdp.coinbase.com/x402/seller/quickstart>
2. Add both values as Worker secrets — **never in the repository**:

   ```bash
   cd apps/worker
   wrangler secret put CDP_API_KEY_ID
   wrangler secret put CDP_API_KEY_SECRET
   wrangler deploy
   ```
3. Confirm the switch took effect and then confirm the listing appears:

   ```bash
   curl -s "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=100" \
   | grep -c agent-evidence-api     # 0 today, 1 once the Bazaar picks it up
   ```

## Which recommendation this changes

The three options earlier in this document assumed we were competing inside a
market we could already reach. We are not. **Entering the CDP Bazaar is a
prerequisite for every one of them**, it costs nothing at our volume, and it is
gated only on two credentials that take a few minutes to create.

I would do this before repricing, before more directory submissions, and before
any further positioning work — because none of it is visible to the agents that
matter until this is done.

## CDP readiness, measured rather than assumed

Coinbase publishes a validation endpoint, and **no API key is required**:

```bash
curl -X POST https://api.cdp.coinbase.com/platform/v2/x402/validate \
  -H 'content-type: application/json' \
  -d '{"resource":"https://agent-evidence-api.thx93.workers.dev/v1/evidence","method":"POST"}'
```

**The HTTP endpoint passes 25 of 25 checks, 0 required failures, 0 advisories**,
with `valid: true` and `simulation.outcome: "accepted"` — including the whole
bazaar block: input metadata, POST method matching the probe, output example and
schema. Whatever else is wrong, the declaration itself is exactly what CDP wants.

The MCP route reports `valid: false`, but the reason is not a defect:

> `"transport type mcp cannot be validated via live probe — check index status to
> confirm it is indexed"`

Their validator cannot probe an MCP transport, and the one check that "fails" is
`bazaar.info.input.method: Skipped: input type is not http` — expected for an MCP
entry, whose input type is `mcp`. Its indexing has to be confirmed from index
status, not from a probe.

### One deployment-breaking mistake, found and fixed

Importing `createCdpFacilitatorClient` pulls `@coinbase/cdp-sdk/x402` into the
Worker bundle, and that module statically imports `@x402/svm/*` — an **optional**
peer dependency that is not installed. Six unresolved imports followed, and
**every deployment failed**, CDP-related or not. A deploy that fails to build still
prints nothing that looks like an error if you are grepping for the success line,
which is how it went unnoticed for a round.

Fixed with an alias in `wrangler.jsonc` to `stubs/x402-svm.js`. That is safe and
verified, not hopeful: `facilitator.js` — the only module imported — contains **zero**
SVM references, and the SVM schemes are instantiated only inside
`getCdpDefaultSchemes()`, which this service never calls. The stub documents the
one condition under which it would break.

### The MCP gate, inverted

The MCP gate used to charge only for `tools/call research_evidence` and pass
everything else through, so a request it did not recognise fell to the transport,
which answered `406` when the caller had not sent MCP headers. It now treats the
**discovery surface as free** (`initialize`, `notifications/*`, `tools/list`,
`resources/list`, `prompts/list`, `ping`, and the free `health` tool) and requires
payment for **everything else** — matching the HTTP route, where the paywall comes
before validation.

Stated plainly: I made this change to fix a CDP validation failure that turned out
not to be fixable this way, because CDP cannot probe MCP at all. It stands on its
own merits — a paid route should present its challenge before validating, and a
generic prober now receives a 402 instead of a 406 — but it did not achieve what I
first claimed for it.

## agentic.market: the Bazaar is the gate to Coinbase's own marketplace too

Found by working the "reach buyers directly" line of the objective. **agentic.market**
describes itself as *"Thousands of services. Zero API keys. Powered by x402"* and is
**operated by Coinbase** — its own footer says so, and its only external link is to
the CDP x402 documentation. It carries a human-facing search, a seller page, and a
`/validate` tool whose stated job is to check whether an endpoint is *"correctly
configured and indexed on the Bazaar"*.

Its FAQ answers the question that matters:

> *"Do I need to register to get my service/endpoints discoverable via Search? If
> your service/endpoints are indexed on the Bazaar, you'll **automatically show up
> on agentic.market**."*

So there is no separate submission path, and no second marketplace to join. One
gate controls both:

| reachable today | gated on the CDP Facilitator |
|---|---|
| PayAI Bazaar — #1 for 5 of 6 buyer queries | CDP Bazaar — 15,141 resources |
| 402 Index — listed, verified | agentic.market — Coinbase-operated, human + agent facing |
| MCP Registry — name-only search | Bazaar MCP server |
| Agent402 — indexed, router gated on settlements | Amazon Bedrock AgentCore |
| glama.ai — listed, 4.3/5.0 | |

Checked directly: agentic.market returns zero mentions of this service, which is
what "not indexed on the Bazaar" predicts.

Every channel on the left is one we already rank well in, and the objective's first
three items are complete on all of them. Everything on the right opens with the same
two credentials, and our endpoint already passes the CDP validator 25 of 25. The
`seller tools` page on agentic.market even exposes the same validation the CDP docs
describe, so the readiness has been confirmed from two independent directions.

This is the clearest statement of the remaining problem: **the work is done on every
surface we can reach, and the next five surfaces are one credential away.**

## Outcome: repriced to $0.003 on 2026-09-21

Option 1 above was taken, with the operator's explicit authorisation.

`X402_PRICE_USD` moved from `0.03` to `0.003` in all three Wrangler environments,
and the 402 Index listing was updated to match. Verified live rather than assumed:
the 402 challenge, the `/.well-known/x402` manifest and the CDP validator all
report `3000` atomic units = $0.0030, and CDP's validator still returns
`valid: true` with zero required failures.

### The reprice exposed a latent bug that had been giving the service away

Changing the price to a sub-cent value made the live paywall request **ZERO USDC**.
`priceString` ended in `n.toFixed(2)`, so `0.003` rendered as `"$0.00"`. CDP's
validator rejected the endpoint for falling under its $0.001 minimum, which is how
it was caught.

It had been latent for the entire life of the service. `$0.03` is the one sub-dollar
price that two-decimal rounding renders correctly, and `$0.03` was the only price
ever configured. The bug was not "introduced" by repricing — repricing was the first
thing that could reveal it.

Fixed by preserving decimals up to USDC's 6, and by removing a hard-coded `"$0.03"`
fallback that would have silently charged a price nobody configured: an unusable
price now makes the paid route refuse to serve. `priceString` moved into
`@aee/schemas` so it could carry a test — a Worker module cannot be imported by the
Node test runner, which is why it had none. 13 regression tests now cover it,
including that no positive input ever renders as zero.

The lesson worth keeping: **the first thing a configuration change should do is
prove the old value is gone.** I checked the manifest and the CDP validator after
deploying; the manifest was correct and the challenge was not, and only looking at
both found it.
