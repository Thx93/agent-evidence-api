import {
  EvidenceRequestSchema,
  type AssessmentStatus,
  type ErrorCode,
  type EvidenceRequest,
  type EvidenceResponse,
  type Source,
  type SourceWarning,
  SCHEMA_VERSION,
  HARD_CAPS,
} from "@aee/schemas";
import { FetchError, fetchSource, type FetchResult } from "@aee/fetcher";
import {
  extractDocument,
  findEvidenceCandidates,
  hasNegationCue,
  type EvidenceCandidate,
  type ExtractedDocument,
} from "@aee/extraction";
import { cacheKey, type CacheProvider, type CacheRecord } from "@aee/cache";
import { assess, type SourceEvidence } from "./assessment.js";
import { checkRobots, robotsWarning } from "./robots.js";
import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";

/** Typed error carrying a stable, public error code. */
export class ServiceError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    if (details) this.details = details;
  }
}

export interface EvidenceServiceDeps {
  config: AppConfig;
  logger: Logger;
  /** Optional bounded cache. Omit to disable caching. */
  cache?: CacheProvider | null;
  /** Injectable fetch implementation — used by tests to avoid the network. */
  fetchImpl?: typeof fetchSource;
}

/** Cached representation of one successfully processed source. */
interface CachedPayload {
  doc: ExtractedDocument;
  candidates: EvidenceCandidate[];
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  redirectChain: string[];
  warnings: SourceWarning[];
}

/**
 * Simple counting semaphore. Bounds concurrent fetches so one request cannot
 * consume the whole VPS (SPEC sections 3, 23).
 */
function createSemaphore(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  async function acquire(): Promise<() => void> {
    if (active < limit) {
      active++;
    } else {
      await new Promise<void>((resolve) => queue.push(resolve));
      active++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
      const next = queue.shift();
      if (next) next();
    };
  }

  return { acquire };
}

/** Normalise and de-duplicate requested URLs, preserving input order. */
function uniqueUrls(urls: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let key: string;
    try {
      key = cacheKey(trimmed);
    } catch {
      // Keep unparseable entries: the fetcher will reject them with a precise
      // INVALID_URL and the caller sees why, rather than silently dropping them.
      key = trimmed;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export class EvidenceService {
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly cache: CacheProvider | null;
  private readonly doFetch: typeof fetchSource;
  private readonly semaphore: ReturnType<typeof createSemaphore>;

  constructor(deps: EvidenceServiceDeps) {
    this.config = deps.config;
    this.logger = deps.logger;
    this.cache = deps.cache ?? null;
    this.doFetch = deps.fetchImpl ?? fetchSource;
    this.semaphore = createSemaphore(Math.max(1, deps.config.limits.maxConcurrentFetches));
  }

  /**
   * Execute one evidence request.
   *
   * Individual source failures do NOT fail the whole request: a source that
   * could not be retrieved is still reported, with its status null and a
   * warning explaining why. That preserves provenance and lets a caller see
   * partial results instead of losing four good sources to one bad URL.
   */
  async execute(input: unknown, requestId: string): Promise<EvidenceResponse> {
    const started = Date.now();
    const log = this.logger.child({ request_id: requestId });

    const parsed = EvidenceRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new ServiceError("INVALID_REQUEST", "The request body is invalid.", {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }
    const request: EvidenceRequest = parsed.data;

    const requested = uniqueUrls(request.urls ?? []);
    if (requested.length === 0) {
      throw new ServiceError(
        "INVALID_REQUEST",
        "At least one source URL is required. Version 0.1.0 supports agent-supplied URLs only.",
      );
    }
    if (requested.length > this.config.limits.maxUrlsPerRequest) {
      throw new ServiceError(
        "INVALID_REQUEST",
        `Too many URLs: ${requested.length} supplied, limit is ${this.config.limits.maxUrlsPerRequest}.`,
      );
    }

    const maxSources = Math.min(
      request.max_sources ?? requested.length,
      requested.length,
      this.config.limits.maxUrlsPerRequest,
      HARD_CAPS.MAX_SOURCES,
    );
    const targets = requested.slice(0, maxSources);

    log.info("evidence request started", {
      url_count: targets.length,
      mode: request.mode ?? "evidence",
      cache_enabled: this.cache !== null,
    });

    const results = await Promise.all(
      targets.map((url) => this.processSource(url, request, requestId)),
    );

    const sources = results.map((r) => r.source);
    const evidenceInput: SourceEvidence[] = results.map((r, i) => ({
      url: targets[i] ?? r.source.requested_url,
      candidates: r.candidates,
    }));

    const outcome = assess(evidenceInput);

    const limitations = [...outcome.limitations];
    const failed = sources.filter((s) => s.status === null).length;
    if (failed > 0) {
      limitations.push(
        `${failed} of ${sources.length} source(s) could not be retrieved; see per-source warnings.`,
      );
    }
    if (sources.some((s) => s.from_cache)) {
      limitations.push(
        "Some sources were served from cache. Each source reports its actual retrieval time.",
      );
    }

    const response: EvidenceResponse = {
      request_id: requestId,
      version: SCHEMA_VERSION,
      question: request.question,
      assessment: { status: outcome.status as AssessmentStatus, basis: outcome.basis },
      sources,
      limitations,
      processing_ms: Date.now() - started,
    };

    const cacheHits = sources.filter((s) => s.from_cache).length;
    log.info("evidence request completed", {
      duration_ms: response.processing_ms,
      sources: sources.length,
      fetch_ok: sources.length - failed,
      fetch_failed: failed,
      cache_hits: cacheHits,
      cache_misses: sources.length - cacheHits,
      assessment: response.assessment.status,
    });

    return response;
  }

  /** Retrieve, extract and analyse a single source, using cache when possible. */
  private async processSource(
    requestedUrl: string,
    request: EvidenceRequest,
    requestId: string,
  ): Promise<{ source: Source; candidates: EvidenceCandidate[] }> {
    const log = this.logger.child({ request_id: requestId });

    // ---- cache lookup -----------------------------------------------------
    if (this.cache) {
      let key: string | null = null;
      try {
        key = cacheKey(requestedUrl);
      } catch {
        key = null; // unparseable: let the fetcher produce the precise error
      }
      if (key) {
        try {
          const hit = await this.cache.get(key);
          if (hit) {
            const payload = hit.payload as CachedPayload;
            if (isUsablePayload(payload)) {
              log.debug("cache hit", { url: requestedUrl });
              return {
                source: this.toSource(payload, hit, request, true),
                candidates: payload.candidates,
              };
            }
          }
        } catch (err) {
          // A cache failure must never break a request; degrade to a live fetch.
          log.warn("cache lookup failed; continuing without cache", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // ---- robots policy (SPEC section 19) ----------------------------------
    // `ignore` skips this entirely; `warn` records a warning and proceeds;
    // `enforce` refuses the source. The setting was previously parsed but never
    // consulted, which made it silently inert.
    let robotsWarningForSource: SourceWarning | null = null;
    if (this.config.fetch.robotsPolicy !== "ignore") {
      try {
        const parsed = new URL(requestedUrl);
        const verdict = await checkRobots(
          { origin: parsed.origin, path: parsed.pathname },
          this.config.fetch.userAgent,
          this.doFetch,
          this.config.limits,
          this.config.fetch.allowLoopbackForTests,
        );
        if (!verdict.allowed) {
          if (this.config.fetch.robotsPolicy === "enforce") {
            return {
              source: this.failedSource(
                requestedUrl,
                new ServiceError(
                  "BLOCKED_URL",
                  `robots.txt disallows this path for our user agent (rule: "${verdict.rule}").`,
                ),
              ),
              candidates: [],
            };
          }
          robotsWarningForSource = robotsWarning(verdict.rule);
        }
      } catch {
        // An unparseable URL will be rejected with a precise error by the
        // fetcher; do not pre-empt that here.
      }
    }

    // ---- live fetch -------------------------------------------------------
    const release = await this.semaphore.acquire();
    let fetched: FetchResult;
    try {
      fetched = await this.doFetch({
        url: requestedUrl,
        limits: this.config.limits,
        userAgent: this.config.fetch.userAgent,
        // Ignored by the fetcher unless NODE_ENV === "test"; see config.ts.
        allowLoopbackForTests: this.config.fetch.allowLoopbackForTests,
      });
    } catch (err) {
      return { source: this.failedSource(requestedUrl, err), candidates: [] };
    } finally {
      release();
    }

    // ---- extract ----------------------------------------------------------
    let payload: CachedPayload;
    try {
      const doc = extractDocument(fetched.body ?? "", fetched.finalUrl);
      const candidates = findEvidenceCandidates(doc, request.question, {
        maxItems: this.config.limits.maxEvidenceItems,
        maxExcerptChars: this.config.limits.maxExcerptChars,
      });
      payload = {
        doc,
        candidates,
        requestedUrl: fetched.requestedUrl,
        finalUrl: fetched.finalUrl,
        status: fetched.status,
        contentType: fetched.contentType,
        redirectChain: fetched.redirectChain,
        warnings: robotsWarningForSource
          ? [...fetched.warnings, robotsWarningForSource]
          : fetched.warnings,
      };
    } catch (err) {
      log.warn("extraction failed", {
        url: requestedUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        source: this.failedSource(
          requestedUrl,
          new ServiceError("EXTRACTION_FAILURE", "The source could not be processed."),
          fetched,
        ),
        candidates: [],
      };
    }

    // ---- cache store ------------------------------------------------------
    if (this.cache) {
      try {
        const key = cacheKey(fetched.finalUrl);
        const ttl = this.config.limits.cacheTtlSeconds;
        const record: CacheRecord = {
          key,
          url: requestedUrl,
          finalUrl: fetched.finalUrl,
          status: fetched.status,
          contentType: fetched.contentType,
          contentHash: payload.doc.contentHashSha256,
          payload,
          retrievedAt: fetched.retrievedAt,
          storedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
          bytes: fetched.bytes,
        };
        await this.cache.set(record);
      } catch (err) {
        log.warn("cache store failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      source: this.toSource(payload, null, request, false),
      candidates: payload.candidates,
    };
  }

  /** Build a provenance record for a source that could not be retrieved. */
  private failedSource(
    requestedUrl: string,
    err: unknown,
    fetched?: FetchResult,
  ): Source {
    // Both error types carry a stable public code; anything else is internal.
    const code: ErrorCode =
      err instanceof FetchError
        ? err.code
        : err instanceof ServiceError
          ? err.code
          : "INTERNAL_ERROR";
    const message =
      err instanceof Error && err.message
        ? err.message
        : "The source could not be retrieved.";

    this.logger.warn("source fetch failed", {
      url: requestedUrl,
      error_code: code,
    });

    return {
      requested_url: requestedUrl,
      final_url: fetched?.finalUrl ?? null,
      status: null,
      content_type: fetched?.contentType ?? null,
      title: null,
      canonical_url: null,
      description: null,
      publisher: null,
      language: null,
      published_at: null,
      modified_at: null,
      retrieved_at: new Date().toISOString(),
      word_count: null,
      content_hash_sha256: null,
      evidence: [],
      structured_data: { json_ld: [], open_graph: {} },
      warnings: [{ code, message }],
      from_cache: false,
      redirect_chain: fetched?.redirectChain ?? [],
    };
  }

  /** Build the public provenance record from a successfully processed source. */
  private toSource(
    payload: CachedPayload,
    cached: CacheRecord | null,
    request: EvidenceRequest,
    fromCache: boolean,
  ): Source {
    const doc = payload.doc;
    const language =
      request.language && request.language !== "auto" ? request.language : doc.language;

    const warnings: SourceWarning[] = [...payload.warnings];
    if (payload.status >= 400) {
      warnings.push({
        code: "UPSTREAM_HTTP_FAILURE",
        message: `The source returned HTTP ${payload.status}.`,
      });
    }
    if (fromCache) {
      warnings.push({
        code: "SERVED_FROM_CACHE",
        message: `Served from cache; originally retrieved at ${cached?.retrievedAt ?? payload.doc.contentHashSha256}.`,
      });
    }

    return {
      requested_url: payload.requestedUrl,
      final_url: payload.finalUrl,
      status: payload.status,
      content_type: payload.contentType,
      title: doc.title,
      canonical_url: doc.canonicalUrl,
      description: doc.description,
      publisher: doc.publisher,
      language: language ?? null,
      published_at: doc.publishedAt,
      modified_at: doc.modifiedAt,
      // Always the ACTUAL retrieval time, even on a cache hit (SPEC section 16).
      retrieved_at: fromCache ? (cached?.retrievedAt ?? new Date().toISOString()) : new Date().toISOString(),
      word_count: doc.wordCount,
      content_hash_sha256: doc.contentHashSha256,
      evidence: payload.candidates.map((c) => ({
        excerpt: c.excerpt,
        context: c.context,
        relevance: c.relevance,
      })),
      structured_data: { json_ld: doc.jsonLd, open_graph: doc.openGraph },
      warnings,
      from_cache: fromCache,
      redirect_chain: payload.redirectChain,
    };
  }
}

/** Narrow a cached payload back to a usable shape. */
function isUsablePayload(value: unknown): value is CachedPayload {
  if (value === null || typeof value !== "object") return false;
  const p = value as Partial<CachedPayload>;
  return (
    typeof p.doc === "object" &&
    p.doc !== null &&
    Array.isArray(p.candidates) &&
    typeof p.finalUrl === "string" &&
    typeof p.status === "number"
  );
}

/** Exposed for unit tests of the negation heuristic used by assessment. */
export { hasNegationCue };
