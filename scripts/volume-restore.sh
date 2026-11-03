#!/usr/bin/env bash
# Push a volumes.tgz from scripts/volume-backup.sh onto a (new) instance via
# SSM, end-to-end encrypted, before the first `scripts/deploy.sh`.
#
#   bash scripts/volume-restore.sh <instance-id> <volumes.tgz>
#
# The instance generates a throwaway key pair and returns only its public
# cert; we encrypt to it, so SSM history (~30 days) holds a public cert and
# ciphertext, never the plaintext tokens. The private key is deleted on the
# instance as soon as the archive is unpacked.
#
# Volumes are created with Compose's labels so `docker compose up` adopts
# them instead of warning "already exists but was not created by Compose".
# Refuses to overwrite non-empty volumes. VOLUME_SUFFIX restores into
# side-by-side test volumes (e.g. VOLUME_SUFFIX=_restoretest) for a dry run.
set -euo pipefail

IID="${1:?usage: volume-restore.sh <instance-id> <volumes.tgz>}"
ARCHIVE="${2:?usage: volume-restore.sh <instance-id> <volumes.tgz>}"
REGION="${AWS_REGION:-ap-northeast-2}"
SUFFIX="${VOLUME_SUFFIX:-}"
PROJECT="claude-for-you"
VOLUMES="tokens caddy_data"
umask 077
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK:?}"' EXIT
[ -f "$ARCHIVE" ] || { echo "✗ no archive at $ARCHIVE" >&2; exit 1; }

ssm_run() { # $1 = bash script; prints stdout, fails on remote failure
  local b64 cid status
  b64="$(printf '%s' "$1" | base64 | tr -d '\n')"
  cid="$(aws ssm send-command --region "$REGION" --instance-ids "$IID" \
    --document-name AWS-RunShellScript --comment "volume-restore" \
    --parameters "commands=[\"echo $b64 | base64 -d | bash\"]" \
    --query Command.CommandId --output text)"
  for _ in $(seq 1 60); do
    status="$(aws ssm get-command-invocation --region "$REGION" --command-id "$cid" --instance-id "$IID" --query Status --output text 2>/dev/null || true)"
    case "$status" in Success|Failed|TimedOut|Cancelled) break ;; esac
    sleep 2
  done
  if [ "$status" != Success ]; then
    aws ssm get-command-invocation --region "$REGION" --command-id "$cid" --instance-id "$IID" --query StandardErrorContent --output text >&2
    echo "✗ remote command $status" >&2
    return 1
  fi
  aws ssm get-command-invocation --region "$REGION" --command-id "$cid" --instance-id "$IID" --query StandardOutputContent --output text
}

echo "▸ Instance-side throwaway key"
CERT_B64="$(ssm_run '
set -euo pipefail
umask 077; install -d -m 700 /root/cfy-restore
openssl req -x509 -newkey rsa:3072 -nodes -days 1 -subj "/CN=cfy-volume-restore" \
  -keyout /root/cfy-restore/key.pem -out /root/cfy-restore/cert.pem 2>/dev/null
base64 -w0 /root/cfy-restore/cert.pem')"
printf '%s' "$CERT_B64" | base64 -d >"$WORK/cert.pem"
openssl x509 -in "$WORK/cert.pem" -noout -subject | grep -q cfy-volume-restore || { echo "✗ bad cert from instance" >&2; exit 1; }

echo "▸ Encrypting $ARCHIVE to it ($(shasum -a 256 "$ARCHIVE" | cut -c1-12)…)"
openssl cms -encrypt -binary -aes256 -outform DER -in "$ARCHIVE" "$WORK/cert.pem" | base64 | tr -d '\n' >"$WORK/cipher.b64"
SHA="$(shasum -a 256 "$ARCHIVE" | cut -d' ' -f1)"

echo "▸ Unpacking on $IID"
ssm_run "$(cat <<EOF
set -euo pipefail
trap 'rm -rf /root/cfy-restore' EXIT
cd /root/cfy-restore
echo '$(cat "$WORK/cipher.b64")' | base64 -d > volumes.cms
openssl cms -decrypt -binary -inform DER -inkey key.pem -in volumes.cms -out volumes.tgz
echo "$SHA  volumes.tgz" | sha256sum -c --quiet
for v in $VOLUMES; do
  name="${PROJECT}_\${v}${SUFFIX}"
  if docker volume inspect "\$name" >/dev/null 2>&1; then
    [ -z "\$(ls -A /var/lib/docker/volumes/\$name/_data)" ] || { echo "\$name is not empty — refusing to overwrite" >&2; exit 1; }
  else
    docker volume create --label com.docker.compose.project=${PROJECT} --label com.docker.compose.volume=\$v "\$name" >/dev/null
  fi
  # --transform renames <project>_<vol>/ to the target volume dir while
  # keeping every owner/mode — including _data itself, which the app (uid
  # 10001) must own to rewrite tokens.json on refresh.
  tar xzf volumes.tgz --numeric-owner --same-permissions --same-owner \
    --transform "s|^${PROJECT}_\${v}/|\$name/|" \
    -C /var/lib/docker/volumes "${PROJECT}_\${v}/_data"
  stat -c "  \$name/_data owner %u mode %a" "/var/lib/docker/volumes/\$name/_data"
  echo "  \$name: \$(find /var/lib/docker/volumes/\$name/_data -type f | wc -l) files"
done
EOF
)"
echo "✓ restored (instance key and archive removed). Next: bash scripts/deploy.sh"
