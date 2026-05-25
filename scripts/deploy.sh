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

echo "▸ Running remote setup (git pull, fetch-env, docker compose up)..."
CMD_ID=$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --comment "claude-for-you deploy" \
  --region "$REGION" \
  --parameters 'commands=[
    "set -euo pipefail",
    "if [ ! -d /home/ec2-user/claude-for-you ]; then sudo -u ec2-user git clone https://github.com/jaeyeonling/claude-for-you.git /home/ec2-user/claude-for-you; fi",
    "cd /home/ec2-user/claude-for-you && sudo -u ec2-user git fetch --depth=1 origin main && sudo -u ec2-user git reset --hard origin/main",
    "sudo /usr/local/bin/fetch-env.sh",
    "cd /home/ec2-user/claude-for-you && docker compose up -d --build"
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
