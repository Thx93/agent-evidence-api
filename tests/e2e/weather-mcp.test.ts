/**
 * `/weather/mcp` end to end through a real Fastify socket: discoverable for free,
 * paid to call.
 *
 * The two failure modes are asymmetric and both are silent. A gate that charges
 * `tools/list` makes the tool un-discoverable, so nobody ever reaches the paywall;
 * a gate that lets `tools/call` through gives the product away. This file asserts
 * both directions for the SECOND MCP service — the one that would have regressed
 * when the gate was generalised from one route to two.
 *
 * It also pins the thing that decides whether a crawler can price this service at
 * all: the 402 for a weather tool call must advertise `resource: …/weather/mcp`,
 * not the evidence endpoint. That exact class of bug shipped once on `/mcp`.
 */
process.env.NODE_ENV = "test";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { EvidenceService, createLogger, loadConfig } from "@aee/core";
import { createEvidenceMcpServer, WEATHER_PAID_TOOLS } from "@aee/mcp";
import { buildApp } from "../../apps/backend/src/app.js";
import { createUsageLog } from "../../apps/backend/src/usage-log.js";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";

const SECRET = "test-secret-value-that-is-long-enough";
const NETWORK = "eip155:84532";
const RECIPIENT = "0x9c0e2B44180439294Fa30Ae2B2a94f8655455FD0";
const PAYER = "0x1111111111111111111111111111111111111111";
const PUBLIC_ORIGIN = "https://agent-evidence-api.example";

// The paywall must be ACTIVE — the whole point is to exercise the gate. A
// non-mainnet network so nothing can touch real funds.
process.env.BACKEND_AUTH_SECRET = SECRET;
process.env.ALLOW_LOOPBACK_FOR_TESTS = "true";
process.env.CACHE_ENABLED = "false";
delete process.env.DEV_BYPASS_PAYMENT;
process.env.X402_NETWORK = NETWORK;
process.env.X402_RECIPIENT = RECIPIENT;
process.env.X402_PRICE_USD = "0.003";
process.env.X402_RESOURCE_URL = `${PUBLIC_ORIGIN}/v1/evidence`;
delete process.env.X402_MCP_RESOURCE_URL;
process.env.LOG_LEVEL = "error";
process.env.USAGE_LOG_PATH = `/tmp/aee-weather-usage-${process.pid}.jsonl`;

interface StubFacilitator {
  url: string;
  calls: string[];
  close(): Promise<void>;
}

/**
 * A facilitator that records what it is asked. The free path must leave `calls`
 * untouched, and none of these tests ever settles — the point is the gate, not
 * the money movement.
 */
function startStubFacilitator(): Promise<StubFacilitator> {
  const calls: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = req.url ?? "/";
    calls.push(`${req.method ?? "?"} ${url.split("?")[0]}`);
    const json = (payload: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    // The gate loads supported kinds before it can quote terms, so a stub that
    // only answers verify/settle leaves it unable to issue a 402 at all.
    if (url.startsWith("/supported")) {
      json({
        kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK, extra: {} }],
        extensions: ["bazaar"],
        signers: {},
      });
      return;
    }
    if (url.startsWith("/verify")) {
      json({ isValid: true, payer: PAYER });
      return;
    }
    if (url.startsWith("/settle")) {
      json({
        success: true,
        payer: PAYER,
        transaction: `0x${"ab".repeat(32)}`,
        network: NETWORK,
        amount: "3000",
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

let fx: FixtureServer;
let facilitator: StubFacilitator;
let base: string;
let closeApp: () => Promise<void>;

before(async () => {
  fx = await startFixtureServer();
  facilitator = await startStubFacilitator();
  // loadConfig() reads the environment at call time, which is why this is set
  // after the imports above.
  process.env.X402_FACILITATOR_URL = facilitator.url;

  const config = loadConfig();
  const logger = createLogger("error");
  const service = new EvidenceService({ config, logger });
  const usage = createUsageLog({ path: config.usageLogPath });
  const mcp = createEvidenceMcpServer({ service, logger, serviceVersion: config.serviceVersion });
  const app = buildApp({ config, logger, service, mcp, usage });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  closeApp = async () => {
    await app.close();
    await mcp.close();
  };
});

after(async () => {
  await closeApp();
  await facilitator.close();
  await fx.close();
});

/** POST JSON-RPC to a route; return the status, body and any payment challenge. */
async function rpc(path: string, message: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // The MCP transport refuses a request that accepts only one shape.
      accept: "application/json, text/event-stream",
      "x-backend-auth": SECRET,
    },
    body: JSON.stringify(message),
  });
  const raw = res.headers.get("payment-required");
  const challenge = raw
    ? (JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as Record<string, unknown>)
    : undefined;
  return { status: res.status, body: await res.text(), challenge };
}

const toolsList = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

function toolCall(id: number, name: string, args: unknown = {}) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

describe("the weather service is discoverable for free", () => {
  test("tools/list is not gated, and the facilitator is never touched", async () => {
    const before = facilitator.calls.length;
    const { status, body } = await rpc("/weather/mcp", toolsList);
    assert.equal(status, 200, body);
    assert.equal(facilitator.calls.length, before, "a free handshake must not reach the facilitator");
  });

  test("tools/list advertises exactly the weather tools plus free health", async () => {
    const { body } = await rpc("/weather/mcp", toolsList);
    const parsed = JSON.parse(body) as { result: { tools: Array<{ name: string }> } };
    const names = parsed.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["get-alerts", "get-forecast", "health"]);
  });

  test("initialize is free", async () => {
    const { status } = await rpc("/weather/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "tests", version: "0" },
      },
    });
    assert.equal(status, 200);
  });

  test("the free health tool is not gated", async () => {
    const before = facilitator.calls.length;
    const { status, body } = await rpc("/weather/mcp", toolCall(2, "health"));
    assert.equal(status, 200, body);
    assert.equal(facilitator.calls.length, before);
  });
});

describe("the weather tools cost money", () => {
  test("get-alerts is gated with 402", async () => {
    const { status, body } = await rpc("/weather/mcp", toolCall(3, "get-alerts", { state: "CA" }));
    assert.equal(status, 402, body);
  });

  test("get-forecast is gated with 402", async () => {
    const { status } = await rpc(
      "/weather/mcp",
      toolCall(4, "get-forecast", { latitude: 38.9, longitude: -77 }),
    );
    assert.equal(status, 402);
  });

  test("the gate names its own resource, so a crawler can price this service", async () => {
    // The regression that shipped on /mcp: a challenge naming the wrong endpoint
    // left the resource unroutable to a crawler. The challenge carries its
    // resource as `resource.url`; the manifest uses `accepts[].resource`.
    const { challenge } = await rpc("/weather/mcp", toolCall(5, "get-alerts", { state: "CA" }));
    assert.ok(challenge, "a 402 must carry a payment-required challenge");
    const resource = challenge.resource as { url?: string };
    assert.equal(resource?.url, `${PUBLIC_ORIGIN}/weather/mcp`);
    const accepts = (challenge.accepts as Array<Record<string, unknown>>) ?? [];
    assert.ok(accepts.length >= 1, "the challenge must quote terms");
    for (const entry of accepts) {
      assert.equal(entry.network, NETWORK);
      assert.equal(entry.payTo, RECIPIENT);
      assert.equal(entry.scheme, "exact");
    }
  });

  test("the challenge advertises a public endpoint, never an internal one", async () => {
    const { challenge } = await rpc("/weather/mcp", toolCall(6, "get-forecast"));
    assert.ok(challenge, "a 402 must carry a payment-required challenge");
    const resource = String((challenge.resource as { url?: string }).url ?? "");
    assert.equal(resource.includes("/internal/"), false, "must never advertise an internal URL");
    assert.match(resource, /^https:\/\//);
  });
});

describe("the gate is per route, not global", () => {
  test("the weather route's paid tools are the two weather tools", () => {
    assert.deepEqual([...WEATHER_PAID_TOOLS].sort(), ["get-alerts", "get-forecast"]);
  });

  test("a weather tool is not gated on /mcp, where it is not published", async () => {
    // A tool a route does not publish can never be charged for there: the price
    // follows the route's own tool set, not one global list.
    const { status } = await rpc("/mcp", toolCall(7, "get-alerts", { state: "CA" }));
    assert.notEqual(status, 402, "a name outside /mcp's paid set must not be gated");
  });

  test("research_evidence is still gated on /mcp", async () => {
    const { status } = await rpc("/mcp", toolCall(8, "research_evidence", { question: "x" }));
    assert.equal(status, 402);
  });
});
