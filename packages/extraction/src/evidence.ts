/**
 * Deterministic lexical evidence ranking.
 *
 * This module is deliberately **not** semantic. It performs the same keyword and
 * morphological matching every time, on any machine, with no model, no
 * embedding, and no randomness. The downstream evidence engine may interpret
 * these candidates; this package only finds and orders them.
 *
 * ## Relevance labels
 *
 * All four labels defined by the response schema are reachable:
 *
 * - `"contradictory"` — the segment matches question terms AND carries a
 *   negation cue (see {@link hasNegationCue}). This is a LEXICAL signal only:
 *   it says the wording negates, not that the source refutes the claim. Callers
 *   must not present it as semantic understanding.
 * - `"direct"` — no negation, and a score within 25% of the best match.
 * - `"supporting"` — no negation, and a score within 35%..75% of the best match.
 * - `"context"` — no negation, positive overlap, but a weak score (< 35% of the
 *   best match): topically related background rather than direct evidence.
 *
 * Segments with no lexical overlap at all are still dropped before return, so
 * an entirely unrelated document yields no candidates rather than filler.
 *
 * ## Term matching
 *
 * Question tokens shorter than 3 characters and built-in English stopwords are
 * dropped. Each surviving token also contributes simple morphological variants
 * by stripping one trailing `ing`, `ed`, `es`, or `s` (the stem must still be at
 * least 3 characters). Document tokens are expanded the same way, so `"product"`
 * in a question matches `"products"` in the text and vice versa. This is
 * intentionally crude: no stemming library, no irregular forms.
 */
import type { Relevance } from "@aee/schemas";
import type { ExtractedDocument } from "./extract.js";

/** A scored, citable excerpt from the document. */
export interface EvidenceCandidate {
  excerpt: string;
  /** Breadcrumb of the enclosing heading plus paragraph index, e.g. "h2:Products > p[3]". */
  context: string;
  relevance: Relevance;
  /** Higher is more relevant. Deterministic; see the scoring formula below. */
  score: number;
}

/**
 * Minimal built-in English stopword list.
 *
 * Kept deliberately small and fixed so ranking is reproducible across releases.
 * Negation words are included here too: they are handled explicitly by
 * {@link hasNegationCue}, not as weak evidence terms.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "about", "after", "all", "also", "am", "an", "and", "any", "are", "as", "at",
  "be", "because", "been", "being", "between", "both", "but", "by",
  "can", "could", "did", "do", "does", "doing", "done", "during",
  "each", "few", "for", "from", "further", "had", "has", "have", "having", "he",
  "her", "here", "hers", "him", "his", "how", "however",
  "i", "if", "in", "into", "is", "it", "its", "itself",
  "just", "me", "more", "most", "much", "my", "no", "nor", "not", "now",
  "of", "off", "on", "once", "only", "or", "other", "our", "ours", "out", "over", "own",
  "same", "she", "should", "so", "some", "such", "than", "that", "the", "their",
  "them", "then", "there", "these", "they", "this", "those", "through", "to", "too",
  "under", "until", "up", "us", "very", "was", "we", "were", "what", "when", "where",
  "which", "while", "who", "whom", "why", "will", "with", "would", "you", "your", "yours",
]);

/** Terms shorter than this are ignored (in questions and in the document). */
const MIN_TERM_LENGTH = 3;

/** Trailing suffixes stripped (once) to build simple morphological variants. */
const SUFFIXES: readonly string[] = ["ing", "ed", "es", "s"];

/**
 * Score bonus per adjacent pair of *distinct* matched question terms, e.g. the
 * query "quantum computing" scoring the phrase "quantum computing" directly.
 * Small relative to term weights so it refines rather than dominates the order.
 */
const ADJACENCY_BONUS = 0.5;

/**
 * Documented negation/contrast cue list used by {@link hasNegationCue}.
 *
 * These are **lexical signals only**. A cue does not prove that a source
 * contradicts a claim, and its absence does not prove agreement.
 */
export const NEGATION_CUES: readonly string[] = [
  "not", "no", "never", "none", "nothing", "neither", "nor", "no longer", "without",
  "cannot", "can't", "won't", "wouldn't", "shouldn't", "doesn't", "don't",
  "didn't", "isn't", "aren't", "wasn't", "weren't", "hardly", "barely", "rarely",
  "denies", "denied", "deny", "refutes", "refuted", "refute", "contradicts",
  "contradicted", "disputes", "disputed", "rejects", "rejected", "disproves",
  "disproved", "debunks", "debunked", "debunk", "false", "falsely", "untrue",
  "incorrect", "inaccurate", "myth", "ceased", "cease", "stopped", "halted",
  "lacks", "lacking", "absent", "fails", "failed", "contrary", "instead", "rather",
];

/** Pre-compiled word-boundary matchers, one per cue. */
const NEGATION_PATTERNS: readonly RegExp[] = NEGATION_CUES.map(
  (cue) => new RegExp(`\\b${cue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`),
);

/**
 * True when `text` contains a documented negation/contrast cue.
 *
 * Matching is case-insensitive and word-bounded, so `"notable"` does not match
 * `"not"`. Multi-word cues such as `"no longer"` must appear contiguously in the
 * normalised text. This is a lexical signal, not a semantic conclusion.
 */
export function hasNegationCue(text: string): boolean {
  if (!text) return false;
  const normalised = text
    .toLowerCase()
    .replace(/[\u2018\u2019\u02BC`]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalised) return false;
  return NEGATION_PATTERNS.some((pattern) => pattern.test(normalised));
}

/** Lower-case word tokens; punctuation is dropped, apostrophes are kept. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u02BC`]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/** One token plus any simple morphological variants (see module docs). */
function variants(token: string): string[] {
  const out = [token];
  for (const suffix of SUFFIXES) {
    if (token.length >= suffix.length + MIN_TERM_LENGTH && token.endsWith(suffix)) {
      out.push(token.slice(0, token.length - suffix.length));
    }
  }
  return out;
}

/** Significant question terms: tokenised, stopword-filtered, variant-expanded. */
function deriveQuestionTerms(question: string): Set<string> {
  const terms = new Set<string>();
  for (const token of tokenize(question)) {
    if (token.length < MIN_TERM_LENGTH || STOPWORDS.has(token)) continue;
    for (const variant of variants(token)) {
      if (variant.length < MIN_TERM_LENGTH || STOPWORDS.has(variant)) continue;
      terms.add(variant);
    }
  }
  return terms;
}

/** Question term matched by a document token, or null. */
function matchTerm(token: string, terms: ReadonlySet<string>): string | null {
  if (token.length < MIN_TERM_LENGTH) return null;
  for (const variant of variants(token)) {
    if (terms.has(variant)) return variant;
  }
  return null;
}

/** Split one paragraph into sentences on `.`, `!`, `?`, and `;`. */
function splitSentences(line: string): string[] {
  return line
    .split(/(?<=[.!?;])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

interface Segment {
  text: string;
  /** 1-based index of the enclosing paragraph; 0 for a heading line. */
  paragraph: number;
  headingLabel: string | null;
  isHeading: boolean;
}

/**
 * Split `mainText` into sentences, tracking the enclosing heading and
 * paragraph index for provenance.
 */
function buildSegments(doc: ExtractedDocument): Segment[] {
  const headingLabels = new Map<string, string>();
  for (const heading of doc.headings) {
    if (!headingLabels.has(heading.text)) headingLabels.set(heading.text, `h${heading.level}:${heading.text}`);
  }

  const segments: Segment[] = [];
  let currentHeading: string | null = null;
  let paragraph = 0;
  for (const line of doc.mainText.split("\n")) {
    if (!line) continue;
    const label = headingLabels.get(line);
    if (label !== undefined) {
      currentHeading = label;
      segments.push({ text: line, paragraph: 0, headingLabel: label, isHeading: true });
      continue;
    }
    paragraph += 1;
    for (const sentence of splitSentences(line)) {
      segments.push({ text: sentence, paragraph, headingLabel: currentHeading, isHeading: false });
    }
  }
  return segments;
}

/** Breadcrumb for a segment: enclosing heading plus paragraph index. */
function buildContext(segment: Segment): string {
  if (segment.isHeading) return segment.headingLabel ?? "heading";
  const position = `p[${segment.paragraph}]`;
  return segment.headingLabel === null ? position : `${segment.headingLabel} > ${position}`;
}

/**
 * Truncate on a word boundary, appending "…" only when something was cut.
 *
 * When a single word is longer than the limit there is no boundary to cut on, so
 * a hard cut is used rather than returning nothing.
 */
function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  return `${(lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trimEnd()}\u2026`;
}

/**
 * Deterministic keyword/lexical matching. No LLM, no randomness.
 *
 * ### Scoring
 *
 * For each sentence segment the score is
 *
 * ```
 *   score = Σ idf(t)  for each distinct matched question term t
 *         + 0.5 × (adjacent pairs of distinct matched terms)
 *   idf(t) = ln(1 + N / (1 + df(t)))
 * ```
 *
 * where `N` is the number of segments and `df(t)` the number of segments
 * containing `t`. Segments scoring 0 are dropped; the remainder are sorted by
 * descending score with document order as the tie-break, then bounded by
 * `maxItems`.
 */
export function findEvidenceCandidates(
  doc: ExtractedDocument,
  question: string,
  opts: { maxItems: number; maxExcerptChars: number },
): EvidenceCandidate[] {
  const maxItems = Math.max(0, Math.trunc(opts.maxItems));
  if (maxItems === 0) return [];

  const terms = deriveQuestionTerms(question);
  if (terms.size === 0) return [];

  const segments = buildSegments(doc);
  if (segments.length === 0) return [];

  const perSegment = segments.map((segment) => {
    const tokenTerms = tokenize(segment.text).map((token) => matchTerm(token, terms));
    const matched = new Set<string>();
    let adjacency = 0;
    for (let i = 0; i < tokenTerms.length; i += 1) {
      const term = tokenTerms[i];
      if (term !== null && term !== undefined) matched.add(term);
      const previous = i > 0 ? tokenTerms[i - 1] : undefined;
      if (previous !== null && previous !== undefined && term !== null && term !== undefined && previous !== term) {
        adjacency += 1;
      }
    }
    return { segment, matched, adjacency };
  });

  // Document frequency per question term, then the IDF-like weight.
  const documentFrequency = new Map<string, number>();
  for (const term of terms) documentFrequency.set(term, 0);
  for (const entry of perSegment) {
    for (const term of entry.matched) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const segmentCount = segments.length;
  const idf = new Map<string, number>();
  for (const term of terms) {
    const df = documentFrequency.get(term) ?? 0;
    idf.set(term, Math.log(1 + segmentCount / (1 + df)));
  }

  const scored = perSegment.flatMap((entry, index) => {
    if (entry.matched.size === 0) return [];
    let score = 0;
    for (const term of entry.matched) score += idf.get(term) ?? 0;
    score += ADJACENCY_BONUS * entry.adjacency;
    score = Math.round(score * 1e6) / 1e6;
    return [{ index, score, matchedCount: entry.matched.size, entry }];
  });
  if (scored.length === 0) return [];

  const maxScore = scored.reduce((max, item) => Math.max(max, item.score), 0);

  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxItems)
    .map((item) => {
      // A matching passage that negates is labelled contradictory; otherwise the
      // score relative to the strongest match decides the remaining labels.
      const negated = hasNegationCue(item.entry.segment.text);
      const relevance: Relevance = negated
        ? "contradictory"
        : item.score >= maxScore * 0.75
          ? "direct"
          : item.score >= maxScore * 0.35
            ? "supporting"
            : "context";

      return {
        excerpt: truncate(item.entry.segment.text, opts.maxExcerptChars),
        context: buildContext(item.entry.segment),
        relevance,
        score: item.score,
      };
    });
}
