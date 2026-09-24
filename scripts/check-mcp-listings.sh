#!/usr/bin/env bash
# Where are our MCP servers listed, and what do the trust directories say?
#
#   bash scripts/check-mcp-listings.sh
#
# Companion to scripts/check-listings.sh, which covers the x402 catalogues. This
# one covers the *code-crawling* directories - the ones that discover an MCP from
# a public GitHub repo, an npm package, or a registry entry.
#
# Why it matters, concretely: M8ven added mcp-weather-server to its Trust Index on
# its own, by crawling the public repo, and emailed the publisher. The paid
# service was not in that index at all, because its repository is PRIVATE, and
# M8ven's checker only accepts a GitHub slug, an npm package name, or a registry
# listing. That asymmetry is the thing this script makes visible instead of
# discovering by accident.
#
# Exit code is the number of channels where a server we care about is missing or
# unscored.
set -uo pipefail

M8VEN_API="https://m8ven.ai/api/mcp/tool-check"
MCP_REGISTRY="https://registry.modelcontextprotocol.io/v0.1/servers"

PROBLEMS=0

note() { printf '  %-46s %s\n' "$1" "$2"; }

# --- M8ven: the trust index that emailed us ---------------------------------
# Public JSON-RPC over SSE, no auth. Returns trust_score, verdict and freshness.
m8ven_check() {
  local id="$1"
  curl -s -m 45 -X POST "$M8VEN_API" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"check_tool\",\"arguments\":{\"identifier\":\"$id\"}}}" 2>/dev/null \
  | sed -n 's/^data: //p' \
  | node -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      try{
        const r=JSON.parse(d).result;
        const t=(r.content&&r.content[0]&&r.content[0].text)||"";
        const j=JSON.parse(t);
        const score=j.trust_score===undefined?"-":j.trust_score;
        const verdict=j.verdict||j.verdict_label||"?";
        const fresh=j.freshness?`${j.freshness.tier||"?"}(${j.freshness.age_days}d)`:"-";
        process.stdout.write(`score=${score} verdict=${verdict} freshness=${fresh}`);
      }catch(e){ process.stdout.write("unreadable"); }
    });'
}

echo "=== M8ven Trust Index ==="
for id in "Thx93/mcp-weather-server" "Thx93/agent-evidence-api"; do
  out="$(m8ven_check "$id")"
  note "$id" "$out"
  case "$out" in
    *"score=-"*|*unreadable*|*pending*|*unknown*) PROBLEMS=$((PROBLEMS + 1)) ;;
  esac
done
echo "  submit (free, no signup): POST https://m8ven.ai/api/mcp/submit"
echo "    {\"identifier\":\"github.com/owner/repo\",\"source\":\"m8ven_submission\"}"
echo "    source must be one of: m8ven_submission, smithery, official, mcp_so, pulsemcp, npm"

# --- Official MCP Registry ---------------------------------------------------
echo
echo "=== Official MCP Registry ==="
reg="$(curl -s -m 40 "$MCP_REGISTRY?limit=100&search=Thx93" 2>/dev/null \
  | node -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      try{
        const a=(JSON.parse(d).servers||[]).map(s=>s.server&&s.server.name).filter(Boolean);
        process.stdout.write(a.length?[...new Set(a)].join(","):"none");
      }catch(e){process.stdout.write("unreadable");}
    });')"
note "io.github.Thx93/*" "$reg"
case "$reg" in none|unreadable) PROBLEMS=$((PROBLEMS + 1)) ;; esac
# The weather server's server.json claims io.github.Thx93/weather; if that name is
# absent here, its registry entry was written but never published.
case "$reg" in *"/weather"*) note "  weather entry published" "yes" ;;
                *) note "  weather entry published" "NO - server.json exists but is not in the registry" ;;
esac

# --- Code-crawling directories ----------------------------------------------
echo
echo "=== MCP directories (crawled from the public repo) ==="
# These are recorded, not scored. glama, PulseMCP and mcp.so all render client
# side, block plain curl, or key their pages by an internal id we do not know, so
# a status code here distinguishes nothing: 403 is a bot wall, 404 is a wrong URL
# scheme, 301 is a redirect. Concluding "not listed" from any of these is exactly
# the mistake this project has already made twice. Verify in a browser instead.
probe() {
  local label="$1" url="$2"
  local code
  code="$(curl -sL -m 25 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)"
  case "$code" in
    200) note "$label" "200 (page served - confirm content in a browser)" ;;
    403) note "$label" "403 (bot wall - UNVERIFIED, needs a browser)" ;;
    404) note "$label" "404 on the guessed URL (UNVERIFIED - scheme may differ)" ;;
    *)   note "$label" "$code (UNVERIFIED)" ;;
  esac
}
probe "glama.ai"   "https://glama.ai/mcp/servers?q=Thx93"
probe "pulsemcp"   "https://www.pulsemcp.com/servers?q=thx93"
probe "mcp.so"     "https://mcp.so/server/mcp-weather-server"
echo "  (none of the above is evidence of absence; use a real browser before concluding)"

echo
echo "=== npm (a package name is what M8ven and most directories accept) ==="
for p in "@thx93/mcp-weather-server" "@thx93/x402-evidence"; do
  code="$(curl -s -m 20 -o /dev/null -w '%{http_code}' "https://registry.npmjs.org/$(printf '%s' "$p" | sed 's|/|%2f|')" 2>/dev/null)"
  if [ "$code" = "200" ]; then note "$p" "published"; else note "$p" "NOT published ($code)"; PROBLEMS=$((PROBLEMS + 1)); fi
done

echo
if [ "$PROBLEMS" -eq 0 ]; then
  echo "  ✓ every channel carries what it should"
else
  echo "  ✖ $PROBLEMS channel(s) missing or unscored - see the lines above"
fi
exit "$PROBLEMS"
