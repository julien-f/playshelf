---
name: backlog-run
description: Pick the next work across both backlogs (docs/dev/code-backlog.md and docs/dev/improvements.md) — conflicts, duplications, synergies — recommend one item or cluster, then plan, review, implement, merge and log the run's review yield. Use when asked which backlog item to do next, to triage both backlogs, to pick one and ship it end to end, or to plan and ship named items end to end (`/backlog-run C313`).
argument-hint: '[C<n>|U<n> …]'
---

# Backlog run

Chooses what to do and ships it; each item's fix is [fix](../fix/SKILL.md). Plan through Log are also how [feature](../feature/SKILL.md) ships. Each run is logged so the user-level setup-review can shrink the phases that don't pay.

## Triage

- Note the start time (ISO) for the log.
- Items given as arguments: they are the pick; read them and the code behind them, report only their conflicts with other open items, and go to Plan.
- Read both backlogs in full, then the code behind the candidates.
- Report, in short bullets: **conflicts** (items that rewrite the same code or undo each other, and the order that resolves them), **duplications** (one item subsumes another, items blocked on the same upstream), **synergies** (same file or state, one unblocks or cheapens others).
- Recommend one item or cluster: value for effort, what it unblocks, why now. When only asked for a pick, stop here.

## Plan

- As `~/.claude/CLAUDE.md`'s non-trivial-change rule (the plan through `cross-review`, branch named). Steps as commits, each with its test, then an out-of-scope list.
- `node scripts/worktree.js <branch>`, the plan committed there as `PLAN.md` while it waits for approval. A declined plan: remove that worktree and branch (`git branch -D` asks first, per `~/.claude/CLAUDE.md`'s Cleanup).
- Per review round, keep for the log: each agent's `subagent_tokens` (the last task notification's, which includes earlier rounds), its numbered required changes (**blocking**), its optional suggestions (**other**), and how many of both you applied.

## Implement

- Each item through [fix](../fix/SKILL.md) from Before starting through Close and commit (Look for UI-visible ones); above about five items, [BATCH.md](../fix/BATCH.md).
- Delete `PLAN.md` once the last step is in.

## Review the code

- As [fix's Review the batch](../fix/SKILL.md#review-the-batch), over the branch's commits.
- Keep for the log: the review's tokens, confirmed correctness bugs (**blocking**), other confirmed findings (**other**), how many you applied.

## Merge

CLAUDE.md's Git workflow: Review the code was its `/code-review`; then the user's own test (worktree, mock port, numbered steps, a "merge without my test" option), then `node scripts/merge.js` with the one CHANGELOG entry.

## Log

```
node scripts/backlog-run-log.js '{"items":["U166"],"started":"<ISO>","merge":"<sha>","phases":{"triage":{"tokens":0},"plan":{"agents":3,"rounds":2,"tokens":0,"blocking":0,"other":0,"applied":0},"code":{"agents":1,"tokens":0,"blocking":0,"other":0,"applied":0}}}'
```

- `items`: the `C<n>`/`U<n>` shipped, or `feature:<slug>` for a feature. Exact sums from the notifications, never estimates; `triage` only when an agent did it (a feature's proposal agents count there). Blocked commits and wall time come from `checks` and the merge, not from you.
- **Escapes**: whenever a fix, audit or review finds a bug's cause commit, `node scripts/backlog-run-log.js --escape <sha> <C<n>|U<n>>` attributes it to the run that merged it, if any. Only where the cause is already known: user-reported bugs are undercounted.

## Report

What shipped and where to see it, gaps, and `node scripts/backlog-run-log.js --summary`. End with the next item or cluster worth doing (Triage's recommendation criteria) as a ready-to-paste prompt for a new session: `/backlog-run <items>`, plus the repo state it needs (unpushed commits, open branches).
