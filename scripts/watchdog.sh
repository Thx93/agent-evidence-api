#!/usr/bin/env bash
# ============================================================================
# Agent Evidence API — Dockerized watchdog (tunnel + Worker origin + liveness)
# ============================================================================
# WHY THIS EXISTS
#   The public edge is a Cloudflare Worker; its origin is a cloudflared QUICK
#   TUNNEL, whose hostname changes on every restart. The Worker reaches the
#   origin through the plain-text var BACKEND_ORIGIN_URL, so a tunnel restart
#   silently leaves the Worker pointing at a dead hostname and the service
#   answers 502 / {"status":"degraded","backend":"unreachable"}.
#   That happened twice: 2026-09-22 (~2 days) and 2026-09-24..2026-10-18 (~3
#   weeks, invisible from outside; Glama's hourly check emailed "HTTP 502").
#
#   The lesson from those outages: processes started from a shell session (a
#   setsid/nohup cloudflared plus a shell supervisor) were killed, while the
#   Docker-managed containers survived ("aee-live Up 3 weeks"). So the watchdog
#   must itself be Docker-managed with a restart policy. This script is that
#   container's inner loop — not a cron job.
#
# WHAT ONE CYCLE DOES (in this order)
#   1. ensure the `aee-tunnel` container exists and is running, (re)starting it
#      with the same `docker run` arguments documented in
#      docker/watchdog/README.md if it is missing or stopped;
#   2. read the tunnel's CURRENT public URL out of `docker logs aee-tunnel`
#      (last match of https://[a-z0-9-]+\.trycloudflare\.com);
#   3. if that URL differs from the contents of .origin-url, write the new URL
#      and run `bash scripts/deploy-live.sh` — that script is the only safe path,
#      because it also re-applies the secret_text binding BACKEND_AUTH_SECRET,
#      which is unrecoverable if it is dropped — then confirm the live service
#      is healthy;
#   4. independently probe GET $PUBLIC_URL/health?deep=1 and treat it as healthy
#      only if the body contains "backend":"ok". Two consecutive unhealthy
#      cycles while the tunnel URL already matches .origin-url mean the Worker
#      is stale, and earn ONE rate-limited redeploy;
#   5. rate-limit Worker deploys: never more than one per 5 minutes, backing off
#      10 -> 20 -> 30 (cap) minutes while deploys keep failing, so a broken
#      backend can never become a deploy storm;
#   6. append EXACTLY ONE timestamped line per cycle to data/watchdog.log
#      (creating data/ if absent), trimmed to the last AEE_LOG_MAX_LINES lines.
#      Full deploy output goes to data/watchdog-deploy.log instead, so the cycle
#      log stays one line per cycle.
#
# No jq is required: only `docker`, `curl` and core shell tools are used.
#
# ENVIRONMENT (all optional; defaults are the live service's real values)
#   WATCHDOG_INTERVAL           seconds between cycles           (default 60)
#   AEE_ROOT                    repo root                        (default: parent of this script)
#   AEE_PUBLIC_URL              public Worker URL                (default: the live one)
#   AEE_TUNNEL_CONTAINER        tunnel container name            (default aee-tunnel)
#   AEE_BACKEND_CONTAINER       backend container name           (default aee-live)
#   AEE_BACKEND_ORIGIN          local origin the tunnel exposes  (default http://127.0.0.1:8080)
#   AEE_CLOUDFLARE_CREDENTIALS  file holding CLOUDFLARE_*       (default /root/Agents Projects/.cloudflare-credentials)
#   AEE_DEPLOY_MIN_GAP          hard floor between deploys, secs (default 300)
#   AEE_BACKOFF_CAP             back-off ceiling, secs           (default 1800)
#   AEE_TUNNEL_RESTART_MIN_GAP  floor between tunnel restarts    (default 300)
#   AEE_LOG_MAX_LINES           watchdog.log retention, lines    (default 2000)
#   AEE_LOG / AEE_DEPLOY_LOG    log destinations, for running a second instance
#                               side by side without interleaving (defaults:
#                               data/watchdog.log and data/watchdog-deploy.log;
#                               .origin-url is deliberately NOT overridable,
#                               because scripts/deploy-live.sh reads it)
#
# A cycle that both recreates the tunnel and repoints the Worker reports both,
# joined by "+", e.g. action=tunnel-started(missing)+deployed(origin-changed).
#
# USAGE
#   bash scripts/watchdog.sh           # long-running loop (what the container runs)
#   bash scripts/watchdog.sh --once    # one cycle, then exit 0 if healthy / 1 if not
#
# This script never prints a secret: it reads CLOUDFLARE_API_TOKEN /
# CLOUDFLARE_ACCOUNT_ID out of the mounted credentials file without echoing
# them, and passes them to scripts/deploy-live.sh through the environment.
# ============================================================================
set -uo pipefail

# --------------------------------------------------------------------------
# configuration
# --------------------------------------------------------------------------
ROOT="${AEE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT" || exit 1

# wrangler/pnpm/node are workspace wrappers, not system packages; deploy-live.sh
# and the wrappers it calls resolve them from PATH, and the wrangler wrapper
# resolves its stored OAuth config (a fallback only) from XDG_CONFIG_HOME.
export PATH="/root/Agents Projects/bin:${PATH}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/root/Agents Projects/.config}"
export HOME="${HOME:-/root}"

PUBLIC_URL="${AEE_PUBLIC_URL:-https://agent-evidence.thx93.dev}"
TUNNEL_CONTAINER="${AEE_TUNNEL_CONTAINER:-aee-tunnel}"
BACKEND_CONTAINER="${AEE_BACKEND_CONTAINER:-aee-live}"
BACKEND_ORIGIN="${AEE_BACKEND_ORIGIN:-http://127.0.0.1:8080}"
ORIGIN_FILE="$ROOT/.origin-url"
# The log paths are overridable only so a second instance can be run for testing
# without interleaving with the production one. .origin-url is NOT overridable:
# scripts/deploy-live.sh reads exactly "$ROOT/.origin-url".
LOG="${AEE_LOG:-$ROOT/data/watchdog.log}"
DEPLOY_LOG="${AEE_DEPLOY_LOG:-$ROOT/data/watchdog-deploy.log}"
LOG_MAX_LINES="${AEE_LOG_MAX_LINES:-2000}"
INTERVAL="${WATCHDOG_INTERVAL:-60}"
DEPLOY_MIN_GAP="${AEE_DEPLOY_MIN_GAP:-300}"
BACKOFF_CAP="${AEE_BACKOFF_CAP:-1800}"
TUNNEL_RESTART_MIN_GAP="${AEE_TUNNEL_RESTART_MIN_GAP:-300}"

MODE="loop"
case "${1:-}" in
  --once|-1) MODE="once" ;;
  --help|-h) sed -n '1,70p' "${BASH_SOURCE[0]}"; exit 0 ;;
esac

mkdir -p "$ROOT/data"

# --------------------------------------------------------------------------
# state — deliberately in-memory: this process is long-lived, which is the
# whole point of the design (a one-shot script cannot rate-limit itself).
# --------------------------------------------------------------------------
unhealthy_streak=0                  # consecutive cycles the live service was unhealthy
last_deploy_epoch=0                 # epoch of the last deploy ATTEMPT
next_deploy_gap="$DEPLOY_MIN_GAP"   # current floor before the next attempt
deploy_failures=0                   # consecutive failed deploys (drives the back-off)
last_tunnel_action=0                # epoch of the last tunnel (re)start
last_health="unknown"               # last observed live health
tunnel_note=""                      # why the tunnel was (re)started this cycle
deploy_note=""                      # outcome detail from the last deploy attempt

# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
now_epoch() { date +%s; }

trim_log() { # $1 = file, $2 = lines to keep
  local f="$1" n="$2" tmp
  [ -f "$f" ] || return 0
  tmp="$(mktemp "$f.tmp.XXXXXX")" || return 0
  if tail -n "$n" "$f" > "$tmp" 2>/dev/null; then mv "$tmp" "$f"; else rm -f "$tmp"; fi
}

# log_line <fields...> — exactly one timestamped line per cycle
log_line() {
  printf '[%s] %s\n' "$(ts)" "$*" >> "$LOG"
  trim_log "$LOG" "$LOG_MAX_LINES"
}

# Load Cloudflare credentials without sourcing the file (so it can never execute
# anything) and without ever echoing the values. Skipped when the container
# already supplies them through its environment.
load_credentials() {
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && return 0
  local f="${AEE_CLOUDFLARE_CREDENTIALS:-/root/Agents Projects/.cloudflare-credentials}"
  [ -r "$f" ] || return 1
  local line k v
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    k="${line%%=*}"
    v="${line#*=}"
    v="${v%\"}"; v="${v#\"}"
    case "$k" in
      CLOUDFLARE_API_TOKEN)  export CLOUDFLARE_API_TOKEN="$v" ;;
      CLOUDFLARE_ACCOUNT_ID) export CLOUDFLARE_ACCOUNT_ID="$v" ;;
    esac
  done < "$f"
}

container_running() { # $1 = container name
  [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ]
}

# The local origin the tunnel exposes. Only meaningful when this container runs
# with --network host (which the documented `docker run` does).
backend_local_ok() {
  [ "$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$BACKEND_ORIGIN/health" 2>/dev/null)" = "200" ]
}

# The current public tunnel URL, as announced in the container's own logs.
# Last match wins: after a restart the newest announcement is the live hostname.
tunnel_url() {
  docker logs "$TUNNEL_CONTAINER" 2>&1 \
    | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' \
    | tail -1
}

# Ensure the tunnel container is up, with the exact arguments the live service
# uses. Records why it acted in $tunnel_note instead of logging a second line.
ensure_tunnel() {
  if container_running "$TUNNEL_CONTAINER"; then return 0; fi
  if ! docker inspect -f '{{.Id}}' "$TUNNEL_CONTAINER" >/dev/null 2>&1; then
    tunnel_note="missing"
  else
    tunnel_note="not-running"
  fi
  docker rm -f "$TUNNEL_CONTAINER" >/dev/null 2>&1
  if docker run -d --name "$TUNNEL_CONTAINER" --restart unless-stopped --network host \
      cloudflare/cloudflared:latest tunnel --url "$BACKEND_ORIGIN" --no-autoupdate >/dev/null 2>&1; then
    last_tunnel_action="$(now_epoch)"
    return 0
  fi
  tunnel_note="${tunnel_note}-start-failed"
  return 1
}

# Recycle a tunnel that is running but whose public path is dead. A recycled
# quick tunnel gets a NEW hostname, which the next cycle sees as a URL change
# and repoints the Worker at.
recycle_tunnel() {
  docker rm -f "$TUNNEL_CONTAINER" >/dev/null 2>&1
  tunnel_note="recycle"
  ensure_tunnel
}

# The live service is healthy ONLY when the deep probe says the backend is ok.
# The shallow /health is answered by the Worker itself and stays 200 even when
# the backend is dead, which is exactly how the two outages stayed invisible.
live_health() {
  local body
  body="$(curl -s -m 25 "$PUBLIC_URL/health?deep=1" 2>/dev/null)"
  if printf '%s' "$body" | grep -Eq '"backend"[[:space:]]*:[[:space:]]*"ok"'; then
    printf 'ok'
  elif [ -z "$body" ]; then
    printf 'unreachable'
  else
    printf 'degraded'
  fi
}

# live_health with a short settle window. A freshly deployed Worker version
# propagates across Cloudflare's edge over a few seconds, so a probe taken the
# instant a deploy finishes can still read the PREVIOUS (broken) version and make
# a successful heal look like a failure.
live_health_settled() {
  local h i
  for i in 1 2 3 4; do
    h="$(live_health)"
    [ "$h" = "ok" ] && { printf 'ok'; return 0; }
    [ "$i" -lt 4 ] && sleep 8
  done
  printf '%s' "$h"
}

deploy_allowed() {
  [ $(( $(now_epoch) - last_deploy_epoch )) -ge "$next_deploy_gap" ]
}

# run_deploy <reason> -> 0 on success, 1 on failure. Records the attempt and
# widens the back-off on failure (5min floor -> 10 -> 20 -> 30 cap).
# NOTE: must run in THIS shell, never in a subshell, or the rate-limiter state
# is lost and the watchdog would redeploy every cycle.
#
# Success is judged by the OUTCOME (is the live service serving with a reachable
# backend?), not by deploy-live.sh's exit status alone. That script verifies the
# Worker from the outside immediately after deploying, and its checks are
# legitimately flaky for a few seconds after an origin change: Cloudflare
# propagates the new version gradually, so some of its probes can still hit the
# previous (broken) version and fail (observed: 502 paywall / 530 manifest while
# deep health already said "backend":"ok"). Treating that as a failed deploy
# would start a 10-minute back-off over a service that is already healed.
run_deploy() {
  local reason="$1" gap i
  deploy_note=""
  last_deploy_epoch="$(now_epoch)"
  printf '=== %s deploy: %s ===\n' "$(ts)" "$reason" >> "$DEPLOY_LOG"
  if bash "$ROOT/scripts/deploy-live.sh" >> "$DEPLOY_LOG" 2>&1; then
    deploy_failures=0
    next_deploy_gap="$DEPLOY_MIN_GAP"
    trim_log "$DEPLOY_LOG" "$LOG_MAX_LINES"
    return 0
  fi
  # The script said no. Ask the service itself before believing it.
  if [ "$(live_health_settled)" = "ok" ]; then
    deploy_note="deploy-script-verify-flaky-but-live-healthy"
    deploy_failures=0
    next_deploy_gap="$DEPLOY_MIN_GAP"
    trim_log "$DEPLOY_LOG" "$LOG_MAX_LINES"
    return 0
  fi
  deploy_failures=$((deploy_failures + 1))
  gap="$DEPLOY_MIN_GAP"
  for ((i = 0; i < deploy_failures; i++)); do gap=$((gap * 2)); done
  [ "$gap" -gt "$BACKOFF_CAP" ] && gap="$BACKOFF_CAP"
  next_deploy_gap="$gap"
  deploy_note="deploy-failed-and-live-still-unhealthy"
  trim_log "$DEPLOY_LOG" "$LOG_MAX_LINES"
  return 1
}

# --------------------------------------------------------------------------
# one cycle
# --------------------------------------------------------------------------
run_cycle() {
  local url cur url_changed="no" action="none" origin_state="unknown" note=""
  local backend_state="unknown" tunnel_action=""

  tunnel_note=""
  deploy_note=""
  tunnel_action=""

  # (a) the tunnel must be running under Docker.
  if ensure_tunnel; then
    [ -n "$tunnel_note" ] && tunnel_action="tunnel-started($tunnel_note)"
  else
    tunnel_action="tunnel-start-failed(${tunnel_note:-unknown})"
  fi

  # (b) the tunnel's current public URL. A freshly started container needs a few
  # seconds to announce it, so poll instead of declaring "no URL" immediately.
  url="$(tunnel_url)"
  if [ -z "$url" ]; then
    local i
    for i in $(seq 1 15); do
      sleep 2
      url="$(tunnel_url)"
      [ -n "$url" ] && break
    done
  fi

  cur="$(cat "$ORIGIN_FILE" 2>/dev/null || true)"

  if [ -z "$url" ]; then
    origin_state="tunnel-url-unavailable"
    note="tunnel is not announcing a URL yet"
  elif [ "$url" != "$cur" ]; then
    # (c) the tunnel URL changed, so the Worker's BACKEND_ORIGIN_URL is stale.
    url_changed="yes"
    origin_state="stale"
    if deploy_allowed; then
      load_credentials
      # deploy-live.sh reads the origin OUT of this file, so the file has to be
      # written before the deploy. That ordering hides a failure: if the deploy
      # then fails, the file already holds the NEW url, so the next cycle reads
      # "match" and never retries - a silent outage with a file that looks
      # correct. (The earlier comment here claimed the opposite.) So keep the
      # previous value and put it back on failure, which leaves the discrepancy
      # visible until a deploy genuinely succeeds.
      prev="$cur"
      if printf '%s\n' "$url" > "$ORIGIN_FILE.tmp" && mv "$ORIGIN_FILE.tmp" "$ORIGIN_FILE" \
         && run_deploy "tunnel-url-changed"; then
        action="deployed(origin-changed)"
      else
        if [ -n "$prev" ]; then
          printf '%s\n' "$prev" > "$ORIGIN_FILE.tmp" && mv "$ORIGIN_FILE.tmp" "$ORIGIN_FILE"
        else
          rm -f "$ORIGIN_FILE"
        fi
        origin_state="stale-deploy-failed"
        action="deploy-failed(origin-changed)"
      fi
    else
      action="deploy-deferred(rate-limit ${next_deploy_gap}s)"
    fi
  else
    origin_state="match"
  fi

  # (d) the independent live check — always runs, whatever happened above.
  last_health="$(live_health)"
  if [ "$last_health" = "ok" ]; then
    unhealthy_streak=0
  else
    unhealthy_streak=$((unhealthy_streak + 1))
    # Two strikes AND the tunnel URL already matching .origin-url means the
    # tunnel is fine while the Worker is stale — the one case a redeploy fixes.
    if [ "$unhealthy_streak" -ge 2 ] && [ -n "$url" ] && [ "$url" = "$cur" ]; then
      if deploy_allowed; then
        load_credentials
        if run_deploy "live-unhealthy-worker-stale"; then
          action="deployed(live-stale)"
        else
          action="deploy-failed(live-stale)"
        fi
        last_health="$(live_health_settled)"
        [ "$last_health" = "ok" ] && unhealthy_streak=0
      elif ! backend_local_ok; then
        # The backend itself is down: a Worker redeploy cannot fix that, so do
        # not queue one. Say so loudly instead.
        note="backend $BACKEND_CONTAINER is not answering on $BACKEND_ORIGIN; a Worker redeploy cannot fix that"
      elif [ $(( $(now_epoch) - last_tunnel_action )) -ge "$TUNNEL_RESTART_MIN_GAP" ]; then
        # Backend answers locally but the public tunnel path is dead: recycle it.
        if recycle_tunnel; then
          tunnel_action="tunnel-recycled(unreachable-through-tunnel)"
        else
          tunnel_action="tunnel-recycle-failed"
        fi
      else
        action="deploy-deferred(rate-limit ${next_deploy_gap}s)"
      fi
    fi
  fi

  backend_local_ok && backend_state="ok" || backend_state="down"

  # Carry the deploy outcome detail (e.g. "the deploy script's own verification
  # was flaky but the service is healthy") into the one line for this cycle.
  [ -n "$deploy_note" ] && note="${note:+$note; }$deploy_note"

  # A cycle can legitimately do two things at once (recreate the tunnel AND
  # repoint the Worker at the new hostname), so report both rather than letting
  # the later one hide the earlier.
  local all_actions="$action"
  if [ -n "$tunnel_action" ]; then
    [ "$action" = "none" ] && all_actions="$tunnel_action" || all_actions="$tunnel_action+$action"
  fi

  log_line "action=$all_actions url=${url:-none} url_changed=$url_changed origin_file=$origin_state live=$last_health unhealthy_streak=$unhealthy_streak backend_local=$backend_state next_deploy_in=${next_deploy_gap}s${note:+ note=\"$note\"}"
}

# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------
if [ "$MODE" = "once" ]; then
  run_cycle
  [ "$last_health" = "ok" ] && exit 0 || exit 1
fi

log_line "action=started mode=loop interval=${INTERVAL}s public=$PUBLIC_URL tunnel_container=$TUNNEL_CONTAINER root=$ROOT"
while true; do
  run_cycle
  sleep "$INTERVAL"
done
