/**
 * Cache tests (SPEC section 26: miss, hit, expiration, invalidation, bounded
 * retention).
 *
 * Everything runs against `:memory:` except one file-backed case, which uses a
 * throwaway temp directory that is removed afterwards. No test sleeps: expiry
 * is exercised with explicit past `expiresAt` values and a zero TTL, so the
 * suite stays fast and deterministic.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { cacheKey, createSqliteCache } from "./index.js";
import type { CacheProvider, CacheRecord, SqliteCacheOptions } from "./index.js";

/** Fixed base for `storedAt` values we want ordered but not relative to now. */
const BASE_EPOCH_MS = Date.parse("2024-01-01T00:00:00.000Z");

/** ISO timestamp `offsetMs` from the real current time. */
function isoFromNow(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** Deterministic, strictly increasing `storedAt` values. */
function isoSequence(n: number): string {
  return new Date(BASE_EPOCH_MS + n * 1_000).toISOString();
}

const liveExpiry = (): string => isoFromNow(60 * 60 * 1_000);
const pastExpiry = (): string => isoFromNow(-1_000);

function makeRecord(
  key: string,
  overrides: Partial<Omit<CacheRecord, "key">> = {},
): CacheRecord {
  const now = new Date().toISOString();
  return {
    key,
    url: "https://example.com/source",
    finalUrl: "https://example.com/source-final",
    status: 200,
    contentType: "text/html; charset=utf-8",
    contentHash: "a".repeat(64),
    payload: { title: "Example", excerpt: "bounded extracted representation" },
    retrievedAt: now,
    storedAt: now,
    expiresAt: liveExpiry(),
    bytes: 128,
    ...overrides,
  };
}

function memoryCache(overrides: Partial<SqliteCacheOptions> = {}): CacheProvider {
  return createSqliteCache({
    path: ":memory:",
    ttlSeconds: 3_600,
    maxEntries: 100,
    ...overrides,
  });
}

describe("cacheKey", () => {
  it("is stable across host case, fragment and query-parameter order", () => {
    const a = cacheKey("https://Example.COM/a/?b=2&a=1#section-3");
    const b = cacheKey("https://example.com/a?a=1&b=2");
    assert.equal(a, b);
    assert.equal(a, "https://example.com/a?a=1&b=2");
  });

  it("drops tracking parameters (utm_*, fbclid, gclid, ref, mc_cid, mc_eid)", () => {
    const noisy = cacheKey(
      "https://example.com/x?utm_source=news&utm_medium=email&utm_campaign=q1" +
        "&fbclid=abc&gclid=def&ref=home&mc_cid=1&mc_eid=2&keep=1",
    );
    assert.equal(noisy, cacheKey("https://example.com/x?keep=1"));
    assert.equal(noisy, "https://example.com/x?keep=1");
  });

  it("drops tracking parameters case-insensitively", () => {
    assert.equal(
      cacheKey("https://example.com/x?UTM_Source=news&FBCLID=abc"),
      cacheKey("https://example.com/x"),
    );
  });

  it("removes one trailing slash except on the root path", () => {
    assert.equal(cacheKey("https://example.com/a/"), "https://example.com/a");
    assert.equal(cacheKey("https://example.com/"), "https://example.com/");
    assert.equal(cacheKey("https://example.com"), "https://example.com/");
  });

  it("keeps distinct paths and schemes distinct", () => {
    assert.notEqual(cacheKey("https://example.com/a"), cacheKey("https://example.com/b"));
    assert.notEqual(cacheKey("https://example.com/a"), cacheKey("http://example.com/a"));
  });

  it("ignores userinfo so credentials never reach keys", () => {
    assert.equal(
      cacheKey("https://user:secret@example.com/a"),
      cacheKey("https://example.com/a"),
    );
  });

  it("orders repeated parameter names by value", () => {
    assert.equal(
      cacheKey("https://example.com/x?q=2&q=1"),
      cacheKey("https://example.com/x?q=1&q=2"),
    );
    assert.equal(cacheKey("https://example.com/x?q=2&q=1"), "https://example.com/x?q=1&q=2");
  });

  it("throws TypeError on unparseable input", () => {
    for (const bad of ["", "   ", "not a url", "http://", "://x", "/relative/path"]) {
      assert.throws(() => cacheKey(bad), TypeError, `expected TypeError for ${JSON.stringify(bad)}`);
    }
    // Runtime guard for untyped callers.
    // @ts-expect-error -- deliberately wrong type
    assert.throws(() => cacheKey(123), TypeError);
  });
});

describe("sqlite cache (:memory:)", () => {
  it("returns null on a miss and always returns promises", async () => {
    const cache = memoryCache();
    const pending = cache.get("https://example.com/never-seen");
    assert.ok(pending instanceof Promise, "get() must be asynchronous");
    assert.equal(await pending, null);
    await cache.close();
  });

  it("round-trips a record through set and get", async () => {
    const cache = memoryCache();
    const record = makeRecord("k1");
    await cache.set(record);

    const got = await cache.get("k1");
    assert.deepEqual(got, record);
    await cache.close();
  });

  it("treats an expired row as absent", async () => {
    const cache = memoryCache();
    await cache.set(makeRecord("stale", { expiresAt: pastExpiry() }));

    assert.equal(await cache.get("stale"), null);
    const stats = await cache.stats();
    assert.equal(stats.entries, 0, "expired rows are not counted as live");
    assert.equal(stats.expired, 1, "the row is still physically present until cleanup");
    await cache.close();
  });

  it("applies the configured TTL when expiresAt is blank", async () => {
    const cache = memoryCache({ ttlSeconds: 60 });
    await cache.set(makeRecord("ttl", { expiresAt: "" }));

    const got = await cache.get("ttl");
    assert.ok(got, "a record with a blank expiresAt gets the default TTL");
    const remaining = Date.parse(got.expiresAt) - Date.now();
    assert.ok(remaining > 55_000 && remaining <= 60_000, `unexpected TTL: ${remaining}ms`);
    await cache.close();
  });

  it("treats a zero TTL as immediately expired", async () => {
    const cache = memoryCache({ ttlSeconds: 0 });
    await cache.set(makeRecord("zero-ttl", { expiresAt: "" }));
    assert.equal(await cache.get("zero-ttl"), null);
    await cache.close();
  });

  it("deletes a row and ignores deletes of missing keys", async () => {
    const cache = memoryCache();
    await cache.set(makeRecord("k1"));
    assert.ok(await cache.get("k1"));

    await cache.delete("k1");
    assert.equal(await cache.get("k1"), null);
    await cache.delete("k1");
    assert.equal((await cache.stats()).entries, 0);
    await cache.close();
  });

  it("replaces an existing key without duplicating it", async () => {
    const cache = memoryCache();
    await cache.set(makeRecord("k1", { payload: { title: "first" }, bytes: 10 }));
    await cache.set(makeRecord("k1", { payload: { title: "second" }, bytes: 20 }));

    const stats = await cache.stats();
    assert.equal(stats.entries, 1);
    assert.equal(stats.totalBytes, 20);

    const got = await cache.get("k1");
    assert.deepEqual(got?.payload, { title: "second" });
    await cache.close();
  });

  it("cleanup removes expired rows and returns the number removed", async () => {
    const cache = memoryCache();
    await cache.set(makeRecord("live-1"));
    await cache.set(makeRecord("live-2"));
    await cache.set(makeRecord("dead-1", { expiresAt: pastExpiry() }));
    await cache.set(makeRecord("dead-2", { expiresAt: pastExpiry() }));

    assert.equal(await cache.cleanup(), 2);
    const stats = await cache.stats();
    assert.equal(stats.entries, 2);
    assert.equal(stats.expired, 0);
    assert.equal(await cache.cleanup(), 0, "a second cleanup has nothing left to remove");
    await cache.close();
  });

  it("enforces maxEntries on set, evicting the oldest first", async () => {
    const cache = memoryCache({ maxEntries: 3 });
    for (let i = 0; i < 5; i += 1) {
      await cache.set(
        makeRecord(`p${i}`, {
          url: `https://example.com/p${i}`,
          storedAt: isoSequence(i),
          payload: { i },
        }),
      );
    }

    const stats = await cache.stats();
    assert.equal(stats.entries, 3);
    assert.equal(stats.totalBytes, 3 * 128);

    for (const kept of ["p4", "p3", "p2"]) {
      assert.ok(await cache.get(kept), `${kept} should have been kept as the newest`);
    }
    for (const evicted of ["p1", "p0"]) {
      assert.equal(await cache.get(evicted), null, `${evicted} should have been evicted`);
    }
    await cache.close();
  });

  it("reports live entries, expired backlog, oldest storedAt and live bytes", async () => {
    const cache = memoryCache();
    await cache.set(makeRecord("a", { storedAt: isoSequence(1), bytes: 100 }));
    await cache.set(makeRecord("b", { storedAt: isoSequence(2), bytes: 250 }));
    await cache.set(makeRecord("c", { storedAt: isoSequence(3), bytes: 999, expiresAt: pastExpiry() }));

    const stats = await cache.stats();
    assert.deepEqual(stats, {
      entries: 2,
      expired: 1,
      oldestStoredAt: isoSequence(1),
      totalBytes: 350,
    });
    await cache.close();
  });

  it("reports an empty cache without throwing", async () => {
    const cache = memoryCache();
    assert.deepEqual(await cache.stats(), {
      entries: 0,
      expired: 0,
      oldestStoredAt: null,
      totalBytes: 0,
    });
    await cache.close();
  });

  it("closes idempotently and rejects work after close", async () => {
    const cache = memoryCache();
    await cache.set(makeRecord("k1"));

    await cache.close();
    await cache.close();

    await assert.rejects(() => cache.get("k1"), /closed/);
  });
});

describe("sqlite cache (file-backed)", () => {
  it("enforces maxEntries during cleanup after the bound is lowered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aee-cache-"));
    try {
      const path = join(dir, "cache.sqlite");

      // A wide bound writes four rows...
      const wide = createSqliteCache({ path, ttlSeconds: 3_600, maxEntries: 10 });
      for (let i = 0; i < 4; i += 1) {
        await wide.set(
          makeRecord(`c${i}`, { storedAt: isoSequence(i), url: `https://example.com/c${i}` }),
        );
      }
      await wide.close();

      // ...then an operator lowers the bound and runs cleanup.
      const narrow = createSqliteCache({ path, ttlSeconds: 3_600, maxEntries: 2 });
      assert.equal(await narrow.cleanup(), 2, "cleanup evicts overflow down to maxEntries");
      assert.equal((await narrow.stats()).entries, 2);
      assert.ok(await narrow.get("c3"), "the newest rows are kept");
      assert.ok(await narrow.get("c2"));
      assert.equal(await narrow.get("c1"), null);
      await narrow.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates missing directories, uses WAL, and survives close/reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aee-cache-"));
    try {
      // A nested path proves the parent directory is created on demand.
      const path = join(dir, "nested", "cache.sqlite");
      const options: SqliteCacheOptions = { path, ttlSeconds: 3_600, maxEntries: 10 };

      const first = createSqliteCache(options);
      await first.set(makeRecord("k1", { url: "https://example.com/persisted" }));
      await first.set(makeRecord("stale", { expiresAt: pastExpiry() }));

      assert.ok(statSync(path).isFile(), "the database file exists on disk");

      // WAL is required for file-backed databases (skipped for :memory:).
      const probe = new DatabaseSync(path);
      const journal = probe.prepare("PRAGMA journal_mode").get();
      probe.close();
      assert.equal(String(journal?.journal_mode).toLowerCase(), "wal");

      assert.equal(await first.cleanup(), 1, "the expired row is removed from the file");
      await first.close();

      const second = createSqliteCache(options);
      const got = await second.get("k1");
      assert.ok(got, "the record survives a close/reopen cycle");
      assert.equal(got.url, "https://example.com/persisted");
      assert.deepEqual(await second.stats(), {
        entries: 1,
        expired: 0,
        oldestStoredAt: got.storedAt,
        totalBytes: 128,
      });
      await second.close();
      await second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
