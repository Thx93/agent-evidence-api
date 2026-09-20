/**
 * @aee/schemas — the shared wire contract.
 *
 * Everything that crosses a process boundary (HTTP request/response bodies,
 * MCP tool inputs, Worker↔backend payloads) is defined here and validated with
 * zod. Changing a schema is a contract change: update the tests and
 * `docs/api.md` in the same commit (see AGENTS.md section 10).
 */
export * from "./errors.js";
export * from "./evidence.js";
