/**
 * Integration test for the backend request-rate limiter (SPEC section 23).
 *
 * Builds the real Fastify app — real auth hook, real rate-limit hook, real
 * EvidenceService against the deterministic fixture server — and drives it with
 * `app.inject()`. No socket is opened for the API itself.
 *
 * The limiter is configured through the environment, exactly as production
 * would configure it: RATE_LIMIT_PER_MINUTE=2, RATE_LIMIT_BURST=0.
 */
process.env.NODE_ENV = "test";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EvidenceService, createLogger, loadConfig } from "@aee/core";
import type { Logger } from "@aee/core";
import type { EvidenceMcpServer } from "@aee/mcp";
import { buildApp } from "../../apps/backend/src/app.js";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";

const SECRET = "test-secret-value-that-is-long-enough";

// Read by loadConfig() inside each test, after these assignments run.
process.env.BACKEND_AUTH_SECRET = SECRET;
process.env.ALLOW_LOOPBACK_FOR_TESTS = "true";
process.env.CACHE_ENABLED = "false";
// The x402 paywall now lives in the backend. These suites exercise the evidence
// pipeline, not payment, so they bypass it - which requires BOTH this flag and a
// non-mainnet network, so it cannot make a production deploy free.
process.env.DEV_BYPASS_PAYMENT = "true";
process.env.LOG_LEVEL = "error";
process.env.RATE_LIMIT_PER_MINUTE = "2";
process.env.RATE_LIMIT_BURST = "0";

let fx: FixtureServer;

/** Minimal MCP stand-in: this suite tests the HTTP rate-limit path. */
function stubMcp(): EvidenceMcpServer {
  return {
    handleNodeRequest: async () => undefined,
    listTools: () => [],
    close: async () => undefined,
  };
}

function buildTestApp(logger: Logger = createLogger("error")) {
  const config = loadConfig();
  const service = new EvidenceService({ config, logger });
  return buildApp({ config, logger, service, mcp: stubMcp() });
}

function evidenceBody() {
  return {
    question: "Is Rotamech Industries a manufacturer of centrifugal pumps?",
    urls: [`${fx.url}/company`],
  };
}

before(async () => {
  fx = await startFixtureServer();
});

after(async () => {
  await fx.close();
});

test("the third authenticated request is rate limited while /health stays available", async () => {
  const app = buildTestApp();
  await app.ready();
  try {
    const auth = { "x-backend-auth": SECRET };
    const post = () =>
      app.inject({
        method: "POST",
        url: "/internal/v1/evidence",
        headers: auth,
        payload: evidenceBody(),
      });

    const first = await post();
    assert.equal(first.statusCode, 200, "request 1 is within the limit");

    assert.equal(
      (await app.inject({ method: "GET", url: "/health" })).statusCode,
      200,
      "health must answer while requests remain",
    );

    const second = await post();
    assert.equal(second.statusCode, 200, "request 2 exhausts the bucket");

    const third = await post();
    assert.equal(third.statusCode, 429, "request 3 must be rate limited");
    const body = third.json();
    assert.equal(body.error.code, "RATE_LIMIT");
    assert.match(body.error.message, /too many requests/i);
    assert.ok(body.error.request_id, "the canonical envelope carries a request id");

    const retryAfter = String(third.headers["retry-after"] ?? "");
    assert.ok(retryAfter.length > 0, "a 429 must carry Retry-After");
    assert.ok(Number(retryAfter) >= 1, "Retry-After must be at least one second");

    // The liveness probe is exempt and must still answer after the denial.
    assert.equal(
      (await app.inject({ method: "GET", url: "/health" })).statusCode,
      200,
      "health must remain reachable for a throttled client",
    );

    assert.equal((await post()).statusCode, 429, "the bucket stays exhausted");
  } finally {
    await app.close();
  }
});

test("unauthenticated rejections do not consume rate-limit tokens", async () => {
  const app = buildTestApp();
  await app.ready();
  try {
    // The auth hook is registered first, so these never reach the limiter.
    for (let i = 0; i < 2; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/internal/v1/evidence",
        headers: { "x-backend-auth": "wrong-secret-wrong-secret" },
        payload: evidenceBody(),
      });
      assert.equal(res.statusCode, 401);
    }

    const auth = { "x-backend-auth": SECRET };
    for (let i = 0; i < 2; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/internal/v1/evidence",
        headers: auth,
        payload: evidenceBody(),
      });
      assert.equal(res.statusCode, 200, `authenticated request ${i + 1} must be allowed`);
    }

    const third = await app.inject({
      method: "POST",
      url: "/internal/v1/evidence",
      headers: auth,
      payload: evidenceBody(),
    });
    assert.equal(third.statusCode, 429, "the full budget was still available to real callers");
  } finally {
    await app.close();
  }
});

test("CF-Connecting-IP takes precedence and isolates clients", async () => {
  const app = buildTestApp();
  await app.ready();
  try {
    const auth = { "x-backend-auth": SECRET };
    const postWith = (headers: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: "/internal/v1/evidence",
        headers: { ...auth, ...headers },
        payload: evidenceBody(),
      });

    // Same client per CF-Connecting-IP; the differing x-forwarded-for values
    // must not create a fresh bucket, which proves the precedence order.
    assert.equal(
      (await postWith({
        "cf-connecting-ip": "203.0.113.7",
        "x-forwarded-for": "198.51.100.1",
      })).statusCode,
      200,
    );
    assert.equal(
      (await postWith({
        "cf-connecting-ip": "203.0.113.7",
        "x-forwarded-for": "198.51.100.2",
      })).statusCode,
      200,
    );
    assert.equal(
      (await postWith({
        "cf-connecting-ip": "203.0.113.7",
        "x-forwarded-for": "198.51.100.3",
      })).statusCode,
      429,
      "a spoofed x-forwarded-for must not reset the CF-Connecting-IP bucket",
    );

    // A different real client still has its own budget.
    assert.equal(
      (await postWith({ "cf-connecting-ip": "203.0.113.8" })).statusCode,
      200,
      "a different client must not share the first client's bucket",
    );
  } finally {
    await app.close();
  }
});

test("the first x-forwarded-for entry is used when CF-Connecting-IP is absent", async () => {
  const app = buildTestApp();
  await app.ready();
  try {
    const auth = { "x-backend-auth": SECRET };
    const postWith = (xff: string) =>
      app.inject({
        method: "POST",
        url: "/internal/v1/evidence",
        headers: { ...auth, "x-forwarded-for": xff },
        payload: evidenceBody(),
      });

    assert.equal((await postWith("198.51.100.9, 10.0.0.1")).statusCode, 200);
    assert.equal((await postWith("198.51.100.9, 10.0.0.2")).statusCode, 200);
    assert.equal(
      (await postWith("198.51.100.9, 10.0.0.3")).statusCode,
      429,
      "the client is identified by the first hop, not the proxy chain",
    );
  } finally {
    await app.close();
  }
});

test("a denial logs a structured warning with a neutral client field", async () => {
  const warns: Array<{ message: string; fields: Record<string, unknown> }> = [];
  const spy: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message, fields) => {
      warns.push({ message, fields: fields ?? {} });
    },
    error: () => undefined,
    child: () => spy,
  };

  const app = buildTestApp(spy);
  await app.ready();
  try {
    const auth = { "x-backend-auth": SECRET };
    const post = () =>
      app.inject({
        method: "POST",
        url: "/internal/v1/evidence",
        headers: { ...auth, "cf-connecting-ip": "203.0.113.99" },
        payload: evidenceBody(),
      });

    assert.equal((await post()).statusCode, 200);
    assert.equal((await post()).statusCode, 200);
    assert.equal(warns.length, 0, "no warning before the limit is hit");

    assert.equal((await post()).statusCode, 429);

    assert.equal(warns.length, 1, "exactly one warning on denial");
    const entry = warns[0];
    assert.ok(entry);
    assert.match(entry.message, /rate limit/i);
    // Neutral key: never a raw `ip`-style field name for a client address.
    assert.equal(entry.fields.client, "203.0.113.99");
    assert.ok(Number(entry.fields.retry_after_seconds) >= 1);
    assert.ok(entry.fields.request_id, "the warning carries the request id");
  } finally {
    await app.close();
  }
});
