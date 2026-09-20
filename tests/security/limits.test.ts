/**
 * Network-dependent fetch controls (SPEC sections 7, 18, 23, 26).
 *
 * These run against the local deterministic fixture server, which binds to
 * loopback. Loopback is blocked by design, so the fetcher's TEST-ONLY escape is
 * used here — and the first test proves that escape is genuinely opt-in and has
 * no effect unless NODE_ENV is exactly "test".
 */
process.env.NODE_ENV = "test";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS, type ResourceLimits } from "@aee/schemas";
import { FetchError, fetchSource, isSupportedContentType } from "@aee/fetcher";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";

let fx: FixtureServer;

const limits: ResourceLimits = {
  ...DEFAULT_LIMITS,
  maxRedirects: 3,
  requestTimeoutMs: 2_000,
  connectTimeoutMs: 1_000,
  maxResponseBytes: 256 * 1024,
};

function get(path: string, overrides: Partial<ResourceLimits> = {}) {
  return fetchSource({
    url: `${fx.url}${path}`,
    limits: { ...limits, ...overrides },
    userAgent: "AgentEvidenceAPI-test/0.1.0",
    allowLoopbackForTests: true,
  });
}

async function expectFetchError(path: string, code: string, overrides: Partial<ResourceLimits> = {}) {
  try {
    await get(path, overrides);
    assert.fail(`expected ${path} to throw ${code}`);
  } catch (err) {
    assert.ok(err instanceof FetchError, `expected FetchError, got ${String(err)}`);
    assert.equal((err as FetchError).code, code);
    return err as FetchError;
  }
}

before(async () => {
  fx = await startFixtureServer();
});

after(async () => {
  await fx.close();
});

describe("the loopback test escape is opt-in", () => {
  test("loopback is refused when the flag is not supplied", async () => {
    await assert.rejects(
      fetchSource({
        url: `${fx.url}/company`,
        limits,
        userAgent: "AgentEvidenceAPI-test/0.1.0",
        // no allowLoopbackForTests
      }),
      (err: unknown) => err instanceof FetchError && err.code === "BLOCKED_URL",
    );
  });

  test("the flag is ignored when NODE_ENV is not 'test'", async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await assert.rejects(
        fetchSource({
          url: `${fx.url}/company`,
          limits,
          userAgent: "AgentEvidenceAPI-test/0.1.0",
          allowLoopbackForTests: true,
        }),
        (err: unknown) => err instanceof FetchError && err.code === "BLOCKED_URL",
      );
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});

describe("successful retrieval", () => {
  test("200 returns status, content type, body and provenance", async () => {
    const res = await get("/company");
    assert.equal(res.status, 200);
    assert.match(res.contentType ?? "", /text\/html/);
    assert.match(res.body ?? "", /Rotamech Industries/);
    assert.equal(res.finalUrl, `${fx.url}/company`);
    assert.deepEqual(res.redirectChain, []);
    assert.ok(Date.parse(res.retrievedAt) > 0, "retrievedAt must be a valid timestamp");
    assert.ok(res.bytes > 0);
  });

  test("text/plain is a supported content type", async () => {
    const res = await get("/plain");
    assert.equal(res.status, 200);
    assert.equal(res.body, "Plain text fixture body.");
  });

  test("isSupportedContentType truth table", () => {
    assert.equal(isSupportedContentType("text/html"), true);
    assert.equal(isSupportedContentType("text/html; charset=utf-8"), true);
    assert.equal(isSupportedContentType("application/json"), true);
    assert.equal(isSupportedContentType("application/ld+json"), true);
    assert.equal(isSupportedContentType("image/png"), false);
    assert.equal(isSupportedContentType("application/octet-stream"), false);
    assert.equal(isSupportedContentType(null), false);
  });

  test("unsupported content type yields a null body plus a warning, not a throw", async () => {
    const res = await get("/binary");
    assert.equal(res.status, 200);
    assert.equal(res.body, null);
    assert.ok(res.warnings.some((w) => w.code === "UNSUPPORTED_CONTENT_TYPE"));
  });
});

describe("redirects", () => {
  test("follows a single redirect and records the chain", async () => {
    const res = await get("/redirect-once");
    assert.equal(res.status, 200);
    assert.equal(res.finalUrl, `${fx.url}/company`);
    assert.deepEqual(res.redirectChain, [`${fx.url}/company`]);
  });

  test("follows a redirect chain", async () => {
    const res = await get("/redirect-chain");
    assert.equal(res.status, 200);
    assert.equal(res.finalUrl, `${fx.url}/company`);
    assert.equal(res.redirectChain.length, 2);
  });

  test("enforces the redirect limit on a loop", async () => {
    await expectFetchError("/redirect-loop", "REDIRECT_LIMIT");
  });

  test("blocks a redirect to a private address", async () => {
    const err = await expectFetchError("/redirect-to-private", "BLOCKED_URL");
    assert.match(err.message, /redirect blocked/i);
  });

  test("blocks a redirect to a cloud metadata endpoint", async () => {
    const err = await expectFetchError("/redirect-to-metadata", "BLOCKED_URL");
    assert.match(err.message, /redirect blocked/i);
  });
});

describe("upstream status handling", () => {
  test("404 is returned as provenance, not thrown", async () => {
    const res = await get("/404");
    assert.equal(res.status, 404);
    assert.ok(res.warnings.some((w) => w.code === "UPSTREAM_HTTP_FAILURE"));
  });

  test("500 is returned as provenance, not thrown", async () => {
    const res = await get("/500");
    assert.equal(res.status, 500);
    assert.ok(res.warnings.some((w) => w.code === "UPSTREAM_HTTP_FAILURE"));
  });
});

describe("resource limits", () => {
  test("times out a slow source", async () => {
    await expectFetchError("/slow", "TIMEOUT", { requestTimeoutMs: 700, connectTimeoutMs: 500 });
  });

  test("rejects an oversized response", async () => {
    await expectFetchError("/huge", "RESPONSE_TOO_LARGE", { maxResponseBytes: 128 * 1024 });
  });

  test("an empty body is handled without error", async () => {
    const res = await get("/empty");
    assert.equal(res.status, 200);
    assert.equal(res.body, "");
  });
});
