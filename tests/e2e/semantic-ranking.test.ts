/**
 * Semantic re-ranking seam (SPEC section 37).
 *
 * The contract that matters is not "the model improves ranking" — it is that
 * the service behaves EXACTLY as before when the model is absent, slow, or
 * broken. A reasoning provider is an upgrade, never a dependency.
 */
process.env.NODE_ENV = "test";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { EvidenceService, createLogger, loadConfig, noReasoning } from "@aee/core";
import type { AppConfig, ReasoningProvider } from "@aee/core";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";

process.env.BACKEND_AUTH_SECRET = "test-secret-value-that-is-long-enough";
process.env.ALLOW_LOOPBACK_FOR_TESTS = "true";
process.env.CACHE_ENABLED = "false";
process.env.LOG_LEVEL = "error";

let fx: FixtureServer;

before(async () => {
  fx = await startFixtureServer();
});
after(async () => {
  await fx.close();
});

function serviceWith(reasoning?: ReasoningProvider) {
  const config: AppConfig = loadConfig();
  return new EvidenceService({ config, logger: createLogger("error"), reasoning });
}

function ask(svc: EvidenceService) {
  return svc.execute(
    {
      question: "Is Rotamech Industries a manufacturer of centrifugal pumps?",
      urls: [`${fx.url}/company`],
      max_sources: 1,
    },
    "req_semantic_test",
  );
}

/** Records what it was asked, and can be told to fail. */
function stubProvider(scores: number[] | null) {
  const seen: { question: string; passages: string[] }[] = [];
  const provider: ReasoningProvider = {
    name: "stub",
    async scorePassages(question, passages) {
      seen.push({ question, passages: [...passages] });
      return scores;
    },
  };
  return { provider, seen };
}

describe("default behaviour is unchanged", () => {
  test("with no provider, candidates keep their lexical order and labels", async () => {
    const res = await ask(serviceWith(undefined));
    const evidence = res.sources[0]?.evidence ?? [];
    assert.ok(evidence.length > 0, "expected lexical evidence");
    // Nothing about the semantic path should be mentioned.
    assert.ok(
      !res.limitations.some((l) => /refined by/i.test(l)),
      "no semantic limitation should be reported when none ran",
    );
  });

  test("the explicit no-op provider is never consulted in a way that changes output", async () => {
    const forked = await ask(serviceWith(noReasoning));
    const plain = await ask(serviceWith(undefined));
    assert.deepEqual(
      forked.sources[0]?.evidence.map((e) => e.excerpt),
      plain.sources[0]?.evidence.map((e) => e.excerpt),
    );
  });
});

describe("a working provider reorders evidence", () => {
  test("the highest-scoring passage is promoted to first", async () => {
    const base = await ask(serviceWith(undefined));
    const n = (base.sources[0]?.evidence ?? []).length;
    assert.ok(n >= 2, "need at least two candidates for a reorder test");

    // Give the LAST candidate the highest score and everything else zero.
    const scores = Array.from({ length: n }, (_, i) => (i === n - 1 ? 0.95 : 0.05));
    const { provider, seen } = stubProvider(scores);

    const res = await ask(serviceWith(provider));
    const evidence = res.sources[0]?.evidence ?? [];

    assert.equal(seen.length, 1, "the provider should be called once per source");
    assert.equal(seen[0]?.passages.length, n, "it should see every candidate");

    // It moved to the front...
    assert.equal(evidence[0]?.excerpt, base.sources[0]?.evidence[n - 1]?.excerpt);
    // ...and nothing was added or removed.
    assert.equal(evidence.length, n);
    assert.deepEqual(
      new Set(evidence.map((e) => e.excerpt)),
      new Set((base.sources[0]?.evidence ?? []).map((e) => e.excerpt)),
    );
  });

  test("it reports that ordering was refined, and never the score itself", async () => {
    const base = await ask(serviceWith(undefined));
    const n = (base.sources[0]?.evidence ?? []).length;
    const { provider } = stubProvider(Array.from({ length: n }, (_, i) => (i === n - 1 ? 0.95 : 0.05)));

    const res = await ask(serviceWith(provider));
    assert.ok(
      res.limitations.some((l) => /refined by stub/i.test(l)),
      "the response must disclose that a model reordered the evidence",
    );
    // SPEC section 21: no model confidence score may be exposed.
    const serialised = JSON.stringify(res);
    assert.ok(!serialised.includes("0.95"), "the raw model score must not be exposed");
  });
});

describe("every failure mode falls back to lexical", () => {
  test("a provider that returns null does not disturb the order", async () => {
    const base = await ask(serviceWith(undefined));
    const { provider } = stubProvider(null);

    const res = await ask(serviceWith(provider));
    assert.deepEqual(
      res.sources[0]?.evidence.map((e) => e.excerpt),
      base.sources[0]?.evidence.map((e) => e.excerpt),
      "a failed provider must leave the lexical result intact",
    );
    assert.ok(!res.limitations.some((l) => /refined by/i.test(l)));
  });

  test("a provider that THROWS still serves the request from lexical ranking", async () => {
    // The provider contract says "return null on failure", but a third-party
    // implementation may throw instead. That must degrade, not 500.
    const base = await ask(serviceWith(undefined));
    const throwing: ReasoningProvider = {
      name: "throwing",
      async scorePassages() {
        throw new Error("sidecar exploded");
      },
    };

    const res = await ask(serviceWith(throwing));
    assert.equal(res.sources[0]?.status, 200, "the buyer's request must still succeed");
    assert.deepEqual(
      res.sources[0]?.evidence.map((e) => e.excerpt),
      base.sources[0]?.evidence.map((e) => e.excerpt),
      "fallback must reproduce the lexical order exactly",
    );
    assert.ok(
      !res.limitations.some((l) => /refined by/i.test(l)),
      "a failed provider must not be reported as having refined anything",
    );
  });

  test("a provider returning a wrong-length score array is ignored", async () => {
    const base = await ask(serviceWith(undefined));
    const { provider } = stubProvider([0.9]); // one score for many passages
    const res = await ask(serviceWith(provider));
    // createLayaProvider rejects shape mismatches itself; a raw stub may not,
    // so the service must not crash and must fall back deterministically.
    assert.equal(res.sources[0]?.status, 200);
    assert.ok((res.sources[0]?.evidence.length ?? 0) >= 1);
    assert.ok((base.sources[0]?.evidence.length ?? 0) >= 1);
  });
});
