# User guide

If your operator sent you a **proxy URL** and an **API key**, this page is for you. It walks through getting Claude Code on your laptop talking to that proxy.

> [한국어 가이드](./user-guide.ko.md)

## What your operator gives you

Two pieces of information — keep the second one private.

| Item | Example | Notes |
|---|---|---|
| Proxy URL | `http://<host-your-operator-sent-you>` | The IP or hostname your operator gave you. |
| API key | 64-char hex string (example shape: `9f1a…c3e7`) | **Treat as a password.** Anyone with this can spend the operator's Claude.ai quota. |

> The key is not your personal Anthropic API key — it's a per-user credential the operator issued specifically for you. It only works against this proxy.

## Prerequisites

- macOS (Linux notes inline where they differ; Windows: these instructions assume a Unix shell — ask your operator for guidance, or use WSL)
- [Claude Code CLI](https://claude.com/claude-code) installed
- A current Anthropic Claude Code build (`claude --version` ≥ `2.1.x`)

## Setup

### Recommended setup

This is the default. It gives you full Claude Code (hooks, CLAUDE.md auto-discovery, plugins, auto-memory) and the proxy key never collides with anything else in your keychain. Three steps, ~5 minutes.

#### Step 1. Clean up any existing keychain OAuth

**Skip this step if you run `claude` against your own Claude.ai account on this machine — even occasionally** (e.g. a few times a month for your own subscription). In that case, jump to [Alternative](#alternative-if-you-also-use-your-personal-claude-max-on-this-machine) below.

Otherwise, remove stale OAuth credentials so they can't accidentally win over the proxy key:

```bash
claude auth logout 2>/dev/null || true
security delete-generic-password -s "Claude Code-credentials" 2>/dev/null || true
security delete-generic-password -s "Claude Code" 2>/dev/null || true
rm -f ~/.claude/.credentials.json 2>/dev/null || true
```

Verify nothing OAuth-shaped remains:

```bash
security find-generic-password -s "Claude Code-credentials" 2>&1 | grep -q "could not be found" && echo "clean ✓"
```

> **Linux**: the equivalent is `secret-tool clear service "Claude Code"` if you use `libsecret`. Otherwise just confirm `~/.claude/.credentials.json` is gone.

#### Step 2. Store the proxy key in macOS Keychain

Save the key as its own Keychain item (this won't collide with any OAuth credential you might add later):

```bash
security add-generic-password \
  -a "$USER" \
  -s "claude-for-you-proxy" \
  -w '<PASTE_KEY_HERE>' \
  -U
```

Confirm — the key should be printed back:

```bash
security find-generic-password -a "$USER" -s "claude-for-you-proxy" -w
```

> **Linux** equivalents: [`pass`](https://www.passwordstore.org/) (`pass insert cfy/proxy-key`) or `secret-tool store --label='cfy proxy key' service claude-for-you-proxy account "$USER"`. A plaintext file with `chmod 600` works as a last resort but leaves the key on disk.

#### Step 3. Configure `~/.claude/settings.json`

Create a small helper script that prints the key on demand:

```bash
mkdir -p ~/bin
cat > ~/bin/cfy-key.sh <<'EOF'
#!/bin/bash
security find-generic-password -a "$USER" -s "claude-for-you-proxy" -w
EOF
chmod +x ~/bin/cfy-key.sh
```

> **Linux**: replace the body of `cfy-key.sh` with whichever secret backend you used in Step 2:
> - `pass`: `pass show cfy/proxy-key`
> - `secret-tool`: `secret-tool lookup service claude-for-you-proxy account "$USER"`

Then point Claude Code at the proxy and the helper. The path **must be absolute** — `~` and `$HOME` are not expanded by Claude Code:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "<PROXY_URL>"
  },
  "apiKeyHelper": "/Users/<your-username>/bin/cfy-key.sh"
}
```

Save to `~/.claude/settings.json`. If the file already exists with other keys (e.g. `theme`), keep those and add `env` and `apiKeyHelper` alongside them — `settings.json` is a single flat object:

```json
{
  "theme": "dark",
  "env": { "ANTHROPIC_BASE_URL": "<PROXY_URL>" },
  "apiKeyHelper": "/Users/<your-username>/bin/cfy-key.sh"
}
```

That's it. From now on, just run `claude` — no environment variables, no `--bare`, no inline keys.

> **First-run dialog**: macOS may prompt "Terminal wants to access Claude Code Keychain" the first time `cfy-key.sh` runs. Click **Always Allow** so it doesn't ask again. This is Keychain's access tracking — a feature, not a bug.

---

### Alternative: if you also use your personal Claude Max on this machine

> ⚠️ **Heads-up**: keeping a Claude.ai OAuth credential in your keychain alongside the proxy carries a small risk. If you ever run `claude auth login` again — or the OAuth refresh chain happens to rotate at the same moment the proxy is also refreshing the same token — you can end up locked out of both. The Recommended setup avoids this entirely by removing the personal OAuth. Only choose this Alternative if you knowingly need both on the same machine.

This setup is identical to the Recommended setup, with two differences:

- **Skip Step 1 (cleanup).** Your personal Claude.ai OAuth stays in the keychain.
- **In Step 3, omit `env.ANTHROPIC_BASE_URL`** from `settings.json`. Keep only `apiKeyHelper`:

  ```json
  {
    "apiKeyHelper": "/Users/<your-username>/bin/cfy-key.sh"
  }
  ```

Then activate the proxy explicitly only when you want it, via inline env or an alias:

```bash
# inline
ANTHROPIC_BASE_URL=<PROXY_URL> claude

# or persist as an alias in ~/.zshrc / ~/.bashrc
alias claude-proxy='ANTHROPIC_BASE_URL=<PROXY_URL> claude'
```

Without `ANTHROPIC_BASE_URL`, `claude` keeps using your personal Claude Max account exactly as before. Verify both modes with the banner check from [Verify it's working](#verify-its-working):

```bash
claude                                     # banner shows "Claude Max"
ANTHROPIC_BASE_URL=<PROXY_URL> claude      # banner shows "API Usage Billing"
```

---

### Debug / one-off check: `--bare` mode

For **one-time verification** or a CI environment where you don't want Claude Code reading anything from disk:

```bash
ANTHROPIC_BASE_URL=<PROXY_URL> \
ANTHROPIC_API_KEY=<PASTE_KEY_HERE> \
claude --bare
```

`--bare` skips hooks, CLAUDE.md auto-discovery, plugins, auto-memory, and background prefetches. **It's not meant for daily use** — you'll lose features. Use the Recommended setup for everyday work.

## Verify it's working

After starting `claude`, the top-left banner tells you which auth path is active:

| Banner shows | Meaning |
|---|---|
| `API Usage Billing` | Proxy key is being used. ✓ |
| `Claude Max` (or your personal plan name) | Keychain OAuth is winning. The proxy is **not** being used. |

If the banner shows your personal plan name and you followed the Recommended setup, see [Troubleshooting](#troubleshooting) below.

Quick functional check:

```bash
claude -p "reply with the single word: pong" --model claude-sonnet-4-6
```

Expected output: `pong`.

## Troubleshooting

### `Please run /login` / `401 Invalid authentication credentials`

Three common causes:

- **`apiKeyHelper` path is not absolute.** `~/bin/cfy-key.sh` or `$HOME/bin/cfy-key.sh` won't work — use the full `/Users/<your-username>/bin/cfy-key.sh`. Confirm with `cat ~/.claude/settings.json`.
- **Helper returns nothing.** Run `~/bin/cfy-key.sh` directly. If blank, two possibilities — first check if you dismissed the Keychain access dialog (see [Keychain access dialog keeps appearing](#keychain-access-dialog-keeps-appearing) below); if that isn't it, Step 2 (key storage) didn't take. Re-run the `security add-generic-password` command, then verify with `security find-generic-password -a "$USER" -s "claude-for-you-proxy" -w`.
- **Wrong API key.** Re-paste from the message your operator sent (no leading `alice:` or other prefix — paste the hex value only).

### Keychain access dialog keeps appearing

You clicked **Allow** instead of **Always Allow** on the first prompt. Run `~/bin/cfy-key.sh` once more and choose **Always Allow** this time.

### Top banner shows `Claude Max` instead of `API Usage Billing`

Your keychain still holds an OAuth credential that's outranking the proxy key. Either:
- Run Step 1 (cleanup) of the Recommended setup, or
- If you're intentionally on the Alternative, double-check `apiKeyHelper` returns the key with no trailing whitespace: `~/bin/cfy-key.sh | wc -c` should equal the key length your operator sent (e.g. `64` for a 64-char hex key). One extra means a trailing newline; the script above avoids this by using `security` (which omits the newline).

### `403 model_not_allowed`

Your key has a per-key model allowlist and you requested something outside it. The response body names which models *are* allowed for your key. Ask your operator to widen the allowlist (or stick to the listed models — for many casual users that means `claude-haiku-*` only).

### `429 rate_limit_error` on sonnet/opus, but haiku works

The proxy injects a default `system` field that Anthropic's backend requires for premium models on Claude.ai OAuth tokens — this `system`-prefix injection runs on every request and is invisible to you, so this specific `rate_limit_error` shouldn't reach the client. If you see it anyway:
- Your client may be sending an explicit empty `system` (`"system": ""`). Either remove the field or use a non-empty string.
- Ask your operator to confirm the proxy is on a recent commit.

(Note on terminology: the proxy surfaces *upstream* `429`s — including `Retry-After` and `X-Should-Retry` headers — to the client verbatim, so the SDK's backoff can do its job. The signature above is a different class of `429` that comes from a missing `system` prefix and is fixed inside the proxy.)

### `[1m]` models / 1M context — works as of 2026-05-29

The 1M context window is fully supported via the gateway. Use the `[1m]` model variant from your client (e.g. select `claude-sonnet-4-6[1m]` via `/model` in Claude Code) and the proxy will forward the `context-1m-2025-08-07` beta flag through to upstream.

History note: between 2026-05-28 and 2026-05-29 the proxy was incorrectly stripping `context-1m-*` and rejecting bodies over 1MB based on a misdiagnosed 429. That behavior is gone; if you have a stale operator using an older commit (pre-`be2e4b4`), they should redeploy.

If you DO see a `429 "Usage credits are required for long context requests"` now, that's a real upstream message — the subscription account's long-context usage budget is exhausted. Wait for the rate-limit reset window or contact your operator.

### A brand-new model (e.g. Fable) is missing from `/model`

When Anthropic ships a **new model family**, direct-API users see it after upgrading Claude Code, but through a proxy it only appears if your client asks the gateway for the model list. Set this in your environment (same place you export other Claude Code vars), then restart `claude`:

```bash
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
```

It's off by default and needs Claude Code ≥ 2.1.129. New *versions* of models you already see (e.g. opus/sonnet moving up a version) do **not** need this — only brand-new families like Fable. If it's still missing after setting the flag and restarting, ask your operator to confirm the proxy serves `/v1/models`.

### `Please run /login` on every restart

If you're on the Recommended setup, this usually means `~/.claude/settings.json` got reverted or has a typo. Run `cat ~/.claude/settings.json` and confirm `apiKeyHelper` is an absolute path and `env.ANTHROPIC_BASE_URL` is set.

If you're on the Alternative with inline `ANTHROPIC_BASE_URL`, persist it as a shell alias instead of a plain `export`:

```bash
# in ~/.zshrc or ~/.bashrc
alias claude-proxy='ANTHROPIC_BASE_URL=<PROXY_URL> claude'
# do NOT put ANTHROPIC_API_KEY in a shared/committed rc file —
# apiKeyHelper already handles the key.
```

## Security notes

- **Never commit the API key.** The Recommended setup keeps it in macOS Keychain (encrypted by the OS); the helper script just prints it on demand and never writes it to disk.
- **Never paste the key into a public chat, gist, or issue tracker.** A leaked key lets anyone burn the operator's Claude.ai quota.
- If you suspect the key leaked, tell the operator immediately. They can revoke it from `/admin` and issue a new one.
- The proxy operator can see request metadata (model used, token counts, timestamps) but **not** your prompts or responses — those pass through end-to-end. Still: treat the proxy as a trusted-but-shared resource and apply normal "what would I send to a coworker" judgment.

## Frequently asked

**I was previously told to run `claude --bare`. What changed?**
The `--bare` flow was a workaround for keychain OAuth colliding with the proxy key. The Recommended setup solves that collision properly (by removing the keychain OAuth and storing the proxy key as a separate Keychain item), and gives you back all of Claude Code's features — hooks, CLAUDE.md auto-discovery, plugins, auto-memory. `--bare` still works for one-off verification, but it's not the right default.

**Can I use this for SDK / API calls (not Claude Code)?**
Yes. The proxy speaks the Anthropic Messages API. Point `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` at it from any Anthropic SDK. Streaming and tool use work.

**Does my personal `claude` account get affected?**
If you followed the Recommended setup with Step 1, your personal OAuth was removed and you'll need to `claude auth login` again if you want to use your personal account on this machine. If you used the Alternative, your personal Claude Max OAuth stays in the keychain untouched — without `ANTHROPIC_BASE_URL`, `claude` uses your personal account exactly as before.

**What model do I get?**
Whatever model you request (`--model claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`). The proxy doesn't restrict models. The Claude.ai plan behind the proxy decides whether premium models are usable.

**How do I know how much I've used?**
Your operator can check `GET /admin` → "per-user usage (UTC today)" for the per-key counter. Ask them.
