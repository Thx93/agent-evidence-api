/**
 * Extension seams (SPEC section 37).
 *
 * Section 37 lists nine interfaces to prepare and says explicitly not to
 * implement them all now. Two are real and in use:
 *
 *   ReasoningProvider  packages/core/src/reasoning.ts  (implemented; opt-in)
 *   CacheProvider      packages/cache                  (implemented)
 *
 * The rest are declared here as **types only**. There is no implementation, no
 * factory and no default, deliberately:
 *
 *   - Nothing in this file is imported by the running service. Adding an
 *     implementation is a deliberate act, not a side effect of this existing.
 *   - Every provider follows the same rule the reasoning seam proved out: a
 *     provider is an upgrade, never a dependency. It must be able to fail, and
 *     the caller must degrade rather than error.
 *
 * These exist so the shape of a future capability is decided before it is
 * needed, which is what section 37 asks for. A seam that is designed late tends
 * to be designed around whatever implementation arrives first.
 */

/** A candidate source returned by a search provider, before any fetching. */
export interface SourceCandidate {
  url: string;
  title?: string;
  snippet?: string;
  /** Provider-assigned relevance, if it has one. Never treated as truth. */
  score?: number;
}

/**
 * Finds URLs instead of only accepting them (SPEC section 8).
 *
 * v0.1.0 deliberately requires agent-supplied URLs: a third-party paid search API
 * must not be mandatory for the MVP, and the product complements an agent's own
 * search rather than replacing it.
 */
export interface SearchProvider {
  readonly name: string;
  /** Normalised candidates, or null when the provider cannot answer. */
  search(query: string, limit?: number): Promise<SourceCandidate[] | null>;
}

/** Retrieves a page that needs JavaScript to render (SPEC section 37). */
export interface BrowserProvider {
  readonly name: string;
  /** Rendered HTML, or null. Must respect the same SSRF rules as the fetcher. */
  render(url: string): Promise<{ html: string; finalUrl: string } | null>;
}

/** Extracts text from a non-HTML document: PDF, office formats (SPEC section 37). */
export interface DocumentProvider {
  readonly name: string;
  /** Plain text plus whatever metadata the format exposes, or null. */
  extract(
    body: Uint8Array,
    contentType: string,
  ): Promise<{ text: string; title?: string; pageCount?: number } | null>;
}

/** Ranks or filters evidence candidates (SPEC section 37). */
export interface EvidenceRanker {
  readonly name: string;
  /**
   * Reorders candidates by how directly they bear on the question.
   *
   * Must return the SAME set of candidates - only their order may change - so a
   * ranker can never add or remove evidence. Null means "keep the current order".
   */
  rank(question: string, excerpts: readonly string[]): Promise<number[] | null>;
}

/** Supplies trust signals about a source (SPEC section 37). */
export interface SourceTrustProvider {
  readonly name: string;
  /**
   * Advisory signals only. These must never be presented to a buyer as a verdict
   * on whether a source is true, and never replace the cited evidence.
   */
  signals(url: string): Promise<{ signals: Record<string, number> } | null>;
}

/**
 * Abstracts the payment boundary (SPEC section 37).
 *
 * Payment is enforced at the Cloudflare Worker today, not in this process. Any
 * implementation must preserve the guarantee proven in production: a request that
 * fails is never charged.
 */
export interface PaymentProvider {
  readonly name: string;
  /** Whether this request carries an acceptable payment proof. */
  verify(proof: string | undefined): Promise<{ valid: boolean; reason?: string } | null>;
}
