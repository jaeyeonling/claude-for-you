# Contributing

Thanks for considering a contribution. A few things up front so we don't waste each other's time.

## What this project is — and isn't

`claude-for-you` exists for a narrow scope: a self-hosted proxy that lets a handful of trusted people share one Claude.ai subscription. **It is not, and will not become, a public SaaS, a multi-tenant gateway, or a load-balancing proxy in front of paid Anthropic API keys.** The wire-fidelity work is deliberately scoped to "look like Claude Code on the network because that's what the upstream subscription expects" — not to evade detection in any creative new direction.

PRs that drift outside this scope will likely be closed, even if technically excellent.

## Before opening an issue

1. **Search existing issues first.** Many wire-fidelity questions repeat.
2. **For "is X a ToS violation" questions, ask Anthropic, not us.** The maintainer's stance is in the README disclaimer.
3. **For deployment problems**, include: terraform `apply` output, `aws ssm get-command-invocation` output of `cloud-init-output.log` tail, `docker compose ps` output. Mask any tokens or webhook URLs before pasting.

## Pull requests

### Required before opening

```bash
bun install
bun run typecheck   # tsc --noEmit
bun test            # bun:test runner — all green
```

CI will re-run both. Don't push if either is red locally.

### What we look for

- **Tests.** New behavior comes with new tests. The `tests/` directory is a regression dam, not a "we'll get to it" stub.
- **No new `console.log` in hot paths.** The access log is `LOG_LEVEL=debug`-gated for a reason; per-request log lines have a cost.
- **No new `any`.** Use `unknown` and narrow.
- **No new mutation.** Immutable updates with spread, `Object.freeze` returned values.
- **Redact secrets in logs.** `lib/redact.ts` exists; use it for anything that could echo a token.
- **Domain errors via factory.** `errors.ts` exposes `Unauthorized`, `Forbidden`, `InvalidRequest`, `NotFound`, `Conflict`, `TooManyRequests`, etc. Prefer them over `new DomainError(...)`.

### What gets closed without much discussion

- Adding multi-tenant routing, public-API exposure, or SaaS framing.
- Replacing Bun with Node "for portability" — the TLS fingerprint is the whole point.
- Replacing Caddy with nginx unless you also handle the ACME automation.
- Replacing PostgreSQL with MongoDB / Redis / "this would be faster in DynamoDB".
- Vendoring large frameworks (React, Vue, Express).
- Anything that requires a new long-lived runtime dependency without a written rationale.

### What we love

- Tests that catch a regression we shipped.
- Documentation gaps you noticed while setting up.
- A new wire-fidelity capture (`scripts/extract-cc-template.mjs` + a fresh `cc-snapshot.json` diff).
- Operability improvements that show up in `/admin` rather than as new env vars.

## Snapshot updates

When Claude Code releases a new version:

```bash
bun run extract-template       # writes src/template/cc-snapshot.json
bun run extract-template:check # diff against committed snapshot
```

Review the diff carefully — every change is a wire-shape change that an Anthropic classifier could notice. Commit the snapshot together with the CC version in the commit message.

## Local development

```bash
docker compose --profile dev up -d postgres
cp .env.example .env
# Fill ANTHROPIC_OAUTH_REFRESH_TOKEN with a real token (or use accounts.json).
bun install
bun run dev
```

The boot banner reports the snapshot age. If it warns "older than 60 days", re-extract before testing.

## Style

- 2-space indent
- single quotes for strings except where JSON
- no semicolons _(see existing `src/server.ts` style)_
- Filenames: kebab-case for source files, PascalCase for types/components
- Imports: built-ins first, third-party second, project last

## Release process

There isn't one yet. The project is a single `main` branch; expect breaking changes on any commit. When this stabilizes we'll switch to tagged releases.
