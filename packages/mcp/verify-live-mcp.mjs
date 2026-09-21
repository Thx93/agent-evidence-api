// Verify the LIVE MCP endpoint the way a real client does.
//
//   node packages/mcp/verify-live-mcp.mjs [url]
//
// Performs the full handshake - initialize, tools/list, a free tool call, and a
// paid tool call without payment - which curl does not exercise: curl can post
// tools/list and tools/call directly but never negotiates a session.
//
// This is what caught the MCP server advertising version 0.1.0 while /health and
// the registry said 0.1.1. It is worth re-running after any change to the Worker,
// the backend, the MCP server, or the version.
//
// Expected: connected, both tools listed, health returns ok, and the paid tool is
// refused with PAYMENT_REQUIRED.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.argv[2] ?? "https://agent-evidence-api.taher-h-alhaddad.workers.dev/mcp");
const transport = new StreamableHTTPClientTransport(url);
const client = new Client({ name: "aee-verification-client", version: "1.0.0" }, { capabilities: {} });

console.log("=== 1. initialize (the handshake curl never did) ===");
try {
  await client.connect(transport);
  const info = client.getServerVersion();
  console.log("  ✓ connected");
  console.log("    server   :", info?.name, info?.version);
  console.log("    protocol :", client.getNegotiatedProtocolVersion?.() ?? "(n/a)");
  console.log("    caps     :", JSON.stringify(client.getServerCapabilities()));
} catch (e) {
  console.log("  ✖ initialize FAILED:", e.message.slice(0, 200));
  process.exit(1);
}

console.log("\n=== 2. tools/list ===");
try {
  const { tools } = await client.listTools();
  for (const t of tools) {
    const props = Object.keys(t.inputSchema?.properties ?? {});
    console.log(`  • ${t.name} — required: ${JSON.stringify(t.inputSchema?.required ?? [])}`);
    console.log(`    props: ${props.join(", ") || "(none)"}`);
  }
} catch (e) {
  console.log("  ✖ listTools FAILED:", e.message.slice(0, 200));
}

console.log("\n=== 3. tools/call on the FREE tool ===");
try {
  const r = await client.callTool({ name: "health", arguments: {} });
  console.log("  ✓ free tool works:", JSON.stringify(r.content).slice(0, 120));
} catch (e) {
  console.log("  ✖ free tool FAILED:", e.message.slice(0, 200));
}

console.log("\n=== 4. tools/call on the PAID tool without payment ===");
try {
  const r = await client.callTool({
    name: "research_evidence",
    arguments: { question: "Is Rotamech a manufacturer of centrifugal pumps?", urls: ["https://example.com"] },
  });
  console.log("  ⚠ expected 402 but got a result:", JSON.stringify(r).slice(0, 200));
} catch (e) {
  const s = String(e.message ?? e);
  console.log("  ", /402|payment/i.test(s) ? "✓ correctly refused (payment required)" : "?", s.slice(0, 180));
}

await client.close();
console.log("\n  handshake completed and closed cleanly");
