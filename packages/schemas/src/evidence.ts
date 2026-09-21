import { z } from "zod";

/** Stable identifiers for this service. */
export const SERVICE_NAME = "agent-evidence-api";
export const SERVICE_VERSION = "0.1.2";
/** Public API version prefix. */
export const API_VERSION = "v1";
/** Response schema version carried in every evidence response. */
export const SCHEMA_VERSION = "1";

/**
 * Absolute schema-level caps.
 *
 * These are deliberately generous: they exist so a malformed or hostile request
 * cannot reach the service with absurd dimensions. The *effective* limits are
 * lower and come from configuration (see ResourceLimitsSchema) so operators can
 * tune them without shipping a schema change.
 */
export const HARD_CAPS = {
  QUESTION_CHARS: 2000,
  URLS: 25,
  MAX_SOURCES: 25,
  EXCERPT_CHARS: 4000,
  EVIDENCE_ITEMS_PER_SOURCE: 20,
  LIMITATIONS: 50,
  WARNINGS: 50,
} as const;

/** The only supported request mode in v0.1.0. */
export const EVIDENCE_MODES = ["evidence"] as const;

/**
 * Evidence request body.
 *
 * `urls` is optional in the schema because version 0.1.0 must additionally
 * support future source mechanisms (SPEC section 8). At runtime the service
 * rejects a request that supplies no usable source at all -- that is a policy
 * decision, not a shape decision, so it does not belong in the schema.
 */
export const EvidenceRequestSchema = z.object({
  question: z
    .string()
    .trim()
    .min(1, "question must not be empty")
    .max(HARD_CAPS.QUESTION_CHARS, `question must be at most ${HARD_CAPS.QUESTION_CHARS} characters`),
  urls: z.array(z.string()).max(HARD_CAPS.URLS).optional(),
  max_sources: z.number().int().positive().max(HARD_CAPS.MAX_SOURCES).optional(),
  /** "auto" or a BCP-47 language tag. */
  language: z.string().trim().min(1).max(35).optional(),
  mode: z.enum(EVIDENCE_MODES).optional(),
});

export type EvidenceRequest = z.infer<typeof EvidenceRequestSchema>;

/** Explicit assessment outcomes. No confidence scores are ever emitted. */
export const AssessmentStatusSchema = z.enum([
  "supported",
  "contradicted",
  "mixed",
  "inconclusive",
]);
export type AssessmentStatus = z.infer<typeof AssessmentStatusSchema>;

/** How a given excerpt relates to the question. */
export const RelevanceSchema = z.enum([
  "direct",
  "supporting",
  "contradictory",
  "context",
]);
export type Relevance = z.infer<typeof RelevanceSchema>;

/** A short, cited excerpt. Excerpts are bounded: this is not a content dump. */
export const EvidenceItemSchema = z.object({
  excerpt: z.string().min(1).max(HARD_CAPS.EXCERPT_CHARS),
  /** Where in the document the excerpt came from, e.g. "h2 > p[3]". */
  context: z.string().optional(),
  relevance: RelevanceSchema,
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

/** Structured, machine-readable warning attached to a source. */
export const SourceWarningSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});
export type SourceWarning = z.infer<typeof SourceWarningSchema>;

/** Metadata recovered from the document itself. */
export const StructuredDataSchema = z.object({
  json_ld: z.array(z.unknown()),
  open_graph: z.record(z.string(), z.string()),
});
export type StructuredData = z.infer<typeof StructuredDataSchema>;

/**
 * Per-source provenance record.
 *
 * Every nullable field is nullable on purpose: when a value cannot be
 * determined it must be `null`, never guessed. `retrieved_at` is always present
 * and always reflects the actual retrieval time, even on a cache hit -- stale
 * evidence must never be presented as fresh (SPEC section 16).
 */
export const SourceSchema = z.object({
  requested_url: z.string(),
  final_url: z.string().nullable(),
  status: z.number().int().nullable(),
  content_type: z.string().nullable(),
  title: z.string().nullable(),
  canonical_url: z.string().nullable(),
  description: z.string().nullable(),
  publisher: z.string().nullable(),
  language: z.string().nullable(),
  published_at: z.string().nullable(),
  modified_at: z.string().nullable(),
  retrieved_at: z.string(),
  word_count: z.number().int().nonnegative().nullable(),
  content_hash_sha256: z.string().nullable(),
  evidence: z.array(EvidenceItemSchema),
  structured_data: StructuredDataSchema,
  warnings: z.array(SourceWarningSchema),
  /** True when this source was served from cache rather than freshly fetched. */
  from_cache: z.boolean(),
  /** Full redirect chain, first URL first. Empty when there were no redirects. */
  redirect_chain: z.array(z.string()),
});
export type Source = z.infer<typeof SourceSchema>;

/** Top-level assessment. `basis` must cite the evidence it rests on. */
export const AssessmentSchema = z.object({
  status: AssessmentStatusSchema,
  basis: z.string(),
});
export type Assessment = z.infer<typeof AssessmentSchema>;

/** The primary response document. */
export const EvidenceResponseSchema = z.object({
  request_id: z.string().min(1),
  version: z.literal(SCHEMA_VERSION),
  question: z.string(),
  assessment: AssessmentSchema,
  sources: z.array(SourceSchema),
  limitations: z.array(z.string()),
  processing_ms: z.number().int().nonnegative(),
});
export type EvidenceResponse = z.infer<typeof EvidenceResponseSchema>;

/**
 * Health response.
 *
 * Deliberately minimal: no secrets, no versions of internal dependencies, and
 * no infrastructure detail (SPEC section 4A).
 */
export const HealthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  service: z.literal(SERVICE_NAME),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/**
 * Effective resource limits. Every one is environment-driven; these are the
 * defaults used when a variable is unset.
 */
export const ResourceLimitsSchema = z.object({
  maxConcurrentFetches: z.number().int().positive(),
  maxUrlsPerRequest: z.number().int().positive(),
  maxResponseBytes: z.number().int().positive(),
  maxRedirects: z.number().int().nonnegative(),
  requestTimeoutMs: z.number().int().positive(),
  connectTimeoutMs: z.number().int().positive(),
  cacheTtlSeconds: z.number().int().nonnegative(),
  maxEvidenceItems: z.number().int().positive(),
  maxExcerptChars: z.number().int().positive(),
});
export type ResourceLimits = z.infer<typeof ResourceLimitsSchema>;

export const DEFAULT_LIMITS: ResourceLimits = {
  maxConcurrentFetches: 4,
  maxUrlsPerRequest: 5,
  maxResponseBytes: 2 * 1024 * 1024,
  maxRedirects: 5,
  requestTimeoutMs: 10_000,
  connectTimeoutMs: 5_000,
  cacheTtlSeconds: 86_400,
  maxEvidenceItems: 5,
  maxExcerptChars: 600,
};
