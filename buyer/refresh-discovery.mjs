#!/usr/bin/env node
/**
 * refresh-discovery — put a resource into an x402 discovery catalogue, at the
 * price it actually charges.
 *
 * Why this exists
 * ---------------
 * PayAI's Bazaar (and the CDP Bazaar's sibling indexes) catalogue a resource from
 * the payments it processes, not from a registration form. The facilitator
 * upserts an entry when a payment payload *carries your bazaar declaration*, so
 * `GET /discovery/resources` is only ever as accurate as the last such payment.
 *
 * That has two consequences this tool addresses:
 *
 *   1. A resource that has never been paid for is not listed at all, even though
 *      it is live and correctly priced.
 *   2. An entry that was first written when the price was different keeps the old
 *      price until a declaration-carrying payment refreshes it. Ours advertised
 *      $0.030 for a month while the endpoint charged $0.003 — ten times the real
 *      price, in the one catalogue where it ranked first.
 *
 * Per PayAI's documentation, `/verify` catalogues and moves no funds, so this
 * makes a verify-shaped payment rather than a settled one: listing is a
 * publishing action, not a purchase. Nothing is charged and nothing is spent.
 *
 * The entry key is `(resource, toolName)`, so an MCP server exposing several
 * tools needs one run per tool.
 *
 * Usage
 *   node refresh-discovery.mjs                       # every known target
 *   node refresh-discovery.mjs --tool get-alerts     # one target
 *   node refresh-discovery.mjs --endpoint <url> --tool <name> --rpc-body <json>
 *
 * Requires a funded-but-unspent wallet only to sign: `X402_PRIVATE_KEY_FILE`
 * (default /root/Agents Projects/.x402-buyer-key), read here and never printed.
 */
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";

const EVIDENCE = "https://agent-evidence.thx93.dev/v1/evidence";
const EVIDENCE_MCP = "https://agent-evidence.thx93.dev/mcp";
const WEATHER_MCP = "https://agent-evidence.thx93.dev/weather/mcp";
const FACILITATOR = "https://facilitator.payai.network";

/** The one question the cataloguer has to be able to see a price for. */
const PROBE_ARGS = {
  research_evidence: { question: "Is the National Weather Service part of NOAA?", urls: ["https://www.weather.gov/about"] },
  "get-alerts": { state: "CA" },
  "get-forecast": { latitude: 38.9, longitude: -77 },
};

/** Every (endpoint, tool) pair this project publishes. */
const TARGETS = [
  { label: "evidence http", endpoint: EVIDENCE, tool: null },
  { label: "evidence mcp", endpoint: EVIDENCE_MCP, tool: "research_evidence" },
  { label: "weather alerts", endpoint: WEATHER_MCP, tool: "get-alerts" },
  { label: "weather forecast", endpoint: WEATHER_MCP, tool: "get-forecast" },
];

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const keyFile = process.env.X402_PRIVATE_KEY_FILE ?? "/root/Agents Projects/.x402-buyer-key";
const account = privateKeyToAccount(readFileSync(keyFile, "utf8").trim());
const client = new x402Client();
client.register("eip155:8453", new ExactEvmScheme(toClientEvmSigner(account)));

/** The request that makes the server quote a price for this tool. */
function probeRequest(endpoint, tool) {
  if (!tool) {
    return {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: PROBE_ARGS.research_evidence.question, urls: PROBE_ARGS.research_evidence.urls }),
    };
  }
  return {
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: PROBE_ARGS[tool] ?? {} },
    }),
  };
}

async function refresh({ label, endpoint, tool }) {
  const target = `${endpoint}${tool ? ` [${tool}]` : ""}`;
  try {
    const res = await fetch(endpoint, { method: "POST", ...probeRequest(endpoint, tool) });
    if (res.status !== 402) {
      console.log(`  ✖ ${label}: expected 402, got ${res.status}`);
      return false;
    }
    const header = res.headers.get("payment-required");
    if (!header) {
      console.log(`  ✖ ${label}: 402 without a payment-required header`);
      return false;
    }
    const required = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    const amount = required.accepts?.[0]?.amount;

    const payload = await client.createPaymentPayload(required);
    if (!payload.extensions) {
      // Without this the facilitator has nothing to catalogue; say so rather than
      // reporting a success that wrote no entry.
      console.log(`  ✖ ${label}: the client built a payload with no extensions — nothing would be catalogued`);
      return false;
    }

    const vr = await fetch(`${FACILITATOR}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: payload.x402Version,
        paymentPayload: payload,
        paymentRequirements: payload.accepted ?? required.accepts[0],
      }),
    });
    const raw = vr.headers.get("extension-responses");
    const verdict = raw ? Buffer.from(raw, "base64").toString("utf8") : "(absent — declaration dropped)";
    const ok = verdict.includes('"processing"');
    console.log(`  ${ok ? "✓" : "✖"} ${label}: $${(Number(amount) / 1e6).toFixed(4)}  ${verdict}`);
    return ok;
  } catch (err) {
    console.log(`  ✖ ${label}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

const only = arg("--tool");
const targets = only
  ? [{ label: only, endpoint: arg("--endpoint") ?? WEATHER_MCP, tool: only === "research_evidence" ? "research_evidence" : only }]
  : TARGETS;

console.log(`cataloguing ${targets.length} target(s) via ${FACILITATOR} (verify only — no funds move)\n`);
let ok = 0;
for (const t of targets) if (await refresh(t)) ok++;
console.log(`\n${ok}/${targets.length} queued for cataloguing.`);
console.log("Confirm with:  curl -s 'https://facilitator.payai.network/discovery/search?query=claim+verification'");
process.exit(ok === targets.length ? 0 : 1);
