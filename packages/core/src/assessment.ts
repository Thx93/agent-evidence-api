import type { AssessmentStatus } from "@aee/schemas";
import type { EvidenceCandidate } from "@aee/extraction";

/**
 * Deterministic, lexical-only assessment (SPEC sections 9, 21).
 *
 * This module is deliberately conservative. It has no semantic understanding,
 * so it must never assert more than the surface evidence supports. Where the
 * signals conflict or are absent it returns `inconclusive` rather than guessing.
 *
 * No confidence scores are produced anywhere: the spec forbids them, and a
 * number would imply a precision this method does not have.
 */

export interface SourceEvidence {
  /** Source URL, used to cite the basis. */
  url: string;
  candidates: EvidenceCandidate[];
}

export interface AssessmentOutcome {
  status: AssessmentStatus;
  basis: string;
  /** Explanatory notes suitable for the response `limitations` array. */
  limitations: string[];
}

/** Which way a single source leans, based purely on lexical signals. */
type Stance = "supports" | "contradicts" | "none";

interface SourceStance {
  url: string;
  stance: Stance;
  candidateCount: number;
}

/**
 * Classify one source.
 *
 * A source only counts as evidence-bearing when it has at least one candidate
 * with `direct` or `supporting` relevance. The stance is then decided by the
 * STRONGEST matching passage — candidates arrive sorted by score descending, so
 * the first relevant one is the best evidence the source offers.
 *
 * An earlier version discarded a source whenever it contained both a negated
 * and a non-negated passage, which made almost any real document inconclusive:
 * a page typically has one sentence carrying the negation and several nearby
 * sentences that merely mention the subject. Keying on the top passage is both
 * simpler and far more faithful. It remains a lexical heuristic, and the
 * published basis string says so.
 */
function classify(source: SourceEvidence): SourceStance {
  // `context` candidates are background, not evidence-bearing, so they do not
  // grant a source a stance. Everything else does.
  const relevant = source.candidates.filter(
    (c) =>
      c.relevance === "direct" ||
      c.relevance === "supporting" ||
      c.relevance === "contradictory",
  );

  if (relevant.length === 0) {
    return { url: source.url, stance: "none", candidateCount: source.candidates.length };
  }

  // The extraction layer already applied the lexical negation check when it
  // labelled candidates, so the stance follows the strongest passage's label.
  const strongest = relevant[0];
  const stance: Stance =
    strongest && strongest.relevance === "contradictory" ? "contradicts" : "supports";

  return { url: source.url, stance, candidateCount: relevant.length };
}

/** Hostname for citing a source without dumping a full URL into prose. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function assess(sources: SourceEvidence[]): AssessmentOutcome {
  const classified = sources.map(classify);
  const supporting = classified.filter((s) => s.stance === "supports");
  const contradicting = classified.filter((s) => s.stance === "contradicts");
  const silent = classified.filter((s) => s.stance === "none");

  const limitations: string[] = [
    "Assessment is derived from deterministic lexical matching, not semantic reasoning. " +
      "A configured reasoning provider may refine it, but never replaces source evidence.",
  ];
  if (silent.length > 0) {
    limitations.push(
      `${silent.length} source(s) contributed no directly matching passage and were not used to reach the assessment.`,
    );
  }

  if (supporting.length === 0 && contradicting.length === 0) {
    return {
      status: "inconclusive",
      basis:
        sources.length === 0
          ? "No sources were available to assess."
          : `No passage in the ${sources.length} retrieved source(s) matched the question closely enough to support or contradict it.`,
      limitations,
    };
  }

  if (supporting.length > 0 && contradicting.length === 0) {
    return {
      status: "supported",
      basis:
        `${supporting.length} source(s) contained passages matching the question ` +
        `(${supporting.map((s) => hostOf(s.url)).join(", ")}) with no contradicting passages found.`,
      limitations,
    };
  }

  if (contradicting.length > 0 && supporting.length === 0) {
    return {
      status: "contradicted",
      basis:
        `${contradicting.length} source(s) contained passages that negate the question ` +
        `(${contradicting.map((s) => hostOf(s.url)).join(", ")}) with no supporting passages found.`,
      limitations,
    };
  }

  return {
    status: "mixed",
    basis:
      `Sources disagreed: ${supporting.length} leaning to support ` +
      `(${supporting.map((s) => hostOf(s.url)).join(", ")}) and ` +
      `${contradicting.length} leaning against ` +
      `(${contradicting.map((s) => hostOf(s.url)).join(", ")}).`,
    limitations,
  };
}
