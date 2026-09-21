# Only you can do these

Everything in this file requires a human: a wallet, an account, a decision, or a
payment. Nothing here is blocked on engineering.

**Last verified:** 2026-09-21 · service version 0.1.1

Run this at any time to see the current truth:

```bash
docker exec aee-live sh -c "grep -c '"payment_provided":true' /app/data/usage.jsonl"   # buyer requests
curl -s https://agent-evidence-api.taher-h-alhaddad.workers.dev/health?deep=1
```

---

## Already done — nothing for you here

| | Status |
|---|---|
| Backend + Worker deployed to public URLs | live on Base mainnet |
| Payment path verified end to end | simulated against the real USDC contract; only a balance was missing |
| Published to the MCP Registry | `io.github.Thx93/agent-evidence-api` **0.1.1**, active |
| One-command purchase client | `…/buy.mjs`, zero install, self-serve wallet |
| Landing page, catalogue metadata, docs | written, links checked, honest about limits |
| Failure behaviour | every failure refuses payment; verified under concurrency |
| Operations | health watchdog on a detached supervisor |

---

## 1. Make the first payment — 15 minutes · **the whole game**

This is not a test. The x402 catalogue holds ~6,600 services and has **no
submission endpoint**: entries appear when a payment settles. Until one settles,
this service is invisible to buyers browsing x402 listings. **This purchase is the
distribution event.**

```bash
# a dedicated wallet, kept out of your shell history
node -e "console.log('0x'+require('crypto').randomBytes(32).toString('hex'))" \
  > ~/.x402-key && chmod 600 ~/.x402-key
export X402_PRIVATE_KEY_FILE=~/.x402-key

curl -fsSL https://agent-evidence-api.taher-h-alhaddad.workers.dev/buy.mjs -o buy.mjs
node buy.mjs --address          # send ~$1 USDC on Base to this address
node buy.mjs "Is Rotamech Industries a manufacturer of centrifugal pumps?" \
  https://en.wikipedia.org/wiki/Centrifugal_pump
```

Full detail, including what each error means: [`FIRST-SALE.md`](./FIRST-SALE.md).

**Verify it worked:**

```bash
docker exec aee-live sh -c "grep -c '"payment_provided":true' /app/data/usage.jsonl"   # → 1
```

---

## 2. Confirm you are in the catalogue — 1 minute

Do this after step 1, before announcing anything.

```bash
curl -s "https://facilitator.payai.network/discovery/resources?limit=1000" \
| grep -c agent-evidence-api      # → 1
```

Catalogue propagation can lag a minute or two. If the payment landed (step 1) but
this stays `0` after several minutes, the facilitator did not record the bazaar
extension — report it to them with the transaction hash.

---

## 3. Post the launch copy — 15 minutes

Do this **after** step 2, so announcements point at a listing that can actually be
found. Copy is ready in [`launch/announcements.md`](./launch/announcements.md).

| Order | Channel | What to use |
|---|---|---|
| 1 | **x402 Slack** | the x402 post — the most likely to reach actual buyers |
| 2 | **X / Twitter** | the short thread |
| 3 | **Show HN** | the longer write-up |
| 4 | **MCP subreddits / Discord** | the MCP-framed post |

That file also lists where **not** to post yet, and why.

---

## 4. One decision I deliberately did not make for you

**The source is private.** The registry listing no longer links it (that link
returned 404 to every visitor), and the landing page no longer either. Nothing is
broken as it stands.

If you want buyers to be able to read the code, make the repository public and
then re-add the field — the exact steps, including how to check it is anonymously
readable first, are in [`registry-publication.md`](./registry-publication.md).
Correcting listing metadata requires a version bump; the registry rejects
duplicates.

---

## 5. Optional — only if you want them

| | What it needs | Why it might matter |
|---|---|---|
| **Durable public URL** | a domain (~$11/yr for `.com`) + a named Cloudflare tunnel | the current quick tunnel changes URL on restart. The Worker is re-pointed automatically by the watchdog, so this is cosmetic today, but a named tunnel removes the moving part |
| **Semantic ranking on by default** | ~2 GB RAM decision on the VPS | it finds answers lexical matching misses, at ~11 s vs ~1.4 s. Off by default; see the README |
| **npm publication** | a Granular Access Token with **Bypass 2FA** | not needed — `…/buy.mjs` already gives buyers a zero-install path |
| **Larger host** | a bigger VPS | only if you enable semantic ranking and want headroom |

---

## For the full picture

See [`ENGINEERING-REPORT.md`](./ENGINEERING-REPORT.md) — the §44 report, with the
architecture, every verification command, x402 and MCP status, and an honest §42
acceptance assessment (25 of 26 criteria met).

## What I could not do, and why

- **Fund a wallet.** Needs money and a human.
- **Make the first payment.** Same.
- **Post anywhere.** Needs your accounts.
- **Decide on repository visibility.** Your call; I flagged the trade-off rather
  than reversing it.
- **Verify settlement on mainnet.** It is verified to the last step — the
  facilitator simulates the real transaction and rejects it only for an empty
  wallet. The remaining gap is funds, not code.
