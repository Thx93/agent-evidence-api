#!/usr/bin/env bash
# Where is this service actually listed right now?
#
# Exists because "we are not in the CDP Bazaar" was once asserted from a
# 500-entry sample of 15,141 - which is not proof of absence. This checks every
# channel, and the CDP one pages the WHOLE catalogue rather than sampling it.
#
#   bash scripts/check-listings.sh
#
# Exit code is the number of channels where the service is unexpectedly missing.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NEEDLE="agent-evidence-api"
PUBLIC_URL="https://agent-evidence-api.thx93.workers.dev"
MISSING=0

echo "=== x402 Bazaar (PayAI facilitator) ==="
for t in http mcp; do
  n=$(curl -s -m 30 "https://facilitator.payai.network/discovery/resources?type=$t&limit=100" 2>/dev/null | grep -c "$NEEDLE" || true)
  if [ "$n" -gt 0 ]; then
    printf '  %-6s listed\n' "$t"
  else
    printf '  %-6s MISSING\n' "$t"
    MISSING=$((MISSING + 1))
  fi
done

echo "=== MCP Registry ==="
V=$(curl -s -m 30 "https://registry.modelcontextprotocol.io/v0.1/servers?search=$NEEDLE" 2>/dev/null \
  | node "$ROOT/scripts/parse-registry.mjs" 2>/dev/null)
if [ -n "$V" ]; then
  echo "  active, version $V"
else
  echo "  MISSING (or the registry is flaky - retry before concluding)"
  MISSING=$((MISSING + 1))
fi

echo "=== Agent402 index ==="
curl -s -m 40 "https://agent402.tools/api/index?seller=agent-evidence-api.thx93.workers.dev" 2>/dev/null \
  | node "$ROOT/scripts/parse-agent402.mjs" 2>/dev/null

echo "=== 402 Index ==="
# `q` is the only filter that works: domain/url/verified are ignored by the API,
# and the directory is 110,665 rows, so paging to find ourselves is not practical.
curl -s -m 40 "https://402index.io/api/v1/services?q=agent+evidence" 2>/dev/null \
  | node "$ROOT/scripts/parse-402index.mjs" 2>/dev/null

echo "=== CDP Bazaar (the whole catalogue, not a sample) ==="
node "$ROOT/scripts/check-cdp-bazaar.mjs" "$NEEDLE"

echo
echo "=== live service ==="
printf '  deep health: '
curl -s -m 25 "$PUBLIC_URL/health?deep=1"
echo
exit "$MISSING"
