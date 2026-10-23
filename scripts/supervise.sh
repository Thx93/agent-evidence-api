#!/usr/bin/env bash
# SUPERSEDED — use the watchdog container instead.
#
#   docker run -d --name aee-watchdog --restart unless-stopped --network host \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     -v "/root/Agents Projects:/root/Agents Projects" aee-watchdog:latest
#
# Why this file no longer supervises anything: it was the detached shell loop that
# was supposed to keep the origin reachable, and it is precisely the thing that
# failed. It ran as a session process, so it was killed along with the rest of the
# session while the Docker-managed backend stayed up - the outages of 2026-09-22
# (~2 days) and 2026-09->10-18 (~3 weeks) both happened with a healthy backend and
# a dead tunnel, and nothing was watching. Docker is what survives; a shell loop is
# not, however it is detached.
#
# It is also now actively unsafe to run: it called `watchdog.sh` with no arguments,
# and that script's default mode is an infinite loop. Starting this alongside the
# container would leave two independent watchdogs racing each other's `wrangler
# deploy`, which is worse than having none.
#
# Kept as a thin, safe entry point:
#   bash scripts/supervise.sh          # report status and run one health cycle
#   bash scripts/supervise.sh --help   # this text
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="${AEE_WATCHDOG_CONTAINER:-aee-watchdog}"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  sed -n '1,30p' "${BASH_SOURCE[0]}"
  exit 0
fi

echo "scripts/supervise.sh is superseded by the watchdog container." >&2

if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"; then
  echo "  ✓ container '$CONTAINER' is running and owns the health loop." >&2
elif docker inspect -f '{{.Id}}' "$CONTAINER" >/dev/null 2>&1; then
  echo "  ! container '$CONTAINER' exists but is NOT running:" >&2
  echo "      docker start $CONTAINER" >&2
else
  echo "  ! container '$CONTAINER' does not exist. Start it with:" >&2
  echo "      docker build -t aee-watchdog:latest docker/watchdog" >&2
  echo "      docker run -d --name $CONTAINER --restart unless-stopped --network host \\" >&2
  echo "        -v /var/run/docker.sock:/var/run/docker.sock \\" >&2
  echo "        -v "/root/Agents Projects:/root/Agents Projects" aee-watchdog:latest" >&2
fi

# A single cycle is always safe: it can only heal, never race a loop.
echo >&2
echo "running one health cycle (bash scripts/watchdog.sh --once):" >&2
exec bash "$ROOT/scripts/watchdog.sh" --once
