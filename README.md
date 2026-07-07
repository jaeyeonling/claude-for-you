# claude-for-you

> Self-hosted Anthropic-compatible proxy. One Claude.ai subscription, a handful of API keys, your trusted few.

[![CI](https://github.com/jaeyeonling/claude-for-you/actions/workflows/ci.yml/badge.svg)](https://github.com/jaeyeonling/claude-for-you/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun%201.3+-fbf0df.svg)](https://bun.sh)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

[한국어 README](./README.ko.md) · Bun · Hono · Caddy · PostgreSQL · Terraform

---

## ⚠️ Before you read further

**This project likely violates Anthropic's Terms of Service.**

Anthropic's Consumer Terms, Acceptable Use Policy, and Subscription Terms generally prohibit **sharing or reselling individual subscription accounts**. This proxy exposes one Claude.ai OAuth token to multiple downstream API consumers, and you must read those terms yourself before deciding whether your use case is permissible.

If Anthropic determines that you are in violation, possible consequences include **account suspension, subscription cancellation, refund refusal, and legal action**.

The maintainers and contributors of this project accept **no responsibility for any outcome arising from its use**. Use is entirely at your own risk. We recommend at most close family or a small handful of trusted collaborators — running this as a public SaaS is **almost certainly a clear ToS violation**.

If you do not agree with this disclaimer, **do not use this tool**.

---

## What it is

A reverse proxy that turns one Claude.ai subscription's OAuth credentials into an API-key gateway, with active **wire-fidelity defenses** so requests look like real Claude Code traffic on the network.

```mermaid
flowchart LR
    Client[CC / curl / SDK]
    Caddy[Caddy<br/>TLS · ACME]
    Bun[Bun proxy<br/>:3456]
    Pool[Account Pool<br/>OAuth refresh]
    Anthropic[api.anthropic.com]
    PG[(Postgres<br/>usage)]
    SSM[(SSM Parameter Store<br/>SecureString)]
    Admin[/Admin UI<br/>token · webhook rotation/]

    Client -->|x-api-key| Caddy
    Caddy -->|HTTP/2 internal| Bun
    Bun -->|TLS ClientHello matches CC| Anthropic
    Bun --> Pool
    Bun --> PG
    Bun -.-> Admin
    SSM -. boot .-> Bun
    Pool --> Anthropic
```

**Why anyone built this**

- Anthropic does not offer a team-shared subscription tier.
- The direct API costs roughly 4× a Pro subscription for moderate usage.
- Two or three trusted users routed through one subscription is a different question from "running a SaaS". The latter is plainly off-limits; the former is the gray area this tool occupies.

## What's interesting under the hood

These are the parts most projects in this category don't bother with:

- **Capture → synthesize → replay loop.** A `CAPTURE_MODE` middleware records the exact HTTP wire shape of real Claude Code traffic in TCP arrival order (via `@hono/node-server` because Web `Headers` would sort alphabetically and destroy the fingerprint). `scripts/synthesize-snapshot.mjs` folds N captures into `cc-snapshot.json` containing dominant header order, header values, body key order, and inter-request pacing distribution. The proxy replays the snapshot at runtime; older snapshots auto-warn.
- **Account pool routing.** Multiple Claude.ai subscriptions are weighted by Anthropic's `anthropic-ratelimit-unified-remaining` header, with same-`x-claude-code-session-id` requests pinned to one account so the upstream prompt cache stays warm. The pool's job is **per-session token routing + 401 refresh fallback**, not quota distribution — same-org pool members share Anthropic's 5h/7d quota, so a 429 is surfaced to the client verbatim (with `Retry-After` / `X-Should-Retry`) and the SDK's own backoff handles it. See `docs/operational-pitfalls.md` #18.
- **Canary deploys for wire shape.** Drop a `cc-snapshot.candidate.json` next to the stable one, set `CANARY_PERCENT`, and a slice of traffic uses the candidate template. Any candidate-served response with `service_tier ≠ "standard"` trips the canary and routes the rest back to stable — **automatic rollback before money starts leaking**.
- **Drift root-cause analyzer.** When `service_tier` flips off `standard`, the resulting Discord alarm includes a diff of request fingerprints (header names, body keys, beta flags, models) between the 5 minutes before and after the alarm. "3am page" becomes "the offender is this header that started appearing 4 requests ago."
- **Operator-managed token + webhook rotation.** Refresh tokens, access tokens, and Discord/Slack webhook URLs can be rotated from the admin UI without restart — no SSH, no `aws ssm put-parameter`.

## Quickstart (Docker Compose, local)

```bash
# 1. Local Postgres for usage tracking
docker compose --profile dev up -d postgres

# 2. .env from template
cp .env.example .env
# fill in ANTHROPIC_OAUTH_REFRESH_TOKEN, API_KEYS, DATABASE_URL

# 3. Run on the host with hot reload
bun install
bun run dev
```

Then `curl -H "x-api-key: $YOUR_KEY" -X POST http://127.0.0.1:3456/v1/messages …` against it as if it were `api.anthropic.com`.

## Quickstart (EC2 + RDS, Terraform)

```bash
# 1. SSH key pair for SSM is unnecessary — sessions go through AWS Systems Manager
brew install --cask session-manager-plugin gh

# 2. Customize terraform.tfvars (optional — defaults work for most cases)
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
cd terraform && terraform init && terraform apply

# 3. (Private repo only — required before deploy.sh) register an SSH deploy key.
#    See terraform/README.md → "Private-repo support" for the full 4-step flow:
#    ssh-keygen → aws ssm put-parameter /claude-for-you/github-deploy-key →
#    gh repo deploy-key add → shred local copy.
#    Public repos: skip this step; cloud-init clones anonymously.

# 4. Upload .env contents as an encrypted SSM parameter
aws ssm put-parameter \
  --name /claude-for-you/env \
  --value "$(cat .env)" \
  --type SecureString --overwrite \
  --region ap-northeast-2

# 5. SSM-session into the instance and bring the stack up
aws ssm start-session --target $(terraform output -raw instance_id) --region ap-northeast-2
$ sudo /usr/local/bin/fetch-env.sh
$ cd /home/ec2-user/claude-for-you && sudo docker build -t claude-for-you:latest . && sudo docker compose up -d
```

The terraform module provisions: EC2 (t3.micro, AL2023, IMDSv2 required, SSM-only access — no port 22), RDS Postgres (t4g.micro, single-AZ, encrypted), Elastic IP, IAM role scoped to the three SSM parameters this proxy owns (`/claude-for-you/env`, `/claude-for-you/database-url`, `/claude-for-you/github-deploy-key`).

## Configuration

| Env var | Default | Notes |
|---|---|---|
| `PORT` | `3456` | The internal proxy port. Caddy fronts it on 80/443. |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` in containers. |
| `ANTHROPIC_OAUTH_REFRESH_TOKEN` | _(required, single-account mode)_ | `sk-ant-ort01-…` from a Claude.ai session. |
| `ANTHROPIC_OAUTH_ACCESS_TOKEN` | _(optional)_ | Skip and the first request will refresh. |
| `ANTHROPIC_OAUTH_EXPIRES_AT` | _(optional)_ | Epoch ms. |
| `ACCOUNTS_PATH` | `./data/accounts.json` | Multi-account pool config. Overrides single-account env vars when present. |
| `API_KEYS` | _(required)_ | `name1:key1,name2:key2`. Generate with `openssl rand -hex 32`. |
| `API_KEYS_PATH` | _(optional)_ | Mutable file-based store. Required if you want self-serve add/revoke from the admin UI. |
| `DATABASE_URL` | _(required in production)_ | `postgres://user:pass@host:port/db`. Falls back to in-memory tracking when unset (dev only). |
| `DAILY_TOKEN_LIMIT_PER_KEY` | `0` (unlimited) | Per-key cap, UTC reset. |
| `GLOBAL_SUBSCRIPTION_THRESHOLD_TOKENS` | `0` (off) | Refuse new requests when Anthropic's reported headroom falls below this. |
| `MAX_CONCURRENT_REQUESTS` | `8` | Application-layer concurrency cap. 429 once exceeded. |
| `PER_IP_RATE_LIMIT_PER_SECOND` | `0` (off) | Per-IP token bucket on `/v1/messages`. Burst = 2×. Defense-in-depth when behind Caddy without the `rate_limit` module. |
| `TOKEN_STORE_PATH` | `./data/tokens.json` | Where the OAuth manager persists refreshed tokens. Mount as a volume in containers. |
| `DISCORD_WEBHOOK_URL` | _(optional)_ | Primary alert channel. |
| `SLACK_WEBHOOK_URL` | _(optional)_ | Fallback when Discord is unset. |
| `DOMAIN` | _(required by Caddy)_ | FQDN for ACME, or `:80` for HTTP-only IP-only deployments. |
| `LOG_LEVEL` | `info` | `debug` enables the per-request access log. |
| `PACING_MIN_GAP_MS` | `0` | Min ms between two outbound requests sharing the same session id. `0` = use snapshot p50. |
| `ACCOUNT_UUID_OVERRIDE` | _(optional)_ | Force a specific account UUID. Leave empty to learn from response headers. |
| `CANARY_PERCENT` | `0` | % of traffic that uses `cc-snapshot.candidate.json` when present. |
| `CAPTURE_MODE` | `false` | Dump every authenticated request to `CAPTURE_DIR`. Never enable in production. |
| `CAPTURE_DIR` | `./captures` | Where capture dumps go. Gitignored. |

## Giving someone access

You issue them a key, then send them two things plus a link to the user guide.

```bash
# operator side — issue a new key
curl -sS -u admin:<your-key> http://<proxy-host>/admin/keys \
  -H 'content-type: application/json' \
  -d '{"name":"bob"}'
# response includes the key value — shown once, never again.

# Restrict by model family (haiku-only for a casual user)
curl -sS -u admin:<your-key> http://<proxy-host>/admin/keys \
  -H 'content-type: application/json' \
  -d '{"name":"carol", "allowedModels": ["claude-haiku-*"]}'
# Restricted users hit 403 model_not_allowed if they request a denied model.
# Omit `allowedModels` (or pass []) for no restriction. Patterns accept exact
# ids ("claude-haiku-4-5-20251001") or trailing-wildcard families
# ("claude-sonnet-*"). Env-baked keys (API_KEYS=…) cannot carry allowedModels —
# use api-keys.json for restricted users.
# Caps: max 50 patterns per key, each pattern ≤128 chars. Trips return
# 400 `allowed_models_too_many` / `invalid_model_pattern`.
# <!-- CAP-DOCS: keep 50/128 in sync with MAX_ALLOWED_MODELS_PER_KEY
#      (src/auth/api-key-store.ts) and MAX_MODEL_PATTERN_LENGTH
#      (src/auth/model-allow.ts). UI labels auto-update from those
#      constants; this doc snippet does not. -->

# Edit an existing file-issued key (rename or change allowedModels)
curl -sS -u admin:<your-key> -X PATCH \
  http://<proxy-host>/admin/keys/carol \
  -H 'content-type: application/json' \
  -d '{"allowedModels": ["claude-haiku-*", "claude-sonnet-4-6"]}'
# Or via the admin UI's "edit api key" panel. Name field is readonly by
# default — tick the rename checkbox to enable. Env-baked keys reject
# with 400 `env_source_immutable` — change API_KEYS env and redeploy.
```

Message you send them:

> Proxy URL: `http://<proxy-host>`
> API key: `<value from the response above>`
> Setup: [`docs/user-guide.md`](./docs/user-guide.md) — follow the **Recommended setup**.
> To see brand-new model families (e.g. Fable) in `/model`, also set `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` in your environment (see [Model discovery](#model-discovery-new-model-families) below).

The user guide covers the Recommended setup (Keychain + `apiKeyHelper`), the `API Usage Billing` banner check, the usual 401 / 429 traps, and an Alternative for users who keep their personal Claude Max on the same machine. Korean translation at [`docs/user-guide.ko.md`](./docs/user-guide.ko.md).

## Model discovery (new model families)

When a brand-new model **family** ships (e.g. Fable, `claude-fable-5`), it appears in a proxied user's Claude Code `/model` picker only when **both** of these hold:

1. **The proxy serves `GET /v1/models`.** It does — the endpoint forwards to Anthropic's upstream model list using the pool's OAuth token, so new families surface automatically with no proxy change.
2. **The client opts into gateway discovery.** Each user sets `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` (off by default; needs Claude Code ≥ 2.1.129). Without it, Claude Code never calls `/v1/models` and new families stay hidden — this is the usual reason a proxied user doesn't see a model their direct-API colleagues already see.

Model *version* bumps within an existing family (e.g. `claude-opus-4-7` → `claude-opus-4-8`) need neither flag nor endpoint: they ride Claude Code's built-in `opus` / `sonnet` / `haiku` aliases, which resolve to the current concrete version upstream at request time.

Verify from the operator side:

```bash
curl -sS "$ANTHROPIC_BASE_URL/v1/models?limit=1000" -H "x-api-key: <proxy-key>" | jq '.data[].id'
# should list claude-fable-5 among the models
```

Full troubleshooting: [`docs/operational-pitfalls.md` §21](./docs/operational-pitfalls.md).

> **Restricted keys.** `GET /v1/models` returns the full upstream list unfiltered, so a user whose `allowedModels` excludes a family will *see* it in the picker but hit `403 model_not_allowed` at send time. Add the family (e.g. `claude-fable-*`) to their key to make it usable.

## Admin endpoints

All `/admin/*` routes require API-key auth (the proxy's authorized keys list — pick any key). CSRF guard rejects cross-origin browser POSTs.

| Route | Method | Purpose |
|---|---|---|
| `GET /admin` | — | Operator dashboard. Billing health, account pool headroom, canary state, per-user usage, forms below. |
| `GET /admin/stats` | — | Same data as JSON. |
| `POST /admin/keys` | JSON | Self-serve add — `{ name, key?, allowedModels? }`. Requires `API_KEYS_PATH`. `allowedModels` entries accept exact ids or `family-*` wildcards; **max 50 entries per key, each ≤128 chars** (see [CAP-DOCS](#giving-someone-access) note above). |
| `PATCH /admin/keys/:name` | JSON | Edit a file-issued key in place — `{ newName?, allowedModels? }`. Same caps as `POST`. Form mirror at `POST /admin/keys/:name/update`. Env-baked keys reject with `env_source_immutable`. Also supports `newName` for renames; e.g. `-d '{"newName":"carol-restricted"}'`. |
| `DELETE /admin/keys/:name` | — | Revoke a key. Form mirror at `POST /admin/keys/:name/revoke`. |
| `POST /admin/oauth/replace` | form/JSON | Paste a fresh refresh token. Next request mints a new access token. `memberName=default` for single-account mode. |
| `POST /admin/alerts/discord` | form | Rotate Discord webhook URL. Empty `url` clears it. |
| `POST /admin/alerts/slack` | form | Same for Slack. |
| `POST /admin/snapshot/promote` | form | Promote `cc-snapshot.candidate.json` over the stable snapshot. Requires container restart to take effect. |
| `POST /admin/snapshot/rollback` | form | Delete the candidate. |

## Operations

- **Token rotation.** Open `/admin`, paste a fresh refresh token, submit. No restart. The pool resets headroom estimates so the next request re-learns.
- **Webhook rotation.** Same UI. Persisted to `/data/alerts.json`; the file overrides the env baseline even after restart.
- **Daily quota.** Per-user counters live in Postgres; `terraform destroy` followed by `apply` recovers everything except `usage_per_user` history (intentional — counter, not source of truth).
- **Snapshot freshness.** Boot banner shows snapshot age. Older than 60 days → warning. Run `bun run extract-template` after a CC update, review the diff, commit.
- **Common pitfalls.** See [`docs/operational-pitfalls.md`](./docs/operational-pitfalls.md). The most painful one: `claude /logout` on any machine sharing the same refresh token revokes it server-side for **all** machines using it.

## Wire fidelity, briefly (C-partial)

The proxy ships a snapshot of Claude Code's HTTP wire shape and replays it on every outbound request. Snapshots are extracted directly from your installed `claude` binary by `scripts/extract-cc-template.mjs`. What we catch and what we miss:

| Axis | Status | How |
|---|---|---|
| TLS ClientHello | ✅ | Bun's TLS stack matches Claude Code's BoringSSL fingerprint. |
| Header order | ✅ | Captured in TCP arrival order, replayed via `@hono/node-server`. |
| `anthropic-beta` flags | ✅ | Static binary extraction + whitelist, client beta flags union'd. |
| `user-agent`, `x-app`, `anthropic-version` | ✅ | Static. |
| Body key order | ✅ | Captured. |
| Session lifecycle & pacing | ✅ | Snapshot's p50 inter-arrival used as pacing floor. |
| Cumulative aggregates | ❌ | Multi-tenant traffic on one OAuth account is structurally unnatural over weeks. Multi-account pool is the only mitigation. |

See [`docs/cc-wire-reference.md`](./docs/cc-wire-reference.md) for a 42-capture empirical reference.

## Project layout

```
src/
├── server.ts             # Entry point + wiring
├── proxy/
│   ├── messages.ts       # /v1/messages handler (hot path)
│   ├── models.ts         # /v1/models handler (gateway model discovery)
│   ├── upstream.ts       # Outbound to api.anthropic.com
│   └── concurrency.ts    # Application-layer rate limiter
├── auth/
│   ├── api-key.ts        # x-api-key middleware (constant-time)
│   ├── api-key-store.ts  # Env + file-backed store
│   ├── oauth.ts          # Refresh logic, atomic persistence
│   └── account-pool.ts   # Multi-account routing
├── usage/
│   ├── per-user-postgres.ts  # SQL counter store (production)
│   ├── per-user.ts           # In-memory fallback
│   ├── sniff.ts              # SSE chunk parser for usage events
│   ├── billing-monitor.ts    # service_tier alarms
│   ├── drift-analyzer.ts     # Fingerprint diff RCA
│   └── global.ts             # Subscription-wide headroom guard
├── admin/                # Dashboard + paste forms + CSRF guard
├── template/             # cc-snapshot.json + replay logic
├── alerts.ts             # Sink abstraction (Discord, Slack, noop)
├── alerts-store.ts       # Mutable webhook config
├── canary.ts             # Candidate-snapshot traffic split
├── capture.ts            # CAPTURE_MODE dumps
└── lib/
    ├── errors.ts         # DomainError + factories
    └── redact.ts         # Strip sk-ant-* from logs

terraform/                # AWS infra (EC2 + RDS + SSM + IAM)
docs/                     # Operational notes, wire reference
scripts/                  # Snapshot extraction + synthesis
tests/                    # Bun tests
```

## Why these choices

- **Bun, not Node.** Bun's TLS stack happens to produce a ClientHello fingerprint compatible with Claude Code's BoringSSL fork. Node TLS does not.
- **Caddy, not nginx.** ACME automation out of the box. Zero-config TLS for the common case.
- **PostgreSQL, not SQLite.** Survives container destroy/recreate and supports the eventual "two replicas behind a load balancer" topology even though current deployments are single-instance.
- **Hono on Bun.** Lightweight (~50KB), Bun-native, but `/v1/messages` falls back to the `@hono/node-server` adapter in `CAPTURE_MODE` because the Web Request API normalizes header case/order, destroying the fingerprint we want to record.
- **SSM Session Manager, not SSH.** No port 22 exposed, IAM-based auth, audit log via CloudTrail. The terraform module reflects this.

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit
bun test            # bun:test runner
bun run dev         # bun --hot src/server.ts
```

Tests cover the routing layer (`account-pool`), SSE parsing (`sniff`), webhook config persistence (`alerts-store`), CSRF guard, concurrency limiter, in-memory tracker quota math, and admin form validation. Run `bun test --watch` while iterating.

## License

MIT. See [LICENSE](./LICENSE) if present.

## Disclaimer (again)

This README contains a full disclaimer in the header. Going public with this repository does not signal that the author endorses any specific use case under Anthropic's Terms of Service. The author has reviewed the architecture for credential safety in a public repository (no secrets in tracked files, all credentials runtime-injected via SSM SecureString) but makes no claim about the legality of running it. **You are on your own.**
