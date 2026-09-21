#!/usr/bin/env bash
# Keep the public service alive.
#
# The public URL is the Worker (stable, workers.dev). The backend origin is a
# quick Cloudflare tunnel, whose URL changes whenever it restarts. So this
# watchdog does two things on every pass:
#
#   1. if the tunnel or backend is unhealthy, restart them
#   2. if the tunnel URL changed, redeploy the Worker with the new origin
#
# Buyers never see the tunnel URL, so a restart is invisible to them.
#
# Run in the foreground, under systemd, or from cron:
#   */5 * * * * /path/to/scripts/watchdog.sh >> /var/log/aee-watchdog.log 2>&1
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="/root/dsh-workspace/bin:$PATH"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/root/dsh-workspace/.config}"

PUBLIC_URL="https://agent-evidence-api.taher-h-alhaddad.workers.dev"
LOG() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# --- 1. is the public service actually able to SERVE? -----------------------
# Deliberately the deep check. The shallow /health is answered by the Worker
# itself and stays 200 even when the backend is dead - which would let a buyer
# pay for nothing, and previously made this watchdog exit early on a broken
# service.
if curl -s -m 15 -o /dev/null "$PUBLIC_URL/health?deep=1" 2>/dev/null; then
  exit 0
fi
LOG "public health check failed; investigating"

# --- 2. is the backend container up? ---------------------------------------
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^aee-live$'; then
  LOG "backend container down; restarting"
  bash "$ROOT/scripts/go-live.sh" >/dev/null 2>&1
fi

# --- 3. is there a tunnel at all? ------------------------------------------
ORIGIN="$(cat "$ROOT/.origin-url" 2>/dev/null || true)"
if [ -z "$ORIGIN" ] || ! curl -s -m 15 -o /dev/null "$ORIGIN/health" 2>/dev/null; then
  LOG "tunnel unhealthy; starting a new one"
  bash "$ROOT/scripts/go-live.sh" >/dev/null 2>&1
  NEW_ORIGIN="$(cat "$ROOT/.origin-url" 2>/dev/null || true)"
  if [ -z "$NEW_ORIGIN" ]; then
    LOG "ERROR: could not establish an origin"
    exit 1
  fi
  if [ "$NEW_ORIGIN" != "$ORIGIN" ]; then
    LOG "origin changed: $ORIGIN -> $NEW_ORIGIN; re-pointing the Worker"
    (cd "$ROOT/apps/worker" && wrangler deploy --env="" \
      --var "BACKEND_ORIGIN_URL:$NEW_ORIGIN" >/dev/null 2>&1) \
      && LOG "Worker re-pointed" || LOG "ERROR: redeploy failed"
  fi
fi

# --- 4. final confirmation --------------------------------------------------
if curl -s -m 15 -o /dev/null "$PUBLIC_URL/health?deep=1" 2>/dev/null; then
  LOG "recovered; public service healthy"
else
  LOG "WARNING: public service still unhealthy after recovery attempt"
  exit 1
fi
