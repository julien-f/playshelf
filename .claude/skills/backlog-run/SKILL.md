---
name: backlog-run
description: Pick the next work across both backlogs (docs/dev/code-backlog.md and docs/dev/improvements.md) — conflicts, duplications, synergies — recommend one item or cluster, then plan, review, implement, merge and log the run's review yield. Use when asked which backlog item to do next, to triage both backlogs, or to pick one and ship it end to end.
---

# Backlog run

Chooses what to do; doing it is [code-fix](../code-fix/SKILL.md) and [ux-fix](../ux-fix/SKILL.md). Each run is logged so [setup-review](../setup-review/SKILL.md) can shrink the phases that don't pay.

## 0. Triage

- Note the start time (ISO) for the log.
- Read both backlogs in full, then the code behind the candidates.
- Report, in short bullets: **conflicts** (items that rewrite the same code or undo each other, and the order that resolves them), **duplications** (one item subsumes another, items blocked on the same upstream), **synergies** (same file or state, one unblocks or cheapens others).
- Recommend one item or cluster: value for effort, what it unblocks, why now. When only asked for a pick, stop here.

## 1. Plan

- As `~/.claude/CLAUDE.md`'s non-trivial-change rule (specialist review until they agree, branch named). The plan lives in the scratchpad and ends with an out-of-scope list.
- Per review round, keep for the log: each agent's `subagent_tokens` (the last task notification's, which includes earlier rounds), its numbered required changes (**blocking**), its optional suggestions (**other**), and how many of both you applied.

## 2. Implement

- Each item through [code-fix](../code-fix/SKILL.md) steps 0–3 or [ux-fix](../ux-fix/SKILL.md) steps 0–4; above about five items, [BATCH.md](../code-fix/BATCH.md).
- Approving the plan is the go-ahead to commit each step.

## 3. Review the code

- As [code-fix's step 4](../code-fix/SKILL.md#4-review-the-batch), over the branch's commits.
- Keep for the log: the review's tokens, confirmed correctness bugs (**blocking**), other confirmed findings (**other**), how many you applied.

## 4. Merge

As CLAUDE.md's Git workflow (`node scripts/merge.js`), with the CHANGELOG entry. Never push.

## 5. Log

```
node scripts/backlog-run-log.js '{"items":["U166"],"started":"<ISO>","merge":"<sha>","phases":{"triage":{"tokens":0},"plan":{"agents":3,"rounds":2,"tokens":0,"blocking":0,"other":0,"applied":0},"code":{"agents":1,"tokens":0,"blocking":0,"other":0,"applied":0}}}'
```

- Exact sums from the notifications, never estimates; `triage` only when an agent did it. Blocked commits and wall time come from `checks` and the merge, not from you.
- **Escapes**: whenever a fix, audit or review finds a bug's cause commit (code-fix/ux-fix step 0, code-audit, ux-review, a user report), `node scripts/backlog-run-log.js --escape <sha> <C<n>|U<n>>` attributes it to the run that merged it, if any. Only where the cause is already known: user-reported bugs are undercounted.

## Report

What shipped and where to see it, gaps, and `node scripts/backlog-run-log.js --summary`.
