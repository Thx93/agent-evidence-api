/**
 * Tests for the @aee/mcp adapter.
 *
 * Covers the MCP list in SPEC section 26: server startup, tool listing, tool
 * schema, tool invocation, malformed arguments and server error handling — plus
 * the layering requirement that the MCP tool invokes the *same* EvidenceService
 * the HTTP layer uses (SPEC section 39).
 *
 * The transport is exercised over a real socket on 127.0.0.1 with an ephemeral
 * port, because Streamable HTTP is an HTTP transport and pretending otherwise
 * would not test the thing under test. Every harness is closed in a `finally`.
 */
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  DEFAULT_ERROR_MESSAGES,
  SCHEMA_VERSION,
  SERVICE_NAME,
  type EvidenceResponse,
} from "@aee/schemas";
import { ServiceError, type EvidenceService, type LogFields, type Logger } from "@aee/core";

import {
  createEvidenceMcpServer,
  FREE_TOOL_NAME,
  PAID_TOOL_NAME,
  type EvidenceMcpServer,
} from "./index.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface LogEntry {
  level: string;
  message: string;
  fields: Record<string, unknown>;
}

/** A Logger that records lines so tests can assert on what was emitted. */
function makeLogger(sink: LogEntry[] = []): Logger {
  const emit = (level: string, message: string, fields?: LogFields): void => {
    sink.push({ level, message, fields: { ...(fields ?? {}) } });
  };
  const logger: Logger = {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: () => logger,
  };
  return logger;
}

interface ServiceCall {
  input: unknown;
  requestId: string;
}

type ExecuteImpl = (input: unknown, requestId: string) => Promise<EvidenceResponse>;

/**
 * A stand-in for EvidenceService.
 *
 * The real class carries private collaborators, but this adapter is only ever
 * allowed to call `execute`, so a minimal object is a sound and deliberately
 * narrow stand-in — and it proves the adapter performs no fetching of its own.
 */
function stubService(
  impl: ExecuteImpl,
  calls: ServiceCall[] = [],
): EvidenceService {
  const service = {
    execute: async (input: unknown, requestId: string): Promise<EvidenceResponse> => {
      calls.push({ input, requestId });
      return impl(input, requestId);
    },
  };
  return service as unknown as EvidenceService;
}

function sampleResponse(requestId: string, question: string): EvidenceResponse {
  return {
    request_id: requestId,
    version: SCHEMA_VERSION,
    question,
    assessment: {
      status: "supported",
      basis: "One source directly states the claim.",
    },
    sources: [
      {
        requested_url: "https://example.com/a",
        final_url: "https://example.com/a",
        status: 200,
        content_type: "text/html; charset=utf-8",
        title: "Example source",
        canonical_url: "https://example.com/a",
        description: "An example document.",
        publisher: "example.com",
        language: "en",
        published_at: "2024-01-01T00:00:00.000Z",
        modified_at: null,
        retrieved_at: "2024-06-01T00:00:00.000Z",
        word_count: 120,
        content_hash_sha256: "0".repeat(64),
        evidence: [{ excerpt: "The claim is directly stated here.", relevance: "direct" }],
        structured_data: { json_ld: [], open_graph: {} },
        warnings: [],
        from_cache: false,
        redirect_chain: [],
      },
    ],
    limitations: [],
    processing_ms: 5,
  };
}

// ---------------------------------------------------------------------------
// Harness: a real HTTP server bound to an ephemeral loopback port
// ---------------------------------------------------------------------------

interface Harness {
  url: string;
  mcp: EvidenceMcpServer;
  logs: LogEntry[];
  httpServer: HttpServer;
  close(): Promise<void>;
}

async function startHarness(service: EvidenceService, logs: LogEntry[] = []): Promise<Harness> {
  const mcp = createEvidenceMcpServer({
    service,
    logger: makeLogger(logs),
    serviceVersion: "0.1.0",
  });
  const httpServer = createHttpServer((req, res) => {
    void mcp.handleNodeRequest(req, res);
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  assert.ok(address !== null && typeof address === "object", "server must bind a TCP port");
  const { port } = address as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    mcp,
    logs,
    httpServer,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      });
      await mcp.close();
    },
  };
}

interface RpcResponse {
  status: number;
  contentType: string;
  text: string;
  json: unknown;
}

async function rpc(url: string, body: unknown): Promise<RpcResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    text,
    json: JSON.parse(text) as unknown,
  };
}

function callToolRequest(id: number, name: string, args?: unknown): unknown {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: args === undefined ? { name } : { name, arguments: args },
  };
}

// ---------------------------------------------------------------------------
// Narrowing helpers (keeps the tests strict without `any`)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    assert.fail(`${label} must be an object, received ${JSON.stringify(value)}`);
  }
  return value;
}

interface ToolPayload {
  text: string;
  isError: boolean;
}

/**
 * Narrow a CallToolResult-shaped value.
 *
 * The SDK types `Client.callTool` as a union with the legacy compatibility
 * result, so its `content` is widened to `unknown`; narrowing at runtime keeps
 * this test honest about the wire shape without casting.
 */
function resultPayload(result: unknown, label: string): ToolPayload {
  const record = requireRecord(result, `${label} result`);
  const content = record["content"];
  assert.ok(
    Array.isArray(content) && content.length > 0,
    `${label}: content must be a non-empty array`,
  );
  const first = requireRecord(content[0], `${label} first content block`);
  assert.equal(first["type"], "text", `${label}: the tool result must be text content`);
  const text = first["text"];
  assert.equal(typeof text, "string", `${label}: the text content block must carry a string`);
  return { text: text as string, isError: record["isError"] === true };
}

function toolPayload(json: unknown): ToolPayload {
  const body = requireRecord(json, "JSON-RPC response");
  return resultPayload(body["result"], "JSON-RPC");
}

interface ErrorEnvelope {
  code: string;
  message: string;
  request_id: string;
  details: Record<string, unknown> | undefined;
  text: string;
}

/** Parse an isError tool result into the canonical SPEC section 22 envelope. */
function errorEnvelope(json: unknown): ErrorEnvelope {
  const { text, isError } = toolPayload(json);
  assert.equal(isError, true, "expected an isError tool result");
  const envelope = requireRecord(JSON.parse(text), "error envelope");
  const error = requireRecord(envelope["error"], "error");
  return {
    code: String(error["code"]),
    message: String(error["message"]),
    request_id: String(error["request_id"]),
    details: isRecord(error["details"]) ? error["details"] : undefined,
    text,
  };
}

const REQUEST_ID_PATTERN = /^req_[0-9a-f]{24}$/;

function assertNoStackTrace(text: string, label: string): void {
  assert.ok(!/\n\s+at\s/.test(text), `${label}: the result must not contain a stack frame`);
  assert.ok(!text.includes("node:internal"), `${label}: the result must not name internal modules`);
  assert.ok(!/\.(ts|js):\d+/.test(text), `${label}: the result must not contain a source location`);
  assert.ok(!text.includes('"stack"'), `${label}: the result must not contain a stack property`);
}

function textBlock(payload: ToolPayload, label: string): Record<string, unknown> {
  assert.equal(payload.isError, false, `${label}: expected a successful tool result`);
  return requireRecord(JSON.parse(payload.text), `${label} payload`);
}

// ---------------------------------------------------------------------------
// Tests: server lifecycle and tool listing
// ---------------------------------------------------------------------------

test("createEvidenceMcpServer exposes the documented surface and close() is idempotent", async () => {
  const mcp = createEvidenceMcpServer({
    service: stubService(async () => sampleResponse("req_ignored", "q")),
    logger: makeLogger(),
    serviceVersion: "0.1.0",
  });

  assert.equal(typeof mcp.handleNodeRequest, "function");
  assert.equal(typeof mcp.listTools, "function");
  assert.equal(typeof mcp.close, "function");

  await mcp.close();
  await mcp.close(); // must be safe to call twice
});

test("listTools() returns exactly the two expected tools", () => {
  const mcp = createEvidenceMcpServer({
    service: stubService(async () => sampleResponse("req_ignored", "q")),
    logger: makeLogger(),
    serviceVersion: "0.1.0",
  });

  const tools = mcp.listTools();
  assert.equal(tools.length, 2, "the server must expose exactly two tools");
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [PAID_TOOL_NAME, FREE_TOOL_NAME],
  );
  assert.equal(PAID_TOOL_NAME, "research_evidence");
  assert.equal(FREE_TOOL_NAME, "health");

  for (const tool of tools) {
    assert.equal(typeof tool.description, "string");
    assert.ok(tool.description.length > 40, `${tool.name} needs an agent-oriented description`);
    const schema = requireRecord(tool.inputSchema, `${tool.name} inputSchema`);
    assert.equal(schema["type"], "object", `${tool.name} inputSchema must be an object schema`);
    // JSON Schema must survive a round-trip because it is sent over the wire.
    assert.deepEqual(JSON.parse(JSON.stringify(schema)), schema);
  }

  // The returned array is a copy: a caller cannot corrupt shared state.
  const first = mcp.listTools();
  assert.notEqual(first, tools);
});

test("the research_evidence input schema requires question and describes every field", () => {
  const mcp = createEvidenceMcpServer({
    service: stubService(async () => sampleResponse("req_ignored", "q")),
    logger: makeLogger(),
    serviceVersion: "0.1.0",
  });

  const paid = mcp.listTools().find((tool) => tool.name === PAID_TOOL_NAME);
  assert.ok(paid, "research_evidence must be listed");
  const schema = requireRecord(paid.inputSchema, "research_evidence inputSchema");

  assert.equal(schema["type"], "object");
  assert.deepEqual(schema["required"], ["question"]);

  const properties = requireRecord(schema["properties"], "properties");
  for (const key of ["question", "urls", "max_sources", "language", "mode"]) {
    assert.ok(key in properties, `properties must advertise ${key}`);
    const property = requireRecord(properties[key], `properties.${key}`);
    assert.equal(typeof property["description"], "string", `${key} must be self-describing`);
  }

  const urls = requireRecord(properties["urls"], "properties.urls");
  assert.equal(urls["type"], "array");
  const maxSources = requireRecord(properties["max_sources"], "properties.max_sources");
  assert.equal(maxSources["type"], "integer");
  const mode = requireRecord(properties["mode"], "properties.mode");
  assert.deepEqual(mode["enum"], ["evidence"], 'only the "evidence" mode is supported in 0.1.0');
});

test("the paid tool description contains the SPEC section 29 discovery phrases", () => {
  const mcp = createEvidenceMcpServer({
    service: stubService(async () => sampleResponse("req_ignored", "q")),
    logger: makeLogger(),
    serviceVersion: "0.1.0",
  });

  const paid = mcp.listTools().find((tool) => tool.name === PAID_TOOL_NAME);
  assert.ok(paid, "research_evidence must be listed");
  const description = paid.description.toLowerCase();

  for (const phrase of [
    "web evidence",
    "source verification",
    "claim verification",
    "evidence extraction",
    "source-grounded research",
    "compare sources",
    "cited evidence",
    "fresh web evidence",
  ]) {
    assert.ok(description.includes(phrase), `description must contain "${phrase}"`);
  }
});

// ---------------------------------------------------------------------------
// Tests: transport-level invocation
// ---------------------------------------------------------------------------

test("tools/list over the transport advertises the same two tools", async () => {
  const harness = await startHarness(stubService(async () => sampleResponse("req_ignored", "q")));
  try {
    const { status, contentType, json } = await rpc(harness.url, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });

    assert.equal(status, 200);
    assert.match(contentType, /application\/json/, "the transport must answer with JSON");

    const result = requireRecord(requireRecord(json, "body")["result"], "result");
    const tools = result["tools"];
    assert.ok(Array.isArray(tools), "tools/list must return a tools array");
    assert.deepEqual(
      tools.map((tool) => requireRecord(tool, "tool")["name"]),
      [PAID_TOOL_NAME, FREE_TOOL_NAME],
    );
    const first = requireRecord(tools[0], "first tool");
    assert.deepEqual(requireRecord(first["inputSchema"], "inputSchema")["required"], ["question"]);
  } finally {
    await harness.close();
  }
});

test("health invocation succeeds and returns the minimal health shape", async () => {
  const harness = await startHarness(stubService(async () => sampleResponse("req_ignored", "q")));
  try {
    const { status, json } = await rpc(harness.url, callToolRequest(1, FREE_TOOL_NAME, {}));
    assert.equal(status, 200);

    const payload = textBlock(toolPayload(json), "health");
    assert.deepEqual(payload, { status: "ok", service: SERVICE_NAME, version: "0.1.0" });
  } finally {
    await harness.close();
  }
});

test("research_evidence invokes the injected EvidenceService and round-trips the JSON", async () => {
  const calls: ServiceCall[] = [];
  const service = stubService(async (input, requestId) => {
    const args = requireRecord(input, "service input");
    return sampleResponse(requestId, String(args["question"]));
  }, calls);

  const harness = await startHarness(service);
  try {
    const args = {
      question: "Is the sky blue?",
      urls: ["https://example.com/a"],
      max_sources: 1,
      language: "en",
      mode: "evidence",
    };
    const { status, json } = await rpc(
      harness.url,
      callToolRequest(1, PAID_TOOL_NAME, args),
    );
    assert.equal(status, 200);

    const tool = toolPayload(json);
    assert.equal(tool.isError, false);
    const payload = requireRecord(JSON.parse(tool.text), "evidence payload");

    assert.equal(calls.length, 1, "the injected EvidenceService must be the one invoked");
    const firstCall = calls[0];
    assert.ok(firstCall, "the service must have been called");
    assert.deepEqual(firstCall.input, args, "arguments must reach the service unchanged");

    assert.match(String(payload["request_id"]), REQUEST_ID_PATTERN);
    assert.equal(payload["request_id"], firstCall.requestId, "response and service share a request id");
    assert.deepEqual(payload, sampleResponse(firstCall.requestId, "Is the sky blue?"));
    assert.equal(tool.text, JSON.stringify(payload), "the payload must round-trip as JSON text");
  } finally {
    await harness.close();
  }
});

test("a tools/call without initialize works: the server keeps no per-session state", async () => {
  const harness = await startHarness(stubService(async (_input, requestId) => sampleResponse(requestId, "q")));
  try {
    // No initialize / notifications/initialized handshake at all.
    const { status, json } = await rpc(harness.url, callToolRequest(7, FREE_TOOL_NAME, {}));
    assert.equal(status, 200);
    assert.equal(toolPayload(json).isError, false);
  } finally {
    await harness.close();
  }
});

test("concurrent tool calls are handled independently", async () => {
  const service = stubService(async (input, requestId) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const args = requireRecord(input, "service input");
    return sampleResponse(requestId, String(args["question"]));
  });
  const harness = await startHarness(service);
  try {
    const [a, b] = await Promise.all([
      rpc(harness.url, callToolRequest(1, PAID_TOOL_NAME, { question: "first" })),
      rpc(harness.url, callToolRequest(2, PAID_TOOL_NAME, { question: "second" })),
    ]);

    const payloadA = requireRecord(JSON.parse(toolPayload(a.json).text), "payload a");
    const payloadB = requireRecord(JSON.parse(toolPayload(b.json).text), "payload b");

    assert.equal(payloadA["question"], "first");
    assert.equal(payloadB["question"], "second");
    assert.notEqual(payloadA["request_id"], payloadB["request_id"], "each call gets its own request id");
  } finally {
    await harness.close();
  }
});

// ---------------------------------------------------------------------------
// Tests: schema validation and error handling
// ---------------------------------------------------------------------------

test("malformed arguments produce an isError result with INVALID_REQUEST and the issues", async () => {
  const calls: ServiceCall[] = [];
  const harness = await startHarness(stubService(async (_input, requestId) => sampleResponse(requestId, "q"), calls));
  try {
    // Missing required `question`.
    const missing = await rpc(
      harness.url,
      callToolRequest(1, PAID_TOOL_NAME, { urls: ["https://example.com/a"] }),
    );
    const missingError = errorEnvelope(missing.json);
    assert.equal(missingError.code, "INVALID_REQUEST");
    assert.match(missingError.request_id, REQUEST_ID_PATTERN);
    const missingIssues = missingError.details?.["issues"];
    assert.ok(Array.isArray(missingIssues) && missingIssues.length > 0, "issues must be reported");
    assert.ok(
      missingIssues.some((issue) => String(requireRecord(issue, "issue")["path"]).includes("question")),
      "the issue must point at `question`",
    );
    assertNoStackTrace(missingError.text, "missing question");

    // Wrong type for `question`.
    const wrongType = await rpc(harness.url, callToolRequest(2, PAID_TOOL_NAME, { question: 42 }));
    const wrongTypeError = errorEnvelope(wrongType.json);
    assert.equal(wrongTypeError.code, "INVALID_REQUEST");
    assert.ok(Array.isArray(wrongTypeError.details?.["issues"]));
    assertNoStackTrace(wrongTypeError.text, "wrong type");

    assert.equal(calls.length, 0, "invalid arguments must never reach the service");
  } finally {
    await harness.close();
  }
});

test("an unknown tool name produces an INVALID_REQUEST error result", async () => {
  const calls: ServiceCall[] = [];
  const harness = await startHarness(stubService(async (_input, requestId) => sampleResponse(requestId, "q"), calls));
  try {
    const { status, json } = await rpc(harness.url, callToolRequest(1, "delete_everything", {}));
    assert.equal(status, 200);

    const envelope = errorEnvelope(json);
    assert.equal(envelope.code, "INVALID_REQUEST");
    assert.match(envelope.request_id, REQUEST_ID_PATTERN);
    assertNoStackTrace(envelope.text, "unknown tool");
    assert.equal(calls.length, 0);
  } finally {
    await harness.close();
  }
});

test("a ServiceError becomes an isError result carrying the canonical error code", async () => {
  const service = stubService(async () => {
    throw new ServiceError(
      "BLOCKED_URL",
      "The supplied URL resolves to a destination that is not allowed.",
    );
  });
  const harness = await startHarness(service);
  try {
    const { status, json } = await rpc(
      harness.url,
      callToolRequest(1, PAID_TOOL_NAME, { question: "q", urls: ["http://127.0.0.1/"] }),
    );
    assert.equal(status, 200, "a tool-level failure is not a transport-level failure");

    const envelope = errorEnvelope(json);
    assert.equal(envelope.code, "BLOCKED_URL");
    assert.equal(envelope.message, "The supplied URL resolves to a destination that is not allowed.");
    assert.match(envelope.request_id, REQUEST_ID_PATTERN);
    assertNoStackTrace(envelope.text, "service error");
  } finally {
    await harness.close();
  }
});

test("an unexpected service failure is sanitised to INTERNAL_ERROR without leaking detail", async () => {
  const service = stubService(async () => {
    throw new Error("boom: internal detail at /srv/agent-evidence-api/packages/core/src/service.ts:42");
  });
  const harness = await startHarness(service);
  try {
    const { status, json } = await rpc(
      harness.url,
      callToolRequest(1, PAID_TOOL_NAME, { question: "q" }),
    );
    assert.equal(status, 200);

    const envelope = errorEnvelope(json);
    assert.equal(envelope.code, "INTERNAL_ERROR");
    assert.equal(envelope.message, DEFAULT_ERROR_MESSAGES.INTERNAL_ERROR);
    assert.match(envelope.request_id, REQUEST_ID_PATTERN);
    assert.ok(!envelope.text.includes("boom"), "the internal message must not leak");
    assert.ok(!envelope.text.includes("agent-evidence-api/packages"), "internal paths must not leak");
    assertNoStackTrace(envelope.text, "internal error");
  } finally {
    await harness.close();
  }
});

// ---------------------------------------------------------------------------
// Tests: observability
// ---------------------------------------------------------------------------

test("one structured log line per tool call, with counts but never arguments", async () => {
  const logs: LogEntry[] = [];
  const service = stubService(async (_input, requestId) => sampleResponse(requestId, "q"));
  const harness = await startHarness(service, logs);
  try {
    await rpc(
      harness.url,
      callToolRequest(1, PAID_TOOL_NAME, {
        question: "q",
        urls: ["https://sensitive.example.com/private-path", "https://example.com/b"],
      }),
    );

    const lines = logs.filter((entry) => entry.message === "mcp tool call");
    assert.equal(lines.length, 1, "exactly one log line per tool call");
    const line = lines[0];
    assert.ok(line, "a log line must be emitted");

    assert.equal(line.fields["tool"], PAID_TOOL_NAME);
    assert.match(String(line.fields["request_id"]), REQUEST_ID_PATTERN);
    assert.equal(typeof line.fields["duration_ms"], "number");
    assert.equal(line.fields["assessment"], "supported");
    assert.equal(line.fields["sources"], 1);
    assert.equal(line.fields["url_count"], 2);

    const serialised = JSON.stringify(line.fields);
    assert.ok(!serialised.includes("sensitive.example.com"), "arguments must never be logged");
    assert.ok(!serialised.includes("private-path"), "arguments must never be logged");
  } finally {
    await harness.close();
  }
});

// ---------------------------------------------------------------------------
// Tests: a real MCP client over Streamable HTTP
// ---------------------------------------------------------------------------

test("an MCP client can initialize, list tools and call both tools end to end", async () => {
  const calls: ServiceCall[] = [];
  const service = stubService(async (input, requestId) => {
    const args = requireRecord(input, "service input");
    return sampleResponse(requestId, String(args["question"]));
  }, calls);

  const harness = await startHarness(service);
  const client = new Client({ name: "aee-mcp-test-client", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(harness.url));

  try {
    await client.connect(transport);

    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      [PAID_TOOL_NAME, FREE_TOOL_NAME],
    );

    const health = resultPayload(await client.callTool({ name: FREE_TOOL_NAME, arguments: {} }), "health");
    assert.equal(health.isError, false);
    assert.deepEqual(JSON.parse(health.text), {
      status: "ok",
      service: SERVICE_NAME,
      version: "0.1.0",
    });

    const evidence = resultPayload(
      await client.callTool({
        name: PAID_TOOL_NAME,
        arguments: { question: "Is the sky blue?", urls: ["https://example.com/a"] },
      }),
      "research_evidence",
    );
    assert.equal(evidence.isError, false);

    const payload = requireRecord(JSON.parse(evidence.text), "evidence payload");
    assert.equal(payload["question"], "Is the sky blue?");
    assert.equal(calls.length, 1);
    assert.equal(payload["request_id"], calls[0]?.requestId);
  } finally {
    await client.close();
    await harness.close();
  }
});
