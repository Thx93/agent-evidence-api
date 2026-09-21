#!/usr/bin/env node
/**
 * Validate a catalogue payer count against the chain.
 *
 *   node scripts/count-x402-payers.mjs <payTo> [days] [rpc]
 *
 * Why this exists: `quality.l30DaysUniquePayers` in the CDP Bazaar is per RESOURCE,
 * and one seller often publishes many resources to a single payout address (the
 * api.onesource.io seller has ~23 chain endpoints behind one address). Summing the
 * field across resources therefore counts the same wallet many times, and the
 * category totals are inflated by exactly that. The only way to know how many
 * distinct wallets actually paid is to read the transfers.
 *
 * It counts distinct ERC-20 senders to `payTo` in a recent window. That is a lower
 * bound on the 30-day pool (a shorter window) and an independent check on the
 * published number.
 *
 * Range limit: every public Base RPC caps `eth_getLogs`. mainnet.base.org allows
 * 2,000 blocks, so the window is paged. ~43,200 blocks is about 24 hours.
 */
import { writeFileSync } from "node:fs";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const MAX_SPAN = 2_000;

// One address, or several separated by commas. `topics[2]` accepts an array with
// OR semantics, so several payout addresses can be scanned in one pass — which is
// what makes a UNION of paying wallets measurable instead of a per-seller count.
const payTos = (process.argv[2] ?? "")
  .split(",")
  .map((a) => a.trim().toLowerCase())
  .filter(Boolean);
const days = Number(process.argv[3] ?? 7);
const rpc = process.argv[4] ?? "https://mainnet.base.org";
const dumpPath = process.argv[5] ?? null;

if (payTos.length === 0 || payTos.some((a) => !/^0x[0-9a-f]{40}$/.test(a))) {
  console.error("usage: node scripts/count-x402-payers.mjs <payTo[,payTo...]> [days] [rpc] [senders.json]");
  process.exit(1);
}

const padded = payTos.map((a) => `0x${"0".repeat(24)}${a.slice(2)}`);
const toSet = new Set(payTos);

async function rpcCall(method, params, attempt = 1) {
  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    return json.result;
  } catch (err) {
    if (attempt >= 4) throw err;
    await new Promise((r) => setTimeout(r, 400 * attempt));
    return rpcCall(method, params, attempt + 1);
  }
}

const head = Number.parseInt(await rpcCall("eth_blockNumber", []), 16);
const blocksPerDay = 43_200; // Base ~2s blocks
const span = Math.min(days * blocksPerDay, head - 1);

const senders = new Map();
const txs = new Set();
let logs = 0;
let from = head - span;
const started = Date.now();
const totalChunks = Math.ceil(span / MAX_SPAN);
let done = 0;

while (from <= head) {
  const to = Math.min(from + MAX_SPAN - 1, head);
  const batch = await rpcCall("eth_getLogs", [
    {
      address: USDC,
      topics: [TRANSFER, null, padded],
      fromBlock: `0x${from.toString(16)}`,
      toBlock: `0x${to.toString(16)}`,
    },
  ]);
  for (const log of batch) {
    const recipient = `0x${log.topics[2].slice(26)}`;
    if (!toSet.has(recipient)) continue;
    logs += 1;
    txs.add(log.transactionHash);
    const sender = `0x${log.topics[1].slice(26)}`;
    senders.set(sender, (senders.get(sender) ?? 0) + 1);
  }
  from = to + 1;
  done += 1;
  if (done % 25 === 0 || done === totalChunks) {
    process.stderr.write(`\r  scanned ${done}/${totalChunks} chunks, ${logs} transfers, ${senders.size} senders`);
  }
}
process.stderr.write("\n");

const top = [...senders.entries()].sort((a, b) => b[1] - a[1]);
console.log(`payTo            : ${payTos.length === 1 ? payTos[0] : `${payTos.length} addresses (union)`}`);
console.log(`window           : ${span.toLocaleString()} blocks (~${(span / blocksPerDay).toFixed(1)} days) to block ${head}`);
console.log(`USDC transfers   : ${logs.toLocaleString()} in ${txs.size.toLocaleString()} transactions`);
console.log(`distinct senders : ${senders.size.toLocaleString()}`);
console.log(`transfers/sender : ${(logs / Math.max(senders.size, 1)).toFixed(2)}`);
console.log(`top senders      : ${top.slice(0, 5).map(([a, n]) => `${a.slice(0, 10)}…×${n}`).join("  ")}`);
console.log(`elapsed          : ${((Date.now() - started) / 1000).toFixed(0)}s`);

if (dumpPath) {
  writeFileSync(dumpPath, JSON.stringify({ payTos, days, senders: Object.fromEntries(senders) }, null, 2));
  console.log(`senders written  : ${dumpPath}`);
}
