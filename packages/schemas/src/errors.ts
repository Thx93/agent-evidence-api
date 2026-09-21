import { z } from "zod";

/**
 * Stable, machine-readable error codes (SPEC section 22).
 *
 * These are part of the public contract: clients switch on `error.code`, so
 * codes must never be renamed or repurposed without a version bump.
 */
export const ERROR_CODES = [
  /** Request body failed schema validation. */
  "INVALID_REQUEST",
  /** URL is syntactically invalid or uses an unsupported scheme. */
  "INVALID_URL",
  /** URL resolved to a disallowed destination (private, loopback, etc.). */
  "BLOCKED_URL",
  /** Request looks like a deliberate SSRF attempt. */
  "SSRF_ATTEMPT",
  /** Fetch exceeded the total request or connect timeout. */
  "TIMEOUT",
  /** Redirect chain exceeded MAX_REDIRECTS. */
  "REDIRECT_LIMIT",
  /** Content type is not one this service processes. */
  "UNSUPPORTED_CONTENT",
  /** Response body exceeded MAX_RESPONSE_BYTES. */
  "RESPONSE_TOO_LARGE",
  /** Upstream returned a 4xx/5xx status. */
  "UPSTREAM_HTTP_FAILURE",
  "NO_SOURCES_RETRIEVED",
  /** Fetch succeeded but extraction failed. */
  "EXTRACTION_FAILURE",
  /** Payment is required to access this resource (HTTP 402). */
  "PAYMENT_REQUIRED",
  /** Supplied payment proof failed verification. */
  "PAYMENT_INVALID",
  /** Supplied payment proof has expired. */
  "PAYMENT_EXPIRED",
  /** Caller exceeded the allowed request rate. */
  "RATE_LIMIT",
  /** Internal failure. Stack traces are never exposed. */
  "INTERNAL_ERROR",
  /** No such endpoint. Both the Worker and the backend answer 404. */
  "NOT_FOUND",
  /** Missing or incorrect server-to-server credential (backend only). */
  "UNAUTHORIZED",
  /** The backend origin could not be reached by the Worker. */
  "BACKEND_UNREACHABLE",
  /** A required dependency (origin URL, secret) is not configured. */
  "NOT_CONFIGURED",
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** HTTP status conventionally paired with each error code. */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_REQUEST: 400,
  INVALID_URL: 400,
  BLOCKED_URL: 400,
  SSRF_ATTEMPT: 400,
  TIMEOUT: 504,
  REDIRECT_LIMIT: 502,
  UNSUPPORTED_CONTENT: 415,
  RESPONSE_TOO_LARGE: 502,
  UPSTREAM_HTTP_FAILURE: 502,
  NO_SOURCES_RETRIEVED: 502,
  EXTRACTION_FAILURE: 500,
  PAYMENT_REQUIRED: 402,
  PAYMENT_INVALID: 402,
  PAYMENT_EXPIRED: 402,
  RATE_LIMIT: 429,
  INTERNAL_ERROR: 500,
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  BACKEND_UNREACHABLE: 502,
  NOT_CONFIGURED: 503,
};

/**
 * Canonical error envelope. Every non-2xx JSON response from either the Worker
 * or the backend uses exactly this shape.
 *
 * `message` is safe to show to a caller: it must never contain a stack trace,
 * a secret, or internal infrastructure detail.
 */
export const ErrorResponseSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string().min(1),
    request_id: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/** Human-readable default messages. Never leak internal detail. */
export const DEFAULT_ERROR_MESSAGES: Record<ErrorCode, string> = {
  INVALID_REQUEST: "The request body is invalid or missing required fields.",
  INVALID_URL: "The supplied URL is invalid or unsupported.",
  BLOCKED_URL: "The supplied URL resolves to a destination that is not allowed.",
  SSRF_ATTEMPT: "The supplied URL is not permitted.",
  TIMEOUT: "The source did not respond within the allowed time.",
  REDIRECT_LIMIT: "The source exceeded the maximum number of redirects.",
  UNSUPPORTED_CONTENT: "The source returned a content type that is not supported.",
  RESPONSE_TOO_LARGE: "The source response exceeded the maximum allowed size.",
  UPSTREAM_HTTP_FAILURE: "The source returned an error status.",
  NO_SOURCES_RETRIEVED:
    "None of the requested sources could be retrieved, so no evidence was produced and no payment was taken.",
  EXTRACTION_FAILURE: "The source could not be processed.",
  PAYMENT_REQUIRED: "Payment is required to access this resource.",
  PAYMENT_INVALID: "The supplied payment could not be verified.",
  PAYMENT_EXPIRED: "The supplied payment has expired.",
  RATE_LIMIT: "Too many requests. Please retry shortly.",
  INTERNAL_ERROR: "An internal error occurred.",
  NOT_FOUND: "No such endpoint.",
  UNAUTHORIZED: "Authentication is required.",
  BACKEND_UNREACHABLE: "The evidence service is temporarily unavailable.",
  NOT_CONFIGURED: "The service is not fully configured.",
};

/** Build a conforming error envelope with the canonical message default. */
export function errorResponse(
  code: ErrorCode,
  requestId: string,
  message?: string,
  details?: Record<string, unknown>,
): ErrorResponse {
  return {
    error: {
      code,
      message: message ?? DEFAULT_ERROR_MESSAGES[code],
      request_id: requestId,
      ...(details ? { details } : {}),
    },
  };
}
