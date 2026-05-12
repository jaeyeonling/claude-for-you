#!/usr/bin/env bash
#
# Phase 25 — automated CC wire capture for snapshot drift tracking.
#
# Runs on the operator's local machine via cron. Steps:
#   1. cd to repo, git pull (latest snapshot for diff base)
#   2. start the proxy in CAPTURE_MODE on a free port
#   3. drive a small CC scenario set through it (HOME-isolated, API-key mode)
#   4. stop the proxy, synthesize new snapshot
#   5. if snapshot changed → leave the diff for operator review (no auto push)
#
# Why no auto-push: a corrupted snapshot would break service_tier across the
# whole subscription. We capture and surface drift; humans merge the PR.
#
# Schedule: weekly is enough. CC ships builds every ~1–2 weeks.
#   crontab -e
#   0 9 * * 1 /Users/you/path/to/claude-for-you/scripts/cron-capture.sh \
#       >> /tmp/cfy-capture.log 2>&1
#
# Required:
#   - bun + git in PATH
#   - claude CLI installed (CC OAuth credentials in Keychain are NOT used —
#     we run CC in HOME-isolated API-key mode pointing at the local proxy)
#   - .env at repo root with valid ANTHROPIC_OAUTH_* (operator's tokens)
#   - .env's API_KEYS contains at least one key we can use as $CAPTURE_API_KEY
#
# Env knobs (optional, set in shell or wrapper):
#   CFY_PORT          — port the throwaway capture proxy listens on (default 13456)
#   CAPTURE_API_KEY   — which key value to send (must be one in API_KEYS)
#                       defaults to the first key in .env API_KEYS
#   CFY_PR_BRANCH     — git branch to leave new snapshot on (default capture/YYYY-MM-DD)
#   CFY_AUTO_BRANCH   — if "true", create branch and commit. default false.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

LOG_PREFIX="[cfy-capture $(date -u +%FT%TZ)]"
log() { echo "$LOG_PREFIX $*"; }

# ---- 0. preflight ----
command -v bun >/dev/null || { log "bun not in PATH"; exit 1; }
command -v claude >/dev/null || { log "claude CLI not in PATH"; exit 1; }
command -v git >/dev/null || { log "git not in PATH"; exit 1; }
[ -f .env ] || { log ".env missing at $REPO_ROOT"; exit 1; }

PORT="${CFY_PORT:-13456}"

# Extract first API key from .env
CAPTURE_API_KEY="${CAPTURE_API_KEY:-}"
if [ -z "$CAPTURE_API_KEY" ]; then
  CAPTURE_API_KEY="$(grep -E '^API_KEYS=' .env | head -1 \
    | sed -E 's/^API_KEYS=//;s/^"//;s/"$//' \
    | awk -F, '{print $1}' | awk -F: '{print $2}')"
fi
[ -n "$CAPTURE_API_KEY" ] || { log "no API key found in .env API_KEYS"; exit 1; }

# ---- 1. git pull (capture diff against the latest committed snapshot) ----
log "git fetch + status"
git fetch origin --quiet || log "  fetch warned (offline?)"
if [ -n "$(git status --porcelain)" ]; then
  log "  workdir dirty — capture only, won't branch"
  AUTO_BRANCH=false
else
  AUTO_BRANCH="${CFY_AUTO_BRANCH:-false}"
fi

# ---- 2. start proxy in capture mode on an isolated port ----
log "starting capture proxy on :$PORT"
TMP_CAPTURE_DIR="$(mktemp -d -t cfy-captures-XXXX)"
ENV_OVERRIDE=(
  "PORT=$PORT"
  "HOST=127.0.0.1"
  "CAPTURE_MODE=true"
  "CAPTURE_DIR=$TMP_CAPTURE_DIR"
)

(
  for kv in "${ENV_OVERRIDE[@]}"; do export "$kv"; done
  bun run src/server.ts
) > /tmp/cfy-capture-proxy.log 2>&1 &
PROXY_PID=$!
trap 'kill $PROXY_PID 2>/dev/null; rm -rf "$TMP_CAPTURE_DIR" "$TMP_HOME"' EXIT

# wait for healthz
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    log "  proxy healthy (took ${i}s)"
    break
  fi
  sleep 1
done
curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null || { log "proxy never healthy"; exit 1; }

# ---- 3. drive CC scenarios through it ----
TMP_HOME="$(mktemp -d -t cfy-cc-home-XXXX)"
log "running CC scenarios (HOME=$TMP_HOME)"

CC_BASE="http://127.0.0.1:$PORT"
SCENARIOS=(
  "Reply ONE word: PING"
  "What is 2+2? Just the number."
  "Briefly explain TypeScript in one sentence."
  "Write a Python function fibonacci(n). No explanation."
  "List 3 popular HTTP methods."
)

for prompt in "${SCENARIOS[@]}"; do
  HOME="$TMP_HOME" \
  ANTHROPIC_BASE_URL="$CC_BASE" \
  ANTHROPIC_API_KEY="$CAPTURE_API_KEY" \
  claude --print --output-format text "$prompt" > /dev/null 2>&1 \
    && log "  ok: ${prompt:0:50}" \
    || log "  fail: ${prompt:0:50}"
done

# ---- 4. stop proxy, synthesize ----
log "stopping proxy"
kill $PROXY_PID 2>/dev/null || true
sleep 1

CAPTURED=$(find "$TMP_CAPTURE_DIR" -name '*.json' | wc -l | tr -d ' ')
log "captured $CAPTURED requests"
[ "$CAPTURED" -gt 0 ] || { log "no captures — aborting synthesize"; exit 1; }

# Stage the captures dir in the project so synthesize-snapshot finds them
mkdir -p captures
cp "$TMP_CAPTURE_DIR"/*.json captures/
log "synthesizing snapshot"
bun run synthesize-snapshot > /tmp/cfy-synth.log 2>&1
tail -20 /tmp/cfy-synth.log

# ---- 5. diff vs HEAD ----
log "diff vs committed snapshot:"
if git diff --quiet src/template/cc-snapshot.json; then
  log "  no changes — snapshot is up to date ✅"
  rm -rf captures
  exit 0
fi

log "  ⚠️  snapshot DIFFERS from HEAD — operator review needed"
git --no-pager diff --stat src/template/cc-snapshot.json

if [ "$AUTO_BRANCH" = "true" ]; then
  BRANCH="${CFY_PR_BRANCH:-capture/$(date -u +%Y-%m-%d)}"
  log "creating branch $BRANCH"
  git checkout -b "$BRANCH" || git checkout "$BRANCH"
  git add src/template/cc-snapshot.json
  git commit -m "chore(snapshot): refresh from cron-capture $(date -u +%F)" || true
  log "branch ready. Operator: review then \`git push origin $BRANCH\` and open PR"
else
  log "leaving diff in working tree (CFY_AUTO_BRANCH=true to branch automatically)"
  log "review: git diff src/template/cc-snapshot.json"
fi

rm -rf captures
log "done"
