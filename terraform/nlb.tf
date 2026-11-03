# NLB front door (#174) — step 1 of moving the instance off a directly
# attached public IP (security notice: kernel CVE response, option B).
#
# Why NLB + Caddy TLS instead of ALB + ACM: there is no domain. ACM can't issue
# for `*.elb.amazonaws.com`, but Let's Encrypt issues IP-address certificates
# (`shortlived` profile, ~6-day validity) and Caddy renews them on its own.
# An NLB passes TCP through untouched, so Caddy keeps terminating TLS and
# keeps answering the ACME http-01 / tls-alpn-01 challenges. Spike: #173.
#
# Step 1 (this file) runs NLB *alongside* the old EIP path so clients can move
# to https://<nlb_public_ip> at their own pace. Step 2 removes the 0.0.0.0/0
# ingress on the instance and moves it into a private subnet behind NAT.

# Static, operator-owned address — clients pin it in ANTHROPIC_BASE_URL and it
# is the IP the certificate is issued for, so it must never change.
resource "aws_eip" "nlb" {
  domain = "vpc"

  tags = {
    Name = "${var.name}-nlb-eip"
  }
}

resource "aws_security_group" "nlb" {
  name        = "${var.name}-nlb-sg"
  description = "claude-for-you NLB: public 80/443, forwards to the app SG only."
  vpc_id      = data.aws_vpc.default.id

  # 80 stays open for Let's Encrypt http-01 (Caddy also tries tls-alpn-01 on 443).
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTP (ACME http-01)"
  }

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTPS"
  }

  # Without an explicit egress block terraform drops the default allow-all,
  # so the NLB could not reach its targets.
  egress {
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
    description     = "To Caddy HTTP"
  }

  egress {
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
    description     = "To Caddy HTTPS"
  }
}

resource "aws_lb" "app" {
  name               = "${var.name}-nlb"
  load_balancer_type = "network"
  internal           = false
  security_groups    = [aws_security_group.nlb.id]

  # Single AZ: the NLB EIP lives in the instance's subnet. A second AZ would
  # need a second EIP (= a second IP clients and the cert would have to know).
  subnet_mapping {
    subnet_id     = aws_instance.app.subnet_id
    allocation_id = aws_eip.nlb.id
  }
}

locals {
  nlb_ports = toset(["80", "443"])
}

resource "aws_lb_target_group" "app" {
  for_each = local.nlb_ports

  name        = "${var.name}-tcp-${each.key}"
  port        = tonumber(each.key)
  protocol    = "TCP"
  vpc_id      = data.aws_vpc.default.id
  target_type = "instance"

  # Keep the real client IP: Caddy's X-Forwarded-For and the app's per-IP rate
  # limiter see the caller, not the NLB. Verified in #173 that ACME validation
  # still passes when the target SG only references the NLB SG.
  # Load-bearing for rate limiting: src/proxy/rate-limit.ts trusts the
  # leftmost X-Forwarded-For, which is only safe because Caddy (no
  # `trusted_proxies`) overwrites it with the TCP peer. Turning this off, or
  # adding trusted_proxies for the VPC range, makes every caller one bucket
  # or lets callers spoof their IP.
  # Side effect: a target can't reach itself through this NLB (no NAT
  # loopback) — see src/tls-expiry.ts and operational-pitfalls #25.
  preserve_client_ip = true

  health_check {
    protocol = "TCP"
  }
}

resource "aws_lb_target_group_attachment" "app" {
  for_each = local.nlb_ports

  target_group_arn = aws_lb_target_group.app[each.key].arn
  target_id        = aws_instance.app.id
  port             = tonumber(each.key)
}

resource "aws_lb_listener" "app" {
  for_each = local.nlb_ports

  load_balancer_arn = aws_lb.app.arn
  port              = tonumber(each.key)
  protocol          = "TCP"

  # Default 350s would cut SSE streams that idle through long thinking
  # blocks; Caddy's own read/write timeouts are 10m. Stay above them.
  tcp_idle_timeout_seconds = 900

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app[each.key].arn
  }
}
