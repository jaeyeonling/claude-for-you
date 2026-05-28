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

## 12. 1M context는 게이트웨이로 못 씀 — `context-1m`은 자동 strip

**증상**: 클라이언트가 `claude-opus-4-7[1m]` 같이 1M 컨텍스트 변종으로 요청하면 직결에서는 통과하지만 우리 프록시 통해 가면 HTTP 429 `"Usage credits are required for long context requests"` 로 거부.

**원인**: 게이트웨이의 업스트림은 Claude.ai OAuth(구독)다. 1M context 베타(`context-1m-*`)는 **Console API key + tier-4 usage credit 전용 기능** — 구독 OAuth에는 엔타이틀먼트 자체가 없음. Anthropic이 토큰 종류를 보고 결정론적으로 거부 (rate-limit 아님, 권한 게이트).

**현재 동작 (`a59a8f1` 이후 — 이건 그 후속 commit)**: `src/template/extracted.ts`의 `mergeAndFilterAnthropicBeta`가 클라이언트가 보낸 `context-1m-*` 플래그를 **머지 후에 silent strip**. 요청은 200K 윈도우로 우아하게 강등되어 그대로 통과. 입력이 진짜로 200K를 넘으면 그때 upstream이 "input too long"으로 명확히 거부.

**확인 방법 (운영자)**: 프록시 로그에서 `[template] stripped OAuth-incompatible anthropic-beta flag(s): context-1m-...` 라인 검색. 라인이 보이면 그 요청은 강등됐다는 뜻.

**부수 효과 — 프롬프트 캐시 미스**: Anthropic의 prompt cache key는 `anthropic-beta` 플래그 집합도 포함한다. 클라이언트가 `context-1m-*`를 켜고 보내면 캐시 쓰기/읽기는 strip된 베타 셋 기준으로 이뤄지므로 — 클라이언트는 캐시 히트를 기대했는데 실제로는 미스. 비용/지연이 살짝 늘 수 있고, "원인 모를 cache-miss 증가"로 보이면 strip 로그 빈도와 상관관계부터 확인할 것.

**1M이 진짜로 필요한 사용자**: 게이트웨이를 우회하고 **Console API key로 직결** 사용. 구독 OAuth로는 구조적으로 불가능 — 회피책 없음.

**확장**: 미래에 OAuth로 못 쓰는 다른 베타가 추가되면 `OAUTH_INCOMPATIBLE_BETA_PREFIXES` 배열에 prefix만 추가하면 자동 strip. 테스트는 `tests/template-extracted.test.ts`에 prefix-match 케이스 포함.

**관련**: 함정 #2(본인 머신 검증)와 같은 "게이트웨이 모델의 자연스러운 trade-off" 카테고리 — 구독 1개를 여럿이 공유한다는 비용 절감 모델은 곧 API-tier 전용 기능을 못 쓴다는 의미.

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
