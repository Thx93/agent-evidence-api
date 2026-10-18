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
  /** Human-readable name a host shows instead of the machine name. */
  title?: string;
  /**
   * MCP tool annotations.
   *
   * Hosts use these to decide whether to prompt before invoking, and trust
   * directories score on them. Leaving them off is not neutral: a tool that only
   * reads but declares nothing looks potentially destructive, which is why the
   * weather tools have declared theirs since they were written.
   */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/** The exact tool names, exported so tests and docs cannot drift. */
export const PAID_TOOL_NAME = "research_evidence";
export const FREE_TOOL_NAME = "health";

/**
 * The free sample tool. Not in any paid set, so `tools/call` for it costs nothing -
 * that boundary is declared once, here, rather than inferred at the call site.
 */
export const SAMPLE_TOOL_NAME = "sample";

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
