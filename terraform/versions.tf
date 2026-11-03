terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "claude-for-you"
      ManagedBy = "terraform"
      # Org-required ownership tags for the shared AWS account.
      Role    = "techcourse-etc"
      Service = "techcourse"
    }
  }

  # Org governance (Cloud Custodian `c7n_*`, `cloud_resource:*`) stamps its
  # own tags on our resources. Without this every plan would strip them and
  # the two would fight forever.
  ignore_tags {
    key_prefixes = ["c7n_", "cloud_resource:"]
  }
}
