#!/usr/bin/env bash
# Detached supervisor: keep the service healthy without a session attached.
#
# Why not cron/systemd: both live outside the sandbox-writable area
# (/var/spool/cron, /etc/systemd/system), so this runs as a detached process
# instead. It survives the shell that started it and the DSH session, and dies
# only on reboot.
#
# For durability ACROSS REBOOTS, install either (requires a privileged write):
#   systemd:  /etc/systemd/system/aee-supervisor.service  -> ExecStart=this
#   cron:     */5 * * * * /root/dsh-workspace/agent-evidence-api/scripts/watchdog.sh
#
# Usage:  bash scripts/supervise.sh [interval-seconds]
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INTERVAL="${1:-300}"
LOG="$ROOT/data/watchdog.log"
PIDFILE="$ROOT/data/supervisor.pid"

mkdir -p "$ROOT/data"

# Refuse to start twice.
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "supervisor already running (pid $(cat "$PIDFILE"))"
  exit 0
fi

echo "starting supervisor: every ${INTERVAL}s, logging to $LOG"
setsid nohup bash -c '
  ROOT="'"$ROOT"'"; INTERVAL="'"$INTERVAL"'"; LOG="'"$LOG"'"
  while true; do
    bash "$ROOT/scripts/watchdog.sh" >> "$LOG" 2>&1 || true
    sleep "$INTERVAL"
  done
' >/dev/null 2>&1 &

echo $! > "$PIDFILE"
sleep 1
echo "supervisor pid: $(cat "$PIDFILE")"
