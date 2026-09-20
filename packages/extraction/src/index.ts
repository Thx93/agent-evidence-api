/**
 * @aee/extraction — HTML parsing, metadata extraction, main-content
 * normalisation, and deterministic lexical evidence ranking.
 *
 * This package is the "HTML parsing → metadata extraction → main-content
 * extraction → normalisation → evidence candidate extraction" segment of the
 * SPEC section 3 pipeline. It is pure: no network, no filesystem, no clock.
 *
 * The provenance fields produced here map onto `@aee/schemas` `Source`
 * (`title`, `canonical_url`, `description`, `publisher`, `language`,
 * `published_at`, `modified_at`, `word_count`, `content_hash_sha256`,
 * `structured_data`) and each {@link EvidenceCandidate} maps onto an
 * `EvidenceItem` once the evidence engine has judged it. The schema types below
 * are the contract this package must remain compatible with.
 */
import type { EvidenceItem, Relevance } from "@aee/schemas";

export type { ExtractedDocument, ExtractOptions, Heading } from "./extract.js";
export { extractDocument } from "./extract.js";
export { hashContent, normalizeText } from "./text.js";
export type { EvidenceCandidate } from "./evidence.js";
export { findEvidenceCandidates, hasNegationCue } from "./evidence.js";

/**
 * Compile-time guard that the `Relevance` value used by {@link EvidenceCandidate}
 * is exactly the schema's relevance vocabulary. If `@aee/schemas` ever changes
 * it, this package fails to typecheck rather than silently drifting from the
 * wire contract. Not exported: the package surface stays as specified.
 */
type RelevanceContract = Relevance extends EvidenceItem["relevance"]
  ? EvidenceItem["relevance"] extends Relevance
    ? true
    : never
  : never;
type _AssertRelevanceContract = RelevanceContract;
