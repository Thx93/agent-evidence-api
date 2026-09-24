/**
 * The append-only usage log (SPEC section 24).
 *
 * Two properties matter here and both are easy to break silently. First, the
 * question text must never be written — only a hash — so the log can be kept and
 * read without holding customer content. Second, `record` must never throw: a
 * failure to write observability must not fail a request a buyer has already
 * paid for.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUsageLog, type UsageEvent } from "../../apps/backend/src/usage-log.js";

const QUESTION = "Is Company X a manufacturer of centrifugal pumps?";

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    ts: "2026-01-01T00:00:00.000Z",
    request_id: "req_test",
    question_hash: "deadbeefdeadbeef",
    question_chars: QUESTION.length,
    sources_requested: 2,
    sources_retrieved: 2,
    evidence_items: 3,
    assessment: "supported",
    processing_ms: 812,
    outcome: "ok",
    payment_provided: true,
    ...overrides,
  };
}

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "usage-log-test-"));
  path = join(dir, "usage.jsonl");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("hashQuestion", () => {
  test("is a short, stable, opaque handle", () => {
    const log = createUsageLog({ path });
    const hash = log.hashQuestion(QUESTION);

    assert.match(hash, /^[0-9a-f]{16}$/);
    assert.equal(log.hashQuestion(QUESTION), hash, "the same question must hash the same");
  });

  test("distinguishes different questions", () => {
    const log = createUsageLog({ path });
    assert.notEqual(log.hashQuestion(QUESTION), log.hashQuestion("A different question"));
  });

  test("does not leak the question", () => {
    const log = createUsageLog({ path });
    const hash = log.hashQuestion(QUESTION);
    assert.equal(hash.includes(QUESTION), false);
    assert.equal(hash.includes("Company"), false);
  });
});

describe("enabled", () => {
  test("an empty path disables the log", () => {
    assert.equal(createUsageLog({ path: "" }).enabled, false);
  });

  test('the literal "off" disables the log', () => {
    assert.equal(createUsageLog({ path: "off" }).enabled, false);
  });

  test("a real path enables it", () => {
    assert.equal(createUsageLog({ path }).enabled, true);
  });

  test("a disabled log writes nothing and still resolves", async () => {
    const log = createUsageLog({ path: "off" });
    await log.record(event());
    assert.deepEqual(await readdir(dir), []);
  });
});

describe("record", () => {
  test("writes one parseable JSON line with every field preserved", async () => {
    const log = createUsageLog({ path });
    await log.record(event());

    const raw = await readFile(path, "utf8");
    assert.equal(raw.trim().split("\n").length, 1);

    const written = JSON.parse(raw) as UsageEvent;
    assert.deepEqual(written, event());
  });

  test("appends rather than overwrites", async () => {
    const log = createUsageLog({ path });
    await log.record(event({ request_id: "req_1" }));
    await log.record(event({ request_id: "req_2" }));

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    const [first, second] = lines;
    assert.ok(first && second, "two lines expected");
    assert.equal(JSON.parse(first).request_id, "req_1");
    assert.equal(JSON.parse(second).request_id, "req_2");
  });

  test("the log never contains the question text", async () => {
    const log = createUsageLog({ path });
    await log.record(event({ question_hash: log.hashQuestion(QUESTION) }));

    const raw = await readFile(path, "utf8");
    assert.equal(raw.includes(QUESTION), false);
    assert.equal(raw.includes("Company"), false);
  });

  test("creates a missing parent directory", async () => {
    const nested = join(dir, "deeply", "nested", "usage.jsonl");
    const log = createUsageLog({ path: nested });
    await log.record(event());

    const raw = await readFile(nested, "utf8");
    assert.match(raw, /req_test/);
  });

  test("records an error outcome and its code", async () => {
    const log = createUsageLog({ path });
    await log.record(event({ outcome: "error", error_code: "SSRF_ATTEMPT" }));

    const written = JSON.parse(await readFile(path, "utf8")) as UsageEvent;
    assert.equal(written.outcome, "error");
    assert.equal(written.error_code, "SSRF_ATTEMPT");
  });

  test("records payment_provided: false without complaint", async () => {
    // An operator or test call carries no proof. It must be recorded as such and
    // must not be dropped, so the log keeps the distinction that lets a buyer's
    // request be told apart from the operator's own.
    const log = createUsageLog({ path });
    await log.record(event({ payment_provided: false }));

    const written = JSON.parse(await readFile(path, "utf8")) as UsageEvent;
    assert.equal(written.payment_provided, false);
  });

  test("never rejects when the log cannot be written", async () => {
    // A path whose parent is a plain file cannot become a directory: every write
    // fails. Logging is observability, not correctness, so this must be swallowed
    // rather than surfaced to a buyer who has already paid.
    const blocking = join(dir, "blocker");
    await writeFile(blocking, "not a directory", "utf8");
    const log = createUsageLog({ path: join(blocking, "usage.jsonl") });

    await assert.doesNotReject(() => log.record(event()));
    await assert.doesNotReject(() => log.record(event()));
  });
});
