# x402-evidence

**Buy structured, cited web evidence for a question. Pay per call with USDC on Base.**

No account. No API key. No signup. No subscription. One command, one payment, one answer.

**Nothing to install** — the service serves this client as a single self-contained file:

```bash
curl -fsSL https://agent-evidence-api.thx93workersdev.workers.dev/buy.mjs -o buy.mjs
export X402_PRIVATE_KEY=0x...        # a wallet holding a little USDC on Base
node buy.mjs "Is Company X a manufacturer of centrifugal pumps?" \
    https://company.example/about https://company.example/products
```

Or, if you prefer npm:

```bash
npx @thx93/x402-evidence "your question" https://source.example
```

## What you get back

Not a prose summary — a structured evidence package you can cite:

- **An explicit assessment**: `supported` · `contradicted` · `mixed` · `inconclusive`
- **Per-source provenance**: requested URL, final URL after redirects, HTTP status, retrieval timestamp
- **Short quoted excerpts**, each tied to the source it came from
- **A SHA-256 of the normalised content**, so you can prove nothing changed underneath you
- **Document metadata**: title, publisher, canonical URL, language, publication/modified dates, JSON-LD, Open Graph
- **Honest limitations**, including when the evidence is inconclusive

## Why an agent would pay for this

Your agent can fetch a page. What it usually can't do reliably:

- **Fetch safely.** Every URL is treated as hostile: private/loopback/link-local/cloud-metadata addresses, decimal-and-octal-encoded IP tricks, dangerous ports, and redirects into any of those are all refused. DNS is re-validated *at connect time*, which is what defeats DNS rebinding.
- **Get a citation, not an opinion.** Every excerpt carries the URL it came from, when it was retrieved, and a content hash. "The model said so" is not evidence.
- **Compare sources.** Two sources that disagree produce `mixed`. That is the interesting answer, and it is the one a single-page read cannot give you.
- **Stay cheap.** Pulling five pages into context costs far more in tokens than $0.03, and burns context window you need elsewhere.
- **Skip the plumbing.** Bounded concurrency, response-size caps, decompression-bomb defence, timeouts, a TTL'd cache, and structured errors are already handled.

## Payment flow

This is [x402](https://x402.org): plain HTTP, settled in USDC on Base.

```
you  ──POST /v1/evidence────────▶  402 Payment Required  (+ PAYMENT-REQUIRED header: price, network, recipient)
you  ──pay USDC, retry with PAYMENT-SIGNATURE──▶  200 OK  (evidence)
```

This CLI does all of that for you. If you'd rather do it yourself, any x402
client works against the same endpoint.

- **Network**: Base mainnet (`eip155:8453`)
- **Asset**: USDC
- **Price**: $0.03 per request
- **Recipient**: published in the 402 response — the endpoint never sees your key

## MCP (for agents)

The same capability is exposed as a remote MCP server, so an agent can call it as
a tool:

```
https://agent-evidence-api.thx93workersdev.workers.dev/mcp
```

Tools:

| Tool | Cost | What it does |
|---|---|---|
| `research_evidence` | $0.03 | Fetch public sources, return cited evidence and an assessment |
| `health` | free | Liveness and version |

`initialize` and `tools/list` are **free** — an agent can discover the tools
before deciding to pay for one. Only an actual `research_evidence` call is charged.

```json
{
  "mcpServers": {
    "evidence": {
      "type": "streamable-http",
      "url": "https://agent-evidence-api.thx93workersdev.workers.dev/mcp"
    }
  }
}
```

## Verify the payment path without spending anything

```bash
node verify-payment-path.mjs
```

This signs a real EIP-3009 `transferWithAuthorization` with a throwaway unfunded
wallet and asks the facilitator to verify it. Because the facilitator *simulates*
the transfer against the live USDC contract, the rejection reason tells you how
far the path got. Expected:

```
invalidReason: "invalid_exact_evm_insufficient_balance"
  → the plumbing is correct; the wallet merely has no USDC
```

Any other reason (format, scheme, network, signature) means a real defect.
Exits non-zero only in that case, so it works as a pre-flight check.

## Options

```
--url <endpoint>   override the endpoint
--max <usd>        refuse to pay more than this per call (default 0.10)
--json             print the raw response
--dry-run          show the quote without paying
```

## Required environment

| Variable | Meaning |
|---|---|
| `X402_PRIVATE_KEY` | A wallet private key holding a little USDC on Base |

Read from the environment only. Never logged, stored, or transmitted anywhere
except as a signed payment authorisation. **Use a dedicated low-balance wallet.**

## Honest limitations

- Assessment is **deterministic lexical matching**, not semantic reasoning. It
  never invents a fact and never emits a confidence score, and it returns
  `inconclusive` when the text does not clearly support or contradict. Read the
  `basis` and the excerpts; do not treat the status as ground truth.
- You supply the URLs. There is no web search.
- Excerpts are deliberately short. This is not a content-download service.
- Not every URL is accessible — paywalls, logins and bot protection are not
  circumvented, by design.

Evidence, not truth.

## Licence

MIT
