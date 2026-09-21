/**
 * x402 price rendering.
 *
 * This lives in the shared contract rather than inside the Worker because it is
 * part of the wire format — it is the string that appears in a 402 challenge —
 * and because it needed a test that a Worker module could not have. See the note
 * on `priceString` for the bug that made that necessary.
 */

/**
 * Convert a configured USD price into the x402 price string: "0.003" -> "$0.003".
 *
 * DECIMALS ARE PRESERVED, NEVER ROUNDED TO TWO PLACES. An earlier implementation
 * ended in `n.toFixed(2)`, which turned a perfectly valid $0.003 into "$0.00".
 * The paywall then requested ZERO USDC from every buyer, and CDP's validator
 * rejected the endpoint for falling under its $0.001 minimum.
 *
 * It survived because $0.03 is the one sub-dollar price that two-decimal rounding
 * renders correctly, and $0.03 was the only price this service had ever used. The
 * defect appeared the moment the price moved to a realistic sub-cent value. Sub-cent
 * pricing is ordinary in x402 — Exa Contents charges $0.002 — so this must round-trip
 * whatever the operator configures.
 *
 * An unusable price THROWS rather than falling back. The old fallback was a
 * hard-coded "$0.03": a stale duplicate of a config value, and a silent
 * substitution inside a payment path, where a typo would charge a price nobody
 * chose. A paid service that cannot determine its price must refuse to serve.
 */
/** USDC has 6 decimals. */
const ATOMIC_UNITS_PER_USD = 1_000_000;

/** Parse and validate a configured price, or throw. */
function parsePrice(usd: string): number {
  const raw = (usd ?? "").trim().replace(/^\$/, "");
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `invalid price ${JSON.stringify(usd)}: must be a positive number. ` +
        "Refusing to serve rather than charge zero.",
    );
  }
  return n;
}

/**
 * The price in atomic USDC units, as the integer a 402 `accepts.amount` carries:
 * "0.003" -> "3000".
 *
 * This exists so the manifest and the payment challenge cannot disagree. They used
 * to be computed by two separate pieces of code — `acceptsEntry()` did its own
 * `Math.round(priceUsd * 1e6)` while the middleware was handed `priceString()` —
 * and when `priceString` rounded $0.003 to "$0.00" the manifest reported 3000 while
 * the live challenge requested 0. One source, one answer.
 */
export function priceAtomicUnits(usd: string): string {
  return String(Math.round(parsePrice(usd) * ATOMIC_UNITS_PER_USD));
}

/**
 * The price as the x402 dollar string a 402 challenge carries: "0.003" -> "$0.003".
 *
 * Derived from the same atomic units as the manifest, and rendered shortest-exact
 * so that parsing it back yields exactly those units.
 */
export function priceString(usd: string): string {
  const n = Number(priceAtomicUnits(usd)) / ATOMIC_UNITS_PER_USD;
  return `$${n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}
