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

**별개 트레이드오프 — prepend로 인한 cache key shift (issue #55, 2026-06-08 해소)**: 위 진단 경로(항목 1~3)는 *client 측 동적 콘텐츠*가 원인인 경우다. 별개로 `ensureSystem`이 prepend하는 CC_BLOCK 자체가 caller breakpoint 위치를 한 칸 밀어 cache prefix hash를 깨는 *proxy 측* 트레이드오프도 존재했다. issue #55에서 CC_BLOCK에 `cache_control: { type: 'ephemeral' }`을 부여하는 방식으로 해소했다 — Anthropic prompt cache는 content-hash 기반 + 20-block lookback이므로, CC_BLOCK이 자체 breakpoint를 가지면 caller breakpoint의 prefix hash가 deterministic하게 처리된다. 두 원인은 독립적으로 발생 가능 — proxy 측 fix 후에도 client_sys0 동적 콘텐츠로 인한 hit% 저하는 별개로 진단해야 한다. #48과 #55의 차이도 여기에 있다: **#48은 "CC_BLOCK 중복 자체로 인한 토큰 낭비" (~$0.04/day, won't-fix 합당), #55는 "CC_BLOCK prepend로 인한 cache key shift" (~4-5x 실효 비용, fix 합당)**. 같은 invariant를 보는 두 각도가 정반대 결론을 낳을 수 있으니 future-me는 두 케이스를 혼동하지 말 것.

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
