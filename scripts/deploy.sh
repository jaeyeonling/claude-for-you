#!/usr/bin/env bash
# Post-push deploy: uploads .env to SSM, pulls latest code on EC2, brings the
# stack up. Idempotent — safe to re-run after any code change that's been
# pushed to origin.
#
# Usage: bash scripts/deploy.sh
#
# Pre-conditions checked at the top: aws cli authed (with permission to
# read /claude-for-you/github-deploy-key and to send SSM Run commands —
# see terraform/README.md → Prerequisites), instance is RUNNING, and the
# SSH deploy key is populated in SSM.
#
# This script clones via git@github.com using the SSH deploy key from
# /claude-for-you/github-deploy-key — even for public repos. Operators
# of a public fork who don't want to register a deploy key should clone
# the code in an SSM session manually instead of running this script.
# Cloud-init still falls back to anonymous HTTPS for public repos at
# first boot; this redeploy path is intentionally SSH-only to avoid
# branching auth modes.
set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-2}"
ENV_PARAM="/claude-for-you/env"
PROJECT_DIR="/Users/jaeyeonling/workspace/github/jaeyeonling/claude-for-you"

cd "$PROJECT_DIR"

echo "▸ Looking up instance id from terraform state..."
INSTANCE_ID="$(cd terraform && terraform output -raw instance_id)"
echo "  instance_id=$INSTANCE_ID"

echo "▸ Confirming AWS credentials..."
aws sts get-caller-identity --region "$REGION" >/dev/null

echo "▸ Confirming instance is reachable via SSM..."
PING=$(aws ssm describe-instance-information \
  --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
  --region "$REGION" \
  --query 'InstanceInformationList[0].PingStatus' \
  --output text)
if [ "$PING" != "Online" ]; then
  echo "  ✗ instance ping status: $PING (expected: Online)"
  echo "  → wait for cloud-init to register the agent, then re-run."
  exit 1
fi
echo "  Online ✓"

# Issue #109: remote memory pre-flight gate.
#
# Post-mortem #107 traced the silent hang to a deploy/buildkit memory spike on
# t3.small. swap + the larger instance widened the safety margin, but a deploy
# launched when MemAvailable is already low can still re-enter the same
# threshold — the new headroom is finite, not unconditional. This gate aborts
# BEFORE the docker build kicks in if the instance is already memory-pressed.
#
# Why a ratio (MemAvailable < MemTotal * 0.2) and not an absolute byte
# threshold: the instance type has changed once (t3.micro → t4g.medium via
# #107/#108) and may change again. An absolute "<400MB" gate would trip
# spuriously on small instances and miss real pressure on larger ones.
# Ratio scales with whatever terraform provisions.
#
# Why bash integer math instead of bc: bc isn't guaranteed on every operator
# workstation (alpine, minimal Docker dev images). /proc/meminfo values are
# already in integer kB, so `(MemAvailable * 100) / MemTotal` stays integer
# without precision loss.
#
# Why a separate SSM send-command instead of folding the check into the main
# remote script: the main script runs git fetch + docker build, which is
# already the expensive step we want to NOT enter when memory is low. The
# gate must precede it as its own SSM invocation. It also keeps the abort
# message visible on the operator's terminal — failures inside the main
# commands[] surface only via truncated StandardErrorContent (issue #71).
#
# Why AWS_MAX_ATTEMPTS=2 AWS_DEFAULT_CONNECT_TIMEOUT=5: issue #67 covers the
# wider gap (outer pre-flight has no AWS CLI timeout), but every NEW outer
# AWS CLI call this PR adds applies the recommendation locally so we don't
# stack new ~3min silent-blocking surface. The pre-existing calls above
# remain untouched and stay scoped to #67.
echo "▸ Checking remote memory pressure on $INSTANCE_ID..."
MEM_CMD_ID=$(AWS_MAX_ATTEMPTS=2 AWS_DEFAULT_CONNECT_TIMEOUT=5 aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --comment "claude-for-you mem preflight" \
  --region "$REGION" \
  --parameters 'commands=["cat /proc/meminfo"]' \
  --query 'Command.CommandId' \
  --output text)

# Poll up to ~30s — `cat /proc/meminfo` is a microsecond op on the box;
# any latency here is SSM agent round-trip, not workload.
MEM_STATUS="Pending"
MEM_OUTPUT=""
for _ in $(seq 1 15); do
  MEM_STATUS=$(AWS_MAX_ATTEMPTS=2 AWS_DEFAULT_CONNECT_TIMEOUT=5 aws ssm get-command-invocation \
    --command-id "$MEM_CMD_ID" \
    --instance-id "$INSTANCE_ID" \
    --region "$REGION" \
    --query 'Status' \
    --output text 2>/dev/null || echo "Pending")
  case "$MEM_STATUS" in
    Success)
      MEM_OUTPUT=$(AWS_MAX_ATTEMPTS=2 AWS_DEFAULT_CONNECT_TIMEOUT=5 aws ssm get-command-invocation \
        --command-id "$MEM_CMD_ID" \
        --instance-id "$INSTANCE_ID" \
        --region "$REGION" \
        --query 'StandardOutputContent' \
        --output text)
      break
      ;;
    Failed|TimedOut|Cancelled)
      echo "  ✗ memory pre-flight SSM status: $MEM_STATUS"
      echo "    → proceeding to deploy would be flying blind on memory headroom."
      echo "    → check the instance via: aws ssm start-session --target $INSTANCE_ID --region $REGION"
      exit 1
      ;;
    *)
      sleep 2
      ;;
  esac
done

if [ "$MEM_STATUS" != "Success" ]; then
  echo "  ✗ memory pre-flight did not complete within timeout (last status: $MEM_STATUS)"
  echo "    → SSM agent may be unresponsive; re-run after confirming the instance is healthy."
  exit 1
fi

# Parse /proc/meminfo. Fields are " kB"-suffixed; awk drops the suffix.
# Field 2 is the integer value in kB.
MEM_TOTAL_KB=$(echo "$MEM_OUTPUT" | awk '/^MemTotal:/ {print $2}')
MEM_AVAIL_KB=$(echo "$MEM_OUTPUT" | awk '/^MemAvailable:/ {print $2}')
SWAP_TOTAL_KB=$(echo "$MEM_OUTPUT" | awk '/^SwapTotal:/ {print $2}')
SWAP_FREE_KB=$(echo "$MEM_OUTPUT" | awk '/^SwapFree:/ {print $2}')

# Defensive: if /proc/meminfo missing expected fields, fail closed rather than
# silently skip the gate. A broken parse should not look like "all clear".
if [ -z "$MEM_TOTAL_KB" ] || [ -z "$MEM_AVAIL_KB" ] || [ "$MEM_TOTAL_KB" -le 0 ]; then
  echo "  ✗ could not parse MemTotal/MemAvailable from remote /proc/meminfo"
  echo "    raw output (first 10 lines):"
  echo "$MEM_OUTPUT" | head -10 | sed 's/^/      /'
  exit 1
fi

MEM_AVAIL_PCT=$(( (MEM_AVAIL_KB * 100) / MEM_TOTAL_KB ))
MEM_AVAIL_MB=$(( MEM_AVAIL_KB / 1024 ))
MEM_TOTAL_MB=$(( MEM_TOTAL_KB / 1024 ))

if [ "$MEM_AVAIL_PCT" -lt 20 ]; then
  echo "  ✗ MemAvailable too low: ${MEM_AVAIL_MB}MiB / ${MEM_TOTAL_MB}MiB (${MEM_AVAIL_PCT}%, threshold 20%)"
  echo "    → deploying now risks re-entering the #107 OOM/swap-thrash window."
  echo "    → investigate via: aws ssm start-session --target $INSTANCE_ID --region $REGION"
  echo "      and: free -m; ps aux --sort=-%mem | head -10"
  exit 1
fi
echo "  memory ✓ (MemAvailable ${MEM_AVAIL_MB}MiB / ${MEM_TOTAL_MB}MiB, ${MEM_AVAIL_PCT}%)"

# Swap is a warning, not a gate: a partly-consumed swap is normal under the
# t4g.medium + 2GiB swap config (#108), and aborting on it would block deploys
# that the memory check already cleared. Surface it so the operator can
# decide whether to investigate post-deploy.
if [ -n "$SWAP_TOTAL_KB" ] && [ "$SWAP_TOTAL_KB" -gt 0 ] && [ -n "$SWAP_FREE_KB" ]; then
  SWAP_FREE_PCT=$(( (SWAP_FREE_KB * 100) / SWAP_TOTAL_KB ))
  SWAP_FREE_MB=$(( SWAP_FREE_KB / 1024 ))
  SWAP_TOTAL_MB=$(( SWAP_TOTAL_KB / 1024 ))
  if [ "$SWAP_FREE_PCT" -lt 50 ]; then
    echo "  ⚠ SwapFree low: ${SWAP_FREE_MB}MiB / ${SWAP_TOTAL_MB}MiB (${SWAP_FREE_PCT}%, warn <50%)"
    echo "    → memory check passed but swap is heavily consumed; deploy proceeds, monitor post-roll."
  else
    echo "  swap ✓ (SwapFree ${SWAP_FREE_MB}MiB / ${SWAP_TOTAL_MB}MiB, ${SWAP_FREE_PCT}%)"
  fi
fi

echo "▸ Uploading .env to SSM SecureString ($ENV_PARAM)..."
aws ssm put-parameter \
  --name "$ENV_PARAM" \
  --value "$(cat .env)" \
  --type SecureString \
  --overwrite \
  --region "$REGION" >/dev/null
echo "  uploaded ✓"

# Outer pre-flight: detect the placeholder deploy-key BEFORE the SSM
# invocation. Without this, the same check inside commands[] fails the run
# from inside the remote shell, where the only signal back is the polling
# loop and the truncated StandardErrorContent. Catching it here gives the
# operator a remediation pointer immediately.
echo "▸ Verifying SSH deploy key in SSM..."
DEPLOY_KEY_VAL=$(aws ssm get-parameter \
  --name /claude-for-you/github-deploy-key \
  --with-decryption \
  --region "$REGION" \
  --query 'Parameter.Value' \
  --output text 2>/dev/null || echo "PLACEHOLDER_RUN_PUT_PARAMETER")
if [ "$DEPLOY_KEY_VAL" = "PLACEHOLDER_RUN_PUT_PARAMETER" ] || [ -z "$DEPLOY_KEY_VAL" ]; then
  echo "  ✗ SSM /claude-for-you/github-deploy-key is empty/placeholder."
  echo "    Register a deploy key first — see terraform/README.md → \"Private-repo support\":"
  echo "      ssh-keygen -t ed25519 -f claude-for-you-deploy -N ''"
  echo "      aws ssm put-parameter --name /claude-for-you/github-deploy-key \\"
  echo "        --value \"\$(cat claude-for-you-deploy)\" --type SecureString --overwrite --region $REGION"
  echo "      gh repo deploy-key add claude-for-you-deploy.pub --title 'claude-for-you ec2 deploy' --repo <owner>/<repo>"
  exit 1
fi
# Issue #68: `-z` only rejects an empty string; a whitespace-only value
# (a stray newline or a few spaces from the SSM console copy-paste) and
# a `.pub` file paste both slip through, get written verbatim to
# `~/.ssh/id_ed25519_claude_for_you`, and produce a downstream
# `error in libcrypto` from OpenSSH that doesn't name the SSM value as
# the cause. The PEM-header check catches both at pre-flight with a
# remediation pointer.
case "$DEPLOY_KEY_VAL" in
  "-----BEGIN OPENSSH PRIVATE KEY-----"*) : ;;
  *)
    echo "  ✗ SSM /claude-for-you/github-deploy-key does not start with '-----BEGIN OPENSSH PRIVATE KEY-----'."
    echo "    Common causes: whitespace-only value (stray newline from console paste), the .pub file"
    echo "    contents (starts with 'ssh-ed25519 ...'), or a non-OPENSSH key format. Re-upload the"
    echo "    ed25519 private key — see terraform/README.md → \"Private-repo support\" for the steps."
    exit 1
    ;;
esac
unset DEPLOY_KEY_VAL  # don't keep the private key in the parent shell environment any longer than needed
echo "  populated ✓"

echo "▸ Running remote setup (SSH key bootstrap, git pull, fetch-env, docker build + up)..."
# The remote script:
#   1. Bootstraps the SSH deploy key from SSM into ~ec2-user/.ssh/ with a
#      pinned ssh_config and explicit (non-TOFU) GitHub host keys. This is
#      idempotent — pre-existing files are overwritten each deploy, so a
#      rotated key takes effect immediately.
#   2. Clones via git@github.com if missing; otherwise re-points the remote
#      to the SSH URL (in case the instance still has an old HTTPS+PAT
#      remote from the previous deploy flow) and resets to origin/main.
#   3. Pulls SSM secrets into .env via fetch-env.sh.
#   4. Builds the docker image with plain `docker build` (NOT `compose --build`)
#      to sidestep buildx version requirements in compose v5.x bundles.
#   5. Starts the stack with `docker compose up -d`.
#
# Why SSH instead of HTTPS+PAT: the prior flow embedded the PAT in the
# clone URL, so any git failure surfaced the token in stderr →
# StandardErrorContent → operator scrollback. The SSH key never appears
# in URLs or git remote error output.
#
# Why `echo "$DEPLOY_KEY"` instead of `printf '%s\n' "$DEPLOY_KEY"`:
# the AWS CLI shorthand parser collapses `\\n` inside commands[] entries
# to a literal `n`, producing a key file whose final line ends with
# `KEY-----n` instead of `KEY-----\n`. OpenSSH then rejects the format
# with `error in libcrypto`, git fetch fails with `Permission denied
# (publickey)`, and (per issue #71) the rest of commands[] continues
# silently. `echo` writes the trailing newline natively. ED25519 PEM
# bodies don't contain `\` or leading `-` characters that would trip
# echo's quirks. (See issue #72 for the full diagnosis.)
#
# Why the inner case pattern is double-quoted as
# `\"-----BEGIN OPENSSH PRIVATE KEY-----\"*` rather than backslash-
# escaped (`-----BEGIN\\ OPENSSH\\ PRIVATE\\ KEY-----*`): the AWS CLI
# shorthand parser does NOT honor backslash-escaped spaces inside
# double-quoted shorthand values — it tokenizes at the raw spaces
# before the value is forwarded to SSM, so `aws ssm send-command`
# fails with "Unknown options: PRIVATE, KEY-----". The double-quote
# form uses the same `\"...\"` JSON-escape that line 124 (the
# placeholder check) has been using since PR #54. (See issue #78 for
# the post-merge regression that surfaced this.)
#
# Why inner SSM commands[] echo messages MUST NOT contain literal `'`
# characters: the entire `commands=[...]` payload below is wrapped in
# bash single quotes for the `--parameters` argument. A literal `'`
# anywhere inside terminates the outer single-quoted string, causing
# whatever follows (separated by spaces) to be split into separate
# bash arguments — AWS CLI then sees those fragments as unknown
# options instead of the intended payload. Reference the PEM header
# in messages with parentheses or no quotes, never with `'...'`. (See
# issue #80 for the regression where the inner message used `'-----
# BEGIN OPENSSH PRIVATE KEY-----'` and broke the entire payload.)
#
# Why the HEAD_LOCAL/HEAD_REMOTE gate after git reset: post-condition
# guard against issue #71 — if `git fetch` or `git reset` silently
# fails, HEAD won't advance to origin/main and the gate makes the SSM
# command exit non-zero instead of proceeding to docker build with the
# stale working tree.
#
# Why the SSM `commands[]` array entries can share shell state: AWS
# Systems Manager Agent (`aws:runShellScript`) joins the array with
# newlines into one temporary script file and executes it with a
# single shell invocation. Variables defined in one entry
# (`DEPLOY_KEY=$(aws ssm get-parameter …)`), shell options
# (`set -euo pipefail`), and cwd (`cd /home/ec2-user/claude-for-you`)
# persist to subsequent entries. This is the precondition the `#71 P1`
# git-chain split below relies on — `cd` on its own line is followed
# by `git remote set-url`/`fetch`/`reset` on the next lines, and
# `set -e` from the first entry terminates the whole script on the
# first non-zero exit. Evidence: pre-existing entries (`DEPLOY_KEY`
# defined on one line, consumed on the next) have been running in
# production since PR #54.
#
# Why unconditional `docker compose up -d --force-recreate --no-deps
# app` after `docker build` (issue #74): under the `:latest` tag,
# `docker compose up -d` compares the compose service reference, not
# the underlying image digest. A freshly built image with the same tag
# leaves `docker compose up -d` as a no-op and the old container keeps
# serving stale code. Issue #74 recommended a digest-compare branch
# (P3), but a deterministic-cache `docker build` from a previous SHA
# can produce a digest matching the currently running container during
# a roll-forward, leaving the operator with a stale container even
# though the rebuild succeeded. P1 (unconditional recreate) costs ~2-3s
# per deploy but covers all paths uniformly. `--no-deps` keeps Caddy
# out of the cascade — Caddy only needs recreation when its
# `caddyfile-hash` label changes, which the trailing `docker compose up
# -d` handles idempotently. The argument is the compose **service
# name** (`app` — `docker-compose.yml:2`), not the host container name
# (`claude-for-you`, which is `container_name` and the image tag); see
# issue #82. SSE stream drain during the recreate window is tracked as
# a separate follow-up.
CMD_ID=$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --comment "claude-for-you deploy" \
  --region "$REGION" \
  --parameters 'commands=[
    "set -euo pipefail",
    "DEPLOY_KEY=$(aws ssm get-parameter --name /claude-for-you/github-deploy-key --with-decryption --region '"$REGION"' --query Parameter.Value --output text 2>/dev/null || echo PLACEHOLDER_RUN_PUT_PARAMETER)",
    "if [ \"$DEPLOY_KEY\" = \"PLACEHOLDER_RUN_PUT_PARAMETER\" ] || [ -z \"$DEPLOY_KEY\" ]; then echo \"[deploy] SSM /claude-for-you/github-deploy-key is empty/placeholder. Populate it before running deploy.sh.\" >&2; exit 1; fi",
    "case \"$DEPLOY_KEY\" in \"-----BEGIN OPENSSH PRIVATE KEY-----\"*) :;; *) echo \"[deploy] SSM /claude-for-you/github-deploy-key does not start with the expected PEM header (-----BEGIN OPENSSH PRIVATE KEY-----). Whitespace-only value, public key, or wrong format. Re-upload the ed25519 private key.\" >&2; exit 1;; esac",
    "install -d -m 700 -o ec2-user -g ec2-user /home/ec2-user/.ssh",
    "(umask 077 && echo \"$DEPLOY_KEY\" > /home/ec2-user/.ssh/id_ed25519_claude_for_you)",
    "chown ec2-user:ec2-user /home/ec2-user/.ssh/id_ed25519_claude_for_you && chmod 600 /home/ec2-user/.ssh/id_ed25519_claude_for_you",
    "{ echo \"Host github.com\"; echo \"  HostName github.com\"; echo \"  User git\"; echo \"  IdentityFile ~/.ssh/id_ed25519_claude_for_you\"; echo \"  IdentitiesOnly yes\"; } > /home/ec2-user/.ssh/config",
    "chown ec2-user:ec2-user /home/ec2-user/.ssh/config && chmod 600 /home/ec2-user/.ssh/config",
    "{ echo \"github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\"; echo \"github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=\"; echo \"github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=\"; } > /home/ec2-user/.ssh/known_hosts",
    "chown ec2-user:ec2-user /home/ec2-user/.ssh/known_hosts && chmod 644 /home/ec2-user/.ssh/known_hosts",
    "CLONE_URL=git@github.com:jaeyeonling/claude-for-you.git",
    "if [ ! -d /home/ec2-user/claude-for-you ]; then sudo -Hu ec2-user git clone \"$CLONE_URL\" /home/ec2-user/claude-for-you; fi",
    "cd /home/ec2-user/claude-for-you",
    "sudo -Hu ec2-user git remote set-url origin \"$CLONE_URL\"",
    "sudo -Hu ec2-user git fetch --depth=1 origin main",
    "sudo -Hu ec2-user git reset --hard origin/main",
    "HEAD_LOCAL=$(sudo -Hu ec2-user git -C /home/ec2-user/claude-for-you rev-parse HEAD); HEAD_REMOTE=$(sudo -Hu ec2-user git -C /home/ec2-user/claude-for-you rev-parse origin/main); [ \"$HEAD_LOCAL\" = \"$HEAD_REMOTE\" ] || { echo \"[deploy] HEAD did not advance to origin/main ($HEAD_LOCAL != $HEAD_REMOTE) -- git fetch or reset silently failed. Aborting before docker build.\" >&2; exit 1; }",
    "sudo /usr/local/bin/fetch-env.sh",
    "cd /home/ec2-user/claude-for-you && export CADDYFILE_SHA256=$(sha256sum Caddyfile | cut -d \" \" -f 1) && [ \"${#CADDYFILE_SHA256}\" -eq 64 ] && docker build -t claude-for-you:latest . && docker compose up -d --force-recreate --no-deps app && docker compose up -d"
  ]' \
  --query 'Command.CommandId' \
  --output text)
echo "  command id: $CMD_ID — polling..."

# Poll until done (max ~5 minutes — docker build can be slow on t3.micro)
for _ in $(seq 1 30); do
  STATUS=$(aws ssm get-command-invocation \
    --command-id "$CMD_ID" \
    --instance-id "$INSTANCE_ID" \
    --region "$REGION" \
    --query 'Status' \
    --output text 2>/dev/null || echo "Pending")
  case "$STATUS" in
    Success)
      echo "  Success ✓"
      break
      ;;
    Failed|TimedOut|Cancelled)
      echo "  ✗ Status: $STATUS"
      aws ssm get-command-invocation \
        --command-id "$CMD_ID" \
        --instance-id "$INSTANCE_ID" \
        --region "$REGION" \
        --query 'StandardErrorContent' \
        --output text | head -40
      exit 1
      ;;
    *)
      echo "  status=$STATUS, sleep 10s..."
      sleep 10
      ;;
  esac
done

if [ "$STATUS" != "Success" ]; then
  echo "✗ Deploy did not finish within timeout. Last status: $STATUS"
  exit 1
fi

PUBLIC_IP="$(cd terraform && terraform output -raw public_ip)"
echo
echo "▸ Smoke test against $PUBLIC_IP..."
HEALTH=$(curl -s --max-time 10 "http://$PUBLIC_IP/healthz" || echo "FAIL")
if [ "$HEALTH" = '{"ok":true}' ]; then
  echo "  /healthz ✓ ($HEALTH)"
else
  echo "  /healthz response: $HEALTH"
  echo "  → containers may still be coming up. Check via:"
  echo "    aws ssm start-session --target $INSTANCE_ID --region $REGION"
fi

echo
echo "Done."
echo "Next steps for first deploy (one-time):"
echo "  1. SSM-session in: aws ssm start-session --target $INSTANCE_ID --region $REGION"
echo "  2. Visit http://$PUBLIC_IP/admin (basic auth: any API key)"
echo "  3. Paste a fresh refresh token in the OAuth section"
