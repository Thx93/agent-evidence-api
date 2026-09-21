/**
 * Content-encoding, decompression-ratio and content-length semantics
 * (SPEC sections 5, 7, 18 — decompression bombs and bounded responses).
 *
 * These run against the local deterministic fixture server on loopback, using
 * the fetcher's TEST-ONLY loopback escape exactly as tests/security/limits.ts
 * does. Every encoded payload is produced by Node's own zlib, so the expected
 * decoded text is knowable without any external dependency.
 */
process.env.NODE_ENV = "test";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS, type ResourceLimits } from "@aee/schemas";
import { FetchError, classifyHostname, fetchSource } from "@aee/fetcher";
import {
  DECOMPRESSED_BOMB_BYTES,
  ENCODED_FIXTURE_HTML,
  GZIP_FIXTURE_BODY,
  UNKNOWN_ENCODING_BODY,
  startFixtureServer,
  type FixtureServer,
} from "../fixtures/server.js";

let fx: FixtureServer;

const limits: ResourceLimits = {
  ...DEFAULT_LIMITS,
  maxRedirects: 3,
  requestTimeoutMs: 5_000,
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

before(async () => {
  fx = await startFixtureServer();
});

after(async () => {
  await fx.close();
});

describe("single content-encoding", () => {
  test("gzip is decoded to the original text", async () => {
    const res = await get("/gzip");
    assert.equal(res.status, 200);
    assert.match(res.contentType ?? "", /text\/html/);
    assert.equal(res.body, ENCODED_FIXTURE_HTML);
    assert.ok(
      !res.warnings.some((w) => w.code === "UNSUPPORTED_CONTENT_ENCODING"),
      "a supported encoding must not warn",
    );
  });
});

describe("chained content-encoding (regression)", () => {
  test("`content-encoding: gzip, br` is decoded, undoing br before gzip", async () => {
    const res = await get("/gzip-br");
    assert.equal(res.status, 200);
    assert.equal(res.body, ENCODED_FIXTURE_HTML);
    assert.ok(
      !res.warnings.some((w) => w.code === "UNSUPPORTED_CONTENT_ENCODING"),
      "supported encodings must not warn",
    );
  });
});

describe("decompression-ratio guard", () => {
  test("aborts a small body that expands hugely with RESPONSE_TOO_LARGE", async () => {
    // The absolute cap is set to the FULL decompressed size of the bomb so it
    // cannot fire: only the ratio guard can stop this response. A few KB of
    // gzip expands to 8 MiB (roughly 1000:1), far past MAX_DECOMPRESSION_RATIO.
    await assert.rejects(
      get("/gzip-bomb", { maxResponseBytes: DECOMPRESSED_BOMB_BYTES }),
      (err: unknown) => {
        assert.ok(err instanceof FetchError, `expected FetchError, got ${String(err)}`);
        assert.equal((err as FetchError).code, "RESPONSE_TOO_LARGE");
        return true;
      },
    );
  });
});

describe("unsupported content-encoding", () => {
  test("an unknown encoding is left undecoded and warns", async () => {
    const res = await get("/unknown-encoding");
    assert.equal(res.status, 200);
    assert.equal(res.body, UNKNOWN_ENCODING_BODY);
    const warning = res.warnings.find((w) => w.code === "UNSUPPORTED_CONTENT_ENCODING");
    assert.ok(warning, "expected an UNSUPPORTED_CONTENT_ENCODING warning");
    assert.match(warning.message, /x-made-up/);
  });
});

describe("contentLength semantics", () => {
  test("contentLength is the wire (compressed) header value; bytes is decoded size", async () => {
    const res = await get("/gzip");
    const decodedBytes = Buffer.byteLength(ENCODED_FIXTURE_HTML, "utf8");
    assert.equal(res.contentLength, GZIP_FIXTURE_BODY.length);
    assert.equal(res.bytes, decodedBytes);
    assert.notEqual(res.contentLength, res.bytes);
    assert.ok(
      (res.contentLength ?? 0) < res.bytes,
      "the compressed wire size must be smaller than the decoded size",
    );
  });

  test("contentLength is null when the response has no content-length header", async () => {
    const res = await get("/chunked");
    assert.equal(res.status, 200);
    assert.equal(res.body, "chunked body");
    assert.equal(res.contentLength, null);
    assert.equal(res.bytes, Buffer.byteLength("chunked body", "utf8"));
  });
});

describe("cloud metadata hostnames (issue: metadata.goog)", () => {
  test('classifyHostname("metadata.goog") is blocked', () => {
    assert.notEqual(classifyHostname("metadata.goog"), null);
  });

  test('classifyHostname("metadatagoog") is blocked defensively', () => {
    assert.notEqual(classifyHostname("metadatagoog"), null);
  });

  test("blocking is not over-broadened to google.com or the bare label goog", () => {
    assert.equal(classifyHostname("google.com"), null);
    assert.equal(classifyHostname("metadata.google.com"), null);
    assert.equal(classifyHostname("goog"), null);
  });
});
