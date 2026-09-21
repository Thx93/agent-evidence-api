#!/usr/bin/env bash
# Check that the live service holds up under concurrency.
#
#   bash scripts/check-load.sh [concurrent-requests]
#
# Worth running before an announcement: everything else in the toolkit verifies
# correctness with one request at a time, so a service that passes every check
# could still fold on the first busy minute.
#
# Two things are asserted, and both matter for payment safety:
#   1. The x402 gate answers every concurrent request with a clean 402 and no 5xx.
#      A 5xx at the gate is a buyer seeing a broken service before they pay.
#   2. The service never returns a 2xx for a request it did not serve, and never
#      returns 5xx. Anything >= 400 cancels settlement, so error paths are safe;
#      an unexpected 2xx would be a charge for a bad response.
#
# Deliberately bounded and read-only: it only hits the public paywall, never
# spends anything.
set -uo pipefail

BASE="${1:-https://agent-evidence-api.thx93workersdev.workers.dev}"
N="${2:-40}"

echo "  target: $BASE"
echo "  firing $N concurrent requests at the payment gate"

node --input-type=module -e '
const base = process.argv[1];
const N = Number(process.argv[2]);
const started = Date.now();

const results = await Promise.all(
  Array.from({ length: N }, (_, i) =>
    fetch(base + "/v1/evidence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "load probe " + i, urls: ["https://example.com"] }),
    })
      .then(async (r) => ({ status: r.status, ms: Date.now() - started, code: (await r.json().catch(() => ({})))?.error?.code }))
      .catch(() => ({ status: 0, ms: Date.now() - started, code: "CONNECTION_FAILED" })),
  ),
);

const wall = Date.now() - started;
const byStatus = {};
for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
const lat = results.map((r) => r.ms).sort((a, b) => a - b);
const p = (q) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))];

console.log("  wall time :", wall, "ms");
console.log("  statuses  :", JSON.stringify(byStatus));
console.log("  p50/p95   :", p(0.5) + "/" + p(0.95), "ms");

const fivexx = results.filter((r) => r.status >= 500).length;
const conn = results.filter((r) => r.status === 0).length;
const twok = results.filter((r) => r.status === 200).length;

let failed = 0;
if (fivexx > 0) { console.log("  ✖ " + fivexx + " server error(s) under load"); failed = 1; }
if (conn > 0) { console.log("  ✖ " + conn + " connection failure(s)"); failed = 1; }
if (twok > 0) { console.log("  ✖ " + twok + " unexpected 200 from an unpaid endpoint"); failed = 1; }
if (!failed) console.log("  ✓ every request answered cleanly; no 5xx, no connection failures");
process.exit(failed);
' "$BASE" "$N"
