#!/usr/bin/env bash
# Worker smoke test: proves the public path and the free/paid MCP split through a
# REAL wrangler dev Worker.
#
#   fixture server  ->  backend (origin auth + x402 gate)  ->  Worker (proxy)  ->  curl
#
# The payment gate runs in the BACKEND, not the Worker (the CDP Facilitator cannot
# run on Workers at all — see docs/market-analysis.md). This script still exercises
# the Worker because it is the only part of the path with a separate runtime.
#
# The backend needs a reachable facilitator to build its challenge, so this uses
# the public testnet facilitator by default. Override with X402_FACILITATOR_URL.
#
# Shuts everything down by PID; never uses `pkill -f`.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FIXTURE_PORT=8123
# 8181 rather than 8080: the deployed backend container publishes 127.0.0.1:8080,
# so a local run on the same port silently does not bind and the test then talks to
# the live service with the wrong secret (observed: every check returned 401).
BACKEND_PORT="${BACKEND_PORT:-8181}"
WORKER_PORT=8787
SECRET="$(openssl rand -hex 32)"

export NODE_ENV=test
export ALLOW_LOOPBACK_FOR_TESTS=true
export LOG_LEVEL=error
export BACKEND_AUTH_SECRET="$SECRET"
export BACKEND_PORT FIXTURE_PORT
export CACHE_ENABLED=false

# The Worker reads secrets from apps/worker/.dev.vars (gitignored). Written here
# so both sides share the same value for this run. wrangler reads `.dev.vars.<env>`
# for a named environment, so the `test` env needs its own copy — a `.dev.vars`
# alone leaves the Worker with no secret and every proxied request comes back 401.
printf 'BACKEND_AUTH_SECRET=%s\n' "$SECRET" > apps/worker/.dev.vars
printf 'BACKEND_AUTH_SECRET=%s\n' "$SECRET" > apps/worker/.dev.vars.test
printf 'BACKEND_AUTH_SECRET=%s\n' "$SECRET" > apps/worker/.dev.vars.dev
chmod 600 apps/worker/.dev.vars apps/worker/.dev.vars.test apps/worker/.dev.vars.dev

FX_PID=""; BE_PID=""; WK_PID=""
cleanup() {
  for p in "$WK_PID" "$BE_PID" "$FX_PID"; do
    [ -n "$p" ] && kill "$p" 2>/dev/null
  done
  wait 2>/dev/null
  rm -f apps/worker/.dev.vars apps/worker/.dev.vars.test apps/worker/.dev.vars.dev
}
trap cleanup EXIT

node --import tsx tests/fixtures/server.ts >/tmp/aee-w-fx.log 2>&1 &
FX_PID=$!
node apps/backend/dist/server.js >/tmp/aee-w-be.log 2>&1 &
BE_PID=$!

# The backend must actually bind. Without this the checks below silently talk to
# whatever else is on the port and every one returns 401.
for _ in $(seq 1 30); do
  if curl -s -m 2 -o /dev/null "http://127.0.0.1:${BACKEND_PORT}/health" 2>/dev/null; then break; fi
  sleep 1
done
if ! curl -s -m 2 -o /dev/null "http://127.0.0.1:${BACKEND_PORT}/health" 2>/dev/null; then
  echo "  ✖ the backend did not bind on :${BACKEND_PORT}; last log lines:"
  tail -20 /tmp/aee-w-be.log | sed 's/^/    /'
  exit 1
fi

cd apps/worker
wrangler dev --env test --port "$WORKER_PORT" --ip 127.0.0.1 \
  --var "BACKEND_ORIGIN_URL:http://127.0.0.1:${BACKEND_PORT}" >/tmp/aee-w-wk.log 2>&1 &
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

# The paywall precedes validation on both transports, so a request that is not a
# recognised free operation is answered 402 first; validation happens on the paid
# path, where a failure cancels settlement rather than charging.
check "malformed body is gated first" "402" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$W/v1/evidence" \
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
