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
- **Cache control**: caller-emitted blocks carry `cache_control: { type: "ephemeral" }` for prompt caching (not shown above — strip when reusing captured blocks as synthesized values). Note: §2a below covers a *separate* proxy-emitted CC_BLOCK that also carries `cache_control: { type: 'ephemeral' }` — same syntax, different owner. Do not confuse the two when reading wire captures.

---

## 2a. Entitlement marker invariant

> **[Current state — active (post-#96)]** The conditional shape exception described below (`UNLESS the caller's system array already contains a canonical CC marker block`) is **active in production code** as of #96 (B3 strict gate) merge. `src/proxy/messages.ts` `ensureSystem` skips the prepend when `isCanonicalCcMarker` matches any element of the caller's `system` array, and falls back to unconditional prepend otherwise. See `docs/operational-pitfalls.md` #15 for migration history and cost rationale.

Section 2 above describes the `system` array that **callers** send. This section describes a separate, proxy-owned block that **we prepend** to that array before forwarding upstream. Do not conflate the two — Section 2's `x-anthropic-billing-header:` block is caller-emitted; the invariant block below is proxy-emitted.

### Why this exists

Anthropic's Claude.ai-OAuth-issued tokens require the upstream `system` array to start with a specific identity block when calling sonnet/opus. Without it, sonnet returns `rate_limit_error` (HTTP 429) — same response shape as a real quota hit, which is exactly what caused the 2026-06-02 misdiagnosis fixed in PR #41. haiku does not enforce this.

### The invariant value

`src/proxy/messages.ts`, the `CC_SYSTEM_PREFIX` constant:

```
You are Claude Code, Anthropic's official CLI for Claude.
```

**Behavior**: `ensureSystem()` has two branches:

1. **Transparent passthrough** — when the caller's `system` array already contains a canonical CC marker block (see "Canonical CC marker shape" below), `ensureSystem` returns a shallow-copied caller array with no prepend. At wire level, the caller-supplied canonical block satisfies the entitlement gate's identity requirement byte-identically to a proxy-emitted one. Real CC client traffic flows through this branch (real CC ships its CC marker at `system[1]` after the billing header — see Section 2 capture data and pitfall #15 cost evidence).
2. **Unconditional prepend** — when the caller's `system` is a string, an empty/missing value, or an array without a canonical marker, `ensureSystem` prepends `{ type: 'text', text: CC_SYSTEM_PREFIX, cache_control: { type: 'ephemeral' } }` as the first element. Tomodachi-style bots and SDK clients without the marker flow through this branch — the PR #41 entitlement fix is preserved.

`src/admin/test-runners.ts` imports `CC_SYSTEM_PREFIX` for self-test, so drift between the proxy path and the probe path is impossible by construction. The `verify-entitlement` probe sends `system: CC_SYSTEM_PREFIX` as a string, which always traverses the prepend branch — see "Probe path divergence" below.

The `cache_control: { type: 'ephemeral' }` field is a prefix-hash anchor — without it the prepend silently pushes caller cache_control breakpoints one slot deeper and breaks Anthropic prompt cache matching (issue #55). It also consumes one of the 4 cache_control breakpoints Anthropic counts across system+messages+tools combined — a trade-off documented at the patch site (`src/proxy/messages.ts`).

### Canonical CC marker shape

A caller-emitted `system` block is recognized as a "canonical CC marker block" (and thus triggers the transparent passthrough described above, post-#96) only when ALL THREE of these match exactly:

1. `type === 'text'`
2. `text === CC_SYSTEM_PREFIX` (byte-identical exact match against the constant in `src/proxy/messages.ts`)
3. `cache_control` is an object AND `cache_control.type === 'ephemeral'` — i.e. the block carries `cache_control: { type: 'ephemeral' }` verbatim

**Position policy**: anywhere in the array (lenient). Empirical evidence is in `docs/operational-pitfalls.md` #15 "Cost evidence — PRE PR41 (2026-06-02) raw capture" — at that time CC version 2.1.149.27c emitted its CC marker block at `system[1]` (after the `x-anthropic-billing-header:` block at `system[0]`), so strict `system[0]`-only matching would fail real-CC traffic. Lenient matching covers any position; this also future-proofs against further CC version shifts that may move the marker. (Section 2 above documents an older CC 2.1.126 snapshot whose `system[1]` was the system prompt body, not a separate CC marker — the marker block emerged in a later CC version.)

**Probe path divergence**: `src/admin/test-runners.ts`'s `verify-entitlement` probe sends `system: CC_SYSTEM_PREFIX` as a string. The transparent branch matches only array elements that satisfy the canonical shape, so the probe path never enters it — it always traverses the unconditional prepend path. The `ok` verdict therefore validates entitlement-gate behavior for the prepend path only; the transparent branch's gate compliance is structurally guaranteed — the caller-supplied canonical block IS the entitlement marker, so wire-level identity is satisfied byte-identically regardless of who emits it. Operators: treat `ok` as a marker-drift signal, NOT as a transparent-branch health check.

**ToS rationale**: the proxy's responsibility under Anthropic ToS is to emit CC-shaped traffic upstream when calling sonnet/opus. When a caller already emits a canonical CC marker block, the wire-level identity requirement is satisfied byte-identically — Anthropic cannot distinguish proxy-emitted vs caller-emitted bytes of equivalent shape. The transparent branch therefore satisfies the same wire-level identity claim as the prepend path with a different ownership model: caller-supplied marker counts toward identity compliance once it byte-matches the canonical shape (this is the analytic basis for the policy reversal documented in `docs/operational-pitfalls.md` #15; #41's R1 forge-protection rejection of this branch was made before the caching cost was quantified — see issue #59 for the cost evidence that re-opened the trade-off).

### Drift signature

If Anthropic changes the gate (different required text, additional metadata, removed requirement, etc.), the entitlement check stops matching and sonnet/opus regress to `rate_limit_error` (429). This is **byte-identical** to a real quota error in the response body, which makes it indistinguishable in logs without the drift probe.

### Drift verdict matrix

The admin `verify-entitlement` probe fires two calls back-to-back against sonnet:

- **A**: `system: CC_SYSTEM_PREFIX` (expected 200)
- **B**: no `system` block (expected 429)

The (statusA, statusB) pair maps to one of five verdicts:

| status_A | status_B | verdict | meaning |
|---|---|---|---|
| 200 | 429 | `ok` | marker is gating sonnet correctly |
| 200 | 200 | `marker-drift` | gate passes without marker — #41 regression signature |
| 429 | 429 | `account-issue` | entitlement-orthogonal failure (quota / account state) |
| 429 | 200 | `reversed` | signal inverted — wire reference needs recapture |
| any other (5xx, 4xx, transport error) | — | `inconclusive` | not safe to conclude |

Only `ok` sets the operator-facing `ok=true`. See Section 8 for how to run this probe.

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

## 8. Periodic entitlement verification

The marker invariant in Section 2a is a hard-coded string that Anthropic could change at any time. Without periodic verification, the next drift event repeats the 2026-06-02 misdiagnosis — same 429 `rate_limit_error` shape, same look as a quota hit.

### How to run

1. Open `/admin`.
2. In the **self-test** section, find the `verify entitlement` form.
3. Optionally change the model (default `claude-sonnet-4-6`). The probe only works against models that enforce the gate — haiku will not produce a useful comparison.
4. Click **probe marker**. The probe sends two parallel calls to `api.anthropic.com` (one with the marker, one without) and records the verdict in the live region above.

### How to interpret

Result summary format: `{verdict} · A={statusA} B={statusB} · {latencyMs}ms · model={model} (member={poolMember})`

- `ok` — keep going. Re-run after the next CC version bump or quarterly, whichever comes first.
- `marker-drift` — **immediate action**. The proxy's gate-passing assumption is dead. Recapture wire (`CAPTURE_MODE=true`, fresh CC session, diff against `src/template/cc-snapshot.json`), find the new identity requirement, update `CC_SYSTEM_PREFIX`.
- `account-issue` — entitlement is fine. Check pool member health (`oauth-probe`), quota, and `anthropic-ratelimit-*` headers.
- `reversed` — wire reference is stale. Section 2a's invariant value no longer matches what Anthropic checks. Recapture before drawing conclusions.
- `inconclusive` — transport hiccup or unexpected status. Re-run. If it persists, treat as `account-issue` until the network stabilizes.

### Caveat: 200 OK with a rate_limit_error body

`classifyEntitlement` reads HTTP status only. In the (rare) case Anthropic returns `HTTP 200 OK` while the response body carries a `rate_limit_error` JSON, the recorded verdict diverges from reality. Two sub-cases:

1. **Both calls 200 OK, both bodies are rate_limit_error JSON** → verdict shows `marker-drift`, real state is `account-issue`.
2. **A returns 200 (rate_limit_error body), B returns 429** → verdict shows `ok`, real state is also `account-issue` (A's success was illusory).

Before acting on `marker-drift`, inspect the **A body** in the result detail — if it contains `"type":"rate_limit_error"`, treat as `account-issue` and re-run after the rate-limit window resets. The `ok` sub-case is silently misleading; a quarterly cross-check against `oauth-probe` or `self-ping` is the practical defence.

Coded mitigation is deferred: observed Anthropic behavior is "non-200 status for rate-limit errors". If `classifyEntitlement` ever needs body sniffing, this section is the trigger to re-evaluate.

### ⚠️ Why this probe is rare-fire — abuse signal cost

Call B intentionally sends a sonnet/opus request **without** the CC identity marker. That is, by design, a request shape that a legitimate Claude.ai-OAuth client would never emit — the marker is always prepended by CC. From Anthropic's side, that is indistinguishable from probing / reconnaissance / "trying to bypass entitlement gating". The 429 we receive is not a quota hit — it is the gate refusing an unauthorized identity.

Running this probe frequently means asking our own OAuth token to do that repeatedly. Plausible consequences (ordered by likelihood, not by severity):

- **Per-token trust score downgrade.** The token starts looking like an anomalous client. Other calls through the same token may be subjected to stricter gates.
- **Cool-down on the token.** Anthropic could rate-limit *other* legitimate calls from the same token for a window after a burst of marker-less requests.
- **Abuse-monitoring alert + human review.** Anthropic security may need to be told this is a self-test, not an attempted gate bypass. Justifying the pattern after the fact is more expensive than not triggering it.
- **Worst case: token revocation.** Low probability but non-zero — repeated automated marker-less traffic from one token over time fits no legitimate usage pattern we can think of.

**Operational rule of thumb**: treat each `verify-entitlement` click like a manual rate-limit-bypass probe — because that is what it looks like from the upstream's perspective. Do not script it. Do not put it on a cron. Use the schedule below.

### When to run

- **After every CC version bump.** New CC versions may carry new identity expectations that we synthesize into the snapshot but not into this invariant.
- **Quarterly baseline.** Catches silent gate changes that don't correlate to any visible release.
- **Before blaming the proxy for a 429 incident.** If `verify-entitlement` returns `ok` while a separate probe returns 429, the issue is account-level, not marker-level. Caveat: a verdict of `ok` can still hide an `account-issue` when A returns 200 with a `rate_limit_error` body — see the sub-case 2 in the caveat above. If `ok` and the incident persists, cross-check with `oauth-probe` or `self-ping` before treating the result as authoritative.

**Do NOT**:

- Bind this probe to a periodic cron job. The whole point of the cadence above is that humans decide each invocation.
- Run it across the pool — one click probes the served pool member, which is enough signal.
- Re-click to "double check". A single result + a follow-up `oauth-probe` or `self-ping` is more informative and costs zero abuse signal.

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
