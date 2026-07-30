#!/usr/bin/env bash
#
# messages_log cold-storage archiver — host wrapper (issue #150).
#
# Runs ON THE EC2 HOST via cron. Moves request/response bodies older than
# MESSAGES_LOG_ARCHIVE_AFTER_DAYS out of Postgres and into S3, leaving each row
# as a queryable stub. See docs/operational-pitfalls.md section 22 for why this
# exists (a 20GB volume filled in ten weeks and took the admin UI down).
#
# Why a host wrapper instead of running the archiver inside the long-lived app
# container:
#
#   1. Credentials. aws_instance.app sets http_put_response_hop_limit = 1 for
#      SSRF hardening, so IMDS is NOT reachable from inside a container — the
#      host reaches it, containers do not (verified on the instance). The host
#      can therefore mint SHORT-LIVED role credentials and hand them to a
#      one-shot container, which means the write path needs no long-lived
#      secret anywhere on disk.
#   2. Isolation. Batches of multi-MB JSONB have no business sharing a heap with
#      in-flight SSE streams. A one-shot container gets its own memory budget
#      and dies when the job is done.
#
# Schedule (crontab -e as root, or /etc/cron.d):
#   17 4 * * * /home/ec2-user/claude-for-you/scripts/archive-messages-log.sh \
#       >> /var/log/cfy-archive.log 2>&1
#
# 04:17 rather than 04:00: nothing else competes for the DB at that hour, and an
# off-the-hour minute avoids piling onto every other cron on the box.
#
# Manual use:
#   scripts/archive-messages-log.sh --dry-run   # read + report, mutate nothing
#
# Env knobs (all optional; defaults live in src/usage/archive-cli.ts):
#   MESSAGES_LOG_ARCHIVE_AFTER_DAYS   days to keep bodies hot in PG (default 14)
#   MESSAGES_LOG_ARCHIVE_BATCH        rows per object            (default 200)
#   MESSAGES_LOG_ARCHIVE_MAX_BATCHES  batches per run            (default 50)
set -euo pipefail

REPO_DIR="${CFY_REPO_DIR:-/home/ec2-user/claude-for-you}"
REGION="${AWS_REGION:-ap-northeast-2}"

log() { echo "[cfy-archive $(date -u +%FT%TZ)] $*"; }

cd "$REPO_DIR" || { log "repo not found at $REPO_DIR"; exit 1; }
[ -f .env ] || { log ".env missing at $REPO_DIR — deploy.sh populates it from SSM"; exit 1; }

# ---- 1. bucket name ----
# Read from .env so the host and the container agree on one source of truth.
BUCKET="${MESSAGES_LOG_ARCHIVE_BUCKET:-$(grep -E '^MESSAGES_LOG_ARCHIVE_BUCKET=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"'')}"
if [ -z "$BUCKET" ]; then
  log "MESSAGES_LOG_ARCHIVE_BUCKET is not set in .env — nothing to archive to"
  log "  → terraform output messages_archive_bucket, then add it to .env and re-run deploy.sh"
  exit 1
fi

# ---- 2. temporary credentials from IMDS ----
# IMDSv2: PUT for a token, then GET with it. The token TTL is deliberately short
# — it only has to survive the two calls below.
TOKEN="$(curl -sS -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 60" --max-time 5)"
if [ -z "$TOKEN" ]; then
  log "IMDSv2 token request failed — is this running on the EC2 host (not inside a container)?"
  exit 1
fi

ROLE="$(curl -sS -H "X-aws-ec2-metadata-token: $TOKEN" \
  "http://169.254.169.254/latest/meta-data/iam/security-credentials/" --max-time 5)"
[ -n "$ROLE" ] || { log "no IAM role attached to this instance"; exit 1; }

CREDS="$(curl -sS -H "X-aws-ec2-metadata-token: $TOKEN" \
  "http://169.254.169.254/latest/meta-data/iam/security-credentials/${ROLE}" --max-time 5)"

# python3 over jq: python3 ships with AL2023, jq does not (and installing a
# dependency for three field reads on a box that already has python is silly).
read_cred() {
  printf '%s' "$CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('$1',''))"
}
AWS_ACCESS_KEY_ID="$(read_cred AccessKeyId)"
AWS_SECRET_ACCESS_KEY="$(read_cred SecretAccessKey)"
AWS_SESSION_TOKEN="$(read_cred Token)"

if [ -z "$AWS_ACCESS_KEY_ID" ] || [ -z "$AWS_SECRET_ACCESS_KEY" ] || [ -z "$AWS_SESSION_TOKEN" ]; then
  log "could not read temporary credentials from IMDS for role $ROLE"
  exit 1
fi
log "using temporary credentials for role $ROLE (bucket=$BUCKET)"

# ---- 3. run the archiver in a one-shot container ----
# `run --rm` and not `exec`: the serving container must not be the thing doing
# this work. Credentials are passed by NAME (-e VAR, no value) so they never
# appear in the process table or in this script's own trace output.
#
# --no-deps skips starting caddy; the archiver talks only to RDS and S3.
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
export AWS_REGION="$REGION"
export MESSAGES_LOG_ARCHIVE_BUCKET="$BUCKET"

docker compose run --rm --no-deps \
  -e AWS_ACCESS_KEY_ID \
  -e AWS_SECRET_ACCESS_KEY \
  -e AWS_SESSION_TOKEN \
  -e AWS_REGION \
  -e MESSAGES_LOG_ARCHIVE_BUCKET \
  -e MESSAGES_LOG_ARCHIVE_AFTER_DAYS \
  -e MESSAGES_LOG_ARCHIVE_BATCH \
  -e MESSAGES_LOG_ARCHIVE_MAX_BATCHES \
  app bun src/usage/archive-cli.ts "$@"

log "done"
