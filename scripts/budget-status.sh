#!/usr/bin/env bash
# Is this goal still inside its spending budget?
#
# The operator set a hard 0.5 USDC budget and a hard "do not touch the rest of the
# wallet" rule. A wallet balance alone cannot express that, so the allowance is
# computed against the balance the wallet held when the goal began.
#
#   bash scripts/budget-status.sh          # report
#   bash scripts/budget-status.sh --strict # exit 1 when the allowance is gone
set -uo pipefail

BUYER=0xa048c5439ccbb64ed3e54fccf292b2d375154c3d
USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
BASELINE=2.934000   # buyer balance when the goal began
ALLOWANCE=0.5       # operator-set budget for the goal
RPC=https://mainnet.base.org

balance() {
  local data="0x70a08231000000000000000000000000${1#0x}"
  curl -s -m 25 -X POST "$RPC" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"$USDC\",\"data\":\"$data\"},\"latest\"]}" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write((Number(BigInt(JSON.parse(d).result))/1e6).toFixed(6))}catch{process.stdout.write("0")}})'
}

NOW="$(balance "$BUYER")"
node -e '
const [now,baseline,allowance] = process.argv.slice(1).map(Number);
const spent = Math.max(0, baseline - now);
const remaining = allowance - spent;
console.log(`  buyer wallet : ${now.toFixed(6)} USDC`);
console.log(`  goal start   : ${baseline.toFixed(6)} USDC`);
console.log(`  spent        : ${spent.toFixed(6)} USDC`);
console.log(`  allowance    : ${allowance.toFixed(6)} USDC`);
console.log(`  remaining    : ${remaining.toFixed(6)} USDC`);
if (remaining <= 0) { console.log("  ✖ allowance exhausted — spend nothing further on this goal"); process.exit(1); }
console.log("  ✓ inside budget");
' "$NOW" "$BASELINE" "$ALLOWANCE"
