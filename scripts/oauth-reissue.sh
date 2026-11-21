#!/usr/bin/env bash
# Diagnose and replace the proxy's OAuth refresh token via SSM — no /admin,
# no redeploy. Procedure and background: docs/oauth-reissue-runbook.md.
#
#   bash scripts/oauth-reissue.sh diag   [instance-id]
#   CLAUDE_CONFIG_DIR=/tmp/cc-login claude auth login --claudeai   # dedicated account
#   bash scripts/oauth-reissue.sh inject [instance-id]
#
# instance-id defaults to `terraform output -raw instance_id`.
#
# What it protects against:
#   - Secret in SSM history: SSM keeps command parameters and output ~30 days.
#     The refresh token never goes in a command — it is relayed through a
#     temporary SecureString the instance reads itself, then deleted. `diag`
#     prints only error lines and expiresAt numbers, never token values.
#   - Wrong keychain item: with CLAUDE_CONFIG_DIR set, Claude Code stores
#     credentials as "Claude Code-credentials-<sha256(dir)[:8]>". Refuses to
#     read the item of ~/.claude or ~/.claude-work (live work sessions).
#   - selectInitial (src/auth/oauth.ts) keeping the dead env token: the
#     injected file carries a far-future expiresAt so it always wins at boot,
#     and an empty accessToken so the first request forces a refresh.
#
# Remote scripts avoid `case` on purpose: macOS bash 3.2 cannot parse
# `case … ;;` inside $(cat <<EOF …) and aborts mid-run.
set -euo pipefail

MODE="${1:?usage: oauth-reissue.sh diag|inject [instance-id]}"
REGION="${AWS_REGION:-ap-northeast-2}"
IID="${2:-$(cd "$(dirname "$0")/../terraform" && terraform output -raw instance_id)}"
TMP_PARAM=/claude-for-you/tmp-newrt
VOL=/var/lib/docker/volumes/claude-for-you_tokens/_data
APP_DIR=/home/ec2-user/claude-for-you
FAR_FUTURE=253402300799000

ssm_run() { # $1 = bash script; prints stdout, fails on remote failure
  local b64 cid status
  b64="$(printf '%s' "$1" | base64 | tr -d '\n')"
  cid="$(aws ssm send-command --region "$REGION" --instance-ids "$IID" \
    --document-name AWS-RunShellScript --comment "oauth-reissue $MODE" \
    --parameters "commands=[\"echo $b64 | base64 -d | bash\"]" \
    --query Command.CommandId --output text)"
  for _ in $(seq 1 90); do
    status="$(aws ssm get-command-invocation --region "$REGION" --command-id "$cid" --instance-id "$IID" --query Status --output text 2>/dev/null || true)"
    if [ "$status" = Success ] || [ "$status" = Failed ] || [ "$status" = TimedOut ] || [ "$status" = Cancelled ]; then break; fi
    sleep 2
  done
  aws ssm get-command-invocation --region "$REGION" --command-id "$cid" --instance-id "$IID" --query StandardOutputContent --output text
  if [ "$status" != Success ]; then
    aws ssm get-command-invocation --region "$REGION" --command-id "$cid" --instance-id "$IID" --query StandardErrorContent --output text >&2
    echo "✗ remote command $status" >&2
    return 1
  fi
}

diag() {
  echo "▸ OAuth state on $IID"
  ssm_run "$(cat <<EOF
cd $APP_DIR
if ! LOGS=\$(docker compose logs --since 24h app 2>&1); then echo "✗ docker compose logs failed — cannot judge" >&2; exit 1; fi
# Matches both "[oauth] ⚠️  refresh failed" (src/app.ts, incl. boot) and "oauth refresh failed".
FAILS=\$(printf '%s\n' "\$LOGS" | grep -i 'refresh failed' || true)
echo "refresh_failures_24h=\$(printf '%s' "\$FAILS" | grep -c . || true)"
printf '%s\n' "\$FAILS" | tail -2 | cut -c1-240
if [ -e $VOL/accounts.json ]; then echo "pool_mode=yes — app reads tokens-{name}.json, inject will refuse"; else echo "pool_mode=no"; fi
echo "tokens_json_expiresAt=\$(grep -o '"expiresAt":[0-9]*' $VOL/tokens.json | cut -d: -f2)"
echo "now_ms=\$(date +%s)000"
EOF
)"
  echo "  failures whose time is before the last restart are history, not a live outage."
}

inject() {
  local dir svc rt
  dir="${CLAUDE_CONFIG_DIR:-/tmp/cc-login}"
  dir="${dir%/}"
  if [ "$dir" = "$HOME/.claude" ] || [ "$dir" = "$HOME/.claude-work" ]; then
    echo "✗ $dir is a live work session — log in under an isolated CLAUDE_CONFIG_DIR" >&2; exit 1
  fi
  svc="Claude Code-credentials-$(printf '%s' "$dir" | shasum -a 256 | cut -c1-8)"

  security find-generic-password -s "$svc" >/dev/null 2>&1 || {
    echo "✗ no keychain item \"$svc\" — run: CLAUDE_CONFIG_DIR=$dir claude auth login --claudeai" >&2; exit 1; }
  rt="$(security find-generic-password -w -s "$svc" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["claudeAiOauth"]["refreshToken"])')"
  if [ "${rt#sk-ant-ort01-}" = "$rt" ]; then
    echo "✗ keychain item \"$svc\" has no sk-ant-ort01- refresh token — finish the browser login" >&2; exit 1
  fi
  echo "▸ refresh token ok (ort01, len=${#rt}) from \"$svc\""

  # Trap before the upload: an interrupt between put and trap would strand the RT.
  # Tolerates an absent parameter (upload never happened).
  trap 'aws ssm delete-parameter --name "$TMP_PARAM" --region "$REGION" >/dev/null 2>&1 && echo "▸ $TMP_PARAM deleted" || true' EXIT
  aws ssm put-parameter --name "$TMP_PARAM" --type SecureString --overwrite \
    --region "$REGION" --value "$rt" >/dev/null
  unset rt

  echo "▸ Writing tokens.json on $IID and restarting app"
  ssm_run "$(cat <<EOF
set -euo pipefail
# Pool mode (accounts.json present) loads tokens-{name}.json and ignores tokens.json —
# writing it would "succeed" while changing nothing.
if [ -e $VOL/accounts.json ]; then echo "POOL_MODE: $VOL/accounts.json exists — tokens.json is unused; update the member store instead" >&2; exit 1; fi
NEWRT=\$(aws ssm get-parameter --name $TMP_PARAM --with-decryption --region $REGION --query Parameter.Value --output text)
if [ "\${NEWRT#sk-ant-ort01-}" = "\$NEWRT" ]; then echo BAD_OR_MISSING_RT >&2; exit 1; fi
cp -p $VOL/tokens.json $VOL/tokens.json.bak-\$(date +%Y%m%d%H%M%S) 2>/dev/null || true
printf '{"accessToken":"","refreshToken":"%s","expiresAt":$FAR_FUTURE}' "\$NEWRT" > $VOL/tokens.json
chown 10001:10001 $VOL/tokens.json; chmod 600 $VOL/tokens.json
cd $APP_DIR && docker compose restart app
sleep 20
echo "expiresAt_now=\$(grep -o '"expiresAt":[0-9]*' $VOL/tokens.json | cut -d: -f2)"
EOF
)"
  cat <<EOF
  expiresAt_now = $FAR_FUTURE → no request has refreshed yet; send one and re-run diag.
  expiresAt_now = a real epoch (~now + 8h) → refresh succeeded, proxy recovered.
▸ After verifying, drop the local copy (pitfall #11, single holder):
  security delete-generic-password -s "$svc" >/dev/null && rm -rf "$dir"
EOF
}

case "$MODE" in
  diag) diag ;;
  inject) inject ;;
  *) echo "usage: oauth-reissue.sh diag|inject [instance-id]" >&2; exit 2 ;;
esac
