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
  description = "EC2 instance type. t3.micro is enough for trusted-few traffic."
  type        = string
  default     = "t3.micro"
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
