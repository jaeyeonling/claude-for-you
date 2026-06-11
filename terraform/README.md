# terraform/

AWS infrastructure for `claude-for-you`. Provisions an EC2 instance (Amazon Linux 2023), an RDS Postgres instance (t4g.micro), two encrypted SSM Parameter Store entries, an Elastic IP, and a narrowly scoped IAM role.

**No SSH.** Operator access goes through AWS Systems Manager Session Manager — port 22 is not opened on the security group at all.

## Prerequisites

- AWS CLI v2 (or v1 via `uv tool install awscli --python python3.13`)
- `aws configure` with credentials that can manage EC2, RDS, IAM, SSM, and (optionally) Route53. Running `scripts/deploy.sh` additionally requires `ssm:GetParameter` (with `--with-decryption`) on `/claude-for-you/github-deploy-key`, `ssm:PutParameter` on `/claude-for-you/env`, `kms:Decrypt` on the SSM service KMS key, and `ssm:SendCommand` + `ssm:GetCommandInvocation` + `ssm:DescribeInstanceInformation` on the target instance. The default AdministratorAccess profile covers all of these; least-privilege deployments need an explicit grant.
- `session-manager-plugin` (e.g., `brew install --cask session-manager-plugin`)
- Terraform ≥ 1.6
- GitHub CLI (`gh`, e.g., `brew install gh`) — needed for the deploy-key registration step; `scripts/deploy.sh` is SSH-only and requires the key to be populated even for public forks.

## What gets created

| Resource | Notes |
|---|---|
| `aws_instance.app` | t3.micro · AL2023 · gp3 root EBS encrypted · IMDSv2 required |
| `aws_eip.app` | Stable public IP (free while attached) |
| `aws_security_group.app` | 80/443 inbound only · all egress |
| `aws_db_instance.app` | Postgres 16 · t4g.micro · 20 GB gp3 · single-AZ · encrypted · 1-day backup |
| `aws_db_subnet_group.app` + `aws_security_group.db` | Postgres reachable only from the app SG |
| `random_password.db_master` | 32-char alphanumeric + `_-` (URL-safe) |
| `aws_iam_role.app` + `aws_iam_instance_profile.app` | EC2 → SSM + Parameter Store read |
| `aws_iam_role_policy_attachment.ssm_managed_core` | `AmazonSSMManagedInstanceCore` |
| `aws_iam_role_policy.env_param_read` | Read `/claude-for-you/env`, `/claude-for-you/database-url`, and `/claude-for-you/github-deploy-key` |
| `aws_ssm_parameter.env` | SecureString — operator-managed (`.env` contents) |
| `aws_ssm_parameter.database_url` | SecureString — terraform-owned (RDS connection string) |
| `aws_ssm_parameter.github_deploy_key` | SecureString — operator-managed (SSH private key for the GitHub repo deploy key) |
| `aws_route53_record.app` | Created only when `domain_zone_id` and `domain_name` are both set |
| `aws_sns_topic.alerts` | Fan-in for CloudWatch alarm notifications |
| `aws_sns_topic_subscription.email` | Created only when `alert_email` is set |
| `aws_cloudwatch_metric_alarm.network_in_drop` | OS-level liveness — fires on sustained NetworkIn drop OR metric publisher silence (#107 follow-up) |

## Variables (`variables.tf`)

| Variable | Default | Required | Description |
|---|---|---|---|
| `region` | `ap-northeast-2` | no | Any AWS region with a default VPC. |
| `name` | `claude-for-you` | no | Tag prefix for all resources. |
| `instance_type` | `t3.micro` | no | t3.micro fits trusted-few traffic. |
| `root_volume_size_gb` | `20` | no | The app keeps OAuth tokens and api-keys.json on the root volume. |
| `domain_zone_id` | `""` | no | Route53 zone ID. When set with `domain_name`, terraform manages the A record. |
| `domain_name` | `""` | no | FQDN such as `claude.example.com`. |
| `git_repo_url` | `""` | no | Public repo cloned by cloud-init on first boot. Empty = clone manually after SSM session. |
| `alert_email` | `""` | no | Subscriber for the CloudWatch alarm SNS topic. Empty = topic created without a subscriber. |

## Outputs (`outputs.tf`)

| Output | Use |
|---|---|
| `public_ip` | EIP — point an A record here when not using Route53. |
| `instance_id` | For `aws ssm start-session --target …`. |
| `ssm_session_command` | One-liner to open a shell on the instance. |
| `put_env_parameter_command` | One-liner to push the local `.env` into SSM SecureString. |
| `fetch_env_command` | Helper script the instance runs to materialize `.env` from SSM. |
| `dns_record` | The created FQDN (or a reminder to point DNS manually). |
| `sns_topic_arn` | SNS topic that receives CloudWatch alarm notifications. Wire extra subscribers here. |
| `alarm_name` | Name of the NetworkIn drop alarm — use with `aws cloudwatch describe-alarms`. |

## Apply

```bash
cd terraform/
cp terraform.tfvars.example terraform.tfvars  # most users can leave this empty

terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

RDS provisioning is the slow step (~5–7 minutes). EC2 + IAM finish in under 60 seconds.

## After apply

> **Private repo only**: complete the [Private-repo support](#private-repo-support-optional) section
> **before** invoking `scripts/deploy.sh`. `deploy.sh` exits early with
> `SSM /claude-for-you/github-deploy-key is empty/placeholder` if the key
> parameter still holds its placeholder value.

```bash
# 1. Upload your local .env to SSM SecureString
aws ssm put-parameter \
  --name /claude-for-you/env \
  --value "$(cat ../.env)" \
  --type SecureString --overwrite \
  --region ap-northeast-2

# 2. Open a session on the instance
aws ssm start-session --target $(terraform output -raw instance_id) --region ap-northeast-2

# Inside the session:
sudo /usr/local/bin/fetch-env.sh           # writes /home/ec2-user/claude-for-you/.env
cd /home/ec2-user/claude-for-you           # repo auto-cloned by cloud-init
# Build the image with plain `docker build` rather than `compose --build` —
# the Dockerfile's syntax=docker/dockerfile:1.7 directive needs buildx, and
# bundled compose builds enforce a stricter buildx version requirement.
sudo docker build -t claude-for-you:latest .
sudo docker compose up -d
```

## Alarms

The `aws_cloudwatch_metric_alarm.network_in_drop` alarm watches for the silent-hang signature from #107.

### How it fires

| Trigger | Mechanism |
|---|---|
| NetworkIn < 5 KB/min for 5 consecutive 1-min periods | `LessThanThreshold` + statistic `Sum` + period 60 s × eval 5 |
| Metric publisher (CWAgent / EC2 itself) goes silent | `TreatMissingData = breaching` |

#107's actual signature was NetworkIn 167 KB/min → 2.3 KB/min, sustained for over 20 minutes. The 5-minute, 5-of-5-datapoints evaluation window sits well inside that envelope. `ok_actions` is wired to the same SNS topic, so recovery is also notified.

### Confirm the subscription first — before any trigger test

Do this **before** running the reboot test below. If you skip it, AWS still publishes alarms to the topic but the email subscription stays in `PendingConfirmation`, AWS drops the delivery silently, and the reboot test below looks like it passes when nothing was actually received.

1. After `terraform apply`, AWS emails the address in `alert_email` with a confirmation link. Click it within 3 days.
2. Verify the subscription is no longer `PendingConfirmation`:

   ```bash
   aws sns list-subscriptions-by-topic \
     --topic-arn "$(terraform output -raw sns_topic_arn)" \
     --region ap-northeast-2 \
     --query 'Subscriptions[].SubscriptionArn' --output text
   # A subscription stuck on "PendingConfirmation" means the confirm
   # link wasn't clicked. The token expires after 3 days — re-run
   # `terraform apply` (or `aws sns subscribe`) to send a new one.
   ```

3. Common silent-failure traps:
   - `alert_email` left at the placeholder from `terraform.tfvars.example` (`*@*.example` is RFC 2606 — AWS will accept it and email a non-existent mailbox).
   - Confirmation email in spam.
   - Operator confirmed on one machine, terraform was re-applied from another that thinks the subscription is fresh.

### Trigger test (reboot simulation)

Only after the subscription is `Confirmed`. Confirm the alarm path end-to-end:

```bash
aws ec2 reboot-instances \
  --instance-ids $(terraform output -raw instance_id) \
  --region ap-northeast-2
# Wait ~5–7 minutes (Period 60 × 5 evaluations + SNS delivery latency).
# Email arrives on the ALARM transition, then again on OK once the
# instance is back and pushing traffic.
```

### Known false alarm: deploy cycles

`scripts/deploy.sh` can stop the instance for a few minutes. If a deploy lands during a quiet traffic window, NetworkIn falls below 5 KB/min for the full 5-minute window and the alarm fires even though nothing is wrong. Suppressing the alarm during deploys is a separate follow-up (below); we keep it un-suppressed for now because a real silent hang during quiet hours is exactly the scenario this alarm exists to catch.

### Out of scope (follow-up)

#111 listed three signals; this PR ships only NetworkIn drop. The other two are tracked as separate issues so each can be designed properly rather than bolted on:

- **SSM Agent ConnectionLost** — Lambda + `DescribeInstanceInformation` polling (AWS Cloud Operations Blog standard). Health Events do not catch instance-level agent disconnects.
- **External `/healthz`** — Route53 health check + cross-region SNS routing decision. Route53 health metrics publish only to `us-east-1`, and CloudWatch alarm actions must point at a same-region SNS topic.
- **Deploy-cycle NetworkIn alarm suppression** — `deploy.sh` should flip the alarm to `INSUFFICIENT_DATA` while a deploy is in flight.

### Private-repo support (optional) <a id="private-repo-support-optional"></a>

When the repo is private, register an SSH deploy key. The EC2 instance
fetches the private half from SSM at boot and at every deploy; the public
half lives on GitHub as a per-repo read-only deploy key.

The previous flow stored a GitHub PAT in SSM and embedded it directly into
the clone URL, which meant any git error printed the PAT to operator
scrollback via `StandardErrorContent`. SSH keys avoid that channel — the
key never appears in URLs, `git remote -v`, or git's stderr.

```bash
# 1. Generate an ED25519 key locally (no passphrase — the instance fetches
#    it programmatically).
ssh-keygen -t ed25519 -f claude-for-you-deploy -N ''

# 2. Store the PRIVATE half in SSM.
aws ssm put-parameter \
  --name /claude-for-you/github-deploy-key \
  --value "$(cat claude-for-you-deploy)" \
  --type SecureString --overwrite \
  --region ap-northeast-2

# 3. Register the PUBLIC half as a repo deploy key (read-only is enough).
gh repo deploy-key add claude-for-you-deploy.pub \
  --title "claude-for-you ec2 deploy" \
  --repo <owner>/<repo>

# 4. Shred the local copy of the private key — SSM is the source of truth now.
shred -u claude-for-you-deploy claude-for-you-deploy.pub
# macOS notes: GNU `shred` isn't bundled (install via `brew install coreutils`,
# then `gshred -u …`). Modern macOS (APFS) does not expose a working
# secure-erase tool — `rm -P` is silently ignored on APFS, `srm` was removed.
# `rm` is acceptable since SSM is the source of truth; just delete it
# (`rm claude-for-you-deploy claude-for-you-deploy.pub`) and do not back the
# files up unencrypted.
```

While the placeholder SSM value is intact, cloud-init falls back to
anonymous clone (only works for public repos), and `scripts/deploy.sh`
exits early with an explicit error.

`scripts/deploy.sh` and the cloud-init bootstrap both pin GitHub's published
host keys (ED25519 + ECDSA + RSA) into `~ec2-user/.ssh/known_hosts` — there
is no first-contact TOFU. If GitHub rotates a host key, update the entries
in `terraform/main.tf` and `scripts/deploy.sh` together.

## Destroy

```bash
terraform destroy
```

> **Lost when destroyed**: `usage_per_user` table (per-user daily counters), `tokens.json` and `api-keys.json` on the EBS volume.
> **Preserved**: the local `.env` (untouched), the local `terraform.tfvars` (untouched).
> **Recovery on next apply**: re-run `aws ssm put-parameter` after the new RDS endpoint is reflected in `aws_ssm_parameter.database_url`. The next `fetch-env.sh` writes the new connection string.

## State

`terraform.tfstate` contains `random_password.db_master.result` and the rendered DATABASE_URL in plaintext. It is gitignored. Back it up out-of-band; losing state means manually importing the AWS resources or destroying them via the console.

For team use, migrate to a remote backend (S3 + DynamoDB lock).
