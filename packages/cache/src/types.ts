/**
 * Cache contract for Agent Evidence API (SPEC section 16 "CACHING",
 * section 17 "DATABASE", section 37 "CacheProvider" extension point).
 *
 * The cache exists for one reason: avoid re-fetching a source we already hold
 * evidence for. It must never make stale evidence look fresh, so every record
 * carries both the time the content was actually retrieved from the origin
 * (`retrievedAt`) and the time the row stops being valid (`expiresAt`). A
 * caller that serves a cache hit is responsible for reporting `retrievedAt` as
 * the retrieval time and marking the source as coming from cache.
 */

export interface CacheRecord {
  /** Normalised cache key (see cacheKey). */
  key: string;
  url: string;
  finalUrl: string | null;
  status: number | null;
  contentType: string | null;
  /** sha256 of the normalised content, if the source was processed. */
  contentHash: string | null;
  /** Bounded, JSON-serialisable extracted representation. Never the whole raw page. */
  payload: unknown;
  /** ISO 8601 — when the content was actually retrieved from the origin. */
  retrievedAt: string;
  /** ISO 8601 — when this row was written. */
  storedAt: string;
  /** ISO 8601 — when this row stops being valid. */
  expiresAt: string;
  bytes: number;
}

export interface CacheStats {
  /** Non-expired rows only — expired rows are not servable and are not counted. */
  entries: number;
  /** Rows whose `expiresAt` has passed but that `cleanup` has not removed yet. */
  expired: number;
  /** Oldest `storedAt` among non-expired rows, or `null` when there are none. */
  oldestStoredAt: string | null;
  /** Sum of `bytes` over non-expired rows — the live, servable footprint. */
  totalBytes: number;
}

/**
 * Storage-agnostic cache interface.
 *
 * Every method is `async` **by contract**, even though the SQLite-backed
 * implementation is synchronous under the hood (`node:sqlite` is a synchronous
 * API). This is deliberate: SPEC section 37 lists `CacheProvider` as a future
 * extension point, and a later implementation may be backed by a network store.
 * Making the signature asynchronous now means swapping the implementation never
 * forces a signature change on `EvidenceService`. Do not "optimise" these
 * methods into synchronous ones.
 */
export interface CacheProvider {
  /** Returns `null` when the row is missing *or* expired. */
  get(key: string): Promise<CacheRecord | null>;
  /** Inserts or replaces the record for `record.key`. */
  set(record: CacheRecord): Promise<void>;
  /** Removes a row. Deleting a missing key is a no-op. */
  delete(key: string): Promise<void>;
  /** Removes expired rows plus any overflow, returns the number of rows removed. */
  cleanup(): Promise<number>;
  /** Observability snapshot; never throws for an empty cache. */
  stats(): Promise<CacheStats>;
  /** Releases the handle. Idempotent: calling it twice must not throw. */
  close(): Promise<void>;
}

export interface SqliteCacheOptions {
  /** File path, or ":memory:" for tests. */
  path: string;
  /** Default TTL applied when a record has no expiresAt. */
  ttlSeconds: number;
  /** Hard upper bound on retained rows; oldest evicted first. */
  maxEntries: number;
}
