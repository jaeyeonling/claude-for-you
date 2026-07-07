# Operational Pitfalls

운영하면서 실제로 발견했거나 예측 가능한 함정들. 새 함정 발견 시 여기 추가.

---

## 1. `claude /logout`은 server-side OAuth revoke ⚠️ (가장 큰 함정)

**증상**: 본인 머신에서 `claude /logout`을 실행하면, 우리 EC2 `.env`에 박혀있는 같은 refresh token도 동시에 무효화됨. EC2의 모든 `/v1/messages` 호출이 502 `invalid_grant`로 깨짐.

**원인**: Claude.ai OAuth의 logout은 client-side 캐시 삭제가 아니라 **server-side revoke API 호출**. 같은 토큰이 어디 박혀있든 한 번에 죽음.

**복구**:

1. 본인 머신에서 `claude login` 재수행
2. Keychain에서 새 자격증명 추출:
   ```bash
   security find-generic-password -w -s "Claude Code-credentials" | python3 -m json.tool
   ```
3. SSH로 EC2 `.env` 갱신 (`ANTHROPIC_OAUTH_REFRESH_TOKEN`, `ANTHROPIC_OAUTH_ACCESS_TOKEN`, `ANTHROPIC_OAUTH_EXPIRES_AT`)
4. `docker compose restart app`

**예방**: **본인 머신에서 절대 `claude /logout` 금지**. 운영 토큰을 회전하고 싶으면 별도 dummy 계정 만들고 그쪽으로 회전. multi-account pool로 운영하면 한 계정 logout해도 나머지로 흡수 가능.

---

## 2. 본인 머신 CC로 우리 프록시 검증 불가

**증상**: `ANTHROPIC_BASE_URL=https://our-domain ANTHROPIC_API_KEY=xxx claude` 실행 시 CC가 "Auth conflict: Both a token (claude.ai) and an API key" 경고하며 무한 retry.

**원인**: 본인 머신 Keychain에 OAuth 토큰이 있으면 CC가 그걸 우선 사용. `ANTHROPIC_API_KEY` env가 있어도 우리 프록시로 안 감.

**해결** (위에서부터 권장):

- **본인 머신을 영구적으로 프록시 클라이언트로 전환** — [`docs/user-guide.md`](./user-guide.md)의 **권장 설정**(Keychain 정리 → 프록시 키를 별도 Keychain 항목으로 → `apiKeyHelper` 절대경로). 본인이 운영자 겸 사용자라면 이게 정답. 함정 #11 참고.
- 본인 OAuth를 유지해야 하면 **별도 머신 / VM / 다른 user account**에서 검증.
- 1회성 검증만 필요하면 임시 HOME 격리:
  ```bash
  TMPHOME=$(mktemp -d -t cc-test-XXXX)
  HOME="$TMPHOME" ANTHROPIC_BASE_URL=https://our-domain ANTHROPIC_API_KEY=xxx claude
  rm -rf "$TMPHOME"
  ```
- 가장 빠른 1회성 검증은 curl/SDK 직호출 (CC 자체 사용 X).

**원칙**: 본인이 운영자이면서 동시에 사용자라면 — 본인 머신도 "다른 사람의 머신"과 같은 셋업(권장 설정)을 따라야 한다. 그게 본인 OAuth를 풀에서 분리하고 충돌 위험을 0으로 만드는 유일한 방법.

---

## 3. `docker compose down -v` 절대 금지

**증상**: 볼륨까지 같이 지워지면서 `tokens` 볼륨의 `/data/{tokens.json, accounts.json, usage.sqlite, api-keys.json}` 영구 손실.

**원인**: `-v` 플래그가 named volume까지 삭제.

**복구**:

- tokens.json: env로 다시 채우기 (OAuth env 또는 `accounts.json` 재배치)
- usage.sqlite: 못 복구 (quota 카운트 0부터 다시)
- api-keys.json: 못 복구 (자체 발급한 키 다 무효 — env 키만 살아남음)

**예방**: 평상시 `docker compose down` 사용 (볼륨 유지). 진짜로 정리하고 싶을 때만 `-v`. 백업 먼저:

```bash
docker run --rm -v claude-for-you_tokens:/d -v $PWD:/b alpine \
  tar czf /b/data-backup-$(date +%F).tar.gz -C /d .
```

---

## 4. Caddy HTTPS 인증서 발급 실패 — 80번 포트

**증상**: 첫 부팅 시 Caddy 로그에 "ACME challenge failed" / 인증서 없이 HTTP만 응답.

**원인**: Let's Encrypt `http-01` 챌린지는 외부에서 80번 포트에 도달해야 함. EC2 보안 그룹이 80을 닫아두거나, DNS A 레코드가 아직 전파 안 됨.

**복구**:

1. EC2 보안 그룹에서 80, 443 모두 `0.0.0.0/0` 인바운드
2. `dig your-domain.com` → EC2 public IP 확인
3. DNS 전파 대기 (5~30분)
4. `docker compose restart caddy` (Caddy가 재시도)

---

## 5. UTC 자정 = 한국 오전 9시

**증상**: 사용자가 "어제 다 쓴 quota인데 왜 막혀있냐"고 컴플레인. 시계는 9시인데 quota는 살아있음.

**원인**: 우리 daily quota는 **UTC** 자정 기준 리셋. KST 기준 오전 9시.

**예방**: README에 명시 (이미 적혀있음). 신뢰 소수에게 안내. 또는 향후 `QUOTA_TIMEZONE` env로 분리.

---

## 6. CANARY_PERCENT 너무 높게

**증상**: 새 candidate snapshot이 service_tier를 깨면 `CANARY_PERCENT%`만큼의 트래픽이 종량제로 청구.

**예방**:

- 처음에는 5% (default 권장)
- 며칠 모니터링 후 점진 증가 (10% → 30% → 100%)
- 또는 candidate 통과 확인되면 그냥 promote (`docker compose restart` 안에서 100% 전환)

**자동 안전망**: 우리 코드가 candidate-side에서 service_tier!=standard 발견 즉시 canary trip (전 트래픽 stable로 fallback). 그래도 trip 전에 받은 일부 요청은 이미 종량제로 갈 수 있음.

---

## 7. `bun.lock` 누락 시 빌드 깨짐

**증상**: 다른 머신/EC2에서 `bun install --frozen-lockfile` 실패.

**원인**: `bun.lock` 파일을 git에 commit 안 함 (`.gitignore` 실수).

**예방**: `.gitignore`에 `bun.lock`이 들어가있는지 가끔 확인. `git status`에서 항상 tracked여야 함.

---

## 8. snapshot stale → CC 신기능 깨짐

**증상**: CC 업데이트 후 클라이언트에서 "context_management: Extra inputs are not permitted" 같은 400. 우리 어드민에서 service_tier는 standard지만 client 직접 호출에서 깨짐.

**원인**: CC가 새 body 필드(예: `cache_diagnosis`)를 보내고 그에 대응하는 anthropic-beta가 우리 snapshot에 없음.

**복구**:

1. 본인 머신에서 `bun scripts/cron-capture.sh` 실행 (또는 weekly cron)
2. 생성된 snapshot diff 검토
3. `cc-snapshot.candidate.json`으로 두고 canary 5%로 검증
4. 안전하면 promote

**예방**: 주간 cron 등록. snapshot 60일 이상 stale 시 부팅 로그에 자동 경고.

---

## 9. `.env` 파일의 OAuth 토큰을 git에 commit

**증상**: `git log -p`에 sk-ant-oat01-... / sk-ant-ort01-... 같은 토큰 노출.

**예방**:

- `.gitignore`에 `.env`, `.env.bak`, `.env.*.local` 포함 확인
- `git status`에서 `.env`가 untracked X (ignored)
- 실수로 commit했으면 즉시:
  ```bash
  git reset HEAD~1  # 그 commit 취소 (push 전이라면)
  # 이미 push된 후라면 GitHub에서 토큰 즉시 회전 + git history rewrite
  ```
- **Anthropic이 자동 revoke**: GitHub에 공개된 OAuth 토큰을 자동 감지해서 무효화. 단점: 우리 EC2도 죽음.

---

## 10. `claude /logout`이 만든 변종 — Anthropic이 자체적으로 토큰 revoke

**증상**: 본인 행위와 무관하게 어느 날 502 `invalid_grant`. logout한 적 없는데.

**원인 후보**:

- 보안 이벤트 (Anthropic 측에서 의심 활동 감지)
- TOS 위반 의심
- Anthropic 정책 변경
- Refresh token TTL 만료 (장기간 사용 후)

**복구**: 위 #1과 동일 (재로그인 + 토큰 추출 + .env 갱신).

**예방**: 다중 계정 풀(`ACCOUNTS_PATH`)로 운영 — 한 계정 revoke되어도 다른 계정으로 fallback. Discord 알람이 즉시 알려줌.

---

## 11. 운영자 본인이 같은 OAuth로 프록시도 굴리고 로컬에서도 쓰는 경우 — RT rotation 충돌

**증상**: 본인 머신에서 `Please run /login`이 반복적으로 뜸. `/logout` 한 적 없고 (함정 #1 아님), Anthropic 측 자동 revoke도 아님(함정 #10 아님). 프록시 서버 로그에는 `oauth refresh failed:` (`src/auth/oauth.ts:109`)가 간헐적으로 찍힘.

**원인**: Anthropic OAuth는 refresh token rotation을 **single-holder**로 강제. 본인이 같은 RT를 EC2 프록시와 로컬 머신 **두 곳에** 갖고 있으면 한쪽이 refresh → 새 RT 발급 → 다른 쪽의 RT는 stale → 다음 호출이 stale RT 사용 → server가 stale RT 재사용을 탈취 시도로 간주하고 chain 통째로 revoke → 양쪽 다 401.

함정 #1·#10과 다른 점: 본인의 명시적 행위가 없는데 일어남. **공존 자체가 원인**.

**자가 진단 체크리스트** (위에서부터 검사):

- [ ] 최근 본인 머신에서 `claude /logout` 한 적 있는가? → **있으면 #1** (이 함정 아님)
- [ ] 본인 머신 keychain에 OAuth 항목이 살아 있는가?
  ```bash
  security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1 \
    && echo "OAuth present (suspect #11)" \
    || echo "OAuth absent (likely not #11)"
  ```
- [ ] 본인 머신의 `~/.claude/settings.json`이 `apiKeyHelper`로 프록시 키를 가리키는 상태인가?
  ```bash
  grep -E "apiKeyHelper|ANTHROPIC_BASE_URL" ~/.claude/settings.json 2>/dev/null
  ```

OAuth가 살아 있으면서 `apiKeyHelper`/`ANTHROPIC_BASE_URL`도 프록시를 가리키는 상태 = #11 시나리오. 본인이 두 holder 역할을 동시에 하고 있는 것.

**복구**:

1. EC2 프록시 로그에서 사고 규모 확인:
   ```bash
   # on the proxy host
   docker compose logs --since 24h app | grep -i "oauth refresh failed"
   ```
2. 본인 머신을 [`docs/user-guide.md`](./user-guide.md)의 **권장 설정**으로 전환 (Keychain OAuth 제거 → 프록시 키만 사용)
3. 함정 #1의 복구 절차로 프록시 측 OAuth 재발급 (`security find-generic-password` → `.env` 갱신 → `docker compose restart app`)

**예방**: 본인 로컬 = **OAuth 없는 클라이언트**, 본인 OAuth = **프록시 account-pool에만 존재**. 그렇게 분리되면 같은 chain의 holder가 한 명이 되어 충돌 자체가 불가능. 1년 뒤 본인이 무의식적으로 `claude /login`을 누르는 사고를 막으려면 user-guide의 권장 설정을 본인 머신에 commit 수준으로 박아둘 것 (`~/.claude/settings.json` 백업 등).

**관련**: 함정 #1(`/logout` server-side revoke), 함정 #10(자동 revoke)과 같은 카테고리 — 모두 "같은 OAuth를 두 곳에 두면 안 됨"의 변종. #11은 그중 가장 빈번하지만 가장 안 보이는 사고.

---

## 12. 1M context는 OAuth로 정상 작동 — `?beta=true` URL이 핵심 (이전 진단 정정)

**상태**: `commit be2e4b4` (2026-05-29)에서 정정. 그 이전 4~5일 동안은 잘못된 진단으로 strip + size gate가 켜져있어 1M이 안 됐음.

**현재 동작**: 클라이언트가 `context-1m-2025-08-07` 베타와 함께 1M 요청을 보내면 프록시는 그대로 forward, 본사가 200으로 응답한다 (mitmproxy로 직접 확인: 385K 입력 토큰, `service_tier: standard`).

**필수 조건**:

- URL: `/v1/messages?beta=true` (이게 핵심 — beta-flag 게이트가 query param에 걸려있음)
- `anthropic-beta`에 `context-1m-2025-08-07` 포함
- 모델 field: 평문 (`claude-sonnet-4-6`, `claude-opus-4-7` 등) — CC의 `[1m]` suffix는 클라이언트 내부 용으로만 사용되고 wire에는 plain name으로 전송

### 과거 잘못된 진단 (역사 기록, 같은 함정 재발 방지용)

**잘못된 가설** (2026-05-28 ~ 2026-05-29): "OAuth 구독은 1M 엔타이틀먼트 없음. 본사가 토큰 종류 보고 결정론적 429 'Usage credits are required for long context requests' 반환." → strip + 1MB 사이즈 게이트 추가.

**실제 원인**: 우리 `src/template/extracted.ts:10`이 `/v1/messages` (no `?beta=true`)를 사용 중이었다. 200K 표준 트래픽은 query param 없이도 통과해서 운영 중에 안 보였는데, **beta 기능은 이 param이 게이트**라 본사가 거부했고 그 거부 메시지의 "Usage credits required" 표현이 entitlement 게이트처럼 보였을 뿐.

`static.ts:5`의 주석("`?beta=true` is required by upstream")이 정답을 가리키고 있었는데, "production이 그 URL 없이도 sonnet/opus 200K 트래픽 잘 처리하니까 주석이 outdated하다"고 잘못 기각.

**검증 절차** (운영자가 미래에 또 의심 들 때):

```bash
# 본인 머신에서 mitmproxy 캡쳐
mitmdump --listen-port 8765 --ssl-insecure -w /tmp/flow.bin &
HTTPS_PROXY=http://localhost:8765 NODE_EXTRA_CA_CERTS=~/.mitmproxy/mitmproxy-ca-cert.pem \
  claude --print --no-session-persistence --model "claude-sonnet-4-6[1m]" < big-prompt.txt
# Python으로 /v1/messages POST 파싱 → URL, anthropic-beta, body 크기, 응답 status 확인
# 우리 프록시 wire shape와 diff
```

**admin probe**: `upstream-direct`에 `betaQuery` 토글이 추가됐다 (commit `be2e4b4`). useTemplate=on이면 자동으로 `?beta=true`. 미래 동일 의심 들 때 어드민 UI에서 5분 안에 A/B 가능.

**메타 교훈**: 본사 응답 메시지("Usage credits required")의 문자 그대로 해석에 매달리지 말 것. **항상 real client(mitmproxy로 CC 캡쳐) wire shape와 우리 wire shape를 diff하는 게 ground truth**. 응답 메시지는 본사가 정확히 어디서 거부했는지 알려주지 않는다.

**관련**: [[project_cc-tls-fingerprint-gate]] (이전에도 같은 함정 — 본사 응답을 "권한 게이트"로 잘못 해석하다가 fingerprint 차이가 진짜 원인이었음). 그때 학습한 교훈을 이번에는 더 빨리 적용해야 했다.

---

## 13. `system` 본문이 CC 시그니처가 아니면 sonnet/opus 만 `rate_limit_error` — entitlement 검증의 마스킹된 시그니처 (2026-06-02 정정)

**상태**: 2026-06-02 패치. 그 이전에는 caller가 자체 system prompt (예: tomodachi 디스코드 봇 같은 워크로드)를 보내면 sonnet/opus는 즉시 429 `rate_limit_error`로 거절되고 haiku는 통과되는 시그니처가 운영 중에 발생했음.

**현재 동작**: `src/proxy/messages.ts`의 `ensureSystem`은 두 분기를 가진다:

1. **caller `system`이 canonical CC marker block (type+text+cache_control:ephemeral)을 array에 포함하면 transparent passthrough** — caller array를 shallow-copy하여 그대로 forwarding. 실제 CC client 트래픽이 이 경로로 흘러 prefix hash가 PRE PR41과 일치 (함정 #15 cost evidence 참조).
2. **그 외 경우 unconditional prepend** — caller가 보낸 string/array는 두 번째 이후 블록으로 보존. tomodachi-style 봇이나 canonical shape를 안 박는 SDK 클라이언트가 이 경로.

단 forge 차단 강도는 절대적이지 않다 — caller가 canonical shape를 정확히 모사하면 transparent 통과되며, 이는 wire-level에서 real CC와 byte-identical하다 (proxy emit vs caller emit 구별 불가). 본 동작은 *entitlement gate 통과용 wire-level identity 보장* 목적이며 *system injection 방어*는 아니다 — ToS 책임이 proxy → API key holder로 위임됨 (함정 #15 위협 모델 재정의 참조).

`verify-entitlement` probe는 `PING_BODY`에 `system: CC_SYSTEM_PREFIX` (string)을 사용하므로 transparent 분기 미진입 — 항상 unconditional prepend 경로를 탄다. probe `ok` verdict는 prepend 경로의 marker drift 검출 신호로만 해석.

**필수 조건**:

- `system` array 안 *어딘가에* **정확히** `"You are Claude Code, Anthropic's official CLI for Claude."` text + `cache_control: { type: 'ephemeral' }`를 가진 canonical block이 있어야 한다. 위치는 array 내 어디든 — real CC는 `system[1]`(billing header 다음)에 박고, `ensureSystem`이 prepend하는 경우는 `system[0]`. `isCanonicalCcMarker`가 anywhere-in-array로 매칭하므로 두 위치 모두 통과 (cc-wire-reference §2a "Position policy" 참조). Anthropic이 이 prefix를 한 글자라도 바꾸면 우리 가드가 무너지고 sonnet/opus가 다시 429로 떨어진다.
- proxy가 박는 헤더 (`user-agent: claude-cli/...`, `anthropic-beta: claude-code-...`) 는 `src/template/static.ts:34-65`에서 클라이언트 헤더 무관하게 자체적으로 박는다. system body만 변수.

### 과거 잘못된 진단 (역사 기록, 같은 함정 재발 방지용)

**잘못된 가설** (2026-05-27): "system 필드가 missing이면 sonnet/opus는 429. 그러니 `ensureSystem`이 system 없을 때만 minimal CC 시그니처 채워주면 됨." → binary (present/absent) 가드 작성. wire-level A/B도 binary로만 검증.

**실제 원인**: Anthropic의 entitlement 검증은 **system 본문의 leading text가 CC marker로 시작하는지**를 본다. tomodachi처럼 정상 system 본문이 들어있으면 우리 가드는 `length > 0`이라 통과시키지만 upstream은 거절. 응답 type이 `rate_limit_error`라서 quota 소진으로 한 번 더 오독되기 쉬움 — 사실은 entitlement 위반의 마스킹된 시그니처.

**검증 절차** (운영자가 미래에 또 의심 들 때):

1. `/admin/messages` 에서 status=429 + model=claude-sonnet-4-6 필터. 같은 시간대 haiku 호출도 같이 본다.
2. **haiku는 200, sonnet은 429 + responseBody에 `type: "rate_limit_error"`** 패턴이면 entitlement 게이트. quota 아님.
3. message detail에서 system 본문 첫 200자가 `"You are Claude Code"`로 시작하는지 확인. 아니면 #13 함정 재발 (또는 marker 자체가 바뀌었거나).

**메타 교훈**: 함정 #12와 동일 — Anthropic 응답 메시지(`rate_limit_error`)의 문자 그대로 해석에 매달리지 말 것. 같은 OAuth 토큰으로 모델만 바꿔 (sonnet vs haiku) A/B하는 게 가장 빠른 ground truth. `src/template/extracted.ts:102`에 명시된 cousin misdiagnosis(같은 함정, 다른 위치)를 한 번 더 반복한 사례.

**관련**: [[project_oauth-entitlement-shape-gate]] (12, 13은 같은 메타 패턴 — 응답 메시지가 진짜 원인을 가리지 않음).

---

## 14. messages_log INSERT가 `unsupported Unicode escape sequence`로 거부됨 — NUL 바이트

**증상**: `[messages-log] write failed: unsupported Unicode escape sequence` 가 sink로 흘러옴. 해당 요청의 admin 대시보드 row가 없음. 사용자 응답은 멀쩡 (fire-and-forget).

**원인**: PostgreSQL JSONB는 underlying TEXT 컬럼이 NUL(U+0000) 바이트를 저장하지 못한다. Claude로 보내는 요청/응답 body에 NUL이 섞이면 (예: 사용자가 binary blob을 prompt에 붙여넣음, tool output에 NUL이 들어감) `sql.json(...)` 직렬화는 통과하지만 INSERT가 거부된다. 컬럼은 `TEXT`로 정의된 키도 동일하게 거부.

**복구**: `src/usage/messages-log.ts:sanitizeJsonValue` 헬퍼가 record 호출 직전에 NUL을 U+FFFD로 치환한다. 패치(2026-06-04, PR #43) 이후로는 자동 처리. admin UI에서 `�`(U+FFFD)로 보이는 글자가 곧 "원본에 NUL이 있었음" 증거. `preview` TEXT 컬럼도 sanitize된 body에서 뽑아지므로 동일하게 보호된다.

**검증 절차** (운영자가 미래에 또 보이면):

1. admin/messages 에서 status=400/500 + error_message에 `unsupported Unicode escape sequence` 패턴 검색
2. `bun test tests/messages-log.test.ts` — sanitizer 테스트 통과 여부
3. PG 직접 `SELECT request_body::text FROM messages_log WHERE id=...` 으로 U+FFFD 흔적 확인 (sanitize가 작동 중이면 보임)

**예방**: sanitize 헬퍼는 PG-impl record()에서만 호출된다. 미래에 다른 backend(SQLite/ClickHouse)가 추가되면 해당 impl도 헬퍼를 호출해야 한다. **헬퍼를 우회하는 직접 INSERT 경로를 만들지 말 것**. `preview` 같은 derived TEXT 컬럼도 sanitize된 결과에서 파생해야 한다 (raw body에서 추출 후 INSERT는 NUL 누수 경로).

**관련 보호 장치** (같은 헬퍼에서 함께 처리):

- depth > 1024 재귀 → sentinel 반환 (악의적 깊은 nested JSON으로 stack overflow 방지)
- `__proto__` / `constructor` / `prototype` / `__lookupGetter__` / `__lookupSetter__` / `__defineGetter__` / `__defineSetter__` 키 → drop (prototype pollution 흔적이 DB에 남지 않게)

---

## 15. CC_BLOCK prepend — canonical shape 일 때 transparent, 그 외 prepend

> **[활성 — #96 머지로 적용 완료]** 본 conditional rule은 #96 (B3 strict gate) 코드 PR 머지로 `ensureSystem`에 반영되어 production에서 활성. caller가 canonical CC marker block을 array에 박은 경우 (real CC client 트래픽) `ensureSystem`이 caller `system`을 shallow-copy하여 그대로 forwarding하고, 그 외 경우 unconditional prepend 유지. 코드: `src/proxy/messages.ts` `isCanonicalCcMarker` + `ensureSystem`. 함정 #13의 "현재 동작" 단락도 본 PR과 함께 갱신됨.

**증상**: 토큰 사용 진단 중 outbound payload의 `system` 배열에서 `"You are Claude Code, Anthropic's official CLI for Claude."` 문자열이 position 0과 1에 동일하게 박힌 걸 발견. 직접 ~12 tok/req 낭비처럼 보임. 1009 req/day 기준 ~12K tok/day, sonnet 단가 환산 약 $0.04/day.

**원인**: `ensureSystem()` (`src/proxy/messages.ts:102-111`) 은 caller가 같은 prefix를 보내든 말든 **무조건 prepend**한다 (#96 머지 전 현재 동작). 관측 시점(2026-06-02, CC 2.1.149.27c)의 Claude Code CLI는 system array 중 하나(현재 캡처에선 `system[1]`)에 동일 prefix를 cache_control과 함께 박아 보내므로 결과적으로 duplicate. 위치는 향후 CC 버전에서 이동 가능 — 본 항목의 진단 경로는 위치가 아닌 *shape 중복*에 초점. 표면적으로는 직접 낭비가 작아 보이지만 (~$0.04/day 토큰 비용), 이 중복이 caller가 박은 cache_control breakpoint의 prefix hash를 깨서 **실질적 cache miss를 유발하는 부수효과**가 더 크다 (issue #55, 후술 cost evidence 참조).

### Cost evidence (출처: issue #59 코멘트 — 24h verification post-#58 deploy)

PR #41 (2026-06-04 머지, unconditional prepend 도입) 전후 동일 user/model의 burst-only cache_read 비율:

| 날짜 | read_burst | avg_create (per req) | Era |
|---|---:|---:|---|
| 2026-05-31 | 95.0% | 19,087 | PRE PR41 |
| 2026-06-01 | 97.0% | 23,368 | PRE PR41 |
| 2026-06-02 | 96.0% | 17,419 | PRE PR41 |
| 2026-06-04 | 47.0% | 127,596 | PR #41 머지일 |
| 2026-06-05 | 20.8% | 201,273 | POST PR41 |
| 2026-06-07 | 0.0% | 303,755 | full cache collapse |
| 2026-06-08 | 21.9% | 224,143 | PR #58 머지일 |
| 2026-06-09 | 26.3% | 177,824 | POST PR58 (24h 측정 ceiling) |

`avg_create` 19k → 22만 (약 10x 증가). 매 요청 약 22만 tokens가 새 cache entry로 저장되지만 다음 요청에서 read로 환수되지 못함. 이는 직접 토큰 낭비가 아니라 **caching efficiency 손실** — 4-5x 실효 input 비용.

**PRE PR41 (2026-06-02) raw capture** — caller가 보낸 system array 실제 shape:

- system[0]: `x-anthropic-billing-header:` (81자, no cache_control)
- system[1]: `"You are Claude Code, Anthropic's official CLI for Claude."` (57자, cache_control: ephemeral)
- system[2]: big system prompt (27,473자, cache_control: ephemeral)

→ Real CC client는 entitlement marker를 **system[1]** 에 박는다 (system[0] 아님). canonical shape match는 **anywhere-in-array** 매칭이 필요 — strict `system[0]`-only matching은 real CC traffic을 놓친다.

### invariant 세 보장의 재평가

(1) **Adversary R1 forge protection** — strict shape match로 정책 변경 예정 (post-#96). `tests/messages-ensure-system.test.ts:55-64`의 string forge 테스트는 유지 (string은 array 분기 미진입). `:79-89`의 array forge 테스트는 forged text가 CC_SYSTEM_PREFIX와 byte-identical 아니라 canonical 미해당 → 유지. wire-level forger와 real CC가 정확히 동일 shape이면 구별 불가능 — 이게 새 정책의 핵심 trade-off다. **위협 모델 재정의**: 본 proxy의 API key를 소지한 *모든* 클라이언트는 "외부 공격 vector"가 아닌 "인증된 caller" 영역으로 분류된다. 본 PR은 entitlement gate의 canonical shape 준수 의무를 *proxy에서 API key holder로 위임*하는 변경이다. 외부 API key 클라이언트(예: discord 봇, 자체 agent 워크로드)가 canonical block을 박지 않은 채로 호출하는 case는 여전히 proxy가 unconditional prepend로 보호 — 그러나 canonical block을 *정확히 모사*해서 박은 경우 proxy는 그 caller의 의도를 신뢰하고 통과시킨다. 이 위임의 ToS 함의는 운영자의 책임 영역으로 박제됨 (proxy 외 직접 API key 발급 시 동일 정책이 자동 승계). cost evidence가 정량화된 후 #41 R1 결정의 trade-off를 재평가한 결과다.

(2) **문서화된 wire invariant** — `docs/cc-wire-reference.md` §2a로 conditional rule 갱신 (#97과 동일 PR).

(3) **`#40` Entitlement drift probe** — `verify-entitlement` probe의 call-A는 `system: CC_SYSTEM_PREFIX` (string)을 보낸다. string은 array가 아니므로 새 conditional invariant 하에서도 canonical match 분기 미진입 → probe path는 항상 unconditional prepend 경로를 탄다. **즉 probe `ok` verdict는 always-prepend 경로의 entitlement gate 통과만 검증하며, production transparent 분기에서의 gate 통과는 probe 범위 외.** #96 활성화 이후, transparent 분기에서 gate 통과는 *structural* 보장 — canonical block 자체가 entitlement marker 본체이므로 wire-level identity 요건이 자동 충족 (proxy가 emit했든 caller가 emit했든 동일 byte sequence를 upstream이 본다). 본 PR 머지 시점엔 transparent 분기 코드 부재 — structural 보장은 post-#96 상태에만 적용. 운영자 가이드: probe `ok`는 marker drift 검출 신호로만 해석, transparent 분기 health proxy로 해석 금지.

### Future #96 구현 가이드 — forge 테스트 처분

- `tests/messages-ensure-system.test.ts:55-64` ("string forge"): **유지**. string은 #96 새 array 분기 미진입, transparent 적용 안 됨.
- `tests/messages-ensure-system.test.ts:79-89` ("array forge with 'Anthropic-issued.' text"): **유지**. forged text가 `CC_SYSTEM_PREFIX` 와 byte-identical 아님 → canonical 미해당 → 여전히 prepend.
- 새 transparent 분기 테스트 (canonical match) 케이스는 #96 PR에서 추가.

**진짜 토큰이 부풀어 보이면 어디부터 봐야 하나** (2026-06-05 진단 경로):

1. `messages_log` 의 `cache_read_tokens` vs `cache_creation_tokens` 비율을 사용자/모델별로 본다. hit_pct < 30%는 캐시 비정상.
2. 비정상의 진짜 원인은 보통 **Claude CLI 동적 system 콘텐츠** (오늘 날짜, 현재 git branch, recent commits, session 요약) 가 prefix bytes를 매 호출 바꿔서 cache_creation으로 다시 청구되는 패턴. proxy 책임 아님 — Anthropic CLI 측 설계.
3. multi-tenant aggregation 효과도 별도 확인: 단일 OAuth 토큰이 N명을 서비스하면 Anthropic 콘솔은 N명 합산을 보여준다 (함정 #2의 "운영자=사용자" 모델 참고).

**#48 재분류**: (2026-06-05) — 같은 증상을 "idempotent fix"로 풀려다 당시 invariant와 정면 충돌해 won't-fix로 close. **superseded by #96 (B3 strict gate)**: #48 closing 시점엔 cache cost가 quantify되지 않았다 (~$0.04/day 토큰 낭비만 보였음). issue #59에서 cost evidence가 정량화된 후 (~22만 tokens/req 새 cache entry 낭비, read_burst 95%→24%) trade-off 재평가가 정당화됨.

**PR #58 (2026-06-08) — partial fix 정정**: PR #58은 CC_BLOCK에 `cache_control: { type: 'ephemeral' }` 을 부여하여 prefix hash anchor를 박았으나 (issue #55 본문 §7.1 mechanism 가설), **caller marker 중복 자체는 해소 못해** read_burst 24% ceiling에 그친 partial fix였다 (issue #59 24h 측정 결과). full fix는 본 PR(#97)의 invariant conditional 재정의 + 후속 #96의 B3 strict gate 코드 구현으로 완성된다. #48과 #55/#96의 차이는 여전히 박제 가치 있음: **#48은 "CC_BLOCK 중복 자체로 인한 토큰 낭비" (~$0.04/day, won't-fix 합당), #55는 "CC_BLOCK prepend로 인한 cache key shift" (~4-5x 실효 비용, fix 합당)**. 같은 코드 변경이라도 두 각도가 정반대 결론을 낳을 수 있으니 future-me는 두 케이스를 혼동하지 말 것.

---

## 16. Caddy `response_header_timeout`이 Bun `UPSTREAM_TTFB_TIMEOUT_MS`보다 짧으면 silent 504

**증상**: `/v1/messages` 호출이 간헐적으로 504. 응답 헤더에 `Server: Caddy`만 있고 `cf-ray`/`anthropic-*`는 없음. Caddy 로그에 `net/http: timeout awaiting response headers` + `status: 504` + `duration: ~30s`로 클러스터링. 클라이언트 SDK retry로 대부분 마스킹되어 사용자는 가끔 한 번씩만 본다.

**원인**: edge proxy(Caddy)의 `response_header_timeout`이 origin(Bun)의 TTFB ceiling(`UPSTREAM_TTFB_TIMEOUT_MS`, 현재 120s)보다 짧으면, Bun이 응답을 만들기 전에 Caddy가 먼저 abort한다. 1M context prefill처럼 30초 넘는 정상 케이스가 모두 504로 둔갑한다. 2026-06-05 incident에서 24시간 동안 81건 발생, duration 분포는 ~30s에 모두 박혀있어 (변동 0) 운영자가 즉시 timeout임을 식별할 수 있었다. (2026-06-09 #44: upstream.ts 5xx retry / 429 failover 제거 후 단일 round-trip이 wall-clock 상한이 되어 두 값을 5m → 120s로 동시 인하했다. invariant는 그대로다.)

**복구**:
- 두 값을 일치시킨다. `Caddyfile`의 `response_header_timeout`과 `src/proxy/upstream.ts`의 `UPSTREAM_TTFB_TIMEOUT_MS` 둘 다 같은 값(현재 120s).
- Caddyfile commit 후 `docker compose up -d` — `caddyfile-hash` label trigger가 caddy 컨테이너를 자동 recreate한다(`docker-compose.yml` + `scripts/deploy.sh`의 `CADDYFILE_SHA256` export 체인).
- 응급 hotfix가 필요하면 EC2에서: `[ -s /tmp/new-caddyfile ] && cat /tmp/new-caddyfile > Caddyfile && docker compose up -d --force-recreate caddy`. **`[ -s ... ]` 가드 필수** — /tmp/new-caddyfile이 없거나 빈 파일이면 `cat`의 redirection이 Caddyfile을 0바이트로 truncate해 caddy boot 실패 + 스택 다운. 가드가 false이면 `&&` chain 전체가 **silent no-op**로 종료(아무 출력 없음, exit 1) — 운영자는 명령 실행 후 `docker compose ps caddy`로 컨테이너 실제 재시작 여부를 항상 확인해야 한다. `sed -i`는 새 inode를 만들어 bind mount를 무력화하므로 절대 쓰지 말 것 (truncate-write가 inode를 보존).

**예방**: 두 timeout은 invariant. 한쪽만 변경하는 PR은 review에서 reject. `Caddyfile` 안에 invariant 주석으로 박제됨 — 다음 사람이 120s를 줄이거나 늘리려고 할 때 즉시 보임.

**검증**: EC2에서 `docker compose exec caddy wget -qO- localhost:2019/config/ | grep response_header_timeout` → ns 값이 `UPSTREAM_TTFB_TIMEOUT_MS * 10^6`과 일치 (120s면 `120000000000`).

**결정적 교훈**: 이번 incident는 Caddyfile이 이미 tracked였음에도 30s 값 자체가 두 timeout 간 invariant violation의 source였다. 첫 진단에서 `find` 결과만 보고 "Caddyfile이 untracked"라고 결론낸 게 추가 cycle을 만들었다 — 진짜 문제는 파일의 존재 여부가 아니라 값의 정합성. 두 timeout 중 한쪽만 보는 review는 같은 incident를 다시 만든다.

---

## 17. `docker compose up -d`는 `:latest` 태그 digest 변경을 인지하지 못한다 — src/ PR이 stale 컨테이너로 서빙됨

**증상**: src/ 변경 PR이 머지되고 `scripts/deploy.sh`가 성공으로 끝났는데도 app 컨테이너의 `StartedAt`은 갱신되지 않고 옛 코드가 계속 서빙된다. `docker compose ps`는 `Up 12 hours`처럼 직전 deploy 이전 시각을 보인다. `/healthz`는 정상 응답이라 synthetic check로는 잡히지 않는다. 운영자는 deploy 로그상 SSM `Success` + `/healthz ✓`를 보고 deploy가 끝났다고 결론낸다.

**원인**: `docker compose up -d`는 compose 서비스의 `image:` 참조(우리 경우 `claude-for-you:latest`)를 비교한다 — 컨테이너가 실제로 실행 중인 이미지의 **digest**를 비교하지 않는다. `docker build -t claude-for-you:latest .`이 `:latest` 태그를 새 digest로 옮겨도 compose 입장에서는 서비스 정의가 그대로(`claude-for-you:latest`)이므로 컨테이너 재생성 사유가 없다고 판단한다. 결과: 새 이미지는 만들어졌지만 새 컨테이너로 회전되지 않는다.

이 함정은 PR #54/#70/#73이 deploy chain의 위쪽 단계(SSH 키 부트스트랩, git fetch silent 실패)를 시끄럽게 실패하게 만들기 전까지는 가려져 있었다. 위쪽 단계가 잡힌 뒤에야 src/ 변경이 컨테이너 재생성 단계까지 도달하게 되었고, 거기서 이 함정이 표면화됐다 (issue #74).

**복구**:
- `scripts/deploy.sh`는 PR #74 이후 `docker compose up -d --force-recreate --no-deps claude-for-you` + 후속 `docker compose up -d`로 변경되어 매 deploy당 컨테이너를 강제 재생성한다. operator가 수동 작업할 일은 일반적으로 없다.
- 수동 hotfix가 필요한 상황(예: hot-patched 이미지를 즉시 적용): `docker compose up -d --force-recreate --no-deps claude-for-you`. Caddy는 `caddyfile-hash` label에 묶여 있으므로 `--no-deps`로 cascade를 차단한다 (Caddy가 함께 재생성될 이유가 없을 때).

**예방**: 이 함정은 `:latest` 태그의 의미와 compose의 서비스 참조 비교 방식이 만나는 지점에서 발생한다. SHA-tag 기반 image 참조(`claude-for-you:<git-sha>`)로 옮기면 자연스럽게 회피되지만 deploy.sh + docker-compose.yml + Dockerfile 변경 surface가 커진다 — 현재는 P1(unconditional force-recreate)로 KISS 처리. deploy당 2-3초 overhead를 받아들인 대신 디버깅 복잡도와 roll-forward 시 digest-cache 함정을 동시에 해소한다.

**검증**: src/ 파일을 한 줄이라도 수정한 PR을 머지 + deploy.sh 실행 → `docker ps --format 'table {{.Names}}\t{{.Status}}'`에서 `claude-for-you`의 `Up Xs/Xm` 값이 직전 deploy 이후 시각을 가리킨다. infra-only PR(terraform/, *.md 등) 후에도 동일하게 재생성됨이 P1 채택의 trade-off.

**결정적 교훈**: 처음에는 issue #74 본문이 P3(digest 비교 후 조건부 recreate)를 권장했지만, plan 단계에서 페르소나 검증(impact-analyst)이 짚은 roll-forward digest fragility + Go template escape 위험으로 P1(unconditional)로 선회했다 — "infra-only PR 재시작 회피"라는 P3의 이점이 두 위험을 감수할 만큼 크지 않았다. SSE 스트림 graceful drain은 별도 follow-up으로 분리. **선택지가 본문에 권장된 형태와 정확히 일치할 필요는 없다 — plan 단계 페르소나가 본문이 잡지 못한 trade-off를 짚어낸 사례다.**

---

## 18. Single-org pool에서 429 failover는 정보가치 0 — wall-clock만 태워 504로 둔갑

**증상**: 큰 payload(≥500KB) + 1M-context + thinking-enabled 요청에서 클라이언트(CC SDK)가 `API Error: 504 status code (no body). This is a server-side issue...`를 본다. 동일 세션 안에서 3회까지 SDK 자체 retry가 동일하게 504로 끝난다. Caddy 액세스 로그에는 같은 30초대 구간에 504가 클러스터링되어 있고, 동시에 업스트림은 사실 정직하게 429를 돌려보내고 있었다 — `X-Should-Retry: true`, `Retry-After` 헤더 포함, `Anthropic-Ratelimit-Unified-5h-Status: allowed → exhausted` 전이.

**원인**: `src/proxy/upstream.ts`가 (1) `fetchOnce`에서 5xx retry loop를 돌고 (2) `callUpstream`에서 429 발생 시 다른 풀 멤버로 failover하면서 누적 wait가 Caddy `response_header_timeout`을 넘었다. Caddy가 먼저 abort → 클라이언트에는 Caddy-origin 504(빈 본문) 만 도달 → SDK는 `Retry-After`/`X-Should-Retry`를 못 보고 무차별 retry, 같은 벽을 다시 친다. 게다가:

- **POST `/v1/messages`는 비멱등.** 5xx retry는 업스트림이 부분 처리한 뒤 5xx를 돌려준 경우 double-submit 위험이 있다.
- **Single-org pool에서 429 failover는 정보가치 0.** Anthropic의 5h/7d quota는 org 단위로 묶여 있다. 같은 org 풀의 다른 멤버에게 다시 물어봐도 답은 같다. failover는 wall-clock만 태운다.

→ "transparent proxy"라는 정체성과도 충돌. 업스트림이 정직하게 보낸 429를 우리가 504로 가공해 클라이언트의 backoff 신호를 날려버린 것.

**복구** (2026-06-09 #44에서 적용 완료):
- `src/proxy/upstream.ts`에서 5xx retry 상수/함수 (`FIVE_XX_*`, `isTransient5xx`, `fullJitterDelay`)와 `sleep` 헬퍼, `callUpstream`의 429 failover 분기를 모두 제거.
- 401 refresh + 동일 풀 멤버 1회 retry는 그대로 유지 (refresh token은 우리만 가지고 있어서 클라이언트가 자력으로 회복 불가).
- `UPSTREAM_TTFB_TIMEOUT_MS` 5min → 120s, `Caddyfile` `response_header_timeout` 5m → 120s. #16 invariant 그대로 유지.

**예방**: 풀의 가치를 다시 못 박는다. **per-session token routing + 401 refresh fallback** 이지, quota 분산이 아니다. 풀에 cross-org 계정이 정말로 들어오는 날이 오면 bounded(≤10s) failover를 다시 도입할 수 있지만, 그날까지는 single-round-trip이 옳다.

**검증**: `tests/upstream.test.ts`가 (A) 429 verbatim surface, (B) 502/503/504 verbatim surface, (C) 401 refresh + 1회 retry, (D) 401 후에도 401이면 surface — 네 가지 invariant를 픽스처로 박제한다. PR R2(behavioral fuzz)에서 staging 상대로 429-storm replay + 큰 payload TTFB 실측.

**결정적 교훈**: "transparent proxy"라는 정체성을 두 번 잃었다 — #16에서는 timeout invariant 위반으로, #18에서는 retry 정책이 정직한 업스트림 응답을 가공해서. 둘 다 *"우리가 클라이언트 대신 잘해주려고"* 끼어든 코드가 원인이었다. 우리는 OAuth refresh처럼 **클라이언트가 못 하는 일만** 한다 — 그 외에는 비켜선다. cross-link: #16 (timeout invariant).

---

## 19. `template_apply_failed` / `pacing_await_failed` — proxy 내부 단계 실패 (status=500, upstream 무관)

**증상**: 클라이언트가 HTTP 500을 받고 응답 본문/로그에 `"code": "template_apply_failed"` 또는 `"code": "pacing_await_failed"`가 찍힌다. 같은 시간대 upstream(Anthropic) 호출은 한 건도 발생하지 않는다 — `fetch` 도달 전에 throw됐기 때문이다.

**원인**: `src/proxy/upstream.ts`의 `fetchOnce`는 네트워크 호출 전 두 단계(`template.apply` → `pacing.await`)를 거친다. 이 두 단계의 raw 예외(예: snapshot이 stale해서 `template.apply`가 `TypeError` throw, pacing 맵 invariant 위반)는 이전에는 `DomainError` 래핑 없이 generic 500으로 표출되어 incident triage 시 upstream 장애와 구분하기 어려웠다. #91에서 `wrapFetchOnceStage`로 식별 가능한 code의 `DomainError`로 변환하도록 수정 (2026-06-09).

**triage**:
- `template_apply_failed`: snapshot stale 가능성 우선 의심 (#8). 최신 cron-capture 결과 확인 후 재배포.
- `pacing_await_failed`: `src/pacing.ts` 설정/invariant 위반. 보통 코드 버그 — 스택 트레이스 확인.
- 두 code 모두 **upstream 호출이 아예 발생하지 않은** 실패라, billing/quota 알람과 무관하다.

**예방**: status=500 + `upstream_failed` code (default)와 시맨틱 차이에 주의. `upstream_failed`(502)는 fetch 자체 실패, `template_apply_failed`/`pacing_await_failed`(500)는 fetch 도달 전 proxy 내부 실패. 알람 의사결정 흐름에 별도 분기.

---

## 20. cc-maxed 서드파티 에이전트(hermes-agent)는 CC_BLOCK prepend로 cache_control 4-block 초과 → 400 (#136)

**증상**: 특정 사용자가 NousResearch/hermes-agent로 멀티턴 대화를 돌리면 **첫 1~2턴은 200, 3턴째부터 갑자기 400**이 반복된다. messages_log의 `error_message` = `A maximum of 4 blocks with cache_control may be provided. Found 5`. status=400, streaming=false, user_agent=`Anthropic/Python x.x.x` (SDK 직접 호출이라 canonical CC marker 없음).

**원인**: Anthropic은 `cache_control` breakpoint를 system+tools+messages 합산 **최대 4개**만 허용한다. hermes-agent `agent/prompt_caching.py`는 `system_and_3` 하드코딩 레이아웃으로 **정확히 4개**(system 1 + 마지막 3 non-system 메시지의 content block)를 박는다 — 직접 호출 시 정당. 우리 프록시 `ensureSystem`이 CC_BLOCK(cache_control 포함)을 prepend하면 4+1=5 → 400. 대화 초반엔 non-system 메시지가 3개 미만이라 hermes cc<4 → 프록시 +1 해도 ≤4 → 통과. 3턴째 non-system이 3개에 도달하면 4+1=5로 넘어간다. **서드파티 에이전트라 caller 수정 불가 — 프록시가 떠안아야 하는 구조적 결함이며, hermes-agent를 쓰는 모든 사용자에게 영향.**

**진단 (prod)**: 400 행 request_body에서 cache_control 위치를 명시적으로 센다.
```sql
-- 주의: 명시적 위치(system / messages content / tools)만 센다.
-- $.**.cache_control 재귀 jsonpath는 중복 집계한다(실제 5를 10으로) — 절대 쓰지 말 것.
-- 이 쿼리만 복붙해도 오진 안 나도록 경고를 쿼리 안에 둔다 (코드의 countCacheControlBlocks와 동일 원칙).
select
  jsonb_array_length(coalesce(jsonb_path_query_array(request_body,'$.system[*].cache_control'),'[]'::jsonb)) sys,
  jsonb_array_length(coalesce(jsonb_path_query_array(request_body,'$.messages[*].content[*].cache_control'),'[]'::jsonb)) msg_content,
  jsonb_array_length(coalesce(jsonb_path_query_array(request_body,'$.tools[*].cache_control'),'[]'::jsonb)) tools
from messages_log where status=400 and error_message like '%maximum of 4 blocks%' order by ts desc limit 5;
```
hermes 분포: sys=2(프록시 1 + hermes 1), msg_content=3, tools=0.

**해결 (#136, 2-b 전략)**: `ensureSystem`이 cap-aware해졌다. prepend 전 `countCacheControlBlocks`(system+tools+messages content, 명시적 위치)로 caller cc를 세고, +1이 4를 넘으면 `CC_BLOCK_NO_CACHE`(cache_control 없는 변형)를 prepend → 프록시가 breakpoint를 0개 더하므로 caller의 4개가 그대로 통과. caller body 미수정. cc<4 일반 트래픽은 기존 `CC_BLOCK`(anchor 유지, #55). 상세: cc-wire-reference §2a. (여기서 **2-b** = "프록시가 cache_control 없는 블록을 prepend"하는 채택안. **2-a** = 폐기된 대안: "caller의 system-level cache_control 1개를 흡수하고 프록시 anchor는 유지" — 구현하지 않음. 두 안의 설계 비교는 이슈 #136 논의 참조. **주의**: 이 `2-a`/`2-b`는 #136의 설계 안 식별자일 뿐, cc-wire-reference 문서의 `§2a` 섹션과는 무관하다.)

**캐시 영향 (실측 필요)**: at-cap caller(hermes)는 자체 4개 배치가 최적이므로 anchor 제거가 캐시를 깨지 않을 것으로 기대한다. 단 #55의 95→0% 데이터는 cc를 적게(~2개) 쓰는 CC 클라이언트 기반이라 hermes(cc=4)엔 그대로 적용되지 않는다 — **배포 후 messages_log에서 hermes(user_name 또는 UA `Anthropic/Python`) status=200 행의 `cache_read_tokens / (cache_read + cache_creation + input)` 비율을 baseline(~44.8%)과 실측 비교**해야 최종 확정된다. 미달 시 2-a(caller system cc 흡수)로 재검토.

> **검증 수행 시점/주체**: 이 비율 비교는 `scripts/deploy.sh` 배포 직후 **운영자**가 수행한다 — production smoke(브리/hermes 트래픽이 멀티턴 ≥10 요청 쌓인 뒤)와 함께. 즉 이 PR 머지 시점에는 "미확정"이며, 단위 테스트는 cc≤4와 messages cc 보존만 보장한다(비율 보존은 실측 전용). deploy 단계 전까지 acceptance 4번은 open 상태로 둔다.

---

## 21. 새 모델 계열(Fable 등)이 프록시 사용자 `/model`에 안 뜬다 — gateway discovery `/v1/models`

**증상**: Anthropic이 새 모델 **계열**(예: Fable, `claude-fable-5`)을 출시했는데, 프록시 경유 Claude Code 사용자의 `/model` picker에는 안 뜬다. 같은 CLI 버전(예: 2.1.201)의 **직결 API 사용자는 자동으로 본다**. 반면 sonnet/opus 같은 기존 계열의 **버전 업**(4-7 → 4-8)은 프록시 사용자에게도 예전부터 자동 인식됐다.

**원인**: Claude Code는 endpoint에 따라 picker를 다르게 채운다.
- **first-party**(`api.anthropic.com`): CLI 번들 **built-in 목록** → 새 계열은 CLI 업그레이드로 등장.
- **커스텀 `ANTHROPIC_BASE_URL` 게이트웨이**(우리): built-in으로 새 계열을 띄우지 **않고**, **gateway model discovery**로 학습한다 — 시작 시 `GET /v1/models?limit=1000`(3초 타임아웃, 리다이렉트=실패). 출처: 공식 Claude Code gateway-protocol 문서.

sonnet/opus **버전 업**이 자동이었던 건 그게 클라이언트의 **코어 alias**(`sonnet`/`opus`/`haiku`)라서, alias가 요청 시점에 upstream에서 concrete 버전으로 resolve되기 때문 — discovery도 프록시도 무관. **새 계열**은 discovery로만 뜬다. 우리 프록시가 `/v1/models`를 404시키면 그 유일한 경로가 막힌다.

**해결**: 프록시가 `GET /v1/models`를 서빙한다 (`src/proxy/models.ts` → `src/app.ts` 등록). pool OAuth 토큰으로 upstream `/v1/models`에 **프록시-스루**(401 시 forceRefresh 1회 재시도, 응답 verbatim 전달, 폴백·필터 없음). 이걸로 Fable과 앞으로의 모든 새 계열이 자동 노출된다.

**클라이언트 조건 (필수, 프록시만으론 부족)**: 각 사용자가 `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`을 설정해야 한다 (기본 OFF, CC ≥ 2.1.129). 캐시는 `~/.claude/cache/gateway-models.json`.

**주의 (allowlist)**: `/v1/models`는 upstream 전체 목록을 **필터 없이** 반환한다. 그래서 `allowedModels`가 어떤 계열을 제외한 restricted 키는 그 모델을 picker에서 보긴 하지만 send 시 `403 model_not_allowed`(`src/proxy/messages.ts`)가 난다. 실제 사용하려면 해당 키에 계열(예: `claude-fable-*`)을 추가해야 한다.

**운영 검증**: `curl -sS "$ANTHROPIC_BASE_URL/v1/models?limit=1000" -H "x-api-key: <프록시-키>" | jq '.data[].id'` → `claude-fable-5` 포함 확인. 실패 시 upstream이 구독 OAuth 토큰으로 `/v1/models`를 안 받는지(헤더 부족 등) 점검 — 폴백이 없으므로 이 경우 picker는 조용히 빈 채로 남는다.

---

## 알람을 받았을 때 의사결정 흐름

```
Discord에 [billing] ALARM 알람 옴
  │
  ├─ service_tier=usage-based?  → wire fidelity 깨짐
  │     ├─ canary 진행 중이었나? → 자동 trip됨. promote/rollback 결정
  │     └─ stable이었나? → CC 업데이트로 wire shape 변화. cron-capture로 새 snapshot 후 canary
  │
  ├─ service_tier=standard but unified-status=denied?  → 구독 한도 초과
  │     ├─ 일시적이면 무시 (Anthropic이 자동 회복)
  │     └─ 지속되면 multi-account pool 또는 사용자 quota 강화
  │
  ├─ [oauth] refresh failed?  → 토큰 revoke됨 (#1, #10, 또는 #11)
  │     → 본인이 logout한 적 있으면 #1, 무관하게 갑자기면 #10,
  │       본인 로컬에서 같은 OAuth 쓰는 중이면 #11
  │     → 재로그인 + 갱신 절차
  │
  ├─ HTTP 500 + code=template_apply_failed|pacing_await_failed?  → proxy 내부 실패 (#19)
  │     → upstream 호출 발생 안 함. snapshot/pacing 설정 점검
  │
  └─ HTTP 400 + "maximum of 4 blocks with cache_control"?  → cc-maxed caller (#20)
        → hermes-agent 등 cache_control 4개를 꽉 쓰는 서드파티 에이전트.
          #136 cap-aware prepend가 배포됐는지 먼저 확인 (미배포면 deploy).
          배포됐는데도 나면 #20의 SQL로 cc 분포 진단 (재귀 jsonpath 금지)
```

## 복구 런북 — 배포 롤백 · OAuth 토큰 복구

배포(`scripts/deploy.sh`)는 EC2를 `origin/main`으로 `git reset --hard` → docker build → `docker compose up -d --force-recreate`. **복구 명령은 전부 로컬 터미널/브라우저에서 AWS SSM으로 실행되며 프록시를 경유하지 않는다** — 프록시가 죽어도, (프록시를 base-url로 쓰는) 배포 세션이 죽어도 복구 가능. **배포 전 이 런북을 프록시와 무관한 별도 터미널에 띄워둘 것.**

> ⚠️ **IP 바인딩 (토큰 사망 원인)**: 프록시가 발급/사용하는 OAuth access token을 **다른 IP에서 사용하면 무효화**된다(#11 single-holder rotation과 같은 계열의 anti-abuse). 그래서 **로컬에서 프록시 토큰을 뽑아 `api.anthropic.com`을 직접 치는 검증은 금지** — 토큰이 죽어 운영 프록시까지 내려간다. upstream 검증은 (a) 배포 후 프록시를 통해서(프록시 자기 IP), 또는 (b) EC2 SSM 세션 안(같은 IP)에서만.

### R1 — 코드가 `/v1/messages`를 깸 (토큰은 정상)

증상: `scripts/smoke.sh` 실패 / 502지만 `[oauth] refresh failed`는 아님. → 코드 롤백 (SSM 직통, IP 무관):

```bash
GOOD=<마지막-정상-SHA>            # 배포 전 `git rev-parse origin/main`으로 미리 확보
git push origin "$GOOD:main" --force && bash scripts/deploy.sh   # ~2~5분
git push origin "$GOOD:deploy" --force                            # deploy 마커 동기화
```

`git revert -m 1 <머지커밋> && git push origin main && bash scripts/deploy.sh`도 동일 효과(히스토리 보존). 되돌리는 실제 레버는 `origin/main` + `deploy.sh`뿐 — deploy 브랜치를 reset하지 말 것.

### R2 — OAuth 토큰/RT 자체가 죽음

증상: 전 요청 502 `invalid_grant` / `[oauth] refresh failed` (코드 롤백해도 안 고쳐짐). 원인: IP 불일치, `claude /logout`(#1), 무관 revoke(#10), single-holder 충돌(#11), RT TTL 만료.

1. **fresh RT 발급**: 원래 `ANTHROPIC_OAUTH_REFRESH_TOKEN`을 뽑던 방식으로 재인증 → 새 `sk-ant-ort01-…`.
2. **프록시에 주입** (둘 중 하나):
   - **(권장·빠름, `/admin` 살아있을 때)** 브라우저 `http://<프록시-호스트>/admin` 접속(프록시 키로 인증) → oauth replace 폼에 새 refreshToken 붙여넣고 제출. 재시작 불필요. RT는 **저장만** 되고 실제 refresh는 EC2가 자기 IP로 수행 → IP 안전. curl: `POST /admin/oauth/replace`(`memberName=default`, `src/admin/oauth.ts`).
   - **(폴백, `/admin`도 죽음)** SSM env 갱신 후 재배포:
     ```bash
     aws ssm get-parameter --name /claude-for-you/env --with-decryption --query Parameter.Value --output text > /tmp/env
     # /tmp/env: ANTHROPIC_OAUTH_REFRESH_TOKEN 새 값으로. ANTHROPIC_OAUTH_ACCESS_TOKEN/_EXPIRES_AT 줄은 삭제(즉시 refresh 유도)
     aws ssm put-parameter --name /claude-for-you/env --type SecureString --overwrite --value "$(cat /tmp/env)"
     shred -u /tmp/env && bash scripts/deploy.sh
     ```
3. **새 RT는 프록시에만 둘 것.** 로컬 claude에서 같은 OAuth를 계속 쓰면 single-holder 충돌로 재사망(#11). 로컬은 OAuth 없는 클라이언트로 유지(user-guide 권장 설정). 토큰 무효화 상세는 #1/#10/#11.

**왜 IP 안전한가**: R1/R2-SSM은 `aws ssm`·`git` → AWS API 직통(프록시 경유 X). R2-admin은 RT를 저장만 하고 refresh(=토큰 사용)는 EC2가 자기 IP로 수행. 로컬에서 upstream을 프록시 토큰으로 직접 치지 않는 한 토큰은 안 죽는다.
