/**
 * End-to-end acceptance flow (SPEC section 27).
 *
 * Real Fastify app + real EvidenceService + real SSRF-hardened fetcher against
 * the deterministic fixture server. Only the MCP adapter is stubbed, because
 * its own transport is covered by packages/mcp.
 *
 * The x402 payment leg is covered separately in tests/e2e/x402.test.ts, since
 * it lives at the Worker boundary.
 */
process.env.NODE_ENV = "test";

import { test, describe, before, after } from "node:test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { EvidenceService, createLogger, loadConfig, type Logger } from "@aee/core";
import type { EvidenceMcpServer } from "@aee/mcp";
import { buildApp } from "../../apps/backend/src/app.js";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";
import { ERROR_HTTP_STATUS, SERVICE_VERSION } from "@aee/schemas";

const SECRET = "test-secret-value-that-is-long-enough";

// Configuration is read from the environment at loadConfig() time.
process.env.BACKEND_AUTH_SECRET = SECRET;
process.env.ALLOW_LOOPBACK_FOR_TESTS = "true";
process.env.CACHE_ENABLED = "false";
// The x402 paywall now lives in the backend. These suites exercise the evidence
// pipeline, not payment, so they bypass it - which requires BOTH this flag and a
// non-mainnet network, so it cannot make a production deploy free.
process.env.DEV_BYPASS_PAYMENT = "true"; // cache behaviour is covered in packages/cache
// The usage log records served requests. A line means the request carried an x402
// payment proof, NOT that a settlement completed - the facilitator settles after
// the backend responds. Point it at a scratch file.
const USAGE_LOG = `/tmp/aee-usage-${process.pid}.jsonl`;
process.env.USAGE_LOG_PATH = USAGE_LOG;
process.env.LOG_LEVEL = "error";
process.env.MAX_CONCURRENT_FETCHES = "4";

let fx: FixtureServer;
// Derived rather than imported: `fastify` lives in apps/backend/node_modules
// and is not resolvable from tests/ under pnpm's isolated layout.
let app: ReturnType<typeof buildApp>;

/** Minimal MCP stand-in: this suite tests the HTTP evidence path. */
function stubMcp(): EvidenceMcpServer {
  return {
    handleNodeRequest: async () => undefined,
    listTools: () => [],
    close: async () => undefined,
  };
}

function url(path: string): string {
  return `${fx.url}${path}`;
}

async function post(body: unknown, authenticated = true) {
  return app.inject({
    method: "POST",
    url: "/internal/v1/evidence",
    headers: authenticated ? { "x-backend-auth": SECRET } : {},
    payload: body as Record<string, unknown>,
  });
}

before(async () => {
  fx = await startFixtureServer();
  const config = loadConfig();
  const logger = createLogger("error");
  const service = new EvidenceService({ config, logger });
  app = buildApp({ config, logger, service, mcp: stubMcp() });
  await app.ready();
});

after(async () => {
  await app.close();
  await fx.close();
});

describe("origin protection", () => {
  test("rejects an unauthenticated evidence request", async () => {
    const res = await post({ question: "anything", urls: [url("/company")] }, false);
    assert.equal(res.statusCode, 401);
    const body = res.json();
    assert.equal(body.error.code, "UNAUTHORIZED");
    assert.ok(body.error.request_id, "error envelope must carry a request id");
  });

  test("rejects a wrong secret", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/internal/v1/evidence",
      headers: { "x-backend-auth": "wrong-secret-wrong-secret" },
      payload: { question: "x", urls: [url("/company")] },
    });
    assert.equal(res.statusCode, 401);
  });

  test("the buyer CLI is downloadable without a credential", async () => {
    // This is the zero-install purchase path: a buyer with no npm account
    // fetches one file and runs it. It must be public and must not 401.
    const res = await app.inject({ method: "GET", url: "/buy.mjs" });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] as string, /javascript/);
    const body = res.body;
    assert.ok(body.length > 1000, "the bundled CLI should not be empty");
    // It must never embed the origin secret, nor hard-code a wallet key.
    assert.ok(!body.includes(SECRET), "the CLI must not contain the origin secret");
    // Note: a naive /0x[0-9a-fA-F]{64}/ would false-positive here — the bundle
    // legitimately contains viem's secp256k1 field prime and compiled contract
    // bytecode. What must never appear is a key ASSIGNED as a literal; the CLI
    // is required to read it from the environment.
    assert.ok(
      !/PRIVATE_KEY["'\s]*[:=]["'\s]*0x[0-9a-fA-F]{64}/.test(body),
      "the CLI must not hard-code a private key",
    );
    assert.ok(body.includes("X402_PRIVATE_KEY"), "the CLI should read the key from the environment");
  });

  test("a served request is recorded in the usage log", async () => {
    // The Worker gates this route with x402, so a 200 here means a payment was
    // accepted. The log must capture that, and must NOT capture the question.
    const secret = "SEKRIT-QUESTION-TEXT-do-not-log";
    const res = await app.inject({
      method: "POST",
      url: "/internal/v1/evidence",
      headers: { "x-backend-auth": SECRET },
      payload: {
        question: `${secret} manufacturer of centrifugal pumps?`,
        urls: [`${fx.url}/company`],
      },
    });
    assert.equal(res.statusCode, 200);

    const raw = await readFile(USAGE_LOG, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    assert.ok(lines.length > 0, "the usage log should have at least one line");

    const last = JSON.parse(lines[lines.length - 1] as string);
    assert.equal(last.outcome, "ok");
    assert.equal(last.assessment, "supported");
    assert.ok(last.question_hash && last.question_hash.length === 16);
    assert.ok(last.sources_retrieved >= 1);
    assert.ok(typeof last.processing_ms === "number");
    assert.ok(last.ts && Date.parse(last.ts) > 0);

    // Privacy: the question text must never be written.
    assert.ok(!raw.includes(secret), "the usage log must not contain the question text");

    // A direct internal call carries no payment proof, so it must not look like
    // buyer traffic.
    assert.equal(last.payment_provided, false, "an operator/test call has no payment proof");
  });

  test("a request carrying a payment proof is recorded as such", async () => {
    // The Worker forwards `payment-signature` on paid requests; its presence is
    // what makes a line count as revenue.
    const res = await app.inject({
      method: "POST",
      url: "/internal/v1/evidence",
      headers: { "x-backend-auth": SECRET, "payment-signature": "test-proof-not-a-real-payment" },
      payload: { question: "manufacturer of centrifugal pumps?", urls: [`${fx.url}/company`] },
    });
    assert.equal(res.statusCode, 200);

    const lines = (await readFile(USAGE_LOG, "utf8")).trim().split("\n").filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1] as string);
    assert.equal(last.payment_provided, true, "a request with a payment proof is buyer traffic");
  });

  test("the reported version follows configuration, not a compiled constant", async () => {
    // Regression: /health used the compiled SERVICE_VERSION constant while the
    // MCP server used config.serviceVersion. The Docker image pinned
    // SERVICE_VERSION=0.1.0, so the REST probe reported 0.1.1 while the MCP
    // serverInfo and health tool reported 0.1.0 - three interfaces disagreeing
    // about which release was running.
    //
    // The invariant: whatever version is configured is the version every
    // interface reports. MCP is verified against the live deployment by
    // buyer/mcp-client-test.mjs, because the MCP route hijacks the raw socket and
    // cannot be driven through app.inject.
    const configured = loadConfig().serviceVersion;
    assert.equal(configured, SERVICE_VERSION, "with no override, config equals the constant");

    const override = { ...loadConfig(), serviceVersion: "9.9.9-test" };
    const overrideLogger = createLogger("error");
    const configuredApp = buildApp({
      config: override,
      logger: overrideLogger,
      service: new EvidenceService({ config: override, logger: overrideLogger }),
      mcp: stubMcp(),
    });
    await configuredApp.ready();
    const res = await configuredApp.inject({ method: "GET", url: "/health" });
    assert.equal(
      res.json().version,
      "9.9.9-test",
      "an operator override must be reflected, not silently replaced by the constant",
    );
    await configuredApp.close();
  });

  test("health is reachable without a credential and leaks nothing", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, "ok");
    assert.equal(body.service, "agent-evidence-api");
    assert.equal(Object.keys(body).length, 3, "health must expose exactly 3 fields");
    assert.ok(!JSON.stringify(body).includes(SECRET));
  });
});

describe("request validation", () => {
  test("rejects a missing question", async () => {
    const res = await post({ urls: [url("/company")] });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "INVALID_REQUEST");
  });

  test("rejects an empty question", async () => {
    const res = await post({ question: "   ", urls: [url("/company")] });
    assert.equal(res.statusCode, 400);
  });

  test("rejects a request with no sources", async () => {
    const res = await post({ question: "Is X a manufacturer?" });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error.message, /at least one source/i);
  });

  test("rejects too many URLs", async () => {
    const res = await post({
      question: "too many",
      urls: Array.from({ length: 25 }, (_, i) => url(`/company?i=${i}`)),
    });
    assert.equal(res.statusCode, 400);
  });

  test("a request where NO source is retrieved fails instead of charging", async () => {
    // The x402 middleware settles any handler response below 400. Returning 200
    // here meant billing the buyer $0.03 for an empty result, so the whole point
    // of this test is that the status is >= 400.
    const res = await app.inject({
      method: "POST",
      url: "/internal/v1/evidence",
      headers: { "x-backend-auth": SECRET },
      payload: {
        question: "anything",
        urls: [`${fx.url}/404`, `http://10.0.0.1/blocked`],
      },
    });

    assert.ok(res.statusCode >= 400, `must not settle: got ${res.statusCode}`);
    const body = res.json();
    assert.equal(body.error.code, "NO_SOURCES_RETRIEVED");
    assert.equal(ERROR_HTTP_STATUS.NO_SOURCES_RETRIEVED, res.statusCode);
    // The buyer must be told no payment was taken.
    assert.match(body.error.message, /no payment/i);
  });

  test("partial success still settles, because real evidence was delivered", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/internal/v1/evidence",
      headers: { "x-backend-auth": SECRET },
      payload: {
        question: "Is Rotamech Industries a manufacturer of centrifugal pumps?",
        urls: [`${fx.url}/company`, `http://10.0.0.1/blocked`],
        max_sources: 2,
      },
    });

    assert.equal(res.statusCode, 200, "one good source must still be billable");
    const body = res.json();
    assert.equal(body.sources.filter((s: { status: number | null }) => s.status === 200).length, 1);
    assert.ok(
      body.limitations.some((l: string) => /could not be retrieved/.test(l)),
      "the failure must still be disclosed",
    );
  });

  test("the request log carries SPEC section 24's required fields", async () => {
    // Section 24 requires the request log to record the source counts, cache
    // hits, payment outcome and error code. The route knows them and the
    // onResponse hook emits them, so a refactor of either could silently drop
    // them - this pins the contract.
    const captured: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const capturing: Logger = {
      debug: (message, fields) => captured.push({ message, fields }),
      info: (message, fields) => captured.push({ message, fields }),
      warn: () => undefined,
      error: () => undefined,
      child() {
        return this;
      },
    };

    const config = loadConfig();
    const probe = buildApp({
      config,
      logger: capturing,
      service: new EvidenceService({ config, logger: capturing }),
      mcp: stubMcp(),
    });
    await probe.ready();

    await probe.inject({
      method: "POST",
      url: "/internal/v1/evidence",
      headers: { "x-backend-auth": SECRET, "payment-signature": "proof-for-log-test" },
      payload: { question: "manufacturer of centrifugal pumps?", urls: [`${fx.url}/company`, `${fx.url}/404`], max_sources: 2 },
    });
    await probe.close();

    const requestLine = captured.filter((c) => c.message === "request").pop();
    assert.ok(requestLine, "a request line must be emitted");
    const f = requestLine.fields ?? {};

    assert.equal(typeof f.request_id, "string", "request ID");
    assert.equal(f.sources_total, 2, "number of sources");
    assert.equal(f.sources_ok, 1, "successful fetch count");
    assert.equal(f.sources_failed, 1, "failed fetch count");
    assert.equal(typeof f.cache_hits, "number", "cache hit/miss");
    assert.equal(f.payment_provided, true, "payment verification outcome");
    assert.equal(f.error_code, null, "high-level error code (null on success)");
    assert.equal(typeof f.duration_ms, "number", "duration");
  });

  test("a malformed JSON body produces a canonical error, not a stack trace", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/internal/v1/evidence",
      headers: { "x-backend-auth": SECRET, "content-type": "application/json" },
      payload: "{ not json",
    });
    assert.ok(res.statusCode >= 400);
    assert.ok(!res.body.includes("at "), "response must not contain a stack trace");
  });
});

describe("evidence pipeline", () => {
  test("returns a complete, schema-shaped response for one supporting source", async () => {
    const res = await post({
      question: "Is Rotamech Industries a manufacturer of centrifugal pumps?",
      urls: [url("/company")],
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();

    // Envelope
    assert.match(body.request_id, /^req_/);
    assert.equal(body.version, "1");
    assert.ok(body.question.length > 0);
    assert.ok(["supported", "contradicted", "mixed", "inconclusive"].includes(body.assessment.status));
    assert.ok(body.assessment.basis.length > 0, "assessment must state its basis");
    assert.ok(Number.isInteger(body.processing_ms) && body.processing_ms >= 0);
    assert.ok(Array.isArray(body.limitations));

    // Provenance on every source
    assert.equal(body.sources.length, 1);
    const s = body.sources[0];
    assert.equal(s.requested_url, url("/company"));
    assert.equal(s.final_url, url("/company"));
    assert.equal(s.status, 200);
    assert.match(s.content_type ?? "", /text\/html/);
    assert.ok(s.title, "title should be extracted");
    assert.ok(s.retrieved_at && Date.parse(s.retrieved_at) > 0, "retrieval time required");
    assert.match(s.content_hash_sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.ok(s.word_count > 0);
    assert.ok(Array.isArray(s.evidence));
    assert.equal(s.from_cache, false);
    assert.deepEqual(s.redirect_chain, []);
    assert.ok(s.structured_data.open_graph !== undefined);
    assert.ok(Array.isArray(s.structured_data.json_ld));
    assert.equal(s.structured_data.json_ld.length, 1, "the fixture carries one JSON-LD block");

    // Evidence items must be short, cited, and carry a relevance label
    assert.ok(s.evidence.length > 0, "a matching source must yield evidence items");
    for (const item of s.evidence) {
      assert.ok(item.excerpt.length > 0 && item.excerpt.length <= 4000);
      assert.ok(["direct", "supporting", "contradictory", "context"].includes(item.relevance));
    }
    assert.equal(body.assessment.status, "supported");
  });

  test("a negating source yields contradicted", async () => {
    const res = await post({
      question: "Is Rotamech Industries a manufacturer of centrifugal pumps?",
      urls: [url("/negating")],
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().assessment.status, "contradicted");
  });

  test("agreeing and negating sources together yield mixed", async () => {
    const res = await post({
      question: "Is Rotamech Industries a manufacturer of centrifugal pumps?",
      urls: [url("/company"), url("/negating")],
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.sources.length, 2);
    assert.equal(body.assessment.status, "mixed");
  });

  test("an irrelevant source yields inconclusive, never a fabricated claim", async () => {
    const res = await post({
      question: "Is Rotamech Industries a manufacturer of centrifugal pumps?",
      urls: [url("/irrelevant")],
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.assessment.status, "inconclusive");
    assert.equal(body.sources[0].evidence.length, 0);
  });

  test("follows redirects and reports the final URL and chain", async () => {
    const res = await post({ question: "manufacturer of centrifugal pumps?", urls: [url("/redirect-once")] });
    const s = res.json().sources[0];
    assert.equal(s.final_url, url("/company"));
    assert.equal(s.redirect_chain.length, 1);
  });

  test("a blocked URL is reported per-source without failing the request", async () => {
    const res = await post({
      question: "Is Rotamech Industries a manufacturer of centrifugal pumps?",
      urls: [url("/company"), "http://169.254.169.254/latest/meta-data/"],
    });
    assert.equal(res.statusCode, 200, "one bad URL must not sink the whole request");
    const body = res.json();
    assert.equal(body.sources.length, 2);

    const blocked = body.sources[1];
    assert.equal(blocked.status, null);
    assert.equal(blocked.evidence.length, 0);
    assert.ok(blocked.warnings.length > 0, "a failed source must explain itself");
    assert.ok(["BLOCKED_URL", "SSRF_ATTEMPT", "INVALID_URL"].includes(blocked.warnings[0].code));
    assert.ok(body.limitations.some((l: string) => /could not be retrieved/i.test(l)));
  });

  test("a 404 upstream is recorded as provenance rather than an error", async () => {
    // Paired with a good source: when EVERY source fails the request is now a
    // NO_SOURCES_RETRIEVED error, so the buyer is not charged for an empty result.
    const res = await post({
      question: "manufacturer of centrifugal pumps?",
      urls: [url("/404"), url("/company")],
      max_sources: 2,
    });
    assert.equal(res.statusCode, 200);
    const s = res.json().sources[0];
    assert.equal(s.status, 404);
    assert.ok(s.warnings.some((w: { code: string }) => w.code === "UPSTREAM_HTTP_FAILURE"));
  });

  test("malformed HTML does not crash extraction", async () => {
    const res = await post({ question: "paragraph", urls: [url("/malformed")] });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().sources[0].status, 200);
  });

  test("de-duplicates repeated URLs", async () => {
    const res = await post({
      question: "manufacturer of centrifugal pumps?",
      urls: [url("/company"), url("/company")],
    });
    assert.equal(res.json().sources.length, 1);
  });

  test("respects max_sources", async () => {
    const res = await post({
      question: "manufacturer of centrifugal pumps?",
      urls: [url("/company"), url("/negating"), url("/irrelevant")],
      max_sources: 2,
    });
    assert.equal(res.json().sources.length, 2);
  });
});
