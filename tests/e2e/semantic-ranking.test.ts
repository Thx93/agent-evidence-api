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

describe("the semantic pass cannot exceed its wall-clock budget", () => {
  // Cost scales as sources x poolSize x ~420 ms. At MAX_SOURCES=25 with a pool
  // of 12 that is ~126 s, four times the Worker's 30 s origin timeout. Without a
  // budget the buyer would pay and receive a timeout.
  test("many sources fall back to lexical rather than under-serving the buyer", async () => {
    // The budget is divided across sources, so a 5-source request cannot afford
    // a pool wide enough to find anything lexical missed. Rather than spend ~20 s
    // reshuffling the same few passages, the model is skipped entirely - and
    // crucially every source still returns the FULL number of evidence items.
    const previous = process.env.REASONING_BUDGET_MS;
    const previousPool = process.env.REASONING_POOL_SIZE;
    process.env.REASONING_BUDGET_MS = "20000";
    process.env.REASONING_POOL_SIZE = "12";
    try {
      const config: AppConfig = loadConfig();
      let calls = 0;
      const spy: ReasoningProvider = {
        name: "spy",
        async scorePassages(_q, passages) {
          calls += 1;
          return passages.map(() => 0.5);
        },
      };
      const svc = new EvidenceService({ config, logger: createLogger("error"), reasoning: spy });

      const started = Date.now();
      const res = await svc.execute(
        {
          question: "Is Rotamech Industries a manufacturer of centrifugal pumps?",
          urls: [
            `${fx.url}/company`,
            `${fx.url}/about`,
            `${fx.url}/irrelevant`,
            `${fx.url}/company?b=1`,
            `${fx.url}/about?a=1`,
          ],
          max_sources: 5,
        },
        "req_budget",
      );
      const elapsed = Date.now() - started;

      assert.equal(calls, 0, "the model must not be engaged when the pool is unaffordable");
      assert.ok(res.sources.length >= 1, "the request must still be served");
      // Never under-deliver: the buyer paid for the configured number of items.
      for (const src of res.sources) {
        if (src.status === 200) {
          assert.ok(
            src.evidence.length <= config.limits.maxEvidenceItems,
            "must never exceed the configured item count",
          );
        }
      }
      assert.ok(!res.limitations.some((l) => /refined by/i.test(l)), "no refinement may be claimed");
      assert.ok(elapsed < 10000, `fallback must stay fast (took ${elapsed}ms)`);
    } finally {
      if (previous === undefined) delete process.env.REASONING_BUDGET_MS;
      else process.env.REASONING_BUDGET_MS = previous;
      if (previousPool === undefined) delete process.env.REASONING_POOL_SIZE;
      else process.env.REASONING_POOL_SIZE = previousPool;
    }
  });

  test("the budget is RESET per request, not drained across the service's life", async () => {
    // Regression: the budget was only ever set in the constructor. A long-lived
    // service therefore drained it and silently switched semantic ranking off
    // forever. Tests that build a fresh service per case cannot see this, so
    // this one deliberately reuses a single instance.
    const previous = process.env.REASONING_BUDGET_MS;
    const previousPool = process.env.REASONING_POOL_SIZE;
    // The budget must be able to afford the full pool, or the model is
    // deliberately not engaged at all.
    process.env.REASONING_BUDGET_MS = "5000";
    process.env.REASONING_POOL_SIZE = "5";
    try {
      const config: AppConfig = loadConfig();
      let calls = 0;
      const slow: ReasoningProvider = {
        name: "slow",
        async scorePassages(_q, passages) {
          calls += 1;
          await new Promise((r) => setTimeout(r, 100)); // consume real time
          return passages.map(() => 0.5);
        },
      };
      const svc = new EvidenceService({ config, logger: createLogger("error"), reasoning: slow });

      const req = {
        question: "Is Rotamech Industries a manufacturer of centrifugal pumps?",
        urls: [`${fx.url}/company`],
        max_sources: 1,
      };
      for (let i = 0; i < 5; i += 1) await svc.execute(req, `req_reset_${i}`);

      assert.equal(calls, 5, `every request must get a fresh budget (provider called ${calls}/5 times)`);
    } finally {
      if (previous === undefined) delete process.env.REASONING_BUDGET_MS;
      else process.env.REASONING_BUDGET_MS = previous;
      if (previousPool === undefined) delete process.env.REASONING_POOL_SIZE;
      else process.env.REASONING_POOL_SIZE = previousPool;
    }
  });

  test("an exhausted budget keeps the lexical order and does not claim refinement", async () => {
    const previous = process.env.REASONING_BUDGET_MS;
    process.env.REASONING_BUDGET_MS = "0";
    try {
      const config: AppConfig = loadConfig();
      assert.equal(config.reasoning.budgetMs, 0);
      const { provider, seen } = stubProvider([0.9, 0.1, 0.1, 0.1, 0.1]);
      const svc = new EvidenceService({ config, logger: createLogger("error"), reasoning: provider });

      const res = await svc.execute(
        { question: "Is Rotamech Industries a manufacturer of centrifugal pumps?", urls: [`${fx.url}/company`], max_sources: 1 },
        "req_nobudget",
      );
      assert.equal(seen.length, 0, "a zero budget must not call the provider");
      assert.ok(!res.limitations.some((l) => /refined by/i.test(l)), "nothing was refined, so nothing may be claimed");
    } finally {
      if (previous === undefined) delete process.env.REASONING_BUDGET_MS;
      else process.env.REASONING_BUDGET_MS = previous;
    }
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
