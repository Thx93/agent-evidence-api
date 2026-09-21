import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup } from "node:dns";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Duplex, Readable } from "node:stream";
import { DEFAULT_LIMITS, type ErrorCode, type ResourceLimits, type SourceWarning } from "@aee/schemas";
import { classifyHostname, classifyIp, classifyPort } from "./ip.js";

/** Typed transport/validation failure carrying a stable public error code. */
export class FetchError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;

  constructor(code: ErrorCode, message: string, status?: number) {
    super(message);
    this.name = "FetchError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export interface UrlValidationOk {
  ok: true;
  url: URL;
  hostname: string;
  addresses: string[];
}
export interface UrlValidationErr {
  ok: false;
  code: ErrorCode;
  reason: string;
}
export type UrlValidation = UrlValidationOk | UrlValidationErr;

export interface FetchOptions {
  url: string;
  limits: ResourceLimits;
  userAgent: string;
  /** Optional caller cancellation, combined with internal timeouts. */
  signal?: AbortSignal;
  /**
   * Test-only escape hatch allowing LOOPBACK addresses (127.0.0.0/8, ::1).
   *
   * It exists because the security suite must drive a real local fixture
   * server, and loopback is otherwise blocked by design. It is honoured ONLY
   * when NODE_ENV === "test", relaxes loopback alone (never RFC1918 or
   * link-local), and is never set by application code. In any other
   * environment the flag is ignored entirely.
   */
  allowLoopbackForTests?: boolean;
}

/** Whether the test-only loopback escape is currently permitted. */
function loopbackEscapeEnabled(): boolean {
  return process.env.NODE_ENV === "test";
}

/** True for 127.0.0.0/8 and ::1 — the only ranges the escape relaxes. */
function isLoopbackAddress(address: string): boolean {
  const bare = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  if (bare === "::1") return true;
  if (/^127\./.test(bare)) return true;
  // ::ffff:127.x.x.x
  if (/^::ffff:127\./i.test(bare)) return true;
  return false;
}

/**
 * Maximum tolerated decompression ratio, expressed as decompressed bytes per
 * byte read from the wire.
 *
 * This is a DEFENCE-IN-DEPTH measure that sits alongside the absolute
 * `ResourceLimits.maxResponseBytes` cap. The absolute cap alone is not enough:
 * a small "gzip bomb" can expand enormously before the decoded stream ever
 * reaches that ceiling. The ratio therefore aborts the fetch as soon as the
 * decoded output outgrows the compressed input by more than this factor.
 *
 * The guard only engages once the decoded body passes
 * `DECOMPRESSION_RATIO_FLOOR_BYTES`, so tiny (and therefore statistically
 * noisy) responses are never rejected on a technically-accurate but harmless
 * ratio.
 */
export const MAX_DECOMPRESSION_RATIO = 200;

/**
 * Decoded-byte floor below which the ratio guard is not evaluated. Kept well
 * above toy payload sizes so ordinary small documents cannot be falsely
 * rejected; the absolute size cap still applies to them.
 */
const DECOMPRESSION_RATIO_FLOOR_BYTES = 64 * 1024;

export interface FetchResult {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  /**
   * The value of the `content-length` RESPONSE HEADER when it is present and
   * parseable as a non-negative integer, otherwise null.
   *
   * This is the size the server declared for the body it sent ON THE WIRE. When
   * the response is content-encoded (gzip/br/deflate) it is therefore the
   * COMPRESSED size, not the decoded size. Use `bytes` for what was actually
   * processed. It is `null` whenever the header is absent, malformed, or the
   * response is chunked.
   */
  contentLength: number | null;
  /** Decoded text body. Null for non-text content types. */
  body: string | null;
  redirectChain: string[];
  retrievedAt: string;
  warnings: SourceWarning[];
  /**
   * Actual DECOMPRESSED byte count read from the body, i.e. the amount of
   * content this service really processed (after any content-encoding has been
   * undone). Zero for an empty body.
   */
  bytes: number;
}

const TEXTUAL = [
  "text/html",
  "text/plain",
  "application/xhtml+xml",
  "application/json",
  "application/ld+json",
  "text/xml",
  "application/xml",
];

/** True when a content type is one this service processes. */
export function isSupportedContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return TEXTUAL.includes(mime);
}

function isTextual(contentType: string | null): boolean {
  if (!contentType) return false;
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return mime.startsWith("text/") || TEXTUAL.includes(mime);
}

/** Strip the query string from a URL before it appears in any message. */
function safeUrlForMessage(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "[unparseable-url]";
  }
}

/**
 * Validate a URL syntactically and against DNS.
 *
 * Every resolved address is checked; if ANY is disallowed the URL is rejected,
 * because DNS round-robins and a later connection could pick a bad one.
 */
export async function validateUrl(
  rawUrl: string,
  opts?: { limits?: Partial<ResourceLimits>; allowLoopbackForTests?: boolean },
): Promise<UrlValidation> {
  const allowLoopback = opts?.allowLoopbackForTests === true && loopbackEscapeEnabled();
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, code: "INVALID_URL", reason: "not a valid absolute URL" };
  }

  const protocol = url.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    return {
      ok: false,
      code: "INVALID_URL",
      reason: `unsupported scheme ${protocol.replace(":", "")}`,
    };
  }

  if (url.username !== "" || url.password !== "") {
    return { ok: false, code: "BLOCKED_URL", reason: "URLs containing credentials are not allowed" };
  }

  const hostname = url.hostname;
  if (hostname === "") {
    return { ok: false, code: "INVALID_URL", reason: "missing hostname" };
  }

  // URL keeps IPv6 hosts bracketed; strip for classification.
  const bareHost =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

  const hostProblem = classifyHostname(bareHost);
  if (hostProblem) {
    // The test escape relaxes loopback only: the `localhost` name and literal
    // loopback addresses (which classifyHostname also flags as numeric hosts).
    const escaped =
      allowLoopback &&
      (bareHost === "localhost" ||
        bareHost.endsWith(".localhost") ||
        isLoopbackAddress(bareHost));
    if (!escaped) {
      return { ok: false, code: "BLOCKED_URL", reason: hostProblem.reason };
    }
  }

  const port = url.port === "" ? (protocol === "https:" ? 443 : 80) : Number(url.port);
  // Under the test escape a loopback host may use any port, because the fixture
  // server binds an ephemeral one. The port allowlist keeps its own dedicated
  // coverage in tests/security/ssrf.test.ts with the escape disabled.
  const portEscapedHere = allowLoopback && isLoopbackAddress(bareHost);
  const portProblem = portEscapedHere ? null : classifyPort(port);
  if (portProblem) {
    return { ok: false, code: "BLOCKED_URL", reason: portProblem.reason };
  }

  // A literal IP host needs no DNS; classify it directly.
  const literal = classifyIp(bareHost);
  const isLiteralIp =
    /^[0-9.]+$/.test(bareHost) || bareHost.includes(":") || /^0x/i.test(bareHost);

  if (isLiteralIp) {
    if (literal && !(allowLoopback && isLoopbackAddress(bareHost))) {
      return { ok: false, code: "BLOCKED_URL", reason: literal.reason };
    }
    return { ok: true, url, hostname: bareHost, addresses: [bareHost] };
  }

  const addresses = await resolveAll(bareHost);
  if (addresses.length === 0) {
    return { ok: false, code: "INVALID_URL", reason: "hostname did not resolve" };
  }
  for (const address of addresses) {
    const bad = classifyIp(address);
    if (bad && !(allowLoopback && isLoopbackAddress(address))) {
      return { ok: false, code: "BLOCKED_URL", reason: `resolved ${bad.reason}` };
    }
  }

  return { ok: true, url, hostname: bareHost, addresses };
}

/** Resolve every A/AAAA record for a hostname. */
function resolveAll(hostname: string): Promise<string[]> {
  return new Promise((resolve) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err || !addresses) return resolve([]);
      resolve(addresses.map((a) => a.address));
    });
  });
}

/**
 * A `lookup` for the http(s) agent that re-validates at CONNECT time.
 *
 * This is the DNS-rebinding control: `validateUrl` ran earlier, but the record
 * can change between validation and connection. Node calls this immediately
 * before opening the socket, so a rebound record is caught here.
 */
function makeGuardedLookup(allowLoopback: boolean) {
  return function guardedLookup(
    hostname: string,
    options: { family?: number },
    callback: (err: Error | null, address: string, family: number) => void,
  ): void {
    dnsLookup(
      hostname,
      { all: true, verbatim: true },
      (err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>) => {
        if (err || !addresses || addresses.length === 0) {
          callback(err ?? new Error("dns resolution failed"), "", 4);
          return;
        }
        for (const entry of addresses) {
          const bad = classifyIp(entry.address);
          if (bad && !(allowLoopback && isLoopbackAddress(entry.address))) {
            // Surfaced as a connection error; mapped to SSRF_ATTEMPT by the caller.
            callback(new FetchError("SSRF_ATTEMPT", `blocked at connect: ${bad.reason}`), "", 4);
            return;
          }
        }
        const wanted =
          options.family === 4 || options.family === 6
            ? addresses.find((a) => a.family === options.family) ?? addresses[0]
            : addresses[0];
        if (!wanted) {
          callback(new Error("no usable address"), "", 4);
          return;
        }
        callback(null, wanted.address, wanted.family);
      },
    );
  };
}

/**
 * Recognised `content-encoding` tokens mapped to decoder factories.
 *
 * A `Map` (not a plain object) so a hostile header token such as `constructor`
 * cannot accidentally resolve through the prototype chain.
 */
const CONTENT_DECODERS = new Map<string, () => Duplex>([
  ["gzip", createGunzip],
  ["x-gzip", createGunzip],
  ["deflate", createInflate],
  ["br", createBrotliDecompress],
]);

interface ParsedContentEncoding {
  /** Recognised tokens, in the order the server declared them. */
  chain: string[];
  /** Tokens present in the header that this build cannot decode. */
  unsupported: string[];
}

/**
 * Parse a `content-encoding` header into its comma-separated tokens.
 *
 * `identity` and empty entries are meaningless no-ops and are dropped silently.
 * Any other token that is not recognised is reported as unsupported; the
 * caller then leaves the body entirely UNDECODED rather than applying a partial
 * chain, because undoing the wrong layer would silently corrupt the bytes.
 */
function parseContentEncoding(header: string | null): ParsedContentEncoding {
  const tokens = (header ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token !== "" && token !== "identity");
  return {
    chain: tokens,
    unsupported: tokens.filter((token) => !CONTENT_DECODERS.has(token)),
  };
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer | null;
  /** Value of the `content-length` response header, when present and valid. */
  contentLength: number | null;
  /** Decompressed byte count actually read. */
  bytes: number;
  /** Decoding warnings raised while handling this response. */
  warnings: SourceWarning[];
}

/** Perform ONE request (no redirect following) with all limits applied. */
function requestOnce(
  url: URL,
  opts: FetchOptions,
  signal: AbortSignal,
  allowLoopback: boolean,
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const requestFn = isHttps ? httpsRequest : httpRequest;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      signal.removeEventListener("abort", onAbort);
      fn();
    };

    const req = requestFn(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port === "" ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          "user-agent": opts.userAgent,
          accept: "text/html,application/xhtml+xml,application/xml,application/json,text/plain;q=0.9,*/*;q=0.1",
          "accept-encoding": "gzip, deflate, br",
          // Deliberately NOT sending cookies or referer.
          connection: "close",
        },
        // Connect-time revalidation (DNS rebinding defence).
        lookup: makeGuardedLookup(allowLoopback) as never,
        timeout: opts.limits.connectTimeoutMs,
      },
      (res: IncomingMessage) => {
        const contentType = headerValue(res.headers["content-type"]);
        const contentLength = parseContentLength(headerValue(res.headers["content-length"]));

        if (contentLength !== null && contentLength > opts.limits.maxResponseBytes) {
          req.destroy();
          finish(() =>
            reject(new FetchError("RESPONSE_TOO_LARGE", "response exceeded the maximum allowed size")),
          );
          return;
        }

        const responseWarnings: SourceWarning[] = [];

        // A failure anywhere in the response/decode chain ends the request. The
        // socket is destroyed so no upstream connection is left dangling.
        const onStreamError = (err: Error) => {
          req.destroy();
          finish(() => reject(new FetchError("UPSTREAM_HTTP_FAILURE", err.message)));
        };

        const { chain, unsupported } = parseContentEncoding(
          headerValue(res.headers["content-encoding"]),
        );

        // Count the bytes actually read from the wire (i.e. still compressed)
        // so the decompression-ratio guard has a denominator. Registered BEFORE
        // the decode chain is built, so the counter never lags the body.
        let compressedBytes = 0;
        res.on("data", (chunk: Buffer) => {
          compressedBytes += chunk.length;
        });

        let stream: Readable = res;
        if (unsupported.length > 0) {
          // Leave the body undecoded: a partial chain would emit garbage.
          responseWarnings.push({
            code: "UNSUPPORTED_CONTENT_ENCODING",
            message: `Content encoding ${unsupported.join(", ")} is not supported; the body was left undecoded.`,
          });
        } else {
          // The server applied the declared encodings left to right (the first
          // listed is the innermost), so they must be undone right to left.
          for (const token of [...chain].reverse()) {
            const decoder = CONTENT_DECODERS.get(token);
            if (!decoder) continue;
            const next = decoder();
            // `pipe` does not forward errors, so a failure in ANY layer of the
            // chain (not just the last) must fail the request fast instead of
            // stalling it until the total timeout.
            next.on("error", onStreamError);
            stream = stream.pipe(next);
          }
        }

        const wantsBody = isTextual(contentType);
        const chunks: Buffer[] = [];
        let bytes = 0;

        stream.on("data", (chunk: Buffer) => {
          // Cap on DECOMPRESSED bytes: this is the decompression-bomb defence.
          bytes += chunk.length;
          if (bytes > opts.limits.maxResponseBytes) {
            req.destroy();
            finish(() =>
              reject(
                new FetchError("RESPONSE_TOO_LARGE", "response exceeded the maximum allowed size"),
              ),
            );
            return;
          }
          // Defence in depth alongside the absolute cap above: a small
          // compressed body must not be allowed to expand without bound before
          // the ceiling is reached. The floor keeps small responses from being
          // rejected on a trivial but harmless ratio.
          if (
            bytes > DECOMPRESSION_RATIO_FLOOR_BYTES &&
            bytes > compressedBytes * MAX_DECOMPRESSION_RATIO
          ) {
            req.destroy();
            finish(() =>
              reject(
                new FetchError(
                  "RESPONSE_TOO_LARGE",
                  "response expanded beyond the maximum allowed decompression ratio",
                ),
              ),
            );
            return;
          }
          if (wantsBody) chunks.push(chunk);
        });

        stream.on("error", onStreamError);

        stream.on("end", () => {
          finish(() =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: wantsBody ? Buffer.concat(chunks) : null,
              contentLength,
              bytes,
              warnings: responseWarnings,
            }),
          );
        });
      },
    );

    const totalTimer = setTimeout(() => {
      req.destroy();
      finish(() => reject(new FetchError("TIMEOUT", "request exceeded the allowed time")));
    }, opts.limits.requestTimeoutMs);

    const onAbort = () => {
      req.destroy();
      finish(() => reject(new FetchError("TIMEOUT", "request was cancelled")));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    req.on("timeout", () => {
      req.destroy();
      finish(() => reject(new FetchError("TIMEOUT", "connection timed out")));
    });

    req.on("error", (err: Error) => {
      // A guardedLookup rejection arrives here as a FetchError already.
      if (err instanceof FetchError) {
        finish(() => reject(err));
        return;
      }
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
        finish(() => reject(new FetchError("TIMEOUT", "connection timed out")));
        return;
      }
      finish(() => reject(new FetchError("UPSTREAM_HTTP_FAILURE", "could not reach the source")));
    });

    req.end();
  });
}

function headerValue(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/**
 * Parse a `content-length` response header.
 *
 * Returns null when the header is absent, empty, or not a plain non-negative
 * integer: an undeterminable length is reported honestly as `null` rather than
 * guessed or coerced to `NaN`.
 */
function parseContentLength(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Fetch a source, following redirects manually so EVERY hop is validated.
 *
 * Non-2xx/3xx statuses are returned rather than thrown: the caller records them
 * as provenance. Only transport-level failures throw.
 */
export async function fetchSource(opts: FetchOptions): Promise<FetchResult> {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const redirectChain: string[] = [];
  const warnings: SourceWarning[] = [];
  const controller = new AbortController();
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, controller.signal])
    : controller.signal;

  const allowLoopback =
    opts.allowLoopbackForTests === true && loopbackEscapeEnabled();

  let current = opts.url;

  for (let hop = 0; hop <= limits.maxRedirects; hop++) {
    const validation = await validateUrl(current, {
      allowLoopbackForTests: opts.allowLoopbackForTests,
    });
    if (!validation.ok) {
      throw new FetchError(validation.code, `${validation.reason} (${safeUrlForMessage(current)})`);
    }

    const raw = await requestOnce(validation.url, { ...opts, limits }, signal, allowLoopback);
    const location = headerValue(raw.headers["location"]);

    if (raw.status >= 300 && raw.status < 400 && location) {
      if (hop === limits.maxRedirects) {
        throw new FetchError(
          "REDIRECT_LIMIT",
          `exceeded the maximum of ${limits.maxRedirects} redirects`,
        );
      }
      let next: string;
      try {
        next = new URL(location, validation.url).toString();
      } catch {
        throw new FetchError("UPSTREAM_HTTP_FAILURE", "redirect target was not a valid URL");
      }
      // Validate the hop immediately so a redirect to a private address is
      // rejected here rather than by the next loop iteration.
      const hopCheck = await validateUrl(next, {
        allowLoopbackForTests: opts.allowLoopbackForTests,
      });
      if (!hopCheck.ok) {
        throw new FetchError(
          hopCheck.code,
          `redirect blocked: ${hopCheck.reason}`,
        );
      }
      redirectChain.push(next);
      current = next;
      continue;
    }

    const contentType = headerValue(raw.headers["content-type"]);
    if (!isSupportedContentType(contentType)) {
      warnings.push({
        code: "UNSUPPORTED_CONTENT_TYPE",
        message: `Content type ${contentType ?? "(none)"} is not processed; body omitted.`,
      });
    }
    if (raw.status >= 400) {
      warnings.push({
        code: "UPSTREAM_HTTP_FAILURE",
        message: `The source returned HTTP ${raw.status}.`,
      });
    }
    // Decoding warnings (e.g. UNSUPPORTED_CONTENT_ENCODING) belong to this
    // response and must survive into the result.
    warnings.push(...raw.warnings);

    return {
      requestedUrl: opts.url,
      finalUrl: validation.url.toString(),
      status: raw.status,
      contentType,
      contentLength: raw.contentLength,
      body: raw.body ? raw.body.toString("utf8") : null,
      redirectChain,
      retrievedAt: new Date().toISOString(),
      warnings,
      bytes: raw.bytes,
    };
  }

  throw new FetchError("REDIRECT_LIMIT", "too many redirects");
}
