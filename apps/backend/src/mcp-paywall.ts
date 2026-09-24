/**
 * The MCP paywall — the free/paid decision, and the response capture that lets
 * settlement follow the tool call.
 *
 * ## Why this lives in the backend at all
 *
 * The HTTP paywall moved to the backend because the CDP Facilitator cannot run in
 * a Cloudflare Worker (see `docs/market-analysis.md`). The MCP route kept gating
 * at the edge on the generic facilitator, which costs more than an architectural
 * wart: the x402 catalogue is populated **per route**, so `research_evidence` never
 * settled through the CDP Facilitator and therefore never appeared in what the
 * Bazaar MCP server enumerates — the one discovery path that needs no keyword.
 *
 * ## Why a Fastify `preHandler` and not `@x402/fastify`'s `onProtectedRequest`
 *
 * The adapter registers `addHook("onRequest", ...)`. `onRequest` runs before
 * Fastify parses the body, so the hook cannot see the JSON-RPC method and cannot
 * tell `tools/list` (free) from `tools/call research_evidence` (paid). An earlier
 * attempt wired `onProtectedRequest` and charged the free handshake; the deploy
 * guard caught it (`MCP tools/list (free) got 402, want 200`).
 *
 * By `preHandler` the body is parsed, so the decision is made here and the x402
 * HTTP resource server is driven directly.
 */
import type { ServerResponse } from "node:http";
import {
  EVIDENCE_PAID_TOOLS,
  FREE_TOOL_NAME,
  PAID_TOOL_NAME,
} from "@aee/mcp";

/**
 * MCP methods an agent may call without paying, so it can look before it buys.
 *
 * This is the discovery surface. Everything not listed here requires payment —
 * the inversion is deliberate and matches the HTTP route, where the paywall comes
 * before validation. A malformed body therefore receives a 402 challenge rather
 * than a protocol error, and a generic prober never sees a 406.
 */
export const FREE_MCP_METHODS: ReadonlySet<string> = new Set([
  "initialize",
  "notifications/initialized",
  "notifications/cancelled",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "prompts/list",
  "ping",
]);

/** The paid tool on `/mcp`. Re-exported so callers name it once. */
export const PAID_MCP_TOOL = PAID_TOOL_NAME;

/** The free liveness tool, callable without payment on every route. */
export const FREE_MCP_TOOL = FREE_TOOL_NAME;

/**
 * Decide whether a parsed JSON-RPC payload must be paid for.
 *
 * `paidTools` is per route — `/mcp` charges for `research_evidence`, `/weather/mcp`
 * for `get-alerts` and `get-forecast` — so a `tools/call` is paid exactly when its
 * name is in the set for its own route. A tool a route does not publish can never
 * be charged for, and a name outside every set is free.
 *
 * A batch is charged if ANY element is not a recognised free operation. An
 * unparseable or absent body is charged, because "not recognised as free" must
 * fail closed.
 */
export function needsMcpPayment(
  body: unknown,
  paidTools: ReadonlySet<string> = EVIDENCE_PAID_TOOLS,
): boolean {
  if (Array.isArray(body)) return !body.every((m) => isFreeMessage(m, paidTools));
  return !isFreeMessage(body, paidTools);
}

function isFreeMessage(message: unknown, paidTools: ReadonlySet<string>): boolean {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return false;
  const m = message as { method?: unknown; params?: unknown };
  if (typeof m.method !== "string") return false;
  if (FREE_MCP_METHODS.has(m.method)) return true;
  if (m.method !== "tools/call") return false;
  const params = m.params;
  if (params === null || typeof params !== "object") return false;
  // `health` and any future free tool pass; only names in `paidTools` cost money.
  return !paidTools.has(String((params as { name?: unknown }).name));
}

/**
 * Did an MCP response describe a failed call?
 *
 * The MCP transport reports a failed tool call as a JSON-RPC **result** carrying
 * `isError: true` with HTTP 200 — correct MCP behaviour, and invisible to
 * settlement, which only consults the status code. Charging for that call would
 * break this service's stated guarantee ("never charges when nothing is
 * retrieved"), so the body has to be inspected.
 *
 * A JSON-RPC transport-level `error` is treated the same way: the buyer did not
 * receive the deliverable, so no settlement is attempted.
 */
export function mcpResponseFailed(body: Buffer, contentType: string): boolean {
  if (body.length === 0) return false;
  const text = body.toString("utf8").trim();
  if (text.length === 0) return false;

  const payloads: string[] = [];
  if (contentType.toLowerCase().includes("event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      const match = /^data:\s*(.*)$/.exec(line);
      if (match?.[1]) payloads.push(match[1]);
    }
  } else {
    payloads.push(text);
  }

  for (const payload of payloads) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // Not JSON we can read: keep the literal marker check the edge used, so a
      // shape we did not anticipate errs toward not charging.
      if (/"isError"\s*:\s*true/.test(payload)) return true;
      continue;
    }
    if (hasFailure(parsed)) return true;
  }
  return false;
}

function hasFailure(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasFailure);
  if (value === null || typeof value !== "object") return false;
  const record = value as { result?: unknown; error?: unknown };
  if (record.error !== undefined && record.error !== null) return true;
  const result = record.result;
  if (result === null || typeof result !== "object") return false;
  return (result as { isError?: unknown }).isError === true;
}

export interface CapturedResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  /** The body written by the MCP transport, after any `replace()`. */
  body(): Buffer;
  /** Merge protocol headers (e.g. `PAYMENT-RESPONSE`) into the captured set. */
  mergeHeaders(headers: Record<string, string>): void;
  /** Replace status, body and (optionally) headers before flushing. */
  replace(statusCode: number, body: string, headers?: Record<string, string>): void;
  /** Write the buffered response to the socket exactly once. */
  flush(): void;
}

function toBuffer(chunk: unknown, encoding: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === "string") {
    return Buffer.from(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8");
  }
  return Buffer.from(String(chunk));
}

/**
 * Buffer everything the MCP transport writes to a `ServerResponse`, so the
 * settlement decision can be made with the status AND the body in hand.
 *
 * The MCP route hijacks the reply and hands the raw socket to the transport,
 * which bypasses Fastify's `onSend` — the point at which the stock x402 adapter
 * normally settles. Without this the only visible signal would be the status
 * code, and every `isError: true` tool result (HTTP 200) would still be charged.
 *
 * Deliberately narrow: it intercepts only the four methods the Node HTTP → Web
 * adapter uses (`writeHead`, `write`, `end`, `flushHeaders`) and restores them
 * before the single real write. `headersSent` stays false throughout, which is
 * what lets the real response be written at the end.
 */
export function captureResponse(res: ServerResponse): CapturedResponse {
  const realWriteHead = res.writeHead.bind(res);
  const realWrite = res.write.bind(res);
  const realEnd = res.end.bind(res);
  const realFlushHeaders = res.flushHeaders.bind(res);

  let status = 200;
  const headers: Record<string, string> = {};
  let chunks: Buffer[] = [];
  let flushed = false;

  res.writeHead = function (code: number, ...rest: unknown[]) {
    status = code;
    const maybeHeaders = typeof rest[0] === "string" ? rest[1] : rest[0];
    if (maybeHeaders !== null && typeof maybeHeaders === "object") {
      for (const [key, value] of Object.entries(maybeHeaders as Record<string, unknown>)) {
        if (value === undefined || value === null) continue;
        headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
      }
    }
    return res;
  } as typeof res.writeHead;

  res.write = function (chunk: unknown, ...rest: unknown[]) {
    if (chunk !== undefined && chunk !== null) chunks.push(toBuffer(chunk, rest[0]));
    return true;
  } as typeof res.write;

  res.end = function (chunk?: unknown, ...rest: unknown[]) {
    // `end(callback)` carries no body; a string encoding is `rest[0]`.
    if (typeof chunk !== "function" && chunk !== undefined && chunk !== null) {
      chunks.push(toBuffer(chunk, rest[0]));
    }
    return res;
  } as typeof res.end;

  res.flushHeaders = function () {
    return res;
  } as typeof res.flushHeaders;

  return {
    get statusCode() {
      return status;
    },
    get headers() {
      return headers;
    },
    body: () => Buffer.concat(chunks),
    mergeHeaders(extra: Record<string, string>) {
      for (const [key, value] of Object.entries(extra)) headers[key.toLowerCase()] = value;
    },
    replace(newStatus: number, body: string, extra?: Record<string, string>) {
      status = newStatus;
      chunks = [Buffer.from(body, "utf8")];
      if (extra) {
        for (const [key, value] of Object.entries(extra)) headers[key.toLowerCase()] = value;
      }
    },
    flush() {
      if (flushed) return;
      flushed = true;
      res.writeHead = realWriteHead;
      res.write = realWrite;
      res.end = realEnd;
      res.flushHeaders = realFlushHeaders;
      realWriteHead(status, headers);
      const body = Buffer.concat(chunks);
      if (body.length > 0) realEnd(body);
      else realEnd();
    },
  };
}
