# Working on `claude-for-you` with Claude Code

Operating notes for any AI assistant (or new contributor) picking up work in this repo. The narrow scope of the project itself is in `CONTRIBUTING.md` — this file is about *process*, not *what we build*.

## Branch naming

Use `feat/{issue}-{slug}` or `fix/{issue}-{slug}`. `{issue}` is the GitHub issue number, no `issue-` prefix.

- ✅ `feat/16-edit-key-ux`
- ✅ `fix/27-newline-collapse`
- ❌ `feat/issue-16-edit-key-ux` (used historically; do not extend)
- ❌ `27-fix-newlines` (no type prefix)

This matches the convention `matrix` skills assume (`feat/{issue}-{slug}`), so `/matrix #N` and manual workflow share the same branch shape.

## Commit messages

Conventional commits — `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`. Optional scope: `(admin)`, `(auth)`, `(api-key-store)`, etc.

Squash to one logical change per commit. Don't batch unrelated work.

## PR body

Required structure (extracted from recent merged PRs — `#28`, `#29`, `#30`):

```markdown
Closes #N.  <!-- enables auto-close + matrix `gh issue list ... | matches #N` epic linkage -->

## Summary
1–3 bullets / a short table of the change.

## Why {load-bearing decision}
For each non-obvious choice, name *why this* rather than the rejected alternative. Especially: trade-offs flagged by persona review.

## Out of scope (follow-up)
Anything a persona surfaced that you chose NOT to fix in this PR. Link the follow-up issue here — never let a HIGH finding disappear into the merged diff. If there's no follow-up, drop this section.

## Test plan
- [x] Specific bun test / typecheck invocations and their results
- [ ] Manual checks you actually ran (paste payload, UI flow, etc.)
```

Risk checkboxes from [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) (hot-path touched / wire shape changed / admin or auth modified / terraform changed / none of the above) and the Anthropic ToS acknowledgment are still required — don't strip them.

## Persona review (R1 → R2)

Every non-trivial change gets two rounds before PR creation:

### R1 — static persona check (parallel)

Spawn the five `matrix` personas in parallel against the diff + plan. Inside Claude Code with the `matrix` plugin installed, this is `Agent(subagent_type='matrix:check-{persona}')` for each of the five below, in a single message. Without the plugin, the lens table below is enough to drive five parallel manual reviews.

| Persona | Lens |
|---|---|
| `chaos` | Empty input, missing files, permission denied, exception paths |
| `adversary` | "Can I exfiltrate / inject / bypass auth with this?" |
| `first-timer` | "Did the README + this PR get me a working setup?" |
| `maintainer` | "Can I understand and modify this in 6 months?" |
| `watchdog` | Runtime cost — hooks per tool call, hot-path overhead |

Output: graded findings (CRITICAL / HIGH / MEDIUM / LOW). CRITICAL or 2+ HIGH = block.

### Self-check between R1 and R2

Before R2, the author answers in one paragraph: *"Is the PR done as scoped?"* This is the moment to catch silent scope drift — if you can't honestly say yes, fix the gap before R2, don't paper over it in R2.

### R2 — behavioral fuzz

Run the actual surface — paste attack payloads, hit the admin UI, exercise the failure path. Capture results in the PR body's `## Test plan` (manual checks).

### Follow-up issue filing

If a persona surfaces a HIGH finding that's **out of scope** for the current PR:

1. File a new issue immediately — title, persona name, finding, reproducer
2. Link it in this PR's `## Out of scope (follow-up)` section
3. Add the new issue to the project board (`Backlog`)

Do not silently drop persona findings. The `## Out of scope (follow-up)` section in the PR body is the audit trail.

## `capture-ai-session`

Captures the full Claude Code session transcript to the Obsidian vault. Call it **after deploy succeeds**, not after PR merge — the post-deploy capture is what the retro depends on, since merge → deploy can surface issues the PR review missed.

Original session logs (`logs/*.txt`) are preserved verbatim under capture; only secret patterns get masked. Don't compress.

## `/matrix` workflow

This repo is wired for the [`matrix`](https://github.com/jaeyeonling/claude-matrix) plugin's `/matrix #N` pipeline (read → plan → build → check → pr → deploy). The pipeline is invoked as a single slash command — `/matrix #32` — inside Claude Code; the assistant dispatches the internal stages automatically. There is no manual `/matrix-read` / `/matrix-build` invocation in the normal flow.

If `/matrix` is not installed, every stage maps to a manual gh + git equivalent — this CLAUDE.md alone is sufficient to run the workflow by hand.

### What `/matrix` handles automatically

- `read` — pulls issue body, creates `.claude/matrix-sessions/{N}.md` (gitignored), sets board → `Todo`
- `plan` — drafts approach; persona R1 lenses applied **to the plan** (before any code)
- `build` — creates branch (`feat/{issue}-{slug}`), implements, sets board → `In Progress`
- `check` — persona R1 lenses applied **to the diff** (after code, before push) — same five lenses as `plan` R1, different target
- `pr` — pushes, creates PR with templated body + detailed comment, runs persona R2 (behavioral fuzz)
- `deploy` — verifies via `.github/workflows/deploy.yml` against the `deploy` branch (operator pushes separately), sets board → `Done`

### What stays manual

- `scripts/deploy.sh` — the actual EC2 roll via SSM. `/matrix-deploy` only verifies the GitHub-side workflow; the operator still runs `bash scripts/deploy.sh` locally. **Ordering matters**: run `scripts/deploy.sh` first, then `git push origin main:deploy`. If `deploy.yml` then comes back red, the EC2 instance is already on the bad commit — **roll forward** to the previous known-good SHA:
  1. `git fetch origin && git worktree add ../rollback <prev-sha>` (or `git checkout <prev-sha>` if you don't want a worktree — but worktree keeps `main` clean)
  2. `cd ../rollback && bash scripts/deploy.sh` — rolls EC2 back to the previous SHA via SSM
  3. `git push origin <prev-sha>:deploy` — updates the deploy ref to match what's actually running on EC2

  Don't `git reset` the deploy branch or try to "undo" the workflow — the only state that matters is what's on EC2, and `scripts/deploy.sh` is the lever for that.
- `capture-ai-session` — call it manually post-deploy (see above).
- Production smoke (paste payload via `/admin/test/key-invoke`, observe toast, etc.) — happens after `scripts/deploy.sh` and feeds the next iteration.

### When to skip `/matrix` and go manual

Concrete signals, not vibes:

- **Single-line fix / typo / one-line README change** — `/matrix` overhead (read → plan → check) dominates payoff for a `git commit -m "docs: fix typo"`.
- **Spike / investigation where you expect to throw the code away** — i.e. no `## Test plan` in your head yet, you're iterating to *learn shape*. Once shape stabilizes, file an issue and restart under `/matrix`.
- **Persona R1 would degenerate into a one-line "looks fine"** — usually because the problem isn't well-defined enough for five lenses to find anything orthogonal. Pause, define the problem more sharply, then decide.

The retro from PR #30 (issue #32) flagged this trade-off explicitly: `/matrix` raises reproducibility but loses adaptive moments. Use the signals above; don't default either way.

## Project board

`claude-for-you` project board: <https://github.com/users/jaeyeonling/projects/10>

Status field: `Backlog` → `Todo` → `In Progress` → `Done`. `matrix` auto-detects via `owner.projectsV2` + repo match; no `.claude/matrix.json` needed (matrix dropped that design).

If `board-update.js` silent-skips (board missing / gh not authed), `/matrix` still completes — board updates are best-effort, not pipeline gates.

## Memory notes

Recurring traps live in [`docs/operational-pitfalls.md`](docs/operational-pitfalls.md). Read it before touching `src/proxy/`, the Bun runtime config, or upstream auth — it's the single source of truth, not a copy here.
