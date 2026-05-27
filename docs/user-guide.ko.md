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

- macOS 또는 Linux (Windows도 가능하지만 아래 path 예시는 Unix 기준)
- [Claude Code CLI](https://claude.com/claude-code) 설치
- 최신 Claude Code (`claude --version` ≥ `2.1.x`)

## 두 가지 연결 방법

**둘 중 하나** 선택:

### 옵션 A — `apiKeyHelper` (권장, 본인 Claude Max OAuth 유지)

본인이 같은 머신에서 개인 Claude.ai 계정으로 `claude`를 평소 쓰고 있다면 이 방법이 최적. `apiKeyHelper`가 키체인 OAuth보다 우선하면서도 키체인 자체는 삭제하지 않음. `ANTHROPIC_BASE_URL` 없이 `claude` 실행하면 평소처럼 개인 계정 사용.

```bash
mkdir -p ~/.claude
cat > ~/.claude/settings.json <<'JSON'
{
  "apiKeyHelper": "echo <여기에_키_붙여넣기>"
}
JSON
```

base URL 인라인 사용:

```bash
ANTHROPIC_BASE_URL=<프록시_URL> claude
```

또는 영구 설정 (alias 권장):

```bash
# ~/.zshrc 또는 ~/.bashrc
export ANTHROPIC_BASE_URL=<프록시_URL>
alias claude-proxy='ANTHROPIC_BASE_URL=<프록시_URL> claude'
```

### 옵션 B — `--bare` 모드 (가장 단순, 단 일부 기능 비활성)

플러그인, hooks, CLAUDE.md 자동발견, 백그라운드 prefetch 같은 거 안 써도 되면:

```bash
ANTHROPIC_BASE_URL=<프록시_URL> \
ANTHROPIC_API_KEY=<여기에_키_붙여넣기> \
claude --bare
```

`--bare`는 키체인 OAuth를 **절대** 안 읽고 프록시 키만 강제로 쓰는 가장 깔끔한 방법. 트레이드오프는 `claude --help`에 명시.

## 작동 검증

`claude` 실행 후 좌상단 배너로 인증 모드 확인:

| 배너 표시 | 의미 |
|---|---|
| `API Usage Billing` | 프록시 키 사용 중. ✓ |
| `Claude Max` (또는 본인 plan 이름) | 키체인 OAuth가 이김. 프록시 **안 거치는 중**. |

본인 plan 이름이 보이면 키체인이 프록시 키를 덮어쓰는 상태. 옵션 B (`--bare`)로 전환하거나 `apiKeyHelper` 경로를 다시 확인.

별도 터미널에서 기능 검증:

```bash
ANTHROPIC_BASE_URL=<프록시_URL> \
ANTHROPIC_API_KEY=<키> \
claude --bare -p "reply with the single word: pong" --model claude-sonnet-4-6
```

기대 출력: `pong`.

## 트러블슈팅

### `Please run /login` / `401 Invalid authentication credentials`

거의 항상 둘 중 하나:
- 인라인 env로 인터랙티브 모드 진입했고, UI가 사이드채널 호출에 키체인 OAuth를 보냈다가 프록시가 인식 못해서 401. 옵션 B 사용.
- API 키가 잘못됨. 운영자가 보낸 메시지에서 다시 복사 (`alice:` 같은 prefix 없이 hex 값만).

### 상단 배너에 `API Usage Billing` 대신 `Claude Max` 표시

프록시 키가 outbound 호출에 안 적용됨. 두 가지 fix:
- `claude --bare`로 전환 (옵션 B).
- 옵션 A 사용 중이면 `~/.claude/settings.json`이 유효한 JSON인지 확인 + `apiKeyHelper`가 키 값만 공백 없이 출력하는지 확인 (`echo -n <KEY>` 또는 그냥 `echo <KEY>`).

### sonnet/opus만 `429 rate_limit_error`, haiku는 잘 됨

프록시가 자동으로 처리해야 함 — 본사가 Claude.ai OAuth 토큰 + premium 모델 조합에 요구하는 default `system` 필드를 프록시가 inject. 그래도 보이면:
- 클라이언트가 명시적으로 빈 `system` (`"system": ""`)을 보냈을 가능성. 필드를 제거하거나 비어있지 않은 값으로 설정.
- 운영자에게 프록시가 `f9982a8` 이후 커밋인지 확인 요청.

### 재시작할 때마다 `Please run /login`

쉘이 환경변수 안 가져감. `~/.zshrc` / `~/.bashrc`에 영구 설정:

```bash
export ANTHROPIC_BASE_URL=<프록시_URL>
# 공유 머신이면 ANTHROPIC_API_KEY는 rc 파일에 두지 말 것 —
# 대신 apiKeyHelper (옵션 A) 사용.
```

## 보안 메모

- **API 키를 절대 commit 하지 말 것.** 쉘 rc 파일에 둔다면 그 파일을 비공개로 (`chmod 600`).
- **공개 채팅, gist, 이슈 트래커에 키 붙여넣지 말 것.** 키 유출되면 누구나 운영자의 Claude.ai 사용량을 소진 가능.
- 유출 의심되면 즉시 운영자에게 알릴 것. `/admin`에서 revoke 후 새 키 발급 가능.
- 프록시 운영자는 요청 메타데이터 (사용 모델, 토큰 수, 타임스탬프) 는 볼 수 있지만 **프롬프트/응답 본문은 못 봄** (end-to-end 통과). 그래도 "공유 자원이 신뢰 가능한가" 일반 판단은 적용할 것.

## 자주 묻는 질문

**Claude Code 말고 SDK / API 호출에도 쓸 수 있나?**
가능. 프록시는 Anthropic Messages API를 그대로 따름. 어떤 Anthropic SDK든 `ANTHROPIC_BASE_URL`과 `ANTHROPIC_API_KEY`를 가리키면 됨. Streaming과 tool use 다 동작.

**내 개인 `claude` 계정에 영향 가나?**
없음. 옵션 A 사용 시 본인 Claude Max OAuth는 키체인에 그대로. `ANTHROPIC_BASE_URL` 없이 `claude` 실행하면 평소처럼 개인 계정 사용.

**어떤 모델 쓸 수 있나?**
요청하는 모델 그대로 (`--model claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`). 프록시는 모델 제한 안 함. 프록시 뒤의 Claude.ai 플랜이 premium 모델 사용 가능 여부 결정.

**얼마나 썼는지 어떻게 알 수 있나?**
운영자가 `GET /admin` → "per-user usage (UTC today)" 섹션에서 키별 카운터 확인 가능. 운영자에게 문의.
