#!/usr/bin/env bash
# Live smoke test: exercises the built backend over real sockets, including the
# SQLite cache path (which the unit suite disables) and the origin-auth gate.
#
# Starts the fixture server and the backend, drives them with curl, then shuts
# both down by PID. Deliberately avoids `pkill -f`, which would match this
# script's own command line and kill the parent shell.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BACKEND_PORT="${BACKEND_PORT:-8099}"
FIXTURE_PORT="${FIXTURE_PORT:-8123}"
export NODE_ENV=test
export ALLOW_LOOPBACK_FOR_TESTS=true
export LOG_LEVEL=info
export BACKEND_AUTH_SECRET="${BACKEND_AUTH_SECRET:-$(openssl rand -hex 32)}"
export BACKEND_PORT FIXTURE_PORT
export CACHE_ENABLED=true
export CACHE_DB_PATH="$ROOT/data/smoke-cache.sqlite"

rm -rf "$ROOT/data"
mkdir -p "$ROOT/data"

FX_PID=""
BE_PID=""
cleanup() {
  [ -n "$FX_PID" ] && kill "$FX_PID" 2>/dev/null
  [ -n "$BE_PID" ] && kill "$BE_PID" 2>/dev/null
  wait "$FX_PID" "$BE_PID" 2>/dev/null
}
trap cleanup EXIT

node --import tsx tests/fixtures/server.ts >/tmp/aee-fx.log 2>&1 &
FX_PID=$!
node apps/backend/dist/server.js >/tmp/aee-be.log 2>&1 &
BE_PID=$!
sleep 3

B="http://127.0.0.1:${BACKEND_PORT}"
F="http://127.0.0.1:${FIXTURE_PORT}"
fail=0
check() { # label expected actual
  if [ "$2" = "$3" ]; then printf '  PASS  %-46s %s\n' "$1" "$3"
  else printf '  FAIL  %-46s expected %s, got %s\n' "$1" "$2" "$3"; fail=1; fi
}

echo "=== health ==="
code=$(curl -s -o /tmp/aee-h.json -w '%{http_code}' "$B/health")
check "GET /health returns 200" "200" "$code"
echo "  body: $(cat /tmp/aee-h.json)"

echo "=== origin protection ==="
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/internal/v1/evidence" \
  -H 'content-type: application/json' \
  -d "{\"question\":\"q\",\"urls\":[\"$F/company\"]}")
check "evidence without secret is refused" "401" "$code"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/internal/v1/evidence" \
  -H 'x-backend-auth: wrong-secret-wrong-secret' -H 'content-type: application/json' \
  -d "{\"question\":\"q\",\"urls\":[\"$F/company\"]}")
check "evidence with wrong secret is refused" "401" "$code"

echo "=== live evidence pipeline ==="
Q='{"question":"Is Rotamech Industries a manufacturer of centrifugal pumps?","urls":["'"$F"'/company"]}'
code=$(curl -s -o /tmp/aee-e.json -w '%{http_code}' -X POST "$B/internal/v1/evidence" \
  -H "x-backend-auth: $BACKEND_AUTH_SECRET" -H 'content-type: application/json' -d "$Q")
check "authenticated evidence request succeeds" "200" "$code"

node -e '
const j = JSON.parse(require("fs").readFileSync("/tmp/aee-e.json","utf8"));
const s = j.sources[0];
const line = (k,v) => console.log("  " + k.padEnd(12) + ": " + v);
line("assessment", j.assessment.status);
line("basis", j.assessment.basis.slice(0,80));
line("title", s.title);
line("publisher", s.publisher);
line("word_count", s.word_count);
line("hash", (s.content_hash_sha256||"").slice(0,24) + "…");
line("retrieved", s.retrieved_at);
line("evidence", s.evidence.length + " item(s)");
line("excerpt", ((s.evidence[0]||{}).excerpt||"").slice(0,80));
line("from_cache", s.from_cache);
line("json_ld", s.structured_data.json_ld.length + " block(s)");
'

echo "=== cache reuse ==="
curl -s -o /tmp/aee-e2.json -X POST "$B/internal/v1/evidence" \
  -H "x-backend-auth: $BACKEND_AUTH_SECRET" -H 'content-type: application/json' -d "$Q"
node -e '
const s = JSON.parse(require("fs").readFileSync("/tmp/aee-e2.json","utf8")).sources[0];
console.log("  from_cache  :", s.from_cache);
console.log("  retrieved_at:", s.retrieved_at, "(actual retrieval time, not now)");
'

echo "=== sqlite cache file ==="
if [ -f "$ROOT/data/smoke-cache.sqlite" ]; then
  printf '  PASS  cache database created (%s bytes)\n' "$(stat -c%s "$ROOT/data/smoke-cache.sqlite")"
else
  printf '  FAIL  cache database missing\n'; fail=1
fi

echo
[ "$fail" -eq 0 ] && echo "SMOKE TEST: ALL CHECKS PASSED" || echo "SMOKE TEST: FAILURES PRESENT"
exit "$fail"
