# ---------- AMI ----------
# Latest Amazon Linux 2023 — gets Docker via dnf, ships SSM Agent pre-installed.
data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-x86_64"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# ---------- IAM (SSM Session Manager + SecureString parameter read) ----------
data "aws_caller_identity" "current" {}

locals {
  env_parameter_name      = "/${var.name}/env"
  database_parameter_name = "/${var.name}/database-url"
  pat_parameter_name      = "/${var.name}/github-pat"
  env_parameter_arn       = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${local.env_parameter_name}"
  database_parameter_arn  = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${local.database_parameter_name}"
  pat_parameter_arn       = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${local.pat_parameter_name}"
}

resource "aws_iam_role" "app" {
  name = "${var.name}-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

# Lets SSM Agent register the instance and serve Session Manager shell.
resource "aws_iam_role_policy_attachment" "ssm_managed_core" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Narrowly scoped: read just the .env SecureString parameter, decrypt only via SSM.
resource "aws_iam_role_policy" "env_param_read" {
  name = "${var.name}-env-param-read"
  role = aws_iam_role.app.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters",
        ]
        Resource = [
          local.env_parameter_arn,
          local.database_parameter_arn,
          local.pat_parameter_arn,
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = "*"
        Condition = {
          StringEquals = {
            "kms:ViaService" = "ssm.${var.region}.amazonaws.com"
          }
        }
      },
    ]
  })
}

resource "aws_iam_instance_profile" "app" {
  name = "${var.name}-profile"
  role = aws_iam_role.app.name
}

# ---------- Parameter Store: .env contents ----------
# Terraform creates the parameter shell. Real value is populated out-of-band:
#   aws ssm put-parameter --name /claude-for-you/env --value "$(cat .env)" \
#       --type SecureString --overwrite --region ap-northeast-2
# ignore_changes prevents terraform from clobbering the operator's secret on subsequent applies.
resource "aws_ssm_parameter" "env" {
  name        = local.env_parameter_name
  description = "claude-for-you .env contents. Populate with aws ssm put-parameter."
  type        = "SecureString"
  value       = "PLACEHOLDER_RUN_PUT_PARAMETER"

  lifecycle {
    ignore_changes = [value]
  }
}

# ---------- Parameter Store: GitHub PAT (private repo support) ----------
# Optional. Operator populates with:
#   aws ssm put-parameter --name /claude-for-you/github-pat \
#     --value "ghp_xxx" --type SecureString --overwrite --region <region>
# When unpopulated (placeholder value), cloud-init and deploy.sh fall back
# to anonymous git clone (works only if the repo is public).
resource "aws_ssm_parameter" "github_pat" {
  name        = local.pat_parameter_name
  description = "Optional GitHub PAT for private-repo git clone. Populate via aws ssm put-parameter."
  type        = "SecureString"
  value       = "PLACEHOLDER_RUN_PUT_PARAMETER"

  lifecycle {
    ignore_changes = [value]
  }
}

# ---------- RDS Postgres ----------
# Default VPC + its subnets — RDS subnet groups require ≥2 AZs.
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

resource "aws_db_subnet_group" "app" {
  name        = "${var.name}-db-subnet"
  description = "${var.name} RDS - default VPC subnets across AZs"
  subnet_ids  = data.aws_subnets.default.ids
}

resource "aws_security_group" "db" {
  name        = "${var.name}-db-sg"
  description = "Postgres reachable only from the app SG."
  vpc_id      = data.aws_vpc.default.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
    description     = "Postgres from app instances"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "random_password" "db_master" {
  length           = 32
  special          = true
  override_special = "_-"

  # Rotate the password only when the instance is replaced.
  keepers = {
    db_identifier = "${var.name}-db"
  }
}

resource "aws_db_instance" "app" {
  identifier             = "${var.name}-db"
  engine                 = "postgres"
  engine_version         = "16"
  instance_class         = "db.t4g.micro"
  allocated_storage      = 20
  storage_type           = "gp3"
  storage_encrypted      = true
  db_name                = "claude_for_you"
  username               = "claude"
  password               = random_password.db_master.result
  db_subnet_group_name   = aws_db_subnet_group.app.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false
  multi_az               = false
  # 7 daily automated snapshots — survives a week of mistakes. Still cheap
  # (snapshots are incremental + 100% of allocated storage is free).
  backup_retention_period = 7
  # Backup window picked to be UTC off-hours (16:00 UTC = 01:00 KST, low traffic).
  backup_window = "16:00-17:00"
  # Maintenance window an hour after backup — keeps both off-peak.
  maintenance_window  = "thu:17:00-thu:18:00"
  skip_final_snapshot = true
  deletion_protection = false
  apply_immediately   = true

  # Lets terraform destroy clean up cleanly.
  delete_automated_backups = true
}

resource "aws_ssm_parameter" "database_url" {
  name        = local.database_parameter_name
  description = "Postgres connection string for claude-for-you — terraform-owned (do not edit out-of-band)."
  type        = "SecureString"
  # `?sslmode=require` is non-negotiable — RDS rejects unencrypted connections
  # via the default pg_hba.conf. postgres.js honors the query-string flag.
  value = "postgres://${aws_db_instance.app.username}:${random_password.db_master.result}@${aws_db_instance.app.endpoint}/${aws_db_instance.app.db_name}?sslmode=require"
}

# ---------- Security group ----------
# No port 22 — SSM Session Manager replaces SSH. Outbound HTTPS reaches SSM endpoints.
resource "aws_security_group" "app" {
  name        = "${var.name}-sg"
  description = "claude-for-you: 80/443 only. SSM Session Manager replaces SSH."

  # 80 is REQUIRED for Let's Encrypt http-01 ACME challenge.
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTP (Caddy ACME)"
  }

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTPS (Caddy)"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "All egress (Anthropic API, Docker Hub, GHCR, SSM endpoints)"
  }
}

# ---------- EC2 instance ----------
locals {
  # Docker Compose v2 — pinned. `releases/latest` once redirected to a wrong
  # asset (v5.1.4) whose buildx requirement (>=0.17) broke `compose --build`.
  # Pin to known-good v2.30.x and install buildx alongside.
  docker_compose_version = "v2.30.3"
  docker_buildx_version  = "v0.17.1"

  user_data = <<-EOT
    #!/bin/bash
    set -e
    dnf update -y
    dnf install -y docker git jq

    systemctl enable --now docker
    usermod -aG docker ec2-user

    # ---- Docker Compose v2 (pinned) ----
    mkdir -p /usr/local/lib/docker/cli-plugins
    ARCH=$(uname -m)
    curl -sL "https://github.com/docker/compose/releases/download/${local.docker_compose_version}/docker-compose-linux-$${ARCH}" \
      -o /usr/local/lib/docker/cli-plugins/docker-compose
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

    # ---- Docker Buildx (required by Dockerfile syntax=docker/dockerfile:1.7) ----
    curl -sL "https://github.com/docker/buildx/releases/download/${local.docker_buildx_version}/buildx-${local.docker_buildx_version}.linux-$${ARCH == "x86_64" && "amd64" || "arm64"}" \
      -o /usr/local/lib/docker/cli-plugins/docker-buildx
    chmod +x /usr/local/lib/docker/cli-plugins/docker-buildx

    # ---- fetch-env.sh writer (runs BEFORE any clone attempt so it's always present) ----
    # If the SSM /env or /database-url parameters are still placeholders, this
    # script will write garbage to .env; that's fine — operator populates them
    # via put-parameter, then re-runs fetch-env.sh.
    cat > /usr/local/bin/fetch-env.sh <<'FETCH'
    #!/bin/bash
    set -euo pipefail
    TARGET=/home/ec2-user/claude-for-you/.env
    aws ssm get-parameter \
      --name ${local.env_parameter_name} \
      --with-decryption \
      --region ${var.region} \
      --query 'Parameter.Value' \
      --output text > "$${TARGET}"
    RDS_URL=$(aws ssm get-parameter \
      --name ${local.database_parameter_name} \
      --with-decryption \
      --region ${var.region} \
      --query 'Parameter.Value' \
      --output text)
    # Strip any DATABASE_URL the operator put in /env, then append the RDS one.
    { grep -v '^DATABASE_URL=' "$${TARGET}" || true; echo "DATABASE_URL=$${RDS_URL}"; } > "$${TARGET}.new"
    mv "$${TARGET}.new" "$${TARGET}"
    chown ec2-user:ec2-user "$${TARGET}"
    chmod 600 "$${TARGET}"
    echo "Wrote $${TARGET} (mode 600)"
    FETCH
    chmod +x /usr/local/bin/fetch-env.sh

    # ---- Optional auto-clone — only if git_repo_url is set ----
    # Uses the GitHub PAT from SSM when populated (private-repo support);
    # falls back to anonymous (public-repo only) when the placeholder is intact.
    %{if var.git_repo_url != ""~}
    PAT=$(aws ssm get-parameter \
      --name ${local.pat_parameter_name} \
      --with-decryption \
      --region ${var.region} \
      --query 'Parameter.Value' \
      --output text 2>/dev/null || echo "PLACEHOLDER_RUN_PUT_PARAMETER")
    CLONE_URL="${var.git_repo_url}"
    if [ "$${PAT}" != "PLACEHOLDER_RUN_PUT_PARAMETER" ] && [ -n "$${PAT}" ]; then
      # Inject PAT into HTTPS URL for private-repo support.
      CLONE_URL=$(echo "${var.git_repo_url}" | sed "s#https://github.com/#https://oauth2:$${PAT}@github.com/#")
    fi
    sudo -u ec2-user bash -c "cd /home/ec2-user && git clone $${CLONE_URL} claude-for-you" || \
      echo "[user-data] git clone failed (private repo without PAT?). Operator can clone manually after SSM-session entry."
    %{endif~}

    echo "user-data finished" > /var/log/user-data-done
  EOT
}

resource "aws_instance" "app" {
  ami                    = data.aws_ami.al2023.id
  instance_type          = var.instance_type
  iam_instance_profile   = aws_iam_instance_profile.app.name
  vpc_security_group_ids = [aws_security_group.app.id]

  root_block_device {
    volume_size = var.root_volume_size_gb
    volume_type = "gp3"
    encrypted   = true
  }

  # Encourage IMDSv2 — protects from SSRF-based metadata exfiltration.
  metadata_options {
    http_tokens                 = "required"
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 1
  }

  user_data = local.user_data

  tags = {
    Name = var.name
  }

  lifecycle {
    # `user_data` changes are routine (deploy.sh re-templates it); never let
    # them recreate the instance.
    # `ami` drift is silent and unwanted: `data.aws_ami.al2023` follows
    # most_recent so a new Amazon Linux build would force-replace the
    # instance and erase /data, OAuth tokens, docker layer cache. Pin the
    # AMI here; upgrade is then an explicit operator decision (taint or
    # bump the data filter), not a side effect of `terraform plan`.
    ignore_changes = [user_data, ami]
  }
}

# ---------- Elastic IP (stable DNS target) ----------
resource "aws_eip" "app" {
  instance = aws_instance.app.id
  domain   = "vpc"

  tags = {
    Name = "${var.name}-eip"
  }
}

# ---------- Route53 A record (optional) ----------
resource "aws_route53_record" "app" {
  count = var.domain_zone_id != "" && var.domain_name != "" ? 1 : 0

  zone_id = var.domain_zone_id
  name    = var.domain_name
  type    = "A"
  ttl     = 300
  records = [aws_eip.app.public_ip]
}
