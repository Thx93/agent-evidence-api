# HTTP API reference

Version: API `v1`, product `0.1.0`, response schema version `1`.

All examples use RFC 2606 placeholder hosts (`*.example.invalid`). Replace them
with your own deployment's values. No real domain, wallet address, or secret
appears in this document.

---

## 1. Base URL

The public API is served by the Cloudflare Worker:

```text
https://${PUBLIC_API_DOMAIN}
```

| Endpoint | Method | Payment | Purpose |
|---|---|---|---|
| `/health` | `GET` | free | Liveness probe. |
| `/` | `GET` | free | Capability description for agent discovery. |
| `/v1/evidence` | `POST` | **paid (x402)** | The evidence resource. |
| `/mcp` | `POST`/`GET`/`DELETE` | paid only for `tools/call` on `research_evidence` | MCP streamable HTTP. See [`mcp.md`](./mcp.md). |

Unknown paths return `400` with the canonical error envelope containing
`INVALID_REQUEST` (the Worker's `notFound` handler reuses that code because the
error vocabulary has no `NOT_FOUND` code).

Every response — success or failure — carries an `x-request-id` header. Error
bodies repeat it as `error.request_id`.

---

## 2. `GET /health` — free

Deliberately minimal: no secrets, no dependency versions, no infrastructure
detail (SPEC §4A).

### Response `200`

```json
{
  "status": "ok",
  "service": "agent-evidence-api",
  "version": "0.1.0"
}
```

| Field | Type | Notes |
|---|---|---|
| `status` | `"ok" \| "degraded"` | `degraded` is part of the schema in `HealthResponseSchema`; the Worker always returns `ok`. |
| `service` | literal `"agent-evidence-api"` | Fixed by `SERVICE_NAME`. |
| `version` | `string` | `SERVICE_VERSION`, currently `0.1.0`. |

```bash
curl -s https://${PUBLIC_API_DOMAIN}/health
```

---

## 3. `GET /` — free capabilities

Returns what the service offers and how it is paid for, so an agent can decide
what to call before spending anything.

### Response `200`

```json
{
  "service": "agent-evidence-api",
  "version": "0.1.0",
  "description": "Evidence infrastructure for AI agents. Returns structured, cited, freshly-retrieved evidence from public web pages so an agent can verify claims and ground answers in sources.",
  "endpoints": {
    "health": "GET /health (free)",
    "evidence": "POST /v1/evidence (paid, x402)",
    "mcp": "POST /mcp (MCP streamable HTTP; initialize and tools/list are free)"
  },
  "mcp": {
    "transport": "streamable-http",
    "tools": {
      "research_evidence": "paid",
      "health": "free"
    }
  },
  "payment": {
    "protocol": "x402",
    "scheme": "exact",
    "network": "eip155:84532",
    "asset": "USDC",
    "price_usd": "0.003",
    "recipient": "0x…",
    "facilitator": "https://x402.org/facilitator"
  }
}
```

`payment.network`, `payment.price_usd`, `payment.recipient`, and
`payment.facilitator` echo the Worker's configured values; `recipient` is a
public receiving address, never a key.

---

## 4. `POST /v1/evidence` — paid

The primary paid resource. Payment is enforced by x402 middleware before the
request body is processed. See [`x402.md`](./x402.md).

Without valid payment the endpoint returns `402` with a `PAYMENT_REQUIRED` error
envelope and the x402 payment requirements in the `payment-response` header
exchange handled by the middleware.

Request content type: `application/json`.

### 4.1 Request schema (exact)

Defined by `EvidenceRequestSchema` in `packages/schemas/src/evidence.ts`:

| Field | Type | Required | Constraints | Meaning |
|---|---|---|---|---|
| `question` | `string` | **yes** | trimmed; length 1–2000 characters | The question or claim to gather evidence for. |
| `urls` | `string[]` | no | at most 25 entries | Public URLs to use as sources. |
| `max_sources` | `integer` | no | positive, at most 25 | Cap on how many of the supplied URLs are processed. |
| `language` | `string` | no | trimmed; length 1–35 | `"auto"` or a BCP-47 language tag. Overrides the detected document language in the response when it is not `"auto"`. |
| `mode` | `"evidence"` | no | only `"evidence"` is accepted | Request mode. v0.1.0 has exactly one mode. |

Two behaviours that are **policy, not shape**, and therefore enforced by
`EvidenceService` rather than by the schema:

- `urls` is optional in the schema because SPEC §8 requires the API to
  accommodate future source mechanisms. At runtime, a request with no usable
  source at all is rejected with `INVALID_REQUEST`
  (*"At least one source URL is required. Version 0.1.0 supports agent-supplied
  URLs only."*).
- More than `MAX_URLS_PER_REQUEST` (default **5**) URLs is rejected with
  `INVALID_REQUEST`, even though the schema permits up to 25. The schema cap
  exists only to stop absurd payloads from reaching the service.

URLs are trimmed, normalised for de-duplication via `cacheKey`, and kept in
input order. Duplicates collapse to one source.

### 4.2 Response schema (exact)

Defined by `EvidenceResponseSchema` and `SourceSchema`. This is the complete
shape — every field, including the ones the SPEC §5 sketch omits.

```json
{
  "request_id": "req_3f9c1a7b2e4d4a6f8b0c1d2e",
  "version": "1",
  "question": "Is Rotamech Industries a manufacturer of centrifugal pumps?",
  "assessment": {
    "status": "supported",
    "basis": "1 source(s) contained passages matching the question (example.invalid) with no contradicting passages found."
  },
  "sources": [
    {
      "requested_url": "https://example.invalid/products",
      "final_url": "https://example.invalid/products",
      "status": 200,
      "content_type": "text/html; charset=utf-8",
      "title": "Rotamech Industries — Products",
      "canonical_url": "https://example.invalid/products",
      "description": "Rotamech Industries manufactures centrifugal pumps for industrial use.",
      "publisher": "Rotamech Industries",
      "language": "en",
      "published_at": "2024-03-01T09:00:00.000Z",
      "modified_at": null,
      "retrieved_at": "2026-09-20T21:16:07.412Z",
      "word_count": 63,
      "content_hash_sha256": "9f2c…64 hex characters…",
      "evidence": [
        {
          "excerpt": "Rotamech Industries is a manufacturer of centrifugal pumps.",
          "context": "h2:Products > p[1]",
          "relevance": "direct"
        }
      ],
      "structured_data": {
        "json_ld": [
          {
            "@context": "https://schema.org",
            "@type": "Organization",
            "name": "Rotamech Industries",
            "datePublished": "2024-03-01T09:00:00Z"
          }
        ],
        "open_graph": {
          "title": "Rotamech Industries",
          "description": "Industrial centrifugal pump manufacturer.",
          "site_name": "Rotamech Industries"
        }
      },
      "warnings": [],
      "from_cache": false,
      "redirect_chain": []
    }
  ],
  "limitations": [
    "Assessment is derived from deterministic lexical matching, not semantic reasoning. A configured reasoning provider may refine it, but never replaces source evidence."
  ],
  "processing_ms": 412
}
```

#### Top level

| Field | Type | Notes |
|---|---|---|
| `request_id` | `string` (non-empty) | Format `req_` + 24 hex characters, generated at the edge. |
| `version` | literal `"1"` | `SCHEMA_VERSION`. |
| `question` | `string` | Echoes the validated question. |
| `assessment` | object | See below. |
| `sources` | `Source[]` | One entry per processed source, in request order. |
| `limitations` | `string[]` | Always at least one entry when the assessment is lexical-only. |
| `processing_ms` | `integer ≥ 0` | Wall-clock duration of the whole request. |

#### `assessment`

| Field | Type | Notes |
|---|---|---|
| `status` | `"supported" \| "contradicted" \| "mixed" \| "inconclusive"` | See §4.3. |
| `basis` | `string` | Human-readable justification that cites the contributing hostnames. Required, never empty in practice. |

There is **no confidence score field**, by design. SPEC §21 forbids
marketing-style confidence numbers.

#### `sources[]`

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `requested_url` | `string` | no | The URL as supplied (after trimming). |
| `final_url` | `string` | yes | URL after redirects. |
| `status` | `integer` | yes | Final HTTP status. `null` when the source could not be retrieved. |
| `content_type` | `string` | yes | Response `content-type`. |
| `title` | `string` | yes | `<title>`, else `og:title`. |
| `canonical_url` | `string` | yes | `<link rel="canonical">`, resolved and restricted to http/https. |
| `description` | `string` | yes | `<meta name="description">`, else `og:description`. |
| `publisher` | `string` | yes | `og:site_name`, else `<meta name="application-name">`, else the hostname of `final_url`. |
| `language` | `string` | yes | The request's `language` when it is set and not `"auto"`, otherwise `<html lang>`. |
| `published_at` | `string` | yes | ISO 8601. Only emitted when a real date parses; JSON-LD `datePublished`, `article:published_time`, `<meta name="date">`, or `<time datetime>`. |
| `modified_at` | `string` | yes | ISO 8601. Only from modification-specific sources (`dateModified`, `article:modified_time`); a publication date is never reused as a modification date. |
| `retrieved_at` | `string` | no | ISO 8601. **Always the actual retrieval time**, even on a cache hit. |
| `word_count` | `integer ≥ 0` | yes | Word count of the normalised main text. |
| `content_hash_sha256` | `string` | yes | SHA-256 hex of the normalised main text. |
| `evidence` | `EvidenceItem[]` | no | May be empty. Bounded by `MAX_EVIDENCE_ITEMS`. |
| `structured_data` | object | no | `{ json_ld: unknown[], open_graph: Record<string,string> }`, both always present (possibly empty). |
| `warnings` | `SourceWarning[]` | no | May be empty. |
| `from_cache` | `boolean` | no | `true` when served from the cache rather than freshly fetched. |
| `redirect_chain` | `string[]` | no | Full redirect chain, first URL first. Empty when there were no redirects. |

`json_ld` holds the parsed JSON-LD blocks as-is (`unknown[]`), because the
document's own structured data is not forced into a fixed shape. `open_graph`
keys are lower-cased and stored **without** the `og:` prefix, so
`og:site_name` becomes `open_graph.site_name`.

#### `sources[].evidence[]` — `EvidenceItem`

| Field | Type | Required | Notes |
|---|---|---|---|
| `excerpt` | `string` | yes | Length 1–4000 characters. Truncated on a word boundary with a `…` when cut. |
| `context` | `string` | no | Where the excerpt came from, e.g. `h2:Products > p[1]`. |
| `relevance` | `"direct" \| "supporting" \| "contradictory" \| "context"` | yes | See §4.4. |

#### `sources[].warnings[]` — `SourceWarning`

| Field | Type | Notes |
|---|---|---|
| `code` | `string` (non-empty) | One of the codes listed below. |
| `message` | `string` (non-empty) | Safe to show a caller; never contains a stack trace. Query strings are stripped from URLs before they are embedded in a message. |

Observed warning codes:

| Warning code | Source | Meaning |
|---|---|---|
| `SERVED_FROM_CACHE` | `@aee/core` | The source was served from cache; the message names the original retrieval time. |
| `UPSTREAM_HTTP_FAILURE` | `@aee/fetcher`, `@aee/core` | The source returned a 4xx/5xx status. `@aee/fetcher` emits it for a status ≥ 400 that still produced a usable response; `@aee/core` adds it when the recorded status is ≥ 400. |
| `UNSUPPORTED_CONTENT_TYPE` | `@aee/fetcher` | The content type is not one the pipeline processes, so the body was omitted while the source is still reported. |
| Any public error code | `@aee/core` | A source that could not be retrieved carries the failure code: `BLOCKED_URL`, `INVALID_URL`, `TIMEOUT`, `REDIRECT_LIMIT`, `RESPONSE_TOO_LARGE`, `SSRF_ATTEMPT`, `EXTRACTION_FAILURE`, `UPSTREAM_HTTP_FAILURE`, … |

Two behaviours worth noting, because they differ from a plain reading of the
error table:

- **An unsupported content type is not a request failure.** It produces a
  source-level failure carrying the public `UNSUPPORTED_CONTENT` code (HTTP
  415): `status` is `null`, and the warning names the content type that was
  refused. The fetcher still reports the upstream status and content type.
- **A 4xx/5xx upstream status is not a request failure either.** The status is
  recorded on the source and a warning is attached; the request still succeeds
  with HTTP 200. Only transport-level problems (timeout, blocked destination,
  oversized body) remove a source's status.

A source that could not be retrieved at all appears in `sources` with
`status: null`, empty `evidence`, and a warning carrying the failure code. One
failing source never fails the whole request.

#### Cap constants

These schema-level caps exist so malformed input cannot reach the service with
absurd dimensions. They are constants in `HARD_CAPS`, not configuration.

| Constant | Value | Enforced on |
|---|---|---|
| `QUESTION_CHARS` | 2000 | request — `question.max` |
| `URLS` | 25 | request — `urls` array length |
| `MAX_SOURCES` | 25 | request — `max_sources.max`, and the service's clamp |
| `EXCERPT_CHARS` | 4000 | response — `evidence[].excerpt.max` |
| `EVIDENCE_ITEMS_PER_SOURCE` | 20 | available to producers; the response schema does not itself cap the `evidence` array length |
| `LIMITATIONS` | 50 | available to producers; the response schema does not itself cap the `limitations` array length |
| `WARNINGS` | 50 | available to producers; the response schema does not itself cap the `warnings` array length |

### 4.3 Assessment status values

`assessment.status` is one of exactly four values. It is derived by
`assess()` in `packages/core/src/assessment.ts`, which is **lexical and
deterministic** — no model, no embeddings, no randomness.

A source is *evidence-bearing* when it has at least one candidate labelled
`direct` or `supporting`. Within those candidates, the presence of a negation cue
(`not`, `no longer`, `denies`, `refutes`, `contradicts`, `debunks`, `myth`,
`ceased`, `lacks`, … — see `NEGATION_CUES`) flips that source's stance to
*contradicts*. A source whose candidates are internally mixed (some negated, some
not) is given **no stance**, because that cannot be resolved without semantics.

| Status | Meaning | When it is returned |
|---|---|---|
| `supported` | At least one source contained passages matching the question, and no source contradicted it. | `supporting > 0` and `contradicting == 0`. |
| `contradicted` | At least one source contained passages that negate the question, and no source supported it. | `contradicting > 0` and `supporting == 0`. |
| `mixed` | Sources disagreed: at least one leaned to support and at least one leaned against. | `supporting > 0` and `contradicting > 0`. |
| `inconclusive` | No passage matched closely enough — or there were no sources at all. | `supporting == 0` and `contradicting == 0`. |

`inconclusive` is the honest default. It is also what you get when the question
shares no significant terms with any retrieved document, when every source
failed, or when the caller supplied no URLs at all (that last case is rejected
earlier with `INVALID_REQUEST`).

The `basis` string always names the contributing hostnames, so a reader can see
which source produced the assessment without parsing the whole response.

### 4.4 Relevance values

| Value | Meaning in v0.1.0 |
|---|---|
| `direct` | The excerpt carries the strongest term overlap in its document (the maximum number of distinct question terms matched). |
| `supporting` | Positive term overlap, below that document's maximum. |
| `contradictory` | **Never emitted by `@aee/extraction`.** Contradiction is a semantic judgement the lexical ranker cannot make. `assess()` derives contradiction from negation cues over `direct`/`supporting` candidates instead. |
| `context` | Reserved for segments with no lexical overlap. Those are dropped before return, so this value is not emitted in v0.1.0. |

### 4.5 Worked request / response

#### Example A — a supported claim

Request:

```http
POST /v1/evidence HTTP/1.1
Host: ${PUBLIC_API_DOMAIN}
Content-Type: application/json
payment-signature: <x402 payment proof>

{
  "question": "Is Rotamech Industries a manufacturer of centrifugal pumps?",
  "urls": [
    "https://example.invalid/products",
    "https://example.invalid/about"
  ],
  "max_sources": 5,
  "language": "auto",
  "mode": "evidence"
}
```

Response `200` (abridged to one source; `processing_ms` and the hash are
illustrative):

```json
{
  "request_id": "req_3f9c1a7b2e4d4a6f8b0c1d2e",
  "version": "1",
  "question": "Is Rotamech Industries a manufacturer of centrifugal pumps?",
  "assessment": {
    "status": "supported",
    "basis": "1 source(s) contained passages matching the question (example.invalid) with no contradicting passages found."
  },
  "sources": [
    {
      "requested_url": "https://example.invalid/products",
      "final_url": "https://example.invalid/products",
      "status": 200,
      "content_type": "text/html; charset=utf-8",
      "title": "Rotamech Industries — Products",
      "canonical_url": "https://example.invalid/products",
      "description": "Rotamech Industries manufactures centrifugal pumps for industrial use.",
      "publisher": "Rotamech Industries",
      "language": "en",
      "published_at": "2024-03-01T09:00:00.000Z",
      "modified_at": null,
      "retrieved_at": "2026-09-20T21:16:07.412Z",
      "word_count": 63,
      "content_hash_sha256": "3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b",
      "evidence": [
        {
          "excerpt": "Rotamech Industries is a manufacturer of centrifugal pumps.",
          "context": "h2:Products > p[1]",
          "relevance": "direct"
        }
      ],
      "structured_data": {
        "json_ld": [
          {
            "@context": "https://schema.org",
            "@type": "Organization",
            "name": "Rotamech Industries",
            "datePublished": "2024-03-01T09:00:00Z"
          }
        ],
        "open_graph": {
          "title": "Rotamech Industries",
          "description": "Industrial centrifugal pump manufacturer.",
          "site_name": "Rotamech Industries"
        }
      },
      "warnings": [],
      "from_cache": false,
      "redirect_chain": []
    }
  ],
  "limitations": [
    "Assessment is derived from deterministic lexical matching, not semantic reasoning. A configured reasoning provider may refine it, but never replaces source evidence."
  ],
  "processing_ms": 412
}
```

#### Example B — a contradicted claim

Same question, with a registry page that explicitly negates it:

```json
{
  "question": "Is Rotamech Industries a manufacturer of centrifugal pumps?",
  "urls": ["https://example.invalid/registry-record"]
}
```

```json
{
  "request_id": "req_a1b2c3d4e5f60718293a4b5c",
  "version": "1",
  "question": "Is Rotamech Industries a manufacturer of centrifugal pumps?",
  "assessment": {
    "status": "contradicted",
    "basis": "1 source(s) contained passages that negate the question (example.invalid) with no supporting passages found."
  },
  "sources": [
    {
      "requested_url": "https://example.invalid/registry-record",
      "final_url": "https://example.invalid/registry-record",
      "status": 200,
      "content_type": "text/html; charset=utf-8",
      "title": "Registry record for Rotamech",
      "canonical_url": null,
      "description": "Registry entry.",
      "publisher": "example.invalid",
      "language": "en",
      "published_at": null,
      "modified_at": null,
      "retrieved_at": "2026-09-20T21:16:09.004Z",
      "word_count": 34,
      "content_hash_sha256": "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
      "evidence": [
        {
          "excerpt": "Rotamech Industries is not a manufacturer of centrifugal pumps.",
          "context": "h2:Registry findings > p[1]",
          "relevance": "direct"
        }
      ],
      "structured_data": { "json_ld": [], "open_graph": {} },
      "warnings": [],
      "from_cache": false,
      "redirect_chain": []
    }
  ],
  "limitations": [
    "Assessment is derived from deterministic lexical matching, not semantic reasoning. A configured reasoning provider may refine it, but never replaces source evidence."
  ],
  "processing_ms": 288
}
```

Note the honest limitation: this is a **lexical** contradiction signal. A
negation cue in a matching passage is strong evidence of disagreement, but the
service does not understand *why* the source disagrees, and it never claims to.

#### Example C — inconclusive

```json
{
  "question": "Does Rotamech Industries hold ISO 9001 certification?",
  "urls": ["https://example.invalid/weather"]
}
```

```json
{
  "request_id": "req_9f8e7d6c5b4a39281706f5e4",
  "version": "1",
  "question": "Does Rotamech Industries hold ISO 9001 certification?",
  "assessment": {
    "status": "inconclusive",
    "basis": "No passage in the 1 retrieved source(s) matched the question closely enough to support or contradict it."
  },
  "sources": [
    {
      "requested_url": "https://example.invalid/weather",
      "final_url": "https://example.invalid/weather",
      "status": 200,
      "content_type": "text/html; charset=utf-8",
      "title": "Weather forecast",
      "canonical_url": null,
      "description": null,
      "publisher": "example.invalid",
      "language": "en",
      "published_at": null,
      "modified_at": null,
      "retrieved_at": "2026-09-20T21:16:10.117Z",
      "word_count": 26,
      "content_hash_sha256": "4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce",
      "evidence": [],
      "structured_data": { "json_ld": [], "open_graph": {} },
      "warnings": [],
      "from_cache": false,
      "redirect_chain": []
    }
  ],
  "limitations": [
    "Assessment is derived from deterministic lexical matching, not semantic reasoning. A configured reasoning provider may refine it, but never replaces source evidence.",
    "1 source(s) contributed no directly matching passage and were not used to reach the assessment."
  ],
  "processing_ms": 203
}
```

#### Example D — partial failure

Two URLs where one redirects to a blocked destination. The good source is still
returned; the bad one appears with a warning.

```json
{
  "request_id": "req_00112233445566778899aabb",
  "version": "1",
  "question": "Is Rotamech Industries a manufacturer of centrifugal pumps?",
  "assessment": {
    "status": "supported",
    "basis": "1 source(s) contained passages matching the question (example.invalid) with no contradicting passages found."
  },
  "sources": [
    {
      "requested_url": "https://example.invalid/products",
      "final_url": "https://example.invalid/products",
      "status": 200,
      "content_type": "text/html; charset=utf-8",
      "title": "Rotamech Industries — Products",
      "canonical_url": null,
      "description": null,
      "publisher": "Rotamech Industries",
      "language": "en",
      "published_at": null,
      "modified_at": null,
      "retrieved_at": "2026-09-20T21:16:12.550Z",
      "word_count": 63,
      "content_hash_sha256": "3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b",
      "evidence": [
        {
          "excerpt": "Rotamech Industries is a manufacturer of centrifugal pumps.",
          "context": "h2:Products > p[1]",
          "relevance": "direct"
        }
      ],
      "structured_data": { "json_ld": [], "open_graph": {} },
      "warnings": [],
      "from_cache": false,
      "redirect_chain": []
    },
    {
      "requested_url": "https://example.invalid/redirect-to-private",
      "final_url": null,
      "status": null,
      "content_type": null,
      "title": null,
      "canonical_url": null,
      "description": null,
      "publisher": null,
      "language": null,
      "published_at": null,
      "modified_at": null,
      "retrieved_at": "2026-09-20T21:16:12.551Z",
      "word_count": null,
      "content_hash_sha256": null,
      "evidence": [],
      "structured_data": { "json_ld": [], "open_graph": {} },
      "warnings": [
        {
          "code": "BLOCKED_URL",
          "message": "The supplied URL resolves to a destination that is not allowed."
        }
      ],
      "from_cache": false,
      "redirect_chain": []
    }
  ],
  "limitations": [
    "Assessment is derived from deterministic lexical matching, not semantic reasoning. A configured reasoning provider may refine it, but never replaces source evidence.",
    "1 of 2 source(s) could not be retrieved; see per-source warnings."
  ],
  "processing_ms": 631
}
```

---

## 5. Error codes

Every non-2xx JSON response from the Worker or the backend uses exactly one
envelope:

```json
{
  "error": {
    "code": "INVALID_URL",
    "message": "The supplied URL is invalid or unsupported.",
    "request_id": "req_3f9c1a7b2e4d4a6f8b0c1d2e"
  }
}
```

`details` is an optional object present only when a code carries structured
context — for example `INVALID_REQUEST` from the evidence engine includes a
`sources`-style `issues` array with per-field `path` and `message` entries.

Codes are stable. Clients switch on `error.code`; codes are never renamed or
repurposed without an API version bump.

| Code | HTTP | Meaning |
|---|---|---|
| `INVALID_REQUEST` | `400` | The request body failed schema validation, was not valid JSON, had no usable source, exceeded `MAX_URLS_PER_REQUEST`, or targeted an unknown path. |
| `INVALID_URL` | `400` | The URL is syntactically invalid, malformed, or uses an unsupported scheme (anything other than `http`/`https`, including `file:`). |
| `BLOCKED_URL` | `400` | The URL resolved to a destination that is not allowed: localhost or a localhost alias, loopback, private/RFC1918, link-local, multicast, unspecified, private IPv6, or a cloud metadata endpoint. |
| `SSRF_ATTEMPT` | `400` | The request looks like a deliberate SSRF attempt (for example encoded or alternate IP representations of a blocked destination). |
| `TIMEOUT` | `504` | The fetch exceeded the total request timeout or the connect timeout. |
| `REDIRECT_LIMIT` | `502` | The redirect chain exceeded `MAX_REDIRECTS`. |
| `UNSUPPORTED_CONTENT` | `415` | The source returned a content type this service does not process. |
| `RESPONSE_TOO_LARGE` | `502` | The response body exceeded `MAX_RESPONSE_BYTES`. |
| `UPSTREAM_HTTP_FAILURE` | `502` | The source returned a 4xx or 5xx status. |
| `EXTRACTION_FAILURE` | `500` | The fetch succeeded but the document could not be processed. |
| `PAYMENT_REQUIRED` | `402` | Payment is required to access this resource. |
| `PAYMENT_INVALID` | `402` | The supplied payment proof failed verification. |
| `PAYMENT_EXPIRED` | `402` | The supplied payment proof has expired. |
| `RATE_LIMIT` | `429` | The caller exceeded the allowed request rate. |
| `INTERNAL_ERROR` | `500` | An internal failure. A stack trace is never exposed. |
| `NOT_FOUND` | `404` | No such endpoint. Both the Worker and the backend answer 404 with this code. |
| `UNAUTHORIZED` | `401` | Missing or incorrect server-to-server credential. Backend/internal only — customers never see this. |
| `BACKEND_UNREACHABLE` | `502` | The Worker could not reach the backend origin (including its own 30 s timeout). |
| `NOT_CONFIGURED` | `503` | A required dependency — `BACKEND_ORIGIN_URL` or `BACKEND_AUTH_SECRET` — is not configured. |

Example error responses:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "question is required and must be a non-empty string",
    "request_id": "req_7d3e1f0a9b8c7d6e5f4a3b2c"
  }
}
```

```json
{
  "error": {
    "code": "PAYMENT_REQUIRED",
    "message": "Payment is required to access this resource.",
    "request_id": "req_5c4b3a291807f6e5d4c3b2a1"
  }
}
```

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "The request body is invalid.",
    "request_id": "req_1a2b3c4d5e6f708192a3b4c5",
    "details": {
      "issues": [
        { "path": "question", "message": "String must contain at most 2000 character(s)" }
      ]
    }
  }
}
```

### Two validation layers

The Worker performs a deliberately shallow check before spending an x402
verification round-trip:

| Check | Worker | Backend (`EvidenceService`) |
|---|---|---|
| Body is a JSON object | yes | yes |
| `question` is a non-empty string | yes | yes (trimmed, ≤ 2000) |
| `urls` is an array of strings | yes | yes (≤ 25, ≤ `MAX_URLS_PER_REQUEST`) |
| `max_sources`, `language`, `mode` | no | yes |
| At least one URL present | no | yes |
| URL safety (SSRF) | no | yes, in `@aee/fetcher` |

The Worker's check exists only to reject obvious junk early. The authoritative
validation is the zod schema in `@aee/schemas` applied by the backend.

---

## 6. Resource limits

Every effective limit is environment-driven. Defaults come from `DEFAULT_LIMITS`
in `packages/schemas/src/evidence.ts`; the environment variable names are read in
`packages/core/src/config.ts`.

| Environment variable | Default | Bounds |
|---|---|---|
| `MAX_CONCURRENT_FETCHES` | `4` | Simultaneous outbound fetches across the process. Enforced by a counting semaphore in `EvidenceService`. |
| `RATE_LIMIT_PER_MINUTE` | `60` | Sustained requests per minute per caller. `0` disables limiting. Exceeding it returns `RATE_LIMIT` (429) with a `Retry-After` header. Keyed on `CF-Connecting-IP`, then the first `X-Forwarded-For` entry, then the socket address. |
| `RATE_LIMIT_BURST` | `20` | Additional burst allowance above the sustained rate (bucket capacity = `RATE_LIMIT_PER_MINUTE + RATE_LIMIT_BURST`). |
| `MAX_URLS_PER_REQUEST` | `5` | URLs accepted per evidence request. Exceeding it is `INVALID_REQUEST`. |
| `MAX_RESPONSE_BYTES` | `2097152` (2 MiB) | Maximum response body size per source. |
| `MAX_REDIRECTS` | `5` | Maximum redirect hops per source. Exceeding it is `REDIRECT_LIMIT`. |
| `REQUEST_TIMEOUT_MS` | `10000` | Total request timeout per source. |
| `CONNECT_TIMEOUT_MS` | `5000` | Connection-establishment timeout per source. |
| `CACHE_TTL_SECONDS` | `86400` | How long a cached source stays valid. |
| `MAX_EVIDENCE_ITEMS` | `5` | Evidence items returned per source. |
| `MAX_EXCERPT_CHARS` | `600` | Maximum excerpt length. Bounded above by the schema cap of 4000. |

Adjacent configuration that shapes behaviour but is not a hard "limit":

| Environment variable | Default | Purpose |
|---|---|---|
| `CACHE_ENABLED` | `true` | Turn the cache off entirely. |
| `CACHE_DB_PATH` | `./data/cache.sqlite` | SQLite file location. Mount this on a persistent volume. |
| `CACHE_MAX_ENTRIES` | `5000` | Hard upper bound on retained cache rows; oldest evicted first. |
| `FETCH_USER_AGENT` | `AgentEvidenceAPI/0.1.0 (+https://example.invalid/bot)` | Clearly identifiable User-Agent (SPEC §19). |
| `ROBOTS_POLICY` | `warn` | `ignore` \| `warn` \| `enforce`. Must be one of those three or startup fails. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |

### Current enforcement status

Be aware of what is enforced today versus designed:

- **Enforced:** `MAX_CONCURRENT_FETCHES` (semaphore in `EvidenceService`),
  `MAX_URLS_PER_REQUEST`, de-duplication, `MAX_EVIDENCE_ITEMS`,
  `MAX_EXCERPT_CHARS`, `CACHE_TTL_SECONDS`, `CACHE_MAX_ENTRIES`, the schema
  caps, and — in `@aee/fetcher` — `MAX_RESPONSE_BYTES`, `MAX_REDIRECTS`,
  `REQUEST_TIMEOUT_MS`, and `CONNECT_TIMEOUT_MS`. `EvidenceService` switches on
  the resulting `FetchError` codes.
- **Not enforced:** `ROBOTS_POLICY`. It is read from the environment and
  validated at startup, but nothing consumes `config.fetch.robotsPolicy`, so all
  three values currently behave as `ignore`. See
  [`security.md`](./security.md#robots_policy).

---

## 7. Caching and provenance

- Cache keys are normalised URLs (`cacheKey`): scheme and host lower-cased,
  fragment stripped, default ports collapsed, userinfo dropped, tracking
  parameters (`utm_*`, `fbclid`, `gclid`, `ref`, `mc_cid`, `mc_eid`) removed,
  remaining query parameters sorted by name then value, and a single trailing
  slash removed unless the path is `/`.
- Only the derived representation is cached — extracted document, evidence
  candidates, and response metadata. **The raw page is never stored**, so the
  cache cannot grow into an unbounded content archive.
- A cache hit sets `from_cache: true`, adds a `SERVED_FROM_CACHE` warning naming
  the original retrieval time, and reports that original time in `retrieved_at`.
  Stale evidence is never presented as fresh.
- A response containing at least one cache hit gains this entry in
  `limitations`: *"Some sources were served from cache. Each source reports its
  actual retrieval time."*
- A cache failure never fails a request. Lookup and store errors are logged and
  the request continues against the live network.

---

## 8. Observability

Structured JSON logs, one object per line, with a request ID on every request
(SPEC §24). Recorded fields include duration, source count, successful and failed
fetch counts, cache hits and misses, and the assessment status. The service
never logs secrets: the logger deep-redacts any key matching
`secret|token|password|passwd|authorization|cookie|api_key|private_key|signature`
before serialisation.

### Status

Both public endpoints (`/health`, `/`) and the `POST /v1/evidence` forwarding
path are implemented in `apps/worker/src/index.ts`. The backend that serves
`/internal/v1/evidence` is implemented in `apps/backend/src/app.ts`, including
the shared-secret hook and the canonical error envelope. `packages/mcp` also
delegates to the same `EvidenceService`.

`pnpm typecheck` passes across the workspace. The suites have **not** been run in
this environment, so request-level behaviour below is documented from the source
and from the fixture-backed test cases, not from an observed run.

### One status-code inconsistency between the two layers

Both the Worker and the backend answer an unknown path with the
`INVALID_REQUEST` code, but they disagree on the HTTP status:

| Layer | Unknown path | Status |
|---|---|---|
| Worker (`app.notFound`) | any unmatched route | `400` |
| Backend (`app.setNotFoundHandler`) | any unmatched route | `404` |

A customer-facing call hits the Worker, so `400` is what a caller actually sees
for a bad path. If you rely on `404` semantics, note that the two layers differ.
