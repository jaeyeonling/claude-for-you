#!/usr/bin/env bash
# Parse the Caddyfile with the *exact* environment docker compose hands the
# caddy service, once with TLS_IP unset and once set, and assert the shape.
#
# Why compose-rendered env and not hand-picked -e flags: #174 shipped a
# Caddyfile that parsed fine in hand-written tests but would not boot in prod,
# because compose always *defines* TLS_IP (as "") and Caddy's `{$VAR:default}`
# only falls back when the variable is unset. Only the real env catches that.
#
# Needs: docker (with compose v2), jq. Usage: scripts/check-caddyfile.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# docker-compose.yml marks DATABASE_URL required (`:?`); its value is
# irrelevant to Caddy, but `compose config` refuses to render without it.
export DATABASE_URL="${DATABASE_URL:-postgres://check-caddyfile.invalid/x}"

IMAGE="$(docker compose config --format json | jq -r '.services.caddy.image')"
TEST_IP="203.0.113.10" # TEST-NET-3, never routable

adapt() {
  local tls_ip="$1" args=()
  while IFS= read -r kv; do args+=(-e "$kv"); done < <(
    TLS_IP="$tls_ip" DOMAIN=":80" docker compose config --format json |
      jq -r '.services.caddy.environment | to_entries[] | "\(.key)=\(.value // "")"'
  )
  docker run --rm "${args[@]}" \
    -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" \
    -v "$PWD/caddy:/etc/caddy/caddy:ro" \
    "$IMAGE" caddy adapt --config /etc/caddy/Caddyfile 2>&1
}

json_of() { grep -E '^\{"(apps|logging)' | tail -1; }

fail() { echo "✗ $*" >&2; exit 1; }

echo "▸ TLS_IP unset (today's prod shape)"
off_out="$(adapt "")" || fail "Caddyfile does not parse with TLS_IP unset:"$'\n'"$off_out"
off="$(json_of <<<"$off_out")"
[ -n "$off" ] || fail "no adapted JSON (TLS_IP unset):"$'\n'"$off_out"
jq -e '.apps.tls == null' <<<"$off" >/dev/null || fail "TLS_IP unset must not configure any certificate"
jq -e '[.apps.http.servers[].listen[]] == [":80"]' <<<"$off" >/dev/null || fail "TLS_IP unset must listen on :80 only"
echo "  ✓ parses, :80 only, no certificates"

echo "▸ TLS_IP=$TEST_IP"
on_out="$(adapt "$TEST_IP")" || fail "Caddyfile does not parse with TLS_IP set:"$'\n'"$on_out"
on="$(json_of <<<"$on_out")"
[ -n "$on" ] || fail "no adapted JSON (TLS_IP set):"$'\n'"$on_out"
jq -e --arg ip "$TEST_IP" '.apps.tls.automation.policies[] | select(.subjects == [$ip]) | .issuers[0] | .module == "acme" and .profile == "shortlived"' <<<"$on" >/dev/null \
  || fail "IP site must use the ACME issuer with the shortlived profile"
jq -e --arg ip "$TEST_IP" '[.apps.http.servers[] | .tls_connection_policies[]? | .default_sni] | index($ip) != null' <<<"$on" >/dev/null \
  || fail "default_sni must be the IP (clients connecting by IP send no SNI)"
jq -e --arg ip "$TEST_IP" '[.apps.http.servers[] | select(.listen == [":80"]) | .routes[] | select(.match[0].host == [$ip]) | .handle[] | .. | objects | select(.abort == true)] | length == 1' <<<"$on" >/dev/null \
  || fail "plain HTTP to the IP must abort, not be served or redirected"
echo "  ✓ shortlived ACME cert for the IP, default_sni set, plain HTTP to the IP aborts"
