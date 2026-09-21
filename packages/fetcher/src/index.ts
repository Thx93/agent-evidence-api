/**
 * @aee/fetcher — SSRF-hardened HTTP retrieval.
 *
 * The security posture is DENY BY DEFAULT. See `ip.ts` for the address and
 * hostname rules, and `fetch.ts` for the transport controls (per-hop redirect
 * validation, connect-time revalidation, timeouts, size and decompression
 * limits).
 *
 * Nothing in this package executes a shell command or touches the filesystem.
 */
export {
  FetchError,
  MAX_DECOMPRESSION_RATIO,
  defaultDnsResolver,
  fetchSource,
  isSupportedContentType,
  makeGuardedLookup,
  validateUrl,
} from "./fetch.js";
export type {
  DnsResolver,
  FetchOptions,
  FetchResult,
  UrlValidation,
  UrlValidationOk,
  UrlValidationErr,
} from "./fetch.js";

export {
  ALLOWED_PORTS,
  classifyHostname,
  classifyIp,
  classifyIpv4,
  classifyIpv6,
  classifyPort,
  expandIpv6,
  parseIpv4,
} from "./ip.js";
export type { Disallowed } from "./ip.js";
