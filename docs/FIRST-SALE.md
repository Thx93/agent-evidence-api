# First sale — the one runbook

Everything else is built. This file is the shortest path from here to a settled
payment, and it is the only thing standing between this service and every buyer
who browses the x402 catalogue.

If you read nothing else: **run step 2.** It costs about $0.03 and it is the only
mechanism that makes this service discoverable to x402 buyers.

---

## 0. Current live facts

| | |
|---|---|
| Public endpoint | `https://agent-evidence-api.thx93workersdev.workers.dev` |
| Price | **$0.0300 USDC** per request |
| Network / asset | Base mainnet (`eip155:8453`), USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Payment goes to | `0x9c0e2B44180439294Fa30Ae2B2a94f8655455FD0` |
| MCP endpoint | `…/mcp` (tool `research_evidence`) |
| Buyer client | `…/buy.mjs` — one file, no install, no signup |

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
curl -fsSL https://agent-evidence-api.thx93workersdev.workers.dev/buy.mjs -o buy.mjs
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

```bash
node buy.mjs "Is Rotamech Industries a manufacturer of centrifugal pumps?" \
  https://en.wikipedia.org/wiki/Centrifugal_pump
```

Expected output:

```
✓ Paid and delivered in 812ms
Assessment: SUPPORTED
 • <source title> · status 200 · 412 words · sha256 ab0ac1fa…
   [direct] "<the passage that answers the question>"
```

**Why this is not just a test.** The x402 discovery catalogue holds ~6,600
services and has no submission endpoint — entries appear when a payment settles
through a facilitator. Until one settles, this service is invisible to the buyers
who browse x402 listings. This purchase is not a rehearsal for distribution; it
*is* the distribution event.

---

## 3. Confirm you are now discoverable

```bash
curl -s "https://facilitator.payai.network/discovery/resources?limit=1000" \
| grep -c agent-evidence-api      # → 1 once catalogued
```

And confirm the money moved, from the service side:

```bash
docker exec aee-live sh -c "grep -c '"payment_provided":true' /app/data/usage.jsonl"   # → 1
```

The catalogue check is the one that matters for discovery. The usage-log number
confirms a request carried a payment proof, which excludes operator and test
traffic — but it is **not** proof the money moved: the facilitator settles *after*
the backend responds. For the money itself, read the settlement transaction the
client printed, or the recipient address on
[basescan](https://basescan.org/address/0x9c0e2B44180439294Fa30Ae2B2a94f8655455FD0).

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

**Nothing appears in the catalogue** — cataloguing happens on settlement, which
can lag. Re-check step 3 after a minute. If the payment shows in step 3 but not in
the catalogue after several minutes, the facilitator did not record the bazaar
extension; that is worth reporting to them with the transaction hash.
