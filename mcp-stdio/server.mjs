#!/usr/bin/env node
/**
 * Agent Evidence MCP — a local stdio MCP server for the Agent Evidence API.
 *
 * Why this package exists: the hosted service is a REMOTE MCP server
 * (streamable HTTP) that charges $0.01 per evidence call over x402. Some MCP
 * clients — Claude Desktop, Cursor, Zed, most desktop hosts — only speak stdio,
 * and none of them can pay an x402 challenge. This package is the adapter: it
 * runs locally, exposes the same tools to the client, and pays the remote calls
 * from a wallet key you provide.
 *
 * Discovery metadata follows what these clients actually read: every tool is
 * re-advertised with its tool-level `title` and `annotations` (not just the name and
 * description), because a tool without a title reads as undocumented in most
 * hosts and in every catalogue that grades a tool list.
 *
 * Nothing is held, cached or proxied here beyond the call in flight. The
 * wallet key is read from your environment/file, is never logged, never
 * written, and never leaves the process except as the EIP-3009 authorization
 * x402 requires.
 */
import { readFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, formatUnits } from "viem";
import { base } from "viem/chains";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { wrapFetchWithPayment } from "@x402/fetch";

const VERSION = "0.1.0";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NETWORK = "eip155:8453";
const REMOTE =
  process.env.AGENT_EVIDENCE_MCP_URL ?? "https://agent-evidence.thx93.dev/mcp";

const log = (...args) => console.error("[agent-evidence-mcp]", ...args);

/** The wallet key, if one was supplied. Never echoed. */
async function walletKey() {
  const inline = process.env.X402_PRIVATE_KEY;
  if (inline) return inline.trim();
  const file = process.env.X402_PRIVATE_KEY_FILE;
  if (!file) return null;
  try {
    return (await readFile(file.replace(/^~(?=\/)/, process.env.HOME ?? ""), "utf8")).trim();
  } catch (error) {
    log(`could not read X402_PRIVATE_KEY_FILE: ${error.code ?? error.message}`);
    return null;
  }
}

const key = await walletKey();
let payFetch = fetch;
let wallet = null;

if (key) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    log("X402_PRIVATE_KEY is not a 32-byte hex value; paid calls will fail.");
  } else {
    const account = privateKeyToAccount(key);
    wallet = account.address;
    const publicClient = createPublicClient({ chain: base, transport: http() });
    const signer = toClientEvmSigner(account, publicClient);
    const x402 = new x402Client().register(NETWORK, new ExactEvmScheme(signer));
    payFetch = wrapFetchWithPayment(fetch, x402);
    const balance = await publicClient
      .readContract({
        address: USDC,
        abi: [
          {
            name: "balanceOf",
            type: "function",
            stateMutability: "view",
            inputs: [{ name: "a", type: "address" }],
            outputs: [{ name: "", type: "uint256" }],
          },
        ],
        functionName: "balanceOf",
        args: [account.address],
      })
      .catch(() => null);
    log(
      `wallet ${wallet} ${balance === null ? "" : `(${formatUnits(balance, 6)} USDC on Base)`}`,
    );
  }
}

/** The remote client, created once and reused. */
let remote = null;
async function remoteClient() {
  if (remote) return remote;
  const transport = new StreamableHTTPClientTransport(new URL(REMOTE), {
    fetch: payFetch,
    requestInit: {
      headers: {
        accept: "application/json, text/event-stream",
        "user-agent": `agent-evidence-mcp/${VERSION}`,
      },
    },
  });
  const client = new Client(
    { name: "agent-evidence-mcp", version: VERSION },
    { capabilities: {} },
  );
  await client.connect(transport);
  remote = client;
  return client;
}

const server = new Server(
  { name: "agent-evidence-mcp", version: VERSION },
  { capabilities: { tools: {} } },
);

/**
 * Tool discovery is free on the remote server, so it is re-read from source
 * rather than duplicated here: a tool added or renamed upstream shows up in this
 * client on the next `tools/list` with no package release.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const client = await remoteClient();
  const { tools } = await client.listTools();
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const client = await remoteClient();
    return await client.callTool({ name, arguments: args ?? {} });
  } catch (error) {
    const message = String(error?.message ?? error);
    const paymentProblem = /402|payment/i.test(message);
    const hint =
      paymentProblem && !key
        ? "\n\nThis tool is paid ($0.01 per call, USDC on Base). Set X402_PRIVATE_KEY " +
          "(or X402_PRIVATE_KEY_FILE with a key on this machine's filesystem) and restart " +
          "this server, or call the free `health` and `sample` tools which need no payment."
        : "";
    return { content: [{ type: "text", text: `remote error: ${message}${hint}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
log(`ready: ${REMOTE}${key ? " (paid calls enabled)" : " (free tools only — no wallet key)"}`);
