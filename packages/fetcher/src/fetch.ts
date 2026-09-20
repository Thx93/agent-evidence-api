import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup } from "node:dns";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Readable } from "node:stream";
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

export interface FetchResult {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  contentLength: number | null;
  /** Decoded text body. Null for non-text content types. */
  body: string | null;
  redirectChain: string[];
  retrievedAt: string;
  warnings: SourceWarning[];
  /** Decompressed byte count actually read. */
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

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer | null;
  bytes: number;
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
        const contentLengthRaw = headerValue(res.headers["content-length"]);
        const contentLength = contentLengthRaw ? Number(contentLengthRaw) : null;

        if (contentLength !== null && contentLength > opts.limits.maxResponseBytes) {
          req.destroy();
          finish(() =>
            reject(new FetchError("RESPONSE_TOO_LARGE", "response exceeded the maximum allowed size")),
          );
          return;
        }

        const encoding = (headerValue(res.headers["content-encoding"]) ?? "").toLowerCase();
        let stream: Readable = res;
        if (encoding === "gzip" || encoding === "x-gzip") stream = res.pipe(createGunzip());
        else if (encoding === "deflate") stream = res.pipe(createInflate());
        else if (encoding === "br") stream = res.pipe(createBrotliDecompress());

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
          if (wantsBody) chunks.push(chunk);
        });

        stream.on("error", (err: Error) => {
          finish(() => reject(new FetchError("UPSTREAM_HTTP_FAILURE", err.message)));
        });

        stream.on("end", () => {
          finish(() =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: wantsBody ? Buffer.concat(chunks) : null,
              bytes,
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

    return {
      requestedUrl: opts.url,
      finalUrl: validation.url.toString(),
      status: raw.status,
      contentType,
      contentLength: raw.bytes,
      body: raw.body ? raw.body.toString("utf8") : null,
      redirectChain,
      retrievedAt: new Date().toISOString(),
      warnings,
      bytes: raw.bytes,
    };
  }

  throw new FetchError("REDIRECT_LIMIT", "too many redirects");
}
