# Cold storage for messages_log request/response bodies (issue #150).
#
# Why this exists: messages_log stores the full body of every /v1/messages call
# with no retention, which filled a 20GB volume in ten weeks and caused the
# 2026-07-30 outage (#149). Bodies move here; the Postgres row stays as a
# queryable stub. See docs/operational-pitfalls.md section 22.
#
# Why S3 and not "just delete": these are the only record of what the proxy
# actually sent and received. They are the audit trail for wire-fidelity work
# (snapshot drift, service_tier regressions) and for reconstructing an incident
# after the fact. Deleting them to save disk trades an irreplaceable record for
# a few dollars a month.

resource "aws_s3_bucket" "messages_archive" {
  bucket = "${var.name}-messages-archive"
}

# These objects contain full user prompts and model responses. Nothing about
# this bucket should be reachable from outside the account.
resource "aws_s3_bucket_public_access_block" "messages_archive" {
  bucket = aws_s3_bucket.messages_archive.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# SSE-S3 (AES256) rather than SSE-KMS: a customer-managed key would add
# per-request KMS charges and a second failure mode (key policy drift) for a
# bucket that only ever holds our own data and is read by our own instance.
# Upgrade to KMS if the archive ever needs cross-account access or a hard
# cryptographic delete story.
resource "aws_s3_bucket_server_side_encryption_configuration" "messages_archive" {
  bucket = aws_s3_bucket.messages_archive.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# Deny any non-TLS request. Encryption at rest above says nothing about the
# wire; without this, a misconfigured client could PUT prompts over plain HTTP.
resource "aws_s3_bucket_policy" "messages_archive_tls_only" {
  bucket = aws_s3_bucket.messages_archive.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource = [
        aws_s3_bucket.messages_archive.arn,
        "${aws_s3_bucket.messages_archive.arn}/*",
      ]
      Condition = {
        Bool = { "aws:SecureTransport" = "false" }
      }
    }]
  })
}

# Access pattern: an archived conversation is read when someone investigates an
# incident — rare, unpredictable, and usually recent-ish. So transition on age
# but stay in an instant-retrieval class; Glacier Flexible/Deep would make the
# admin "open archived bodies" link a multi-hour restore job instead of a click.
resource "aws_s3_bucket_lifecycle_configuration" "messages_archive" {
  bucket = aws_s3_bucket.messages_archive.id

  rule {
    id     = "tier-and-expire"
    status = "Enabled"

    filter {
      prefix = "messages-log/"
    }

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 90
      storage_class = "GLACIER_IR"
    }

    # Expiration is opt-in. Default 0 = keep forever: deleting an audit trail
    # should be a deliberate decision with a number attached, not a default
    # someone inherits.
    dynamic "expiration" {
      for_each = var.archive_expiration_days > 0 ? [1] : []
      content {
        days = var.archive_expiration_days
      }
    }
  }

  # A part upload that dies mid-flight (instance reboot during the cron) leaves
  # billable garbage that is invisible in the object listing.
  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# ---------- Write path: the EC2 instance role ----------
# The archiver runs on the instance (host cron → one-shot container, with
# temporary role credentials injected from IMDS by the wrapper script).
#
# No s3:DeleteObject on purpose. Deletion belongs to the lifecycle rule above;
# a bug in the archiver — or anything that gets hold of those temporary
# credentials — must not be able to erase the archive it just wrote.
resource "aws_iam_role_policy" "s3_archive_write" {
  name = "${var.name}-s3-archive-write"
  role = aws_iam_role.app.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.messages_archive.arn}/messages-log/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.messages_archive.arn
        Condition = {
          StringLike = { "s3:prefix" = ["messages-log/*"] }
        }
      },
    ]
  })
}

# ---------- Read path: a scoped IAM user ----------
# The long-running app container needs to read archived bodies for the admin
# detail view, and it CANNOT use the instance role: aws_instance.app sets
# http_put_response_hop_limit = 1 (SSRF hardening), which makes IMDS unreachable
# from inside a container. Verified empirically on the instance — the host
# reaches IMDS, the container does not.
#
# Rejected alternatives:
#   - raise the hop limit to 2: this proxy forwards arbitrary user-controlled
#     prompts to an upstream API, so handing containers a path to instance
#     credentials is exactly the exposure the hop limit exists to prevent.
#   - skip in-UI reading entirely: the detail page still degrades to showing the
#     object key (see renderArchiveBanner), but reading your own archived
#     conversation should not require a terminal.
#
# So: one long-lived credential, scoped as narrowly as it can be — GetObject on
# a single prefix of a single bucket. Blast radius if leaked is "read archived
# proxy logs", which is data the admin UI already displays to the same operator.
resource "aws_iam_user" "archive_reader" {
  name = "${var.name}-archive-reader"
}

resource "aws_iam_user_policy" "archive_reader" {
  name = "${var.name}-archive-read"
  user = aws_iam_user.archive_reader.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject"]
      Resource = "${aws_s3_bucket.messages_archive.arn}/messages-log/*"
    }]
  })
}

resource "aws_iam_access_key" "archive_reader" {
  user = aws_iam_user.archive_reader.name
}

# Terraform-owned, unlike /claude-for-you/env (which is populated out-of-band and
# has ignore_changes on its value). The secret is generated by terraform here, so
# terraform is the only sensible owner — and rotation is `terraform taint
# aws_iam_access_key.archive_reader && terraform apply` + a container restart.
resource "aws_ssm_parameter" "archive_reader_credentials" {
  name        = "/${var.name}/archive-reader-credentials"
  description = "Read-only S3 credentials for the messages_log archive, consumed by the app container."
  type        = "SecureString"
  value = jsonencode({
    S3_ACCESS_KEY_ID     = aws_iam_access_key.archive_reader.id
    S3_SECRET_ACCESS_KEY = aws_iam_access_key.archive_reader.secret
  })
}
