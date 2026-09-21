#!/usr/bin/env bash
# Is this service genuinely sellable right now?
#
# Every goal round that ended in "still no customer" needed the same question
# answered from scratch. This is the buyer journey from a stranger's position:
# discoverable, gated, payable, and safe to charge. One command, real HTTP.
#
#   bash scripts/check-readiness.sh
#
# Exit code is the number of checks that failed.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
W="https://agent-evidence-api.thx93.workers.dev"
FAILED=0

pass() { printf '  ✓ %-46s %s\n' "$1" "$2"; }
fail() { printf '  ✖ %-46s %s\n' "$1" "$2"; FAILED=$((FAILED + 1)); }

expect() {
  local label="$1" want="$2" got="$3"
  if [ "$got" = "$want" ]; then pass "$label" "$got"; else fail "$label" "got $got, want $want"; fi
}

echo "=== discoverable ==="
RANK=$(curl -s -m 35 "https://facilitator.payai.network/discovery/search?query=claim+verification" 2>/dev/null \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);const a=j.resources||j.items||j.results||[];const i=a.findIndex(x=>JSON.stringify(x).includes("agent-evidence-api"));process.stdout.write(i>=0?String(i+1):"none")}catch{process.stdout.write("error")}})')
if [ "$RANK" = "1" ]; then pass "Bazaar search: claim verification" "rank #1"; else fail "Bazaar search: claim verification" "rank $RANK"; fi

echo "=== gated ==="
expect "HTTP paywall without payment" 402 \
  "$(curl -s -m 30 -o /dev/null -w '%{http_code}' -X POST "$W/v1/evidence" -H 'content-type: application/json' -d '{"question":"q","urls":["https://example.com"]}')"
expect "MCP discovery is free (tools/list)" 200 \
  "$(curl -s -m 25 -o /dev/null -w '%{http_code}' -X POST "$W/mcp" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')"
expect "MCP paid tool is gated" 402 \
  "$(curl -s -m 25 -o /dev/null -w '%{http_code}' -X POST "$W/mcp" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"research_evidence","arguments":{"question":"q","urls":["https://example.com"]}}}')"

echo "=== payable ==="
expect "manifest serves payment terms" 200 "$(curl -s -m 25 -o /dev/null -w '%{http_code}' "$W/.well-known/x402")"
CDP=$(curl -s -m 60 -X POST "https://api.cdp.coinbase.com/platform/v2/x402/validate" -H 'content-type: application/json' \
  --data "{\"resource\":\"$W/v1/evidence\",\"method\":\"POST\"}" 2>/dev/null \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);let f=0;for(const c of (j.preflight||[]))if(!c.passed&&c.severity==="required")f++;process.stdout.write(j.valid&&f===0?"accepted":("rejected/"+f))}catch{process.stdout.write("error")}})')
if [ "$CDP" = "accepted" ]; then pass "CDP validator (gate to the Bazaar)" "accepted"; else fail "CDP validator" "$CDP"; fi

echo "=== the MCP challenge is cataloguable ==="
# The MCP paywall moved to the backend so that a settled MCP call is catalogued by
# the CDP Bazaar. That only works if the 402 challenge declares the MCP tool shape
# and names the PUBLIC /mcp address, so both are checked on the live challenge.
MCP_HDR=$(curl -s -m 30 -D - -o /dev/null -X POST "$W/mcp" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"research_evidence","arguments":{"question":"q"}}}' 2>/dev/null \
  | grep -i '^payment-required:' | cut -d' ' -f2 | tr -d '\r' | base64 -d 2>/dev/null)
MCP_SUMMARY=$(printf '%s' "$MCP_HDR" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);const r=j.resource&&j.resource.url;const i=j.extensions&&j.extensions.bazaar&&j.extensions.bazaar.info&&j.extensions.bazaar.info.input;process.stdout.write([r||"",i&&i.type,i&&i.toolName,i&&i.transport].join("|"))}catch{process.stdout.write("error")}})')
case "$MCP_SUMMARY" in
  "$W/mcp|mcp|research_evidence|streamable-http")
    pass "MCP challenge declares the tool" "$MCP_SUMMARY" ;;
  *)
    fail "MCP challenge declares the tool" "$MCP_SUMMARY" ;;
esac

echo "=== the advertised terms match what is charged ==="
# The Worker still serves /.well-known/x402 and the landing page, but the paywall
# that charges runs in the backend. The two are separate configurations now, so
# they can drift: a manifest that quotes a price or address the service does not
# charge is worse than no manifest. The live 402 challenge is the authority.
DRIFT=$(node -e '
const W = "https://agent-evidence-api.thx93.workers.dev";
const decode = (h) => JSON.parse(Buffer.from(h, "base64").toString("utf8"));
const post = (u) => fetch(u, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ question: "q", urls: ["https://example.com"] }) });
(async () => {
  const [manifestRes, challengeRes] = await Promise.all([fetch(W + "/.well-known/x402"), post(W + "/v1/evidence")]);
  const manifest = await manifestRes.json();
  const charge = decode(challengeRes.headers.get("payment-required")).accepts[0];
  const advertised = (manifest.resources || []).map((r) => (r.accepts || [])[0]).filter(Boolean);
  if (advertised.length === 0) { console.log("manifest carries no accepts"); return; }
  for (const a of advertised) {
    for (const k of ["scheme", "network", "amount", "payTo", "asset"]) {
      if (String(a[k]) !== String(charge[k])) { console.log(k + ": manifest=" + a[k] + " charged=" + charge[k]); return; }
    }
  }
  console.log("agree");
})().catch((e) => console.log("error: " + e.message));
' 2>/dev/null)
if [ "$DRIFT" = "agree" ]; then pass "manifest agrees with the live charge" "agree"; else fail "manifest agrees with the live charge" "$DRIFT"; fi

echo "=== safe to charge ==="
if (cd "$ROOT/buyer" && timeout 120 node verify-payment-path.mjs 2>/dev/null | grep -q 'PATH VERIFIED'); then
  pass "settlement simulated on-chain" "verified"
else
  fail "settlement simulated on-chain" "did not verify"
fi

echo
if [ "$FAILED" -ne 0 ]; then
  echo "  ✖ $FAILED readiness check(s) failed — do not charge until fixed."
  exit "$FAILED"
fi
echo "  ✓ service is sellable: discoverable, gated, payable, safe to charge."
