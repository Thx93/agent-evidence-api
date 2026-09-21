/**
 * @aee/core — the application service layer.
 *
 * Both the HTTP adapter (apps/backend) and the MCP adapter (packages/mcp) call
 * `EvidenceService` from here. Business logic must never be duplicated between
 * those adapters (AGENTS.md section 3, SPEC section 39).
 *
 * x402 lives at the payment boundary in the Worker, never in this package.
 */
export * from "./config.js";
export * from "./logger.js";
export * from "./assessment.js";
export * from "./robots.js";
export * from "./reasoning.js";
export * from "./providers.js";
export * from "./service.js";
