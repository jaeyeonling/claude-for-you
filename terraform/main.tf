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
  env_parameter_arn       = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${local.env_parameter_name}"
  database_parameter_arn  = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${local.database_parameter_name}"
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
  description = "${var.name} RDS — default VPC subnets across AZs"
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
  identifier              = "${var.name}-db"
  engine                  = "postgres"
  engine_version          = "16"
  instance_class          = "db.t4g.micro"
  allocated_storage       = 20
  storage_type            = "gp3"
  storage_encrypted       = true
  db_name                 = "claude_for_you"
  username                = "claude"
  password                = random_password.db_master.result
  db_subnet_group_name    = aws_db_subnet_group.app.name
  vpc_security_group_ids  = [aws_security_group.db.id]
  publicly_accessible     = false
  multi_az                = false
  backup_retention_period = 1
  skip_final_snapshot     = true
  deletion_protection     = false
  apply_immediately       = true

  # Lets terraform destroy clean up cleanly.
  delete_automated_backups = true
}

resource "aws_ssm_parameter" "database_url" {
  name        = local.database_parameter_name
  description = "Postgres connection string for claude-for-you — terraform-owned (do not edit out-of-band)."
  type        = "SecureString"
  value       = "postgres://${aws_db_instance.app.username}:${random_password.db_master.result}@${aws_db_instance.app.endpoint}/${aws_db_instance.app.db_name}"
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
  user_data = <<-EOT
    #!/bin/bash
    set -e
    dnf update -y
    dnf install -y docker git

    systemctl enable --now docker
    usermod -aG docker ec2-user

    # Install docker-compose v2 plugin (Amazon Linux 2023 has no compose by default)
    mkdir -p /usr/local/lib/docker/cli-plugins
    ARCH=$(uname -m)
    curl -sL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$${ARCH}" \
      -o /usr/local/lib/docker/cli-plugins/docker-compose
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

    %{if var.git_repo_url != ""~}
    # Auto-clone for first-boot bootstrap. Operator still has to populate the .env parameter.
    sudo -u ec2-user bash -c "cd /home/ec2-user && git clone ${var.git_repo_url} claude-for-you"
    %{endif~}

    # Helper: pulls both SecureString parameters and writes /home/ec2-user/claude-for-you/.env.
    # /${var.name}/env       → operator-managed contents (OAuth, API_KEYS, DISCORD_WEBHOOK_URL, etc.)
    # /${var.name}/database-url → terraform-managed RDS connection string (wins over any local value)
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
    # user_data changes shouldn't recreate the instance after first deploy.
    ignore_changes = [user_data]
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
