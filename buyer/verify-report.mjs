/**
 * Ask the PayAI facilitator to catalogue a resource, and report exactly what it says.
 *
 * `refresh-discovery.mjs` only reads the `extension-responses` header and treats any
 * mention of "processing" as success. That hides the interesting case: the facilitator
 * accepts every target, yet PayAI's search index only ever shows a subset. So this
 * prints the whole response, per target, for endpoints that script never touches -
 * notably the plain-HTTP weather routes, which were catalogued in CDP by settled calls
 * but were never sent through /verify at all.
 *
 * Verify moves no funds. It is the same call PayAI documents for listing.
 *
 *   node verify-report.mjs                       # all five resources
 *   node verify-report.mjs --only /weather/mcp
 */
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";

const FACILITATOR = "https://facilitator.payai.network";
const ORIGIN = "https://agent-evidence.thx93.dev";

const keyFile = process.env.X402_PRIVATE_KEY_FILE ?? "/root/dsh-workspace/.x402-buyer-key";
const account = privateKeyToAccount(readFileSync(keyFile, "utf8").trim());
const client = new x402Client();
client.register("eip155:8453", new ExactEvmScheme(toClientEvmSigner(account)));

const TARGETS = [
  { path: "/v1/evidence", body: { question: "Is the National Weather Service part of NOAA?", urls: ["https://www.weather.gov/about"] } },
  { path: "/v1/weather/alerts", body: { state: "TX" } },
  { path: "/v1/weather/forecast", body: { latitude: 37.7749, longitude: -122.4194 } },
  { path: "/mcp", tool: "research_evidence", args: { question: "Is the National Weather Service part of NOAA?", urls: ["https://www.weather.gov/about"] } },
  { path: "/weather/mcp", tool: "get-alerts", args: { state: "TX" } },
  { path: "/weather/mcp", tool: "get-forecast", args: { latitude: 37.7749, longitude: -122.4194 } },
];

const argv = process.argv.slice(2);
const onlyIdx = argv.indexOf("--only");
const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;

function probeBody(t) {
  if (!t.tool) return JSON.stringify(t.body);
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: t.tool, arguments: t.args },
  });
}

async function run(t) {
  const url = `${ORIGIN}${t.path}`;
  const label = `${t.path}${t.tool ? ` [${t.tool}]` : ""}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: probeBody(t),
  });
  if (res.status !== 402) {
    console.log(`  ✖ ${label}: expected 402, got ${res.status}`);
    return;
  }
  const header = res.headers.get("payment-required");
  const required = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  const payload = await client.createPaymentPayload(required);

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
  const ext = raw ? Buffer.from(raw, "base64").toString("utf8") : "(no extension-responses header)";
  let bodyText = "";
  try {
    bodyText = JSON.stringify(await vr.json());
  } catch {
    bodyText = "(non-JSON body)";
  }
  console.log(`\n  ${label}`);
  console.log(`    resource url      : ${required.resource?.url}`);
  console.log(`    bazaar input type : ${required.extensions?.bazaar?.info?.input?.type ?? "(none)"}`);
  console.log(`    payload extensions: ${payload.extensions ? Object.keys(payload.extensions).join(",") : "(none)"}`);
  console.log(`    verify status     : ${vr.status}`);
  console.log(`    extension-responses: ${ext.slice(0, 200)}`);
  console.log(`    verify body       : ${bodyText.slice(0, 200)}`);
}

for (const t of TARGETS) {
  if (only && t.path !== only) continue;
  try {
    await run(t);
  } catch (err) {
    console.log(`  ✖ ${t.path}: ${err?.message ?? err}`);
  }
}
