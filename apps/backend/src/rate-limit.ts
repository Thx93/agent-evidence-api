/**
 * Bounded, in-process rate limiter (SPEC section 23).
 *
 * One token bucket per key (normally a client IP). A request consumes one
 * token; tokens refill continuously at `perMinute / 60000` per millisecond and
 * the bucket holds at most `perMinute + burst` tokens. Refill is lazy — it is
 * computed from the injectable clock whenever a key is touched — so there are
 * no timers and no background work (SPEC section 3).
 *
 * Memory is bounded on purpose. A naive `Map<ip, bucket>` grows without limit
 * under a spray of distinct source addresses, which is itself a denial-of-
 * service vector, so:
 *
 *   - the map is hard-capped at {@link MAX_BUCKETS}; inserting beyond the cap
 *     evicts the least-recently-used bucket first, and
 *   - buckets that have refilled to capacity and have been idle for
 *     {@link IDLE_BUCKET_TTL_MS} are collected opportunistically during a
 *     bounded sweep of the oldest entries.
 *
 * `size()` is exposed so a test can prove the bound holds.
 *
 * The bucket keeps no reference to request bodies, URLs, or headers, and the
 * key is never hashed into anything long-lived beyond this process.
 */

export interface RateLimitOptions {
  /** Sustained requests allowed per window. 0 disables limiting. */
  perMinute: number;
  /** Maximum burst above the sustained rate. */
  burst: number;
  /** Injectable clock for deterministic tests (ms since epoch). */
  now?: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds the caller should wait before retrying; 0 when allowed. */
  retryAfterSeconds: number;
  /** Remaining tokens, for diagnostics. */
  remaining: number;
}

export interface RateLimiter {
  /** Consume one token for a key (e.g. a client IP). */
  check(key: string): RateLimitDecision;
  /** For tests: forget all buckets. */
  reset(): void;
  /** For tests/diagnostics: current number of tracked keys. */
  size(): number;
}

/**
 * Hard cap on tracked buckets. Distinct source addresses beyond this are not
 * rejected — they simply share the map with older keys, and the least-recently
 * used key is evicted to make room.
 */
export const MAX_BUCKETS = 10_000;

/**
 * A bucket that is completely full and has not been touched for this long
 * carries no information worth keeping: the client is back to a clean slate,
 * and a fresh bucket would behave identically.
 */
export const IDLE_BUCKET_TTL_MS = 5 * 60_000;

/**
 * How many of the oldest buckets one `check()` inspects for idle collection.
 * Bounded so a single request never pays an O(map) sweep.
 */
const GC_SWEEP_LIMIT = 64;

const MS_PER_MINUTE = 60_000;

const UNLIMITED = Number.POSITIVE_INFINITY;

interface Bucket {
  /** Tokens currently available. Fractional between refills. */
  tokens: number;
  /** Clock reading at the last lazy refill. */
  refilledAt: number;
  /** Clock reading at the last access; drives idle collection and LRU order. */
  lastUsedAt: number;
}

export function createRateLimiter(opts: RateLimitOptions): RateLimiter {
  const { perMinute, burst } = opts;
  const now = opts.now ?? Date.now;

  // `perMinute <= 0` disables limiting entirely. Non-finite values are treated
  // as disabled rather than as an accidental unlimited-burst configuration.
  const disabled = !Number.isFinite(perMinute) || perMinute <= 0;

  const capacity = Math.max(0, perMinute + burst);
  const refillPerMs = perMinute / MS_PER_MINUTE;

  /**
   * Insertion order is recency order: reading a key deletes and re-inserts it,
   * so `keys().next()` is always the least-recently-used key. This gives LRU
   * eviction without a second data structure.
   */
  const buckets = new Map<string, Bucket>();

  function refill(bucket: Bucket, at: number): void {
    const elapsed = at - bucket.refilledAt;
    if (elapsed <= 0) return;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
    bucket.refilledAt = at;
  }

  /**
   * Opportunistically drop full, idle buckets. Walks from the oldest entry so
   * keys that are actively being used are never collected ahead of idle ones.
   * Deleting the current entry during Map iteration is well-defined.
   */
  function collectIdle(at: number): void {
    let inspected = 0;
    for (const [key, bucket] of buckets) {
      if (inspected >= GC_SWEEP_LIMIT) break;
      inspected += 1;
      refill(bucket, at);
      if (bucket.tokens >= capacity && at - bucket.lastUsedAt >= IDLE_BUCKET_TTL_MS) {
        buckets.delete(key);
      }
    }
  }

  function evictLeastRecentlyUsed(): void {
    const oldest = buckets.keys().next();
    if (!oldest.done) buckets.delete(oldest.value);
  }

  return {
    check(key: string): RateLimitDecision {
      if (disabled) {
        return { allowed: true, retryAfterSeconds: 0, remaining: UNLIMITED };
      }

      const at = now();
      collectIdle(at);

      let bucket = buckets.get(key);
      if (bucket === undefined) {
        if (buckets.size >= MAX_BUCKETS) evictLeastRecentlyUsed();
        bucket = { tokens: capacity, refilledAt: at, lastUsedAt: at };
        buckets.set(key, bucket);
      } else {
        // Mark most-recently-used: delete + re-insert moves the key to the end.
        buckets.delete(key);
        buckets.set(key, bucket);
        refill(bucket, at);
      }
      bucket.lastUsedAt = at;

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return {
          allowed: true,
          retryAfterSeconds: 0,
          remaining: Math.floor(bucket.tokens),
        };
      }

      const msUntilToken = (1 - bucket.tokens) / refillPerMs;
      return {
        allowed: false,
        // Minimum 1: a caller told to retry must always wait a visible amount,
        // even when the next token is only a fraction of a second away.
        retryAfterSeconds: Math.max(1, Math.ceil(msUntilToken / 1000)),
        remaining: 0,
      };
    },

    reset(): void {
      buckets.clear();
    },

    size(): number {
      return buckets.size;
    },
  };
}
