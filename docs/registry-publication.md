# Publishing to the Official MCP Registry

This document describes how **Agent Evidence API** is published to the
[official MCP Registry](https://registry.modelcontextprotocol.io), following
[SPEC section 28](../SPEC.md). The project is kept **registry-ready**; it is
**not published automatically**.

> **Publication is a manual, credentialed, authorised action.**
> Nothing in this repository publishes anything. The steps below require a real
> GitHub account, a real public MCP endpoint, and an explicit interactive login.
> Do not run them until the deployment is live and the operator has decided to
> publish. No credential, token, or domain is invented or committed here.

---

## 1. What is being published

The registry stores **metadata only**. Agent Evidence API is a **remote** MCP
server (streamable HTTP), so `server.json` declares it through `remotes` and
deliberately contains **no `packages` entry** — there is no npm package to
install, and inventing one would be false metadata.

Current [`server.json`](../server.json):

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.Thx93/agent-evidence-api",
  "title": "Agent Evidence API",
  "description": "MCP-native web evidence and claim verification: cited, source-grounded evidence for AI agents.",
  "version": "0.1.1",
  "remotes": [
    {
      "type": "streamable-http",
      "url": "https://mcp.example.invalid/mcp"
    }
  ]
}
```

| Field | Notes |
| --- | --- |
| `$schema` | Must be the **current** schema URI. The registry rejects or warns on non-current schemas. Current: `2025-12-11`. |
| `name` | Reverse-DNS with **exactly one** `/`. `io.github.<username>/<server>` for GitHub auth. |
| `description` | Max 100 characters, truthful, capability-focused. |
| `version` | Product version (SPEC section 34). Must be a specific version — ranges are rejected. Keep it equal to the product version so `/health`, the MCP `serverInfo` and this listing agree. |
| `repository` | **Optional.** Omit it unless the repository is publicly readable — a private one publishes a link that 404s. See below. |
| `remotes[0].type` | `streamable-http` (the primary transport, SPEC section 10). SSE is deprecated. |
| `remotes[0].url` | **Placeholder.** Must be the deployed public MCP URL (`MCP_PUBLIC_URL`). |

---

## 2. Prerequisites

1. **A GitHub account** that owns the namespace. This is confirmed: the account
   is `Thx93` and `server.json` says `io.github.Thx93/agent-evidence-api`, which
   matches the publish permission the registry grants for that login
   (`io.github.Thx93/*`). Note the capital `T` — the namespace is compared
   case-sensitively, so a lowercase `thx93` would be rejected at publish time.
   **If you ever publish under a different account, change `name` first** — see
   section 3.
2. **A deployed, publicly reachable MCP endpoint.** For a remote server the
   registry expects the URL to serve the MCP streamable-HTTP transport. That
   means: the Worker is deployed, the backend container is running behind the
   Cloudflare Tunnel, `MCP_PUBLIC_URL` resolves, and `initialize` /
   `tools/list` answer without payment (only `research_evidence` is x402-gated).
3. **`mcp-publisher` installed** (official CLI, from the
   [registry repository](https://github.com/modelcontextprotocol/registry)):

   ```bash
   # macOS / Linux (pre-built binary)
   curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/

   # or Homebrew
   brew install mcp-publisher

   mcp-publisher --help
   ```

   The CLI exposes: `init`, `login`, `logout`, `publish`, `status`, `validate`.

No npm account is required for this server, because no package is published.

---

## 3. Before validating: replace the placeholders

Run these from the repository root.

| Placeholder | Where | Replace with |
| --- | --- | --- |
| `https://mcp.example.invalid/mcp` | [`server.json`](../server.json) → `remotes[0].url` | the deployed MCP URL, i.e. `MCP_PUBLIC_URL` from [`docker/env.production.example`](../docker/env.production.example) |
| *(none — see below)* | `server.json` → `repository` | **omit it unless the repository is public** |
| `io.github.Thx93/...` | `server.json` → `name` | `io.github.<your-github-username>/agent-evidence-api` |

### Why there is no `repository` field

`repository.url` is optional, and it was removed deliberately. This project's
source is private, so pointing at it published a link that returned **404** to
everyone who clicked it — on the primary discovery channel, where it reads as an
abandoned listing. A missing field is honest; a dead link is not.

Add it only once the repository is publicly readable, and verify that an
anonymous request returns 200 first:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://github.com/<owner>/<repo>   # must be 200
```

Correcting metadata requires a new version: `mcp-publisher publish` rejects a
duplicate version, and `status` only changes active/deprecated/deleted. Bump
`version` in `server.json` (and the product version, so `/health`, the MCP
`serverInfo` and the listing agree — see the round-15 note in `docs/discovery.md`).

Rules that the registry enforces:

- `name` must match the namespace your **authentication method** proves.
- For GitHub auth the name **must** start with `io.github.<your-username>/`.
- A remote URL must be publicly accessible and must not be a placeholder:
  a `.invalid` host (RFC 2606 reserved) will fail validation on purpose, which
  is the intended loud failure for an unreplaced placeholder.
- `version` must be a specific version string (`0.1.0`), never `latest` or a
  range.

---

## 4. Validate (no credentials required)

`mcp-publisher validate` validates **without publishing**. It checks JSON
syntax, schema compliance and semantic rules by POSTing the file to the
registry's `/v0/validate` endpoint, so it needs network access — but it does
**not** need a login and it does not change anything in the registry.

```bash
# Default file path is ./server.json; passing it explicitly is also fine.
mcp-publisher validate server.json
```

Expected output on success:

```text
Validating against https://registry.modelcontextprotocol.io...
✅ server.json is valid
```

### Offline checks (run first; they catch most mistakes instantly)

```bash
# 1. It must be parseable JSON.
node -e 'JSON.parse(require("fs").readFileSync("server.json","utf8")); console.log("valid json")'

# 2. Validate against the official JSON Schema, fetched fresh (draft-07).
curl -fsSL -o /tmp/server.schema.json \
  https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
npx --yes ajv-cli@5 validate --spec=draft7 -c ajv-formats \
  -s /tmp/server.schema.json -d server.json
```

Schema-only validation is necessary but not sufficient: the registry also
applies semantic rules (schema currency, namespace/authentication matching,
remote reachability). Always finish with `mcp-publisher validate`.

---

## 5. Authenticate and publish

Run both commands from the repository root, in the directory that contains
`server.json`.

```bash
# 1. Authenticate. GitHub auth uses an interactive OAuth device flow.
mcp-publisher login github
#    -> visit https://github.com/login/device, enter the printed code,
#       authorise the application.

# 2. Publish server.json.
mcp-publisher publish
#    -> Publishing to https://registry.modelcontextprotocol.io...
#       ✓ Successfully published
#       ✓ Server io.github.Thx93/agent-evidence-api version 0.1.0
```

Notes:

- `publish` takes **no** `--registry` flag: it uses the registry URL stored by
  `login`. Passing one would be interpreted as the path to `server.json`.
- `publish` re-runs validation; a file that fails `validate` will not publish.
- The CLI stores the auth token locally (per-user config). Treat it like a
  credential: never commit it, never paste it into a repository file.

### Verify the publication

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.Thx93/agent-evidence-api"
```

The response is JSON containing the published server metadata. A subsequent
release is published by bumping `version` in `server.json` (and the product
version wherever it is defined) and running `login` + `publish` again.

### Later maintenance

```bash
mcp-publisher status --help   # mark a published version active/deprecated/deleted
mcp-publisher logout          # clear the saved credentials
```

---

## 6. Namespace ownership and authentication checklist

The registry grants a namespace only to an identity that provably owns it.
**Pick the authentication method first, then set `name` to match it.**

- GitHub personal: `io.github.<your-username>/*` — you must log in as that
  GitHub user (`mcp-publisher login github`).
- GitHub organisation: `io.github.<orgname>/*` — you must be an **Owner** of the
  organisation. Ordinary membership is not sufficient, and a Personal Access
  Token used for CI must be able to read your organisation role (classic PAT:
  `read:org`; fine-grained PAT: *Organization permissions → Members →
  Read-only*). The registry never needs repository scopes.
- Custom domain: `com.example.*/*` (reverse DNS of a domain you control) — prove
  ownership with **DNS** authentication (an apex TXT record; not a selector like
  `_mcp-auth`) or **HTTP** authentication (a file at
  `https://<domain>/.well-known/mcp-registry-auth`).

Checklist — every box must be true before publishing:

- [ ] `server.json` `name` uses `io.github.<username>/agent-evidence-api`, and
      `<username>` is exactly the GitHub account that will run `login github`.
- [ ] If publishing under an organisation, the authenticated account is an
      **Owner** of that organisation.
- [ ] Either `repository` is omitted, or its URL returns 200 to an
      anonymous request. A private repository must not be linked.
- [ ] `description` is truthful and ≤ 100 characters.
- [ ] `version` is a specific version and matches the product
      version.
- [ ] `remotes[0].url` is the deployed `MCP_PUBLIC_URL` — no `.invalid` host left.
- [ ] The public MCP endpoint answers `initialize` and `tools/list` without
      payment, and `research_evidence` returns `402` without payment.
- [ ] `mcp-publisher validate server.json` prints `✅ server.json is valid`.
- [ ] The operator has explicitly authorised publication.
- [ ] No secret, token, or private key has been written into any repository file.

---

## 7. Explicit non-goals

- **No automatic publication.** There is no CI workflow in this repository and
  none is planned (SPEC section 36 forbids a complex CI platform). Publishing is
  a deliberate manual action with real credentials.
- **No credentials are stored in the repository.** `server.json` contains no
  secrets; the registry token lives only in the local `mcp-publisher` store.
- **No invented domains, wallets, or repositories.** Every value that is not yet
  real is an RFC 2606 `.invalid` placeholder or an obvious `example.invalid`
  stand-in, and section 3 lists each one that must be replaced.
- **No npm package entry.** The registry is told the truth: this is a remote
  server reachable over streamable HTTP.

## 8. Troubleshooting

| Error | Meaning / action |
| --- | --- |
| `$schema field is required.` | Add the current `$schema` URI (see section 1). |
| `deprecated schema detected` | Migrate to the current schema URI; `mcp-publisher init` writes a current template. |
| `You do not have permission to publish this server` | The authenticated identity does not own the namespace: the name must be `io.github.<your-username>/...` for GitHub auth. |
| `Invalid or expired Registry JWT token` | Re-run `mcp-publisher login github`. |
| `Registry validation failed for package` | Only relevant when a `packages` entry exists; this server declares none. |
| Validation fails on the remote URL | The URL is still a placeholder or is not publicly reachable. Deploy first (see [SPEC section 31](../SPEC.md)). |

## The registry API is intermittently flaky

Observed 2026-09-21: the same query returned an **empty response body** on one
attempt and the correct payload on the next, seconds apart. The listing itself was
never affected — a direct fetch of the versioned endpoint confirmed
`io.github.Thx93/agent-evidence-api 0.1.1 status=active` throughout.

This matters for anyone scripting a health check: `curl -s ... | grep -q <something>`
reports a false failure when the body is empty, because an empty body is not the
same as a missing listing. Retry, and confirm against the versioned endpoint:

```bash
# flaky: an empty body looks like a failure
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers?search=agent-evidence-api" | grep -q agent-evidence-api

# reliable: names the version, and a non-200 is unambiguous
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.Thx93%2Fagent-evidence-api/versions/0.1.1"
```
