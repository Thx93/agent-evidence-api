#!/usr/bin/env bash
# Deploy the public edge (Worker) pointed at the live origin.
#
# The origin URL is passed as a --var rather than committed, because a quick
# tunnel URL is ephemeral and would otherwise churn the git history. Everything
# else comes from apps/worker/wrangler.jsonc.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/apps/worker"

export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/root/dsh-workspace/.config}"
ORIGIN="$(cat "$ROOT/.origin-url")"
SECRET="$(cat "$ROOT/.prod-secret")"

echo "origin: $ORIGIN"
echo

echo "=== set the origin secret ==="
printf '%s' "$SECRET" | wrangler secret put BACKEND_AUTH_SECRET --env="" 2>&1 | tail -2

echo
echo "=== deploy (production / mainnet) ==="
wrangler deploy --env="" \
  --var "BACKEND_ORIGIN_URL:$ORIGIN" 2>&1 | tail -12
