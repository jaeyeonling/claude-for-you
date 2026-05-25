<!--
Before opening: read CONTRIBUTING.md.

Required:
- bun run typecheck  → green
- bun test           → green
- New behavior comes with new tests
-->

## What

One sentence summary of the change.

## Why

The problem this PR solves. Link to an issue if there is one.

## How

Brief tour of the diff. Mention any non-obvious decisions (why this approach, what was rejected).

## Tests

- [ ] Added new tests for new behavior
- [ ] Updated existing tests that change shape
- [ ] `bun test` is green locally

## Risk

- [ ] Touches the hot path (`src/proxy/messages.ts`, `src/proxy/upstream.ts`)
- [ ] Changes wire shape (snapshot, headers, body keys)
- [ ] Modifies admin endpoints or auth
- [ ] Changes terraform / requires `apply`
- [ ] None of the above (low risk)

## Anthropic ToS

By submitting this PR you acknowledge that the project's disclaimer applies (`README.md` and `LICENSE`). The maintainers do not accept liability for any consequences of running this software.
