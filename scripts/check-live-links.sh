#!/usr/bin/env bash
# Check the live landing page for dead links and stale content.
#
#   bash scripts/check-live-links.sh [base-url]
#
# Why this exists: the landing page once linked a PRIVATE GitHub repository, so
# the "source" link returned 404 for every visitor, and it labelled the minified
# buyer bundle "buyer CLI source". The same dead-repo defect had already been
# fixed in the registry listing and was missed here - a hardcoded external URL
# drifts out of date silently and no unit test sees it.
#
# Exits non-zero if any link on the page does not resolve.
set -uo pipefail

BASE="${1:-https://agent-evidence-api.taher-h-alhaddad.workers.dev}"
FAILED=0

html="$(curl -s -m 25 -H 'accept: text/html' "$BASE/" 2>/dev/null)" || {
  echo "  ✖ landing page unreachable at $BASE/"
  exit 1
}

if [ -z "$html" ]; then
  echo "  ✖ landing page returned an empty body"
  exit 1
fi

count=0
while read -r href; do
  [ -z "$href" ] && continue
  case "$href" in
    /*) full="${BASE}${href}" ;;
    http*) full="$href" ;;
    *) continue ;;
  esac
  code="$(curl -s -m 25 -o /dev/null -w '%{http_code}' -L "$full" 2>/dev/null)"
  count=$((count + 1))
  if [ "$code" = "200" ]; then
    printf '  ✓ %s  %s\n' "$code" "$href"
  else
    printf '  ✖ %s  %s\n' "$code" "$href"
    FAILED=1
  fi
done < <(printf '%s' "$html" | grep -oE 'href="[^"]*"' | sed 's/href="//;s/"$//' | sort -u)

# The page must not advertise a label that contradicts what the link serves.
if printf '%s' "$html" | grep -q 'buyer CLI source'; then
  echo "  ✖ the page still calls the minified bundle \"source\""
  FAILED=1
fi

printf '\n  checked %s link(s)\n' "$count"
if [ "$FAILED" -ne 0 ]; then
  echo "  ✖ dead or mislabelled links on the landing page"
  exit 1
fi
echo "  ✓ all landing-page links resolve"
