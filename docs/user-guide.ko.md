# 사용자 가이드

운영자가 **프록시 URL**과 **API 키**를 전달했다면 이 문서가 맞다. 본인 노트북의 Claude Code를 프록시로 연결하는 절차를 정리.

> [English guide](./user-guide.md)

## 운영자에게 받는 정보

두 가지. 두 번째는 비공개로 유지.

| 항목 | 예시 | 비고 |
|---|---|---|
| 프록시 URL | `http://<운영자가-알려준-주소>` | 운영자가 알려준 IP 또는 호스트명. |
| API 키 | 64자 hex 문자열 (예시 형태: `9f1a…c3e7`) | **비밀번호로 취급.** 이 키 가진 사람은 운영자의 Claude.ai 사용량을 소진 가능. |

> 이 키는 본인 Anthropic API 키가 아니라 **운영자가 본인 전용으로 발급한 키**. 이 프록시 한정으로만 동작.

## 사전 요구사항

- macOS (Linux는 차이 나는 부분만 인라인으로 주석. Windows는 Unix 쉘 가정 — 운영자에게 문의하거나 WSL 사용)
- [Claude Code CLI](https://claude.com/claude-code) 설치
- 최신 Claude Code (`claude --version` ≥ `2.1.x`)

## 설정

### 권장 설정

기본 설정. Claude Code의 모든 기능(hooks, CLAUDE.md 자동 발견, 플러그인, auto-memory)을 그대로 쓰면서 프록시 키가 키체인의 다른 항목과 충돌하지 않음. 3단계, 약 5분.

#### Step 1. 기존 키체인 OAuth 정리

**이 머신에서 본인 Claude.ai 계정으로 `claude`를 한 번이라도 쓴다면 이 단계는 건너뛴다** (예: 본인 구독으로 한 달에 몇 번만 쓰는 경우도 포함). 대신 아래 [대안 설정](#대안-설정-같은-머신에서-본인-claude-max를-병행-사용)으로 이동.

그게 아니라면, 잔존 OAuth 자격증명이 프록시 키를 덮어쓰는 일이 없도록 제거:

```bash
claude auth logout 2>/dev/null || true
security delete-generic-password -s "Claude Code-credentials" 2>/dev/null || true
security delete-generic-password -s "Claude Code" 2>/dev/null || true
rm -f ~/.claude/.credentials.json 2>/dev/null || true
```

OAuth 흔적이 없는지 확인:

```bash
security find-generic-password -s "Claude Code-credentials" 2>&1 | grep -q "could not be found" && echo "clean ✓"
```

> **Linux**: `libsecret` 사용 시 `secret-tool clear service "Claude Code"`. 아니면 `~/.claude/.credentials.json` 삭제만 확인.

#### Step 2. 프록시 키를 macOS Keychain에 저장

별도 Keychain 항목으로 저장 (나중에 OAuth 자격증명이 추가돼도 충돌 안 함):

```bash
security add-generic-password \
  -a "$USER" \
  -s "claude-for-you-proxy" \
  -w '<여기에_키_붙여넣기>' \
  -U
```

저장 확인 — 키가 그대로 출력되어야 함:

```bash
security find-generic-password -a "$USER" -s "claude-for-you-proxy" -w
```

> **Linux** 대응: [`pass`](https://www.passwordstore.org/) (`pass insert cfy/proxy-key`) 또는 `secret-tool store --label='cfy proxy key' service claude-for-you-proxy account "$USER"`. 최후의 수단으로 `chmod 600` 평문 파일이 있지만 디스크에 평문이 남음.

#### Step 3. `~/.claude/settings.json` 구성

키를 요구 시점에 출력하는 작은 헬퍼 스크립트 생성:

```bash
mkdir -p ~/bin
cat > ~/bin/cfy-key.sh <<'EOF'
#!/bin/bash
security find-generic-password -a "$USER" -s "claude-for-you-proxy" -w
EOF
chmod +x ~/bin/cfy-key.sh
```

> **Linux**: `cfy-key.sh`의 본문을 Step 2에서 쓴 secret backend에 맞게 교체:
> - `pass`: `pass show cfy/proxy-key`
> - `secret-tool`: `secret-tool lookup service claude-for-you-proxy account "$USER"`

그 다음 Claude Code가 프록시와 헬퍼를 보도록 설정. 경로는 **반드시 절대 경로** — `~`나 `$HOME`은 Claude Code가 expand하지 않음:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "<프록시_URL>"
  },
  "apiKeyHelper": "/Users/<본인_사용자명>/bin/cfy-key.sh"
}
```

`~/.claude/settings.json`에 저장. 파일이 이미 있고 다른 키(예: `theme`)가 들어있다면 그것들은 유지하고 `env`와 `apiKeyHelper`만 같은 레벨에 추가 — `settings.json`은 한 개의 flat object임:

```json
{
  "theme": "dark",
  "env": { "ANTHROPIC_BASE_URL": "<프록시_URL>" },
  "apiKeyHelper": "/Users/<본인_사용자명>/bin/cfy-key.sh"
}
```

끝. 이제 그냥 `claude` 실행하면 됨 — 환경변수도, `--bare`도, 인라인 키도 필요 없음.

> **첫 호출 다이얼로그**: `cfy-key.sh`가 처음 실행될 때 macOS가 "Terminal이 Claude Code Keychain에 접근하려고 합니다"를 묻는다. **Always Allow**를 누르면 이후엔 묻지 않음. Keychain의 접근 추적 기능 — 버그가 아니라 보안 기능.

---

### 대안 설정: 같은 머신에서 본인 Claude Max를 병행 사용

> ⚠️ **주의**: 키체인에 본인 Claude.ai OAuth와 프록시를 같이 두는 건 약간의 위험이 있음. 이후 `claude auth login`을 다시 실행하거나, 프록시가 같은 토큰을 refresh하는 순간에 OAuth refresh chain이 회전하면 양쪽 다 풀릴 수 있음. 권장 설정은 본인 OAuth를 제거해서 이 위험을 원천 차단. 같은 머신에서 본인 OAuth와 프록시를 모두 써야 한다는 점을 인지한 경우에만 이 대안을 선택.

권장 설정과 동일하되 두 가지만 다름:

- **Step 1(정리)을 건너뛴다.** 본인 Claude.ai OAuth는 키체인에 그대로 남김.
- **Step 3에서 `env.ANTHROPIC_BASE_URL`을 settings.json에서 뺀다.** `apiKeyHelper`만 남김:

  ```json
  {
    "apiKeyHelper": "/Users/<본인_사용자명>/bin/cfy-key.sh"
  }
  ```

프록시를 쓰고 싶을 때만 인라인 env 또는 alias로 활성화:

```bash
# 인라인
ANTHROPIC_BASE_URL=<프록시_URL> claude

# 또는 ~/.zshrc / ~/.bashrc에 alias 영구 설정
alias claude-proxy='ANTHROPIC_BASE_URL=<프록시_URL> claude'
```

`ANTHROPIC_BASE_URL` 없이 `claude` 실행하면 평소처럼 본인 Claude Max 계정 사용. [작동 검증](#작동-검증)의 배너 체크로 두 모드 모두 확인 가능:

```bash
claude                                     # 배너 "Claude Max"
ANTHROPIC_BASE_URL=<프록시_URL> claude     # 배너 "API Usage Billing"
```

---

### 디버그/일회성 검증용: `--bare` 모드

**일회성 검증** 또는 Claude Code가 디스크에서 아무것도 안 읽었으면 하는 CI 환경에서:

```bash
ANTHROPIC_BASE_URL=<프록시_URL> \
ANTHROPIC_API_KEY=<여기에_키_붙여넣기> \
claude --bare
```

`--bare`는 hooks, CLAUDE.md 자동 발견, 플러그인, auto-memory, 백그라운드 prefetch를 모두 건너뜀. **일상 사용 용도가 아님** — 기능을 잃는다. 일상은 권장 설정으로.

## 작동 검증

`claude` 실행 후 좌상단 배너로 인증 모드 확인:

| 배너 표시 | 의미 |
|---|---|
| `API Usage Billing` | 프록시 키 사용 중. ✓ |
| `Claude Max` (또는 본인 plan 이름) | 키체인 OAuth가 이김. 프록시 **안 거치는 중**. |

권장 설정을 따랐는데도 본인 plan 이름이 보이면 아래 [트러블슈팅](#트러블슈팅) 참고.

기능 검증:

```bash
claude -p "reply with the single word: pong" --model claude-sonnet-4-6
```

기대 출력: `pong`.

## 트러블슈팅

### `Please run /login` / `401 Invalid authentication credentials`

거의 항상 다음 셋 중 하나:

- **`apiKeyHelper` 경로가 절대 경로가 아님.** `~/bin/cfy-key.sh`나 `$HOME/bin/cfy-key.sh`는 동작 안 함 — 풀 경로 `/Users/<본인_사용자명>/bin/cfy-key.sh`로 적어야 함. `cat ~/.claude/settings.json`으로 확인.
- **헬퍼가 빈 값 반환.** `~/bin/cfy-key.sh` 직접 실행. 출력이 비면 두 가지 가능성 — 먼저 Keychain 접근 다이얼로그를 닫아버린 건 아닌지 확인 (아래 [Keychain 접근 다이얼로그가 계속 뜸](#keychain-접근-다이얼로그가-계속-뜸) 참고). 그게 아니면 Step 2(키 저장)가 안 된 것. `security add-generic-password` 다시 실행 후 `security find-generic-password -a "$USER" -s "claude-for-you-proxy" -w`로 확인.
- **API 키가 잘못됨.** 운영자가 보낸 메시지에서 다시 복사 (`alice:` 같은 prefix 없이 hex 값만).

### Keychain 접근 다이얼로그가 계속 뜸

첫 다이얼로그에서 **Allow**를 눌렀음 (**Always Allow**가 아니라). `~/bin/cfy-key.sh`를 한 번 더 실행하고 이번엔 **Always Allow** 클릭.

### 상단 배너에 `API Usage Billing` 대신 `Claude Max` 표시

키체인에 OAuth 자격증명이 살아 있어서 프록시 키를 덮어쓰고 있음. 둘 중 하나:
- 권장 설정 Step 1(정리)을 실행, 또는
- 대안 설정 중이라면 `apiKeyHelper` 출력에 trailing whitespace가 없는지 확인: `~/bin/cfy-key.sh | wc -c`가 운영자가 보낸 키 길이와 같아야 함 (64자 hex 키라면 `64`). 1이 더 크면 trailing newline이 끼어있는 것 — 위 스크립트는 `security`(기본적으로 trailing newline 없이 출력)를 써서 이 문제를 피함.

### `403 model_not_allowed`

본인 키에 모델 allowlist가 걸려있고 그 외의 모델을 요청함. 응답 본문에 허용된 모델 목록이 있음. 운영자에게 allowlist 확장 요청하거나, 표시된 모델만 사용 (대부분 casual 사용자는 `claude-haiku-*`만).

### sonnet/opus만 `429 rate_limit_error`, haiku는 잘 됨

프록시가 자동으로 처리해야 함 — 본사가 Claude.ai OAuth 토큰 + premium 모델 조합에 요구하는 default `system` 필드를 프록시가 inject. 그래도 보이면:
- 클라이언트가 명시적으로 빈 `system` (`"system": ""`)을 보냈을 가능성. 필드 제거 또는 비어있지 않은 값으로 설정.
- 운영자에게 프록시가 최근 커밋인지 확인 요청.

### 재시작할 때마다 `Please run /login`

권장 설정 중이라면 `~/.claude/settings.json`이 reverted되었거나 typo가 있을 가능성. `cat ~/.claude/settings.json`으로 `apiKeyHelper`가 절대 경로이고 `env.ANTHROPIC_BASE_URL`이 설정되어 있는지 확인.

대안 설정 중이라면 인라인 `ANTHROPIC_BASE_URL`을 plain `export` 대신 alias로 영구 설정:

```bash
# ~/.zshrc 또는 ~/.bashrc
alias claude-proxy='ANTHROPIC_BASE_URL=<프록시_URL> claude'
# 공유/commit되는 rc 파일에 ANTHROPIC_API_KEY는 두지 말 것 —
# apiKeyHelper가 키를 처리.
```

## 보안 메모

- **API 키를 절대 commit 하지 말 것.** 권장 설정은 키를 macOS Keychain에 보관(OS 암호화) — 헬퍼 스크립트는 요구 시점에 출력만 하고 디스크에 쓰지 않음.
- **공개 채팅, gist, 이슈 트래커에 키 붙여넣지 말 것.** 키 유출되면 누구나 운영자의 Claude.ai 사용량을 소진 가능.
- 유출 의심되면 즉시 운영자에게 알릴 것. `/admin`에서 revoke 후 새 키 발급 가능.
- 프록시 운영자는 요청 메타데이터(사용 모델, 토큰 수, 타임스탬프)는 볼 수 있지만 **프롬프트/응답 본문은 못 봄** (end-to-end 통과). 그래도 "공유 자원이 신뢰 가능한가" 일반 판단은 적용할 것.

## 자주 묻는 질문

**전에는 `claude --bare`로 쓰라고 안내받았는데, 뭐가 바뀐 거?**
`--bare`는 키체인 OAuth가 프록시 키와 충돌하는 문제를 우회하는 임시 방편이었음. 권장 설정은 그 충돌을 근본적으로 해결(키체인 OAuth를 제거하고 프록시 키를 별도 Keychain 항목으로 저장)하고, Claude Code의 모든 기능 — hooks, CLAUDE.md 자동 발견, 플러그인, auto-memory — 을 그대로 돌려줌. `--bare`는 일회성 검증용으로는 여전히 유효하지만 기본 설정으로는 적합하지 않음.

**Claude Code 말고 SDK / API 호출에도 쓸 수 있나?**
가능. 프록시는 Anthropic Messages API를 그대로 따름. 어떤 Anthropic SDK든 `ANTHROPIC_BASE_URL`과 `ANTHROPIC_API_KEY`를 가리키면 됨. Streaming과 tool use 다 동작.

**내 개인 `claude` 계정에 영향 가나?**
권장 설정 Step 1을 따랐다면 본인 OAuth가 제거되었으므로 이 머신에서 본인 계정을 다시 쓰려면 `claude auth login` 재실행 필요. 대안 설정을 따랐다면 본인 Claude Max OAuth는 키체인에 그대로 — `ANTHROPIC_BASE_URL` 없이 `claude` 실행하면 평소처럼 개인 계정 사용.

**어떤 모델 쓸 수 있나?**
요청하는 모델 그대로 (`--model claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`). 프록시는 모델 제한 안 함. 프록시 뒤의 Claude.ai 플랜이 premium 모델 사용 가능 여부 결정.

**얼마나 썼는지 어떻게 알 수 있나?**
운영자가 `GET /admin` → "per-user usage (UTC today)" 섹션에서 키별 카운터 확인 가능. 운영자에게 문의.
