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

**현재 동작**: `src/proxy/messages.ts`의 `ensureSystem`이 모든 호출에 대해 caller 입력에 관계없이 CC 시그니처 블록을 `system` array의 첫 블록으로 강제 prepend한다. caller가 보낸 string/array는 두 번째 이후 블록으로 그대로 보존된다 (cache_control 포함). transparent 분기는 없음 — caller가 본문에 `"You are Claude Code"`로 시작하는 텍스트를 박아 identity를 위장하는 abuse도 차단된다.

**필수 조건**:

- `system` array의 첫 블록은 **정확히** `"You are Claude Code, Anthropic's official CLI for Claude."` — 이 marker가 entitlement 게이트 통과 조건. Anthropic이 이 prefix를 한 글자라도 바꾸면 우리 가드가 무너지고 sonnet/opus가 다시 429로 떨어진다.
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

## 15. CC_BLOCK 마커가 system[0]과 system[1]에 두 번 보임 — 이건 의도된 invariant, dedup 금지

**증상**: 토큰 사용 진단 중 outbound payload의 `system` 배열에서 `"You are Claude Code, Anthropic's official CLI for Claude."` 문자열이 position 0과 1에 동일하게 박힌 걸 발견. 직접 ~12 tok/req 낭비처럼 보임. 1009 req/day 기준 ~12K tok/day, sonnet 단가 환산 약 $0.04/day.

**원인 (그러나 버그 아님)**: `ensureSystem()` (`src/proxy/messages.ts:69-78`) 은 caller가 같은 prefix를 보내든 말든 **무조건 prepend**한다. Claude Code CLI의 첫 system 블록이 이미 동일 prefix로 시작하므로 결과적으로 duplicate. 이건 다음 세 가지를 동시에 보장하는 documented invariant다:

1. **Adversary R1 forge protection** — `tests/messages-ensure-system.test.ts:41-75`의 두 forge 테스트가 명시. caller가 marker를 mimicking해서 보내도 proxy-owned block이 leading position을 가져가야 identity ownership이 가짜 caller로 넘어가지 않는다.
2. **문서화된 wire invariant** — `docs/cc-wire-reference.md:72`: *"always prepends ... as the first element ... regardless of what the caller sent"*.
3. **`#40` Entitlement drift probe** — `src/admin/test-runners.ts`의 `verify-entitlement`는 "proxy가 매번 marker를 박는다"를 가정으로 marker drift를 검출한다. dedup하면 이 진단 인프라의 신뢰성도 흔들린다.

**왜 dedup으로 절약하지 않나**: 절약 ~$0.04/day vs 무너뜨릴 것 = adversary R1 hardening + 문서 invariant + drift probe 가정. trade-off가 한쪽으로 명확히 기운다.

**진짜 토큰이 부풀어 보이면 어디부터 봐야 하나** (2026-06-05 진단 경로):

1. `messages_log` 의 `cache_read_tokens` vs `cache_creation_tokens` 비율을 사용자/모델별로 본다. hit_pct < 30%는 캐시 비정상.
2. 비정상의 진짜 원인은 보통 **Claude CLI 동적 system 콘텐츠** (오늘 날짜, 현재 git branch, recent commits, session 요약) 가 prefix bytes를 매 호출 바꿔서 cache_creation으로 다시 청구되는 패턴. proxy 책임 아님 — Anthropic CLI 측 설계.
3. multi-tenant aggregation 효과도 별도 확인: 단일 OAuth 토큰이 N명을 서비스하면 Anthropic 콘솔은 N명 합산을 보여준다 (함정 #2의 "운영자=사용자" 모델 참고).

**선례**: #48 (2026-06-05) — 같은 증상을 "idempotent fix"로 풀려다 위 invariant와 정면 충돌해 won't-fix로 close. 향후 재발견 시 본 항목으로 즉시 returns.

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
  └─ [oauth] refresh failed?  → 토큰 revoke됨 (#1, #10, 또는 #11)
        → 본인이 logout한 적 있으면 #1, 무관하게 갑자기면 #10,
          본인 로컬에서 같은 OAuth 쓰는 중이면 #11
        → 재로그인 + 갱신 절차
```
