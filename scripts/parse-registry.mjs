// Parse an MCP Registry search response on stdin; print the active version, or nothing.
let d = "";
process.stdin.on("data", (c) => (d += c)).on("end", () => {
  try {
    const j = JSON.parse(d);
    const latest = (j.servers || []).find(
      (e) => e._meta?.["io.modelcontextprotocol.registry/official"]?.isLatest,
    );
    process.stdout.write(latest ? latest.server.version : "");
  } catch {
    process.stdout.write("");
  }
});
