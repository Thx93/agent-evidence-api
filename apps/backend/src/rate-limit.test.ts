/**
 * Unit tests for the in-process token-bucket rate limiter (SPEC section 23).
 *
 * Every test drives the limiter through an injected clock, so nothing here
 * sleeps and the results are exact.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createRateLimiter,
  MAX_BUCKETS,
  IDLE_BUCKET_TTL_MS,
} from "./rate-limit.js";

describe("token bucket", () => {
  test("allows up to capacity then denies", () => {
    let now = 0;
    const perMinute = 60;
    const burst = 10;
    const limiter = createRateLimiter({ perMinute, burst, now: () => now });

    const capacity = perMinute + burst; // 70
    for (let i = 0; i < capacity; i += 1) {
      const decision = limiter.check("client-a");
      assert.equal(decision.allowed, true, `request ${i + 1} should be allowed`);
      assert.equal(decision.retryAfterSeconds, 0);
      assert.ok(decision.remaining >= 0);
    }

    const denied = limiter.check("client-a");
    assert.equal(denied.allowed, false, "the request past capacity must be denied");
    assert.equal(denied.remaining, 0);
  });

  test("a denied decision reports retryAfterSeconds >= 1", () => {
    let now = 0;
    const limiter = createRateLimiter({ perMinute: 60, burst: 0, now: () => now });

    for (let i = 0; i < 60; i += 1) assert.equal(limiter.check("k").allowed, true);

    const denied = limiter.check("k");
    assert.equal(denied.allowed, false);
    assert.ok(denied.retryAfterSeconds >= 1, "retry delay must be at least one second");
    assert.equal(Number.isInteger(denied.retryAfterSeconds), true);
  });

  test("tokens refill over the injected clock and the request is allowed again", () => {
    let now = 0;
    const limiter = createRateLimiter({ perMinute: 60, burst: 0, now: () => now });

    // Drain the bucket: capacity is 60, refill is 1 token / 1000 ms.
    for (let i = 0; i < 60; i += 1) assert.equal(limiter.check("k").allowed, true);
    assert.equal(limiter.check("k").allowed, false);

    // Half a token is not enough.
    now += 500;
    assert.equal(limiter.check("k").allowed, false, "0.5 tokens must not allow a request");

    // Another 600 ms crosses the one-token threshold.
    now += 600;
    assert.equal(limiter.check("k").allowed, true, "refilled token must allow the request");
  });

  test("perMinute <= 0 always allows", () => {
    let now = 0;
    const disabled = createRateLimiter({ perMinute: 0, burst: 0, now: () => now });
    const negative = createRateLimiter({ perMinute: -5, burst: 0, now: () => now });

    for (let i = 0; i < 1000; i += 1) {
      assert.equal(disabled.check("k").allowed, true);
      assert.equal(negative.check("k").allowed, true);
    }
    assert.equal(disabled.size(), 0, "a disabled limiter must not track buckets");
  });

  test("separate keys have independent buckets", () => {
    let now = 0;
    const limiter = createRateLimiter({ perMinute: 1, burst: 0, now: () => now });

    assert.equal(limiter.check("alice").allowed, true);
    assert.equal(limiter.check("alice").allowed, false, "alice is exhausted");
    assert.equal(limiter.check("bob").allowed, true, "bob has his own bucket");
    assert.equal(limiter.check("carol").allowed, true);
    assert.equal(limiter.size(), 3);
  });
});

describe("bounded memory", () => {
  test("the bucket map stays bounded under many distinct keys", () => {
    let now = 0;
    const limiter = createRateLimiter({ perMinute: 1, burst: 0, now: () => now });

    const inserted = MAX_BUCKETS + 5000;
    for (let i = 0; i < inserted; i += 1) {
      limiter.check(`key-${i}`);
    }

    assert.ok(
      limiter.size() <= MAX_BUCKETS,
      `size ${limiter.size()} must not exceed MAX_BUCKETS (${MAX_BUCKETS})`,
    );
    assert.equal(limiter.size(), MAX_BUCKETS, "the cap should actually be reached");
  });

  test("insertion past the cap evicts the least-recently-used key", () => {
    let now = 0;
    const limiter = createRateLimiter({ perMinute: 1, burst: 0, now: () => now });

    // `key-0` is the oldest and is evicted first once the cap is exceeded.
    for (let i = 0; i < MAX_BUCKETS + 1; i += 1) limiter.check(`key-${i}`);

    assert.equal(
      limiter.check("key-0").allowed,
      true,
      "the evicted key must come back with a fresh bucket",
    );
    assert.equal(
      limiter.check(`key-${MAX_BUCKETS}`).allowed,
      false,
      "the most recently used key is still exhausted",
    );
  });

  test("idle full buckets are collected over the injected clock", () => {
    let now = 0;
    const limiter = createRateLimiter({ perMinute: 60, burst: 0, now: () => now });

    assert.equal(limiter.check("idle-a").allowed, true);
    assert.equal(limiter.check("idle-b").allowed, true);
    assert.equal(limiter.size(), 2);

    // Long enough for both buckets to refill to capacity and go idle.
    now += IDLE_BUCKET_TTL_MS + 1000;

    // Touching an unrelated key triggers the opportunistic sweep.
    assert.equal(limiter.check("fresh").allowed, true);

    assert.equal(
      limiter.size(),
      1,
      "the two idle, full buckets must have been collected",
    );
  });

  test("a partially drained idle bucket is retained", () => {
    let now = 0;
    // capacity 11, but only 1 token refills per minute, so it is still short of
    // capacity when the idle window elapses.
    const limiter = createRateLimiter({ perMinute: 1, burst: 10, now: () => now });

    for (let i = 0; i < 11; i += 1) assert.equal(limiter.check("slow").allowed, true);

    now += IDLE_BUCKET_TTL_MS + 1000;
    assert.equal(limiter.check("other").allowed, true);

    assert.equal(
      limiter.size(),
      2,
      "a bucket that has not refilled to capacity must be kept",
    );
  });

  test("reset forgets every bucket", () => {
    let now = 0;
    const limiter = createRateLimiter({ perMinute: 60, burst: 0, now: () => now });

    limiter.check("a");
    limiter.check("b");
    assert.equal(limiter.size(), 2);

    limiter.reset();
    assert.equal(limiter.size(), 0);
    assert.equal(limiter.check("a").allowed, true);
  });
});
