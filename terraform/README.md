# terraform/

AWS infrastructure for `claude-for-you`. Provisions an EC2 instance (Amazon Linux 2023), an RDS Postgres instance (t4g.micro), two encrypted SSM Parameter Store entries, an Elastic IP, and a narrowly scoped IAM role.

**No SSH.** Operator access goes through AWS Systems Manager Session Manager — port 22 is not opened on the security group at all.

## Prerequisites

- AWS CLI v2 (or v1 via `uv tool install awscli --python python3.13`)
- `aws configure` with credentials that can manage EC2, RDS, IAM, SSM, and (optionally) Route53
- `session-manager-plugin` (e.g., `brew install --cask session-manager-plugin`)
- Terraform ≥ 1.6

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
| `aws_iam_role_policy.env_param_read` | Read just `/claude-for-you/env` and `/claude-for-you/database-url` |
| `aws_ssm_parameter.env` | SecureString — operator-managed (`.env` contents) |
| `aws_ssm_parameter.database_url` | SecureString — terraform-owned (RDS connection string) |
| `aws_route53_record.app` | Created only when `domain_zone_id` and `domain_name` are both set |

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

## Outputs (`outputs.tf`)

| Output | Use |
|---|---|
| `public_ip` | EIP — point an A record here when not using Route53. |
| `instance_id` | For `aws ssm start-session --target …`. |
| `ssm_session_command` | One-liner to open a shell on the instance. |
| `put_env_parameter_command` | One-liner to push the local `.env` into SSM SecureString. |
| `fetch_env_command` | Helper script the instance runs to materialize `.env` from SSM. |
| `dns_record` | The created FQDN (or a reminder to point DNS manually). |

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
sudo docker compose up -d --build
```

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
