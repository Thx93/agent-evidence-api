/**
 * The x402 capability manifest (`/.well-known/x402`).
 *
 * This file exists for one defect that shipped: both resources were described by
 * a single `accepts` entry hard-coded to `/v1/evidence`, so the MCP resource
 * advertised `resource: …/v1/evidence` and a crawler could not tell how to pay
 * for `/mcp`. The manifest is now built from `config.x402` — the same values the
 * paywall charges from — and these tests pin the shape that prevents the drift:
 * **every `accepts` entry must describe the resource it is attached to.**
 */
process.env.NODE_ENV = "test";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { EvidenceService, createLogger, loadConfig } from "@aee/core";
import { priceAtomicUnits } from "@aee/schemas";
import type { EvidenceMcpServer } from "@aee/mcp";
import { buildApp } from "../../apps/backend/src/app.js";

const SECRET = "test-secret-value-that-is-long-enough";

process.env.BACKEND_AUTH_SECRET = SECRET;
process.env.ALLOW_LOOPBACK_FOR_TESTS = "true";
process.env.CACHE_ENABLED = "false";
// The manifest is independent of the paywall; bypassing it keeps this suite free
// of a facilitator.
process.env.DEV_BYPASS_PAYMENT = "true";
process.env.USAGE_LOG_PATH = "off";
process.env.LOG_LEVEL = "error";

process.env.X402_NETWORK = "eip155:8453";
process.env.X402_RECIPIENT = "0x9c0e2B44180439294Fa30Ae2B2a94f8655455FD0";
process.env.X402_PRICE_USD = "0.003";
process.env.X402_RESOURCE_URL = "https://agent-evidence-api.example.invalid/v1/evidence";
// Left unset on purpose: the MCP resource URL must be DERIVED from the HTTP one,
// and a manifest that named a different host would be the same class of bug.
delete process.env.X402_MCP_RESOURCE_URL;

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

let app: ReturnType<typeof buildApp>;
let manifest: Record<string, unknown> & {
  resources: Array<{
    url: string;
    method: string;
    description?: string;
    accepts: Array<Record<string, unknown>>;
  }>;
};

function stubMcp(): EvidenceMcpServer {
  return {
    handleNodeRequest: async () => undefined,
    listTools: () => [],
    close: async () => undefined,
  };
}

before(async () => {
  const config = loadConfig();
  const logger = createLogger("error");
  const service = new EvidenceService({ config, logger });
  app = buildApp({ config, logger, service, mcp: stubMcp() });
  await app.ready();

  const res = await app.inject({ method: "GET", url: "/.well-known/x402" });
  assert.equal(res.statusCode, 200, `manifest should be readable, got ${res.statusCode}`);
  manifest = res.json();
});

after(async () => {
  await app.close();
});

describe("the manifest is public", () => {
  test("is readable without the shared secret", async () => {
    // A crawler fetches this; requiring X-Backend-Auth would make the origin
    // invisible to every index that looks here.
    const res = await app.inject({ method: "GET", url: "/.well-known/x402" });
    assert.equal(res.statusCode, 200);
  });

  test("advertises cacheable, cross-origin-readable headers", async () => {
    const res = await app.inject({ method: "GET", url: "/.well-known/x402" });
    assert.match(res.headers["cache-control"] as string, /public/);
    assert.equal(res.headers["access-control-allow-origin"], "*");
  });
});

describe("the manifest describes both resources", () => {
  test("lists exactly the HTTP, MCP and weather endpoints", () => {
    assert.equal(manifest.resources.length, 3);
    assert.deepEqual(
      manifest.resources.map((r) => r.url).sort(),
      [
        "https://agent-evidence-api.example.invalid/mcp",
        "https://agent-evidence-api.example.invalid/v1/evidence",
        "https://agent-evidence-api.example.invalid/weather/mcp",
      ],
    );
  });

  test("the MCP resource URL is derived from the HTTP one", () => {
    // Regression guard for the env pair drifting: a hand-written MCP URL that
    // names a different host would put a dead address in front of a crawler.
    const mcp = manifest.resources.find((r) => r.url.endsWith("/mcp"));
    assert.ok(mcp, "an MCP resource must be declared");
    assert.match(mcp.url, /^https:\/\/agent-evidence-api\.example\.invalid\/mcp$/);
  });

  test("declares itself a resource-server, not a facilitator", () => {
    assert.equal(manifest.x402Version, 2);
    assert.equal(manifest.kind, "resource-server");
    assert.equal((manifest.attestation as { type: string }).type, "none");
    assert.equal(manifest.docs, "https://agent-evidence-api.example.invalid/");
  });

  test("carries a fresh timestamp", () => {
    const updated = new Date(String(manifest.updated));
    assert.ok(!Number.isNaN(updated.getTime()), "updated must be an ISO date");
  });
});

describe("payment terms ride on the resource they pay for", () => {
  test("each accepts entry describes its own resource", () => {
    // THE regression. One shared entry hard-coded to /v1/evidence meant the MCP
    // resource advertised the wrong resource URL.
    for (const resource of manifest.resources) {
      assert.equal(resource.accepts.length, 1, `${resource.url} must carry payment terms`);
      const [accept] = resource.accepts;
      assert.ok(accept, `${resource.url} must carry payment terms`);
      assert.equal(
        accept.resource,
        resource.url,
        `the accepts entry on ${resource.url} must describe ${resource.url}`,
      );
    }
  });

  test("both resources quote the same terms, from the config the paywall uses", () => {
    for (const resource of manifest.resources) {
      const [accept] = resource.accepts;
      assert.ok(accept, `${resource.url} must carry payment terms`);
      assert.equal(accept.scheme, "exact");
      assert.equal(accept.network, "eip155:8453");
      assert.equal(accept.asset, USDC);
      assert.equal(accept.payTo, "0x9c0e2B44180439294Fa30Ae2B2a94f8655455FD0");
      assert.equal(accept.amount, priceAtomicUnits("0.003"));
      assert.equal(accept.maxTimeoutSeconds, 300);
    }
  });

  test("the asset is USDC with its EIP-712 domain, not a bare address", () => {
    const [first] = manifest.resources;
    assert.ok(first, "at least one resource");
    const [accept] = first.accepts;
    assert.ok(accept, "payment terms must be present");
    assert.deepEqual(accept.extra, { name: "USD Coin", version: "2" });
  });

  test("every resource is POST, the method both endpoints accept", () => {
    for (const resource of manifest.resources) {
      assert.equal(resource.method, "POST");
    }
  });
});

describe("descriptions are the search surface", () => {
  test("each resource carries a non-trivial description", () => {
    for (const resource of manifest.resources) {
      const description = resource.description ?? "";
      assert.ok(description.length > 80, `${resource.url} description is too thin`);
    }
  });

  test("each description names the caller's outcome, not the protocol", () => {
    // A crawler ranks on match score against the words a buyer would type, so
    // "HTTPS evidence endpoint" loses to text that says what the caller gets. Each
    // resource must name its OWN outcome, not merely some outcome.
    const vocabulary: Record<string, RegExp> = {
      "/v1/evidence": /evidence/i,
      "/mcp": /evidence/i,
      "/weather/mcp": /(weather|alert|forecast)/i,
    };
    for (const resource of manifest.resources) {
      const path = new URL(resource.url).pathname;
      assert.match(
        resource.description ?? "",
        vocabulary[path] ?? /(evidence|weather)/i,
        `${path} description must name its own outcome`,
      );
    }
  });
});
