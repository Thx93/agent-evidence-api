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

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** One MCP tool as advertised to clients and asserted by tests. */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown; // JSON Schema object
}

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

/** The exact tool names, exported so tests and docs cannot drift. */
export const PAID_TOOL_NAME = "research_evidence";
export const FREE_TOOL_NAME = "health";

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
  "Every excerpt returned is cited evidence tied to its source URL.";

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
      description: PAID_TOOL_DESCRIPTION,
      inputSchema: z.toJSONSchema(ResearchEvidenceInput),
    },
    {
      name: FREE_TOOL_NAME,
      description: FREE_TOOL_DESCRIPTION,
      inputSchema: z.toJSONSchema(HealthInput),
    },
  ];
}

const TOOL_DEFINITIONS: readonly McpToolDefinition[] = Object.freeze(buildToolDefinitions());

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

  if (name === FREE_TOOL_NAME) {
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
