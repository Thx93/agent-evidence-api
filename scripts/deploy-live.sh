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
PUBLIC_URL="https://agent-evidence.thx93.dev"
VERSION_FILE="$ROOT/data/last-worker-version"

# A quick tunnel is handed a new hostname on every restart, so .origin-url is
# machine-local runtime state and is deliberately NOT tracked in git: tracking it
# left the tree permanently dirty and risked committing a hostname that had since
# died. Refuse to deploy with an empty origin instead of silently shipping
# `BACKEND_ORIGIN_URL=""`, which would break every paid route.
if [ ! -s "$ROOT/.origin-url" ]; then
  echo "  ✖ $ROOT/.origin-url is missing or empty."
  echo "    It holds the current tunnel hostname. Run scripts/watchdog.sh once to"
  echo "    discover it and start the tunnel:  bash scripts/watchdog.sh --once"
  exit 1
fi
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
echo "=== build the workspace packages the Worker imports ==="
# Why this is here: the Worker imports @aee/schemas, and wrangler resolves that to
# the package's `dist`, not its `src`. This script used to go straight to
# `wrangler deploy`, so a stale `dist` was bundled silently - on 2026-10-18 the
# deployed Worker was found still reporting SERVICE_VERSION 0.1.4 from a dist
# built three days earlier, while src said 0.1.5. Typecheck reads src, so nothing
# caught it. Build first, and fail loudly rather than shipping an old artifact.
BUILD_OUT="$(mktemp)"
if ! pnpm build >"$BUILD_OUT" 2>&1; then
  echo "  ✖ BUILD FAILED. Full output:"
  sed 's/^/    /' "$BUILD_OUT"
  rm -f "$BUILD_OUT"
  exit 1
fi
rm -f "$BUILD_OUT"

# Prove the build actually refreshed the artifact the Worker will bundle.
# `wrangler` resolves @aee/schemas to its `dist`, and a stale dist has twice shipped
# a wrong SERVICE_VERSION to production - once three days old, and again when a
# 0.1.6 source shipped as 0.1.5. `pnpm build` is supposed to prevent that; this
# checks it did, because "the build ran" and "the artifact changed" are different
# claims.
# Paths are absolute: this script has already cd'd to "$ROOT/apps/worker", so a
# relative path here silently finds nothing - which the first version of this guard
# did, and then refused every deploy because it could not read a file that exists.
SRC_VERSION="$(sed -n 's/.*SERVICE_VERSION = "\([^"]*\)".*/\1/p' "$ROOT/packages/schemas/src/evidence.ts")"
DIST_VERSION="$(sed -n 's/.*SERVICE_VERSION = "\([^"]*\)".*/\1/p' "$ROOT/packages/schemas/dist/evidence.js")"
if [ -z "$DIST_VERSION" ] || [ "$DIST_VERSION" != "$SRC_VERSION" ]; then
  echo "  ✖ the built @aee/schemas is stale: src=$SRC_VERSION dist=${DIST_VERSION:-missing}"
  echo "    The Worker would bundle the dist copy. Refusing to deploy."
  exit 1
fi
echo "  ok (schemas dist matches src: $SRC_VERSION)"

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
# Wait for the edge to actually settle rather than guessing with a fixed sleep.
# This used to be `sleep 6`, and on 2026-10-18 that produced a FALSE FAILURE: the
# deploy had succeeded, but the verification ran while the version swap was still
# propagating and saw 502 from the origin and 530 (Cloudflare) on the manifest.
# The watchdog reading that output logged "deploy-failed" and backed off from a
# deploy that had in fact worked - so a guard that cries wolf is worse than none.
# Poll the two endpoints that prove the swap landed; only if they never come good
# do the checks below get to fail.
SETTLE_DEADLINE=$((SECONDS + 75))
while :; do
  health_code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$PUBLIC_URL/health" 2>/dev/null || echo 000)"
  pay_code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "$PUBLIC_URL/v1/evidence" \
    -H 'content-type: application/json' -d '{"question":"settle-probe"}' 2>/dev/null || echo 000)"
  if [ "$health_code" = "200" ] && [ "$pay_code" = "402" ]; then
    break
  fi
  if [ "$SECONDS" -ge "$SETTLE_DEADLINE" ]; then
    echo "  (edge did not settle within the deadline: health=$health_code paywall=$pay_code; checking anyway)"
    break
  fi
  sleep 3
done
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
# The MCP paywall lives in the backend now, but the guard stays here: this is the
# buyer-visible outcome, and an earlier attempt at moving the gate charged the FREE
# handshake above. Both directions are checked so neither can regress unnoticed.
check "MCP paid tool gated" 402 "$PUBLIC_URL/mcp" \
  -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"research_evidence","arguments":{"question":"q"}}}'

# The MCP challenge has to name the PUBLIC /mcp address and declare the MCP tool
# shape; that declaration is what the CDP Bazaar catalogues.
MCP_CHALLENGE="$(curl -s -m 25 -D - -o /dev/null -X POST "$PUBLIC_URL/mcp" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"research_evidence","arguments":{"question":"q"}}}' 2>/dev/null \
  | grep -i '^payment-required:' | cut -d' ' -f2 | tr -d '\r' | base64 -d 2>/dev/null)"
if printf '%s' "$MCP_CHALLENGE" | grep -q '"type":"mcp"' && printf '%s' "$MCP_CHALLENGE" | grep -q '/mcp"'; then
  printf '  ✓ %-24s %s\n' "MCP challenge" "public /mcp, declares mcp"
else
  printf '  ✖ %-24s %s\n' "MCP challenge" "missing the public /mcp resource or the mcp declaration"
  FAILED=1
fi

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
