output "public_ip" {
  description = "EC2 public IP (Elastic). Point your DNS A record here if not using Route53."
  value       = aws_eip.app.public_ip
}

output "instance_id" {
  description = "EC2 instance ID"
  value       = aws_instance.app.id
}

output "ssm_session_command" {
  description = "Open an interactive shell on the instance via SSM Session Manager. Requires aws cli + session-manager-plugin."
  value       = "aws ssm start-session --target ${aws_instance.app.id} --region ${var.region}"
}

output "put_env_parameter_command" {
  description = "Run this from the directory containing .env to upload it as a SecureString. Re-run any time .env changes."
  value       = "aws ssm put-parameter --name ${aws_ssm_parameter.env.name} --value \"$(cat .env)\" --type SecureString --overwrite --region ${var.region}"
}

output "fetch_env_command" {
  description = "Run this inside the SSM session to pull the .env onto the instance."
  value       = "sudo /usr/local/bin/fetch-env.sh"
}

output "dns_record" {
  description = "Created DNS record (only if domain_zone_id was set)"
  value       = length(aws_route53_record.app) > 0 ? aws_route53_record.app[0].fqdn : "(not managed by terraform — point A record to ${aws_eip.app.public_ip})"
}

output "sns_topic_arn" {
  description = "SNS topic that receives CloudWatch alarm notifications. Wire additional subscribers (Slack via AWS Chatbot, PagerDuty, etc.) to this ARN."
  value       = aws_sns_topic.alerts.arn
}

output "alarm_name" {
  description = "Name of the NetworkIn drop alarm. Use with `aws cloudwatch describe-alarms --alarm-names` to inspect state."
  value       = aws_cloudwatch_metric_alarm.network_in_drop.alarm_name
}
