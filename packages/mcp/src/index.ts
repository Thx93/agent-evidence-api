/**
 * @aee/mcp — the remote MCP adapter for Agent Evidence API.
 *
 * Transport (SPEC section 10): **Streamable HTTP**, run in **stateless** mode.
 *
 * Why stateless: the backend VPS sits behind a load balancer / Cloudflare edge,
 * so a request may land on a different process than the one that handled
 * `initialize`. There is therefore no session persistence and no per-session
 * memory (no session id, no event store, no resumability). The SDK requires a
 * *fresh* transport per HTTP request in this mode — reusing one raises
 * "Stateless transport cannot be reused across requests" — so
 * `handleNodeRequest` builds a throwaway `Server` + transport pair per request
 * and releases both when the response closes. `enableJsonResponse` keeps the
 * answer a single JSON body instead of an SSE stream, which is friendlier to
 * proxies and to the plain JSON-RPC clients that consume this endpoint.
 *
 * Layering (SPEC section 39, AGENTS.md section 3): this package is an adapter
 * only. Every paid call delegates to the *same* `EvidenceService` instance the
 * HTTP layer uses — this package never fetches, validates or assesses anything
 * itself.
 */
import { randomBytes } from "node:crypto";
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

import {
  EVIDENCE_MODES,
  HARD_CAPS,
  SERVICE_NAME,
  errorResponse,
  type HealthResponse,
} from "@aee/schemas";
import { ServiceError, type EvidenceService, type Logger } from "@aee/core";

import {
  FREE_TOOL_NAME,
  PAID_TOOL_NAME,
  PREVIEW_TOOL_NAME,
  SAMPLE_TOOL_NAME,
  type McpToolDefinition,
} from "./tools.js";
import { SAMPLE_EVIDENCE } from "./sample.js";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

// Re-exported so callers keep one import site. `McpToolDefinition` and the tool
// names live in `tools.js` rather than here because `weather.js` also needs them,
// and an import back into this module would be a cycle that reads a `const` during
// module initialisation.
export * from "./tools.js";

// The weather MCP server: a second, separately listable and separately payable
// service, mounted at `/weather/mcp`. It lives in its own module so this one
// stays about the evidence tools.
export {
  createWeatherMcpServer,
  formatAlert,
  formatPeriod,
  makeNWSRequest,
  NWS_API_BASE,
  NWS_USER_AGENT,
  runAlerts,
  runForecast,
  type WeatherMcpServer,
  type WeatherMcpServerOptions,
} from "./weather.js";

/**
 * What the server reports after each paid tool call.
 *
 * The MCP path never touches the durable usage log - that is written by the HTTP
 * route - so an MCP sale was invisible in the revenue record. This callback lets
 * the caller record it without the MCP package knowing anything about storage.
 *
 * `question` is passed through for the caller to hash; it must never be logged.
 */
export interface McpToolCallSummary {
  tool: string;
  outcome: "ok" | "error";
  requestId: string;
  question: string;
  sourcesRequested: number;
  sourcesRetrieved: number;
  evidenceItems: number;
  assessment: string;
  processingMs: number;
  errorCode?: string;
  /** The request carried a payment proof. Same rule as the HTTP route. */
  paymentProvided: boolean;
}

export interface EvidenceMcpServerOptions {
  service: EvidenceService;
  logger: Logger;
  serviceVersion: string;
  /** Called after a paid tool call. Never throws into the request path. */
  onToolCall?: (summary: McpToolCallSummary) => void | Promise<void>;
}

export interface EvidenceMcpServer {
  /** Handle one streamable-HTTP MCP request. */
  handleNodeRequest(req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void>;
  /** Tool definitions, exposed for discovery and for tests. */
  listTools(): McpToolDefinition[];
  /** Release any transport state. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Tool descriptions
//
// SPEC section 29 requires the paid description to contain the discovery
// phrases "web evidence", "source verification", "claim verification",
// "evidence extraction", "source-grounded research", "compare sources",
// "cited evidence" and "fresh web evidence" — truthfully, without keyword
// stuffing. Every sentence below describes behaviour this package actually has.
// ---------------------------------------------------------------------------

const PAID_TOOL_DESCRIPTION =
  "Fetch public web sources and return structured, cited web evidence for a question or claim. " +
  "Use this for source verification, claim verification, evidence extraction, and source-grounded research, or to compare sources. " +
  "Returns source URLs, retrieval timestamps, short evidence excerpts, publisher and document metadata, and an explicit supported/contradicted/mixed/inconclusive assessment. " +
  "Fresh web evidence is retrieved per request unless served from a bounded cache, and each source reports its actual retrieval time. " +
  "Every excerpt returned is cited evidence tied to its source URL. " +
  "No API key and no account: discovery is free, a call costs $0.01 in USDC on Base " +
  "via x402, and nothing is charged when no source is retrieved.";

const FREE_TOOL_DESCRIPTION =
  "Check that the Agent Evidence API MCP server is reachable and report which service version is running. " +
  "Free to call, takes no arguments or payment. " +
  "Returns only {status, service, version} and exposes no secrets or infrastructure detail.";

const SERVER_INSTRUCTIONS =
  "Agent Evidence API returns web evidence for AI agents. Call research_evidence with a question or claim " +
  "and the public source URLs to verify to receive structured, cited evidence with an explicit assessment. " +
  "Call health to check connectivity.";

// ---------------------------------------------------------------------------
// Tool input schemas (zod -> JSON Schema)
//
// These mirror the shared request contract in @aee/schemas so an MCP caller and
// an HTTP caller fail (or succeed) on the same shapes. They are *shape* checks
// only; EvidenceService re-validates and owns all policy decisions.
// ---------------------------------------------------------------------------

const PreviewEvidenceInput = z.object({
  question: z
    .string()
    .trim()
    .min(8)
    .max(HARD_CAPS.QUESTION_CHARS)
    .describe("The question or claim to gather web evidence for."),
  url: z
    .string()
    .url()
    .describe("One public source URL to retrieve and cite. The paid tool accepts up to five."),
});

const ResearchEvidenceInput = z.object({
  question: z
    .string()
    .trim()
    .min(1)
    .max(HARD_CAPS.QUESTION_CHARS)
    .describe("The question or claim to gather web evidence for."),
  urls: z
    .array(z.string())
    .max(HARD_CAPS.URLS)
    .optional()
    .describe(
      "Candidate public source URLs to retrieve and cite. Version 0.1.0 requires at least one such URL.",
    ),
  max_sources: z
    .number()
    .int()
    .positive()
    .max(HARD_CAPS.MAX_SOURCES)
    .optional()
    .describe("Cap on the number of sources processed."),
  language: z
    .string()
    .trim()
    .min(1)
    .max(35)
    .optional()
    .describe('Preferred evidence language: "auto" or a BCP-47 tag such as "en".'),
  mode: z
    .enum(EVIDENCE_MODES)
    .optional()
    .describe('Reserved input. Only "evidence" is supported in version 0.1.0.'),
});

/** `health` takes no arguments. */
const HealthInput = z.object({});

function buildToolDefinitions(): McpToolDefinition[] {
  return [
    {
      name: PAID_TOOL_NAME,
      title: "Research Evidence",
      description: PAID_TOOL_DESCRIPTION,
      inputSchema: z.toJSONSchema(ResearchEvidenceInput),
      // Read-only with respect to the caller's system: it fetches the pages the
      // caller names and returns what they say. It reaches the open web, and the
      // caller is charged per call, so it is not idempotent in the sense of being
      // free to repeat - but repeating it produces the same evidence, and the
      // result is cached, so `idempotentHint` is honest.
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    {
      // Free, and real: the sample tool proves what the output looks like, this one
      // answers the caller's actual question over one source. It costs us a fetch and
      // an extraction, so it is capped per day rather than unlimited.
      name: PREVIEW_TOOL_NAME,
      title: "Preview evidence (free)",
      description:
        "Free preview of the paid tool: give one question and one public URL and get " +
        "back up to three cited excerpts with the source URL, retrieval time and " +
        "content hash. No assessment and no verdict - that is what research_evidence " +
        "adds, over up to five sources. Capped per day. Use this to judge whether the " +
        "paid call is worth 0.01 USDC.",
      inputSchema: z.toJSONSchema(PreviewEvidenceInput),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    {
      // Free on purpose: it lets a caller judge the output before paying for one.
      name: SAMPLE_TOOL_NAME,
      title: "Sample evidence",
      description:
        "Return one real, previously produced evidence package, free, so you can " +
        "see exactly what a paid call returns before spending anything: a verdict, " +
        "and for every source the URL, retrieval time, content hash and the cited " +
        "excerpts. Takes no arguments and always returns the same package. The paid " +
        "tool is research_evidence, which answers your own question.",
      inputSchema: z.toJSONSchema(z.object({})),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: FREE_TOOL_NAME,
      title: "Health",
      description: FREE_TOOL_DESCRIPTION,
      inputSchema: z.toJSONSchema(HealthInput),
      // Purely local: it reports this process's own status and touches nothing
      // external, so `openWorldHint` is false. It is free, which is what makes it
      // usable as a liveness probe by a directory or a monitor.
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  ];
}

const TOOL_DEFINITIONS: readonly McpToolDefinition[] = Object.freeze(buildToolDefinitions());

/** Daily ceiling for the free preview tool, per process. */
const PREVIEW_PER_DAY = 200;
let previewDay = "";
let previewCount = 0;

/**
 * Fresh, independent copies so a caller cannot corrupt the shared definitions
 * by mutating (for example) a returned JSON Schema object.
 */
function listToolDefinitions(): McpToolDefinition[] {
  return TOOL_DEFINITIONS.map((tool) => structuredClone(tool));
}

/** Tools as the MCP wire types expect them. */
function wireTools(): Tool[] {
  return listToolDefinitions().map((tool) => ({
    name: tool.name,
    description: tool.description,
    // Produced by `z.toJSONSchema` from a Zod object schema, so this is always
    // a JSON Schema object with `type: "object"`.
    inputSchema: tool.inputSchema as Tool["inputSchema"],
    // Carried through so a host (and a directory that scores tool definitions)
    // sees the same title and annotations the definition declares.
    ...(tool.title ? { title: tool.title } : {}),
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Request ids, results and logging
// ---------------------------------------------------------------------------

/** `req_` + 24 hex characters, the same request-id shape the HTTP layer uses. */
function newRequestId(): string {
  return `req_${randomBytes(12).toString("hex")}`;
}

/** A successful tool result: the structured payload as JSON text, nothing else. */
function textResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/**
 * Report a paid tool call, swallowing any failure: the buyer has already paid, so
 * bookkeeping must never fail the request.
 */
async function reportToolCall(
  opts: EvidenceMcpServerOptions,
  summary: McpToolCallSummary,
): Promise<void> {
  if (!opts.onToolCall) return;
  try {
    await opts.onToolCall(summary);
  } catch (err) {
    opts.logger.warn("mcp usage report failed", { error: describeError(err) });
  }
}

/** A tool error result carrying the canonical error envelope (SPEC section 22). */
function errorResult(envelope: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(envelope) }], isError: true };
}

function describeError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

/**
 * Execute one `tools/call`.
 *
 * Emits exactly one structured log line per call. Tool arguments are never
 * logged — a URL supplied by a caller may be sensitive — so only the tool name,
 * request id, duration and counts are recorded.
 */
async function invokeTool(
  opts: EvidenceMcpServerOptions,
  name: string,
  rawArguments: Record<string, unknown> | undefined,
  paymentProvided: boolean,
): Promise<CallToolResult> {
  const requestId = newRequestId();
  const startedAt = Date.now();
  const fields: Record<string, unknown> = { tool: name, request_id: requestId };

  let result: CallToolResult;

  if (name === PREVIEW_TOOL_NAME) {
    const day = new Date().toISOString().slice(0, 10);
    if (previewDay !== day) {
      previewDay = day;
      previewCount = 0;
    }
    const parsed = PreviewEvidenceInput.safeParse(rawArguments ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => ({
        path: issue.path.map((segment) => String(segment)).join("."),
        message: issue.message,
      }));
      result = errorResult(
        errorResponse("INVALID_REQUEST", requestId, "The tool arguments are invalid.", { issues }),
      );
      fields["outcome"] = "invalid_request";
      fields["error_code"] = "INVALID_REQUEST";
    } else if (previewCount >= PREVIEW_PER_DAY) {
      result = errorResult(
        errorResponse(
          "PREVIEW_LIMIT",
          requestId,
          "The free preview has reached its daily limit. The paid tool, research_evidence, costs 0.01 USDC per call and needs no account.",
        ),
      );
      fields["outcome"] = "preview_limit";
      fields["error_code"] = "PREVIEW_LIMIT";
    } else {
      previewCount += 1;
      try {
        const response = await opts.service.execute(
          { question: parsed.data.question, urls: [parsed.data.url] },
          requestId,
        );
        const source = response.sources[0];
        result = textResult({
          preview: true,
          question: parsed.data.question,
          source: {
            requested_url: source?.requested_url ?? parsed.data.url,
            final_url: source?.final_url ?? null,
            status: source?.status ?? null,
            retrieved_at: source?.retrieved_at ?? null,
            content_hash_sha256: source?.content_hash_sha256 ?? null,
          },
          excerpts: (source?.evidence ?? []).slice(0, 3).map((item) => ({
            excerpt: item.excerpt,
            relevance: item.relevance,
            ...(item.context ? { context: item.context } : {}),
          })),
          excerpt_count_total: source?.evidence?.length ?? 0,
          note:
            "Preview: one source, three excerpts, no assessment. research_evidence takes up to five sources and returns the supported/contradicted/mixed/inconclusive verdict.",
        });
        await reportToolCall(opts, {
          tool: name,
          outcome: "ok",
          requestId,
          question: parsed.data.question,
          sourcesRequested: 1,
          sourcesRetrieved: response.sources.filter((s) => s.status === 200).length,
          evidenceItems: source?.evidence?.length ?? 0,
          assessment: "n/a",
          processingMs: Date.now() - startedAt,
          paymentProvided: false,
        });
        fields["outcome"] = "ok";
      } catch (err) {
        result = errorResult(
          errorResponse(
            "UPSTREAM_HTTP_FAILURE",
            requestId,
            err instanceof Error ? err.message : "The source could not be retrieved.",
          ),
        );
        fields["outcome"] = "service_error";
      }
    }
  } else if (name === SAMPLE_TOOL_NAME) {
    // Free, and deliberately free: this is the proof of output quality. It costs
    // nothing to serve because it was produced once by a real paid call.
    result = textResult(SAMPLE_EVIDENCE);
    fields["outcome"] = "ok";
  } else if (name === FREE_TOOL_NAME) {
    const health: HealthResponse = {
      status: "ok",
      service: SERVICE_NAME,
      version: opts.serviceVersion,
    };
    result = textResult(health);
    fields["outcome"] = "ok";
  } else if (name === PAID_TOOL_NAME) {
    const parsed = ResearchEvidenceInput.safeParse(rawArguments ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => ({
        path: issue.path.map((segment) => String(segment)).join("."),
        message: issue.message,
      }));
      result = errorResult(
        errorResponse("INVALID_REQUEST", requestId, "The tool arguments are invalid.", { issues }),
      );
      fields["outcome"] = "invalid_request";
      fields["error_code"] = "INVALID_REQUEST";
      fields["issue_count"] = issues.length;
    } else {
      try {
        // The single business-logic entry point. No fetching, validation or
        // assessment happens in this package (SPEC section 39).
        const response = await opts.service.execute(parsed.data, requestId);
        result = textResult(response);
        await reportToolCall(opts, {
          tool: name,
          outcome: "ok",
          requestId,
          question: parsed.data.question,
          sourcesRequested: parsed.data.urls?.length ?? 0,
          sourcesRetrieved: response.sources.filter((s) => s.status === 200).length,
          evidenceItems: response.sources.reduce((n, s) => n + s.evidence.length, 0),
          assessment: response.assessment.status,
          processingMs: response.processing_ms,
          paymentProvided,
        });
        fields["outcome"] = "ok";
        fields["assessment"] = response.assessment.status;
        fields["sources"] = response.sources.length;
        fields["url_count"] = parsed.data.urls?.length ?? 0;
      } catch (err) {
        if (err instanceof ServiceError) {
          const message = err.message.length > 0 ? err.message : undefined;
          result = errorResult(errorResponse(err.code, requestId, message, err.details));
          await reportToolCall(opts, {
            tool: name,
            outcome: "error",
            requestId,
            question: parsed.data.question,
            sourcesRequested: parsed.data.urls?.length ?? 0,
            sourcesRetrieved: 0,
            evidenceItems: 0,
            assessment: "n/a",
            processingMs: Date.now() - startedAt,
            errorCode: err.code,
            paymentProvided,
          });
          fields["outcome"] = "service_error";
          fields["error_code"] = err.code;
        } else {
          // Never leak an unexpected failure to the caller: the canonical
          // INTERNAL_ERROR message and no stack trace go over the wire.
          result = errorResult(errorResponse("INTERNAL_ERROR", requestId));
          fields["outcome"] = "internal_error";
          fields["error_code"] = "INTERNAL_ERROR";
          fields["error"] = describeError(err);
        }
      }
    }
  } else {
    result = errorResult(
      errorResponse("INVALID_REQUEST", requestId, `Unknown tool: ${name}`),
    );
    fields["outcome"] = "unknown_tool";
    fields["error_code"] = "INVALID_REQUEST";
  }

  fields["duration_ms"] = Date.now() - startedAt;
  opts.logger.info("mcp tool call", fields);

  return result;
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Widen a request's `Accept` header to the two media types the MCP SDK insists on.
 *
 * The SDK answers 406 to any POST whose Accept does not name both
 * `application/json` and `text/event-stream`. The spec does ask compliant clients to
 * send both, but a plain JSON prober does not - and the endpoint then looks broken to
 * anything that is not an MCP client. Catalogue crawlers are exactly that: PayAI's
 * indexer produced entries for our plain-HTTP routes while never creating one for
 * either MCP endpoint, and their crawler's `tools/list` came back 406.
 *
 * The transport is built with `enableJsonResponse`, so it replies with JSON whatever
 * the header said. Widening it therefore cannot change a response format - it only
 * stops the server refusing a caller it would happily serve.
 */
function widenAcceptHeader(req: IncomingMessage): void {
  const current = String(req.headers.accept ?? "");
  const namesJson = current.includes("application/json") || current.includes("*/*");
  const namesSse = current.includes("text/event-stream");
  if (namesJson && namesSse) return;

  const parts = new Set(
    current
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
  parts.add("application/json");
  parts.add("text/event-stream");
  req.headers.accept = [...parts].join(", ");
}

export function createEvidenceMcpServer(opts: EvidenceMcpServerOptions): EvidenceMcpServer {
  /** In-flight (server, transport) pairs; released when a response closes. */
  const active = new Set<{ server: Server; transport: StreamableHTTPServerTransport }>();

  function buildProtocolServer(paymentProvided: boolean): Server {
    const server = new Server(
      { name: SERVICE_NAME, version: opts.serviceVersion },
      { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
    );

    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: wireTools() }));

    server.setRequestHandler(CallToolRequestSchema, (request) =>
      invokeTool(opts, request.params.name, request.params.arguments, paymentProvided),
    );

    return server;
  }

  async function handleNodeRequest(
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody?: unknown,
  ): Promise<void> {
    // The Worker forwards the x402 proof on paid calls, so its presence is the
    // signal - the same one the HTTP route uses. Without this the MCP path would
    // report every tool call as paid, including operator and test calls, which is
    // the false-positive corrected on the HTTP side.
    const paymentProvided = Boolean(req.headers["payment-signature"]);
    const server = buildProtocolServer(paymentProvided);
    const transport = new StreamableHTTPServerTransport({
      // No session id: stateless mode. The transport is single-use, so a new
      // one is created for every HTTP request.
      sessionIdGenerator: undefined,
      // Answer with one JSON body rather than an SSE stream.
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
      widenAcceptHeader(req);
      await transport.handleRequest(req, res, parsedBody);
    } catch (err) {
      release();
      opts.logger.error("mcp request failed", { error: describeError(err) });
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

  /**
   * Release in-flight transports. Safe to call twice: the set is drained on the
   * first call and a second call has nothing left to close.
   */
  async function close(): Promise<void> {
    const entries = [...active];
    active.clear();
    await Promise.all(
      entries.flatMap(({ server, transport }) => [
        transport.close().catch(() => undefined),
        server.close().catch(() => undefined),
      ]),
    );
  }

  return {
    handleNodeRequest,
    listTools: listToolDefinitions,
    close,
  };
}
