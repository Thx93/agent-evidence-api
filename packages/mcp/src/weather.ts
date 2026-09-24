/**
 * The weather MCP server — `get-alerts` and `get-forecast`, paid per call.
 *
 * A second, separately listable service alongside the evidence tools, reachable at
 * `POST /weather/mcp`. It exists so the weather capability can be sold and
 * catalogued as its own MCP (`io.github.Thx93/weather`) rather than as a tool
 * bolted onto the evidence server: a registry entry should name a server whose
 * tool list matches it.
 *
 * The data is the US National Weather Service API — free, keyless and US-only.
 * What is sold here is the interface: a bounded, normalised, error-documented
 * tool surface with per-call settlement, not the weather itself.
 *
 * A standalone stdio implementation of the same tools lives in the
 * `mcp-weather-server` repository. The two deliberately do not share a package:
 * they sit on different MCP SDKs, and coupling two repositories across an npm
 * boundary is a worse trade than keeping one ~80-line data layer in each.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { SERVICE_NAME, type HealthResponse } from "@aee/schemas";
import type { Logger } from "@aee/core";

import { FREE_TOOL_NAME } from "./tools.js";

// ---------------------------------------------------------------------------
// NWS access
// ---------------------------------------------------------------------------

export const NWS_API_BASE = "https://api.weather.gov";
export const NWS_USER_AGENT = "AgentEvidenceAPI/0.1.5 (+https://github.com/Thx93/agent-evidence-api)";

/**
 * How long to wait for the NWS before giving up.
 *
 * This fetch is the only I/O a tool call performs, and without a deadline a
 * stalled NWS hangs a call the buyer has already paid for.
 */
const NWS_TIMEOUT_MS = 10_000;

/** Make one request to the NWS API. Returns `null` for any failure. */
export async function makeNWSRequest<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": NWS_USER_AGENT, Accept: "application/geo+json" },
      signal: AbortSignal.timeout(NWS_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return (await response.json()) as T;
  } catch {
    // The caller turns this into an isError tool result naming the cause. The
    // raw error is deliberately not sent to the client: it can name internals.
    return null;
  }
}

interface AlertFeature {
  properties: {
    event?: string;
    areaDesc?: string;
    severity?: string;
    description?: string;
    instruction?: string;
  };
}

interface ForecastPeriod {
  name?: string;
  temperature?: number;
  temperatureUnit?: string;
  windSpeed?: string;
  windDirection?: string;
  detailedForecast?: string;
}

interface AlertsResponse {
  features: AlertFeature[];
}

interface PointsResponse {
  properties: { forecast?: string };
}

interface ForecastResponse {
  properties: { periods: ForecastPeriod[] };
}

/**
 * `get-alerts` output: a top-level array, which protocol revision 2026-07-28 is
 * the first to allow. The SDK projects it onto `{ result: [...] }` for
 * `2025-11-25` clients.
 */
export const alertsOutputSchema = z.array(
  z.object({
    event: z.string().describe("The kind of weather event"),
    area: z.string().describe("The area the alert covers"),
    severity: z.string().describe("How severe the event is"),
    description: z.string().describe("What is happening"),
    instructions: z.string().describe("What people in the area should do"),
  }),
);

export const forecastOutputSchema = z.object({
  latitude: z.number().describe("Latitude the forecast is for"),
  longitude: z.number().describe("Longitude the forecast is for"),
  periods: z
    .array(
      z.object({
        name: z.string(),
        temperature: z.number().nullable(),
        temperature_unit: z.string(),
        wind_speed: z.string(),
        wind_direction: z.string(),
        detailed_forecast: z.string(),
      }),
    )
    .describe("The forecast periods, soonest first"),
});

export type Alert = z.infer<typeof alertsOutputSchema>[number];
export type Forecast = z.infer<typeof forecastOutputSchema>;

export function formatAlert(alert: Alert): string {
  return [
    `Event: ${alert.event}`,
    `Area: ${alert.area}`,
    `Severity: ${alert.severity}`,
    `Description: ${alert.description}`,
    `Instructions: ${alert.instructions}`,
    "---",
  ].join("\n");
}

export function formatPeriod(period: Forecast["periods"][number]): string {
  return [
    `${period.name}:`,
    period.temperature === null
      ? "Temperature: Unknown"
      : `Temperature: ${period.temperature}°${period.temperature_unit}`,
    `Wind: ${period.wind_speed} ${period.wind_direction}`,
    period.detailed_forecast,
    "---",
  ].join("\n");
}

/** Both tools only read the NWS. Hosts use these to decide whether to prompt. */
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const ALERTS_TOOL: Tool = {
  name: "get-alerts",
  description:
    "Get active weather alerts for a US state. Give the two-letter state code (for " +
    "example CA or NY) and get every active National Weather Service alert for it: " +
    "the event type, the area it covers, its severity, what is happening, and the " +
    "official instruction. US locations only. Free tool: " +
    FREE_TOOL_NAME +
    " and tools/list.",
  inputSchema: {
    type: "object",
    properties: {
      state: {
        type: "string",
        minLength: 2,
        maxLength: 2,
        description: "Two-letter US state code (e.g. CA, NY)",
      },
    },
    required: ["state"],
    additionalProperties: false,
  },
  // A top-level ARRAY, which protocol revision 2026-07-28 is the first to allow.
  // The double cast is deliberate and is the one place this repository narrows
  // the SDK's types: `Tool["outputSchema"]` is still declared `{ type: "object" }`,
  // the pre-2026-07-28 rule. The runtime passes this shape through, and the suite
  // asserts the array survives the wire. The standalone stdio server in the
  // `mcp-weather-server` repository returns the same shape for the same tool.
  outputSchema: {
    type: "array",
    items: {
      type: "object",
      properties: {
        event: { type: "string" },
        area: { type: "string" },
        severity: { type: "string" },
        description: { type: "string" },
        instructions: { type: "string" },
      },
      required: ["event", "area", "severity", "description", "instructions"],
      additionalProperties: false,
    },
  } as unknown as Tool["outputSchema"],
  annotations: { ...READ_ONLY_ANNOTATIONS, title: "Get Weather Alerts" },
};

const FORECAST_TOOL: Tool = {
  name: "get-forecast",
  description:
    "Get the weather forecast for a point on the map. Give latitude and longitude and " +
    "get the next five forecast periods for it: the period name, its temperature, " +
    "wind speed and direction, and the plain-language forecast. US locations only. " +
    "Free tool: " +
    FREE_TOOL_NAME +
    " and tools/list.",
  inputSchema: {
    type: "object",
    properties: {
      latitude: {
        type: "number",
        minimum: -90,
        maximum: 90,
        description: "Latitude of the location",
      },
      longitude: {
        type: "number",
        minimum: -180,
        maximum: 180,
        description: "Longitude of the location",
      },
    },
    required: ["latitude", "longitude"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      latitude: { type: "number" },
      longitude: { type: "number" },
      periods: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            temperature: { type: ["number", "null"] },
            temperature_unit: { type: "string" },
            wind_speed: { type: "string" },
            wind_direction: { type: "string" },
            detailed_forecast: { type: "string" },
          },
          required: [
            "name",
            "temperature",
            "temperature_unit",
            "wind_speed",
            "wind_direction",
            "detailed_forecast",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["latitude", "longitude", "periods"],
    additionalProperties: false,
  },
  annotations: { ...READ_ONLY_ANNOTATIONS, title: "Get Weather Forecast" },
};

/** The free liveness tool, so an agent can check a route before paying for it. */
const HEALTH_TOOL: Tool = {
  name: FREE_TOOL_NAME,
  description: "Check that the service is up. Costs nothing.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { ...READ_ONLY_ANNOTATIONS, title: "Health" },
};

const TOOLS: Tool[] = [ALERTS_TOOL, FORECAST_TOOL, HEALTH_TOOL];

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * A tool failure is an `isError` result, per the MCP spec — a well-formed call
 * whose work failed — rather than a JSON-RPC error, which means the call itself
 * was broken. A caller can show this text and retry.
 */
/**
 * What every tool call returns.
 *
 * One shape rather than a union, so a caller reads `isError` and
 * `structuredContent` without narrowing first. The two are exclusive at runtime —
 * `structuredContent` on success, `isError` on failure — but both are reachable
 * from the same type.
 */
export interface ToolOutcome<T = unknown> {
  content: Array<{ type: "text"; text: string }>;
  /** Present on success only. */
  structuredContent?: T;
  /** Present on failure only. */
  isError?: true;
}

function toolError<T>(message: string): ToolOutcome<T> {
  return { content: [{ type: "text", text: message }], isError: true };
}

function toolOk<T>(text: string, structuredContent: T): ToolOutcome<T> {
  return { content: [{ type: "text", text }], structuredContent };
}

const alertsInput = z.object({ state: z.string().length(2) });
const forecastInput = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

/** Exported for tests: the tool body, with the NWS behind `fetch`. */
export async function runAlerts(state: string): Promise<ToolOutcome<Alert[]>> {
  try {
    const stateCode = state.toUpperCase();
    const data = await makeNWSRequest<AlertsResponse>(
      `${NWS_API_BASE}/alerts/active/area/${stateCode}`,
    );
    if (!data) return toolError(`Failed to retrieve alerts data for ${stateCode}`);

    // An empty result is an empty array, not an error. `??` catches the nulls the
    // NWS sends for missing fields, so a key-missing default never fires.
    const alerts: Alert[] = (data.features ?? []).map((feature) => ({
      event: feature.properties.event ?? "Unknown",
      area: feature.properties.areaDesc ?? "Unknown",
      severity: feature.properties.severity ?? "Unknown",
      description: feature.properties.description ?? "No description available",
      instructions: feature.properties.instruction ?? "No specific instructions provided",
    }));

    const text =
      alerts.length === 0
        ? `No active alerts for ${stateCode}`
        : `Active alerts for ${stateCode}:\n\n${alerts.map(formatAlert).join("\n")}`;
    return toolOk(text, alerts);
  } catch (error) {
    return toolError(
      `Failed to retrieve alerts: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Exported for tests: the tool body, with the NWS behind `fetch`. */
export async function runForecast(
  latitude: number,
  longitude: number,
): Promise<ToolOutcome<Forecast>> {
  try {
    // The NWS works from a grid point, so a coordinate becomes one hop.
    const points = await makeNWSRequest<PointsResponse>(
      `${NWS_API_BASE}/points/${latitude.toFixed(4)},${longitude.toFixed(4)}`,
    );
    if (!points) {
      return toolError(
        `Failed to retrieve grid point data for coordinates: ${latitude}, ${longitude}. ` +
          "This location may not be supported by the NWS API (only US locations are supported).",
      );
    }
    const forecastUrl = points.properties?.forecast;
    if (!forecastUrl) return toolError("Failed to get forecast URL from grid point data");

    const forecastData = await makeNWSRequest<ForecastResponse>(forecastUrl);
    if (!forecastData) return toolError("Failed to retrieve forecast data");

    const raw = forecastData.properties?.periods ?? [];
    if (raw.length === 0) return toolError("No forecast periods available");

    const forecast: Forecast = {
      latitude,
      longitude,
      // Five periods is enough to answer "what is the weather like" and short
      // enough not to dominate a context window.
      periods: raw.slice(0, 5).map((period) => ({
        name: period.name ?? "Unknown",
        temperature: period.temperature ?? null,
        temperature_unit: period.temperatureUnit ?? "F",
        wind_speed: period.windSpeed ?? "Unknown",
        wind_direction: period.windDirection ?? "Unknown",
        detailed_forecast: period.detailedForecast ?? "No forecast available",
      })),
    };

    const text = `Forecast for ${latitude}, ${longitude}:\n\n${forecast.periods
      .map(formatPeriod)
      .join("\n")}`;
    return toolOk(text, forecast);
  } catch (error) {
    return toolError(
      `Failed to retrieve forecast: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export interface WeatherMcpServer {
  handleNodeRequest(req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void>;
  listTools(): Tool[];
  close(): Promise<void>;
}

export interface WeatherMcpServerOptions {
  logger: Logger;
  serviceVersion: string;
}

const SERVER_INSTRUCTIONS =
  "Paid per call in USDC on Base. Free tools: " +
  FREE_TOOL_NAME +
  " and tools/list. " +
  "Data is the US National Weather Service, so only US locations are supported.";

export function createWeatherMcpServer(opts: WeatherMcpServerOptions): WeatherMcpServer {
  /** In-flight (server, transport) pairs; released when a response closes. */
  const active = new Set<{ server: Server; transport: StreamableHTTPServerTransport }>();

  function buildProtocolServer(): Server {
    const server = new Server(
      { name: SERVICE_NAME, version: opts.serviceVersion },
      { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
    );

    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

    server.setRequestHandler(CallToolRequestSchema, (request) =>
      // One documented cast, matching the one on `outputSchema` above: the SDK
      // types `CallToolResult.structuredContent` as an object, while `get-alerts`
      // returns a top-level array — the shape protocol revision 2026-07-28 allows
      // and the standalone stdio server in `mcp-weather-server` returns for the
      // same tool. `ToolOutcome` itself stays strictly typed for the tests.
      invokeTool(request.params.name, request.params.arguments) as unknown as Promise<CallToolResult>,
    );

    return server;
  }

  async function invokeTool(name: string, rawArgs: unknown) {
    if (name === FREE_TOOL_NAME) {
      const health: HealthResponse = {
        status: "ok",
        service: SERVICE_NAME,
        version: opts.serviceVersion,
      };
      return toolOk(JSON.stringify(health), health);
    }
    if (name === "get-alerts") {
      const parsed = alertsInput.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        return toolError(
          `Invalid arguments for ${name}: state must be a two-letter US state code.`,
        );
      }
      return runAlerts(parsed.data.state);
    }
    if (name === "get-forecast") {
      const parsed = forecastInput.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        return toolError(
          `Invalid arguments for ${name}: latitude must be between -90 and 90 and ` +
            "longitude between -180 and 180.",
        );
      }
      return runForecast(parsed.data.latitude, parsed.data.longitude);
    }
    return toolError(`Unknown tool: ${name}`);
  }

  async function handleNodeRequest(
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody?: unknown,
  ): Promise<void> {
    // Stateless mode: a fresh transport per request, matching the evidence
    // server. One JSON body rather than an SSE stream.
    const server = buildProtocolServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    const entry = { server, transport };
    active.add(entry);

    const release = (): void => {
      if (!active.delete(entry)) return;
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    };
    res.once("close", release);

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (err) {
      release();
      opts.logger.error("weather mcp request failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      if (!res.writableEnded) {
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
        );
      }
    }
  }

  return {
    handleNodeRequest,
    listTools: () => TOOLS.map((tool) => ({ ...tool })),
    close: async () => {
      const entries = [...active];
      active.clear();
      await Promise.all(
        entries.flatMap(({ server, transport }) => [
          transport.close().catch(() => undefined),
          server.close().catch(() => undefined),
        ]),
      );
    },
  };
}
