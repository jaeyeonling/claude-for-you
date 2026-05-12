# CC Wire Reference

Empirical reference compiled from **42 live `/v1/messages` captures** of Claude Code 2.1.126 (build `e44c1d97`), captured 2026-05-12 via our own `CAPTURE_MODE` proxy. This document supplements `src/template/cc-snapshot.json` with content-level data that the snapshot intentionally omits (since our wire rebuild forwards body content verbatim).

Use this when:
- Phase 20 considers injecting CC-shaped `system` / `tools` into SDK-direct clients
- Debugging "why does my outbound look different from CC" — pattern reference
- Re-capturing for a new CC version and wanting to diff

---

## 1. `anthropic-beta` variants

All 3 variants use the same 7-flag set; only the **list order** differs (SDK adds flags from different code paths). Anthropic accepts all three identically.

```
SET = {
  claude-code-20250219,
  interleaved-thinking-2025-05-14,
  redact-thinking-2026-02-12,
  context-management-2025-06-27,
  prompt-caching-scope-2026-01-05,
  advisor-tool-2026-03-01,
  effort-2025-11-24,
}
```

| Variant | Count | Notes |
|---|---|---|
| `claude-code,interleaved,redact,context-mgmt,prompt-cache,advisor,effort` | 36 | dominant order |
| `interleaved,redact,context-mgmt,prompt-cache,claude-code,advisor` | 4 | claude-code mid-list |
| same with `+structured-outputs-2025-12-15` instead of `claude-code` | 1 | structured outputs request |

**Conclusion**: the union of all observed flags is what our snapshot stores. Set is what matters, not order.

---

## 2. `body.system` shape

CC sends `system` as **array of 3 text blocks** in every observed capture (none used a plain string).

```json
[
  { "type": "text", "text": "x-anthropic-billing-header: cc_version=2.1.126.<HASH>;cc_…" },
  { "type": "text", "text": "<system prompt body — instructions>" },
  { "type": "text", "text": "<final context block — last user message context, tools description, etc.>" }
]
```

- **First block** starts with `x-anthropic-billing-header: cc_version=2.1.126.<HASH>;cc_…`. **The `<HASH>` differs per CC session** (`75e`, `88d`, `af5`, `e4b`, `198` across our captures). This is the build-time hash CC emits — a real fingerprint axis. Because we forward `body.system` verbatim, the hash naturally varies per CC session in our outbound, which matches what direct CC traffic looks like.
- **Size distribution**: min 934 B, max 26662 B, mean **~19 KB**. Grows with multi-turn conversation context.
- **Cache control**: blocks carry `cache_control: { type: "ephemeral" }` for prompt caching (not shown above — strip from synthesized values if reusing).

---

## 3. `body.tools` distributions

Tool count varies by request:

| Tool count | Captures | Scenario |
|---|---|---|
| 27 | 27 | Full interactive (all built-in + Agent / AskUserQuestion / EnterPlanMode / ExitPlanMode / TaskOutput) |
| 22 | 9 | Subset — likely `--print` or non-interactive |
| 4  | 4  | Minimal set |
| 0  | 1  | Tool-less call |

### Always-present tools (40/42)
`Bash`, `Read`, `WebFetch`, `WebSearch`

### Common tools (36/42)
`CronCreate`, `CronDelete`, `CronList`, `Edit`, `EnterWorktree`, `ExitWorktree`, `Monitor`, `NotebookEdit`, `PushNotification`, `RemoteTrigger`, `ScheduleWakeup`, `Skill`, `TaskCreate`, `TaskGet`, `TaskList`, `TaskStop`, `TaskUpdate`, `Write`

### Interactive-only (27/42)
`Agent`, `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `TaskOutput`

These names are stable across CC 2.1.x; the schema for each lives inside the captured `body.tools` and is forwarded as-is by our proxy.

---

## 4. `body.thinking` / `context_management` / `output_config`

CC always emits these three fields together on interactive calls. Single deterministic shapes:

```json
"thinking": { "type": "adaptive" }
```

```json
"context_management": {
  "edits": [ { "keep": "all", "type": "clear_thinking_20251015" } ]
}
```

```json
"output_config": { "effort": "high" }
```

One outlier: 1 call used `output_config` for structured-outputs json_schema instead of `{effort:high}`.

---

## 5. `body.metadata.user_id`

Wrapped as a **JSON-encoded string** inside `metadata.user_id`:

```json
"metadata": {
  "user_id": "{\"device_id\":\"<64-char hex>\",\"account_uuid\":\"<UUID or empty>\",\"session_id\":\"<UUID>\"}"
}
```

| Field | Captured value pattern | Notes |
|---|---|---|
| `device_id` | 64-char hex (SHA-256 hash) | Stable per machine. Our captures: 1 unique value (one machine). |
| `account_uuid` | `""` in API-key mode | In real OAuth-mode CC, this is the user's account UUID. Our proxy injects `anthropic-organization-id` as a best-effort fallback (Phase 21). |
| `session_id` | UUID v4 | One per CC session (process). Stable within a session, regenerated next launch. Same value also appears in `x-claude-code-session-id` header. |

---

## 6. body top-level key variants by call pattern

| Keys | Count | Trigger |
|---|---|---|
| `model, messages, system, tools, metadata, max_tokens, thinking, context_management, output_config, stream` | 27 | Interactive thinking-enabled |
| `model, messages, system, tools, metadata, max_tokens, temperature, output_config, stream` | 10 | Non-thinking calls (some non-interactive) |
| `model, messages, system, tools, metadata, max_tokens, temperature, stream` | 4 | Same as above without `output_config` |
| `model, max_tokens, messages` | 1 | Minimal call (first call probe) |

Our snapshot's `bodyKeyOrder` follows variant 1 (most frequent). Client-supplied keys not in our order are appended at the end of the outbound body — covers variants 2/3 via `temperature` append. Variant 4 (the probe) keeps its own order since we don't fabricate missing keys.

---

## 7. Response headers (observed)

Anthropic responses contain these wire-fidelity-relevant headers (we already forward all of them; documenting for reference):

| Header | Value pattern |
|---|---|
| `anthropic-organization-id` | UUID (stable per subscription) — we learn this in `account-learner` |
| `anthropic-ratelimit-unified-5h-utilization` | `0.0`–`1.0` |
| `anthropic-ratelimit-unified-5h-status` | `allowed` / `allowed_warning` / `denied` |
| `anthropic-ratelimit-unified-5h-reset` | epoch seconds |
| `anthropic-ratelimit-unified-7d-*` | mirror of 5h, 7-day window |
| `anthropic-ratelimit-unified-overage-*` | mirror, overage bucket |
| `anthropic-ratelimit-unified-status` | overall (worst of buckets) |
| `anthropic-ratelimit-unified-representative-claim` | `five_hour` / `seven_day` / `overage` (driver bucket) |
| `anthropic-ratelimit-unified-fallback-percentage` | float |
| `request-id` | `req_011…` |

`service_tier` lives in body's `usage.service_tier`, not in headers.

---

## How to regenerate

```bash
# 1. ensure CAPTURE_MODE=true in .env
# 2. run a fresh CC session through the proxy (HOME-isolated)
# 3. analyze:
python3 docs/_analyze.py   # (this is informal; or re-run the inline script from chat)
```

For routine snapshot updates (header order, body key order, header values) use:

```bash
bun run synthesize-snapshot
```

This document is only needed when content-level analysis (tools list, system prompt size, beta variants) becomes relevant — typically Phase 20.
