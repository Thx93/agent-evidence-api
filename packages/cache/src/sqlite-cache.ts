/**
 * Bounded SQLite cache backed by Node's built-in `node:sqlite` (SPEC section 16,
 * section 17).
 *
 * Why `node:sqlite` and not `better-sqlite3`/`sqlite3`:
 * - zero native dependencies to compile, ship, or audit
 * - no install-step supply-chain surface
 * - the driver is synchronous, which is fine for the bounded, small queries used
 *   here and keeps the code boring
 *
 * The synchronous driver is hidden behind the asynchronous `CacheProvider`
 * interface (see `types.ts`) so a network-backed store can replace it later
 * without touching callers — SPEC section 37.
 *
 * Freshness rule: expired rows are *invisible*. `get` filters them out and
 * `cleanup` deletes them, so stale evidence can never be served as fresh.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { CacheProvider, CacheRecord, CacheStats, SqliteCacheOptions } from "./types.js";

/**
 * Single `entries` table, one row per cached source.
 *
 * `expiresAt` is stored as a canonical ISO 8601 UTC string so that plain
 * lexicographic comparison in SQL is equivalent to chronological comparison.
 * Input timestamps are normalised through {@link toIso} before they are bound,
 * which is what makes that assumption safe.
 *
 * `STRICT` is used so a bug in the mapping layer fails loudly at write time
 * instead of silently storing a value of the wrong type. It requires SQLite
 * >= 3.37, which every Node release that ships `node:sqlite` bundles.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS entries (
  key         TEXT    PRIMARY KEY,
  url         TEXT    NOT NULL,
  finalUrl    TEXT,
  status      INTEGER,
  contentType TEXT,
  contentHash TEXT,
  payload     TEXT    NOT NULL,
  retrievedAt TEXT    NOT NULL,
  storedAt    TEXT    NOT NULL,
  expiresAt   TEXT    NOT NULL,
  bytes       INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS entries_expiresAt_idx ON entries (expiresAt);
`;

/** Columns selected by every read, in the order {@link toCacheRecord} expects. */
const COLUMNS =
  "key, url, finalUrl, status, contentType, contentHash, payload, retrievedAt, storedAt, expiresAt, bytes";

/**
 * `node:sqlite` is typed as `Record<string, SQLOutputValue>` for result rows:
 * the driver cannot know our schema, so the values arrive as a loose union
 * (`null | number | bigint | string | Uint8Array`). Instead of casting to a
 * hand-written row interface at each call site, every row goes through the
 * narrow, total helpers below. This keeps the unsafe boundary small and in one
 * place — next to the DDL that defines the columns.
 */
type Row = Record<string, unknown>;

function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function asNullableString(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === "string" ? value : String(value);
}

function asNullableInteger(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function asInteger(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** Number of rows affected by a write statement. */
function changedRows(result: { changes: number | bigint }): number {
  return Number(result.changes);
}

/** Parses a row into a record, or `null` when the stored payload is unusable. */
function toCacheRecord(row: Row | undefined): CacheRecord | null {
  if (row === undefined) return null;
  const payloadJson = row.payload;
  if (typeof payloadJson !== "string") return null;

  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    // A corrupt payload must not crash an evidence request. Treat the row as a
    // miss; `cleanup` or the next `set` for the same key replaces it.
    return null;
  }

  return {
    key: asString(row.key),
    url: asString(row.url),
    finalUrl: asNullableString(row.finalUrl),
    status: asNullableInteger(row.status),
    contentType: asNullableString(row.contentType),
    contentHash: asNullableString(row.contentHash),
    payload,
    retrievedAt: asString(row.retrievedAt),
    storedAt: asString(row.storedAt),
    expiresAt: asString(row.expiresAt),
    bytes: asInteger(row.bytes),
  };
}

/**
 * Normalises a timestamp to canonical ISO 8601 UTC, so lexicographic SQL
 * comparison and JavaScript `Date` ordering agree. Accepts any string `Date`
 * understands (including explicit offsets) and re-serialises it.
 *
 * @throws {TypeError} when the value is missing or not a parseable timestamp.
 */
function toIso(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`cache: ${field} must be a non-empty ISO 8601 string`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new TypeError(`cache: ${field} is not a valid ISO 8601 timestamp: ${JSON.stringify(value)}`);
  }
  return new Date(ms).toISOString();
}

/** Non-empty string check for fields the record contract requires. */
function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`cache: ${field} must be a non-empty string`);
  }
  return value;
}

/** `null`/`undefined` stay `null`; anything else must already be a string. */
function requireNullableString(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new TypeError(`cache: ${field} must be a string or null`);
  }
  return value;
}

/** Required bounded integer (used for `bytes`). */
function requireByteCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`cache: bytes must be a finite, non-negative number`);
  }
  return Math.trunc(value);
}

/** Optional integer (used for HTTP `status`). */
function requireNullableInteger(value: unknown, field: string): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`cache: ${field} must be a finite number or null`);
  }
  return Math.trunc(value);
}

/** Serialises the bounded extracted representation. Never the raw page. */
function serialisePayload(payload: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(payload);
  } catch (cause) {
    throw new TypeError("cache: payload is not JSON-serialisable", { cause });
  }
  if (json === undefined) {
    throw new TypeError("cache: payload is not JSON-serialisable (undefined, function or symbol)");
  }
  return json;
}

/** True for SQLite's in-memory database targets, where WAL does not apply. */
function isInMemory(path: string): boolean {
  return path === ":memory:" || path.startsWith("file::memory:");
}

/**
 * Creates a bounded, evicting, TTL-aware SQLite cache.
 *
 * Behaviour guaranteed by this implementation:
 * - the parent directory of a file-backed database is created if missing
 * - `get` returns `null` for a missing **or expired** row
 * - `set` upserts by primary key, then enforces `maxEntries` (oldest first)
 * - `cleanup` deletes expired rows, enforces `maxEntries`, and returns the total
 *   number of rows removed
 * - `stats` reports live entries/bytes, the expired backlog, and the oldest
 *   live `storedAt`
 * - `close` is idempotent
 *
 * All methods return promises even though `node:sqlite` is synchronous; see
 * `CacheProvider` for why that is deliberate.
 *
 * @throws {TypeError} when options are malformed (bad path, negative TTL, or a
 * non-integer `maxEntries`).
 */
export function createSqliteCache(opts: SqliteCacheOptions): CacheProvider {
  const path = requireString(opts?.path, "path");
  const ttlSeconds = opts?.ttlSeconds;
  const maxEntries = opts?.maxEntries;

  if (typeof ttlSeconds !== "number" || !Number.isFinite(ttlSeconds) || ttlSeconds < 0) {
    throw new TypeError("createSqliteCache: ttlSeconds must be a finite, non-negative number");
  }
  if (typeof maxEntries !== "number" || !Number.isInteger(maxEntries) || maxEntries < 0) {
    throw new TypeError("createSqliteCache: maxEntries must be a non-negative integer");
  }

  const memory = isInMemory(path);
  if (!memory) {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new DatabaseSync(path);
  if (!memory) {
    // WAL lets the reader and the writer coexist; it is meaningless (and
    // rejected) for an in-memory database.
    db.exec("PRAGMA journal_mode = WAL;");
  }
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA_SQL);

  const statements = {
    select:
      db.prepare(`SELECT ${COLUMNS} FROM entries WHERE key = ? AND expiresAt > ?`),
    upsert: db.prepare(`
      INSERT INTO entries (${COLUMNS})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        url         = excluded.url,
        finalUrl    = excluded.finalUrl,
        status      = excluded.status,
        contentType = excluded.contentType,
        contentHash = excluded.contentHash,
        payload     = excluded.payload,
        retrievedAt = excluded.retrievedAt,
        storedAt    = excluded.storedAt,
        expiresAt   = excluded.expiresAt,
        bytes       = excluded.bytes
    `),
    remove: db.prepare("DELETE FROM entries WHERE key = ?"),
    deleteExpired: db.prepare("DELETE FROM entries WHERE expiresAt <= ?"),
    // Keeps the newest `maxEntries` rows; everything else is evicted. The
    // tie-break on `key` makes the outcome deterministic when two rows share a
    // `storedAt` millisecond.
    evict: db.prepare(`
      DELETE FROM entries
      WHERE key NOT IN (
        SELECT key FROM entries ORDER BY storedAt DESC, key DESC LIMIT ?
      )
    `),
    countLive: db.prepare("SELECT COUNT(*) AS n FROM entries WHERE expiresAt > ?"),
    countExpired: db.prepare("SELECT COUNT(*) AS n FROM entries WHERE expiresAt <= ?"),
    oldestLive: db.prepare("SELECT MIN(storedAt) AS oldest FROM entries WHERE expiresAt > ?"),
    sumLiveBytes: db.prepare("SELECT COALESCE(SUM(bytes), 0) AS total FROM entries WHERE expiresAt > ?"),
  };

  let closed = false;

  function assertOpen(): void {
    if (closed) {
      throw new Error("cache: database is closed");
    }
  }

  /** Trims retained rows back to `maxEntries`; returns rows deleted. */
  function enforceMaxEntries(): number {
    return changedRows(statements.evict.run(maxEntries));
  }

  function countOf(row: Row | undefined): number {
    if (row === undefined) return 0;
    return asInteger(row.n);
  }

  const provider: CacheProvider = {
    async get(key: string): Promise<CacheRecord | null> {
      assertOpen();
      const normalisedKey = requireString(key, "key");
      const row = statements.select.get(normalisedKey, new Date().toISOString());
      return toCacheRecord(row);
    },

    async set(record: CacheRecord): Promise<void> {
      assertOpen();
      const key = requireString(record?.key, "key");
      const url = requireString(record?.url, "url");

      // `retrievedAt` is provenance, not bookkeeping: guessing it would let a
      // caller present stale content as fresh, so it must be supplied.
      const retrievedAt = toIso(record?.retrievedAt, "retrievedAt");
      const now = new Date().toISOString();
      // `storedAt` is mechanical; default it to now when absent.
      const storedAt =
        record?.storedAt == null || record.storedAt === "" ? now : toIso(record.storedAt, "storedAt");
      // Explicitly required default: fall back to the configured TTL.
      const expiresAt =
        record?.expiresAt == null || record.expiresAt === ""
          ? new Date(Date.parse(storedAt) + ttlSeconds * 1000).toISOString()
          : toIso(record.expiresAt, "expiresAt");

      const finalUrl = requireNullableString(record?.finalUrl, "finalUrl");
      const status = requireNullableInteger(record?.status, "status");
      const contentType = requireNullableString(record?.contentType, "contentType");
      const contentHash = requireNullableString(record?.contentHash, "contentHash");
      const payload = serialisePayload(record?.payload);
      const bytes = requireByteCount(record?.bytes);

      statements.upsert.run(
        key,
        url,
        finalUrl,
        status,
        contentType,
        contentHash,
        payload,
        retrievedAt,
        storedAt,
        expiresAt,
        bytes,
      );

      enforceMaxEntries();
    },

    async delete(key: string): Promise<void> {
      assertOpen();
      statements.remove.run(requireString(key, "key"));
    },

    async cleanup(): Promise<number> {
      assertOpen();
      const expired = changedRows(statements.deleteExpired.run(new Date().toISOString()));
      return expired + enforceMaxEntries();
    },

    async stats(): Promise<CacheStats> {
      assertOpen();
      const now = new Date().toISOString();
      return {
        entries: countOf(statements.countLive.get(now)),
        expired: countOf(statements.countExpired.get(now)),
        oldestStoredAt: asNullableString(statements.oldestLive.get(now)?.oldest),
        totalBytes: asInteger(statements.sumLiveBytes.get(now)?.total),
      };
    },

    async close(): Promise<void> {
      // Idempotent by contract: `node:sqlite` throws when closing a closed
      // handle, so guard on our own flag as well as the driver's.
      if (closed) return;
      closed = true;
      if (db.isOpen) db.close();
    },
  };

  return provider;
}
