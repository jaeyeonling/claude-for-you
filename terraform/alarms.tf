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
          "aws:SourceArn" = "arn:aws:cloudwatch:${var.region}:${data.aws_caller_identity.current.account_id}:alarm:*"
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
