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
#   33:  "X402_PRICE_USD": "0.03",     <- production (the deploy uses this one)
#   56:  "X402_PRICE_USD": "0.03",     <- env.dev
#   72:  "X402_PRICE_USD": "0.03",     <- env.test

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
