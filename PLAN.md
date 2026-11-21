# Plan: skills-review (branch `skills-review`)

From the 2026-11-21 setup-review (P94–P105 in docs/dev/setup-backlog.md). Deleted before the merge.

## Commits

1. Ledger: setup-backlog.md gets P94–P105 and the header dates.
2. Small skill fixes:
   - release: `npm run format` instead of `npx prettier --write` (wipes Prettier's cache, P81).
   - code-audit, ux-review: the fix offer plans lanes only above about five items.
   - Drop rules restated from CLAUDE.md: backlog-run "approving the plan is the go-ahead", "Never push" in backlog-run and feature, feature's persona and assumption clauses, "never reuse a closed item's number" (backlog-next.js guarantees it).
   - code-audit: its per-area and per-doc agents run on `model: sonnet` (the lead verifies each finding); setup-review: the digest subagent too.
   - `argument-hint` on skills taking arguments; `allowed-tools` for dependency-audit's read-only npm commands.
3. `deps-audit.js --full`: also runs `npm audit`, `npm ci --dry-run`, `npm dedupe --dry-run`, `npm ls --all`, printing only problems; dependency-audit, code-audit and release call it. Test in test/.
4. Merge code-fix and ux-fix into one `fix` skill (`.claude/skills/fix/`, BATCH.md moves with it):
   - Item prefix picks the backlog and docs: C → code-backlog.md + the doc its dimension names; U → improvements.md + journeys.md scenario + ui-guidelines.md.
   - Named steps, no numbers: Before starting · Test first · Fix · Look (UI-visible items) · Close and commit · Review the batch · Report. Callers link step names.
   - Re-verify "still holds" applies to both (ux-fix lacked it). Escape logging owned here.
   - Mock-server facts: link testing.md#looking-at-the-ui; keep only widths, file names, what to measure.
   - "Re-check U<n>" routes here (Look step), ux-review's re-check mode deleted (ux-fix deletes the item it would read).
   - BATCH lane template: "every step except Look" (today's "steps 0–<last before the look>" skips ux-fix's close step).
   - evals.json merged; feature/code-audit/ux-review evals expecting code-fix/ux-fix → fix.
5. backlog-run owns shipping (plan → worktree → build → review → merge → log); its plan gets committed as PLAN.md (user-level Git rule). feature keeps Frame and Proposals, then ships as backlog-run steps Plan–Log, so feature runs get logged too.
6. Routing evals after (baseline 104/105 on main); CHANGELOG Development entry at merge; CLAUDE.md's BATCH link updated.

## Out of scope

- release `disable-model-invocation` (dropped: "Cut a release" would no longer load the skill and the agent would improvise the tag).
- Lanes on Sonnet (measure first), screenshots as a fork, backlog-run-log reading tokens itself (Open).
- setup-review moved to user-level: separate work in template-CLAUDE.md after this merge.
