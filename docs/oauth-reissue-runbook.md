# OAuth Refresh Token 재발급 Runbook

프록시의 OAuth **refresh token이 죽었을 때** 재배포 없이 되살리는 절차. auto-refresh는 만료를 미룰 뿐 없애지 못한다 — refresh token chain은 아래 넷 중 하나로 **언젠가 반드시** 죽으므로([`operational-pitfalls.md`](./operational-pitfalls.md) #1 · #10 · #11), 이 문서는 그때 매번 헤매지 않기 위한 단계표다.

> **핵심 구분 (먼저 읽을 것)**
> `.env`/SSM의 `ANTHROPIC_OAUTH_EXPIRES_AT`는 **access token** 만료시각이다. 프록시가 refresh token으로 자동 재발급하므로(`src/auth/oauth.ts` — 만료 5분 전 refresh) **이 값이 과거여도 정상이고 손댈 필요 없다.**
> 재발급이 필요한 유일한 신호는 **refresh token 자체의 사망** = `502 oauth refresh failed / invalid_grant`. EXPIRES_AT 숫자로는 판단하지 말 것.

---

## 언제 이 문서를 쓰나

다음 중 하나라도 참일 때만:

- prod `/v1/messages` 응답이 `502` + 본문에 `invalid_grant` / `oauth refresh failed`
- `/admin/test/oauth-probe`가 `ok:false`
- EC2 앱 로그에 `oauth refresh failed:` (`src/auth/oauth.ts:109`) 반복
- 계기가 짚임: 본인 `claude /logout`(#1), Anthropic 자동 revoke(#10), 로컬↔프록시 rotation 충돌(#11)

`/healthz` 200은 **앱 생존만** 증명하며 OAuth 상태와 무관하다. 반드시 아래 진단을 거칠 것.

---

## 1단계 — 30초 진단 (재발급 필요 여부 확정)

`/admin/test/oauth-probe`는 지정 멤버에 **forceRefresh를 직접 실행**한다(`src/admin/test-runners.ts`). refresh token 유효성만 순수하게 본다 — TLS fingerprint gate(sonnet/opus 429)나 API 키 불일치(401)에 오염되지 않는다.

**방법 A — `/admin` 웹 UI (권장):** 브라우저로 `/admin` 접속(admin 자격 프롬프트) → OAuth probe 버튼 실행.

**방법 B — curl (스크립트):** admin 역할 API 키(env `API_KEYS`에 baked된 키만 `role=admin`)로 호출. 비브라우저 요청이라 CSRF 가드는 자동 통과(`src/admin/csrf.ts` layer 4).

```bash
# ADMIN_KEY = API_KEYS 중 admin 역할 키. MEMBER = 단일모드 "default", 풀모드는 계정명.
curl -sS -X POST "https://<PROXY_HOST>/admin/test/oauth-probe" \
  -H "x-api-key: $ADMIN_KEY" \
  -H "content-type: application/json" \
  -d '{"memberName":"default"}'
```

**해석:**

| 결과 | 의미 | 조치 |
|---|---|---|
| `ok:true` (`refreshed · …suffix`) | refresh token 정상 | **재발급 불필요. 종료.** EXPIRES_AT가 과거였어도 정상이다. |
| `ok:false` + `invalid_grant` | refresh token 사망 | 2단계로. |
| `ok:false` + timeout/네트워크 | 업스트림/네트워크 문제 | 토큰 문제 아님. 인프라부터 확인. |

풀 모드(`/data/accounts.json` 존재)면 **멤버별로** probe해서 어느 계정이 죽었는지 특정한다.

---

## 2단계 — ⚠️ 재발급 전에: #11 rotation 충돌부터 차단

**이 단계를 건너뛰면 재발급이 곧바로 다시 죽는다.** Anthropic OAuth는 refresh token rotation을 **single-holder**로 강제한다. 같은 chain을 두 곳(프록시 + 본인 로컬 Keychain)이 쥐면, 한쪽 refresh → 다른 쪽 stale → 서버가 탈취로 간주 → chain 통째 revoke(#11).

본인 머신 Keychain 상태 확인:

```bash
security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1 \
  && echo "OAuth present — #11 위험. 아래 분기 확인" \
  || echo "OAuth absent — 권장 셋업. 안전하게 진행"
```

**분기:**

- **프록시가 전용(dummy) 계정을 쓰는 경우 (권장 상태):** 본인 개인 계정과 무관하므로 그대로 3단계 진행. 재발급은 그 전용 계정에서만 한다.
- **프록시가 본인 개인 계정을 쓰는 경우 (위험 상태):** 재발급해도 로컬 CC가 같은 chain을 계속 회전시켜 재충돌한다. 근본 해결 = 로컬을 **gateway 모델로 강등**([`user-guide.md`](./user-guide.md) 권장 설정: Keychain OAuth 제거 → 로컬은 프록시 API 키만 사용). 강등이 지금 당장 불가하면, 최소한 재발급에 쓸 **전용 계정을 새로 만들어** 프록시에만 물리고 본인 개인 chain과 분리할 것.

> `claude /logout`은 절대 금지 — server-side revoke라 같은 토큰을 어디 박아뒀든 즉사시킨다(#1).

---

## 3단계 — 새 자격 획득 → 프록시에 주입 (재배포 없음)

### 3-1. 새 refresh token 확보

재발급 대상 계정(전용 계정 권장)으로 로그인 후 Keychain에서 추출:

```bash
claude login    # 해당 계정
security find-generic-password -w -s "Claude Code-credentials" | python3 -m json.tool
```

출력에서 `refreshToken`(`sk-ant-ort01-…`)을 확보. access token/expiresAt은 넣지 않아도 된다 — 비우면 첫 요청에서 강제 refresh된다.

### 3-2. `/admin/oauth/replace`로 즉시 교체

`tokens` 볼륨(`/data`)의 token store에 바로 써서 **SSH·재배포 없이** 다음 요청부터 적용된다. `docker compose restart`와 정상 배포에도 살아남는다(볼륨 유실 #4 때만 소실 → 4단계로 보완).

**웹 UI:** `/admin` → OAuth replace 폼에 refresh token 붙여넣기.

**curl:**

```bash
curl -sS -X POST "https://<PROXY_HOST>/admin/oauth/replace" \
  -H "x-api-key: $ADMIN_KEY" \
  -H "content-type: application/json" \
  -d '{"memberName":"default","refreshToken":"sk-ant-ort01-..."}'
```

검증 규칙(`src/admin/oauth.ts`): `refreshToken`은 `sk-ant-ort01-`로 시작·32자 이상. accessToken을 넣는다면 `sk-ant-oat01-` 필수. `expiresAt` 생략 시 0 = 즉시 refresh 유도.

### 3-3. 재확인

1단계 probe를 다시 실행 → `ok:true` 나오면 프록시 측 복구 완료.

---

## 4단계 — 내구성: SSM 동기화 (볼륨 유실·신규 인스턴스 대비)

3단계는 `tokens` 볼륨에만 쓴다. 볼륨이 날아가거나(#4) 새 인스턴스가 뜨면 프록시는 **SSM `/claude-for-you/env`의 값으로 폴백**하므로, 거기가 옛 죽은 토큰이면 다시 죽는다. 그래서 SSM의 OAuth 필드도 새 값으로 맞춰둔다.

> ⚠️ **`scripts/deploy.sh`로 하지 말 것.** deploy.sh는 로컬 워킹카피 `.env`를 통째로 SSM에 업로드하는데, 이 `.env`는 보통 smoke-test **더미**다(더미면 prod 사망). SSM 파라미터의 OAuth 필드만 표적 갱신할 것.

절차: SSM 파라미터를 받아 → OAuth 3필드(`ANTHROPIC_OAUTH_REFRESH_TOKEN`, 선택적으로 `ANTHROPIC_OAUTH_ACCESS_TOKEN`/`ANTHROPIC_OAUTH_EXPIRES_AT`)만 새 값으로 치환 → 다시 put. (시크릿 전체를 다루므로 운영자가 직접 실행.)

```bash
REGION=ap-northeast-2; PARAM=/claude-for-you/env
# 받아서 → 편집 → 되올리기. 편집 시 refreshToken만 새 값으로 교체.
aws ssm get-parameter --name "$PARAM" --with-decryption --region "$REGION" \
  --query Parameter.Value --output text > /tmp/prod.env   # 편집 후:
aws ssm put-parameter --name "$PARAM" --type SecureString --overwrite \
  --region "$REGION" --value "$(cat /tmp/prod.env)"
rm -f /tmp/prod.env    # 시크릿 즉시 삭제
```

풀 모드면 SSM `.env`가 아니라 `/data/accounts.json`이 소스이므로, 그쪽 해당 계정 항목의 `refreshToken`을 갱신한다.

---

## 왜 이 구조인가

- **probe로 진단 먼저**: EXPIRES_AT/`/healthz`는 refresh token 사망을 판별 못 한다. forceRefresh만이 chain 유효성을 직접 친다.
- **replace로 즉시 교체**: SSH+`.env`편집+`restart`(과거 #1 복구법)보다 짧고, 볼륨 지속성으로 재배포에도 남는다.
- **#11 차단을 재발급의 전제로**: 이 단계를 앞에 두지 않으면 재발급이 곧 재사망한다. 반복 고통의 근원은 토큰이 아니라 **두 holder** 구조다.
- **SSM은 안전망**: 상시 소스가 아니라 볼륨 유실·신규 인스턴스 폴백용. 그래서 4단계는 표적 갱신이며 deploy.sh 경로를 피한다.

## 근본 예방 (반복을 줄이려면)

- **로컬 gateway 강등** — 본인 로컬 = OAuth 없는(프록시 키만) 클라이언트. 프록시 OAuth = 전용 계정으로 프록시만 보유 → #11 원천 차단.
- **멀티계정 풀(`ACCOUNTS_PATH`)** — 한 계정 chain이 죽어도 나머지가 서빙, rotation 부하 분산. 재발급이 prod 전면 중단이 아니게 된다.

## 관련 함정

[`operational-pitfalls.md`](./operational-pitfalls.md): #1(`/logout` server-side revoke) · #4(볼륨 유실) · #10(refresh TTL·자동 revoke) · #11(rotation 충돌).

---

## 부록 A — `/admin` 접근 불가 시: 볼륨 `tokens.json` 직접 주입 (실전 검증됨, 2026-07-27)

`/admin/oauth/replace`가 admin 키 인증에 실패하면(예: **SSM `API_KEYS` ≠ 실행 컨테이너 `API_KEYS` 드리프트** — 아래 부록 C) `/admin` 경로 전체가 막힌다. 이때는 SSM Run Command로 `tokens` 볼륨의 `tokens.json`을 직접 갈아끼운다.

핵심 함정 — **`selectInitial` (`src/auth/oauth.ts`)**: boot 시 env state와 file state 중 **`expiresAt`가 더 큰 쪽**을 채택한다. env의 만료 토큰이 큰 `expiresAt`를 가지면 새 파일을 덮어써버린다. 그래서 주입 파일은:

```json
{"accessToken":"","refreshToken":"<sk-ant-ort01-...>","expiresAt":253402300799000}
```

- `expiresAt` = 먼 미래(예: 253402300799000) → 항상 file이 env를 이김
- `accessToken` = 빈값 → 첫 호출에서 강제 refresh 유도(`ensureFresh`가 accessToken 비면 refresh)
- 첫 refresh 성공 시 `writeAtomic`이 실제 access token + 실제 `expiresAt`로 덮어씀 → 그때 `expiresAt`가 253402…가 아닌 실제 미래값이면 복구 성공 신호

**절차 (RT를 명령 로그에 안 남기려 SecureString 릴레이):**

1. RT를 SecureString에 넣기(암호화·CloudTrail redact):
   ```bash
   aws ssm put-parameter --name /claude-for-you/tmp-newrt --type SecureString \
     --overwrite --region ap-northeast-2 --value '<sk-ant-ort01-...>'
   ```
2. 원격 주입 스크립트 (인스턴스가 SecureString에서 RT를 직접 가져옴 → send-command params에 secret 없음):
   ```sh
   NEWRT=$(aws ssm get-parameter --name /claude-for-you/tmp-newrt --with-decryption \
     --region ap-northeast-2 --query Parameter.Value --output text)
   case "$NEWRT" in sk-ant-ort01-*) : ;; *) echo BAD_OR_MISSING_RT; exit 1;; esac
   D=/var/lib/docker/volumes/claude-for-you_tokens/_data
   printf '{"accessToken":"","refreshToken":"%s","expiresAt":253402300799000}' "$NEWRT" > "$D/tokens.json"
   chown 10001:10001 "$D/tokens.json"; chmod 600 "$D/tokens.json"   # 컨테이너 uid=10001
   cd /home/ec2-user/claude-for-you && docker compose restart app
   ```
   중첩 따옴표 회피: 로컬에서 위 스크립트를 파일로 저장 → `base64 < file` → `send-command --parameters '{"commands":["echo <b64> | base64 -d | bash"]}'`. (긴 base64를 손으로 붙여넣지 말고 항상 `base64 < file`로 생성 — 붙여넣기 손상 잦음.)
3. 재시작 필수 — oauth manager는 boot 시에만 파일을 읽는다(`createOAuthManager`). 런타임 파일 변경은 restart 전까지 무효.
4. 검증: `docker compose logs --since 5m app | grep -ic 'oauth refresh failed'` = 0 + `tokens.json`의 `expiresAt`가 실제 미래값으로 갱신.
5. 정리: `aws ssm delete-parameter --name /claude-for-you/tmp-newrt`.

원격 경로 확정값(`scripts/deploy.sh` 기준): 작업 디렉토리 `/home/ec2-user/claude-for-you`, compose 서비스명 `app`, 볼륨 `claude-for-you_tokens` → `/var/lib/docker/volumes/claude-for-you_tokens/_data`, 컨테이너 uid `10001`.

## 부록 B — refresh token 확보: `claude login` 주의 (실전 검증됨)

프록시는 **`sk-ant-ort01-` refresh token**이 필수다(`grant_type=refresh_token`). 그런데 자격증명 획득 시 함정:

- **`claude setup-token` = access-only(`sk-ant-oat01-`, 장기) → refresh token 없음.** 프록시에 못 쓴다.
- **`claude login`이라도 브라우저 authorize를 끝까지 완료하지 않으면** keychain이 갱신되지 않거나 `refreshToken`이 빈 문자열로 남는다. `CLAUDE_CONFIG_DIR` 격리 로그인은 keychain을 안 건드릴 수 있어 신뢰 어려움 — **평범한 `claude login`을 완결**하는 게 가장 확실했다.
- 획득 후 **반드시 검증** (accessToken이 아니라 refreshToken을, 그것도 `sk-ant-ort01-` prefix + 미래 `expiresAt`인지):
  ```python
  # keychain JSON은 {"claudeAiOauth":{"accessToken","refreshToken","expiresAt","subscriptionType",...}}
  # refreshToken은 claudeAiOauth 안에 중첩. oat01(access)을 refreshToken으로 오인복사하는 실수 잦음.
  ```
  `security find-generic-password -w -s "Claude Code-credentials"` → `claudeAiOauth.refreshToken`이 `sk-ant-ort01-`로 시작하는지 확인.

> 로컬이 이미 gateway(프록시 키)로 돌면 `claude login`은 BASE_URL(settings.json `env`)을 안 타는 것으로 보였다(정상 로그인됨). 단 settings.json `env`는 shell env를 이기므로 `ANTHROPIC_BASE_URL=... claude login` 오버라이드는 안 먹는다.

## 부록 C — 확인된 미해결: SSM `API_KEYS` 드리프트

2026-07-27 복구 중 발견: SSM `/claude-for-you/env`의 `API_KEYS` 첫 키가 실행 컨테이너 인증에 `401`. 즉 **SSM ≠ 실행 컨테이너 env**. 영향:
- `/admin/*` 전체 접근 불가(그래서 부록 A 경로로 우회함)
- **이 상태로 `deploy.sh` 돌리면** SSM 내용이 prod로 덮여 깨질 수 있음(로컬 더미 `.env` 지뢰와 같은 계열)

→ 별도 이슈로 SSM ↔ 실행 컨테이너 `API_KEYS` 정합화 필요(배포 안전 전제).
