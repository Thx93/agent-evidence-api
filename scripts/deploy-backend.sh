#!/usr/bin/env bash
# Build and deploy the backend container, then PROVE the live service from outside.
#
# Why this exists: the paywall lives in the backend, and the backend is what
# decides whether the MCP route is discoverable. Rebuilding it by hand is how a
# stale image ends up serving while the source says otherwise. Two guardrails,
# mirroring scripts/deploy-live.sh:
#
#   - the container is started from a deliberate env file, NOT from `-e` flags, so
#     no secret ever lands on a command line or in a shell history;
#   - a version ID is required to change and the live service is then verified
#     from the public URL. A build that succeeded is not a deploy that took.
#
# Secrets live OUTSIDE the repository:
#   /root/dsh-workspace/.aee-live.env     runtime environment (0600)
#   /root/dsh-workspace/.cdp-credentials  the CDP keys alone, for rotation (0600)
#
# Usage: bash scripts/deploy-backend.sh [version]
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="$(cd "$ROOT/.." && pwd)"

ENV_FILE="$WORKSPACE/.aee-live.env"
PUBLIC_URL="https://agent-evidence-api.thx93.workers.dev"
VERSION_FILE="$ROOT/data/last-backend-version"

if [ ! -f "$ENV_FILE" ]; then
  echo "  ✖ missing $ENV_FILE (runtime environment; chmod 600, never committed)"
  exit 1
fi

# The version is the image tag. Default: bump the patch of the running image so a
# redeploy cannot silently reuse the previous tag.
CURRENT_TAG="$(cat "$VERSION_FILE" 2>/dev/null || echo "0.1.4")"
VERSION="${1:-$(printf '%s' "$CURRENT_TAG" | awk -F. '{printf "%d.%d.%d", $1, $2, $3+1}')}"
IMAGE="agent-evidence-api-backend:$VERSION"

echo "=== build $IMAGE ==="
cd "$ROOT"
docker build -f docker/Dockerfile -t "$IMAGE" . || {
  echo "  ✖ docker build failed"
  exit 1
}
echo "  ok"

echo
echo "=== validate the new image on a staging port, before touching the live one ==="
# The live container keeps serving while the new image is proven. The staging
# instance gets its own cache volume: two SQLite writers on one volume is a
# corruption risk, not a smoke test.
docker rm -f aee-staging >/dev/null 2>&1 || true
if ! docker run -d --name aee-staging --env-file "$ENV_FILE" \
      -e BACKEND_PORT=18080 \
      -v aee-staging-data:/app/data \
      -p 127.0.0.1:18080:18080 \
      "$IMAGE" >/dev/null; then
  echo "  ✖ staging container failed to start"
  exit 1
fi

STAGING_OK=0
for _ in $(seq 1 30); do
  if curl -s -m 2 -o /dev/null http://127.0.0.1:18080/health 2>/dev/null; then STAGING_OK=1; break; fi
  sleep 1
done

if [ "$STAGING_OK" -ne 1 ]; then
  echo "  ✖ the new image did not answer /health on :18080; live service untouched"
  docker logs aee-staging 2>&1 | tail -30 | sed 's/^/    /'
  docker rm -f aee-staging >/dev/null 2>&1 || true
  exit 1
fi

# The free MCP handshake must answer without payment. This is the exact check the
# Worker deploy guard uses, and the one that caught an earlier attempt at moving
# this gate.
STAGING_MCP="$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:18080/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H "x-backend-auth:$(grep '^BACKEND_AUTH_SECRET=' "$ENV_FILE" | cut -d= -f2-)" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' 2>/dev/null)"
if [ "$STAGING_MCP" != "200" ]; then
  echo "  ✖ the new image charges or breaks the free MCP handshake (got $STAGING_MCP); live service untouched"
  docker logs aee-staging 2>&1 | tail -30 | sed 's/^/    /'
  docker rm -f aee-staging >/dev/null 2>&1 || true
  exit 1
fi
echo "  ok — health and free MCP handshake both answer"
docker rm -f aee-staging >/dev/null 2>&1 || true

echo
echo "=== swap the live container ==="
docker rm -f aee-live >/dev/null 2>&1 || true
# --env-file rather than -e: the values include a wallet-adjacent secret and rot
# regularly, and a command line is the wrong place for either.
if ! docker run -d --name aee-live --restart unless-stopped \
      --env-file "$ENV_FILE" \
      -v aee-data:/app/data \
      -p 127.0.0.1:8080:8080 \
      "$IMAGE" >/dev/null; then
  echo "  ✖ container failed to start"
  docker logs aee-live 2>&1 | tail -20 | sed 's/^/    /'
  exit 1
fi

HEALTHY=0
for _ in $(seq 1 30); do
  if curl -s -m 2 -o /dev/null http://127.0.0.1:8080/health 2>/dev/null; then HEALTHY=1; break; fi
  sleep 1
done
if [ "$HEALTHY" -ne 1 ]; then
  echo "  ✖ container did not answer /health; last log lines:"
  docker logs aee-live 2>&1 | tail -30 | sed 's/^/    /'
  exit 1
fi
echo "  ok — $(curl -s -m 5 http://127.0.0.1:8080/health)"

# A container that starts and then exits is the failure mode this catches.
if [ "$(docker inspect -f '{{.State.Running}}' aee-live 2>/dev/null)" != "true" ]; then
  echo "  ✖ container is not running after the health check"
  docker logs aee-live 2>&1 | tail -30 | sed 's/^/    /'
  exit 1
fi

echo
echo "=== verify the LIVE service (from the outside) ==="
sleep 3
FAILED=0

check() {
  local label="$1" want="$2" url="$3"
  shift 3
  local got
  got="$(curl -s -m 30 -o /dev/null -w '%{http_code}' "$@" "$url" 2>/dev/null)"
  if [ "$got" = "$want" ]; then
    printf '  ✓ %-28s %s\n' "$label" "$got"
  else
    printf '  ✖ %-28s got %s, want %s\n' "$label" "$got" "$want"
    FAILED=1
  fi
}

check "health" 200 "$PUBLIC_URL/health"
check "HTTP paywall" 402 "$PUBLIC_URL/v1/evidence" \
  -X POST -H 'content-type: application/json' -d '{"question":"q","urls":["https://example.com"]}'
check "MCP tools/list (free)" 200 "$PUBLIC_URL/mcp" \
  -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
check "MCP paid tool gated" 402 "$PUBLIC_URL/mcp" \
  -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"research_evidence","arguments":{"question":"q"}}}'

# The MCP challenge must name the PUBLIC MCP URL and declare the MCP tool shape —
# that declaration is the entire reason this route moved to the backend.
MCP_CHALLENGE="$(curl -s -m 30 -D - -o /dev/null -X POST "$PUBLIC_URL/mcp" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"research_evidence","arguments":{"question":"q"}}}' 2>/dev/null \
  | grep -i '^payment-required:' | cut -d' ' -f2 | tr -d '\r' | base64 -d 2>/dev/null)"

if printf '%s' "$MCP_CHALLENGE" | grep -q '"type":"mcp"'; then
  printf '  ✓ %-28s %s\n' "MCP bazaar declares mcp" "yes"
else
  printf '  ✖ %-28s %s\n' "MCP bazaar declares mcp" "no — CDP cannot catalogue the route"
  FAILED=1
fi
if printf '%s' "$MCP_CHALLENGE" | grep -q '/mcp"'; then
  printf '  ✓ %-28s %s\n' "MCP challenge names /mcp" "yes"
else
  printf '  ✖ %-28s %s\n' "MCP challenge names /mcp" "no — it advertises an internal origin"
  FAILED=1
fi

echo
if [ "$FAILED" -ne 0 ]; then
  echo "  ✖ build and start succeeded, but the LIVE service did not verify."
  echo "    Previous image is not restored automatically; fix and re-run."
  exit 1
fi

mkdir -p "$(dirname "$VERSION_FILE")"
printf '%s\n' "$VERSION" > "$VERSION_FILE"
echo "  ✓ deployed and verified: backend $VERSION is live"
