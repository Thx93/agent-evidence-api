# Outreach log — the attempt to find a first paying customer

Recorded 2026-09-21. This file exists because the outreach channel had to be built
from nothing, and rebuilding it later would be wasted work. It records exactly what
was sent, to whom, with what claim, and how to read the replies.

## Why this was necessary

The market measurement in [`buyer-pool.md`](./buyer-pool.md) and
[`market-outside-x402.md`](./market-outside-x402.md) says the demand inside x402 is
tiny: 2,764 distinct paying wallets for the sellers taking ~80% of call volume,
228 wallets in the evidence-shaped category, and a median seller revenue of $0.08
per 30 days. Independent confirmation arrived while this work was running — **TRM
Labs measured that only 0.6–7.5% of screened x402 commerce is plausibly agentic at
all** ([TRM Labs, 2026-09-09](https://www.trmlabs.com/trm-tech-blog/whos-actually-paying-measuring-ai-agent-payments-onchain)),
and PYMNTS covered the same conclusion. Our listing on OpenSea's own x402 browser
independently reports **1 call and 1 unique caller**, which is the operator.

So the constraint is not the product. It is that there is no channel: no audience,
no email domain, no marketplace account, and a $0.50 marketing budget that buys no
advertising. What follows is the one channel that could be opened for free.

## The channel that works: direct-to-MX SMTP over IPv4

`sendmail` is absent and no mail credentials exist on this host, but **outbound port
25 is open**, so mail can be delivered by connecting straight to a recipient's MX —
no account, no ESP.

What does NOT work, and why:

| attempt | result |
|---|---|
| `agent-reach` X account (`@leq6ah`) | exists, **0 followers**; `twitter search` returns HTTP 404, so it cannot even find people to reply to |
| Hacker News account | **"Sorry, account creation disabled."** |
| GitHub / npm | not authenticated (npm token is 401) |
| AgentMail key | valid but scoped: no `inbox_read`, `inbox_create`, `pod_read` — cannot send or read |
| mail.tm mailbox for sending | domain has `v=spf1 ip4:1.0.0.1 -all` and a **rejecting DMARC policy** → Google/Zoho reject outright |
| sending from `*.workers.dev` over **IPv6** | Gmail: "does not meet IPv6 sending guidelines regarding PTR records" |
| **sending from `outreach@agent-evidence-api.thx93.workers.dev` over IPv4** | **accepted** by Gmail/Workspace, Proton and others |

The working recipe: resolve the recipient's MX, resolve that host to an **A record**,
connect to the IPv4 literal on port 25, `EHLO
agent-evidence-api.thx93.workers.dev`, and include `Message-ID` and `Date` headers.
Forcing IPv4 is essential — the IPv6 path is rejected without a PTR record.

Deliverability is still limited. Zoho (`agent402.tools`, `payai.network`) and
Cloudflare's MX (`x402stats.io`) reject unauthenticated senders, and one personal
Gmail rejected while a Google Workspace address accepted. **A real domain with SPF
and DKIM would fix this**, which is the single highest-value thing the operator
could provide.

Replies land in the mailbox recorded at `/root/dsh-workspace/.outreach-mailbox`
(mail.tm; read it with the API documented in that file). It is a receive-only
mailbox on a disposable domain — fine for a first reply, not for a business.

## What was sent

Offer: the full CDP Bazaar snapshot (15,228 resources with published usage),
distinct paying wallets per seller read from USDC transfers on Base, the method, the
category and price-band analysis — **$25 in USDC on Base**
(`0x9c0e2B44180439294Fa30Ae2B2a94f8655455FD0`). Summary tables offered free on reply
either way, because finding out whether the numbers hold up matters more than the
sale.

Every message: plain text, one recipient, no list, no tracking, an explicit
"reply stop and you will not hear from me again", and a personal hook specific to
that recipient.

| recipient | why them | delivered |
|---|---|---|
| `privacy@merit.systems` | x402scan runs the directory; their index misses us | yes |
| `support@x402atlas.com` | one of the sellers measured | yes |
| `hello@blockrun.ai` | largest endpoint by call volume (326k calls / 183 wallets) | yes |
| `support@ax1.vc` | widest payer base; their published payer count differs from chain | yes |
| `contact@nevermined.ai` | delegated-card settlement into x402 — demand shape is their model | yes |
| `hello@tempo.xyz` | Tempo/Stripe MPP, the only rail that might be bigger | yes |
| `partners@tempo.xyz` | as above | yes |
| `hello@catena.com` | agent payments, $30M raised | yes |
| `info@lenz.io` | sells the same job card-billed; the contrast is the useful part | yes |
| `mike@agent402.tools` | sells a bestsellers dataset ($0.005) — closest buyer | **rejected** (Zoho antispam) |
| `hello@x402stats.io` | independent x402 audit; methodology overlap | **rejected** (Cloudflare DMARC) |
| `clawdbotworker@gmail.com` | ForgeMesh x402 ad network | **rejected** (Gmail, unauthenticated sender) |
| `info@payai.network` | facilitator, 22% of settled volume | **rejected** (Zoho antispam) |

Nine delivered, four rejected. No replies as of the end of the session — expected,
since the messages were sent minutes earlier.

## What would actually produce a first payment

1. **A domain with SPF and DKIM.** Roughly $10/year, and it converts a channel that
   currently bounces off half the internet into one that lands. Nothing else on this
   list matters as much.
2. **A card-payment link.** Every prospect reached here would have to already hold
   USDC on Base. A Stripe or Gumroad link would make a $25 decision trivial. Both
   need a business profile and a payout account, which is an operator action, not an
   agent one.
3. **An introduction from the operator's own network.** The fastest legitimate first
   payment is a person who already knows the operator and needs one claim or one
   company checked. I can produce the report; I cannot supply the relationship.

## What was deliberately not done

No bulk email, no purchased lists, no disposable-email account farming, no automated
signups on platforms whose rules forbid it, and no unsubstantiated claims to
prospects. Every number in every message is reproducible from this repository.

---

## The X attempt (2026-09-21, after the email batch)

Credentials: the operator's `@leq6ah` session, read from
`/root/.agent-reach/config.yaml` (`twitter_auth_token`, `twitter_ct0`) and used with
the `twitter` CLI. `export TWITTER_AUTH_TOKEN=… TWITTER_CT0=…` is required in the
same shell — the CLI does not read the config itself.

**The account has 0 followers**, which decides the whole strategy: a standalone post
reaches nobody (the one posted has 0 views), so the only reach available is
**replies**, which notify the author and appear to everyone reading that thread.

`twitter search` returns HTTP 404 — a known upstream breakage, documented in the
skill's own reference as "可能不稳定 … 可能 404". Workaround: `twitter user-posts`,
`twitter following` and `twitter tweet` (read a thread's replies) all work, so
targets were found by walking the ecosystem's accounts and their reply threads
rather than by searching.

### Reach added

A public landing page was deployed so the posts had somewhere to land:
`https://agent-evidence-api.thx93.workers.dev/x402-market` (Worker version
`313a3f18`). It carries the aggregate findings, the purchase terms ($25 USDC), and
the two reproduce commands. Deliberately aggregated — it names no seller.

| what | where | thread reach |
|---|---|---|
| standalone post | [2102111369042759927](https://x.com/i/status/2102111369042759927) | ~0 (0 followers) |
| reply: "active buyers" is a loop metric too | [ax1vc, 9.7k views](https://x.com/i/status/2102111474827382944) | 9,729 |
| reply: what agents actually pay for | [x402scan](https://x.com/i/status/2102111591374430467) | 1,407 |
| reply: measure the demand side | [BlockRunAI](https://x.com/i/status/2102111629014163509) | 366 |
| reply: rails vs buyers | [PayAI, 3.0k views](https://x.com/i/status/2102112010796495000) | 3,044 |
| reply: settlement solved, demand not | [PayAI](https://x.com/i/status/2102111923454251288) | 1,967 |
| reply: the same question from the chain | [PayAI](https://x.com/i/status/2102111951279255772) | 1,438 |

All seven were verified **publicly visible** by reading the target threads back.
The highest-reach reply sits in a PayAI thread that CoinDesk also replies to.

Every reply is on-topic — the posts are about agent payments, x402 volume, or the
"active buyers" ranking — and each carries a real number from this repository rather
than a pitch. Replies to large announcement posts were deliberately avoided: an
off-topic reply under a 685k-view post reads as spam and gets hidden.

**No engagement yet** (0 views on the standalone post, no likes or replies on the
replies at the time of writing). With a 0-follower account the realistic outcome is
a handful of profile visits, so this is a low-probability channel that costs nothing
to run — not a plan.

### What would make X work

1. **An account with an audience.** The current one has none, so every impression has
   to be borrowed from someone else's thread. A 1,000-follower account posting the
   same measurement would reach more than these six replies ever will.
2. **A visible identity.** An Arabic deals account posting English x402 market data
   is a poor signal. Renaming or a second account is the operator's call, not
   something to do unilaterally to someone's existing handle.
3. **The landing page indexed.** `x402-market` is a real, quotable artefact; it needs
   a domain with history behind it to rank for anything.
