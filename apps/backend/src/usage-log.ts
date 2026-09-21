import { appendFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

/**
 * Append-only usage log, one JSON object per line.
 *
 * Why this exists: every request the backend serves on /internal/v1/evidence
 * has already passed the Worker's x402 gate, so each line here is a SETTLED
 * PAYMENT. That makes this file the revenue record.
 *
 * It writes to the mounted volume (/app/data) rather than relying on container
 * stdout, because Docker logs are destroyed when a container is recreated —
 * which happens on every deploy.
 *
 * Privacy: the question text is NEVER written. Only a salted hash (for
 * spotting duplicates) and a length. Per SPEC section 24, request payloads are
 * not logged.
 */

export interface UsageEvent {
  ts: string;
  request_id: string;
  /** sha256 of the question, truncated — lets you spot repeats without storing content. */
  question_hash: string;
  question_chars: number;
  sources_requested: number;
  sources_retrieved: number;
  evidence_items: number;
  assessment: string;
  processing_ms: number;
  outcome: "ok" | "error";
  error_code?: string;
  /**
   * True when the request carried an x402 payment proof.
   *
   * This is NOT proof of settlement, and must not be read as revenue. The x402
   * order is verify -> handler -> settle, so the backend writes this line BEFORE
   * the facilitator settles: a settlement that later fails still appears here as
   * `true`. The field was previously named `settled`, which was wrong and read as
   * revenue by the README, the checklist and the runbook.
   *
   * It remains useful for what it actually distinguishes: a buyer's request from
   * an operator or test call.
   *
   * For money, use the on-chain record against the X402_RECIPIENT address, or the
   * settlement transaction the buyer's client prints. See docs/FIRST-SALE.md.
   */
  payment_provided: boolean;
}

let ready: Promise<void> | null = null;

export interface UsageLogOptions {
  /** File to append to. Empty or "off" disables logging entirely. */
  path: string;
}

export function createUsageLog(opts: UsageLogOptions) {
  const enabled = Boolean(opts.path) && opts.path !== "off";

  async function ensureDir(): Promise<void> {
    if (!ready) {
      ready = mkdir(dirname(opts.path), { recursive: true }).then(
        () => undefined,
        () => undefined, // a failure here must never break a paid request
      );
    }
    return ready;
  }

  return {
    enabled,
    path: opts.path,

    /** Record one paid request. Never throws. */
    async record(event: UsageEvent): Promise<void> {
      if (!enabled) return;
      try {
        await ensureDir();
        await appendFile(opts.path, JSON.stringify(event) + "\n", "utf8");
      } catch {
        // Usage logging is observability, not correctness: a failure to write
        // it must never fail a request the customer has already paid for.
      }
    },

    /** Stable, non-reversible handle for a question. */
    hashQuestion(question: string): string {
      return createHash("sha256").update(question, "utf8").digest("hex").slice(0, 16);
    },
  };
}

export type UsageLog = ReturnType<typeof createUsageLog>;
