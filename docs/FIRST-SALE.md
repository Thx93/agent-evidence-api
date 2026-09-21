# First sale — the one runbook

Everything else is built. This file is the shortest path from here to a settled
payment, and it is the only thing standing between this service and every buyer
who browses the x402 catalogue.

If you read nothing else: **run step 2.** It costs about $0.003 and it is the only
mechanism that makes this service discoverable to x402 buyers.

---

## 0. Current live facts

| | |
|---|---|
| Public endpoint | `https://agent-evidence-api.thx93.workers.dev` |
| Price | **$0.0030 USDC** per request |
| Network / asset | Base mainnet (`eip155:8453`), USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Payment goes to | `0x9c0e2B44180439294Fa30Ae2B2a94f8655455FD0` |
| MCP endpoint | `…/mcp` (tool `research_evidence`) |
| Buyer client | `…/buy.mjs` — one file, no install, no signup |
| Service version | `0.1.4` (backend `agent-evidence-api-backend:0.1.4` in container `aee-live`) |
| Settlements to date | **operator's own only** — 0.066 USDC, zero third-party customers |

Read that last row as the point of this document rather than a footnote: the service
is complete on every channel reachable from here, and no stranger has ever paid for
it. A runbook cannot fix that. What follows is the one mechanism that turns a route
into a catalogue entry; whether anyone then buys is a separate, unanswered question,
and [`market-analysis.md`](./market-analysis.md) is the honest read on it.

---

## 1. Create a wallet and fund it

You need USDC on Base. **You do not need ETH** — the facilitator submits the
transaction and pays the gas.

```bash
# Generate a dedicated key and keep it out of shell history.
node -e "console.log('0x'+require('crypto').randomBytes(32).toString('hex'))" \
  > ~/.x402-key && chmod 600 ~/.x402-key
export X402_PRIVATE_KEY_FILE=~/.x402-key
```

Print the address to fund (works offline, so it works even if the service is down):

```bash
curl -fsSL https://agent-evidence-api.thx93.workers.dev/buy.mjs -o buy.mjs
node buy.mjs --address
```

Send a small amount of USDC **on the Base network** to that address. $1 is far
more than enough. Two ways to get it:

- Already hold USDC elsewhere → bridge it: <https://bridge.base.org>
- No USDC at all → buy on Coinbase and withdraw to the address, choosing **Base**

> ⚠ Base network only. USDC sent on another chain to that address will not be
> visible to this client and cannot be spent by it.

---

## 2. Make the purchase

The HTTP route:

```bash
node buy.mjs "Is Rotamech Industries a manufacturer of centrifugal pumps?" \
  https://en.wikipedia.org/wiki/Centrifugal_pump
```

The MCP route — a **separate** catalogue entry, because x402 catalogues per route:

```bash
X402_PRIVATE_KEY_FILE=~/.x402-key node mcp-paid-client.mjs
```

Expected output:

```
✓ Paid and delivered in 812ms
Assessment: SUPPORTED
 • <source title> · status 200 · 412 words · sha256 ab0ac1fa…
   [direct] "<the passage that answers the question>"
```

**Why this is not just a test.** The x402 discovery catalogue has no submission
endpoint — an entry appears when a payment settles through a facilitator. Until one
settles, the route is invisible to the buyers who browse x402 listings. This purchase
is not a rehearsal for distribution; it *is* the distribution event. The HTTP entry
was created this way, and the MCP entry only exists after the MCP call above.

---

## 3. Confirm you are now discoverable

PayAI's catalogue (the one this service ranks first in):

```bash
curl -s "https://facilitator.payai.network/discovery/resources?limit=1000" \
| grep -c agent-evidence-api      # → 2 once both routes are catalogued
```

Coinbase's CDP Bazaar (the one that reaches the Bazaar MCP server and
agentic.market), and the whole catalogue rather than a page — the entry lands on the
last page:

```bash
node scripts/check-cdp-bazaar.mjs
# and the MCP shelf specifically:
curl -s "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=100&type=mcp" \
| node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log(j.pagination.total,"mcp entries");for(const e of j.items)console.log(" -",e.resource)})'
```

Confirm the money moved **on-chain**, not from the usage log:

```bash
docker exec aee-live sh -c "grep -c '"payment_provided":true' /app/data/usage.jsonl"
```

That count is not proof of payment: the facilitator settles *after* the backend
responds, so the log line is written first. Read the settlement transaction the client
printed, or the recipient balance on
[basescan](https://basescan.org/address/0x9c0e2B44180439294Fa30Ae2B2a94f8655455FD0).
`buyer/` has no balance helper; the reliable form is to read `asset` and `payTo` from
the live 402 challenge rather than retyping an address.

---

## 4. Then announce

Now that there is a catalogue entry behind the URL, post the launch copy:
[`announcements.md`](./launch/announcements.md). x402 Slack first.

Doing it in this order matters. Posting first sends readers to a service that
cannot yet be found by browsing.

---

## If something goes wrong

**"Not enough USDC"** — either the wallet really is empty (send USDC on Base), or
the RPC could not be read, in which case the client now proceeds and lets on-chain
verification decide.

**"The service could not complete this request (HTTP 4xx/5xx)"** — your money did
**not** move. x402 cancels settlement whenever the resource server returns an
error status. The message states the canonical error code and the reason. Fixing
the cause and re-running is safe.

**"no wallet key found"** — the message now prints the exact commands to generate
a wallet and to fund it.

**A route settled but does not appear in the CDP Bazaar.** Check the backend log for
the facilitator's own answer:

```bash
docker logs aee-live 2>&1 | grep 'extension responses'
# [x402] extension responses: {"bazaar":{"status":"processing"}}
```

`processing` means CDP accepted the declaration; it does not mean the entry is live.
Observed 2026-09-21: after an MCP settlement, `type=mcp` still returned one unrelated
entry and the full catalogue (15,211 resources) still held only the `/v1/evidence`
entry, ~15 minutes later. Two explanations remain open — indexing latency, or an
unstated shape requirement for MCP entries. The one catalogued MCP entry uses a
per-tool `resource` fragment (`https://mcp.memestack.ai/mcp#generate_meme#generate_meme`)
where ours is the bare `/mcp`; that is the first thing to vary if it never appears.
Varying it costs another settlement, so decide deliberately rather than repeatedly.

**PayAI shows the route but the manifest disagrees with the charge** — run
`bash scripts/check-readiness.sh`. It compares the Worker's `/.well-known/x402`
against the live 402 challenge and fails on any difference; the Worker's values are
display-only and can drift.
