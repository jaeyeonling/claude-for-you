#!/usr/bin/env bash
# Claude Code CLI 호환성 검증 — 4단계 스모크 테스트.
#
# 옵션 1 (로컬 CLI를 프록시 뒤로 라우팅) 으로 넘어가기 전,
# 프록시가 CLI가 의존하는 모든 호출 패턴을 정상 처리하는지 확인한다.
#
# Usage:
#   ./scripts/smoke.sh                    # 1~2단계만
#   ./scripts/smoke.sh --tools            # + 3단계 (tool use)
#   ./scripts/smoke.sh --tools --session  # + 4단계 (multi-turn)
#
# Exit codes:
#   0 = 통과한 단계까지 정상
#   1 = 어떤 단계든 실패 — 옵션 1로 넘어가지 말 것

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUBLIC_IP="${PUBLIC_IP:-43.202.105.69}"
KEY="$(grep '^API_KEYS=' "$ROOT/.env" | sed 's/^API_KEYS=//' | cut -d',' -f1 | cut -d':' -f2-)"
MODEL="${MODEL:-claude-sonnet-4-5}"
ENDPOINT="http://$PUBLIC_IP/v1/messages"

if [[ -z "$KEY" ]]; then
  echo "[!] API_KEYS not readable from .env"
  exit 1
fi

hdr=(
  -H "x-api-key: $KEY"
  -H "anthropic-version: 2023-06-01"
  -H "content-type: application/json"
)

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }

echo "=== Step 1: non-streaming /v1/messages ==="
body=$(curl -sS --max-time 30 -X POST "$ENDPOINT" "${hdr[@]}" -d "{
  \"model\":\"$MODEL\",
  \"max_tokens\":50,
  \"messages\":[{\"role\":\"user\",\"content\":\"reply with the single word: pong\"}]
}")
echo "$body" | head -c 300; echo
echo "$body" | grep -q '"type":"message"' && pass "non-streaming OK" || fail "non-streaming failed"

echo
echo "=== Step 2: streaming SSE ==="
stream=$(curl -sS -N --max-time 30 -X POST "$ENDPOINT" "${hdr[@]}" -d "{
  \"model\":\"$MODEL\",
  \"max_tokens\":50,
  \"stream\":true,
  \"messages\":[{\"role\":\"user\",\"content\":\"count: 1 2 3\"}]
}" | head -c 2000)
echo "$stream" | head -c 500; echo
echo "$stream" | grep -q 'event: message_start' && pass "stream starts" || fail "no message_start event"
echo "$stream" | grep -q 'event: message_stop' && pass "stream ends" || fail "no message_stop — proxy may be cutting stream"

if [[ "${1:-}" == "--tools" || "${2:-}" == "--tools" ]]; then
  echo
  echo "=== Step 3: tool use round-trip ==="
  # TODO(learning-mode):
  # Claude Code CLI가 실제로 보내는 tool use 페이로드를 여기에 채워 넣으세요.
  #
  # 검증해야 할 것:
  #   - tools 배열에 input_schema 포함된 도구 선언이 통과하는지
  #   - 모델이 tool_use content block을 반환하는지
  #   - tool_result로 multi-turn 호출했을 때 정상 응답이 오는지
  #
  # 참고 페이로드 형태:
  #   {
  #     "model": "...",
  #     "max_tokens": 1024,
  #     "tools": [{
  #       "name": "...",
  #       "description": "...",
  #       "input_schema": { "type": "object", "properties": {...}, "required": [...] }
  #     }],
  #     "messages": [{"role": "user", "content": "..."}]
  #   }
  #
  # 어떤 도구를 시험할지가 의미 있는 선택이에요:
  #   - get_weather 류 단순 파라미터       → 기본 동작 확인
  #   - bash/file edit 류 multi-arg         → Claude Code의 실제 패턴에 가까움
  #   - 응답 후 tool_result로 한 번 더 호출 → multi-turn까지 검증
  fail "Step 3 payload not implemented — fill in scripts/smoke.sh and re-run"
fi

if [[ "${1:-}" == "--session" || "${2:-}" == "--session" ]]; then
  echo
  echo "=== Step 4: multi-turn (5 turns) ==="
  fail "Step 4 not implemented yet — finish Step 3 first"
fi

echo
echo "=== 모든 단계 통과 — 옵션 1로 진행 가능 ==="
