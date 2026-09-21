#!/usr/bin/env bash
# Launch the backend and expose it publicly, then report the public origin.
#
# Two things are deliberately separated:
#   - the PUBLIC url is the Worker's workers.dev hostname, which never changes
#   - the ORIGIN url is a quick tunnel, which is ephemeral by nature
# So a tunnel restart means re-pointing BACKEND_ORIGIN_URL, not a new public URL
# for buyers.
#
# Writes the resolved origin to .origin-url so the deploy step can read it.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SECRET_FILE="$ROOT/.prod-secret"
ORIGIN_FILE="$ROOT/.origin-url"

# A stable secret across restarts, so the Worker does not need re-secreting.
if [ ! -f "$SECRET_FILE" ]; then
  umask 077
  openssl rand -hex 32 > "$SECRET_FILE"
  chmod 600 "$SECRET_FILE"
fi
SECRET="$(cat "$SECRET_FILE")"

echo "=== backend container ==="
docker rm -f aee-live >/dev/null 2>&1 || true
docker run -d --name aee-live --restart unless-stopped \
  -e NODE_ENV=production \
  -e BACKEND_AUTH_SECRET="$SECRET" \
  -e BACKEND_HOST=0.0.0.0 \
  -e BACKEND_PORT=8080 \
  -e CACHE_ENABLED=true \
  -e CACHE_DB_PATH=/app/data/cache.sqlite \
  -e LOG_LEVEL=info \
  -e FETCH_USER_AGENT="AgentEvidenceAPI/0.1.0 (+https://github.com/Thx93/agent-evidence-api)" \
  -e RATE_LIMIT_PER_MINUTE=60 \
  -e RATE_LIMIT_BURST=20 \
  -v aee-data:/app/data \
  -p 127.0.0.1:8080:8080 \
  agent-evidence-api-backend:0.1.0 >/dev/null

for _ in $(seq 1 30); do
  if curl -s -m 2 -o /dev/null http://127.0.0.1:8080/health 2>/dev/null; then break; fi
  sleep 1
done
printf 'health: '; curl -s -m 5 http://127.0.0.1:8080/health || echo "(not responding)"

echo
echo "=== tunnel ==="
# Kill any previous tunnel so only one is live. Wait for it to actually exit:
# racing a new tunnel against a dying one leaves orphans behind (observed).
pkill -x cloudflared 2>/dev/null || true
for _ in $(seq 1 15); do
  pgrep -x cloudflared >/dev/null 2>&1 || break
  sleep 1
done
pkill -9 -x cloudflared 2>/dev/null || true
sleep 1
rm -f /tmp/aee-tunnel.log
nohup cloudflared tunnel --url http://127.0.0.1:8080 --no-autoupdate \
  > /tmp/aee-tunnel.log 2>&1 &

ORIGIN=""
for _ in $(seq 1 40); do
  ORIGIN=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/aee-tunnel.log 2>/dev/null | head -1)
  [ -n "$ORIGIN" ] && break
  sleep 1
done

if [ -z "$ORIGIN" ]; then
  echo "FAILED to obtain a tunnel URL; last log lines:"; tail -12 /tmp/aee-tunnel.log; exit 1
fi

printf '%s\n' "$ORIGIN" > "$ORIGIN_FILE"
echo "origin: $ORIGIN"

echo
echo "=== origin reachable through the tunnel? ==="
printf 'health via tunnel: '
curl -s -m 20 "$ORIGIN/health" || echo "(no response)"
echo
printf 'unauth evidence   : '
curl -s -m 20 -o /dev/null -w '%{http_code}\n' -X POST "$ORIGIN/internal/v1/evidence" \
  -H 'content-type: application/json' -d '{"question":"q","urls":["https://example.com"]}'
