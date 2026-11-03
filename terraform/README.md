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
| `aws_eip.app` | NAT Gateway's EIP = egress IP for upstream calls (`prevent_destroy`) |
| `aws_security_group.app` | 80/443 from the NLB SG only · all egress |
| `aws_subnet.private` + `aws_route_table.private` | App's private subnet (no public IP); default route via NAT |
| `aws_nat_gateway.egress` | Outbound for the private subnet · ≈ $43/mo + $0.059/GB |
| `aws_vpc_endpoint.s3` | Free S3 gateway endpoint (archive traffic skips the NAT) |
| `aws_lb.app` + `aws_eip.nlb` + `aws_security_group.nlb` | Public NLB, TCP 80/443 → Caddy; the only way in (`prevent_destroy` on the EIP) |
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
| `nlb_public_ip` | Client entry point (`https://<this>`) and the IP the certificate is for. Point an A record here when using a domain. |
| `egress_ip` | NAT EIP — source IP of upstream calls. Not reachable inbound. |
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

## NLB + IP certificate rollout

`nlb.tf` (#174) puts an NLB with its own static EIP in front of the instance and Caddy serves `https://<nlb_public_ip>` with a Let's Encrypt IP-address certificate — HTTPS without a domain. Step 1 runs it **alongside** the old `http://<public_ip>` path. Order matters:

1. **`terraform apply`** — creates the NLB, its EIP and SG; only adds tags elsewhere. Nothing changes for current clients.
2. **`terraform output -raw nlb_public_ip`** → add `TLS_IP=<that IP>` to your **local** `.env`. (`deploy.sh` uploads it to SSM; never edit `.env` on the instance — `fetch-env.sh` rebuilds it from SSM on every deploy.)
3. **`bash scripts/deploy.sh`** → recreates Caddy with the IP site. First issuance takes ~2–3 min (ACME fails until NLB targets are healthy, then Caddy retries).
4. **Confirm** `docker logs claude-for-you-caddy 2>&1 | grep 'certificate obtained'` on the instance, and the app log line `[tls] certificate watch armed`. Verify the cert from a network **without TLS interception** and **not from the instance itself** (intercepting proxy / NLB hairpin — `docs/operational-pitfalls.md` #25).
5. **`git push origin main:deploy`**.
6. **Move clients** to `ANTHROPIC_BASE_URL=https://<nlb_public_ip>`. Watch Caddy logs for requests still arriving on the old IP before step 7.
7. *(#174 step 3 / #178)* drop `0.0.0.0/0` ingress on the instance SG, move it to a private subnet behind NAT — next section.

Rollback after clients moved: only to a SHA that still contains `caddy/ip-tls/on.caddy`, or move clients back first.

## Private subnet cutover (#178)

`network.tf` moves the instance into a private subnet; its former EIP becomes the NAT Gateway's (same egress IP). Moving subnets **replaces the instance**, and the Docker volumes on its root disk go with it — so this is a migration, with ~10–15 minutes of downtime. Do it once clients are on `https://<nlb_public_ip>`. Cost: NAT ≈ $43/mo + $0.059/GB processed (S3 bypasses it via a free gateway endpoint).

Each step exists because skipping it breaks something. `OLD` = current instance id (`terraform output -raw instance_id`) before step 6; `NEW` = the same output after it.

**Before step 1 — run the cutover from a client that does not use this proxy.** If your own Claude Code has `ANTHROPIC_BASE_URL` pointed at this proxy, step 1 cuts off its API and the session dies with the service down (happened in the #178 cutover). Use a session with a direct API connection or do it by hand. Keep the machine awake and online for the whole run (macOS: prefix long commands with `caffeinate -i`): a network drop mid-cutover killed a script polling step 7 and stretched the outage by over an hour.

1. **Stop app + Caddy on OLD** — the OAuth refresh token rotates on use; a refresh after the backup leaves the new instance with a dead token (pitfall #11):
   `aws ssm send-command --instance-ids $OLD --document-name AWS-RunShellScript --parameters 'commands=["cd /home/ec2-user/claude-for-you && docker compose stop app caddy"]'`
2. **Back up the volumes off the box** — `bash scripts/volume-backup.sh $OLD <dir>` (end-to-end encrypted through SSM; refuses while the app runs). Do this *before* step 4: OLD's disk dies with OLD in step 6.
3. **Snapshot OLD's root volume** as a fallback and wait for `completed` (`aws ec2 wait snapshot-completed`). It holds every secret — delete it once the new instance has run cleanly for a few days.
4. **Free the EIP** so the NAT can take it (else terraform may create the NAT before destroying OLD → "already associated"):
   `aws ec2 disassociate-address --association-id "$(aws ec2 describe-addresses --filters Name=tag:Name,Values=claude-for-you-eip --query 'Addresses[0].AssociationId' --output text)"`
   OLD was launched with an auto-assigned public IP, so it gets a new one and stays reachable over SSM until step 6.
5. **Local `.env`: `DOMAIN=`** (empty). With the NLB in front, any `{$DOMAIN}` site on :80 would be a plaintext proxy for a spoofed Host header (asserted by `scripts/check-caddyfile.sh`).
6. **Network first, then the instance** — so a NAT failure doesn't leave you with OLD already destroyed:
   `terraform apply -target=aws_route_table_association.private -target=aws_nat_gateway.egress -target=aws_vpc_endpoint.s3`, then `terraform apply`.
   Prefer `terraform plan -out=<file>` → review → `terraform apply <file>` for each: only the reviewed changes are applied, and `terraform apply <file>` doesn't prompt (a plain `terraform apply` in a non-interactive shell exits at the `yes` prompt with nothing applied). The plan file can hold sensitive values; delete it after applying.
7. **Wait for NEW** (`terraform output -raw instance_id`): `aws ssm describe-instance-information` shows `Online`, and `test -f /var/log/user-data-done` via send-command succeeds (Docker installed through the NAT; ~3–5 min).
   **Not done after ~10 min → it failed; waiting longer won't help.** user_data runs under `set -e` and stops at the first error. To recover:
   1. Open a shell: `aws ssm start-session --target $NEW`, then `sudo -i`.
   2. Find the failing line: `cloud-init status --long` and `tail -40 /var/log/cloud-init-output.log` (the error names `part-001: line N`).
   3. Rule out egress first: `curl -fsS https://checkip.amazonaws.com` must print `terraform output -raw egress_ip`. If it doesn't, fix the NAT route; the script is fine.
   4. The rendered script is on the box at `/var/lib/cloud/instance/scripts/part-001`. Copy it from line N to the end: `sed -n 'N,$p' /var/lib/cloud/instance/scripts/part-001 > /root/resume.sh`. Fix the failing line in `/root/resume.sh`, prepend `#!/bin/bash`, `set -e` and any variables it uses from earlier lines (e.g. `ARCH=$(uname -m)`), then `bash /root/resume.sh`. The script ends by writing `/var/log/user-data-done`.
   5. Fix the same line in `terraform/main.tf`, run `bash scripts/check-user-data.sh` (terraform + jq, no AWS credentials needed), and open a PR. `ignore_changes = [user_data]` means this won't touch the running instance; it fixes the next one.

   (#180: a broken buildx line aborted every fresh boot; `scripts/check-user-data.sh` now catches that class of bug in CI.)
8. **Restore** — `bash scripts/volume-restore.sh $NEW <dir>/volumes.tgz` (Compose-labelled volumes, original owners/modes — the app's uid 10001 must own `tokens` to rewrite them).
9. **`bash scripts/deploy.sh`** (only the NLB path exists now). Verify from a network without TLS interception: `https://<nlb_public_ip>/healthz`; in-container `[tls]` check (pitfall #25); egress IP from inside the container equals `terraform output egress_ip`; `aws ec2 describe-instances` shows no public IP.
10. **`git push origin main:deploy`**, then delete `<dir>/volumes.tgz`.

Expect one `network-in-drop` alarm email during the gap (the alarm treats missing data as breaching).

Rollback: before step 6 — re-associate the EIP (`aws ec2 associate-address --allocation-id "$(aws ec2 describe-addresses --filters Name=tag:Name,Values=claude-for-you-eip --query 'Addresses[0].AllocationId' --output text)" --instance-id $OLD`) and `docker compose start app caddy` on OLD. After step 6 OLD is gone: roll forward with the step-2 archive (or the step-3 snapshot). **Never `terraform apply` from a pre-#178 SHA** — it would pull the instance back to a public subnet and fight the NAT for the EIP.

## Alarms

Two alarms publish to the `${var.name}-alerts` SNS topic:

| Alarm | Watches for |
|---|---|
| `aws_cloudwatch_metric_alarm.network_in_drop` | the silent-hang signature from #107 |
| `aws_cloudwatch_metric_alarm.rds_free_storage` | RDS running out of disk before it becomes an outage (#22) |

> Alarm names must keep the `${var.name}-` prefix. The SNS topic policy only permits publishes from `alarm:${var.name}-*`, so a differently-named alarm fails silently — it transitions to ALARM and nothing is delivered.

### How it fires

| Trigger | Mechanism |
|---|---|
| NetworkIn < 5 KB/min for 5 consecutive 1-min periods | `LessThanThreshold` + statistic `Sum` + period 60 s × eval 5 |
| Metric publisher (CWAgent / EC2 itself) goes silent | `TreatMissingData = breaching` |
| RDS `FreeStorageSpace` < 15 % of `allocated_storage`, 2 × 5-min periods | `LessThanThreshold` + statistic `Minimum` |

### RDS free storage — why 15 %

Storage autoscaling (`max_allocated_storage`) triggers at roughly 10 % free, so this alarm deliberately fires *first*: autoscaling silently raises the monthly bill, and sustained growth is something the operator should decide about rather than discover on an invoice. The threshold is computed from `allocated_storage`, so it tracks resizes automatically.

The failure this exists to prevent is documented in `docs/operational-pitfalls.md` §22: on 2026-07-30 the volume filled completely, Postgres entered recovery mode, and the first signal was the admin dashboard returning `internal_error`. A full volume cannot be recovered by deleting rows — `DELETE` needs WAL write space — so the only exit is expansion. Hearing about it at 15 % is the difference between a `terraform apply` and an outage.

`treat_missing_data` is `missing` here, not `breaching` (as on the EC2 alarm): a silent RDS metric means the instance is stopped or mid-modification, which is not something a *storage* alarm should claim to have detected.

`#107`'s actual signature was NetworkIn 167 KB/min → 2.3 KB/min, sustained for over 20 minutes. The 5-minute, 5-of-5-datapoints evaluation window sits well inside that envelope. `ok_actions` is wired to the same SNS topic, so recovery is also notified.

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
   - `alert_email` left at the `terraform.tfvars.example` placeholder (`your-alerts-team@your-company.example` — the `.example` TLD is RFC 2606, so AWS will accept it and email a non-existent mailbox).
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

### Diagnostic publish (manual smoke test)

Pre-conditions before this is useful:
1. SNS subscription is `Confirmed` (see § Confirm the subscription first — a `PendingConfirmation` subscription drops AWS's delivery silently).
2. `alert_email` is non-empty in tfvars (otherwise the topic has no subscriber and publishing succeeds but nothing arrives).

If those hold, send a synthetic message to verify the SNS → email path without rebooting the instance:

```bash
# Replace ap-northeast-2 if your var.region is different.
aws sns publish \
  --topic-arn "$(terraform output -raw sns_topic_arn)" \
  --region ap-northeast-2 \
  --subject "smoke test" \
  --message "manual publish to verify subscription delivery"
```

AWS evaluates SNS topic policy and IAM identity policy as a union for same-account access, so your IAM identity needs `sns:Publish` permission on this topic ARN. If you get `AuthorizationError`:

- Attach `sns:Publish` on the topic ARN to your IAM role/user. Minimal statement:
  ```json
  {
    "Effect": "Allow",
    "Action": "sns:Publish",
    "Resource": "<sns_topic_arn from terraform output>"
  }
  ```
- Or temporarily switch to an admin role.

The CloudWatch alarm publish path is independent and uses the topic policy's CloudWatch service principal — alarms still publish even when your operator IAM cannot.

### Known false alarm: deploy cycles

`scripts/deploy.sh` can stop the instance for a few minutes. If a deploy lands during a quiet traffic window, NetworkIn falls below 5 KB/min for the full 5-minute window and the alarm fires even though nothing is wrong. Suppressing the alarm during deploys is a separate follow-up (below); we keep it un-suppressed for now because a real silent hang during quiet hours is exactly the scenario this alarm exists to catch.

### Out of scope (follow-up)

`#111` listed three signals; this PR ships only NetworkIn drop. The other two are tracked as separate issues so each can be designed properly rather than bolted on:

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
