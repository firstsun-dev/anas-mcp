#!/usr/bin/env bash
# Read-only post-deployment smoke checks for the production anas-mcp Worker.
#
# Sends only unauthenticated GET/POST requests and carries no credentials. It deliberately does NOT roll back:
# a previous Worker version may predate Cloudflare Access authentication, so an automatic revert could re-expose
# `/mcp` with a weaker gate. A failure therefore only fails the pipeline and asks for operator intervention.
#
# Env: BASE_URL (default https://mcp.firstsun.org), EXPECTED_ISSUER (required; the Access authorization server).
set -uo pipefail

BASE_URL="${BASE_URL:-https://mcp.firstsun.org}"
EXPECTED_ISSUER="${EXPECTED_ISSUER:?EXPECTED_ISSUER is required}"
ATTEMPTS="${SMOKE_ATTEMPTS:-6}"
DELAY="${SMOKE_DELAY_SECONDS:-5}"
failures=0

fail() { echo "::error::SMOKE FAIL: $1"; failures=$((failures + 1)); }
pass() { echo "ok: $1"; }

# fetch <outfile> <curl args...> -> echoes the HTTP status; retries to ride out edge propagation.
fetch() {
  local out="$1"; shift
  local code="000" i
  for ((i = 1; i <= ATTEMPTS; i++)); do
    code="$(curl -sS -m 20 -o "$out" -w '%{http_code}' "$@" 2>/dev/null || echo 000)"
    [[ "$code" != "000" && "$code" != 5?? ]] && break
    sleep "$DELAY"
  done
  echo "$code"
}

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# 1. /health
code="$(fetch "$tmp/health" "$BASE_URL/health")"
if [[ "$code" == "200" ]] && jq -e '.status == "ok" and .service == "anas-mcp"' "$tmp/health" >/dev/null 2>&1; then
  pass "/health returned 200 ok"
else fail "/health expected 200 {service:anas-mcp,status:ok}, got HTTP $code"; fi

# 2. Unauthenticated /mcp must be rejected and must not return an MCP result.
code="$(fetch "$tmp/mcp" -X POST "$BASE_URL/mcp" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
if [[ "$code" == "401" || "$code" == "403" ]] && ! grep -q '"tools"' "$tmp/mcp"; then
  pass "unauthenticated /mcp rejected with HTTP $code"
else fail "unauthenticated /mcp must be 401/403 without tools, got HTTP $code"; fi

# 3. OAuth Protected Resource Metadata (RFC 9728), served by Cloudflare Access.
code="$(fetch "$tmp/prm" "$BASE_URL/.well-known/cloudflare-access-protected-resource/mcp")"
if [[ "$code" == "200" ]] && jq -e --arg r "$BASE_URL/mcp" --arg i "$EXPECTED_ISSUER" \
  '.resource == $r and (.authorization_servers | index($i)) != null' "$tmp/prm" >/dev/null 2>&1; then
  pass "protected-resource metadata valid; authorization server is $EXPECTED_ISSUER"
else fail "protected-resource metadata invalid or authorization server != $EXPECTED_ISSUER (HTTP $code)"; fi

# 4. Authorization Server Metadata (RFC 8414) reachable and issuer matches the configured Access issuer.
code="$(fetch "$tmp/as" "$EXPECTED_ISSUER/.well-known/oauth-authorization-server")"
if [[ "$code" == "200" ]] && jq -e --arg i "$EXPECTED_ISSUER" \
  '.issuer == $i and (.authorization_endpoint | startswith($i)) and (.token_endpoint | startswith($i))' "$tmp/as" >/dev/null 2>&1; then
  pass "authorization-server metadata reachable; issuer matches"
else fail "authorization-server metadata unreachable or issuer mismatch (HTTP $code)"; fi

if ((failures > 0)); then
  echo "::error::$failures smoke check(s) failed. OPERATOR INTERVENTION REQUIRED. No automatic rollback was performed (a previous version may lack Cloudflare Access authentication); inspect the deployment and roll forward or roll back manually."
  exit 1
fi
echo "All smoke checks passed."
