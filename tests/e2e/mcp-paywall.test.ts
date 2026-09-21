/**
 * The MCP paywall, end to end through a real Fastify socket.
 *
 * This is the coverage that was missing when the MCP gate lived at the Cloudflare
 * edge. It matters because the failure mode is silent and costly in one direction
 * only: a gate that charges the free `tools/list` handshake makes the tool
 * un-discoverable, and a gate that lets `tools/call` through gives the product
 * away. The deploy guard caught the first of those once already.
 *
 * A stub facilitator is used rather than the live one — deterministic, offline,
 * and it lets the test assert exactly which calls the backend makes. The evidence
 * pipeline itself is real: a real `EvidenceService` against the deterministic
 * fixture server.
 */
process.env.NODE_ENV = "test";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { EvidenceService, createLogger, loadConfig } from "@aee/core";
import { createEvidenceMcpServer } from "@aee/mcp";
import { buildApp } from "../../apps/backend/src/app.js";
import { createUsageLog } from "../../apps/backend/src/usage-log.js";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";

const SECRET = "test-secret-value-that-is-long-enough";
const NETWORK = "eip155:84532";
const PAYER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x9c0e2B44180439294Fa30Ae2B2a94f8655455FD0";
const PUBLIC_MCP_URL = "https://agent-evidence-api.example/mcp";

// The paywall must be ACTIVE here (unlike the evidence suites, which bypass it),
// because the whole point is to exercise the gate. A non-mainnet network is used
// so nothing can touch real funds, and DEV_BYPASS_PAYMENT is deliberately unset.
process.env.BACKEND_AUTH_SECRET = SECRET;
process.env.ALLOW_LOOPBACK_FOR_TESTS = "true";
process.env.CACHE_ENABLED = "false";
delete process.env.DEV_BYPASS_PAYMENT;
process.env.X402_NETWORK = NETWORK;
process.env.X402_RECIPIENT = RECIPIENT;
process.env.X402_PRICE_USD = "0.003";
process.env.X402_RESOURCE_URL = "https://agent-evidence-api.example/v1/evidence";
delete process.env.X402_MCP_RESOURCE_URL; // must be derived from the HTTP URL
process.env.LOG_LEVEL = "error";
process.env.USAGE_LOG_PATH = `/tmp/aee-mcp-usage-${process.pid}.jsonl`;

interface StubFacilitator {
  url: string;
  calls: string[];
  close(): Promise<void>;
}

function startStubFacilitator(): Promise<StubFacilitator> {
  const calls: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = req.url ?? "/";
    calls.push(`${req.method ?? "?"} ${url.split("?")[0]}`);
    const json = (payload: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
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
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

let fx: FixtureServer;
let facilitator: StubFacilitator;
let base: string;
let closeApp: () => Promise<void>;

function mcpUrl(): string {
  return `${base}/mcp`;
}

async function mcpCall(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(mcpUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-backend-auth": SECRET,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** Decode the base64 `payment-required` header from a 402. */
function decodeChallenge(res: Response): Record<string, unknown> {
  const header = res.headers.get("payment-required");
  assert.ok(header, "a 402 must carry the PAYMENT-REQUIRED header");
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, unknown>;
}

before(async () => {
  fx = await startFixtureServer();
  facilitator = await startStubFacilitator();

  // Point the backend at the stub. loadConfig() reads the environment at call
  // time, which is why this can be set after the imports above.
  process.env.X402_FACILITATOR_URL = facilitator.url;

  const config = loadConfig();
  assert.equal(config.x402.publicMcpResourceUrl, PUBLIC_MCP_URL, "MCP URL must derive");

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

describe("the free MCP discovery surface", () => {
  test("initialize is not charged and not blocked", async () => {
    const res = await mcpCall({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    });
    assert.equal(res.status, 200);
  });

  test("tools/list is free, and the free path never touches the facilitator", async () => {
    facilitator.calls.length = 0;
    const res = await mcpCall({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result?: { tools?: { name: string }[] } };
    const names = (body.result?.tools ?? []).map((t) => t.name);
    assert.ok(names.includes("research_evidence"), "the paid tool must be advertised");
    assert.ok(names.includes("health"), "the free tool must be advertised");
    // This is the regression the deploy guard caught: a free handshake that
    // needed a facilitator round-trip (or a payment) made the tool invisible.
    assert.deepEqual(facilitator.calls, [], "a free request must not need the facilitator");
  });

  test("the free health tool is not charged", async () => {
    const res = await mcpCall({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "health", arguments: {} },
    });
    assert.equal(res.status, 200);
  });
});

describe("the paid MCP tool", () => {
  test("requires payment, and the challenge describes the MCP route", async () => {
    const res = await mcpCall({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "research_evidence", arguments: { question: "q" } },
    });
    assert.equal(res.status, 402);

    const challenge = decodeChallenge(res);
    // The public address, not http://127.0.0.1:<port>/mcp — a catalogue that
    // indexed the internal origin would send buyers nowhere.
    const resource = challenge.resource as { url?: string };
    assert.equal(resource.url, PUBLIC_MCP_URL);

    const accepts = challenge.accepts as Record<string, unknown>[];
    assert.equal(accepts[0]?.["scheme"], "exact");
    assert.equal(accepts[0]?.["network"], NETWORK);
    assert.equal(accepts[0]?.["amount"], "3000", "$0.003 in USDC atomic units");
    assert.equal(accepts[0]?.["payTo"], RECIPIENT);

    // The bazaar declaration is what the CDP Bazaar catalogues, and it is the
    // reason this paywall moved to the backend at all.
    const extensions = challenge.extensions as { bazaar?: { info?: { input?: Record<string, unknown> } } };
    const input = extensions.bazaar?.info?.input;
    assert.ok(input, "the MCP challenge must carry a bazaar declaration");
    assert.equal(input["type"], "mcp");
    assert.equal(input["toolName"], "research_evidence");
    assert.equal(input["transport"], "streamable-http");
    // The library's internal validator injects a synthetic `method` for MCP
    // patterns that carry an HTTP verb and then warns that the declaration has an
    // extra property. That copy is for validation only: if it ever leaked into the
    // served declaration, CDP's validator would reject it.
    assert.equal(input["method"], undefined);
  });

  test("a verified payment is served and settled", async () => {
    const challengeRes = await mcpCall({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "research_evidence", arguments: { question: "q" } },
    });
    assert.equal(challengeRes.status, 402);
    const challenge = decodeChallenge(challengeRes);
    const requirements = (challenge.accepts as Record<string, unknown>[])[0];

    // A structurally valid payment payload. The facilitator is the authority on
    // the signature, and the stub accepts it; what this exercises is the
    // backend's own matching, serving, settlement and header plumbing.
    const payload = {
      x402Version: 2,
      scheme: "exact",
      network: NETWORK,
      accepted: requirements,
      payload: {
        signature: `0x${"cd".repeat(65)}`,
        authorization: {
          from: PAYER,
          to: RECIPIENT,
          value: requirements?.["amount"],
          validAfter: "0",
          validBefore: String(Math.floor(Date.now() / 1000) + 3600),
          nonce: `0x${"ef".repeat(32)}`,
        },
      },
    };
    const signatureHeader = Buffer.from(JSON.stringify(payload)).toString("base64");

    facilitator.calls.length = 0;
    const res = await mcpCall(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "research_evidence",
          arguments: { question: "Is the fixture company a company?", urls: [`${fx.url}/company`] },
        },
      },
      { "payment-signature": signatureHeader },
    );

    // Read the body exactly once: a `Response` body is consumed on first read.
    const raw = await res.text();
    assert.equal(res.status, 200, `expected a served call, got ${res.status}: ${raw}`);
    // The settlement receipt is what proves the money moved, rather than merely
    // that a proof was presented.
    assert.ok(res.headers.get("payment-response"), "the response must carry PAYMENT-RESPONSE");
    assert.ok(
      facilitator.calls.some((c) => c.includes("/settle")),
      "settlement must be attempted exactly once the call delivered",
    );

    const body = JSON.parse(raw) as { result?: { content?: { text?: string }[] } };
    const text = body.result?.content?.[0]?.text ?? "";
    assert.match(text, /assessment/, "the buyer must receive the evidence package");
  });

  test("a failed tool call is not settled", async () => {
    // A source that does not exist makes the service return an error result
    // (`isError: true`) with HTTP 200 — the shape settlement cannot see. No
    // settlement may be attempted, because the buyer got nothing.
    const challengeRes = await mcpCall({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "research_evidence", arguments: { question: "q" } },
    });
    const challenge = decodeChallenge(challengeRes);
    const requirements = (challenge.accepts as Record<string, unknown>[])[0];
    const payload = {
      x402Version: 2,
      scheme: "exact",
      network: NETWORK,
      accepted: requirements,
      payload: {
        signature: `0x${"cd".repeat(65)}`,
        authorization: {
          from: PAYER,
          to: RECIPIENT,
          value: requirements?.["amount"],
          validAfter: "0",
          validBefore: String(Math.floor(Date.now() / 1000) + 3600),
          nonce: `0x${"ef".repeat(32)}`,
        },
      },
    };

    facilitator.calls.length = 0;
    const res = await mcpCall(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "research_evidence",
          // Port 1 on loopback is closed, so every source fails to retrieve.
          arguments: { question: "q", urls: ["http://127.0.0.1:1/nope"] },
        },
      },
      { "payment-signature": Buffer.from(JSON.stringify(payload)).toString("base64") },
    );

    assert.equal(res.status, 200, "MCP reports a failed tool call as a 200 result");
    const body = (await res.json()) as { result?: { isError?: boolean } };
    assert.equal(body.result?.isError, true, "the call must be reported as failed");
    assert.ok(
      !facilitator.calls.some((c) => c.includes("/settle")),
      "a failed call must never settle",
    );
  });
});
