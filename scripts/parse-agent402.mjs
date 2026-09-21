// Parse an Agent402 index row on stdin and describe our listing.
let d = "";
process.stdin.on("data", (c) => (d += c)).on("end", () => {
  try {
    const j = JSON.parse(d);
    if (!j.origin) {
      console.log("  MISSING from the index");
      return;
    }
    const dispatch = j.routerDispatchEligible ? "eligible" : j.routerDispatchReason;
    console.log(`  listed, ${j.toolCount} tools, networks=${JSON.stringify(j.networks)}, dispatch=${dispatch}`);
  } catch {
    console.log("  (could not parse the index response)");
  }
});
