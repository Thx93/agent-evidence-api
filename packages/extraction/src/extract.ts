/**
 * HTML → {@link ExtractedDocument}.
 *
 * Design rules:
 *
 * - **Never throw.** A hostile or malformed page must degrade to `null`/empty
 *   fields, never to an exception (SPEC section 7). Extraction failures that
 *   could not be recovered from are simply absent values.
 * - **Never invent a value.** A missing or unparseable field is `null`; dates
 *   in particular are only emitted when a real value parses.
 * - **Deterministic.** No randomness, no clock, no locale-sensitive comparison.
 *
 * ## Open Graph key convention
 *
 * `openGraph` keys are stored **without** the `og:` prefix, lower-cased, e.g.
 * `<meta property="og:site_name" content="Example">` becomes
 * `openGraph["site_name"] === "Example"`. The prefix is redundant (every key in
 * the record is an Open Graph property) and dropping it keeps lookups short.
 *
 * ## Extraction order
 *
 * Metadata and JSON-LD are read from the untouched document first, because the
 * boilerplate-stripping step removes `<script>`, `<header>`, `<footer>` and
 * friends. Only afterwards is the DOM pruned and the main content selected.
 */
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { hashContent, normalizeLines, normalizeText } from "./text.js";

/** A heading discovered in the main content (h1-h3 only). */
export interface Heading {
  level: number;
  text: string;
}

/** Normalised, provenance-ready view of a single HTML document. */
export interface ExtractedDocument {
  title: string | null;
  description: string | null;
  canonicalUrl: string | null;
  language: string | null;
  /** ISO 8601, or null when no real date could be parsed. Never guessed. */
  publishedAt: string | null;
  /** ISO 8601, or null when no real date could be parsed. Never guessed. */
  modifiedAt: string | null;
  /** Open Graph properties keyed **without** the `og:` prefix. */
  openGraph: Record<string, string>;
  /** Parsed JSON-LD values; malformed blocks are skipped silently. */
  jsonLd: unknown[];
  headings: Heading[];
  /** Normalised visible text of the main content, one line per block. */
  mainText: string;
  wordCount: number;
  /** sha256 of `mainText`. */
  contentHashSha256: string;
  /** Absolute, de-duplicated http(s) links found in the main content. */
  links: string[];
  /** og:site_name → meta application-name → hostname of `finalUrl`. */
  publisher: string | null;
}

export interface ExtractOptions {
  /** Maximum number of links to keep. Defaults to 100. */
  maxLinks?: number;
}

/** Default bound on `links`, per SPEC "bounded everything". */
export const DEFAULT_MAX_LINKS = 100;

/**
 * Elements removed before main-content extraction. These carry navigation,
 * chrome, or non-visible content rather than evidence.
 */
const BOILERPLATE_SELECTOR = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "nav",
  "footer",
  "header",
  "aside",
  "form",
  "[role='navigation']",
  "[aria-hidden='true']",
  "[hidden]",
].join(", ");

/**
 * Block-level elements whose text becomes one line of `mainText`. Headings and
 * paragraphs therefore never run together.
 */
const BLOCK_SELECTOR = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "li",
  "blockquote",
  "pre",
  "figcaption",
  "dt",
  "dd",
  "td",
  "th",
  "caption",
].join(", ");

/** Candidate containers, in priority order (before the density fallback). */
const CONTAINER_SELECTORS = ["main", "article", "[role='main']"] as const;

/** A cheerio selection, typed without importing domhandler directly. */
type Selection = ReturnType<CheerioAPI>;

/** Parse `html` and return the loaded document. Invalid HTML never throws. */
function loadDocument(html: string): CheerioAPI {
  return cheerio.load(html);
}

/** Parse `finalUrl`, returning null when it is not a usable absolute URL. */
function parseBaseUrl(finalUrl: string): URL | null {
  try {
    return new URL(finalUrl);
  } catch {
    return null;
  }
}

/** True only for http/https URLs. */
function isHttpProtocol(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

/** First non-empty value of `meta[attr=wanted]` (case-insensitive), or null. */
function firstMetaContent($: CheerioAPI, attr: "name" | "property", wanted: string): string | null {
  const target = wanted.toLowerCase();
  for (const el of $("meta").toArray()) {
    if (($(el).attr(attr) ?? "").trim().toLowerCase() !== target) continue;
    const value = normalizeText($(el).attr("content") ?? "");
    if (value) return value;
  }
  return null;
}

/**
 * Open Graph properties, first non-empty occurrence winning.
 *
 * `property="og:..."` is the standard form; `name="og:..."` is also accepted
 * because real pages use it. Keys are lower-cased and carry no `og:` prefix.
 */
function extractOpenGraph($: CheerioAPI): Record<string, string> {
  const result: Record<string, string> = {};
  for (const el of $("meta").toArray()) {
    const property = ($(el).attr("property") ?? "").trim().toLowerCase();
    const name = ($(el).attr("name") ?? "").trim().toLowerCase();
    const raw = property.startsWith("og:") ? property : name.startsWith("og:") ? name : "";
    if (!raw) continue;
    const key = raw.slice(3).trim();
    if (!key || Object.prototype.hasOwnProperty.call(result, key)) continue;
    const value = normalizeText($(el).attr("content") ?? "");
    if (value) result[key] = value;
  }
  return result;
}

/**
 * Parse every `<script type="application/ld+json">` block.
 *
 * Malformed JSON is skipped silently: a broken structured-data block on an
 * otherwise usable page must never fail extraction. A `;charset=...` suffix on
 * the MIME type and surrounding HTML comments are tolerated.
 */
function extractJsonLd($: CheerioAPI): unknown[] {
  const blocks: unknown[] = [];
  for (const el of $("script").toArray()) {
    const type = ($(el).attr("type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (type !== "application/ld+json") continue;
    let raw = $(el).text().trim();
    if (raw.startsWith("<!--")) raw = raw.slice(4);
    if (raw.endsWith("-->")) raw = raw.slice(0, -3);
    raw = raw.trim();
    if (!raw) continue;
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      // Malformed JSON-LD is skipped silently, by contract.
    }
  }
  return blocks;
}

/**
 * Recursively collect string values for `wanted` keys (case-insensitive).
 *
 * Depth-bounded so a pathologically nested JSON-LD graph cannot blow the stack.
 */
function collectJsonLdDates(
  value: unknown,
  wanted: readonly string[],
  out: string[],
  depth: number,
): void {
  if (depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonLdDates(item, wanted, out, depth + 1);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (wanted.includes(key.toLowerCase())) {
      if (typeof raw === "string") out.push(raw);
      else if (Array.isArray(raw)) {
        for (const item of raw) if (typeof item === "string") out.push(item);
      }
    }
    collectJsonLdDates(raw, wanted, out, depth + 1);
  }
}

/**
 * Convert a candidate date string to ISO 8601, or null.
 *
 * Requires a four-digit year before even asking `Date.parse`, so short numeric
 * values (`"1"`, `"12"`) cannot be silently promoted into an invented year.
 * Parsed years outside 1800-2200 are rejected as nonsense.
 */
function toIsoDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = normalizeText(raw);
  if (!value || !/\d{4}/.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  if (year < 1800 || year > 2200) return null;
  return date.toISOString();
}

/** First candidate that converts to a valid ISO 8601 timestamp, or null. */
function firstIsoDate(candidates: ReadonlyArray<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const iso = toIsoDate(candidate);
    if (iso !== null) return iso;
  }
  return null;
}

/** Normalise `<html lang>`; empty or whitespace-only means null. */
function extractLanguage($: CheerioAPI): string | null {
  const raw = $("html").attr("lang");
  if (raw === undefined) return null;
  const value = normalizeText(raw);
  return value.length > 0 ? value : null;
}

/**
 * Resolve a link-ish href against `base`.
 *
 * Only absolute http/https URLs survive; `mailto:`, `javascript:`, `data:`,
 * `file:` and unparseable values become null. The fragment is dropped because
 * it never changes the fetched resource.
 */
function resolveLink(href: string | undefined, base: URL | null): string | null {
  if (href === undefined) return null;
  const trimmed = normalizeText(href);
  if (!trimmed) return null;
  try {
    const resolved = base ? new URL(trimmed, base) : new URL(trimmed);
    if (!isHttpProtocol(resolved)) return null;
    resolved.hash = "";
    return resolved.toString();
  } catch {
    return null;
  }
}

/** Canonical URL: resolved against `finalUrl`, http/https only, else null. */
function extractCanonical($: CheerioAPI, base: URL | null): string | null {
  const el = $("link[rel='canonical']").first();
  if (el.length === 0) return null;
  return resolveLink(el.attr("href"), base);
}

/** Bound an option to a non-negative integer, falling back on nonsense input. */
function boundedInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

/**
 * Pick the main content container.
 *
 * Tries `main`, then `article`, then `[role=main]`; otherwise falls back to the
 * `<div>` with the most paragraph text (ties go to the earliest in document
 * order), and finally to `<body>`.
 */
function selectContainer($: CheerioAPI): Selection {
  for (const selector of CONTAINER_SELECTORS) {
    const candidate = $(selector).first();
    if (candidate.length > 0) return candidate;
  }
  let best: Selection | null = null;
  let bestScore = -1;
  for (const el of $("div").toArray()) {
    let score = 0;
    for (const p of $(el).find("p").toArray()) score += normalizeText($(p).text()).length;
    if (score > bestScore) {
      bestScore = score;
      best = $(el);
    }
  }
  if (best !== null && bestScore > 0) return best;
  return $("body");
}

/**
 * Extract one line per block element, in document order.
 *
 * Each block's text is collapsed to a single line (source formatting newlines
 * inside a `<p>` are just whitespace), so paragraph and heading boundaries are
 * exactly the block boundaries. A block whose ancestor was already emitted is
 * skipped so nested structures (e.g. `<p>` inside `<li>`) are not duplicated.
 */
function extractBlockLines($: CheerioAPI, container: Selection): string[] {
  const emitted = new Set<object>();
  const lines: string[] = [];
  for (const el of $(container).find(BLOCK_SELECTOR).toArray()) {
    let covered = false;
    for (const parent of $(el).parents().toArray()) {
      if (emitted.has(parent)) {
        covered = true;
        break;
      }
    }
    if (covered) continue;
    emitted.add(el);
    const text = normalizeText($(el).text());
    if (text) lines.push(text);
  }
  return lines;
}

/** Headings h1-h3 from the main content, in document order. */
function extractHeadings($: CheerioAPI, container: Selection): Heading[] {
  const headings: Heading[] = [];
  for (const el of $(container).find("h1, h2, h3").toArray()) {
    const level = Number.parseInt(el.tagName.slice(1), 10);
    if (!Number.isInteger(level)) continue;
    const text = normalizeText($(el).text());
    if (!text) continue;
    headings.push({ level, text });
  }
  return headings;
}

/** Absolute, de-duplicated http(s) links from the main content. */
function extractLinks($: CheerioAPI, container: Selection, base: URL | null, maxLinks: number): string[] {
  const links: string[] = [];
  if (maxLinks <= 0) return links;
  const seen = new Set<string>();
  for (const el of $(container).find("a[href]").toArray()) {
    if (links.length >= maxLinks) break;
    const resolved = resolveLink($(el).attr("href"), base);
    if (resolved === null || seen.has(resolved)) continue;
    seen.add(resolved);
    links.push(resolved);
  }
  return links;
}

/** Parse an HTML document into normalised, provenance-ready fields. */
export function extractDocument(html: string, finalUrl: string, opts?: ExtractOptions): ExtractedDocument {
  const $ = loadDocument(html);
  const base = parseBaseUrl(finalUrl);
  const maxLinks = boundedInt(opts?.maxLinks, DEFAULT_MAX_LINKS);

  // Metadata and structured data are read before the DOM is pruned.
  const jsonLd = extractJsonLd($);
  const openGraph = extractOpenGraph($);

  const metaTitle = normalizeText($("title").first().text());
  const title = metaTitle || openGraph["title"] || null;
  const description =
    firstMetaContent($, "name", "description") ?? openGraph["description"] ?? null;
  const canonicalUrl = extractCanonical($, base);
  const language = extractLanguage($);

  const publishedFromJsonLd: string[] = [];
  collectJsonLdDates(jsonLd, ["datepublished"], publishedFromJsonLd, 0);
  const modifiedFromJsonLd: string[] = [];
  collectJsonLdDates(jsonLd, ["datemodified"], modifiedFromJsonLd, 0);

  const firstTimeDatetime = normalizeText($("time[datetime]").first().attr("datetime") ?? "");
  const publishedAt = firstIsoDate([
    ...publishedFromJsonLd,
    firstMetaContent($, "property", "article:published_time"),
    firstMetaContent($, "name", "date"),
    firstTimeDatetime,
  ]);
  // Only modified-specific sources are consulted. A generic publication date is
  // never reused as a modification date: that would be inventing provenance.
  const modifiedAt = firstIsoDate([
    ...modifiedFromJsonLd,
    firstMetaContent($, "property", "article:modified_time"),
  ]);

  const publisher =
    openGraph["site_name"] ?? firstMetaContent($, "name", "application-name") ?? base?.hostname ?? null;

  // Boilerplate removal happens after metadata extraction.
  $(BOILERPLATE_SELECTOR).remove();

  const container = selectContainer($);
  let lines = extractBlockLines($, container);
  if (lines.length === 0) {
    // A declared container with no block content (or none at all) falls back to
    // the whole body so plain-text pages still yield evidence.
    lines = extractBlockLines($, $("body"));
  }
  if (lines.length === 0) lines = normalizeLines($("body").text());

  const mainText = lines.join("\n");
  const wordCount = mainText.length === 0 ? 0 : mainText.split(/\s+/).filter(Boolean).length;
  const headings = extractHeadings($, container.length > 0 ? container : $("body"));
  const links = extractLinks($, container.length > 0 ? container : $("body"), base, maxLinks);

  return {
    title,
    description,
    canonicalUrl,
    language,
    publishedAt,
    modifiedAt,
    openGraph,
    jsonLd,
    headings,
    mainText,
    wordCount,
    contentHashSha256: hashContent(mainText),
    links,
    publisher,
  };
}
