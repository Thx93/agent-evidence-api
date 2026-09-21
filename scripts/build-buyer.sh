#!/usr/bin/env bash
# Regenerate the zero-install buyer CLI served at /buy.mjs.
#
# The published npm package (buyer/) installs its dependencies normally; this
# produces a single self-contained file so a buyer with no npm account can
# `curl` it and run it. Run this whenever buyer/cli.mjs changes.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/buyer"
npx --yes esbuild@0.28.1 cli.mjs \
  --bundle --platform=node --format=esm --target=node20 \
  --minify --legal-comments=none \
  --outfile=dist/x402-evidence.mjs
mkdir -p "$ROOT/apps/backend/public"
cp dist/x402-evidence.mjs "$ROOT/apps/backend/public/x402-evidence.mjs"
printf 'buyer CLI bundled: %s bytes\n' "$(wc -c < "$ROOT/apps/backend/public/x402-evidence.mjs")"
