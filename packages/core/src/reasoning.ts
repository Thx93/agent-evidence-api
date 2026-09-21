/**
 * Semantic reasoning seam (SPEC section 37).
 *
 * The lexical scorer in @aee/extraction is deterministic and dependency-free,
 * but it has a measured ceiling: asked "What is the population of Tokyo?", it
 * ranks a history passage above the sentence that answers the question, because
 * that sentence says "the city proper" instead of repeating "Tokyo". Two
 * heuristics were tried and reverted; no lexical trick bridges the gap.
 *
 * This interface is where a judgement model plugs in to close it. It is
 * deliberately narrow: score passages for how directly they answer the
 * question. It does NOT fetch, cite, or decide provenance — those are already
 * solved and must not be delegated to a model.
 *
 * The contract every implementation must honour: `scorePassages` returns
 * `null` rather than throwing when it cannot answer. The caller then keeps its
 * lexical result. A reasoning provider is an upgrade, never a dependency — the
 * service must behave exactly as before when it is absent, loading, or slow.
 */

export interface ReasoningProvider {
  readonly name: string;

  /**
   * @returns one score per passage, aligned by index, each in [0, 1]; or null
   *          if the provider could not answer (unavailable, timeout, bad shape).
   */
  scorePassages(
    question: string,
    passages: readonly string[],
    signal?: AbortSignal,
  ): Promise<number[] | null>;
}

/** The default: no semantic reasoning. Reproduces the lexical-only behaviour. */
export const noReasoning: ReasoningProvider = {
  name: "none",
  async scorePassages() {
    return null;
  },
};

export interface LayaProviderOptions {
  /** Base URL of the Laya sidecar, e.g. http://127.0.0.1:8077 */
  url: string;
  /**
   * Hard ceiling for the whole call. Measured at ~410 ms per passage on a
   * 4 vCPU CPU, so a 5-passage request needs ~2.1 s; anything beyond this
   * budget falls back to lexical rather than making the buyer wait.
   */
  timeoutMs: number;
}

/**
 * Laya-backed provider (open weights, Apache-2.0, self-hosted).
 *
 * Chosen over a hosted judgement API because it needs no vendor, no key and no
 * per-call fee, and the content never leaves the host. Measured on the VPS:
 * ~410 ms per passage, ~2.9 GB resident, 33 s cold load — which is why it runs
 * as a separate process and why this provider treats every failure as "fall
 * back", never as an error the buyer sees.
 */
export function createLayaProvider(opts: LayaProviderOptions): ReasoningProvider {
  return {
    name: `laya(${opts.url})`,

    async scorePassages(question, passages, signal) {
      if (passages.length === 0) return [];

      const timeout = AbortSignal.timeout(opts.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

      try {
        const res = await fetch(new URL("/judge", opts.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question, passages: [...passages] }),
          signal: combined,
        });
        if (!res.ok) return null;

        const body = (await res.json()) as { scores?: unknown };
        if (!Array.isArray(body.scores) || body.scores.length !== passages.length) {
          return null;
        }
        // Coerce and bounds-check: a malformed score must not silently reorder
        // evidence. Any non-finite value means we cannot trust the batch.
        const scores = body.scores.map((s) => Number(s));
        if (scores.some((s) => !Number.isFinite(s) || s < 0 || s > 1)) return null;
        return scores;
      } catch {
        // Unreachable, timeout, non-JSON, aborted — all mean "use lexical".
        return null;
      }
    },
  };
}
