#!/usr/bin/env bash
# Post-push deploy: uploads .env to SSM, pulls latest code on EC2, brings the
# stack up. Idempotent — safe to re-run after any code change that's been
# pushed to origin.
#
# Usage: bash scripts/deploy.sh
#
# Pre-conditions checked at the top: aws cli authed, instance is RUNNING,
# repo is reachable (public OR EC2 has a deploy token).
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

echo "▸ Uploading .env to SSM SecureString ($ENV_PARAM)..."
aws ssm put-parameter \
  --name "$ENV_PARAM" \
  --value "$(cat .env)" \
  --type SecureString \
  --overwrite \
  --region "$REGION" >/dev/null
echo "  uploaded ✓"

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
CMD_ID=$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --comment "claude-for-you deploy" \
  --region "$REGION" \
  --parameters 'commands=[
    "set -euo pipefail",
    "DEPLOY_KEY=$(aws ssm get-parameter --name /claude-for-you/github-deploy-key --with-decryption --region '"$REGION"' --query Parameter.Value --output text 2>/dev/null || echo PLACEHOLDER_RUN_PUT_PARAMETER)",
    "if [ \"$DEPLOY_KEY\" = \"PLACEHOLDER_RUN_PUT_PARAMETER\" ] || [ -z \"$DEPLOY_KEY\" ]; then echo \"[deploy] SSM /claude-for-you/github-deploy-key is empty/placeholder. Populate it before running deploy.sh.\" >&2; exit 1; fi",
    "install -d -m 700 -o ec2-user -g ec2-user /home/ec2-user/.ssh",
    "umask 077 && echo \"$DEPLOY_KEY\" > /home/ec2-user/.ssh/id_ed25519_claude_for_you",
    "chown ec2-user:ec2-user /home/ec2-user/.ssh/id_ed25519_claude_for_you && chmod 600 /home/ec2-user/.ssh/id_ed25519_claude_for_you",
    "{ echo \"Host github.com\"; echo \"  HostName github.com\"; echo \"  User git\"; echo \"  IdentityFile ~/.ssh/id_ed25519_claude_for_you\"; echo \"  IdentitiesOnly yes\"; } > /home/ec2-user/.ssh/config",
    "chown ec2-user:ec2-user /home/ec2-user/.ssh/config && chmod 600 /home/ec2-user/.ssh/config",
    "{ echo \"github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\"; echo \"github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=\"; echo \"github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=\"; } > /home/ec2-user/.ssh/known_hosts",
    "chown ec2-user:ec2-user /home/ec2-user/.ssh/known_hosts && chmod 644 /home/ec2-user/.ssh/known_hosts",
    "CLONE_URL=git@github.com:jaeyeonling/claude-for-you.git",
    "if [ ! -d /home/ec2-user/claude-for-you ]; then sudo -Hu ec2-user git clone \"$CLONE_URL\" /home/ec2-user/claude-for-you; fi",
    "cd /home/ec2-user/claude-for-you && sudo -Hu ec2-user git remote set-url origin \"$CLONE_URL\" && sudo -Hu ec2-user git fetch --depth=1 origin main && sudo -Hu ec2-user git reset --hard origin/main",
    "sudo /usr/local/bin/fetch-env.sh",
    "cd /home/ec2-user/claude-for-you && export CADDYFILE_SHA256=$(sha256sum Caddyfile | cut -d \" \" -f 1) && [ \"${#CADDYFILE_SHA256}\" -eq 64 ] && docker build -t claude-for-you:latest . && docker compose up -d"
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
