/**
 * Stable cache keys.
 *
 * The cache key must depend on what identifies the *content*, not on how the
 * URL happened to be spelled at request time. Two requests for the same page
 * that differ only by hostname case, fragment, parameter order, or campaign
 * tracking parameters must produce the same key — otherwise the cache silently
 * misses and re-fetches, and hit-rate reporting becomes meaningless.
 *
 * The key is a normalised URL string (not a hash) so cache rows stay readable
 * and debuggable in SQLite.
 */

/** Query parameters that identify a campaign or click, never the content. */
const TRACKING_PARAMETERS: ReadonlySet<string> = new Set([
  "fbclid",
  "gclid",
  "ref",
  "mc_cid",
  "mc_eid",
]);

/** True for `utm_*` and the fixed tracking list, compared case-insensitively. */
function isTrackingParameter(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_PARAMETERS.has(lower);
}

/**
 * Total order over `[name, value]` pairs: by name, then by value. Sorting by
 * value too keeps the key deterministic when a URL repeats a parameter name
 * (a plain stable sort by name would preserve the original — i.e. unstable —
 * order of duplicates).
 */
function comparePairs(a: readonly [string, string], b: readonly [string, string]): number {
  const [aName, aValue] = a;
  const [bName, bValue] = b;
  if (aName !== bName) return aName < bName ? -1 : 1;
  if (aValue !== bValue) return aValue < bValue ? -1 : 1;
  return 0;
}

/**
 * Stable cache key for a URL.
 *
 * Normalisation performed:
 * - scheme and hostname lowercased (the WHATWG parser already does this; we do
 *   it explicitly so the contract does not depend on parser internals)
 * - fragment stripped
 * - default ports collapsed by the parser (`https://x:443/` -> `https://x/`)
 * - userinfo dropped: credentials never identify a different resource here,
 *   and they must not leak into keys or logs
 * - `utm_*`, `fbclid`, `gclid`, `ref`, `mc_cid`, `mc_eid` dropped
 * - remaining query parameters sorted by name, then value
 * - a single trailing slash removed from the path unless the path is `/`
 *
 * @throws {TypeError} when `url` is not parseable as a URL.
 */
export function cacheKey(url: string): string {
  if (typeof url !== "string" || url.trim() === "") {
    throw new TypeError(`cacheKey: expected a non-empty URL string, received ${JSON.stringify(url)}`);
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (cause) {
    throw new TypeError(`cacheKey: unparseable URL ${JSON.stringify(url)}`, { cause });
  }

  parsed.hash = "";

  // The parser lowercases scheme/host already, but be explicit about the parts
  // of the contract the cache depends on.
  const scheme = parsed.protocol.toLowerCase();
  const host = parsed.host.toLowerCase();
  const path =
    parsed.pathname !== "/" && parsed.pathname.endsWith("/")
      ? parsed.pathname.slice(0, -1)
      : parsed.pathname;

  const pairs: Array<[string, string]> = [];
  for (const [name, value] of parsed.searchParams) {
    if (!isTrackingParameter(name)) pairs.push([name, value]);
  }
  pairs.sort(comparePairs);

  const query = new URLSearchParams();
  for (const [name, value] of pairs) query.append(name, value);
  const search = query.toString();

  return `${scheme}//${host}${path}${search === "" ? "" : `?${search}`}`;
}
