# CloudWatch alarms for OS-level liveness (issue #111).
#
# Why this file exists separately from main.tf:
# EC2 status checks ping the hypervisor only — they cannot see an OS-level
# hang. #107 silently hung the kernel reclaim path; the status check kept
# reporting `ok` while the host was effectively dead. NetworkIn drop +
# `TreatMissingData = breaching` together catch both #107 signatures:
#  1. Traffic falling to ~2.3K bytes/min from ~167K
#  2. CWAgent / metric publisher going silent altogether
#
# Scope of this PR: NetworkIn drop only. The other two signals listed in
# the original issue are split into separate follow-up PRs (see
# `.claude/matrix-sessions/111.md` § Follow-up):
#   - SSM Agent ConnectionLost  → Lambda + DescribeInstanceInformation polling
#                                 (AWS Cloud Operations Blog standard)
#   - External /healthz         → Route53 health check + cross-region SNS

# ---------- SNS topic (alarm fan-in) ----------
resource "aws_sns_topic" "alerts" {
  name = "${var.name}-alerts"
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
# Parameter rationale lives in .claude/matrix-sessions/111.md § alarm table.
# Short version inline:
#   period × evaluation_periods = 5 min sustained window
#   datapoints_to_alarm = evaluation_periods → all-5-of-5 breaching to fire
#                         (flicker prevention)
#   threshold 5 KB/min ≈ 3 % of #107 baseline (~160 KB/min) — well below
#                         normal idle traffic, well above 0
#   treat_missing_data = breaching — metric publisher silence is itself the
#                         second #107 signature
resource "aws_cloudwatch_metric_alarm" "network_in_drop" {
  alarm_name        = "${var.name}-network-in-drop"
  alarm_description = "OS-level liveness: NetworkIn metric falls below 5 KB/min for 5 consecutive 1-min periods, OR metric publisher silent. Signature of #107 silent hang (NetworkIn 167K → 2.3K bytes/min drop without OOM-killer fire)."

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
