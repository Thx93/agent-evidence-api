# How large is the x402 buyer pool, actually?

Measured 2026-09-21. This document exists because "find more buyers" is a question
that can be answered with numbers, and the numbers say something the earlier
analysis got wrong in both directions.

Two earlier claims are corrected here:

1. **"Verification is 1% of search"** came from a 500-entry sample of a 15,213-entry
   catalogue. A sample cannot size a market, and this one was unrepresentative.
2. **"Retrieval has 1,649 distinct payers"** was a *sum of per-resource payer
   counts*. The same seller often publishes many resources behind a single payout
   address, so that sum counts the same wallet many times. The real number is
   measured on-chain below and is smaller.

## Method

| step | what was done | why it is trustworthy |
|---|---|---|
| Catalogue | Paged **all** 15,213 CDP Bazaar resources (`scripts/analyze-bazaar-demand.mjs`) | no sampling; the script reports how much it read |
| Deduplication | Re-grouped by **payout address** (`accepts[0].payTo`) | one seller's many routes are one seller |
| Payer counts | Read USDC `Transfer` logs to each payout address over a 7-day window (`scripts/count-x402-payers.mjs`) | `quality.l30DaysUniquePayers` is per-resource and provably inflated |
| Union | Scanned several payout addresses in one pass (`topics[2]` array = OR) | gives distinct **wallets**, not payer-slots |

Limits, stated up front: the categories are keyword heuristics (CDP publishes no
category field); the on-chain window is 7 days, so every wallet count is a **lower
bound** on 30 days; and a transfer to a payout address is taken as an x402 payment,
which for these addresses is what it is. `transfers` counts payments, not calls.

## What the catalogue contains

| | |
|---|---:|
| resources | 15,213 |
| distinct payout addresses (sellers) | **1,362** |
| sellers with ≥100 payers on any route | **6** |
| sellers with ≥10 payers | **141** |
| calls in 30 days (published) | 849,624 |
| share of calls from the top 10 sellers | **75.8%** |
| share from the single largest seller | **38.4%** |

15,213 endpoints is not 15,213 businesses. It is 1,362 payout addresses, and 141 of
them have more than ten buyers.

### The inflation artifact, measured

`api.onesource.io` publishes ~70 chain-data routes behind **one** payout address.
Each route reports a few hundred to ~900 unique payers; summed, they imply ~18,300.
On-chain, that address received transfers from **534 distinct wallets in 7 days**.
The per-resource field overcounted the wallets by roughly 34×. Any "category has N
payers" figure built by summing that field is wrong, including one this project
published earlier.

## What the chain says

Distinct wallets that actually paid, 7-day window, verified from USDC transfers:

| seller set | wallets | new vs the set above |
|---|---:|---:|
| top 15 sellers (76% of all catalogue calls) | **1,855** | — |
| sellers ranked 16–75 (60 more, all ≥10 payers) | 1,151 | **909** |
| **union of those 75 sellers (~80% of calls)** | **2,764** | — |
| retrieval/search-shaped top 15 | 932 | **0** |
| evidence-shaped top 11, excluding the token-verdict outlier | 228 | **11** |

The third row is the headline: **the entire paying population for the sellers that
take 80% of x402's call volume is 2,764 wallets in a week.** Adding sixty more
sellers added 909 wallets; the remaining ~1,290 sellers are smaller still, so the
ecosystem figure is plausibly in the low thousands, not tens of thousands.

### It is not a crowd. It is a few hundred loops.

Within those 1,855 wallets:

| | |
|---|---:|
| paid exactly once | 238 (12.8%) |
| made ≥100 payments | 421 (**22.7%**) |
| …and their share of all payments | **83.7%** |
| median payments per wallet | 10 |
| top 10 wallets' share of payments | 24.8% |

Roughly one wallet in four is an agent operator running a loop; they generate ~84%
of the volume. The rest are mostly one-off trials. This is the shape of the demand:
a few hundred operators, not a market of many buyers.

## The answer to "find more buyers"

**The pools are not separate.** The retrieval/search buyers (932) are entirely a
subset of the same 2,764 wallets — **zero new wallets**. The evidence-shaped buyers
(228) are almost all in that set too; only **11 wallets** buy evidence-shaped output
without also buying from the top 75 sellers.

The one useful cut is the intersection, not the union: **204 wallets paid both a
retrieval/search seller and an evidence-shaped seller** in the same week. Those are
the only wallets in the ecosystem demonstrably willing to pay for content *and* for
an assessment of it — the most qualified prospects that exist. Of those 204, only
**14** made 100+ payments across the two; the median is 4. That is the entire
addressable segment, measured, and there is no channel to them other than the
catalogue itself.

That is the finding, and it is more useful than a list of directories:

> Repositioning from "adjudication" to "verified retrieval" does not reach a new
> pool. It changes which product the *same* wallets are asked to buy. The earlier
> recommendation (reposition, and price at the retrieval median) may still be right
> on price and framing, but it is not a route to more buyers — there are no more
> buyers of this kind inside x402 to reach.

Two structural reasons, both measured:

- **The largest volume is not a market at all.** The single biggest resource
  (`blockrun.ai` chat completions, 326,493 calls in 30 days) has **183 payers** —
  about 1,800 calls per payer. Remove the top ten sellers and 24% of the catalogue's
  calls remain for ~1,350 sellers.
- **Evidence-shaped demand is 228 wallets, dominated by two.** Across the eleven
  busiest evidence-shaped sellers that are not the token-verdict entertainment
  service, two wallets produced 69% of all payments. Our own product's entire
  history is one operator wallet.

### The one adjacent pool that looks big, and is not ours

`ax1.vc`'s "q-verdict" has **2,511 payers** and 168,435 calls at **$0.02** — 6.7×
this service's price. On-chain it is real: **847 distinct wallets in 7 days**, 137
payments each on average. It is the widest pool in the whole catalogue.

It is also a different job: "send a Base token contract address, get an AI-written
verdict ... Entertainment". Those wallets pay for computed on-chain token analysis,
not for adjudicating a claim against public web sources. Copying that would not be
this product, and SPEC §1 says what this product is not.

### Outside x402

The MCP population is far larger than 2,764 — but it is a **different** population,
not a bigger version of this one. The mainstream MCP hosts are not x402 payers: the
PayAI catalogue carries 33 MCP-typed entries and the CDP Bazaar carries **one**,
against thousands of MCP servers overall. Discovery and payment barely intersect,
and the x402 integrations are AgentCore, the Bazaar MCP server and agentic.market —
all of which this service is already in or one settlement away from.

So the honest conclusion stands, now with numbers behind it: **the constraint is the
size of the paying population, and no amount of listing, repositioning or building
inside this product changes it.** The pool grows when the x402 rail grows — when
more agent frameworks give their agents wallets and a reason to spend. That is not
something this service controls.

## Reproduce

```bash
node scripts/analyze-bazaar-demand.mjs --refresh          # page all 15,213 resources
node scripts/count-x402-payers.mjs <payTo[,payTo]> 7      # chain-verified wallets
```

Both are committed. The first caches its snapshot under `data/` (gitignored).
