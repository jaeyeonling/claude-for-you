# User guide

If your operator sent you a **proxy URL** and an **API key**, this page is for you. It walks through getting Claude Code on your laptop talking to that proxy.

> [한국어 가이드](./user-guide.ko.md)

## What your operator gives you

Two pieces of information — keep the second one private.

| Item | Example | Notes |
|---|---|---|
| Proxy URL | `http://43.202.105.69` | Public address of the proxy. Safe to share. |
| API key | 64-char hex string (example shape: `9f1a…c3e7`) | **Treat as a password.** Anyone with this can spend the operator's Claude.ai quota. |

> The key is not your personal Anthropic API key — it's a per-user credential the operator issued specifically for you. It only works against this proxy.

## Prerequisites

- macOS or Linux (Windows works but path examples below assume macOS/Linux shells)
- [Claude Code CLI](https://claude.com/claude-code) installed
- A current Anthropic Claude Code build (`claude --version` ≥ `2.1.x`)

## Two ways to connect

Pick **one**:

### Option A — `apiKeyHelper` (recommended, keeps your personal Claude Max OAuth)

Best if you already use `claude` against your own Claude.ai account on the same machine. `apiKeyHelper` makes Claude Code use the proxy key over the keychain OAuth, without removing the keychain entry. Your normal `claude` (without `ANTHROPIC_BASE_URL`) still uses your personal account.

```bash
mkdir -p ~/.claude
cat > ~/.claude/settings.json <<'JSON'
{
  "apiKeyHelper": "echo <PASTE_KEY_HERE>"
}
JSON
```

Then either set the base URL inline:

```bash
ANTHROPIC_BASE_URL=<PROXY_URL> claude
```

Or persist it (and optionally alias):

```bash
# in ~/.zshrc or ~/.bashrc
export ANTHROPIC_BASE_URL=<PROXY_URL>
alias claude-proxy='ANTHROPIC_BASE_URL=<PROXY_URL> claude'
```

### Option B — `--bare` mode (simpler, but skips some Claude Code features)

If you don't need plugins, hooks, CLAUDE.md auto-discovery, or background prefetches:

```bash
ANTHROPIC_BASE_URL=<PROXY_URL> \
ANTHROPIC_API_KEY=<PASTE_KEY_HERE> \
claude --bare
```

`--bare` is the cleanest way to guarantee the proxy key is used and keychain OAuth is **never** read. The trade-off is documented in `claude --help`.

## Verify it's working

After starting `claude`, the top-left banner tells you which auth path is active:

| Banner shows | Meaning |
|---|---|
| `API Usage Billing` | Proxy key is being used. ✓ |
| `Claude Max` (or your personal plan name) | Keychain OAuth is winning. The proxy is **not** being used. |

If you see your personal plan name, the keychain is overriding the proxy key. Use Option B (`--bare`) instead, or double-check the `apiKeyHelper` path.

Quick functional check from a separate terminal:

```bash
ANTHROPIC_BASE_URL=<PROXY_URL> \
ANTHROPIC_API_KEY=<KEY> \
claude --bare -p "reply with the single word: pong" --model claude-sonnet-4-6
```

Expected output: `pong`.

## Troubleshooting

### `Please run /login` / `401 Invalid authentication credentials`

Almost always one of:
- Inline-env was used without `--bare`, and the interactive UI tried a side-channel call with the keychain OAuth that the proxy can't authenticate. Use Option B.
- API key is wrong. Re-paste from the message your operator sent (no leading `alice:` or other prefix — paste the hex value only).

### Top banner shows `Claude Max` instead of `API Usage Billing`

The proxy key isn't being applied to outbound calls. Two fixes:
- Switch to `claude --bare` (Option B).
- If you used Option A, make sure `~/.claude/settings.json` is valid JSON and `apiKeyHelper` returns exactly the key with no extra whitespace: `echo -n <KEY>` (or just `echo <KEY>`).

### `429 rate_limit_error` on sonnet/opus, but haiku works

The proxy itself should handle this transparently — it injects a default `system` field that Anthropic's backend requires for premium models on Claude.ai OAuth tokens. If you see it anyway:
- Your client may be sending an explicit empty `system` (`"system": ""`). Either remove the field or use a non-empty string.
- Ask your operator to confirm the proxy is on commit `f9982a8` or later.

### `Please run /login` on every restart

Your shell didn't keep the env vars. Persist them in `~/.zshrc` / `~/.bashrc`:

```bash
export ANTHROPIC_BASE_URL=<PROXY_URL>
# leave ANTHROPIC_API_KEY out of the rc file if your machine is shared —
# use apiKeyHelper (Option A) instead.
```

## Security notes

- **Never commit the API key.** If you put it in a shell rc file, that file must be private (`chmod 600`).
- **Never paste the key into a public chat, gist, or issue tracker.** A leaked key lets anyone burn the operator's Claude.ai quota.
- If you suspect the key leaked, tell the operator immediately. They can revoke it from `/admin` and issue a new one.
- The proxy operator can see request metadata (model used, token counts, timestamps) but **not** your prompts or responses — those pass through end-to-end. Still: treat the proxy as a trusted-but-shared resource and apply normal "what would I send to a coworker" judgment.

## Frequently asked

**Can I use this for SDK / API calls (not Claude Code)?**
Yes. The proxy speaks the Anthropic Messages API. Point `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` at it from any Anthropic SDK. Streaming and tool use work.

**Does my personal `claude` account get affected?**
No. With Option A, your personal Claude Max OAuth stays in the keychain untouched. Without `ANTHROPIC_BASE_URL`, `claude` uses your personal account exactly as before.

**What model do I get?**
Whatever model you request (`--model claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`). The proxy doesn't restrict models. The Claude.ai plan behind the proxy decides whether premium models are usable.

**How do I know how much I've used?**
Your operator can check `GET /admin` → "per-user usage (UTC today)" for the per-key counter. Ask them.
