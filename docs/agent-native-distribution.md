# Agent-native distribution: Smithery and Glama

Recorded 2026-10-23. These two matter more than the remaining directories because
developers install tools from them rather than browse them, so a listing produces an
actual configured client rather than a page view.

## What has been done

| item | state |
| --- | --- |
| `glama.json` (maintainers: Thx93) | added to both repos, pushed |
| Endpoint passes a SmitheryBot scan | verified — `initialize` and `tools/list` answer 200 |
| Glama connector: weather | **Ownership verified · Status Healthy · TDQS 4.1/5.0** |
| Glama connector: agent-evidence-api | listed, **claim not yet submitted** |
| Glama servers listing: mcp-weather-server | live |
| Glama servers listing: agent-evidence-api | 404 — the repo is a monorepo |

## Why the weather connector showed 15.8% uptime

Glama's probe was failing against our MCP endpoints. Until 2026-10-22 they answered
**406** to any POST whose `Accept` header did not name both `application/json` and
`text/event-stream`, and a probe that is not an MCP client does not send that header:

```
406 {"error":{"code":-32000,"message":"Not Acceptable: Client must accept both
     application/json and text/event-stream"}}
```

Fixed in `01a7268` — the transport is built with `enableJsonResponse`, so widening the
header changed no response format. Last Tested now reports **Healthy**, and the 30-day
average should climb as healthy probes accumulate. That single fix may also be why
PayAI's crawler failed to catalogue the MCP resources.

## What is blocked, and on what

Both remaining steps require a logged-in account. There is no API path that avoids it.

### Smithery — https://smithery.ai/new

1. Sign in (email, Google or GitHub).
2. Enter the server's HTTPS URL:
   - `https://agent-evidence.thx93.dev/mcp`
   - `https://agent-evidence.thx93.dev/weather/mcp`
3. Complete the flow. Smithery scans the server to extract tools.

The scan should succeed: verified that `SmitheryBot/1.0` gets 200 with the full tool list
from both endpoints. Smithery documents 403-during-scan as the most common failure and
attributes it to WAF or bot protection — we have `security_level: medium` and no Bot
Fight Mode, and the simulated scan passes, so this is not a risk here.

### Glama — claim the evidence connector

The connector page shows "Verify claim". The proof is already served at
`https://agent-evidence.thx93.dev/.well-known/glama.json`:

```json
{"$schema":"https://glama.ai/mcp/schemas/connector.json","claim":"glama_claim_Q_TR9WzmB7yGxCqFoVqs1uiNipCRlCsO"}
```

Signing in on Glama and submitting that claim marks the connector as owned, as the
weather one already is.

### Optional: a servers listing for the evidence API

Glama's `servers` format is built from a repository it can introspect. Ours is a
monorepo — backend, Worker and six packages — so there is no single entrypoint and the
path 404s. `punkpeye/awesome-mcp-servers#16915` asks for a servers badge for exactly this
reason and is blocked on the same thing.

The connector listing is the correct surface for a hosted service, which is what point
one of that PR asks. If a servers listing is required, the fix is a small standalone
repository containing only the MCP surface — not a refactor of this one.

## Edge settings that block legitimate clients (2026-10-23)

Issue #1 reported `HTTP 403 / Cloudflare Error 1010 browser_signature_banned` from a
Python client. It was **Browser Integrity Check**, on by default, rejecting the
`Python-urllib` user agent while letting `python-requests` through:

```
User-Agent: Python-urllib/3.12   -> 403 error code 1010
User-Agent: python-requests/2.31 -> 200
User-Agent: Mozilla/5.0 ...      -> 200
```

`browser_check` is now **off**. An endpoint that advertises "no API key, no account,
call it from anything" cannot sit behind a filter that judges the client by its user
agent. This is worth remembering before enabling any other edge control: Bot Fight
Mode and the higher security levels would do the same thing to agents, and agents are
the entire customer base.

The same setting very likely explains the 15.8% uptime Glama reported, alongside the
406 described above — two edge/behaviour faults with one root question: *would a plain
HTTP client be refused?*

**Rule for this zone:** every edge setting must be tested against a bare
`Python-urllib` and a bare `curl` before being enabled. Both must get a real answer.
