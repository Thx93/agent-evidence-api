#!/usr/bin/env node
/**
 * x402-evidence — buy structured, cited web evidence for a question.
 *
 *   npx @thx93/x402-evidence "Is Company X a manufacturer of centrifugal pumps?" \
 *        https://company.example/about https://company.example/products
 *
 * There is no account, no API key and no signup. The endpoint answers
 * `402 Payment Required`; this client pays the quoted USDC amount on Base and
 * retries automatically, then prints the evidence.
 *
 * Requirements: a wallet private key holding a little USDC on Base, supplied
 * through X402_PRIVATE_KEY or X402_PRIVATE_KEY_FILE. It is read only from there
 * and is never logged, printed, or written anywhere.
 *
 * Options:
 *   --url <endpoint>   Override the endpoint (default: the public deployment)
 *   --max <usd>        Refuse to pay more than this per call (default 0.10)
 *   --json             Print the raw JSON response instead of a summary
 *   --dry-run          Show the quote without paying
 *   --address          Print the wallet address and exit, so a fresh wallet can
 *                      be funded before its first use
 */
import { readFile } from "node:fs/promises";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, formatUnits } from "viem";
import { base } from "viem/chains";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { wrapFetchWithPayment } from "@x402/fetch";

const DEFAULT_ENDPOINT =
  "https://agent-evidence-api.thx93workersdev.workers.dev/v1/evidence";
const NETWORK = "eip155:8453"; // Base mainnet
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// --------------------------------------------------------------------- args
const argv = process.argv.slice(2);
const flags = { json: false, dryRun: false, address: false, url: DEFAULT_ENDPOINT, max: 0.1 };
const positional = [];

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--json") flags.json = true;
  else if (a === "--dry-run") flags.dryRun = true;
  else if (a === "--address") flags.address = true;
  else if (a === "--url") flags.url = argv[++i] ?? DEFAULT_ENDPOINT;
  else if (a === "--max") flags.max = Number(argv[++i] ?? "0.1");
  else positional.push(a);
}

const question = positional[0];
const urls = positional.slice(1);

if (!question && !flags.address) {
  console.error(`usage: x402-evidence "<question>" [url ...] [--url <endpoint>] [--max <usd>] [--json] [--dry-run] [--address]

example:
  npx @thx93/x402-evidence "Is Rotamech Industries a manufacturer of centrifugal pumps?" \\
      https://example.com/about https://example.com/products`);
  process.exit(2);
}

// ---- local-only mode ---------------------------------------------------------
// Handled before any network call on purpose: the whole point is to obtain the
// address of a wallet that cannot pay yet, which must work even when the
// endpoint is down or the machine is offline.
if (flags.address) {
  const fromEnv = process.env.X402_PRIVATE_KEY;
  const fromFile = process.env.X402_PRIVATE_KEY_FILE;
  let k = fromEnv ?? null;
  if (!k && fromFile) {
    try {
      k = (await readFile(fromFile, "utf8")).trim();
    } catch (err) {
      console.error(`\n  ✖ X402_PRIVATE_KEY_FILE could not be read: ${fromFile} (${err.code ?? "error"})\n`);
      process.exit(1);
    }
  }
  if (!k) {
    console.error(`\n  ✖ --address needs X402_PRIVATE_KEY or X402_PRIVATE_KEY_FILE to be set.\n`);
    process.exit(1);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) {
    console.error("\n  ✖ the wallet key is not a 32-byte hex value starting with 0x.\n");
    process.exit(1);
  }
  const acct = privateKeyToAccount(k);
  console.log(`
  Wallet address : ${acct.address}

  Send USDC on the Base network to that address. Any amount works; this request
  costs a few cents. No ETH is needed for gas — the facilitator submits the
  payment.

  Check the balance at https://basescan.org/address/${acct.address}
`);
  process.exit(0);
}

function fail(msg) {
  console.error(`\n  ✖ ${msg}\n`);
  process.exit(1);
}

function decodeHeader(value) {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

// ------------------------------------------------------------- 1. the quote
const body = JSON.stringify({ question, urls, mode: "evidence" });

let quote;
try {
  const probe = await fetch(flags.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  if (probe.status !== 402) {
    fail(
      `expected 402 Payment Required, got ${probe.status}.` +
        (probe.status === 200 ? " (this endpoint is not charging)" : ""),
    );
  }
  const header = probe.headers.get("payment-required");
  if (!header) fail("402 returned without a PAYMENT-REQUIRED header");
  quote = decodeHeader(header).accepts?.[0];
  if (!quote) fail("no payment option offered");
} catch (err) {
  fail(`could not reach ${flags.url} — ${err.message}`);
}

const priceUsd = Number(quote.amount) / 1e6;
console.log(`\n  Endpoint : ${flags.url}`);
console.log(`  Network  : ${quote.network}`);
console.log(`  Price    : $${priceUsd.toFixed(4)} USDC`);
console.log(`  Pay to   : ${quote.payTo}`);

if (quote.network !== NETWORK) {
  fail(`unexpected network ${quote.network}; this client only pays on Base mainnet`);
}
if (!(priceUsd > 0) || priceUsd > flags.max) {
  fail(`price $${priceUsd} exceeds --max $${flags.max}; refusing to pay`);
}
if (flags.dryRun) {
  console.log("\n  --dry-run: quote above, nothing paid.\n");
  process.exit(0);
}

// --------------------------------------------------------------- 2. the pay
// The key may come from the environment or from a file. A file is offered
// because putting a private key on a command line leaks it into shell history
// and into `ps` output for every user on the machine.
let key = process.env.X402_PRIVATE_KEY;
if (!key && process.env.X402_PRIVATE_KEY_FILE) {
  const file = process.env.X402_PRIVATE_KEY_FILE;
  try {
    key = (await readFile(file, "utf8")).trim();
  } catch (err) {
    fail(`X402_PRIVATE_KEY_FILE could not be read: ${file} (${err.code ?? "error"})`);
  }
}

if (!key) {
  fail(`no wallet key found.

  This client needs a wallet holding a little USDC on Base. You have two options.

  ── 1. Generate a dedicated wallet (recommended) ────────────────────────────

      node -e "console.log('0x'+require('crypto').randomBytes(32).toString('hex'))" \
        > ~/.x402-key && chmod 600 ~/.x402-key
      export X402_PRIVATE_KEY_FILE=~/.x402-key

  Then fund the address this prints:

      node ${process.argv[1] ?? "buy.mjs"} --address

  ── 2. Use an existing wallet ───────────────────────────────────────────────

      export X402_PRIVATE_KEY=0x...

  Either way the key is read from the environment or a file and is never logged,
  stored, or sent anywhere. Use a dedicated low-balance wallet — not a wallet
  holding anything you care about.

  You do NOT need ETH for gas: the facilitator submits the transaction.`);
}
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
  fail(
    "the wallet key is not a 32-byte hex value starting with 0x. Check for " +
      "surrounding quotes or whitespace, and note that a mnemonic phrase is not " +
      "accepted here — only a raw private key.",
  );
}

const account = privateKeyToAccount(key);
const publicClient = createPublicClient({ chain: base, transport: http() });

const erc20 = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];
let balance = 0n;
let balanceKnown = true;
try {
  balance = await publicClient.readContract({
    address: USDC,
    abi: erc20,
    functionName: "balanceOf",
    args: [account.address],
  });
} catch {
  // The balance is ADVISORY. An unreachable RPC must never block a purchase:
  // defaulting to 0 and refusing would tell a funded buyer they have no money
  // and send them to a funding page they do not need. On-chain verification is
  // the authority - if the wallet really is empty, the facilitator says so
  // precisely ("ERC20: transfer amount exceeds balance").
  balanceKnown = false;
}

console.log(`  Wallet   : ${account.address}`);
console.log(`  Balance  : ${balanceKnown ? `${formatUnits(balance, 6)} USDC` : "unavailable (continuing anyway)"}`);

if (balanceKnown && balance < BigInt(quote.amount)) {
  const short = priceUsd - Number(formatUnits(balance, 6));
  console.error(`
  ✖ Not enough USDC on Base yet.

    Need     ${priceUsd.toFixed(4)} USDC
    Have     ${formatUnits(balance, 6)} USDC
    Short    ${short.toFixed(4)} USDC

    This service is paid in USDC on the Base network (chain id 8453).
    You do NOT need ETH for gas — the payment facilitator submits the
    transaction and covers it. You only need USDC.

    Send any amount of USDC on Base to:

        ${account.address}

    If you already hold USDC on another chain (Ethereum, Arbitrum, Polygon…),
    bridge it to Base:
        https://bridge.base.org

    If you have no USDC at all, the simplest route is a Coinbase account:
    buy USDC and withdraw it to the address above, choosing the Base network.
        https://www.coinbase.com/wallet

    ⚠ Send on the BASE network only. USDC sent on another chain to this address
      will not be visible here and this client cannot spend it.

    Then re-run exactly the same command.
`);
  process.exit(1);
}

console.log("\n  Paying…");
const started = Date.now();

const signer = toClientEvmSigner(account, publicClient);
const client = new x402Client().register(NETWORK, new ExactEvmScheme(signer));
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

let paid;
try {
  paid = await fetchWithPayment(flags.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
} catch (err) {
  fail(`payment failed — ${err.message}`);
}

if (paid.status !== 200) {
  // A 4xx/5xx from the resource server CANCELS settlement in x402, so the buyer
  // has not been charged. Say so plainly: a bare "paid request returned 502"
  // reads to a buyer as though their money is gone, and on a first purchase
  // that ambiguity is worse than the failure itself.
  const raw = await paid.text();
  let code = null;
  let message = null;
  try {
    const parsed = JSON.parse(raw);
    code = parsed?.error?.code ?? null;
    message = parsed?.error?.message ?? null;
  } catch {
    /* not the canonical envelope; fall back to the raw body */
  }
  console.error(`
  ✖ The service could not complete this request (HTTP ${paid.status}).` +
    (code ? `

    ${code}` : "") +
    (message ? `
    ${message}` : raw ? `
    ${raw.slice(0, 200)}` : "") +
    `

    You have NOT been charged. x402 cancels settlement whenever the resource
    server returns an error status, so no USDC moved for this request.

    This is a failure of the service, not of your payment. Fixing the cause
    (for example a source that cannot be reached) and re-running is safe.
`);
  process.exit(1);
}

const settleHeader = paid.headers.get("payment-response");
let tx = null;
if (settleHeader) {
  try {
    tx = decodeHeader(settleHeader).transaction ?? null;
  } catch {
    /* non-fatal */
  }
}

const result = await paid.json();
const elapsed = Date.now() - started;

// -------------------------------------------------------------- 3. the goods
if (flags.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`\n  ✓ Paid and delivered in ${elapsed}ms`);
  if (tx) console.log(`  Settlement tx: ${tx}`);
  console.log(`\n  Assessment: ${result.assessment.status.toUpperCase()}`);
  console.log(`  Basis     : ${result.assessment.basis}`);
  console.log(`\n  Sources (${result.sources.length}):`);

  for (const s of result.sources) {
    console.log(`\n   • ${s.title ?? "(untitled)"}`);
    console.log(`     ${s.final_url ?? s.requested_url}`);
    console.log(`     status ${s.status ?? "-"} · ${s.word_count ?? "-"} words · retrieved ${s.retrieved_at}`);
    if (s.content_hash_sha256) console.log(`     sha256 ${s.content_hash_sha256.slice(0, 24)}…`);
    for (const e of s.evidence ?? []) {
      console.log(`     [${e.relevance}] "${e.excerpt.slice(0, 160)}${e.excerpt.length > 160 ? "…" : ""}"`);
    }
    for (const w of s.warnings ?? []) console.log(`     ! ${w.code}: ${w.message}`);
  }

  if (result.limitations?.length) {
    console.log(`\n  Limitations:`);
    for (const l of result.limitations) console.log(`   - ${l}`);
  }
  console.log(`\n  request_id ${result.request_id} · ${result.processing_ms}ms server-side\n`);
}
