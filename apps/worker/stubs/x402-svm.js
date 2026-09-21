/**
 * Stub for the optional Solana schemes of the CDP SDK.
 *
 * `@coinbase/cdp-sdk/x402` imports `@x402/svm/*` for its Solana payment schemes,
 * but declares that package as an OPTIONAL peer dependency. We import exactly one
 * thing from the CDP SDK - `createCdpFacilitatorClient`, to settle through the CDP
 * Facilitator and reach the CDP Bazaar - and that module contains ZERO references
 * to Solana. The SVM schemes are instantiated only inside `getCdpDefaultSchemes()`,
 * which this service never calls, and our settlement is Base-only.
 *
 * Without this alias the Worker bundle fails to build with six unresolved imports,
 * which blocks EVERY deployment, CDP-related or not.
 *
 * DO NOT call `getCdpDefaultSchemes()` while this stub is aliased in: the schemes
 * it returns would be empty classes rather than real ones. If Solana support is
 * ever wanted, install `@x402/svm` and remove the alias from wrangler.jsonc.
 */
export class ExactSvmScheme {}
export class ExactSvmSchemeV1 {}
export class UptoSvmScheme {}
