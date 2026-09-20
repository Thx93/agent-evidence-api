# MCP server

Agent Evidence API is MCP-native: the same evidence capability that the HTTP API
exposes is also reachable by an agent as an MCP server. There is no separate
implementation of the feature — SPEC §39 requires both adapters to call the same
`EvidenceService`, and that is the design here.

> **Status.** Implemented end to end in source. The edge routes `/mcp`, inspects
> the JSON-RPC body to find paid calls, and gates accordingly
> (`apps/worker/src/index.ts`). The backend registers `POST`, `GET`, and `DELETE`
> on `/mcp`, hijacks the socket, and hands it to an `EvidenceMcpServer` created by
> `@aee/mcp` (`apps/backend/src/app.ts`). `packages/mcp` implements the server,
> the tool definitions, and `tools/call` delegation in stateless streamable-HTTP
> mode, with a 15-case test file.
>
> What has **not** been done: the suites have not been run here, and no x402
> payment test exists. See [§8 Status](#8-status).

---

## 1. Transport

**Streamable HTTP**, as required by SPEC §10. There is no stdio transport and no
SSE-only legacy transport.

The server runs in **stateless mode**. That is a deliberate consequence of the
deployment shape: the backend sits behind the Cloudflare edge, so a request may
land on a different process from the one that handled `initialize`. There is
therefore no session persistence — no session id, no event store, no
resumability:

```ts
new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,   // stateless: no session id
  enableJsonResponse: true,        // one JSON body, not an SSE stream
})
```

Two consequences a client will observe:

- **A fresh `Server` + transport pair is created per HTTP request** and released
  when the response closes. The SDK forbids reusing a stateless transport across
  requests ("Stateless transport cannot be reused across requests"), so
  `handleNodeRequest` builds a throwaway pair each time and releases both on
  `res` `close`. A `tools/call` therefore works **without** a preceding
  `initialize` on the same connection — there is no per-session state to establish.
- **Responses are plain JSON bodies**, not SSE. That is friendlier to proxies and
  to JSON-RPC-only clients. `Accept: text/event-stream` is still advertised in the
  example config because `GET /mcp` is the SSE channel.

| Method | Path | Paid? | Purpose |
|---|---|---|---|
| `POST` | `/mcp` | Only for a paid tool invocation | JSON-RPC requests and notifications. |
| `GET` | `/mcp` | Free | Server-sent events stream for server-initiated messages. |
| `DELETE` | `/mcp` | Free | Session teardown. |

Endpoint URL:

```text
${MCP_PUBLIC_URL}
```

which resolves to the Worker's `/mcp` route, for example
`https://${PUBLIC_API_DOMAIN}/mcp`.

The Worker forwards `/mcp` to the backend, attaching the same server-to-server
credential it uses for the HTTP API:

```http
POST /mcp HTTP/1.1
Host: ${PUBLIC_API_DOMAIN}
Content-Type: application/json
Accept: application/json, text/event-stream
```

On the way through, the Worker:

- buffers the JSON-RPC body **once** (hard cap 64 KiB) and stashes the original
  bytes on the request context, so the downstream proxy forwards the exact bytes
  without re-serialising them;
- forwards `mcp-session-id` and `payment-response` back to the client when the
  backend supplies them;
- sets `cache-control: no-store` on the proxied response.

A body larger than 64 KiB is rejected at the edge with `INVALID_REQUEST`
(HTTP 400, *"Request body is too large."*).

The backend's `/mcp` route requires the shared secret like every other internal
route — `PUBLIC_PATHS` contains only `/health` — and calls `reply.hijack()` before
handing the raw sockets to the MCP transport, so Fastify does not serialise the
response itself.

---

## 2. Tools

SPEC §10 asks for a small, carefully designed tool set. There are exactly two.

| Tool | Payment | Purpose |
|---|---|---|
| `research_evidence` | **paid (x402)** | Fetch public sources and return structured, cited evidence for a question or claim. |
| `health` | free | Simple health/status check. |

There are no account-management, payment-management, or administrative tools,
and there must not be (SPEC §10).

### `research_evidence`

The **actual** description string returned by `tools/list` (from
`packages/mcp/src/index.ts`):

> Fetch public web sources and return structured, cited web evidence for a
> question or claim. Use this for source verification, claim verification,
> evidence extraction, and source-grounded research, or to compare sources.
> Returns source URLs, retrieval timestamps, short evidence excerpts, publisher
> and document metadata, and an explicit supported/contradicted/mixed/inconclusive
> assessment. Fresh web evidence is retrieved per request unless served from a
> bounded cache, and each source reports its actual retrieval time. Every excerpt
> returned is cited evidence tied to its source URL.

This is **not** the SPEC §10 text verbatim. SPEC §10 gives an *example intent*
("Example intent: …"), and SPEC §29 asks the description to contain eight
truthful discovery phrases. The implementation satisfies §29 by weaving all eight
into real sentences: *web evidence*, *source verification*, *claim verification*,
*evidence extraction*, *source-grounded research*, *compare sources*, *cited
evidence*, *fresh web evidence*.

That is a judgement call worth flagging: eight mandated phrases × one paragraph is
close to the boundary of keyword stuffing, even though every clause describes
behaviour the code actually has. If you revise it, cut phrases rather than adding
them, and keep each remaining claim verifiable. A test asserts the phrases are
present (`packages/mcp/src/mcp.test.ts`), so changing the string requires changing
the test.

The `health` tool's description:

> Check that the Agent Evidence API MCP server is reachable and report which
> service version is running. Free to call, takes no arguments or payment. Returns
> only {status, service, version} and exposes no secrets or infrastructure detail.

The server also advertises `instructions` to the client:

> Agent Evidence API returns web evidence for AI agents. Call research_evidence
> with a question or claim and the public source URLs to verify to receive
> structured, cited evidence with an explicit assessment. Call health to check
> connectivity.

#### Input schema (exact)

The tool input schemas are **generated from zod** with `z.toJSONSchema(...)` in
`packages/mcp/src/index.ts`, mirroring the shared contract in `@aee/schemas` so an
MCP caller and an HTTP caller fail (or succeed) on the same shapes. They are
*shape* checks only; `EvidenceService` re-validates and owns every policy
decision.

| Field | Type | Required | Schema constraint | Notes |
|---|---|---|---|---|
| `question` | `string` | **yes** | trimmed, 1–2000 | The question or claim to gather web evidence for. |
| `urls` | `string[]` | no | at most 25 | Candidate public source URLs. v0.1.0 requires at least one at runtime. |
| `max_sources` | `integer` | no | positive, at most 25 | Cap on the number of sources processed. |
| `language` | `string` | no | trimmed, 1–35 | `"auto"` or a BCP-47 tag such as `"en"`. |
| `mode` | `"evidence"` | no | enum `["evidence"]` | Reserved input; only `"evidence"` in v0.1.0. |

`urls` is optional in the schema but a call with no URL is rejected at runtime
with `INVALID_REQUEST`: version 0.1.0 works from agent-supplied URLs only, so
there is no search provider to fall back on (SPEC §8).

#### Tool errors are results, not JSON-RPC errors

An invalid invocation does **not** produce a JSON-RPC `error`. It produces a
normal `tools/call` result with `isError: true` whose text content is the
canonical error envelope:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"error\":{\"code\":\"INVALID_REQUEST\",\"message\":\"The tool arguments are invalid.\",\"request_id\":\"req_…\",\"details\":{\"issues\":[{\"path\":\"question\",\"message\":\"Too small: expected string to have >=1 characters\"}]}}}"
    }
  ],
  "isError": true
}
```

This is how a client receives an unknown tool name (`INVALID_REQUEST`,
`"Unknown tool: …"`), malformed arguments (with a per-field `issues` array), a
`ServiceError` from the engine (its own stable code), and an unexpected internal
failure (sanitised to `INTERNAL_ERROR` with no stack trace and no leaked detail).

#### Output

The tool result carries the same `EvidenceResponse` document described in
[`api.md` §4.2](./api.md#42-response-schema-exact): `request_id`, `version`,
`question`, `assessment`, `sources[]`, `limitations[]`, and `processing_ms`. Each
`source` carries its requested and final URL, status, content type, title,
canonical URL, description, publisher, language, publication and modification
dates, retrieval timestamp, word count, content hash, short cited excerpts with
context and relevance, structured data, warnings, `from_cache`, and the redirect
chain.

### `health`

Takes no arguments and returns the same minimal status object as `GET /health`.
It exists so a client can confirm the service is reachable before deciding to
pay for anything.

#### Input schema

Generated from `z.object({})` via `z.toJSONSchema`, so it is an empty object
schema:

```json
{ "type": "object", "properties": {} }
```

---

## 3. What is free and what is paid

This is the most important property of the MCP surface, and it is deliberate:

> **`initialize` and `tools/list` are free. Only `tools/call` on
> `research_evidence` requires payment.**

An agent must be able to *discover* the tools before it can decide to pay for
one. Charging for discovery would make the service unusable by an autonomous
agent, which is the opposite of the commercial design in SPEC §38
(discover → call → 402 → pay → retry → receive evidence).

The Worker decides this by parsing the JSON-RPC body before forwarding it
(`needsPayment()` in `apps/worker/src/index.ts`):

| JSON-RPC method | Paid? |
|---|---|
| `initialize` | **free** |
| `tools/list` | **free** |
| `notifications/initialized` and all other notifications | **free** |
| `tools/call` with `params.name === "health"` | **free** |
| `tools/call` with `params.name === "research_evidence"` | **paid** |
| `ping`, `resources/list`, `prompts/list`, and anything else | **free** |

Additional behaviour, stated precisely because it is observable:

- **Only `tools/call` is examined.** Any other JSON-RPC method is free, even if
  it happens to carry a `params.name`. The check requires
  `method === "tools/call"` *and* `params.name === "research_evidence"`.
- **A batch is charged if any element is a paid call.** If the body is a JSON-RPC
  array, `Array.prototype.some` is applied and the whole batch is gated. That is
  conservative: it never lets a paid call through inside a batch.
- **Malformed JSON is not gated at the edge.** If the body cannot be parsed, the
  Worker forwards it so the backend can answer with a proper JSON-RPC parse
  error. Malformed JSON is not a payment problem.
- **`GET /mcp` and `DELETE /mcp` are never gated.** They carry no tool
  invocation.

---

## 4. Example MCP client configuration

Client config formats vary between MCP host applications. The shape below is the
common remote-server form: a name, a streamable-HTTP transport, and the endpoint
URL. Adapt the key names to your client.

```json
{
  "mcpServers": {
    "agent-evidence-api": {
      "type": "http",
      "url": "${MCP_PUBLIC_URL}",
      "headers": {
        "Accept": "application/json, text/event-stream"
      }
    }
  }
}
```

There are **no API keys and no accounts** to put in this block. Authentication is
payment: the server answers a paid call with HTTP 402 and the x402 payment
requirements, and the client's x402-capable wallet layer settles them. See
[`x402.md`](./x402.md).

If your client cannot perform x402 settlement on its own, point it at an
HTTP client that can, or use the HTTP API through a payment-aware proxy.

---

## 5. Example tool call

### 5.1 Discovery (free)

Request:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

This is **not** gated. `tools/list` returns `research_evidence` and `health`
along with their input schemas, so the agent can plan before spending anything.

### 5.2 Invocation (paid)

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "research_evidence",
    "arguments": {
      "question": "Is Rotamech Industries a manufacturer of centrifugal pumps?",
      "urls": [
        "https://example.invalid/products",
        "https://example.invalid/about"
      ],
      "max_sources": 5,
      "language": "auto",
      "mode": "evidence"
    }
  }
}
```

After payment settles, the result content carries the evidence document:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"request_id\":\"req_3f9c1a7b2e4d4a6f8b0c1d2e\",\"version\":\"1\",\"question\":\"Is Rotamech Industries a manufacturer of centrifugal pumps?\",\"assessment\":{\"status\":\"supported\",\"basis\":\"1 source(s) contained passages matching the question (example.invalid) with no contradicting passages found.\"},\"sources\":[{\"requested_url\":\"https://example.invalid/products\",\"final_url\":\"https://example.invalid/products\",\"status\":200,\"content_type\":\"text/html; charset=utf-8\",\"title\":\"Rotamech Industries — Products\",\"canonical_url\":\"https://example.invalid/products\",\"description\":\"Rotamech Industries manufactures centrifugal pumps for industrial use.\",\"publisher\":\"Rotamech Industries\",\"language\":\"en\",\"published_at\":\"2024-03-01T09:00:00.000Z\",\"modified_at\":null,\"retrieved_at\":\"2026-09-20T21:16:07.412Z\",\"word_count\":63,\"content_hash_sha256\":\"3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b\",\"evidence\":[{\"excerpt\":\"Rotamech Industries is a manufacturer of centrifugal pumps.\",\"context\":\"h2:Products > p[1]\",\"relevance\":\"direct\"}],\"structured_data\":{\"json_ld\":[],\"open_graph\":{}},\"warnings\":[],\"from_cache\":false,\"redirect_chain\":[]}],\"limitations\":[\"Assessment is derived from deterministic lexical matching, not semantic reasoning. A configured reasoning provider may refine it, but never replaces source evidence.\"],\"processing_ms\":412}"
      }
    ],
    "isError": false
  }
}
```

The exact content-block encoding is the MCP server's responsibility; the
essential contract is that the agent receives the full `EvidenceResponse`
document, with every source's URL, retrieval timestamp, content hash, and short
cited excerpts intact. An agent must be able to cite what it received.

### 5.3 The free health tool

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": { "name": "health", "arguments": {} }
}
```

Not gated: `health` is not `research_evidence`, so `needsPayment()` returns
false.

---

## 6. The payment-required response

A paid invocation without valid payment is answered at the edge, before any
backend work happens. Because the transport is HTTP, the client sees an **HTTP
`402 Payment Required`** carrying the x402 payment requirements produced by the
official x402 middleware — not a JSON-RPC `result`.

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json

{
  "error": {
    "code": "PAYMENT_REQUIRED",
    "message": "Payment is required to access this resource.",
    "request_id": "req_5c4b3a291807f6e5d4c3b2a1"
  }
}
```

The same code appears for a payment that fails verification or has expired:

| Situation | Code | HTTP |
|---|---|---|
| No payment supplied for a paid call | `PAYMENT_REQUIRED` | `402` |
| Payment proof failed verification | `PAYMENT_INVALID` | `402` |
| Payment proof expired | `PAYMENT_EXPIRED` | `402` |

What an MCP client should do with it:

1. Read the x402 payment requirements from the 402 response.
2. Settle the required USDC amount on the configured network (`eip155:84532`
   Base Sepolia for test, `eip155:8453` Base for production) to the configured
   `payTo` address.
3. Retry the **same** `tools/call` with the payment proof in the
   `payment-signature` header.
4. On success, the Worker forwards the call to the backend and returns the
   evidence result.

For the full sequence and its configuration, see [`x402.md`](./x402.md).

Because the 402 arrives at the HTTP layer, a client that only understands
JSON-RPC and has no wallet handling will surface it as a transport error rather
than a tool result. That is expected: `research_evidence` is a paid tool, and the
agent's runtime is responsible for the payment leg.

---

## 7. Registry readiness

SPEC §28 requires the project to be prepared for the official MCP Registry via a
`server.json` metadata file, with remote transport information, repository
metadata, version, and installation details — validated, with publication steps
documented, but **not** published automatically.

`server.json` now exists and declares this as a **remote** server, which is
correct (there is no npm package to install):

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.<owner>/agent-evidence-api",
  "title": "Agent Evidence API",
  "description": "MCP-native web evidence and claim verification: cited, source-grounded evidence for AI agents.",
  "version": "0.1.0",
  "repository": { "url": "https://github.com/<owner>/agent-evidence-api", "source": "github" },
  "remotes": [{ "type": "streamable-http", "url": "https://mcp.example.invalid/mcp" }]
}
```

The `remotes[].url` is a placeholder (`*.example.invalid`) and must be replaced
with your real `MCP_PUBLIC_URL` before publication. The `name` and `repository`
values assert a GitHub namespace and account — **verify they are genuinely yours
before publishing**, because namespace ownership is validated against the
repository and a fabricated handle will fail.

The exact publish procedure, the namespace/authentication checklist, and the
validation steps are documented in
[`registry-publication.md`](./registry-publication.md). The discovery strategy
that surrounds it is in [`discovery.md`](./discovery.md).

---

## 8. Status

| Piece | State |
|---|---|
| `/mcp` routing and forwarding in the Worker | Implemented |
| Free `initialize` / `tools/list` gating logic | Implemented (`needsPayment`) |
| Paid-call detection for `tools/call` → `research_evidence` | Implemented |
| Batch conservatism and 64 KiB body cap | Implemented |
| Backend `/mcp` routes (POST/GET/DELETE, socket hijack) | Implemented |
| Backend requires the shared secret on `/mcp` | Implemented (`PUBLIC_PATHS` is `/health` only) |
| `packages/mcp` — server, tool definitions, `tools/call` delegation | Implemented, stateless streamable HTTP |
| `packages/mcp/src/mcp.test.ts` | 15 cases (not run here) |
| `server.json` | Created; remote URL still a placeholder |
| Automated x402 payment test | **Not written** |

Known behavioural notes:

- The two tool descriptions returned by `tools/list` are the ones in §2, not the
  SPEC §10 text verbatim.
- The server is stateless, so a `tools/call` works without a preceding
  `initialize` on the same connection.
- One structured log line is emitted per tool call, carrying the tool name,
  request id, duration, and counts. **Tool arguments are deliberately never
  logged**, because a caller-supplied URL may be sensitive.
- `close()` is idempotent and releases any in-flight transports.
