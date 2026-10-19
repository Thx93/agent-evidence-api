/**
 * Documentation drift.
 *
 * Six rounds were spent fixing the same defect by hand: adding a capability left
 * every sentence describing the service out of date. The manifest said three
 * resources when five were served, `GET /` and the landing page listed no weather at
 * all, the README advertised two routes, `docs/api.md` advertised none, and
 * `AGENTS.md` called evidence "the single capability". None of that failed any test,
 * because nothing compared the prose to the routes.
 *
 * This does. The manifest is the source of truth - it is built from the same
 * configuration the paywall charges from - and every paid route in it must be named
 * where a reader would look for it. A route added without its documentation now
 * fails here instead of silently surviving until someone notices.
 *
 * Deliberately narrow: it asserts that each route is *mentioned*, not how. Prose is
 * not a contract, and a test that pinned sentences would be rewritten every time
 * someone improved one.
 */
process.env.NODE_ENV = "test";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EvidenceService, createLogger, loadConfig } from "@aee/core";
import type { EvidenceMcpServer } from "@aee/mcp";
import { buildApp } from "../../apps/backend/src/app.js";

const SECRET = "test-secret-value-that-is-long-enough";

process.env.BACKEND_AUTH_SECRET = SECRET;
process.env.ALLOW_LOOPBACK_FOR_TESTS = "true";
process.env.CACHE_ENABLED = "false";
process.env.DEV_BYPASS_PAYMENT = "true";
process.env.USAGE_LOG_PATH = "off";
process.env.LOG_LEVEL = "error";
process.env.X402_NETWORK = "eip155:8453";
process.env.X402_RECIPIENT = "0x9c0e2B44180439294Fa30Ae2B2a94f8655455FD0";
process.env.X402_PRICE_USD = "0.003";
process.env.X402_RESOURCE_URL = "https://agent-evidence-api.example.invalid/v1/evidence";
delete process.env.X402_MCP_RESOURCE_URL;

let app: ReturnType<typeof buildApp>;
/** The path part of every paid route the manifest declares, e.g. `/v1/evidence`. */
let paidPaths: string[];

function stubMcp(): EvidenceMcpServer {
  return {
    handleNodeRequest: async () => undefined,
    listTools: () => [],
    close: async () => undefined,
  };
}

async function readDoc(path: string): Promise<string> {
  return readFile(new URL(`../../${path}`, import.meta.url), "utf8");
}

before(async () => {
  const config = loadConfig();
  const logger = createLogger("error");
  const service = new EvidenceService({ config, logger });
  app = buildApp({ config, logger, service, mcp: stubMcp() });
  await app.ready();

  const res = await app.inject({ method: "GET", url: "/.well-known/x402" });
  const manifest = res.json() as { resources: Array<{ url: string }> };
  paidPaths = manifest.resources.map((r) => new URL(r.url).pathname);
});

after(async () => {
  await app.close();
});

describe("the documentation names every paid route", () => {
  test("the manifest declares the routes this suite is guarding", () => {
    // If this ever reads as zero, the guard below would pass vacuously.
    assert.ok(paidPaths.length >= 5, `expected at least 5 paid routes, saw ${paidPaths.length}`);
  });

  test("the README names every paid route", async () => {
    const readme = await readDoc("README.md");
    const missing = paidPaths.filter((p) => !readme.includes(p));
    assert.deepEqual(
      missing,
      [],
      `README.md does not mention: ${missing.join(", ")}. Adding a route means adding it to the table a reader looks at.`,
    );
  });

  test("docs/api.md documents every paid route", async () => {
    const api = await readDoc("docs/api.md");
    const missing = paidPaths.filter((p) => !api.includes(p));
    assert.deepEqual(
      missing,
      [],
      `docs/api.md does not mention: ${missing.join(", ")}. AGENTS.md requires the contract doc to move with the API.`,
    );
  });

  test("docs/mcp.md names every MCP endpoint", async () => {
    const mcp = await readDoc("docs/mcp.md");
    const endpoints = paidPaths.filter((p) => p.endsWith("/mcp"));
    assert.ok(endpoints.length >= 2, "both MCP endpoints should be declared");
    const missing = endpoints.filter((p) => !mcp.includes(p));
    assert.deepEqual(missing, [], `docs/mcp.md does not mention: ${missing.join(", ")}`);
  });

  test("the free sample is described where a buyer decides", async () => {
    // /demo is free, so it is not in the manifest, but it is the proof of output
    // quality and it was undocumented for several rounds.
    const readme = await readDoc("README.md");
    assert.ok(readme.includes("/demo"), "the README should point at the free sample");
    const api = await readDoc("docs/api.md");
    assert.ok(api.includes("/demo"), "docs/api.md should document the free sample");
  });
});
