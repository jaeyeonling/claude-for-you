# CloudWatch alarms for OS-level liveness (issue #111).
#
# Why this file exists separately from main.tf:
# EC2 status checks ping the hypervisor only — they cannot see an OS-level
# hang. The host can be effectively dead while the status check still
# reports `ok`. NetworkIn drop + `TreatMissingData = breaching` together
# catch both halves of that gap:
#  1. Sustained traffic drop on the instance
#  2. Metric publisher itself going silent
#
# Scope of this PR: NetworkIn drop only. SSM Agent ConnectionLost and
# external /healthz are split into separate follow-up PRs; see the
# "Out of scope (follow-up)" section in terraform/README.md.

# ---------- SNS topic (alarm fan-in) ----------
resource "aws_sns_topic" "alerts" {
  name = "${var.name}-alerts"
}

# Defense-in-depth: explicitly name the only *service* principal that
# should reach this topic. What this actually buys:
#
#  - Cross-service injection is blocked. A misconfigured EventBridge
#    rule, Lambda, or Config rule pointed at this topic ARN cannot
#    publish — the service principal is not on the allow list.
#  - The `aws:SourceArn` condition further restricts the publisher to
#    a same-account, same-region CloudWatch alarm.
#
# What this does NOT change:
#
#  - Same-account IAM principals with `sns:Publish` in their identity
#    policy CAN still publish (AWS evaluates identity and resource
#    policies as a union for same-account access). That's the path the
#    "Diagnostic publish" section of terraform/README.md → Alarms uses.
#    If that path returns AuthorizationError, the operator's identity
#    policy is missing the permission — not this topic policy.
resource "aws_sns_topic_policy" "alerts" {
  arn = aws_sns_topic.alerts.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudWatchAlarmsToPublish"
      Effect    = "Allow"
      Principal = { Service = "cloudwatch.amazonaws.com" }
      Action    = "sns:Publish"
      Resource  = aws_sns_topic.alerts.arn
      Condition = {
        ArnLike = {
          # Pin to alarms under our own `${var.name}-*` naming convention.
          # Follow-up alarms (#115 SSM, #116 healthz) must use the same
          # prefix so they can publish through this topic without policy
          # changes.
          "aws:SourceArn" = "arn:aws:cloudwatch:${var.region}:${data.aws_caller_identity.current.account_id}:alarm:${var.name}-*"
        }
      }
    }]
  })
}

# Conditional subscriber. Empty alert_email keeps the topic alive but
# unsubscribed — useful for terraform plan smoke runs and for environments
# that wire CloudWatch alarms into other channels (e.g., AWS Chatbot)
# without needing email at all.
resource "aws_sns_topic_subscription" "email" {
  count = var.alert_email != "" ? 1 : 0

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# ---------- NetworkIn drop alarm ----------
# Parameter rationale (kept inline so future maintainers don't need
# session notes or commit archaeology):
#   period × evaluation_periods = 5-minute sustained window
#   datapoints_to_alarm = evaluation_periods — all-5-of-5 breaching to
#                         fire (flicker prevention)
#   threshold 5 KB/min        — roughly 3 % of the historical idle
#                               baseline (~160 KB/min); well below
#                               normal traffic, well above zero
#   treat_missing_data = breaching — the metric publisher itself going
#                                    silent is the second half of the
#                                    failure mode this alarm exists for
resource "aws_cloudwatch_metric_alarm" "network_in_drop" {
  alarm_name        = "${var.name}-network-in-drop"
  alarm_description = "OS-level liveness alarm: fires on sustained NetworkIn < 5 KB/min OR metric publisher silence. See terraform/README.md → Alarms for details."

  namespace   = "AWS/EC2"
  metric_name = "NetworkIn"
  dimensions = {
    InstanceId = aws_instance.app.id
  }
  statistic = "Sum"

  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 5

  threshold           = 5000
  comparison_operator = "LessThanThreshold"

  treat_missing_data = "breaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

# ---------- RDS free-storage alarm ----------
# Added after the 2026-07-30 outage: the instance filled its 20GB volume,
# Postgres entered recovery mode, and the first signal anyone got was the admin
# dashboard returning `internal_error`. There was no storage alarm at all.
#
# Parameter rationale:
#   threshold 15 % of allocated_storage — RDS storage autoscaling triggers at
#     roughly 10 % free, so 15 % puts this alarm AHEAD of the automatic growth.
#     That ordering is deliberate: autoscaling silently increases the monthly
#     bill, and the operator should hear about sustained growth before AWS
#     starts buying disk on their behalf. Recompute if allocated_storage moves.
#   period 300 / evaluation_periods 2 — RDS publishes FreeStorageSpace every
#     60s; a 10-minute sustained window filters the transient dips caused by
#     WAL churn and autovacuum without delaying a real fill-up meaningfully
#     (going from 15 % to 0 % takes days at this traffic level, not minutes).
#   statistic Minimum — the worst datapoint in the window is the one that
#     matters; Average would let a brief recovery mask a downward trend.
#   treat_missing_data missingData — unlike the EC2 liveness alarm, silence here
#     is not itself the failure mode. RDS not publishing means the instance is
#     stopped or being modified, which the storage alarm should not claim to
#     have detected. Instance-level death is a separate concern.
#
# Alarm name MUST keep the `${var.name}-` prefix — the SNS topic policy above
# only permits publishes from alarms matching `alarm:${var.name}-*`.
resource "aws_cloudwatch_metric_alarm" "rds_free_storage" {
  alarm_name        = "${var.name}-rds-free-storage"
  alarm_description = "RDS free storage below 15% of allocated. A full volume puts Postgres into recovery mode and takes the admin dashboard down with it (2026-07-30). See docs/operational-pitfalls.md section 22."

  namespace   = "AWS/RDS"
  metric_name = "FreeStorageSpace"
  dimensions = {
    DBInstanceIdentifier = aws_db_instance.app.identifier
  }
  statistic = "Minimum"

  period              = 300
  evaluation_periods  = 2
  datapoints_to_alarm = 2

  # allocated_storage is in GiB; FreeStorageSpace is published in bytes.
  threshold           = aws_db_instance.app.allocated_storage * 1024 * 1024 * 1024 * 0.15
  comparison_operator = "LessThanThreshold"

  treat_missing_data = "missing"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}
