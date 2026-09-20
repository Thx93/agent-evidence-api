/**
 * `@aee/cache` — bounded SQLite-backed evidence cache.
 *
 * Public surface. It is deliberately small: the cache is an adapter behind the
 * `CacheProvider` interface (SPEC section 37), not a place for business logic.
 * See `types.ts` for why the interface is asynchronous even though the
 * `node:sqlite` driver underneath is synchronous.
 */

export type { CacheProvider, CacheRecord, CacheStats, SqliteCacheOptions } from "./types.js";
export { cacheKey } from "./cache-key.js";
export { createSqliteCache } from "./sqlite-cache.js";
