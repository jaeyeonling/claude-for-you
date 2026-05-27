# claude-for-you

> 셀프 호스팅 Anthropic 호환 프록시. 하나의 Claude.ai 구독, 몇 개의 API 키, 신뢰하는 소수.

[![CI](https://github.com/jaeyeonling/claude-for-you/actions/workflows/ci.yml/badge.svg)](https://github.com/jaeyeonling/claude-for-you/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun%201.3+-fbf0df.svg)](https://bun.sh)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

[English README](./README.md) · Bun · Hono · Caddy · PostgreSQL · Terraform

---

## ⚠️ 시작하기 전에

**이 프로젝트는 Anthropic의 이용 약관에 위반될 가능성이 있습니다.**

Anthropic의 Consumer Terms, Acceptable Use Policy, Subscription Terms는 일반적으로 **개인 구독 계정의 공유나 재판매를 금지**합니다. 이 프록시는 한 개의 Claude.ai OAuth 토큰을 여러 다운스트림 API 사용자에게 노출하는 형태이며, 본인의 사용 사례가 약관에서 허용되는지는 **본인이 직접 약관을 읽고 판단해야 합니다**.

Anthropic이 약관 위반으로 판단할 경우 **계정 정지, 구독 취소, 환불 거부, 법적 조치**까지 가능합니다.

본 프로젝트의 운영자/기여자는 **사용으로 인한 어떤 결과에도 책임지지 않습니다**. 사용은 전적으로 본인 책임입니다. 가까운 가족이나 신뢰하는 소수 동료 정도까지만 권장합니다. **공개 SaaS로 운영하는 것은 명백한 약관 위반 영역**입니다.

이 디스클레이머에 동의하지 않으면 **이 도구를 사용하지 마세요**.

---

## 무엇을 하나

하나의 Claude.ai 구독 OAuth 자격증명을 여러 API 키 게이트웨이로 전환하는 리버스 프록시. 요청이 실제 Claude Code 트래픽처럼 보이도록 **wire-fidelity 방어**를 적극 수행합니다.

```mermaid
flowchart LR
    Client[CC / curl / SDK]
    Caddy[Caddy<br/>TLS · ACME]
    Bun[Bun proxy<br/>:3456]
    Pool[Account Pool<br/>OAuth refresh]
    Anthropic[api.anthropic.com]
    PG[(Postgres<br/>usage)]
    SSM[(SSM Parameter Store<br/>SecureString)]
    Admin[/Admin UI<br/>token · webhook rotation/]

    Client -->|x-api-key| Caddy
    Caddy -->|HTTP/2 internal| Bun
    Bun -->|TLS ClientHello matches CC| Anthropic
    Bun --> Pool
    Bun --> PG
    Bun -.-> Admin
    SSM -. boot .-> Bun
    Pool --> Anthropic
```

**왜 이걸 만들었나**

- Anthropic은 팀 공유 구독 티어를 제공하지 않습니다.
- 직접 API를 쓰면 보통 구독료의 약 4배 비용.
- 2~3명이 신뢰하는 사람끼리 한 구독을 공유하는 건 SaaS 운영과 전혀 다른 문제입니다. 후자는 명백히 금지, 전자는 회색 지대 — 이 도구가 다루는 영역.

## 내부에서 흥미로운 것들

이 분야의 대부분 프로젝트가 신경 쓰지 않는 부분들:

- **Capture → synthesize → replay 루프**: `CAPTURE_MODE` 미들웨어가 실제 Claude Code 트래픽의 TCP 도착 순서대로 HTTP 와이어 형태를 기록 (Web `Headers`는 알파벳 순으로 정렬되므로 fingerprint를 망가뜨려서 `@hono/node-server` 사용). `scripts/synthesize-snapshot.mjs`가 N개 캡처를 `cc-snapshot.json`으로 융합하여 dominant 헤더 순서, 헤더 값, body key 순서, inter-request pacing 분포까지 추출. 런타임에 그대로 재생; 오래된 snapshot은 자동 경고.
- **Account pool 라우팅**: 여러 Claude.ai 구독을 Anthropic의 `anthropic-ratelimit-unified-remaining` 헤더로 가중치, 동일 `x-claude-code-session-id`는 한 계정에 핀(prompt cache 보존). 429 시 다른 계정으로 자동 재핀.
- **Wire shape 카나리 배포**: `cc-snapshot.candidate.json`을 stable 옆에 두고 `CANARY_PERCENT` 설정 → 일부 트래픽이 candidate 사용. candidate 응답에 `service_tier ≠ "standard"` 발생 시 카나리 트립 → 자동 stable 복귀. **돈이 새기 전 자동 롤백**.
- **Drift root-cause analyzer**: `service_tier`가 `standard`에서 벗어나면 Discord 알람에 5분 전후 fingerprint 차이 (헤더명, body keys, beta flags, models)가 포함됨. "3시 알람"이 "이 헤더가 4 요청 전에 새로 나타나기 시작했음"으로 바뀜.
- **운영자 토큰/웹훅 회전**: refresh token, access token, Discord/Slack webhook URL을 admin UI에서 재시작 없이 회전 — SSH 불필요, `aws ssm put-parameter` 불필요.

## 빠른 시작 (Docker Compose, 로컬)

```bash
# 1. 사용량 추적용 로컬 Postgres
docker compose --profile dev up -d postgres

# 2. .env 템플릿
cp .env.example .env
# ANTHROPIC_OAUTH_REFRESH_TOKEN, API_KEYS, DATABASE_URL 채우기

# 3. 호스트에서 hot reload 실행
bun install
bun run dev
```

그 다음 `curl -H "x-api-key: $YOUR_KEY" -X POST http://127.0.0.1:3456/v1/messages …`로 `api.anthropic.com`처럼 사용.

## 빠른 시작 (EC2 + RDS, Terraform)

```bash
# 1. SSH 키 페어 불필요 — 세션은 AWS Systems Manager 경유
brew install --cask session-manager-plugin

# (선택) private repo면 terraform apply 후 PAT 등록:
#   aws ssm put-parameter --name /claude-for-you/github-pat \
#     --value "ghp_xxx" --type SecureString --overwrite --region ap-northeast-2

# 2. terraform.tfvars 수정 (선택사항 — 기본값으로도 대부분 OK)
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
cd terraform && terraform init && terraform apply

# 3. .env 내용을 SSM SecureString으로 업로드
aws ssm put-parameter \
  --name /claude-for-you/env \
  --value "$(cat .env)" \
  --type SecureString --overwrite \
  --region ap-northeast-2

# 4. 인스턴스에 SSM 세션 진입 + 스택 기동
aws ssm start-session --target $(terraform output -raw instance_id) --region ap-northeast-2
$ sudo /usr/local/bin/fetch-env.sh
$ cd /home/ec2-user/claude-for-you && sudo docker build -t claude-for-you:latest . && sudo docker compose up -d
```

terraform 모듈이 프로비저닝하는 것: EC2 (t3.micro, AL2023, IMDSv2 강제, SSM 전용 접근 — 22번 포트 미개방), RDS Postgres (t4g.micro, single-AZ, 암호화), Elastic IP, SSM 파라미터 2개에만 한정된 IAM role.

## 설정

| Env var | 기본값 | 비고 |
|---|---|---|
| `PORT` | `3456` | 내부 프록시 포트. Caddy가 80/443에서 fronting. |
| `HOST` | `127.0.0.1` | 컨테이너에서는 `0.0.0.0`. |
| `ANTHROPIC_OAUTH_REFRESH_TOKEN` | _(single-account 모드에서 필수)_ | Claude.ai 세션의 `sk-ant-ort01-…`. |
| `ANTHROPIC_OAUTH_ACCESS_TOKEN` | _(선택)_ | 비우면 첫 요청에서 refresh. |
| `ANTHROPIC_OAUTH_EXPIRES_AT` | _(선택)_ | Epoch ms. |
| `ACCOUNTS_PATH` | `./data/accounts.json` | Multi-account pool 설정. 존재하면 single-account env vars 무시. |
| `API_KEYS` | _(필수)_ | `name1:key1,name2:key2`. `openssl rand -hex 32`로 생성. |
| `API_KEYS_PATH` | _(선택)_ | 변경 가능한 파일 기반 저장소. admin UI의 self-serve add/revoke 사용 시 필수. |
| `DATABASE_URL` | _(운영에서 필수)_ | `postgres://user:pass@host:port/db`. 미설정 시 인메모리 fallback (dev only). |
| `DAILY_TOKEN_LIMIT_PER_KEY` | `0` (무제한) | 키별 일일 상한, UTC 리셋. |
| `GLOBAL_SUBSCRIPTION_THRESHOLD_TOKENS` | `0` (off) | Anthropic의 잔여 토큰이 이 값 아래면 새 요청 거부. |
| `MAX_CONCURRENT_REQUESTS` | `8` | 어플리케이션 레이어 동시성 캡. 초과 시 429. |
| `PER_IP_RATE_LIMIT_PER_SECOND` | `0` (off) | `/v1/messages`의 per-IP 토큰 버킷. burst = 2배. Caddy의 `rate_limit` 모듈 없이도 방어. |
| `TOKEN_STORE_PATH` | `./data/tokens.json` | OAuth 매니저가 refreshed token을 영속화하는 경로. 컨테이너에선 볼륨으로 마운트. |
| `DISCORD_WEBHOOK_URL` | _(선택)_ | 주 알람 채널. |
| `SLACK_WEBHOOK_URL` | _(선택)_ | Discord 미설정 시 fallback. |
| `DOMAIN` | _(Caddy에서 필수)_ | ACME용 FQDN, 또는 IP-only 배포면 `:80`. |
| `LOG_LEVEL` | `info` | `debug`는 per-request 액세스 로그 활성화. |
| `PACING_MIN_GAP_MS` | `0` | 동일 session id의 outbound 두 요청 사이 최소 ms. `0` = snapshot p50 사용. |
| `ACCOUNT_UUID_OVERRIDE` | _(선택)_ | 특정 account UUID 강제. 비우면 응답 헤더에서 학습. |
| `CANARY_PERCENT` | `0` | `cc-snapshot.candidate.json`이 있을 때 candidate 사용 트래픽 %. |
| `CAPTURE_MODE` | `false` | 모든 인증된 요청을 `CAPTURE_DIR`에 dump. 운영에선 절대 켜지 말 것. |
| `CAPTURE_DIR` | `./captures` | 캡처 dump 저장 경로. gitignored. |

## 다른 사람한테 사용 권한 주기

키 발급 후 사용자 가이드 링크와 함께 두 정보를 전달.

```bash
# 운영자 — 새 키 발급
curl -sS -u admin:<운영자-키> http://<프록시-호스트>/admin/keys \
  -H 'content-type: application/json' \
  -d '{"name":"bob"}'
# 응답에 키 값 포함 — 발급 시 한 번만 표시됨.

# 모델 family 단위 제한 (예: 일반 사용자에게 haiku만 허용)
curl -sS -u admin:<운영자-키> http://<프록시-호스트>/admin/keys \
  -H 'content-type: application/json' \
  -d '{"name":"carol", "allowedModels": ["claude-haiku-*"]}'
# 제한된 키는 거부된 모델 요청 시 403 model_not_allowed 반환.
# `allowedModels`를 생략 (또는 []) 하면 제한 없음. 패턴은 정확 id
# ("claude-haiku-4-5-20251001") 또는 끝-와일드카드 family
# ("claude-sonnet-*") 만 허용. env-baked 키(API_KEYS=…)는 allowedModels
# 못 가짐 — 제한된 사용자는 api-keys.json 사용.
```

사용자에게 보낼 메시지:

> 프록시 URL: `http://<프록시-호스트>`
> API 키: `<위 응답의 값>`
> 설정 방법: [`docs/user-guide.ko.md`](./docs/user-guide.ko.md) — **권장 설정**을 따른다.

사용자 가이드에는 권장 설정(Keychain + `apiKeyHelper`), 배너로 인증 모드 확인, 401/429 흔한 함정, 그리고 본인 Claude Max를 같은 머신에서 병행 사용하는 사용자를 위한 대안 설정이 정리되어 있음. 영문판: [`docs/user-guide.md`](./docs/user-guide.md).

## Admin 엔드포인트

모든 `/admin/*`은 API-key 인증 (프록시의 authorized keys — 아무거나 하나). CSRF 가드가 cross-origin 브라우저 POST를 거부.

| 라우트 | Method | 용도 |
|---|---|---|
| `GET /admin` | — | 운영자 대시보드. billing health, account pool headroom, canary 상태, per-user usage, 아래 폼들. |
| `GET /admin/stats` | — | 같은 데이터를 JSON으로. |
| `POST /admin/keys` | JSON | Self-serve 추가 — `{ name, key?, allowedModels? }`. `API_KEYS_PATH` 필요. `allowedModels`는 정확 id 또는 `family-*` wildcard. |
| `DELETE /admin/keys/:name` | — | 키 회수. 폼 미러: `POST /admin/keys/:name/revoke`. |
| `POST /admin/oauth/replace` | form/JSON | Fresh refresh token paste. 다음 요청이 새 access token을 mint. single-account 모드는 `memberName=default`. |
| `POST /admin/alerts/discord` | form | Discord webhook URL 회전. 빈 `url`은 클리어. |
| `POST /admin/alerts/slack` | form | Slack도 동일. |
| `POST /admin/snapshot/promote` | form | `cc-snapshot.candidate.json`을 stable로 승격. 적용엔 컨테이너 재시작 필요. |
| `POST /admin/snapshot/rollback` | form | candidate 삭제. |

## 운영

- **토큰 회전**: `/admin` 진입, fresh refresh token paste, 제출. 재시작 불필요. 풀이 headroom 추정을 리셋하여 다음 요청이 새로 학습.
- **Webhook 회전**: 같은 UI. `/data/alerts.json`에 영속화; 재시작 후에도 파일이 env baseline을 덮어씀.
- **일일 quota**: per-user 카운터는 Postgres에 있음; `terraform destroy` 후 `apply`는 `usage_per_user` 히스토리만 잃음 (의도적 — 카운터지 source of truth는 아님).
- **Snapshot 신선도**: 부팅 배너에 snapshot age 표시. 60일 초과 → 경고. CC 업데이트 후 `bun run extract-template` 실행, diff 검토, 커밋.
- **흔한 함정**: [`docs/operational-pitfalls.md`](./docs/operational-pitfalls.md) 참조. 가장 아픈 것: 같은 refresh token을 쓰는 어떤 머신에서든 `claude /logout`을 실행하면 **그 토큰을 쓰는 모든 머신**의 토큰을 서버 측에서 무효화.

## Wire fidelity (C-partial)

이 프록시는 Claude Code의 HTTP 와이어 형태 snapshot을 ship해서 모든 outbound 요청에 재생합니다. Snapshot은 `scripts/extract-cc-template.mjs`로 본인 머신의 `claude` 바이너리에서 직접 추출. 잡는 것과 못 잡는 것:

| 축 | 상태 | 방법 |
|---|---|---|
| TLS ClientHello | ✅ | Bun의 TLS 스택이 Claude Code의 BoringSSL fingerprint와 일치. |
| 헤더 순서 | ✅ | TCP 도착 순서대로 캡처, `@hono/node-server`로 재생. |
| `anthropic-beta` flags | ✅ | 정적 바이너리 추출 + 화이트리스트, 클라이언트 beta flag union. |
| `user-agent`, `x-app`, `anthropic-version` | ✅ | 정적. |
| Body key 순서 | ✅ | 캡처. |
| Session lifecycle & pacing | ✅ | Snapshot의 p50 inter-arrival을 pacing floor로 사용. |
| Cumulative aggregates | ❌ | 한 OAuth 계정의 multi-tenant 트래픽은 주 단위로 구조적으로 부자연. Multi-account pool만이 완화책. |

42-capture 경험적 reference는 [`docs/cc-wire-reference.md`](./docs/cc-wire-reference.md) 참조.

## 프로젝트 레이아웃

`README.md` (English)의 같은 섹션 참조.

## 왜 이런 선택을 했나

- **Bun, not Node**: Bun의 TLS 스택은 Claude Code의 BoringSSL fork와 호환되는 ClientHello fingerprint를 만듭니다. Node TLS는 아닙니다.
- **Caddy, not nginx**: ACME 자동화가 기본 제공. 일반적 케이스에 zero-config TLS.
- **PostgreSQL, not SQLite**: 컨테이너 destroy/recreate를 견디고, 결국엔 "로드밸런서 뒤 2 replicas" 토폴로지를 지원. 현재 배포는 단일 인스턴스라도.
- **Bun 위 Hono**: 가볍고(~50KB) Bun-native. 단 `CAPTURE_MODE`에서 `/v1/messages`는 `@hono/node-server`로 fallback — Web Request API가 헤더 case/순서를 정규화해서 우리가 기록하고 싶은 fingerprint를 망가뜨리기 때문.
- **SSM Session Manager, not SSH**: 22번 포트 미개방, IAM 기반 auth, CloudTrail 감사 로그. terraform 모듈이 이걸 반영.

## 개발

```bash
bun install
bun run typecheck   # tsc --noEmit
bun test            # bun:test runner
bun run dev         # bun --hot src/server.ts
```

테스트가 다루는 영역: 라우팅 (`account-pool`), SSE 파싱 (`sniff`), webhook 설정 영속성 (`alerts-store`), CSRF 가드, concurrency limiter, 인메모리 tracker quota 계산, admin form 검증, 로거 redaction, errors factory, api-key middleware. `bun test --watch`로 반복 작업.

## 라이선스

MIT. [LICENSE](./LICENSE) 참조.

## 디스클레이머 (다시)

이 README 헤더에 전체 디스클레이머가 있습니다. 이 저장소를 공개로 전환했다고 해서 작성자가 Anthropic 약관 하에서의 특정 사용 사례를 지지한다는 의미는 아닙니다. 작성자는 공개 저장소에서의 자격증명 안전성에 대해 아키텍처를 검토했지만 (추적되는 파일에 시크릿 없음, 모든 자격증명은 SSM SecureString 경유로 런타임 주입), 운영의 합법성에 대해서는 어떤 주장도 하지 않습니다. **모든 책임은 본인에게 있습니다.**
