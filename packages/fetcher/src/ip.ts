import { isIP } from "node:net";

/**
 * IP and hostname classification for SSRF defence.
 *
 * Pure functions only — no I/O — so every rule below is directly unit-testable
 * without a network. The fetcher calls these both at validation time and again
 * at connect time (DNS-rebinding defence).
 *
 * The default posture is DENY: anything not provably public is rejected.
 */

export interface Disallowed {
  /** Short machine-ish reason, safe to log and to surface to a caller. */
  reason: string;
}

/** Parse an IPv4 dotted-quad or one of the legacy inet_aton forms. */
export function parseIpv4(input: string): number | null {
  const parts = input.split(".");
  if (parts.length === 0 || parts.length > 4) return null;
  if (parts.some((p) => p === "")) return null;

  const values: number[] = [];
  for (const part of parts) {
    let value: number;
    let radix = 10;
    let digits = part;

    if (/^0x[0-9a-f]+$/i.test(part)) {
      radix = 16;
      digits = part.slice(2);
    } else if (/^0[0-7]+$/.test(part)) {
      // Leading zero means octal in inet_aton, NOT decimal.
      radix = 8;
      digits = part.slice(1);
    }

    // Reject anything that is not purely digits in the chosen radix.
    const valid = radix === 16 ? /^[0-9a-f]+$/i : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
    if (!valid.test(digits)) return null;

    value = Number.parseInt(digits, radix);
    if (!Number.isFinite(value)) return null;
    values.push(value);
  }

  // inet_aton semantics: the final part absorbs all remaining bytes.
  const maxLast = [0xffffffff, 0xffffff, 0xffff, 0xff][values.length - 1] ?? -1;
  if (maxLast < 0) return null;
  for (let i = 0; i < values.length - 1; i++) {
    if ((values[i] ?? 0) > 0xff) return null;
  }
  if ((values[values.length - 1] ?? 0) > maxLast) return null;

  let result = 0;
  for (let i = 0; i < values.length - 1; i++) {
    result = result * 256 + (values[i] ?? 0);
  }
  result = result * (maxLast + 1) + (values[values.length - 1] ?? 0);
  return result >>> 0;
}

function inRange(value: number, cidrBase: number, prefixBits: number): boolean {
  const mask = prefixBits === 0 ? 0 : (0xffffffff << (32 - prefixBits)) >>> 0;
  return (value & mask) >>> 0 === (cidrBase & mask) >>> 0;
}

/** IPv4 blocks that must never be fetched. */
const DISALLOWED_V4: Array<{ base: number; bits: number; reason: string }> = [
  { base: 0x00000000, bits: 8, reason: "this-network (0.0.0.0/8)" },
  { base: 0x0a000000, bits: 8, reason: "private (10.0.0.0/8)" },
  { base: 0x64400000, bits: 10, reason: "carrier-grade NAT (100.64.0.0/10)" },
  { base: 0x7f000000, bits: 8, reason: "loopback (127.0.0.0/8)" },
  { base: 0xa9fe0000, bits: 16, reason: "link-local / cloud metadata (169.254.0.0/16)" },
  { base: 0xac100000, bits: 12, reason: "private (172.16.0.0/12)" },
  { base: 0xc0a80000, bits: 16, reason: "private (192.168.0.0/16)" },
  { base: 0xc0000000, bits: 24, reason: "IETF protocol assignments (192.0.0.0/24)" },
  { base: 0xc0000200, bits: 24, reason: "documentation (192.0.2.0/24)" },
  { base: 0xc6120000, bits: 15, reason: "benchmarking (198.18.0.0/15)" },
  { base: 0xc6336400, bits: 24, reason: "documentation (198.51.100.0/24)" },
  { base: 0xcb007100, bits: 24, reason: "documentation (203.0.113.0/24)" },
  { base: 0xe0000000, bits: 4, reason: "multicast (224.0.0.0/4)" },
  { base: 0xf0000000, bits: 4, reason: "reserved (240.0.0.0/4)" },
  { base: 0xffffffff, bits: 32, reason: "broadcast (255.255.255.255)" },
];

/** Classify a numeric IPv4 address. */
export function classifyIpv4(value: number): Disallowed | null {
  for (const block of DISALLOWED_V4) {
    if (inRange(value, block.base, block.bits)) return { reason: block.reason };
  }
  return null;
}

/** Expand an IPv6 address into its eight 16-bit groups, or null if invalid. */
export function expandIpv6(input: string): number[] | null {
  let address = input;
  const zone = address.indexOf("%");
  if (zone !== -1) address = address.slice(0, zone);

  // A trailing embedded IPv4 (e.g. ::ffff:127.0.0.1) becomes two groups.
  let trailing: number[] = [];
  const lastColon = address.lastIndexOf(":");
  const tail = address.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4(tail);
    if (v4 === null) return null;
    trailing = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    address = address.slice(0, lastColon + 1) + "0:0";
  }

  const doubleColon = address.indexOf("::");
  let head: string[];
  let tailGroups: string[];

  if (doubleColon !== -1) {
    if (address.indexOf("::", doubleColon + 1) !== -1) return null; // more than one "::"
    head = address.slice(0, doubleColon).split(":").filter((s) => s !== "");
    tailGroups = address.slice(doubleColon + 2).split(":").filter((s) => s !== "");
  } else {
    head = address.split(":");
    tailGroups = [];
  }

  const parseGroups = (groups: string[]): number[] | null => {
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };

  const headValues = parseGroups(head);
  const tailValues = parseGroups(tailGroups);
  if (headValues === null || tailValues === null) return null;

  const total = headValues.length + tailValues.length + (trailing.length ? 0 : 0);
  if (doubleColon === -1) {
    const all = [...headValues, ...trailing];
    return all.length === 8 ? all : null;
  }

  const fill = 8 - headValues.length - tailValues.length;
  if (fill < 0) return null;
  return [...headValues, ...new Array<number>(fill).fill(0), ...tailValues];
}

/** Classify an IPv6 address string. */
export function classifyIpv6(input: string): Disallowed | null {
  const groups = expandIpv6(input);
  if (groups === null) return { reason: "unparseable IPv6 address" };

  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;

  // ::1 loopback
  if (groups.every((g, i) => (i === 7 ? g === 1 : g === 0))) {
    return { reason: "IPv6 loopback (::1)" };
  }
  // :: unspecified
  if (groups.every((g) => g === 0)) {
    return { reason: "IPv6 unspecified (::)" };
  }
  // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfe80) return { reason: "IPv6 link-local (fe80::/10)" };
  // fc00::/7 unique-local
  if ((g0 & 0xfe00) === 0xfc00) return { reason: "IPv6 unique-local (fc00::/7)" };
  // ff00::/8 multicast
  if ((g0 & 0xff00) === 0xff00) return { reason: "IPv6 multicast (ff00::/8)" };
  // 64:ff9b::/96 NAT64 and 2002::/16 6to4 can embed private v4 — treat as opaque
  // and rely on connect-time revalidation; still flag the well-known metadata case.
  // ::ffff:0:0/96 IPv4-mapped — unwrap and re-check as IPv4.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    const v4 = ((g6 << 16) | g7) >>> 0;
    const inner = classifyIpv4(v4);
    if (inner) return { reason: `IPv4-mapped ${inner.reason}` };
  }
  return null;
}

/** Classify any literal IP address string (v4 or v6). */
export function classifyIp(ip: string): Disallowed | null {
  const kind = isIP(ip);
  if (kind === 4) {
    const value = parseIpv4(ip);
    if (value === null) return { reason: "unparseable IPv4 address" };
    return classifyIpv4(value);
  }
  if (kind === 6) return classifyIpv6(ip);
  return { reason: "not a valid IP address" };
}

/** Hostnames that must never be fetched, regardless of DNS. */
const DISALLOWED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];
const DISALLOWED_HOST_EXACT = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "localhost.localdomain",
]);

/**
 * Reject a hostname on name alone.
 *
 * Returns a reason when disallowed, or null when the name is not obviously bad
 * (its resolved addresses still have to pass `classifyIp`).
 */
export function classifyHostname(hostname: string): Disallowed | null {
  const host = hostname.toLowerCase().replace(/\.$/, ""); // strip trailing dot
  if (host === "") return { reason: "empty hostname" };

  if (DISALLOWED_HOST_EXACT.has(host)) return { reason: `internal hostname (${host})` };
  for (const suffix of DISALLOWED_HOST_SUFFIXES) {
    if (host === suffix.slice(1) || host.endsWith(suffix)) {
      return { reason: `internal hostname suffix (${suffix})` };
    }
  }

  // A bare alternative-form IPv4 (decimal/octal/hex/short) is an IP, not a name.
  if (!host.includes(":") && /^[0-9a-fx.]+$/i.test(host)) {
    const value = parseIpv4(host);
    if (value !== null) {
      const bad = classifyIpv4(value);
      if (bad) return { reason: `numeric host ${bad.reason}` };
    }
  }
  return null;
}

/** Ports the fetcher is willing to connect to. */
export const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);

export function classifyPort(port: number): Disallowed | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { reason: "invalid port" };
  }
  if (!ALLOWED_PORTS.has(port)) return { reason: `port ${port} is not allowed` };
  return null;
}
