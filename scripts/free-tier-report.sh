#!/usr/bin/env bash
# What is actually happening, in numbers: paid vs free, per tool.
#
# The usage log lives on a docker volume, not in the repository, and until now it
# could not separate a free preview from a paid call or one tool from another - every
# line looked the same, and the MCP route wrote nothing at all. Both are fixed, so this
# exists to read the result instead of guessing at it.
#
#   bash scripts/free-tier-report.sh          # last 24h
#   bash scripts/free-tier-report.sh 7d       # last 7 days
set -uo pipefail

WINDOW="${1:-24h}"
case "$WINDOW" in
  *d) AGO="${WINDOW%d} days ago" ;;
  *h) AGO="${WINDOW%h} hours ago" ;;
  *)  AGO="24 hours ago" ;;
esac

SINCE=$(date -u -d "$AGO" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")

docker exec aee-live sh -c 'cat /app/data/usage-prod.jsonl 2>/dev/null' 2>/dev/null \
  | SINCE="$SINCE" node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c)).on("end", () => {
      const since = process.env.SINCE;
      const rows = raw.trim().split("\n").filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean).filter((r) => !since || (r.ts || "") >= since);

      const byTool = {};
      let previews = 0, paid = 0, failed = 0;
      const ips = new Set();
      for (const r of rows) {
        // The MCP path sets the tool name but not the flag, so both count.
        if (r.preview || r.tool === "preview_evidence") previews += 1;
        if (r.payment_provided) paid += 1;
        if (r.outcome !== "ok") failed += 1;
        const free = r.preview || r.tool === "preview_evidence";
        const key = free ? (r.tool || "preview (rest)") : (r.tool || "http paid route");
        byTool[key] = (byTool[key] || 0) + 1;
      }

      console.log(`  window        : since ${since}`);
      console.log(`  total calls   : ${rows.length}`);
      console.log(`  free previews : ${previews}`);
      console.log(`  with payment  : ${paid}   (a proof, not settlement - see usage-log.ts)`);
      console.log(`  errors        : ${failed}`);
      console.log("  by surface    :");
      for (const [k, v] of Object.entries(byTool).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${k.padEnd(22)} ${v}`);
      }
      if (rows.length === 0) {
        console.log("  (nothing yet - the free tier is instrumented, but nobody has called it)");
      }
    });
  '
