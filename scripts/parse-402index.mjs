// Report our 402 Index listing from a search response on stdin.
//
// Queries the row by name rather than paging: the directory holds 110,665 rows and
// its domain/url/verified filters are ignored by the API, so only `q` finds us.
let d = "";
process.stdin.on("data", (c) => (d += c)).on("end", () => {
  try {
    const j = JSON.parse(d);
    const list = j.services || j.data || [];
    const row = list.find((x) => JSON.stringify(x).includes("agent-evidence-api"));
    if (!row) {
      console.log("  NOT FOUND — the listing may have been dropped (see PATCH edit rights)");
      return;
    }
    const rank = list.findIndex((x) => JSON.stringify(x).includes("agent-evidence-api")) + 1;
    console.log(`  listed at #${rank} of ${list.length} for its own name`);
    console.log(`    category=${row.category} price=$${row.price_usd} ${row.payment_asset}/${row.payment_network}`);
    console.log(`    domain_verified=${row.domain_verified} health=${row.health_status} probe=${row.probe_status}`);
  } catch {
    console.log("  (could not parse the directory response)");
  }
});
