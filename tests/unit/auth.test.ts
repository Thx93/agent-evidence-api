/**
 * Server-to-server authentication (SPEC section 15).
 *
 * The point of these tests is the security property: a caller without the shared
 * secret must be refused, and the refusal must not leak the secret's length —
 * which is why the comparison hashes both sides first rather than comparing raw
 * strings.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  extractCredential,
  isPublicPath,
  PUBLIC_PATHS,
  secretMatches,
} from "../../apps/backend/src/auth.js";

const SECRET = "a-very-long-shared-secret-value";

describe("secretMatches", () => {
  test("accepts the correct secret", () => {
    assert.equal(secretMatches(SECRET, SECRET), true);
  });

  test("rejects a wrong secret", () => {
    assert.equal(secretMatches("a-very-long-shared-secret-valuX", SECRET), false);
  });

  test("rejects a secret that differs only in the last character", () => {
    assert.equal(secretMatches(`${SECRET}!`, SECRET), false);
  });

  test("rejects a missing or empty credential", () => {
    assert.equal(secretMatches(undefined, SECRET), false);
    assert.equal(secretMatches("", SECRET), false);
  });

  test("rejects an empty expected secret rather than matching empty", () => {
    // Both empty would otherwise be "equal", which would let an operator who
    // forgot to set BACKEND_AUTH_SECRET accept every request.
    assert.equal(secretMatches("", ""), false);
    assert.equal(secretMatches(undefined, ""), false);
  });

  test("a wrong secret of a different length is still rejected", () => {
    // `timingSafeEqual` throws on differing lengths; the hash-first comparison
    // must still return false rather than throw.
    assert.equal(secretMatches("short", SECRET), false);
  });

  test("non-string input is refused", () => {
    assert.equal(secretMatches(123 as unknown as string, SECRET), false);
  });
});

describe("extractCredential", () => {
  test("reads X-Backend-Auth", () => {
    assert.equal(extractCredential({ "x-backend-auth": "tok" }), "tok");
  });

  test("reads an Authorization: Bearer header", () => {
    assert.equal(extractCredential({ authorization: "Bearer tok" }), "tok");
  });

  test("prefers X-Backend-Auth when both are present", () => {
    const cred = extractCredential({ "x-backend-auth": "direct", authorization: "Bearer bearer" });
    assert.equal(cred, "direct");
  });

  test("returns undefined when neither is present", () => {
    assert.equal(extractCredential({}), undefined);
  });

  test("an empty X-Backend-Auth falls through to the bearer header", () => {
    assert.equal(extractCredential({ "x-backend-auth": "", authorization: "Bearer tok" }), "tok");
  });

  test("ignores a non-bearer authorization scheme", () => {
    assert.equal(extractCredential({ authorization: "Basic dXNlcjpwYXNz" }), undefined);
    assert.equal(extractCredential({ authorization: "Bearer" }), undefined);
  });

  test("ignores a repeated header rather than trusting one of two values", () => {
    assert.equal(extractCredential({ "x-backend-auth": ["a", "b"] }), undefined);
  });
});

describe("public paths", () => {
  test("the liveness, CLI and manifest routes are reachable without a credential", () => {
    for (const path of ["/health", "/buy.mjs", "/.well-known/x402"]) {
      assert.equal(isPublicPath(path), true, `${path} must be public`);
    }
  });

  test("every paid and internal route requires the secret", () => {
    for (const path of ["/internal/v1/evidence", "/mcp", "/"]) {
      assert.equal(isPublicPath(path), false, `${path} must require a credential`);
    }
  });

  test("matching is exact — a lookalike path is not public", () => {
    // `/health` being public must not make `/healthz`, `/health/deep` or
    // `/.well-known/x402/../../internal/v1/evidence` public.
    assert.equal(isPublicPath("/healthz"), false);
    assert.equal(isPublicPath("/health/deep"), false);
    assert.equal(isPublicPath("/buy.mjs.bak"), false);
  });

  test("the allow-list stays small — every entry must be public on purpose", () => {
    assert.deepEqual([...PUBLIC_PATHS].sort(), [
      "/.well-known/x402",
      "/buy.mjs",
      "/health",
    ]);
  });
});
