# The market outside x402, and what ax1.vc actually is

Researched 2026-09-21. Two questions were asked: is there a bigger buyer pool
outside x402, and can this service reposition to the widest pool inside it
(ax1.vc's token-verdict cards)? The answers are "no, not demonstrably" and "no, and
there is nothing there to reposition to". This file records how each answer was
reached, because both have a plausible-sounding opposite.

Method: the CDP Bazaar and the official MCP Registry were paged in full; wallet
counts were verified against USDC transfers on Base; third-party audits were
fetched and read as data rather than quoted; and vendor claims are labelled as
such throughout. Where a number is somebody's marketing, it says so.

---

## 1. ax1.vc: the widest pool in the catalogue is the operator paying itself

This is the single most important finding, because ax1.vc looks exactly like the
proof that a bigger market exists: **2,511 unique payers and 168,435 calls in 30
days at $0.02** — the widest payer base of any resource in the CDP Bazaar, and 6.7×
this service's price.

### What the service exactly is

`POST https://www.ax1.vc/api/dashboard/q-verdict/resource`, $0.02, Base mainnet:

```jsonc
// input
{ "requestKey": "<8-128 char idempotency key>", "tokenAddress": "0x…40 hex" }
// output
{ "grade": "BASED" | "MID" | "COOKED" | "RADIOACTIVE",
  "roast": "≤220 chars", "one_liner": "≤60 chars",
  "price": "$0.02", "disclaimer": "Not financial advice." }
```

Its own catalogue description: *"get an AI-written verdict: onchain metrics, a
plain-language take, and a shareable verdict card. **Entertainment, not trading
advice**."* The card is a server-rendered **PNG 1200×630** with a public permalink
and an X share intent. It is a joke about a token, and it is meant to be posted.

### The structure behind it

The operator is **AX1 Research LLC** (Wayne, NJ; X: `@ax1vc`, 18.3K followers),
an "agentic activities launchpad" — a research firm and ecosystem investor on
Base. Q-Verdict is **quest Q03** inside its Console, and the shipped front-end
describes the rail as `PAY → VERIFY → VERDICT → POINT`. Every account gets an
**agent wallet** (Coinbase AgentKit/CDP or Privy) which pays the $0.02 endpoint;
AX1 sponsors the gas.

The usage is the operator's, and the product says so itself:

> "**AX1 Console is #1 on @x402scan by active buyers. For the next 14 days, your
> first quest is on us.**"
> "**weekly USDC reward pool for the 300 most active agents**"
> FAQ: "**The weekly pool is subsidized by AX1 and is not funded by route fees.**"
> FAQ: "Promo credit cannot be withdrawn."
> FAQ: "Who pays gas for my agent? **AX1 does.**"

On-chain corroboration: in a 3,000-transfer sample the payTo had only **77 distinct
senders, with the top 6 producing 74%**; several payer wallets were funded with
exactly **0.10 USDC (= five verdicts)** from the same address, and a settlement
transaction carries AX1's CDP builder attribution in its calldata. x402scan
reports **167.78K requests, 2.52K buyers and $3.36K total volume** for the
lifetime of the route.

### Two corrections this forces

- **"$9.7k/month" was wrong.** An earlier measurement of mine extrapolated a
  single busy day ($324) to a month. The all-time figure is **$3.36K** over the
  route's whole ~14-day life. One day is not a rate — the spike was real and the
  extrapolation was not.
- **"2,511 payers" is a count of wallets, not of customers.** They are Console
  agent wallets, largely funded by AX1's own promo credit and looped to farm a
  leaderboard and a subsidised reward pool.

### And its audience is disjoint from everything else

Verified on-chain over the same 7-day window: of ax1.vc's **847** paying wallets,
**0** also paid any of the other eleven evidence-shaped sellers, and **0** paid any
of the top retrieval/search sellers. It is not a bigger version of this service's
pool; it is a separate population attached to one gamified product.

### Can we reposition to it?

**No — and this is not a close call.** There is no buyer pool to capture: the
demand is manufactured by AX1's reward pool, promo credit and X distribution. To
"reposition" would mean becoming a quest inside someone else's XP program, or
building one — a different product, a different company capability (token launch,
quests, rewards, Base-app distribution), and outside SPEC §1. The comparable
endpoints are also a small niche: a full catalogue crawl found **~5–10 roast/grade
resources out of 15,228**, one of which uses the *identical* grade vocabulary at
the same $0.02.

What is genuinely transferable, and is already true of this service's engine: a
short, opinionated, graded verdict; idempotency per subject; a flat price; and a
shareable artifact. The shareable card is a *distribution* mechanic, not a market.
Adding one would not create buyers, and the buyers who do exist for evidence-shaped
output are machine consumers, not people posting cards.

---

## 2. Is there a bigger pool outside x402?

### 2.1 The x402 market itself, independently audited

Fetched directly from [x402stats.io](https://x402stats.io/api/stats) (methodology
`2026-07-01.v1`, computed 2026-09-21T17:58Z), 30-day window:

| | |
|---|---:|
| sellers | 13,049 |
| volume | $990,498 (organic $869,079) |
| **median seller revenue** | **$0.08** |
| average payment | $0.043 |
| top-10 share of volume | **78.9%** |
| facilitators | Coinbase 38%, PayAI 22%, Figment 21%, mrdn 13% |

Half of all x402 sellers earn **less than eight cents a month**. That is the pool
this service is competing in, measured by an independent third party, and it agrees
with the on-chain count in [`buyer-pool.md`](./buyer-pool.md) (2,764 wallets for
the 75 sellers that take ~80% of calls).

### 2.2 Other agent-payment rails

| rail | can an agent pay a third-party API autonomously? | buying population | gate for a solo seller |
|---|---|---|---|
| **x402** | yes | ~4k distinct buyers/week; median seller $0.08/30d | none |
| **MPP** (Stripe + Tempo) | yes | 3.4M tx / **$429k cumulative**; ~30k tx/day (Stripe CEO, 2026-07-27) | Stripe business profile + bank; **$0.01 minimum** |
| **Nevermined** | yes (delegated card settles a 402) | ~1–2% of settled volume | free personal account |
| **ACP / OpenAI Instant Checkout** | no | **retired March 2026** | OpenAI policy **prohibits digital goods** |
| Visa Intelligent Commerce / Mastercard Agent Pay | via enablement partners only | pre-scale | enterprise |
| Virtuals / Olas / Fetch.ai | nominally | independent decoding: **5 unique senders/day** (Virtuals); **$109,407 lifetime** (Olas Mech) | n/a |
| L402 / Lightning | yes | adoption **unmeasurable** | none |

Three things decide it:

- **No rail has a demonstrably larger pool of buyers who pay for third-party
  micro-APIs.** MPP may have more *agents*, but about **1% of x402's volume**, and
  its **$0.01 minimum makes this service's $0.003 unsellable there** without
  repricing or bundling.
- **The flagship agent-checkout rail is gone.** OpenAI retired Instant Checkout in
  March 2026 and its app policy prohibits selling digital products — a ChatGPT app
  can never bill this API. ACP is physical-goods catalogue checkout.
- **Agent-token ecosystems are noise, not markets.** Independently decoded,
  Virtuals showed 5 unique senders on its latest day; Olas Mech has $109k of
  lifetime turnover.

The honest opportunity here is small and mechanical: a second rail behind the same
route (MPP, repriced; or Nevermined's delegated-card facilitator) widens the pool
from "a few thousand wallets" to "a few thousand wallets plus some delegated-card
agents". It does not change the shape of the problem.

### 2.3 MCP: a huge distribution pool with no payment layer

The official MCP Registry holds **40,000 server versions across 13,372 distinct
names** (paged in full from
`registry.modelcontextprotocol.io/v0/servers`), and third-party directories carry
tens of thousands more. That population is far larger than x402's — and it cannot
pay: no mainstream MCP host settles payments, the MCP specification defines none,
and a paid MCP server is invisible to a client that cannot pay it. The x402
catalogue carries **33 MCP-typed entries** (PayAI) and **one** (CDP Bazaar) against
40,000 registry entries. Discovery and payment are different populations that
barely intersect, and this service sits at the crossing.

### 2.4 The commercial market for the job

The job — "verify a claim against sources" — does have money behind it, but not in
the shape of a per-call verdict API:

- **The per-call grounding layer is commoditised by funded incumbents.**
  [Exa's `Answer`](https://docs.exa.ai/reference/pricing) is literally *"an LLM
  answer to a question, with citations"* at **$0.005/call**; the category has
  converged to **$0.0025–$0.01** (Brave Answers $0.004, Perplexity `web_search`
  $0.0025, Anthropic and OpenAI `web_search` $0.01). Exa raised $250M at a $2.2B
  valuation (May 2026); Tavily was acquired by Nebius for up to $400M.
- **x402 is a payment option bolted onto those card-billed businesses, not
  evidence of a paying agent market.** Exa supports x402 on `/search` and
  `/contents` only — *not* the citation-bearing `/answer` — and it is bypassed
  entirely when an API key is present.
- **The money is where consequence is.** Dow Jones Risk & Compliance booked
  **$392M in FY2026, +16% YoY** (audited, [News Corp 10-K](https://www.sec.gov/Archives/edgar/data/1564708/000156470826000175/nws-20260630.htm)),
  and identity verification clears at **$1.50 per verification** (Stripe Identity),
  with Socure at $364M disclosed ARR. Willingness to pay per unit tracks the cost
  of being wrong, not the difficulty of the work — a 150–600× spread over
  grounded search.
- **Fact-checking itself is a grant economy, not a market.** Full Fact's entire
  2025 income (£3,054,478) is donations and grants with no commercial line
  ([source](https://fullfact.org/about/funding/)); Google's ClaimReview API is
  free; Meta exited third-party fact-checking in January 2025.
- **Market-size reports here are unusable.** One vendor puts "AI hallucination
  detection" at **$1.45 trillion in 2025** — larger than global GDP. Only audited
  revenue, disclosed ARR, funding rounds and M&A prices are treated as hard numbers
  in this document.

### 2.5 The one adjacent product that fits this engine, and how it is doing

The most natural extension of this service's capabilities is not another claim
verifier — it is verifying **x402 resources themselves**. `x402-evidence-crosscheck`
does exactly that at **$0.01/call**: it compares a seller's Bazaar listing and
manifest against the live observed price, `payTo`, network, method and paywall,
returning field-level evidence with source, timestamp, hash and a signed receipt.

Its measured usage: **4 calls from 3 unique callers in 7 days** (OpenSea's own
counter). A correct, well-aimed product for the x402 economy has roughly three
buyers a week. That closes off the most attractive-looking "reposition" available.

---

## 3. Surfaces that were missing from the inventory

- **OpenSea operates an x402 Bazaar browser** at
  `opensea.io/tools/x402-bazaar`, populated automatically from the CDP Bazaar
  (`source: X402_BAZAAR`). This service is listed — `agent-evidence-api - Evidence`,
  tool id `6833681270043050642`, created 2026-09-21T15:54Z. It publishes
  independent usage counters and a live payment feed per tool, and its own
  category taxonomy. **Our counter reads 1 call, 1 unique caller in 7 days** — the
  operator's own payment — which is a third-party confirmation of zero outside
  demand. Of OpenSea's top 50 tools, **42 had no call in 7 days**.
- **OpenSea's categories, independently measured** (tools / calls in 7 days):
  trading 2,075 / 57,501 · other 4,963 / 14,307 · ai-agents 1,926 / 5,715 · nft 460
  / 3,178 · payments 2,865 / 3,164 · social 449 / 2,065 · defi 1,057 / 1,701 · data
  893 / 1,621 · dev-tools 310 / 839 · gaming 463 / 514 · identity 250 / 481.
  **There is no verification or evidence category at all.**
- **x402scan still does not carry this service** (`public.origins.search` returns
  `[]` for `thx93` and `agent-evidence`), confirming the earlier finding that its
  ingestion is incomplete rather than our being unlisted.
- The **MCP route is still absent from the CDP Bazaar** ~2.5 hours after its
  settlement, while the catalogue added entries during that window — see the
  observation recorded in [`market-analysis.md`](./market-analysis.md).

---

## 4. What is actually available, ranked

1. **Stop expecting reach to produce a buyer.** Median x402 seller revenue is
   $0.08/month; the top 10 sellers take 79% of volume; the evidence-shaped pool is
   228 wallets and the only two adjacent products that fit this engine have 3–4
   callers a week.
2. **If anything is built, position at consequence, not at commodity retrieval.**
   The only segment with audited money and a self-serve entry point is
   compliance/anti-financial-crime screening — adverse media, sanctions, PEP,
   due diligence — where ComplyAdvantage's entry tier is $99/month for monitored
   entities and OpenSanctions bills per query. That is a different buyer
   (regulated), a different product surface (audit trail, coverage, liability) and
   a different sales motion (contracts, not catalogue calls). It is buildable from
   this engine, and it is not what this repository currently is.
3. **A second payment rail is cheap and worth trying, with modest expectations.**
   MPP behind the same route (repriced to $0.01) or Nevermined's delegated-card
   facilitator. Expect a wider pool, not a large one.
4. **The remaining lever is human, not technical.** The 204 wallets that buy both
   content and assessments are the entire qualified segment, and there is no
   channel to them except the catalogue. The x402 Slack is where the people who
   build x402 buyers gather. That is outreach, and it is the only action on this
   list that could plausibly produce a first customer without the category needing
   to grow first.

**The honest summary:** there is no larger buyer pool to find. x402's paying
population is a few thousand wallets with a median seller earning eight cents a
month; no alternative rail has a demonstrably bigger one; the MCP population is far
larger but cannot pay; the job's real money is in compliance and identity, sold as
contracts; and the widest pool inside x402 is an operator paying its own agent
wallets to farm a reward pool. Building more will not change any of that.
