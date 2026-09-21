#!/usr/bin/env bash
# Deploy the public edge (Worker) and PROVE it took effect.
#
# Why this is more than `wrangler deploy`: two separate mistakes made a broken
# deploy look successful, and both were in the checking rather than the deploying.
#
#   1. `wrangler deploy ... | tail` makes the pipeline's exit status `tail`'s, so
#      a failed build exits 0. The script could not fail.
#   2. Filtering the output for success markers (`grep Deployed`) DISCARDS the
#      error text. A build that failed with six unresolved imports printed no line
#      matching "Deployed", and the absence of output read as success while the
#      live Worker kept serving the previous bundle.
#
# So this script never pipes the build, always checks the exit status, requires a
# version ID to be present and to have CHANGED, and then verifies the deployed
# Worker from the outside. Any of those failing is a hard failure.
#
# The origin URL is passed as a --var rather than committed, because a quick
# tunnel URL is ephemeral and would otherwise churn the git history.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/apps/worker"

export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/root/dsh-workspace/.config}"
PUBLIC_URL="https://agent-evidence-api.thx93.workers.dev"
VERSION_FILE="$ROOT/data/last-worker-version"

ORIGIN="$(cat "$ROOT/.origin-url")"
SECRET="$(cat "$ROOT/.prod-secret")"

echo "origin: $ORIGIN"
echo

echo "=== set the origin secret ==="
if ! printf '%s' "$SECRET" | wrangler secret put BACKEND_AUTH_SECRET --env="" >/tmp/wrangler-secret.log 2>&1; then
  echo "  ✖ failed to set the secret:"
  tail -6 /tmp/wrangler-secret.log | sed 's/^/    /'
  exit 1
fi
echo "  ok"

echo
echo "=== deploy (production / mainnet) ==="
OUT="$(mktemp)"
# NOT piped: the exit status must be wrangler's, not a filter's.
wrangler deploy --env="" --var "BACKEND_ORIGIN_URL:$ORIGIN" >"$OUT" 2>&1
CODE=$?

if [ "$CODE" -ne 0 ]; then
  echo "  ✖ DEPLOY FAILED (exit $CODE). Full output:"
  sed 's/^/    /' "$OUT"
  rm -f "$OUT"
  exit 1
fi

# A successful build always names the version it deployed. Requiring it means a
# silent no-op cannot pass for success.
NEW_VERSION="$(grep -oE 'Current Version ID: [0-9a-fA-F-]+' "$OUT" | awk '{print $NF}' | head -1)"
if [ -z "$NEW_VERSION" ]; then
  echo "  ✖ DEPLOY: no 'Current Version ID' in the output — refusing to call this a success."
  sed 's/^/    /' "$OUT"
  rm -f "$OUT"
  exit 1
fi

PREVIOUS="$(cat "$VERSION_FILE" 2>/dev/null || echo "")"
if [ -n "$PREVIOUS" ] && [ "$NEW_VERSION" = "$PREVIOUS" ]; then
  echo "  ✖ DEPLOY: version ID is unchanged ($NEW_VERSION) — the deploy did not take effect."
  rm -f "$OUT"
  exit 1
fi

grep -E 'Total Upload|Deployed' "$OUT" | sed 's/^/  /'
echo "  version: $NEW_VERSION (was ${PREVIOUS:-none})"
mkdir -p "$(dirname "$VERSION_FILE")"
printf '%s\n' "$NEW_VERSION" > "$VERSION_FILE"
rm -f "$OUT"

echo
echo "=== verify the LIVE Worker (from the outside) ==="
sleep 6
FAILED=0

check() {
  local label="$1" want="$2" url="$3"
  shift 3
  local got
  got="$(curl -s -m 25 -o /dev/null -w '%{http_code}' "$@" "$url" 2>/dev/null)"
  if [ "$got" = "$want" ]; then
    printf '  ✓ %-24s %s\n' "$label" "$got"
  else
    printf '  ✖ %-24s got %s, want %s\n' "$label" "$got" "$want"
    FAILED=1
  fi
}

check "health" 200 "$PUBLIC_URL/health"
check "paywall (no payment)" 402 "$PUBLIC_URL/v1/evidence" \
  -X POST -H 'content-type: application/json' -d '{"question":"q","urls":["https://example.com"]}'
check "manifest" 200 "$PUBLIC_URL/.well-known/x402"
check "MCP tools/list (free)" 200 "$PUBLIC_URL/mcp" \
  -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# The deep probe must report a reachable backend, not merely a live Worker.
DEEP="$(curl -s -m 25 "$PUBLIC_URL/health?deep=1" 2>/dev/null)"
if printf '%s' "$DEEP" | grep -q '"backend":"ok"'; then
  printf '  ✓ %-24s backend ok\n' "deep health"
else
  printf '  ✖ %-24s %s\n' "deep health" "$(printf '%s' "$DEEP" | head -c 90)"
  FAILED=1
fi

echo
if [ "$FAILED" -ne 0 ]; then
  echo "  ✖ build and deploy succeeded, but the LIVE service did not verify."
  exit 1
fi
echo "  ✓ deployed and verified: version $NEW_VERSION is live"
