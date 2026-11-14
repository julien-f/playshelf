---
name: feature
description: Take a new feature request (not yet a backlog item) from idea to merge — proposals weighed by specialist agents and as the app's users, the user's choice, a plan, a branch, test-first steps, and a merge after the user's own test. Use when the user asks for a new feature or capability, asks how the app could support something, or asks for proposals or a brainstorm about one. A U- or C-item goes to ux-fix or code-fix; choosing among backlog items to backlog-run.
---

# Feature

A request for something the app doesn't do yet. Fixing a filed item is [ux-fix](../ux-fix/SKILL.md) or [code-fix](../code-fix/SKILL.md); this skill reuses their steps once the feature is planned.

## 0. Frame

- Who it's for and what they're trying to do: the matching _Who / goal_ in [journeys.md](../../../docs/dev/journeys.md), and what the app already does nearby ([features.md](../../../docs/user/features.md)).
- Check [improvements.md](../../../docs/dev/improvements.md), [code-backlog.md](../../../docs/dev/code-backlog.md) and [decisions.md](../../../docs/dev/decisions.md): it may be filed, or declined with a reason.
- A new upstream: [integrations.md](../../../docs/dev/integrations.md#trust-tiers)'s trust tiers first.

## 1. Proposals

- Two to four approaches, each with what the user gets, its cost and its risk. One `Agent` per area it touches plus one as the app's users (would they use it, is it worth its place?), all in one message; drop or merge what they sink.
- Explain the result in plain words, then ask in one `AskUserQuestion`, recommendation first. A visual choice goes on a mockup page first (ux-fix step 0).

## 2. Plan

- `~/.claude/CLAUDE.md`'s non-trivial-change rule, with the same reviewers; inferred upstream behavior stated as an assumption to confirm (CLAUDE.md). Steps as commits, each with its test, then an out-of-scope list.
- `node scripts/worktree.js <branch>`, the plan committed there as `PLAN.md` while it waits for approval.

## 3. Build

- Each step test-first: [ux-fix](../ux-fix/SKILL.md) steps 1–4 for UI, [code-fix](../code-fix/SKILL.md) steps 1–3 otherwise; `docs/user/` updated with the step that changes what users see.
- Delete `PLAN.md` once the last step is in.

## 4. Merge

CLAUDE.md's Git workflow: review, the user's test (worktree, mock port, numbered steps), then `node scripts/merge.js` with the feature's one CHANGELOG entry. Never push.

## Report

What shipped and where to see it (route and steps), what was left out and why.
