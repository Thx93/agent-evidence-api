/**
 * Robots-policy behaviour (SPEC section 19).
 *
 * The policy was previously parsed and validated but never consulted, making
 * `ignore`/`warn`/`enforce` all behave as `ignore`. These tests pin the three
 * modes against the fixture server.
 */
process.env.NODE_ENV = "test";

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EvidenceService, clearRobotsCache, createLogger, loadConfig } from "@aee/core";
import type { AppConfig } from "@aee/core";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";

process.env.BACKEND_AUTH_SECRET = "test-secret-value-that-is-long-enough";
process.env.ALLOW_LOOPBACK_FOR_TESTS = "true";
process.env.CACHE_ENABLED = "false";
process.env.LOG_LEVEL = "error";

let fx: FixtureServer;

function serviceWith(policy: "ignore" | "warn" | "enforce"): EvidenceService {
  const config: AppConfig = loadConfig();
  config.fetch.robotsPolicy = policy;
  return new EvidenceService({ config, logger: createLogger("error") });
}

/** Narrow a response to its first source, failing loudly if absent. */
function firstSource(res: { sources: Array<Record<string, unknown>> }) {
  const s = res.sources[0];
  assert.ok(s, "expected at least one source in the response");
  return s as {
    status: number | null;
    evidence: unknown[];
    warnings: Array<{ code: string; message: string }>;
  };
}

/** Ask about the path the fixture's robots.txt disallows. */
function ask(svc: EvidenceService) {
  return svc.execute(
    { question: "Is Rotamech a manufacturer of centrifugal pumps?", urls: [`${fx.url}/blocked-by-robots`] },
    "req_robots_test",
  );
}

before(async () => {
  fx = await startFixtureServer();
});

after(async () => {
  await fx.close();
});

beforeEach(() => {
  clearRobotsCache();
});

describe("robots policy", () => {
  test("ignore does not consult robots.txt and retrieves the path", async () => {
    const res = await ask(serviceWith("ignore"));
    const s = firstSource(res);
    assert.equal(s.status, 200);
    assert.ok(
      !s.warnings.some((w) => w.code === "ROBOTS_DISALLOWED"),
      "ignore mode must not attach a robots warning",
    );
  });

  test("warn retrieves the path but attaches a robots warning", async () => {
    const res = await ask(serviceWith("warn"));
    const s = firstSource(res);
    assert.equal(s.status, 200, "warn mode still retrieves");
    const warn = s.warnings.find((w) => w.code === "ROBOTS_DISALLOWED");
    assert.ok(warn, "warn mode must attach ROBOTS_DISALLOWED");
    assert.match(warn.message, /blocked-by-robots/);
  });

  test("enforce refuses the disallowed path", async () => {
    const res = await ask(serviceWith("enforce"));
    const s = firstSource(res);
    assert.equal(s.status, null, "enforce mode must not retrieve");
    assert.equal(s.evidence.length, 0);
    assert.ok(s.warnings.some((w) => w.code === "BLOCKED_URL"));
    const blocked = s.warnings.find((w) => w.code === "BLOCKED_URL");
    assert.ok(blocked, "expected a BLOCKED_URL warning");
    assert.match(blocked.message, /robots\.txt disallows/);
  });

  test("an allowed path is retrieved normally in enforce mode", async () => {
    const res = await ask(serviceWith("enforce"));
    assert.ok(res.sources.length === 1);

    const allowed = await serviceWith("enforce").execute(
      { question: "manufacturer of centrifugal pumps?", urls: [`${fx.url}/company`] },
      "req_robots_allowed",
    );
    assert.equal(firstSource(allowed).status, 200);
    assert.ok(!firstSource(allowed).warnings.some((w) => w.code === "ROBOTS_DISALLOWED"));
  });

  test("a host with no robots.txt is treated as allowed", async () => {
    // The fixture serves a permissive rule set only for "*"; an unparseable or
    // absent file must never block. /json has no disallow rule against it.
    const svc = serviceWith("enforce");
    const res = await svc.execute(
      { question: "fixture", urls: [`${fx.url}/plain`] },
      "req_robots_absent",
    );
    assert.equal(firstSource(res).status, 200);
  });
});
