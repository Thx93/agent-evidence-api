#!/usr/bin/env node
/**
 * Pay for an MCP tool call.
 *
 *   X402_PRIVATE_KEY_FILE=~/.x402-key node mcp-paid-client.mjs [--url <mcp-url>]
 *
 * Why this exists: the CLI in cli.mjs speaks HTTP (`POST /v1/evidence`). An MCP
 * agent reaches the same paid tool over a different transport, and that paid path
 * had never been exercised - MCP free, MCP 402 and HTTP paid were all verified,
 * but not MCP paid.
 *
 * It matters for discovery too. The x402 catalogue is populated PER ROUTE: only a
 * route that settles a payment is listed. Paying over HTTP lists the HTTP endpoint;
 * paying over MCP is what lists the MCP one, on a shelf holding 33 entries of
 * which just 11 declare tool metadata.
 *
 * The mechanism is small: the MCP streamable-HTTP transport accepts a custom
 * `fetch`, and x402's payment wrapper is exactly that. MCP's `initialize` and
 * `tools/list` are free, so they pass straight through; the paid `tools/call`
 * answers 402 and the wrapper pays and retries.
 */
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, formatUnits } from "viem";
import { base } from "viem/chains";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { wrapFetchWithPayment } from "@x402/fetch";

const DEFAULT_MCP = "https://agent-evidence-api.thx93.workers.dev/mcp";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NETWORK = "eip155:8453";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : (argv[i + 1] ?? fallback);
};
const url = flag("--url", DEFAULT_MCP);
const question = flag("--question", "Is Rotamech Industries a manufacturer of centrifugal pumps?");
const sourceUrl = flag("--source", "https://en.wikipedia.org/wiki/Centrifugal_pump");

// ------------------------------------------------------------------ the wallet
let key = process.env.X402_PRIVATE_KEY ?? null;
if (!key && process.env.X402_PRIVATE_KEY_FILE) {
  key = (await readFile(process.env.X402_PRIVATE_KEY_FILE, "utf8")).trim();
}
if (!key) {
  console.error("\n  ✖ set X402_PRIVATE_KEY or X402_PRIVATE_KEY_FILE\n");
  process.exit(1);
}
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error("\n  ✖ the wallet key is not a 32-byte hex value\n");
  process.exit(1);
}

const account = privateKeyToAccount(key);
const publicClient = createPublicClient({ chain: base, transport: http() });
const balance = await publicClient.readContract({
  address: USDC,
  abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] }],
  functionName: "balanceOf",
  args: [account.address],
}).catch(() => 0n);

console.log(`
  MCP endpoint : ${url}
  Tool         : research_evidence
  Wallet       : ${account.address}
  Balance      : ${formatUnits(balance, 6)} USDC`);

// ------------------------------------------------------- the payment transport
const signer = toClientEvmSigner(account, publicClient);
const x402 = new x402Client().register(NETWORK, new ExactEvmScheme(signer));
const payFetch = wrapFetchWithPayment(fetch, x402);

// Capture the settlement header on its way past: the MCP transport consumes the
// response, so this is the only place the transaction hash is visible.
let settlementHeader = null;
const capturingFetch = async (input, init) => {
  const res = await payFetch(input, init);
  const h = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
  if (h) settlementHeader = h;
  return res;
};

const transport = new StreamableHTTPClientTransport(new URL(url), {
  fetch: capturingFetch,
  requestInit: { headers: { accept: "application/json, text/event-stream" } },
});
const client = new Client({ name: "aee-paid-mcp-probe", version: "1.0.0" }, { capabilities: {} });

console.log("\n  ── 1. initialize (free) ──");
await client.connect(transport);
console.log("     ✓ connected to", client.getServerVersion()?.name, client.getServerVersion()?.version);

console.log("\n  ── 2. tools/list (free) ──");
const { tools } = await client.listTools();
for (const t of tools) console.log(`     • ${t.name}`);

console.log("\n  ── 3. tools/call research_evidence (PAID) ──");
const started = Date.now();
let result;
try {
  result = await client.callTool({
    name: "research_evidence",
    arguments: { question, urls: [sourceUrl], max_sources: 1 },
  });
} catch (err) {
  console.error("     ✖ the paid call failed:", String(err.message ?? err).slice(0, 300));
  await client.close().catch(() => {});
  process.exit(1);
}
const elapsed = Date.now() - started;

if (settlementHeader) {
  try {
    const decoded = JSON.parse(Buffer.from(settlementHeader, "base64").toString());
    console.log("     settlement tx :", decoded.transaction ?? "(none)");
    console.log("     success       :", decoded.success);
  } catch {
    console.log("     settlement    :", settlementHeader.slice(0, 120));
  }
} else {
  console.log("     settlement    : (no payment-response header seen)");
}
console.log("     elapsed       :", elapsed, "ms");
console.log("     isError       :", result.isError === true);

const text = result.content?.find((c) => c.type === "text")?.text;
if (text) {
  try {
    const parsed = JSON.parse(text);
    console.log("\n     assessment    :", parsed.assessment?.status);
    console.log("     basis         :", String(parsed.assessment?.basis ?? "").slice(0, 100));
    console.log("     sources       :", parsed.sources?.length, "|", parsed.sources?.[0]?.title);
    console.log("     evidence      :", parsed.sources?.[0]?.evidence?.length, "excerpt(s)");
    if (parsed.sources?.[0]?.evidence?.[0]) {
      console.log("     first excerpt :", String(parsed.sources[0].evidence[0].excerpt).slice(0, 110));
    }
  } catch {
    console.log("\n     raw:", text.slice(0, 200));
  }
}

const after = await publicClient.readContract({
  address: USDC,
  abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] }],
  functionName: "balanceOf",
  args: [account.address],
}).catch(() => 0n);
console.log(`\n  balance after : ${formatUnits(after, 6)} USDC`);

await client.close().catch(() => {});
console.log("  done\n");
