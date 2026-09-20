import type { ResourceLimits, SourceWarning } from "@aee/schemas";
import type { FetchResult } from "@aee/fetcher";

/**
 * Configurable robots.txt behaviour (SPEC section 19).
 *
 * The spec asks for "a configurable robots-policy behavior where practical".
 * Three modes, driven by ROBOTS_POLICY:
 *
 *   ignore  — do not consult robots.txt at all (default for the MVP: the
 *             service is called by agents for specific URLs they chose, and it
 *             identifies itself honestly without evading anything)
 *   warn    — consult robots.txt and attach a warning when a path is disallowed,
 *             but still retrieve it
 *   enforce — consult robots.txt and refuse to retrieve a disallowed path
 *
 * This is a plain prefix/wildcard matcher, not a full RFC 9309 implementation.
 * It is deliberately conservative: where the rules are ambiguous it allows the
 * fetch and (in `warn` mode) records a warning, because refusing a legitimate
 * public source is a worse failure than fetching one the operator did not ask us
 * to avoid. The caller decides what to do with a disallowed verdict.
 *
 * Nothing here bypasses an access control: robots.txt is a courtesy protocol,
 * and honouring it is the point.
 */

/** Longest a robots.txt we will read, independent of the general response cap. */
const MAX_ROBOTS_BYTES = 128 * 1024;

/** Per-origin cache. Per-process and bounded, so it cannot grow without limit. */
const robotsCache = new Map<string, { rules: RobotsRules; fetchedAt: number }>();
const MAX_CACHED_ORIGINS = 256;
const ROBOTS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface RobotsRules {
  /** Sorted most-specific-first. */
  rules: Array<{ allow: boolean; path: string }>;
  /** True when no rule group applied to our user agent. */
  unrestricted: boolean;
}

/** Parse the subset of robots.txt this service honours. */
export function parseRobots(txt: string, userAgentToken: string): RobotsRules {
  const lines = txt.split(/\r?\n/);
  const token = userAgentToken.toLowerCase();

  // Collect groups: consecutive User-agent lines share the rule block that follows.
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = [];
  let current: { agents: string[]; rules: Array<{ allow: boolean; path: string }> } | null = null;
  let lastWasAgent = false;

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      if (!lastWasAgent || current === null) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }

    lastWasAgent = false;
    if (current === null) continue;

    if (field === "disallow") current.rules.push({ allow: false, path: value });
    else if (field === "allow") current.rules.push({ allow: true, path: value });
  }

  // A group applies when its agent token is "*" or a prefix of our token.
  const applicable = groups.filter((g) =>
    g.agents.some((a) => a === "*" || (a !== "" && token.startsWith(a))),
  );

  if (applicable.length === 0) {
    return { rules: [], unrestricted: true };
  }

  // Specific agent groups win over "*".
  const specific = applicable.filter((g) => g.agents.some((a) => a !== "*"));
  const chosen = specific.length > 0 ? specific : applicable;

  const rules = chosen
    .flatMap((g) => g.rules)
    // An empty Disallow means "allow everything"; drop it.
    .filter((r) => r.path !== "" || r.allow)
    // Most specific (longest path) first; Allow wins ties.
    .sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow));

  return { rules, unrestricted: false };
}

/** Match a path against a robots rule, supporting `*` and a trailing `$`. */
function matchesRule(rulePath: string, path: string): boolean {
  if (rulePath === "") return false;

  const anchored = rulePath.endsWith("$");
  const pattern = anchored ? rulePath.slice(0, -1) : rulePath;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const re = new RegExp("^" + escaped + (anchored ? "$" : ""));
  return re.test(path);
}

/** Decide whether a path is allowed for our agent. */
export function isPathAllowed(rules: RobotsRules, path: string): boolean {
  if (rules.unrestricted) return true;
  for (const rule of rules.rules) {
    if (matchesRule(rule.path, path)) return rule.allow;
  }
  return true; // no matching rule means allowed
}

export type RobotsVerdict =
  | { allowed: true; consulted: boolean }
  | { allowed: false; consulted: true; rule: string };

/**
 * Consult robots.txt for a URL.
 *
 * Any failure to retrieve or parse robots.txt is treated as ALLOWED: an
 * unreachable robots.txt is not a prohibition, and failing closed here would
 * silently drop legitimate sources.
 */
export async function checkRobots(
  target: { origin: string; path: string },
  userAgent: string,
  doFetch: (opts: {
    url: string;
    limits: ResourceLimits;
    userAgent: string;
    allowLoopbackForTests?: boolean;
  }) => Promise<FetchResult>,
  limits: ResourceLimits,
  allowLoopbackForTests: boolean,
): Promise<RobotsVerdict> {
  const cached = robotsCache.get(target.origin);
  let rules: RobotsRules;

  if (cached && Date.now() - cached.fetchedAt < ROBOTS_CACHE_TTL_MS) {
    rules = cached.rules;
  } else {
    let txt = "";
    try {
      const res = await doFetch({
        url: new URL("/robots.txt", target.origin).toString(),
        limits: { ...limits, maxResponseBytes: MAX_ROBOTS_BYTES },
        userAgent,
        allowLoopbackForTests,
      });
      // A 4xx robots.txt means "no rules".
      if (res.status >= 200 && res.status < 300 && res.body) txt = res.body;
    } catch {
      // Unreachable robots.txt is not a prohibition.
      txt = "";
    }

    // Our token is the leading product name of the User-Agent string.
    const token = userAgent.split(/[\s/]/)[0] ?? userAgent;
    rules = parseRobots(txt, token);

    if (robotsCache.size >= MAX_CACHED_ORIGINS) {
      const oldest = robotsCache.keys().next().value;
      if (oldest !== undefined) robotsCache.delete(oldest);
    }
    robotsCache.set(target.origin, { rules, fetchedAt: Date.now() });
  }

  if (isPathAllowed(rules, target.path)) return { allowed: true, consulted: true };

  const matched = rules.rules.find((r) => matchesRule(r.path, target.path));
  return { allowed: false, consulted: true, rule: matched?.path ?? "" };
}

/** Test helper: forget cached robots.txt. */
export function clearRobotsCache(): void {
  robotsCache.clear();
}

/** Build the warning attached when a disallowed path is retrieved in `warn` mode. */
export function robotsWarning(rule: string): SourceWarning {
  return {
    code: "ROBOTS_DISALLOWED",
    message:
      `robots.txt disallows this path for our user agent (rule: "${rule}"). ` +
      `Retrieved because ROBOTS_POLICY=warn; set ROBOTS_POLICY=enforce to refuse.`,
  };
}
