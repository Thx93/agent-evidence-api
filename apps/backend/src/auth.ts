import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Server-to-server authentication for the internal backend API.
 *
 * The Worker is the only legitimate caller. Requests arriving without a valid
 * shared secret are refused, so a customer cannot bypass the payment layer by
 * addressing the origin directly (SPEC section 15).
 *
 * The secret is compared by hashing both sides first: `timingSafeEqual` throws
 * on differing lengths, and a raw length check would leak the secret's length.
 * Fixed-width digests avoid both problems.
 */

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time comparison of a supplied credential against the expected secret. */
export function secretMatches(provided: string | undefined, expected: string): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;
  if (typeof expected !== "string" || expected.length === 0) return false;
  return timingSafeEqual(digest(provided), digest(expected));
}

/** Pull a credential from `X-Backend-Auth` or `Authorization: Bearer …`. */
export function extractCredential(headers: Record<string, unknown>): string | undefined {
  const direct = headers["x-backend-auth"];
  if (typeof direct === "string" && direct.length > 0) return direct;

  const auth = headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length);
  }
  return undefined;
}

/**
 * Paths that are reachable without a credential.
 *
 * Kept deliberately tiny: liveness only. Everything else — including the MCP
 * endpoint — requires the shared secret, because it is the Worker that owns
 * payment enforcement.
 */
export const PUBLIC_PATHS = new Set([
  "/health",
  // The buyer CLI is meant to be downloaded by anyone; it contains no secrets
  // (it reads the payer's own key from their environment).
  "/buy.mjs",
]);

export function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.has(path);
}
