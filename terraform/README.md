# terraform/

EC2 인프라 (t3.micro + EIP + SG). Route53 A 레코드는 선택.

## 사전

- AWS 계정 + `aws configure` 또는 SSO 프로파일
- EC2 키 페어 1개 (AWS 콘솔 EC2 → Key Pairs → 생성. `.pem` 다운로드 후 `chmod 600`)
- (선택) Route53에 도메인이 있다면 zone ID 메모

## 적용

```bash
cd terraform/

# 1. 변수 파일 채우기
cp terraform.tfvars.example terraform.tfvars
vim terraform.tfvars

# 2. 검토 → 적용
terraform init
terraform plan
terraform apply

# 3. 출력 확인
terraform output public_ip
terraform output ssh_command
```

## 그 다음 (수동 단계)

```bash
# EC2 접속
ssh -i ~/.ssh/your-key.pem ec2-user@$(terraform output -raw public_ip)

# user_data가 docker + git를 깔아둠. 끝났는지 확인:
test -f /var/log/user-data-done && echo "ready"

# 리포 클론 (git_repo_url 변수를 비웠다면 수동)
cd ~ && git clone <your-fork-url> claude-for-you
cd claude-for-you

# .env 채우기 (OAuth + API keys + DOMAIN + DISCORD_WEBHOOK_URL)
cp .env.example .env
chmod 600 .env
vim .env

# docker compose up -d --build
# Caddy가 자동으로 LE 인증서 발급 (DOMAIN env가 EC2 IP로 resolve돼야)
docker compose up -d --build

# 검증
curl https://your-domain/healthz
```

## 파괴

```bash
terraform destroy
```

> ⚠️ `terraform destroy`는 EBS 볼륨까지 지웁니다 → tokens.json도 함께 사라짐. 보존하려면 미리 백업.

## state 파일

`terraform.tfstate`는 **민감 정보** (인스턴스 정보, 옵션에 따라 다른 비밀)를 포함합니다. `.gitignore`에서 제외 중. 팀이라면 remote backend (S3 + DynamoDB lock)로 마이그레이션 권장.
