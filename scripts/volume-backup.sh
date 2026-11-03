#!/usr/bin/env bash
# Pull the app's Docker volumes (tokens + Caddy data) off an instance via SSM,
# end-to-end encrypted, for an instance replacement (#178 cutover, AMI bumps).
#
#   bash scripts/volume-backup.sh <instance-id> [out-dir]
#
# What it protects against:
#   - SSM keeps command parameters and output for ~30 days. Plain base64 of
#     tokens.json would sit there. Instead we generate a throwaway key pair
#     *here*, send only the public cert, and the instance returns CMS
#     ciphertext. SSM history only ever sees a public cert and ciphertext.
#   - Refresh-token rotation (pitfall #11): refuses while the app container
#     is running — a token refreshed after the backup would be dead on the
#     new instance. Stop it first (`docker compose stop app caddy`).
#     ALLOW_RUNNING=1 skips that check — dry runs only, never for a cutover.
#
# Output: <out-dir>/volumes.tgz (mode 600). Holds OAuth tokens, API keys and
# the Let's Encrypt account/cert keys — delete it once restored.
set -euo pipefail

IID="${1:?usage: volume-backup.sh <instance-id> [out-dir]}"
OUT_DIR="${2:-$(mktemp -d)}"
REGION="${AWS_REGION:-ap-northeast-2}"
VOLUMES="claude-for-you_tokens claude-for-you_caddy_data"
umask 077
mkdir -p "$OUT_DIR"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK:?}"' EXIT

ssm_run() { # $1 = bash script; prints stdout, fails on remote failure
  local b64 cid status
  b64="$(printf '%s' "$1" | base64 | tr -d '\n')"
  cid="$(aws ssm send-command --region "$REGION" --instance-ids "$IID" \
    --document-name AWS-RunShellScript --comment "volume-backup" \
    --parameters "commands=[\"echo $b64 | base64 -d | bash\"]" \
    --query Command.CommandId --output text)"
  for _ in $(seq 1 60); do
    status="$(aws ssm get-command-invocation --region "$REGION" --command-id "$cid" --instance-id "$IID" --query Status --output text 2>/dev/null || true)"
    case "$status" in Success) break ;; Failed|TimedOut|Cancelled) break ;; esac
    sleep 2
  done
  if [ "$status" != Success ]; then
    aws ssm get-command-invocation --region "$REGION" --command-id "$cid" --instance-id "$IID" --query StandardErrorContent --output text >&2
    echo "✗ remote command $status" >&2
    return 1
  fi
  aws ssm get-command-invocation --region "$REGION" --command-id "$cid" --instance-id "$IID" --query StandardOutputContent --output text
}

echo "▸ Throwaway recipient key (stays on this machine)"
openssl req -x509 -newkey rsa:3072 -nodes -days 1 -subj "/CN=cfy-volume-backup" \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null
CERT_B64="$(base64 <"$WORK/cert.pem" | tr -d '\n')"

echo "▸ Encrypting volumes on $IID"
CIPHER_B64="$(ssm_run "$(cat <<EOF
set -euo pipefail
if [ "${ALLOW_RUNNING:-}" != 1 ] && docker ps --format '{{.Names}}' | grep -qx claude-for-you; then
  echo "app container is running — stop it first (docker compose stop app caddy): refresh-token rotation" >&2; exit 1
fi
for v in $VOLUMES; do docker volume inspect "\$v" >/dev/null; done
d=\$(mktemp -d); trap 'rm -rf "\$d"' EXIT
echo "$CERT_B64" | base64 -d > "\$d/cert.pem"
tar czf - --numeric-owner -C /var/lib/docker/volumes $(for v in $VOLUMES; do printf '%s/_data ' "$v"; done) \
  | openssl cms -encrypt -binary -aes256 -outform DER "\$d/cert.pem" | base64 -w0
EOF
)")" || exit 1
[ -n "$CIPHER_B64" ] || { echo "✗ empty ciphertext" >&2; exit 1; }

printf '%s' "$CIPHER_B64" | base64 -d >"$WORK/volumes.cms"
openssl cms -decrypt -binary -inform DER -inkey "$WORK/key.pem" -in "$WORK/volumes.cms" -out "$OUT_DIR/volumes.tgz"
chmod 600 "$OUT_DIR/volumes.tgz"

echo "▸ Contents"
tar tzvf "$OUT_DIR/volumes.tgz" | awk '{print "  " $1, $2, $NF}'
shasum -a 256 "$OUT_DIR/volumes.tgz" | sed 's/^/  sha256 /'
echo "✓ $OUT_DIR/volumes.tgz — secrets: delete after restore"
