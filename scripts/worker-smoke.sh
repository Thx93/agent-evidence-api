#!/usr/bin/env bash
# Worker smoke test: proves the x402 payment boundary and the free/paid MCP split.
#
#   fixture server  ->  backend (origin auth)  ->  Worker (x402 gate)  ->  curl
#
# Runs against the Worker's `test` environment, which REQUIRES payment (the
# `dev` environment bypasses it, so it cannot validate a gate).
#
# Shuts everything down by PID; never uses `pkill -f`.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FIXTURE_PORT=8123
BACKEND_PORT=8080          # must match BACKEND_ORIGIN_URL in wrangler.jsonc env.test
WORKER_PORT=8787
SECRET="$(openssl rand -hex 32)"

export NODE_ENV=test
export ALLOW_LOOPBACK_FOR_TESTS=true
export LOG_LEVEL=error
export BACKEND_AUTH_SECRET="$SECRET"
export BACKEND_PORT FIXTURE_PORT
export CACHE_ENABLED=false

# The Worker reads secrets from apps/worker/.dev.vars (gitignored). Written here
# so both sides share the same value for this run.
printf 'BACKEND_AUTH_SECRET=%s\n' "$SECRET" > apps/worker/.dev.vars
chmod 600 apps/worker/.dev.vars

FX_PID=""; BE_PID=""; WK_PID=""
cleanup() {
  for p in "$WK_PID" "$BE_PID" "$FX_PID"; do
    [ -n "$p" ] && kill "$p" 2>/dev/null
  done
  wait 2>/dev/null
  rm -f apps/worker/.dev.vars
}
trap cleanup EXIT

node --import tsx tests/fixtures/server.ts >/tmp/aee-w-fx.log 2>&1 &
FX_PID=$!
node apps/backend/dist/server.js >/tmp/aee-w-be.log 2>&1 &
BE_PID=$!

cd apps/worker
wrangler dev --env test --port "$WORKER_PORT" --ip 127.0.0.1 >/tmp/aee-w-wk.log 2>&1 &
WK_PID=$!
cd "$ROOT"

# Wait for the Worker to accept connections.
for _ in $(seq 1 45); do
  if curl -s -m 2 -o /dev/null "http://127.0.0.1:${WORKER_PORT}/health" 2>/dev/null; then break; fi
  sleep 1
done

W="http://127.0.0.1:${WORKER_PORT}"
fail=0
check() {
  if [ "$2" = "$3" ]; then printf '  PASS  %-52s %s\n' "$1" "$3"
  else printf '  FAIL  %-52s expected %s, got %s\n' "$1" "$2" "$3"; fail=1; fi
}

echo "=== free edge endpoints ==="
check "GET /health (free)" "200" "$(curl -s -o /tmp/w-h.json -w '%{http_code}' "$W/health")"
echo "  body: $(cat /tmp/w-h.json)"
check "GET / capabilities (free)" "200" "$(curl -s -o /tmp/w-root.json -w '%{http_code}' "$W/")"

echo "=== x402 payment boundary ==="
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$W/v1/evidence" \
  -H 'content-type: application/json' \
  -d '{"question":"Is Rotamech a manufacturer of centrifugal pumps?","urls":["http://127.0.0.1:8123/company"]}')
check "POST /v1/evidence without payment -> 402" "402" "$code"

hdr=$(curl -s -D - -o /dev/null -X POST "$W/v1/evidence" -H 'content-type: application/json' \
  -d '{"question":"q","urls":["http://127.0.0.1:8123/company"]}' \
  | grep -i '^PAYMENT-REQUIRED:' | sed 's/^[^:]*: //' | tr -d '\r')
if [ -n "$hdr" ]; then
  printf '  PASS  PAYMENT-REQUIRED header present\n'
  node -e '
    const j = JSON.parse(Buffer.from(process.argv[1], "base64").toString());
    const a = j.accepts[0];
    console.log("        x402Version:", j.x402Version);
    console.log("        network    :", a.network);
    console.log("        scheme     :", a.scheme);
    console.log("        amount     :", a.amount, "=>", Number(a.amount)/1e6, "USDC");
    console.log("        payTo      :", a.payTo);
  ' "$hdr"
else
  printf '  FAIL  PAYMENT-REQUIRED header missing\n'; fail=1
fi

# SPEC section 13 orders the edge as: receive -> x402 gate -> validate -> forward.
# So a malformed body is answered 402 first; validation happens on the paid path.
check "malformed body is gated first (SPEC 13 order)" "402" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$W/v1/evidence" \
  -H 'content-type: application/json' -d '{}')"

echo "=== MCP: free discovery, paid invocation ==="
init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
check "MCP initialize is FREE (no 402)" "200" "$(curl -s -o /tmp/w-mcp.json -w '%{http_code}' -X POST "$W/mcp" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d "$init")"

list='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
check "MCP tools/list is FREE (no 402)" "200" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$W/mcp" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d "$list")"

call='{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"research_evidence","arguments":{"question":"q","urls":["http://127.0.0.1:8123/company"]}}}'
check "MCP tools/call research_evidence -> 402" "402" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$W/mcp" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d "$call")"

call2='{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"health","arguments":{}}}'
check "MCP tools/call health is FREE (no 402)" "200" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$W/mcp" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d "$call2")"

echo
[ "$fail" -eq 0 ] && echo "WORKER SMOKE: ALL CHECKS PASSED" || echo "WORKER SMOKE: FAILURES PRESENT"
exit "$fail"
