# claude-for-you

> Anthropic 호환 API를 노출하는 **셀프 호스팅 프록시**.
> 내 Claude.ai 구독 OAuth 토큰을 한 곳에 두고, 신뢰하는 소수에게 API 키로 권한을 나눠 준다.
> **Bun runtime** + Hono. TLS ClientHello가 Claude Code와 매칭되도록 의도적으로 Bun 채택.

---

## ⚠️ 시작하기 전에 — 반드시 읽어주세요

**이 프로젝트는 Anthropic의 이용 약관에 위반될 가능성이 있습니다.**

- Anthropic 약관(Consumer Terms, Acceptable Use, Subscription Terms)은 일반적으로 **개인 구독 계정의 공유 또는 재판매를 금지**합니다.
- 이 도구는 한 사람의 Claude.ai OAuth 토큰을 다수에게 노출하는 형태이며, 그 행위가 약관에서 허용되는지는 **본인이 직접 약관을 읽고 판단해야 합니다**.
- Anthropic이 약관 위반으로 판단할 경우, **계정 정지·구독 취소·환불 거부·법적 조치**까지 가능합니다.
- 본 프로젝트의 운영자/기여자는 **이용으로 인한 어떤 결과에도 책임지지 않습니다**. 사용은 전적으로 본인 책임입니다.
- 신뢰하는 가족·소수 동료 정도까지만 권장합니다. 일반 공개 SaaS로 운영하는 행위는 **명백히 약관 위반 영역**에 들어갈 가능성이 높습니다.

이 문구를 가볍게 넘기지 마세요.

이 디스클레이머에 동의하지 않으면 **이 도구를 사용하지 마세요**.

---

## 무엇을 하나

- `POST /v1/messages` — Anthropic Messages API와 동일한 형태. 들어온 요청을 본인 Claude.ai OAuth 토큰으로 `api.anthropic.com`에 그대로 전달.
- API 키 인증 — 환경변수에 `name1:key1,name2:key2` 형태로 등록. `x-api-key` 또는 `Authorization: Bearer` 헤더로 받음.
- OAuth 자동 갱신 — access token 만료 5분 전 자동 refresh, 진행 중 락은 Promise 캐싱으로 단일화.
- 사용량 가드 — 응답 헤더 기반 **구독 전체 잔여 가드** + **사용자별 일일 토큰 한도(UTC 자정 리셋)**.
- 스트리밍 — SSE를 byte-for-byte 전달하면서 동시에 usage 토큰만 청크에서 엿보기.

### wire fidelity 정책 (C-partial)

본 프로젝트는 사용자 머신의 **Claude Code 바이너리에서 직접 헤더를 추출**해서 wire shape를 모방합니다 (`scripts/extract-cc-template.mjs`). 그러나 호스팅(EC2) + Node.js 환경의 본질적 한계로 일부 fingerprint는 정적으로 잡을 수 없습니다.

**✅ 잡는 것 (자동 추출)**
- `anthropic-beta` flag — CC 바이너리에 박힌 모든 flag를 추출 후 **`/v1/messages`에서 유효한 안전 화이트리스트**만 사용
- `user-agent`, `x-app`, `anthropic-version` — 정적 값
- CC 버전 / build / git sha — 추출일 함께 기록
- **클라이언트가 보낸 `anthropic-beta`는 자동 union** (CC가 자체 책임으로 새 기능 활성화 가능)

**❌ 못 잡는 것 (현재 단계 한계)**
- ~~TLS ClientHello~~ — **Bun runtime 전환으로 해결** (Phase 16). CC와 같은 BoringSSL fork TLS
- **body key 순서** — CC 코드 안에서 동적 생성, 정적 분석으로 추출 불가
- **session-id 라이프사이클, inter-request pacing** — 런타임 동작
- **cumulative aggregates** — 장기 사용 패턴 (multi-account pool로만 우회 가능)

**결과**: 본질적 한계 한 가지(`cumulative aggregate` — single OAuth + multi-tenant 트래픽 결합으로 인한 장기 사용 패턴의 비-자연스러움)는 multi-account pool로만 해결됩니다. 그 외 wire axis는 live capture 기반으로 자동 추적·갱신됩니다. 구독 경로로 정상 인식되는지는 응답 헤더 `anthropic-ratelimit-unified-*`와 `service_tier`로 자동 확인 + Discord 알람. 첫 며칠은 그래도 **수동 청구 모니터링** 권장.

운영:
- 매 부팅 시 사용 중인 snapshot의 추출 시점이 로그로 노출됩니다 (`template: cc-X.Y.Z (extracted YYYY-MM-DD, sha256 …)`)
- 60일 이상 오래된 snapshot은 자동 경고
- CC 업데이트 후 `npm run extract-template`로 갱신 → diff를 검토 → git commit

---

## 빠른 시작 (EC2 + Docker Compose)

### 0. 사전 요구사항

- EC2 인스턴스 (Amazon Linux 2023 또는 Ubuntu 22.04, t3.micro 이상)
- Docker + Docker Compose plugin
- 도메인 1개 (HTTPS 자동 발급용)
- Claude.ai 유료 구독 (Pro/Max)
- Anthropic OAuth refresh token (얻는 방법은 아래 §3)

### 1. EC2 보안 그룹

인바운드 다음을 허용:

| Port | Source | 용도 |
|---|---|---|
| 22 | 본인 IP | SSH |
| 80 | 0.0.0.0/0 | Let's Encrypt ACME http-01 |
| 443 | 0.0.0.0/0 | HTTPS API |

### 2. 도메인 연결

도메인의 A 레코드를 EC2 public IP로 연결. DNS 전파를 기다린 뒤 진행.

### 3. OAuth refresh_token 얻기

본 프로젝트는 **자체 로그인 플로우가 없습니다**. Claude Code의 OAuth 플로우 결과를 빌려옵니다.

**macOS — Keychain에서 추출 (Claude Code v1.x+)**

Claude Code 1.x 이후로 자격증명은 macOS Keychain의 generic password로 저장됩니다 (service: `Claude Code-credentials`).

```bash
# 본인 로컬 머신에서
# 1) Claude Code 미설치라면 먼저 설치
brew install --cask claude-code
claude login   # 브라우저 OAuth 플로우

# 2) 구조 확인 (값 노출 X)
security find-generic-password -w -s "Claude Code-credentials" | python3 -m json.tool
# 처음에는 macOS가 키체인 접근 권한 다이얼로그를 띄움 → 항상 허용
```

JSON은 보통 다음 형태:
```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-...",
    "refreshToken": "sk-ant-ort01-...",
    "expiresAt": 1778573151352
  }
}
```

**Linux — 보통 `~/.claude/.credentials.json` 평문 (구버전) 또는 secret-tool/Gnome Keyring**.

추출한 세 값을 다음 단계 `.env`의 `ANTHROPIC_OAUTH_*`에 채웁니다.

> ⚠️ 토큰을 채팅창에 붙여넣지 말고 본인 터미널 안에서 `.env`에 직접 편집하세요. `.env`는 `chmod 600`.

### 4. API 키 발급

각 신뢰 사용자별로 무작위 키 생성:

```bash
openssl rand -hex 32
# → e.g. 9f3a8b...c41d
```

`API_KEYS` 환경변수에 `name:key` 페어를 콤마로 연결.

### 5. 코드 클론 + lock 생성

```bash
git clone <your-fork-url> claude-for-you
cd claude-for-you
npm install      # package-lock.json 생성 (커밋 권장)
```

### 6. .env 작성

`.env.example`을 복사해서 `.env`로 만들고 채웁니다:

```bash
cp .env.example .env
chmod 600 .env
vim .env
```

| 변수 | 필수 | 설명 |
|---|---|---|
| `ANTHROPIC_OAUTH_REFRESH_TOKEN` | ✅ | §3에서 얻은 refresh token |
| `ANTHROPIC_OAUTH_ACCESS_TOKEN` | ⚪ | 있으면 첫 refresh 절약. 없으면 부팅 시 refresh |
| `ANTHROPIC_OAUTH_EXPIRES_AT` | ⚪ | epoch ms. access token과 함께 |
| `API_KEYS` | ✅ | `alice:9f3a...,bob:7c2e...` |
| `DAILY_TOKEN_LIMIT_PER_KEY` | ⚪ | per-user 일일 토큰 한도. 0=무제한 |
| `GLOBAL_SUBSCRIPTION_THRESHOLD_TOKENS` | ⚪ | 구독 잔여 토큰이 이 값 미만이면 429. 0=비활성 |
| `MAX_CONCURRENT_REQUESTS` | ⚪ | 기본 8 (현재는 표시용, 강제는 미구현) |
| `LOG_LEVEL` | ⚪ | `debug` / `info` / `warn` / `error` |
| `TOKEN_STORE_PATH` | ⚪ | 컨테이너 내부 토큰 영속 경로. 기본 `/data/tokens.json` |
| `DOMAIN` | ✅ (compose) | Caddy에 알려줄 도메인 (HTTPS 자동 발급용) |

### 7. 띄우기

```bash
docker compose up -d --build
docker compose logs -f app
```

처음 부팅 시 Caddy가 Let's Encrypt 인증서를 받습니다 (수십 초). 그 후 `https://your-domain/healthz` 확인:

```bash
curl https://your-domain/healthz
# {"ok":true}
```

---

## 클라이언트에서 사용

발급한 API 키로 본인 도구의 base URL을 우리 서버로 가리키면 됩니다.

### curl

```bash
curl https://your-domain/v1/messages \
  -H "x-api-key: $YOUR_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-opus-4-5",
    "max_tokens": 1024,
    "messages": [{"role":"user","content":"hi"}]
  }'
```

### Anthropic SDK (TypeScript)

```ts
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  baseURL: 'https://your-domain',
  apiKey: process.env.YOUR_ISSUED_KEY!,
});

const response = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'hello' }],
});
```

### Claude Agent SDK / 기타 도구

`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` 환경변수를 본인 도구에 맞게 설정. 도구가 Anthropic API와 호환된다면 그대로 작동합니다.

---

## 운영

### 어드민 페이지

- `https://your-domain/admin` — 운영자용 대시보드 (basic auth)
  - 브라우저가 native credential 다이얼로그를 띄움. user는 아무거나, password에 운영자 API 키
  - 5초 자동 새로고침. service_tier / unified-status / OAuth expires / per-user usage / account org-id 한눈에
- `https://your-domain/admin/stats` — JSON. 자동화/스크립트용
  ```bash
  curl -s -H "x-api-key: $KEY" https://your-domain/admin/stats | jq
  ```

### Discord 알람

`.env`의 `DISCORD_WEBHOOK_URL`에 Discord incoming webhook을 박으면 다음 이벤트가 채널에 자동 알림 (각자 60초 cooldown):

| 이벤트 | 메시지 형태 |
|---|---|
| `service_tier != 'standard'` 또는 `unified-status` 비정상 | `[billing] ⚠️ ALARM — service_tier=usage-based ...` |
| OAuth refresh 실패 | `[oauth] ⚠️ refresh failed: 400 {...}` |
| 5xx 응답 (`upstream_failed`, `config_error`, unhandled) | `[5xx] upstream_failed: ...` |

Webhook 만드는 법: Discord 서버 → **Settings** → **Integrations** → **Webhooks** → **New Webhook** → URL 복사.

### ⚠️ 운영 함정 (읽어두기)

→ **[`docs/operational-pitfalls.md`](docs/operational-pitfalls.md)** — 10가지 자주 빠지는 함정 + 알람 받았을 때 의사결정 흐름.

가장 큰 하나: **본인 머신에서 `claude /logout`을 하면 EC2 `.env`의 OAuth 토큰도 같이 죽음** (server-side revoke). 운영 토큰을 회전하고 싶으면 별도 절차 (#1 참고).

### 헬스체크

```bash
curl https://your-domain/healthz
docker compose ps             # STATUS healthy 확인
docker inspect claude-for-you --format '{{.State.Health.Status}}'
```

### 토큰 영속

`tokens` named volume에 atomic write로 저장됩니다 (`/data/tokens.json`, 0600).

```bash
docker volume inspect claude-for-you_tokens
# 내용 직접 확인 (민감 — 외부 노출 금지):
docker run --rm -v claude-for-you_tokens:/d alpine cat /d/tokens.json
```

### 로그

```bash
docker compose logs -f app          # 앱 로그
docker compose logs -f caddy        # HTTPS / 액세스 로그
```

### 업그레이드

```bash
git pull
docker compose up -d --build
```

### Canary 배포 (snapshot A/B, Phase 28)

새 `cc-snapshot.json`을 prod 전체에 즉시 적용하기 전에 일부 트래픽으로 검증:

```bash
# 1) cron-capture가 만든 새 snapshot을 candidate로 저장
mv src/template/cc-snapshot.json.new src/template/cc-snapshot.candidate.json
git add src/template/cc-snapshot.candidate.json
git commit -m "chore(canary): candidate snapshot from $(date -u +%F)"
git push

# 2) EC2: CANARY_PERCENT=5 (.env 갱신) 후 재배포
ssh ... 'cd claude-for-you && git pull && sed -i "s/^CANARY_PERCENT=.*/CANARY_PERCENT=5/" .env && docker compose up -d'

# 3) 며칠 모니터링 (어드민 대시보드의 canary 섹션)
#    candidate 측에서 service_tier != standard 발견 시 자동 trip + Discord 알람
#    tripped 후에는 모든 트래픽이 stable로 fallback

# 4-a) Promote (candidate가 안전하다 확인됨)
mv src/template/cc-snapshot.candidate.json src/template/cc-snapshot.json
sed -i 's/^CANARY_PERCENT=.*/CANARY_PERCENT=0/' .env
git commit -am "chore(canary): promote candidate"
git push

# 4-b) Rollback (candidate가 문제)
rm src/template/cc-snapshot.candidate.json
git commit -am "chore(canary): rollback"
git push
```

⚠️ **자동 promote 없음** — canary가 일정 시간 잘 돌았다고 우리가 자동으로 main으로 올리지 않습니다. 분류기 평가는 며칠 단위 cumulative이고, 사람이 어드민 보고 promote 결정.

### 자동 cron capture (Phase 25)

본인 머신에서 CC가 정상 작동 중이라면, 매주 자동으로 `cc-snapshot.json`을 새로 capture해서 drift를 추적할 수 있어요. 본인 머신에 cron 등록:

```bash
crontab -e
# 매주 월요일 오전 9시
0 9 * * 1 /Users/you/path/to/claude-for-you/scripts/cron-capture.sh >> /tmp/cfy-capture.log 2>&1
```

스크립트는:
1. git pull → 최신 snapshot으로 diff base 갱신
2. CAPTURE_MODE proxy를 임시 포트에 띄움
3. 격리 HOME으로 CC 짧은 시나리오 5개 실행 (capture 누적)
4. synthesize-snapshot 실행
5. diff 있으면 working tree에 둠 — **운영자가 직접 review 후 PR**

⚠️ **자동 push는 일부러 안 함** — 잘못된 snapshot이 prod로 가면 모든 트래픽 service_tier가 깨질 수 있어요. cron은 drift **감지**만, merge는 사람 손.

`CFY_AUTO_BRANCH=true`로 설정하면 자동으로 `capture/YYYY-MM-DD` 브랜치까지 만듭니다.

### Snapshot 갱신 (Claude Code 업데이트 추적)

CC 새 버전이 나오면 wire shape이 바뀔 수 있어요. **본인 로컬 머신**에서 (EC2가 아닌):

```bash
# 1) 본인 머신의 CC 업데이트 후
brew upgrade --cask claude-code   # 또는 npm i -g @anthropic-ai/claude-code

# 2) 추출 + diff 검토 (write 안 함)
npm run extract-template:check       # exit 0이면 변경 없음, exit 1이면 drift

# 3) 실제 갱신 (cc-snapshot.json 덮어씀)
npm run extract-template

# 4) 새 anthropic-beta가 추가됐다면 검토 후 src/template/extracted.ts의
#    SAFE_MESSAGES_BETAS 화이트리스트에 등록할지 결정 (body 요구사항 검증 필수)

# 5) commit + push + EC2 deploy
git diff src/template/cc-snapshot.json
git add src/template/cc-snapshot.json && git commit -m "chore: refresh CC snapshot for vX.Y.Z"
git push
# EC2에서:  git pull && docker compose up -d --build
```

운영 자동화 팁: GitHub Actions에 `npm run extract-template:check`를 주기 cron으로 걸어서 drift 알림. 자동 갱신은 권장 X (새 flag의 body 요구사항을 사람이 검토해야 안전).

### 백업

토큰 볼륨만 백업하면 됩니다 (코드는 git에 있음):

```bash
docker run --rm -v claude-for-you_tokens:/d -v $PWD:/b alpine \
  tar czf /b/tokens-backup-$(date +%F).tar.gz -C /d .
```

---

## 보안 체크리스트

- [ ] 도메인을 HTTPS로만 노출 (Caddy가 자동 처리). HTTP 직노출 금지.
- [ ] API 키는 32자 이상 무작위 (`openssl rand -hex 32`).
- [ ] `.env` 권한 `0600`. git에 절대 커밋 금지.
- [ ] API 키 공유는 1:1 비밀 채널로만 (1Password 등). Slack/이메일 평문 금지.
- [ ] 사용자 이탈 시 즉시 키 제거 + `docker compose up -d` 재기동.
- [ ] EC2 보안 그룹 SSH는 본인 IP만.
- [ ] `tokens.json`은 OAuth refresh token이 들어있는 **민감 파일**입니다. 백업 보관 시 암호화.
- [ ] CI 로그/스택트레이스에 토큰이 새지 않는지 정기 확인 (`src/lib/redact.ts`가 1차 방어).

---

## 알려진 한계

- **C-partial wire fidelity** — TLS ClientHello / body key 순서 / timing은 잡지 않습니다. Anthropic 분류기가 이들을 본다면 종량제로 빠뜨릴 위험이 있어요. 첫 며칠 청구 형태 모니터링 필수.
- **CC와 SDK 외 도구** — Cline / Cursor 등의 비-CC 도구는 자체 wire shape를 보내는데, 우리는 body를 재구성하지 않으므로 그 도구가 보내는 형태가 그대로 forward됩니다. 비-CC 도구의 tool name normalize는 별도 layer로 분리되어 있지 않습니다.
- **단일 OAuth 계정** — pool 모드 없음. 구독 rate limit에 도달하면 모두 같이 막힙니다.
- **인메모리 quota** — `DAILY_TOKEN_LIMIT_PER_KEY`는 컨테이너 재시작 시 리셋됩니다. 진짜 영속이 필요해지면 SQLite로 진화 필요.
- **OAuth 로그인 플로우 없음** — Claude Code 자격증명을 빌려와야 합니다.
- **snapshot은 추출 머신 종속** — `extract-cc-template`는 CC가 설치된 머신에서만 가능. EC2에서 직접 추출 불가. 본인 머신에서 추출 → git commit → EC2 pull 흐름.

---

## 디렉토리 구조

```
src/
├── server.ts              # Hono 진입점, 부트스트랩
├── config.ts              # 환경변수 로딩 + 검증
├── auth/
│   ├── api-key.ts         # 신뢰 사용자 인증 (timing-safe)
│   └── oauth.ts           # Claude.ai OAuth refresh + 파일 영속화
├── proxy/
│   ├── messages.ts        # /v1/messages 핸들러
│   └── upstream.ts        # api.anthropic.com 호출 + 401 재시도
├── template/
│   ├── types.ts           # ClaudeTemplate 인터페이스 (B→C 추상화 경계)
│   ├── static.ts          # B 정책: 정적 헤더 스냅샷 (백업/대조용)
│   ├── extracted.ts       # C-full 정책: snapshot v2 + body rebuild + client merge
│   └── cc-snapshot.json   # synthesize-snapshot 결과물 (커밋됨)
├── admin/
│   ├── stats.ts           # GET /admin/stats — JSON 자동화용
│   └── page.ts            # GET /admin — HTML 대시보드 (basic auth)
├── account-learner.ts     # anthropic-organization-id learning → metadata.user_id 주입
├── alerts.ts              # Discord/Slack sink + cooldown
├── capture.ts             # CAPTURE_MODE 미들웨어 — wire-order 보존 dump
└── pacing.ts              # session-단위 minimum gap (옵션)

scripts/
├── extract-cc-template.mjs    # CC binary → anthropic-beta + CC 메타데이터
└── synthesize-snapshot.mjs    # captures/*.json → cc-snapshot.json v2

terraform/                # EC2 + EIP + SG (+ 옵션 Route53)
docs/cc-wire-reference.md # content-level wire 분석 (Phase 17 captures 기반)
├── usage/
│   ├── sniff.ts           # TransformStream으로 응답 청크에서 usage 추출
│   ├── per-user.ts        # 사용자별 일일 한도
│   └── global.ts          # 구독 전체 잔여 헤더 기반 가드
└── lib/
    ├── errors.ts          # 도메인 에러 → HTTP 상태 매핑
    └── redact.ts          # 로그 직전 토큰 마스킹
```

---

## 라이선스

MIT. 코드 자체는 자유롭게 fork/수정 가능. **단, Anthropic 약관 준수 책임은 사용자 본인에게 있습니다.**

---

## 면책

이 프로젝트는 Anthropic과 무관한 **독립·비공식·서드파티 도구**입니다. Anthropic, Claude, Claude.ai 상표는 각 소유자에게 귀속됩니다. 본 도구의 사용으로 발생하는 어떤 형태의 손해(계정 정지, 환불 거부, 데이터 손실, 법적 분쟁 등)에 대해서도 운영자/기여자는 책임지지 않습니다.
