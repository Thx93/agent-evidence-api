# @thx93/agent-evidence-mcp

Local **stdio** MCP server for the [Agent Evidence API](https://agent-evidence.thx93.dev) —
cited, source-grounded web evidence and claim verification for AI agents.

The hosted service is a remote streamable-HTTP MCP server that charges **$0.01 per
evidence call** in USDC on Base over x402. Desktop MCP clients (Claude Desktop,
Cursor, Zed, …) only speak stdio and cannot pay an x402 challenge. This package is
that adapter: it runs locally, exposes the same tools, and pays the remote calls
from a wallet key you control.

```bash
npx -y @thx93/agent-evidence-mcp
```

## What you get

| Tool | Cost | What it does |
|---|---|---|
| `research_evidence` | **$0.01** | Fetch public web sources for a question or claim and return structured, cited evidence: source URLs, retrieval timestamps, quotable excerpts, content hashes, and an explicit `supported` / `contradicted` / `mixed` / `inconclusive` assessment |
| `sample` | free | One real, previously produced evidence package — so you can judge the output before paying |
| `health` | free | Liveness and service version |

The tool list is re-read from the remote service, never duplicated here, so a tool
added upstream appears in your client without waiting for a release of this package.

## Setup

Two environment variables matter:

| Variable | Purpose |
|---|---|
| `X402_PRIVATE_KEY` | a Base wallet key holding a little USDC. Paid calls are signed with it, locally. |
| `AGENT_EVIDENCE_MCP_URL` | override the endpoint (default `https://agent-evidence.thx93.dev/mcp`) |

`X402_PRIVATE_KEY_FILE` is accepted instead of the inline variable, so the key can
live in a file outside your shell history. The key is never logged, never written
anywhere, and never sent anywhere: only the EIP-3009 payment authorization leaves
the process.

Without a key the server still runs: `health` and `sample` work, and a paid call
answers with an explanatory error instead of a payment failure.

### Claude Desktop

```json
{
  "mcpServers": {
    "agent-evidence": {
      "command": "npx",
      "args": ["-y", "@thx93/agent-evidence-mcp"],
      "env": { "X402_PRIVATE_KEY": "0x…" }
    }
  }
}
```

### Cursor

```json
{
  "mcpServers": {
    "agent-evidence": {
      "command": "npx",
      "args": ["-y", "@thx93/agent-evidence-mcp"],
      "env": { "X402_PRIVATE_KEY": "0x…" }
    }
  }
}
```

## Paying

Each paid call is an x402 settlement: the server answers `402` with its price, this
adapter signs a USDC transfer authorization for exactly that amount, and the call
is retried. There is no account, no API key and no subscription, and you are not
charged when nothing could be retrieved.

Wallet: `0x9c0e2B44180439294Fa30Ae2B2a94f8655455FD0` (it receives the payments; it
is not a source of funds).

## Also from the same service

- HTTP: `POST https://agent-evidence.thx93.dev/v1/evidence` — same engine, no MCP.
- Weather: `https://agent-evidence.thx93.dev/weather/mcp` — NWS alerts and forecasts.
- Free sample of real output: `https://agent-evidence.thx93.dev/demo`.
- Zero-install buyer CLI: `curl -fsSL https://agent-evidence.thx93.dev/buy.mjs -o buy.mjs`.

MIT licensed.
