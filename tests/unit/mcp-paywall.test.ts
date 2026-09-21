/**
 * Unit tests for the MCP paywall's decisions and its response capture.
 *
 * The capture is the part with real subtlety: it stands between the MCP
 * transport's raw socket writes and the settlement decision, and a mistake in it
 * either charges for a failed call or serves content that was never paid for.
 * `node --test` exercises it against a minimal `ServerResponse` stand-in, because
 * the production type is a live socket.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import {
  FREE_MCP_METHODS,
  FREE_MCP_TOOL,
  PAID_MCP_TOOL,
  captureResponse,
  mcpResponseFailed,
  needsMcpPayment,
} from "../../apps/backend/src/mcp-paywall.js";

/** Minimal `ServerResponse`, enough for `captureResponse` to intercept. */
function fakeResponse(): ServerResponse & {
  written: { status?: number; headers?: Record<string, string>; body: string };
} {
  const res = new EventEmitter() as unknown as ServerResponse & {
    written: { status?: number; headers?: Record<string, string>; body: string };
  };
  res.written = { body: "" };
  const target = res as unknown as Record<string, unknown>;
  target["writeHead"] = (status: number, headers?: Record<string, string>) => {
    res.written.status = status;
    res.written.headers = headers;
    return res;
  };
  target["write"] = (chunk: unknown) => {
    res.written.body += String(chunk);
    return true;
  };
  target["end"] = (chunk?: unknown) => {
    if (chunk !== undefined && chunk !== null) res.written.body += String(chunk);
    return res;
  };
  target["flushHeaders"] = () => res;
  return res;
}

const call = (name: string) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name, arguments: { question: "q" } },
});

describe("needsMcpPayment", () => {
  test("the discovery surface is free", () => {
    for (const method of FREE_MCP_METHODS) {
      assert.equal(
        needsMcpPayment({ jsonrpc: "2.0", id: 1, method }),
        false,
        `${method} must not require payment`,
      );
    }
  });

  test("the paid tool requires payment", () => {
    assert.equal(needsMcpPayment(call(PAID_MCP_TOOL)), true);
  });

  test("the free health tool does not", () => {
    assert.equal(needsMcpPayment(call(FREE_MCP_TOOL)), false);
  });

  test("an unrecognised method requires payment (fail closed)", () => {
    // This inversion is deliberate: a prober that sends no MCP headers must see a
    // 402 challenge rather than a transport 406.
    assert.equal(needsMcpPayment({ jsonrpc: "2.0", id: 1, method: "unknown/method" }), true);
  });

  test("a malformed or absent body requires payment", () => {
    assert.equal(needsMcpPayment(undefined), true);
    assert.equal(needsMcpPayment(null), true);
    assert.equal(needsMcpPayment("not json"), true);
    assert.equal(needsMcpPayment({ jsonrpc: "2.0", id: 1 }), true);
    assert.equal(needsMcpPayment({ jsonrpc: "2.0", id: 1, method: "tools/call" }), true);
  });

  test("a batch is charged when any element is paid", () => {
    const free = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    assert.equal(needsMcpPayment([free]), false);
    assert.equal(needsMcpPayment([free, call(PAID_MCP_TOOL)]), true);
    assert.equal(needsMcpPayment([free, call(FREE_MCP_TOOL)]), false);
  });
});

describe("mcpResponseFailed", () => {
  test("a JSON-RPC tool error is a failure", () => {
    const body = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "{\"error\":{}}" }], isError: true },
      }),
    );
    assert.equal(mcpResponseFailed(body, "application/json"), true);
  });

  test("a successful result is not", () => {
    const body = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "evidence" }] },
      }),
    );
    assert.equal(mcpResponseFailed(body, "application/json"), false);
  });

  test("a transport-level error is not charged for", () => {
    const body = Buffer.from(
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "no method" } }),
    );
    assert.equal(mcpResponseFailed(body, "application/json"), true);
  });

  test("a batch fails if any element failed", () => {
    const body = Buffer.from(
      JSON.stringify([
        { jsonrpc: "2.0", id: 1, result: { content: [] } },
        { jsonrpc: "2.0", id: 2, result: { isError: true } },
      ]),
    );
    assert.equal(mcpResponseFailed(body, "application/json"), true);
  });

  test("an SSE frame is inspected", () => {
    const body = Buffer.from(
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"isError":true}}\n\n',
    );
    assert.equal(mcpResponseFailed(body, "text/event-stream"), true);
  });

  test("an empty body is not a failure", () => {
    assert.equal(mcpResponseFailed(Buffer.alloc(0), "application/json"), false);
  });

  test("the word isError inside evidence text does not trigger a cancel", () => {
    // The evidence payload is embedded as a JSON *string*, so its own quotes are
    // escaped and the top-level shape has no isError. A regex over the raw body
    // would false-positive here; parsing does not.
    const body = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ excerpt: 'the field isError": true in the payload' }),
            },
          ],
        },
      }),
    );
    assert.equal(mcpResponseFailed(body, "application/json"), false);
  });
});

describe("captureResponse", () => {
  test("buffers writeHead/write/end and flushes once", () => {
    const res = fakeResponse();
    const captured = captureResponse(res);

    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"a":');
    res.end("1}");

    // Nothing reached the socket yet.
    assert.equal(res.written.status, undefined);
    assert.equal(captured.statusCode, 200);
    assert.equal(captured.headers["content-type"], "application/json");
    assert.equal(captured.body().toString(), '{"a":1}');

    captured.flush();
    assert.equal(res.written.status, 200);
    assert.equal(res.written.body, '{"a":1}');
  });

  test("replace() rewrites the response before it is sent", () => {
    const res = fakeResponse();
    const captured = captureResponse(res);
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"jsonrpc":"2.0"}');

    captured.replace(402, JSON.stringify({ error: { code: "PAYMENT_INVALID" } }), {
      "content-type": "application/json",
    });
    captured.flush();

    assert.equal(res.written.status, 402);
    assert.match(res.written.body, /PAYMENT_INVALID/);
    assert.doesNotMatch(res.written.body, /jsonrpc/);
  });

  test("mergeHeaders() adds the settlement receipt", () => {
    const res = fakeResponse();
    const captured = captureResponse(res);
    res.writeHead(200, {});
    res.end("ok");
    captured.mergeHeaders({ "payment-response": "receipt" });
    captured.flush();
    assert.equal(res.written.headers?.["payment-response"], "receipt");
  });

  test("flush is idempotent", () => {
    const res = fakeResponse();
    const captured = captureResponse(res);
    res.writeHead(200, {});
    res.end("once");
    captured.flush();
    captured.flush();
    assert.equal(res.written.body, "once");
  });

  test("header names are case-insensitive on read", () => {
    const res = fakeResponse();
    const captured = captureResponse(res);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    assert.equal(captured.headers["content-type"], "text/event-stream");
  });
});
