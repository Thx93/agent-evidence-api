/**
 * The names that decide the free/paid boundary, and the shape of a tool as
 * advertised to clients.
 *
 * Deliberately its own module. Both MCP servers in this package name these tools
 * in their descriptions and in their discovery metadata, and re-importing them
 * from `index.js` would make `index.js` and `weather.js` a circular pair that reads
 * a `const` during module initialisation — which is a temporal-dead-zone error,
 * not a slow import.
 *
 * A `tools/call` for a name not in `PAID_TOOL_NAME`'s set is free, and everything
 * outside the documented free surface is paid. See `apps/backend/src/mcp-paywall.ts`.
 */

/** One MCP tool as advertised to clients and asserted by tests. */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown; // JSON Schema object
}

/** The exact tool names, exported so tests and docs cannot drift. */
export const PAID_TOOL_NAME = "research_evidence";
export const FREE_TOOL_NAME = "health";

/**
 * The tools each MCP route charges for.
 *
 * Per route rather than global: `/mcp` charges for `research_evidence`,
 * `/weather/mcp` for `get-alerts` and `get-forecast`. A `tools/call` is paid
 * exactly when its name is in the set for its route, so a tool a route does not
 * publish can never be charged for and `health` is always free.
 */
export const EVIDENCE_PAID_TOOLS: ReadonlySet<string> = new Set([PAID_TOOL_NAME]);
export const WEATHER_PAID_TOOLS: ReadonlySet<string> = new Set(["get-alerts", "get-forecast"]);
