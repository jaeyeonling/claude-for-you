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

echo "▸ Running remote setup (git pull, fetch-env, docker build + up)..."
# The remote script:
#   1. Resolves the git URL with PAT injection if /github-pat is populated
#      (private-repo support; falls back to anonymous for public repos).
#   2. Clones if missing, otherwise fetches + resets to origin/main.
#   3. Pulls SSM secrets into .env via fetch-env.sh.
#   4. Builds the docker image with plain `docker build` (NOT `compose --build`)
#      to sidestep buildx version requirements in compose v5.x bundles.
#   5. Starts the stack with `docker compose up -d`.
CMD_ID=$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --comment "claude-for-you deploy" \
  --region "$REGION" \
  --parameters 'commands=[
    "set -euo pipefail",
    "PAT=$(aws ssm get-parameter --name /claude-for-you/github-pat --with-decryption --region '"$REGION"' --query Parameter.Value --output text 2>/dev/null || echo PLACEHOLDER_RUN_PUT_PARAMETER)",
    "BASE_URL=https://github.com/jaeyeonling/claude-for-you.git",
    "if [ \"$PAT\" != \"PLACEHOLDER_RUN_PUT_PARAMETER\" ] && [ -n \"$PAT\" ]; then CLONE_URL=$(echo \"$BASE_URL\" | sed \"s#https://github.com/#https://oauth2:$PAT@github.com/#\"); else CLONE_URL=\"$BASE_URL\"; fi",
    "if [ ! -d /home/ec2-user/claude-for-you ]; then sudo -u ec2-user git clone \"$CLONE_URL\" /home/ec2-user/claude-for-you; fi",
    "cd /home/ec2-user/claude-for-you && sudo -u ec2-user git remote set-url origin \"$CLONE_URL\" && sudo -u ec2-user git fetch --depth=1 origin main && sudo -u ec2-user git reset --hard origin/main",
    "sudo /usr/local/bin/fetch-env.sh",
    "cd /home/ec2-user/claude-for-you && export CADDYFILE_SHA256=$(sha256sum Caddyfile | cut -d \" \" -f 1) && docker build -t claude-for-you:latest . && docker compose up -d"
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
