variable "region" {
  description = "AWS region"
  type        = string
  default     = "ap-northeast-2"
}

variable "name" {
  description = "Name tag prefix for resources"
  type        = string
  default     = "claude-for-you"
}

variable "instance_type" {
  description = "EC2 instance type. t4g.medium (Graviton, 4 GiB RAM) — picked over t3.medium for ~10% cost. Must remain an arm64 family member; the AMI filter is pinned to al2023 arm64."
  type        = string
  default     = "t4g.medium"
}

variable "root_volume_size_gb" {
  description = "Root EBS size. Token store + capture logs live here."
  type        = number
  default     = 20
}

variable "domain_zone_id" {
  description = "Route53 zone ID. Leave empty to skip DNS record creation (manage DNS elsewhere)."
  type        = string
  default     = ""
}

variable "domain_name" {
  description = "FQDN for the proxy, e.g. claude.example.com. Required iff domain_zone_id is set."
  type        = string
  default     = ""
}

variable "git_repo_url" {
  description = "Git URL the EC2 will clone on first boot. Empty = skip auto-clone."
  type        = string
  default     = ""
}

variable "alert_email" {
  description = "Email address subscribed to the SNS topic that receives CloudWatch alarm notifications. Empty = create the topic but no subscriber (alarms still publish; just nobody receives them)."
  type        = string
  default     = ""

  validation {
    condition     = length(var.alert_email) == 0 || can(regex("^.+@.+$", var.alert_email))
    error_message = "alert_email must be either empty or a string containing exactly one '@' character (e.g., ops@example.com). Validation is intentionally loose — full RFC 5322 is the SNS subscription confirmation step's job."
  }
}
