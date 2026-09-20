# Agent Evidence API — Specification

_This is the project specification transcribed from the source PDF "Agent Evidence API" (39 pages)._

You are DeepSeek Harness (DSH) operating as the primary autonomous engineering agent for this project.

Build a production-minded MVP called:

Agent Evidence API

The product is a globally usable, MCP-native, x402-paid infrastructure service for AI agents.

Its core job is:

Give an AI agent structured, traceable, fresh evidence from public web pages so the agent can verify claims, compare information, and ground its answers in sources.

Do not turn this into a generic SaaS dashboard, conventional subscription product, Saudi-only service, or a broad collection of unrelated APIs.

The first release must have one clear capability:

agent-accessible web evidence and claim verification

The product must be usable by an AI agent through both:

1. HTTP API
2. MCP server

The public payment mechanism must be:

x402 + USDC on Base

The public edge/gateway must run on:

Cloudflare Workers Free

The heavier web-fetching and processing workloads must run on my existing Linux VPS.

The system must remain independent of DSH. DSH is only the development harness.

## 1. IMPORTANT OPERATING RULES

Before changing anything:

1. Inspect the current machine, OS, Node.js, npm/pnpm, Docker, Git, DSH, network configuration, and available disk/RAM.
2. Verify whether this project already exists.
3. If it does not exist, create it at: `/srv/agent-evidence-api`
4. Work only inside this project unless a change outside it is absolutely required for deployment.
5. Do NOT modify unrelated DSH configuration.
6. Do NOT modify unrelated Kilo Code configuration.
7. Do NOT modify unrelated SSH configuration.
8. Do NOT modify unrelated repositories.
9. Do NOT install large unnecessary system packages.
10. Do NOT create Kubernetes, Terraform, a complex CI platform, or a large frontend.
11. Do NOT build user accounts, passwords, social login, subscriptions, organizations, teams, billing dashboards, mobile applications, or an admin panel.
12. Do NOT create CLAUDE.md, .cursorrules, GEMINI.md, or other competing project rule books.
13. The sole project instruction file must be: `AGENTS.md`
14. All project-specific engineering rules must live in AGENTS.md.
15. Keep the architecture model/harness agnostic.
16. Do not hard-code DeepSeek as the production intelligence provider.
17. Prefer interfaces and adapters over vendor-specific implementation.
18. Use current official package/documentation guidance where available instead of guessing APIs.
19. Do not silently substitute obsolete x402 or MCP implementations.
20. Do not claim success until the complete local end-to-end flow works.

Do not ask me unnecessary questions. Make reasonable engineering decisions and continue.

## 2. ENVIRONMENT

Assume the primary development environment is my existing GreenCloud Linux VPS.

Known approximate resources:

- 4 vCPU AMD EPYC Milan
- 8 GB RAM
- 60 GB NVMe storage
- Linux
- Docker available or installable if required
- DeepSeek Harness installed
- DSH is being used as the coding/development harness
- The server may also be used for other unrelated projects

Because the machine is small, design for:

- low memory usage
- bounded concurrency
- bounded response size
- bounded browser usage
- no unnecessary background workers
- no memory-heavy databases
- no unnecessary containers

## 3. PRODUCT POSITIONING

Do not position this as:

- a web scraper
- an SEO tool
- a generic crawler
- a proxy
- a browser automation service
- a search engine

Position it as:

Evidence infrastructure for AI agents.

The agent provides a question/claim and optionally one or more URLs.

The service fetches public sources, extracts useful evidence, normalizes the content, records provenance, and returns a structured evidence package.

Example:

An agent asks:

"Is Company X actually a manufacturer of centrifugal pumps?"

The agent can provide several candidate URLs.

The service returns structured findings such as:

- question
- source URL
- final URL after redirects
- HTTP status
- title
- publisher/domain
- canonical URL
- language
- publication/update dates when available
- relevant evidence excerpt
- evidence location/context
- extracted structured metadata
- retrieval timestamp
- normalized content hash
- content type
- warnings
- source agreement/disagreement
- final assessment when deterministic evidence supports one

Do not invent facts.

Do not pretend a source says something it does not say.

Do not expose unsupported confidence scores.

When semantic interpretation is uncertain, explicitly return:

inconclusive

rather than guessing.

## 4. MVP PRODUCT INTERFACE

Implement these public interfaces.

### A. Health endpoint

`GET /health`

Free.

Returns a small JSON response similar to:

```json
{
  "status": "ok",
  "service": "agent-evidence-api",
  "version": "0.1.0"
}
```

No secrets.

No internal infrastructure information.

### B. Main HTTP API

`POST /v1/evidence`

This is the primary paid resource.

Use x402.

Suggested input:

```json
{
  "question": "Is Company X a manufacturer of centrifugal pumps?",
  "urls": [
    "https://example.com/about",
    "https://example.com/products"
  ],
  "max_sources": 5,
  "language": "auto",
  "mode": "evidence"
}
```

Requirements:

- question required
- urls optional but at least one of urls or another supported source mechanism must eventually be present
- maximum URLs must be configurable
- maximum source count must be configurable
- reject malformed URLs
- reject unsupported schemes
- protect against SSRF
- apply fetch timeout
- apply maximum response size
- apply maximum redirect count
- validate every redirect hop
- reject local/private/loopback/link-local/metadata endpoints
- reject dangerous ports
- reject file://
- reject invalid IP representations
- protect against DNS rebinding
- prevent localhost aliases
- prevent cloud metadata access
- prevent internal network access
- do not bypass authentication
- do not bypass paywalls
- do not attempt CAPTCHA solving
- do not evade anti-bot mechanisms
- do not defeat access controls

## 5. RESPONSE SCHEMA

Return structured JSON.

Use a versioned response schema.

Suggested shape:

```json
{
  "request_id": "req_...",
  "version": "1",
  "question": "...",
  "assessment": {
    "status": "supported|contradicted|mixed|inconclusive",
    "basis": "..."
  },
  "sources": [
    {
      "requested_url": "...",
      "final_url": "...",
      "status": 200,
      "content_type": "text/html",
      "title": "...",
      "canonical_url": "...",
      "description": "...",
      "publisher": "...",
      "language": "en",
      "published_at": null,
      "modified_at": null,
      "retrieved_at": "...",
      "word_count": 1234,
      "content_hash_sha256": "...",
      "evidence": [
        {
          "excerpt": "...",
          "context": "...",
          "relevance": "direct|supporting|contradictory|context"
        }
      ],
      "structured_data": {
        "json_ld": [],
        "open_graph": {}
      },
      "warnings": []
    }
  ],
  "limitations": [],
  "processing_ms": 123
}
```

Keep excerpts short.

Do not return entire pages by default.

Do not create a bulk content dump service.

The response should be optimized for AI-agent consumption rather than human browsing.

## 6. EVIDENCE ENGINE

Build a clean internal pipeline:

```text
request
↓
validation
↓
source acquisition
↓
redirect validation
↓
HTTP fetch
↓
content-type detection
↓
HTML parsing
↓
metadata extraction
↓
main-content extraction
↓
normalization
↓
evidence candidate extraction
↓
cross-source comparison
↓
structured response
```

The architecture should allow later replacement or addition of:

- search providers
- browser providers
- LLM reasoning providers
- document parsers
- specialized extraction modules

without rewriting the core service.

## 7. WEB FETCHING

For normal HTML pages:

Extract at least:

- title
- meta description
- canonical
- Open Graph metadata
- JSON-LD
- language
- publication date
- modified date
- main text
- headings where useful
- links relevant to evidence
- word count

Normalize content:

- normalize whitespace
- normalize line endings
- remove irrelevant boilerplate
- normalize repeated navigation
- preserve meaningful text order
- generate SHA-256 hash of normalized content

Record:

- initial URL
- final URL
- redirect chain
- status code
- content type
- content length
- retrieval timestamp
- processing duration

Use deterministic processing wherever practical.

## 8. SEARCH SUPPORT

Do NOT make a third-party paid search API mandatory for the MVP.

The first functional MVP must work using agent-supplied URLs.

Design a provider interface for future search support:

```text
SearchProvider
search(query)
return normalized source candidates
```

Potential future providers may include:

- external search APIs
- self-hosted search
- enterprise search
- specialized databases

But do not make those dependencies required for version 0.1.

The product should complement agent search rather than trying to replace every search engine.

## 9. OPTIONAL SEMANTIC REASONING LAYER

Create an abstraction such as:

`ReasoningProvider`

It must not be hard-wired to DeepSeek, OpenAI, Anthropic, or any other vendor.

The MVP should remain useful without an LLM.

Deterministic mode must:

- fetch sources
- extract evidence
- identify matching passages
- compare source metadata
- detect direct agreement/conflict where possible
- return inconclusive when semantic interpretation cannot be safely determined

If an LLM provider is configured later, it may be used for:

- claim decomposition
- evidence relevance ranking
- source comparison
- structured synthesis

But the implementation must preserve source provenance.

Never allow the LLM to replace source evidence with unsupported prose.

Keep the provider interface generic enough to support OpenAI-compatible APIs.

## 10. MCP SERVER

Implement a proper remote MCP server.

Primary transport should be:

Streamable HTTP

Expose a small number of carefully designed tools.

Do not create dozens of tools.

Primary paid tool:

`research_evidence`

Description should be extremely clear and agent-oriented.

Example intent:

"Fetch public web sources and return structured, cited evidence for a question or claim. Use this when you need source-grounded verification, comparison, or evidence extraction. Returns source URLs, retrieved timestamps, short evidence excerpts, metadata, and an explicit supported/contradicted/mixed/inconclusive assessment."

Tool inputs should map cleanly to the HTTP API.

Suggested inputs:

```text
question: string
urls?: string[]
max_sources?: number
language?: string
mode?: "evidence"
```

Optional free tool:

`health`

Simple health/status check.

Do not create account-management tools.

Do not create payment-management tools.

Do not create administrative tools.

## 11. x402 PAYMENT

Implement x402 for paid HTTP and MCP usage.

Production blockchain network:

Base

Testing network:

Base Sepolia

Settlement token:

USDC

Do not invent a custom payment protocol.

Do not create API keys for paid access.

Do not create user accounts.

The request flow must be:

```text
Agent
↓
MCP/HTTP request
↓
402 Payment Required
↓
Agent pays USDC
↓
Agent retries with payment proof
↓
Payment verification
↓
Evidence job executes
↓
Structured response
```

Use the current official x402 integration supported by the chosen Cloudflare/MCP implementation rather than hand-implementing the protocol unless absolutely necessary.

The architecture must support:

- Base Sepolia for tests
- Base for production
- configurable recipient wallet
- configurable facilitator
- configurable price

Never hard-code a private key.

Never commit a wallet private key.

Never store a customer wallet private key.

## 12. PRICING

Make pricing configurable through environment variables.

Use a very small MVP price.

Start with a configurable default approximately equivalent to:

$0.03 per evidence request

Do not assume the final commercial price is fixed.

Create configuration such as:

```text
X402_NETWORK
X402_RECIPIENT
X402_FACILITATOR_URL
X402_PRICE_USD
```

For testnet use a clearly separate environment/config.

Do not mix testnet and production wallet configuration.

## 13. CLOUDFLARE WORKER

Build a separate Cloudflare Worker package.

Suggested project structure:

```text
agent-evidence-api/
AGENTS.md
apps/
backend/
worker/
mcp/
```

The Worker is the public edge.

The Worker must remain lightweight because it is intended to run on the Cloudflare Workers Free plan.

Do not run heavy HTML extraction, browser automation, or expensive reasoning inside the Worker.

The Worker should:

1. receive the request
2. perform x402 payment gating
3. validate basic request structure
4. forward authorized requests to the backend
5. return the backend result
6. expose the MCP endpoint
7. expose health/capabilities endpoints

Keep Worker CPU usage minimal.

Avoid unnecessary middleware.

Avoid large npm dependencies.

Do not build a database inside the Worker for the MVP unless there is a clear reason.

Do not depend on Durable Objects for the first release.

Do not depend on Workers Paid-only capabilities.

## 14. BACKEND VPS SERVICE

Use:

Node.js + TypeScript

Prefer:

Fastify

unless there is a compelling current ecosystem reason to use another framework.

Backend responsibilities:

- URL validation
- SSRF defense
- HTTP fetching
- parsing
- extraction
- normalization
- evidence processing
- optional semantic reasoning
- response generation
- caching
- logging
- metrics

Expose a health endpoint.

Keep the internal backend API separate from the public payment layer.

Example internal endpoint:

`POST /internal/v1/evidence`

The internal endpoint must NOT be publicly usable without authorization.

Use a server-to-server authentication mechanism such as:

- shared secret
- HMAC request signing

Do not expose the authentication secret to customers.

## 15. ORIGIN PROTECTION

Design so customers cannot simply bypass the Worker and call the backend directly to avoid payment.

Preferred deployment:

```text
Internet
↓
Cloudflare Worker
↓
protected origin
↓
VPS backend
```

A Cloudflare Tunnel may be used where appropriate.

If a public origin is used instead, require:

- authenticated Worker-to-origin requests
- firewall hardening
- HTTPS
- origin secrets stored only server-side
- no exposed administrative ports

Do not assume obscurity is security.

## 16. CACHING

Implement a simple bounded cache.

Initially use SQLite or another lightweight local store.

Cache candidates may include:

- URL
- final URL
- retrieved timestamp
- response metadata
- normalized content hash
- extracted metadata
- normalized text or safely bounded evidence representation

Use configurable TTL.

Do not store unlimited source content.

Do not allow the cache to grow without bound.

Implement cleanup.

The cache must reduce redundant fetches without causing stale evidence to appear fresh.

Always return the actual retrieval time.

## 17. DATABASE

Use SQLite for the MVP unless there is a demonstrated need for another database.

Do not introduce PostgreSQL.

Do not introduce Redis.

Do not introduce Kafka.

Do not introduce Elasticsearch.

Do not introduce a vector database.

This is intentionally a small infrastructure product.

Design repository/data-access interfaces so the database can later be replaced.

## 18. SECURITY

Treat the web fetcher as a security-sensitive component.

Implement robust SSRF protection.

At minimum:

- allow only http and https
- reject localhost
- reject loopback addresses
- reject RFC1918/private IPv4
- reject link-local
- reject multicast
- reject unspecified addresses
- reject IPv6 loopback
- reject IPv6 link-local
- reject private IPv6 ranges
- block cloud metadata addresses
- validate hostname resolution
- validate resolved IPs
- validate every redirect
- detect DNS rebinding scenarios
- restrict ports
- enforce connection timeout
- enforce total request timeout
- enforce maximum redirects
- enforce maximum response bytes
- reject suspicious content types when unnecessary
- prevent decompression bombs
- enforce concurrency limits
- avoid shell execution of URLs
- never pass raw URLs into shell commands
- do not follow arbitrary local file references
- sanitize logs
- do not log payment secrets
- do not log origin secrets

Add security tests for every one of these classes.

## 19. ROBOTS AND ACCESS BEHAVIOR

This service is intended for public web evidence retrieval.

Do not bypass access controls.

Do not attempt to defeat bot protections.

Do not automate login.

Do not circumvent paywalls.

Do not solve CAPTCHAs.

Use a clearly identifiable User-Agent.

Implement a configurable robots-policy behavior where practical.

Document that users should only submit URLs that the service is permitted to access.

Keep the MVP focused on publicly accessible web resources.

## 20. CONTENT SAFETY AND DATA MINIMIZATION

The service should primarily process public websites and business/public information.

Do not create functionality specifically intended to collect personal profiles, private information, passwords, private messages, or restricted data.

Do not store unnecessary personal data.

Do not retain full web pages indefinitely.

Return concise evidence excerpts rather than reproducing entire copyrighted documents.

Add configurable retention behavior.

Document data retention clearly.

## 21. RESPONSE QUALITY

Every evidence result must preserve provenance.

Each evidence item should be traceable to:

- exact source URL
- final URL
- retrieval timestamp
- short excerpt
- source title where available
- source domain
- content hash

Never output an uncited factual conclusion when the source information is unavailable.

Use explicit statuses:

```text
supported
contradicted
mixed
inconclusive
```

Do not use marketing-style confidence scores.

## 22. API ERROR DESIGN

Create consistent machine-readable errors.

Example:

```json
{
  "error": {
    "code": "INVALID_URL",
    "message": "The supplied URL is invalid or unsupported.",
    "request_id": "req_..."
  }
}
```

Define stable error codes for:

- invalid request
- invalid URL
- blocked URL
- SSRF attempt
- timeout
- redirect limit
- unsupported content
- response too large
- upstream HTTP failure
- extraction failure
- payment required
- payment invalid
- payment expired
- rate limit
- internal error

Never expose stack traces in production responses.

## 23. RATE LIMITING

Implement bounded concurrency.

Do not allow one customer or one request to consume all VPS resources.

Configuration examples:

```text
MAX_CONCURRENT_FETCHES
MAX_URLS_PER_REQUEST
MAX_RESPONSE_BYTES
MAX_REDIRECTS
REQUEST_TIMEOUT_MS
CACHE_TTL_SECONDS
MAX_EVIDENCE_ITEMS
```

Make all resource limits configurable.

## 24. OBSERVABILITY

Implement structured JSON logs.

Each request should have a request ID.

Log enough information to diagnose failures without logging secrets.

Record:

- request ID
- request type
- duration
- number of sources
- successful fetch count
- failed fetch count
- cache hit/miss
- payment verification outcome
- high-level error code

Never log:

- private keys
- wallet secrets
- origin secrets
- complete payment signatures unless specifically required for secure debugging
- arbitrary sensitive request payloads

Add a simple health/readiness check.

## 25. PROJECT STRUCTURE

Create a clean monorepo or similarly clear structure.

Preferred:

```text
agent-evidence-api/
├── AGENTS.md
├── README.md
├── .env.example
├── .gitignore
├── package.json
├── pnpm-workspace.yaml
├── docs/
│ ├── architecture.md
│ ├── api.md
│ ├── mcp.md
│ ├── x402.md
│ ├── security.md
│ ├── deployment.md
│ └── discovery.md
├── apps/
│ ├── backend/
│ └── worker/
├── packages/
│ ├── core/
│ ├── schemas/
│ ├── fetcher/
│ ├── extraction/
│ ├── cache/
│ └── mcp/
├── tests/
└── docker/
```

You may improve the exact structure if a simpler architecture is clearly better.

Avoid premature abstraction.

## 26. TESTING

Testing is a hard acceptance criterion.

Write automated tests for:

### URL validation

- valid HTTP
- valid HTTPS
- malformed URL
- localhost
- private IP
- IPv6 loopback
- metadata endpoint
- dangerous port
- unsupported scheme
- encoded bypass attempts
- decimal/octal/hex IP tricks where applicable
- redirect to private address
- DNS rebinding-sensitive cases

### HTTP

- 200
- 3xx redirect
- redirect chain
- 4xx
- 5xx
- timeout
- oversized response
- wrong content type
- malformed HTML

### Extraction

- title
- description
- canonical
- Open Graph
- JSON-LD
- language
- dates
- main text
- headings
- content hashing

### Evidence

- relevant source
- irrelevant source
- conflicting sources
- insufficient evidence
- multiple sources agreeing

### Cache

- miss
- hit
- expiration
- invalidation
- bounded retention

### x402

Test both:

1. request without payment → 402
2. valid testnet payment → successful request

Use Base Sepolia for automated payment tests where practical.

Never put a production private key into automated tests.

### MCP

Test:

- server startup
- tool listing
- tool schema
- tool invocation
- paid invocation
- payment-required response
- successful payment flow
- malformed arguments
- server error handling

## 27. END-TO-END ACCEPTANCE TEST

The following scenario must work before declaring completion:

```text
Agent/client
↓
POST /v1/evidence
↓
402 Payment Required
↓
test client creates valid Base Sepolia payment
↓
request retried with payment proof
↓
Worker validates payment
↓
Worker forwards authorized request
↓
VPS backend validates URLs
↓
VPS fetches public test pages
↓
HTML is parsed
↓
evidence is extracted
↓
structured response is generated
↓
payment response returned
↓
client receives JSON
```

Create a deterministic local fixture server for testing instead of relying only on random real websites.

The real-world integration test may additionally use one or two stable public pages.

## 28. MCP REGISTRY READINESS

Prepare the MCP server for publication to the official MCP Registry.

Create the required metadata file:

`server.json`

Use the current official schema.

Do not invent registry fields.

Prepare:

- server name
- description
- repository metadata
- version
- remote transport information
- package metadata where applicable
- installation information

Also create documentation explaining the publication process.

Do NOT automatically publish to the registry unless credentials and authorization are explicitly available.

Instead:

1. validate the server.json
2. document the exact publish steps
3. create a checklist for namespace ownership/authentication
4. make the project registry-ready

The project should be easy to publish later using the official mcp-publisher workflow.

## 29. AGENT DISCOVERABILITY

Create:

`docs/discovery.md`

Document a realistic discovery strategy.

The project should be discoverable through:

- official MCP Registry
- GitHub repository
- npm/package metadata where appropriate
- clear MCP server descriptions
- machine-readable metadata
- documentation
- agent-oriented tool descriptions

Tool descriptions should explicitly contain useful phrases such as:

- web evidence
- source verification
- claim verification
- evidence extraction
- source-grounded research
- compare sources
- cited evidence
- fresh web evidence

Do not keyword-stuff.

Descriptions must be truthful.

## 30. README

Write a strong README aimed at:

AI-agent developers and MCP users

The README must explain:

1. What the service does
2. Why an agent would use it
3. Example use case
4. MCP usage
5. HTTP usage
6. x402 payment flow
7. Base / Base Sepolia
8. pricing configuration
9. local development
10. deployment
11. security
12. limitations
13. registry publication

Show example requests and responses.

Do not market it with exaggerated claims such as:

- "the world's best"
- "100% accurate"
- "hallucination-free"
- "guaranteed truth"

The product provides evidence, not absolute truth.

## 31. DEPLOYMENT

Create a production-minded but simple deployment.

Preferred:

```text
Cloudflare Worker
↓
protected origin
↓
Docker container
↓
Node.js backend
↓
SQLite
```

Create:

- Dockerfile
- docker-compose.yml
- production env template
- development env template
- health check
- restart policy
- persistent volume for SQLite/cache if Docker is used

Do not introduce Kubernetes.

Do not introduce Terraform.

Do not introduce a full observability stack.

## 32. CLOUDFLARE CONFIGURATION

Create Worker configuration for:

Development:

base-sepolia

Production:

base

Use environment variables/secrets for:

- x402 recipient
- facilitator URL
- backend URL
- backend auth secret
- pricing
- optional API configuration

Never commit secrets.

Provide:

`.dev.vars.example`

or the appropriate current Cloudflare local-secret configuration.

Do not use production wallet configuration in development.

## 33. DOMAIN PLACEHOLDERS

Do not assume I already own a specific domain.

Use placeholders in configuration such as:

```text
PUBLIC_API_DOMAIN
BACKEND_ORIGIN_URL
MCP_PUBLIC_URL
```

Do not invent a real domain.

Do not invent a wallet address.

Do not invent credentials.

## 34. VERSIONING

Start product version at:

0.1.0

API version:

v1

Keep API schemas stable.

Add a clear version field to responses.

Do not prematurely support multiple major API versions.

## 35. GIT

Initialize Git only if the project is not already a Git repository.

Create an appropriate .gitignore.

Do not delete unrelated Git history.

Do not force-push.

Do not change remote repositories.

Do not push to GitHub automatically.

At the end, provide:

- current branch
- files created
- tests run
- deployment status
- remaining manual credentials/configuration

## 36. DO NOT OVERBUILD

The MVP must NOT include:

- frontend dashboard
- user accounts
- subscriptions
- email
- payments dashboard
- CRM
- mobile apps
- browser extension
- Kubernetes
- Terraform
- Redis
- PostgreSQL
- Elasticsearch
- vector database
- proprietary autonomous agent
- multi-agent orchestration platform
- job marketplace
- NFT/token
- cryptocurrency token
- Saudi-only datasets
- massive scraping infrastructure
- arbitrary site bypassing
- CAPTCHA solving
- login automation
- private-data collection

The goal is a small, excellent piece of agent infrastructure.

## 37. FUTURE EXTENSION POINTS

Prepare interfaces, but do not implement all of these now:

```text
SearchProvider
BrowserProvider
ReasoningProvider
DocumentProvider
EvidenceRanker
SourceTrustProvider
CacheProvider
PaymentProvider
```

Future products could eventually add:

- search-backed research
- PDF evidence
- image evidence
- browser rendering
- structured company research
- source-change detection
- fresh-source verification
- domain/company/entity resolution
- specialized data packs

Do not build these unless they are necessary for the MVP architecture.

## 38. COMMERCIAL DESIGN PRINCIPLE

The product is infrastructure for agents.

The agent should not have to:

- create an account
- create a password
- request an API key
- subscribe to a monthly plan
- contact sales

The preferred experience is:

```text
discover tool
↓
call tool
↓
402
↓
pay USDC
↓
retry
↓
receive evidence
```

This is the primary commercial design.

Keep human onboarding secondary.

## 39. ENGINEERING QUALITY BAR

Use:

- strict TypeScript
- schema validation
- typed errors
- modular services
- unit tests
- integration tests
- deterministic fixtures
- clear logging
- environment-driven configuration
- secure defaults

Prefer boring, maintainable code.

Do not use clever abstractions without need.

Do not duplicate business logic between HTTP and MCP implementations.

Both should call the same core application service.

Architecture:

```text
HTTP adapter ─────┐
├──> EvidenceService ──> Fetch/Extract/Cache
MCP adapter ─────┘
```

x402 belongs at the payment boundary, not inside the core evidence engine.

## 40. IMPLEMENTATION ORDER

Work in this order:

### Phase 1

Inspect environment and create project.

### Phase 2

Create AGENTS.md.

### Phase 3

Implement core schemas and validation.

### Phase 4

Implement secure URL fetching.

### Phase 5

Implement extraction and normalization.

### Phase 6

Implement evidence engine.

### Phase 7

Implement SQLite cache.

### Phase 8

Implement backend API.

### Phase 9

Implement MCP server.

### Phase 10

Implement Cloudflare Worker.

### Phase 11

Integrate x402.

### Phase 12

Add security tests.

### Phase 13

Add end-to-end tests.

### Phase 14

Add Docker deployment.

### Phase 15

Create MCP Registry metadata.

### Phase 16

Write documentation.

### Phase 17

Run full validation.

Do not jump directly to deployment before the local application works.

## 41. DEVELOPMENT LOOP

After each meaningful phase:

1. run type checking
2. run unit tests
3. run integration tests where applicable
4. inspect failures
5. fix them
6. continue

Do not accumulate dozens of unchecked changes.

Before completion run the complete test suite from a clean state.

## 42. FINAL ACCEPTANCE CRITERIA

Do not declare the project complete unless all of the following are true:

- [ ] Project exists at /srv/agent-evidence-api
- [ ] AGENTS.md is the sole project rules file
- [ ] Backend starts successfully
- [ ] Worker builds successfully
- [ ] MCP server starts successfully
- [ ] Health endpoint works
- [ ] HTTP evidence endpoint works locally
- [ ] Secure URL fetching works
- [ ] SSRF tests pass
- [ ] Redirect validation tests pass
- [ ] Response size limits work
- [ ] Timeout limits work
- [ ] Metadata extraction works
- [ ] Main-content extraction works
- [ ] Content hashing works
- [ ] Evidence response schema is stable
- [ ] SQLite cache works
- [ ] MCP tool is discoverable from the server
- [ ] MCP tool invokes the same EvidenceService as HTTP
- [ ] x402 returns 402 without payment
- [ ] Base Sepolia test payment flow works where credentials/test funds are available
- [ ] Worker successfully forwards authorized calls
- [ ] Backend cannot be used anonymously to bypass payment
- [ ] Production secrets are not committed
- [ ] Docker deployment works
- [ ] server.json validates
- [ ] MCP Registry publication instructions are documented
- [ ] README is complete
- [ ] architecture documentation is complete
- [ ] deployment documentation is complete
- [ ] security documentation is complete
- [ ] no unrelated project configuration was changed
- [ ] no production credential was invented or committed
- [ ] full tests pass

## 43. WHEN SOMETHING IS BLOCKED

If external credentials are unavailable:

Do not fake them.

Do not invent them.

Do not claim the integration works.

Implement everything possible locally and document exactly what manual credential/configuration is still required.

For example:

```text
DONE:
- Worker implementation
- x402 integration
- testnet configuration
- local mock flow

BLOCKED:
- final production payment test

REQUIRED:
- X402_RECIPIENT
- production wallet
- Cloudflare account binding
- deployment credentials
```

Be precise.

## 44. FINAL RESPONSE TO ME

At the end, provide a concise engineering report containing:

1. What was built
2. Final architecture
3. Exact project location
4. Important files
5. Commands to run locally
6. Commands to deploy
7. Test results
8. x402 status
9. MCP status
10. MCP Registry readiness
11. Any remaining manual configuration
12. Any known limitations

Do not say "production ready" unless the actual acceptance criteria have been demonstrated.

Start now.
