# Changelog

All notable changes will land here. The project is in 0.x; expect breaking changes on any commit until 1.0.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/), and this project does not (yet) follow semantic versioning.

## [Unreleased]

### Added

- Admin UI: rotate OAuth tokens, Discord/Slack webhook URLs from `/admin` without restart.
- CSRF guard on state-changing `/admin/*` endpoints (Origin / X-Forwarded-Host check).
- 4 MB body limit and per-process concurrency semaphore on `/v1/messages`.
- Graceful shutdown — SIGTERM/SIGINT drain the Postgres pool.
- 28 unit tests covering: account-pool routing, usage tracker, SSE sniff, alerts store, CSRF, concurrency limiter, admin OAuth validation.
- English README with Mermaid architecture diagram and admin endpoint reference.
- LICENSE (MIT, with explicit Anthropic ToS disclaimer).
- CONTRIBUTING.md, CHANGELOG.md, .github/ workflows + issue/PR templates.

### Changed

- Usage tracking moved from SQLite on EBS → PostgreSQL (local dev: docker compose profile; production: RDS).
- Terraform: replaced SSH key pair access with AWS Systems Manager Session Manager. Port 22 is no longer open.
- Terraform: added RDS Postgres (`db.t4g.micro`), DB subnet group, DB security group, and two SSM Parameter Store SecureStrings (`/claude-for-you/env`, `/claude-for-you/database-url`).
- `UsageTracker` interface is now async — propagated to `messages.ts`, `admin/page.ts`, `admin/stats.ts`.
- Access log gated by `LOG_LEVEL=debug` (previously always on).
- OAuth refresh errors are `redact()`-ed before reaching the alarm sink.
- API key revoke now uses the same name validator as add (no whitespace/colon/comma).
- alerts-store: an explicit `null` in the file now wins over the env baseline (operator intent preserved across restarts).

### Fixed

- `replaceOAuth` did not reset the member's stale `remainingTokens` estimate — first request after rotation could route based on the prior account's headroom.
- Dead `if`-branch in `drift-analyzer.collectVal` removed.
- `esc()` fallback that never fired (always returned `'—'`) replaced with explicit null check in admin page candidate description.
- Dynamic `import('node:fs/promises')` inside `writeAtomic` replaced with a top-level import.
- DB write failure in usage tracker no longer floods stderr per request — routed through cooldown-wrapped alert sink.

### Security

- Refresh token / access token prefix validation in `/admin/oauth/replace` (catches access-token-pasted-in-refresh-field mistakes).
- Constant-time API key comparison documented; the loop deliberately does not short-circuit.
- Error handler logs no longer dump full `Error` objects (the `cause` chain can leak unredacted upstream response text).
