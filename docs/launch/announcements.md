# Launch kit — copy-paste posts

Everything here is ready to post. Replace nothing except where marked `[ ]`.
Post from **your** accounts — I cannot post on your behalf.

**The one-line pitch:** *A pay-per-call API that gives AI agents cited, timestamped
web evidence. No account, no API key — the agent pays 3¢ in USDC and gets an
answer it can cite.*

---

## 1. x402 Slack — highest intent audience

Channel: `#showcase` or `#general` (http://slack.x402.org/)

> **Live mainnet x402 endpoint: Agent Evidence API**
>
> I've just shipped a paid x402 endpoint on Base mainnet, and it's in the MCP
> Registry: `io.github.Thx93/agent-evidence-api`
>
> **What it does:** you send a question + URLs, it fetches the public sources,
> extracts cited excerpts with provenance (final URL, retrieval timestamp,
> SHA-256 of normalised content) and returns an explicit
> `supported`/`contradicted`/`mixed`/`inconclusive` assessment.
>
> **See the paywall with no wallet at all:**
> ```
> curl -X POST https://agent-evidence-api.taher-h-alhaddad.workers.dev/v1/evidence \
>   -H 'content-type: application/json' \
>   -d '{"question":"Is Rotamech a manufacturer of centrifugal pumps?","urls":["https://example.com"]}'
> ```
> You'll get a 402 with the payment requirements.
>
> **Or as an MCP tool:** `https://agent-evidence-api.taher-h-alhaddad.workers.dev/mcp`
> (`research_evidence` is paid, `initialize`/`tools/list`/`health` are free)
>
> **Buy it with zero install** — one file, no npm account, no signup:
> ```
> curl -fsSL https://agent-evidence-api.taher-h-alhaddad.workers.dev/buy.mjs -o buy.mjs
> X402_PRIVATE_KEY=0x... node buy.mjs "Is Rotamech a manufacturer of centrifugal pumps?" https://example.com
> ```
> It signs one USDC payment, retries, and prints the cited evidence.
>
> A design decision worth calling out if you build on x402: the middleware
> settles any handler response below 400, so it is on you to make every failure a
> 4xx/5xx. I found mine returning `200 inconclusive` when every source failed —
> which would have charged a buyer for an empty result. It now fails with
> `NO_SOURCES_RETRIEVED` and takes nothing. Partial success still bills.
>
> I verified the payment path without spending anything: a throwaway unfunded
> wallet signs a real EIP-3009 authorization, and the facilitator simulates it
> against the live USDC contract. The only rejection reason is
> `invalid_exact_evm_insufficient_balance`, which means the plumbing is correct
> end to end. Useful trick if you're building on x402 — you can prove your
> settlement path works before you fund anything.
>
> Two things I learned the hard way, in case they save anyone else time:
> 1. The public x402.org facilitator is **testnet-only** — it advertises no
>    `eip155:8453` route and a mainnet deploy fails at runtime with a
>    `RouteConfigurationError`. I moved to a facilitator that supports Base mainnet.
> 2. There are public mainnet facilitators that need **no account or API key**,
>    which makes this viable for a solo builder. Check `/supported` before you pick.
>
> It declares the `bazaar` discovery extension, so it should get catalogued once
> the first payment settles. Feedback very welcome — especially on whether the
> assessment output is useful to your agents.

---

## 2. X / Twitter — short version

> I built an API that sells web evidence to AI agents.
>
> No signup. No API key. The agent hits it, gets a 402, pays 3¢ in USDC on Base,
> and receives cited excerpts with a supported/contradicted/inconclusive verdict.
>
> [screenshot of the 402 response]
>
> It's live, on mainnet, and in the MCP Registry. 🧵

Follow-up posts:

> 2/ The hard part wasn't the AI. It was that the "official" x402 facilitator is
> testnet-only — it advertises no Base mainnet route, so your first mainnet deploy
> 500s with a RouteConfigurationError that looks like your bug and isn't.

> 3/ Every URL is treated as hostile: private/loopback/link-local/cloud-metadata
> IPs, octal-and-decimal encoded IP tricks, dangerous ports, and redirects into any
> of those are refused. DNS is re-validated *at connect time*, which is what
> actually stops DNS rebinding.

> 4/ The design rule I hold hardest: it never emits a confidence score it can't
> justify. If the text doesn't clearly support or contradict you, it says
> `inconclusive`. Evidence, not truth.

> 5/ It's pay-per-call, which means I have no idea if anyone wants it. If you run
> agents that need to check facts, I'd love 5 minutes of your honesty:
> https://agent-evidence-api.taher-h-alhaddad.workers.dev

---

## 3. Show HN

Title:
> **Show HN: Pay-per-call web evidence API for AI agents (x402, USDC on Base)**

Body:

> I kept hitting the same problem: an agent makes a factual claim, and there's no
> cheap, programmatic way for it to get *cited* evidence rather than another
> model's opinion.
>
> So I built one. You POST a question plus candidate URLs; it fetches the public
> sources, extracts short excerpts with full provenance (final URL after
> redirects, retrieval timestamp, SHA-256 of the normalised content, publisher,
> publication date, JSON-LD/OpenGraph), and returns an explicit
> supported / contradicted / mixed / inconclusive assessment.
>
> Payment is x402: plain HTTP 402, settled in USDC on Base. No account, no API
> key, no signup — the agent pays 3¢ and retries. There's also a remote MCP
> server so an agent can call it as a tool.
>
> Things I'd genuinely value feedback on:
>
> - **Is the output useful to an agent?** The assessment is deliberately
>   deterministic lexical matching, not an LLM. It never invents a fact and never
>   emits a confidence score, and it says `inconclusive` when the text doesn't
>   clearly support or contradict. That's honest, but it may be too weak to be
>   worth 3¢.
> - **Would you rather it found the sources itself?** Right now you supply the
>   URLs, so it's a processor rather than a source of information. That's the
>   limitation I'm least sure about.
> - **Is the payer the agent or the developer?** My read is that agents don't feel
>   token costs, so the buyer has to be a platform that does.
>
> Security was the bulk of the work: SSRF defence with per-hop redirect
> validation, connect-time IP re-validation (DNS rebinding), decompression-bomb
> limits, bounded concurrency, and a backend that refuses to start without a
> shared secret. 240 tests, and the repo's docs are honest about the gaps.
>
> The most useful bug I found was one my own tests could not have caught: every
> network test used 127.0.0.1 literals, which skip DNS entirely. Node's
> happy-eyeballs path asks the resolver for an array and my custom resolver
> returned a string, so every real hostname failed while the whole suite stayed
> green. It only surfaced when I ran the live pipeline against Wikipedia. If you
> build anything that does its own DNS validation, test it against a real
> hostname.
>
> Live: https://agent-evidence-api.taher-h-alhaddad.workers.dev
> Registry: io.github.Thx93/agent-evidence-api
>
> It's in the MCP Registry and on Base mainnet. I'm a first-time seller, so
> blunt feedback is more useful to me than encouragement.

---

## 4. r/mcp, r/LocalLLaMA, r/AI_Agents

Title:
> **I published a paid MCP server to the official registry — here's what the payment flow actually looks like**

> The MCP Registry now has servers that charge per tool call via x402 (HTTP 402 +
> USDC on Base). I published one: `io.github.Thx93/agent-evidence-api`.
>
> The part I think is interesting for MCP authors: **`initialize` and
> `tools/list` are free, and only `tools/call` on the paid tool costs money.**
> An agent has to be able to discover your tools before it can decide to pay for
> one. Charging at the transport level breaks discovery entirely.
>
> ```
> POST /mcp  {"method":"tools/list"}                        → 200, free
> POST /mcp  {"method":"tools/call","params":{"name":"research_evidence",…}}  → 402, 0.03 USDC
> POST /mcp  {"method":"tools/call","params":{"name":"health"}}               → 200, free
> ```
>
> Happy to write up the mechanics (facilitator selection, the testnet-only trap,
> the bazaar discovery extension) if useful.

---

## 5. Where NOT to post yet

- **Product Hunt / Hacker News front page pushes** — wait until you have at least
  one real user. An empty product getting attention wastes the one shot you get.
- **Paid ads** — you'd be paying to send traffic to an unvalidated offer.
- **Cold DMs** — high effort, near-zero conversion for a first-time seller.

---

## 6. The honest thing to say if someone asks "does anyone use this?"

> Not yet — I shipped it this week and you'd be the first. That's exactly why I'm
> posting: I'd rather find out it's not useful now than after building more.

Do not inflate traction. The x402 and MCP communities are small, technical, and
they will check. Being the person who shipped something real and said so honestly
is worth more than a fake launch.

---

## Sequencing note: the first payment is a distribution step

The x402 discovery catalogue holds ~6,600 services and has no submission endpoint -
entries appear when a payment settles. So the first purchase is not only a test: it
is what makes this service visible to buyers browsing x402 listings.

That argues for doing the two actions in this order:

1. Make the first (self-)purchase. It proves settlement and puts the service in the
   catalogue. Keep the amount small; the point is the settled transaction.
2. Then post the launch kit. Announcements now have a live catalogue entry behind
   them instead of a URL a reader has to take on faith.

Doing it the other way round sends traffic to a listing that cannot yet be found
by browsing.
