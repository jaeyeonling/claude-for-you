# Private subnet + NAT (#178, step 3 of #174) — the instance no longer has a
# public IP and nothing on the internet can address it directly. Inbound goes
# through the NLB (nlb.tf); outbound (Anthropic API, GitHub, SSM, Docker Hub)
# goes through a NAT Gateway that reuses the instance's former EIP, so the
# egress IP Anthropic sees does not change.
#
# The default VPC is shared with other projects: we only *add* a subnet and a
# route table. The default public subnets and their routes are untouched.

# The default public subnet in the NLB's AZ. Hosts the NLB and the NAT
# Gateway. Looked up (not derived from the instance) so moving the instance
# never drags the NLB into a replacement. AZ "a" is where the NLB already
# lives (it was created in the old instance's subnet, ap-northeast-2a); a
# different AZ here would change the NLB's subnet_mapping and replace it.
# Single AZ by design: the NLB EIP is per-AZ, and one EIP = one client IP.
# The NAT is therefore a single point of failure — including for SSM access,
# so if the NAT is down the operator loses the debug path too.
data "aws_subnet" "public" {
  vpc_id            = data.aws_vpc.default.id
  availability_zone = "${var.region}a"
  default_for_az    = true
}

resource "aws_subnet" "private" {
  vpc_id            = data.aws_vpc.default.id
  cidr_block        = var.private_subnet_cidr
  availability_zone = data.aws_subnet.public.availability_zone

  map_public_ip_on_launch = false

  tags = {
    Name = "${var.name}-private"
  }
}

resource "aws_nat_gateway" "egress" {
  allocation_id = aws_eip.app.id
  subnet_id     = data.aws_subnet.public.id

  tags = {
    Name = "${var.name}-nat"
  }
}

resource "aws_route_table" "private" {
  vpc_id = data.aws_vpc.default.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.egress.id
  }

  tags = {
    Name = "${var.name}-private"
  }
}

resource "aws_route_table_association" "private" {
  subnet_id      = aws_subnet.private.id
  route_table_id = aws_route_table.private.id
}

# S3 traffic (messages_log body archive, admin archive reads) would otherwise
# be billed per GB through the NAT. A gateway endpoint is free and keeps it on
# the AWS network. Interface endpoints (SSM, ECR, …) are NOT added: at ~$0.0145
# per hour each they cost more than the NAT bytes they would save.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = data.aws_vpc.default.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]

  tags = {
    Name = "${var.name}-s3"
  }
}
