---
name: fix
description: Fix backlog items — C<n> from docs/dev/code-backlog.md, U<n> from docs/dev/improvements.md — test first, fix, look at UI changes on the mocked server, close the item, one commit each; or re-check a U-item in the browser after its fix. Use when asked to fix, implement or close C- or U-items or code-audit/ux-review findings, or to re-check a fixed U-item. Not for a bug with no backlog item.
argument-hint: '<C<n>|U<n> …> | re-check U<n>'
---

# Fix

Works through the named items, in order, one commit each. The prefix picks the backlog and what to read:

- **C<n>**: [code-backlog.md](../../../docs/dev/code-backlog.md), and the doc its dimension names in [code-audit](../code-audit/SKILL.md#2-review-the-dimension).
- **U<n>**: [improvements.md](../../../docs/dev/improvements.md), the scenario it names in [journeys.md](../../../docs/dev/journeys.md) and the [UI guidelines](../../../docs/dev/ui-guidelines.md) it touches.

Finding new problems is [code-audit](../code-audit/SKILL.md)'s and [ux-review](../ux-review/SKILL.md)'s job. Above about five items, run them as a parallel batch: [BATCH.md](BATCH.md).

## Before starting

- Read every requested item and its docs (above), then the code involved, callers included.
- Re-verify each item still holds; one that doesn't is closed without a commit, and said so.
- A bug whose cause commit you find: `node scripts/backlog-run-log.js --escape <sha> <C<n>|U<n>>` ([backlog-run's Log](../backlog-run/SKILL.md#log)).
- Batch the real forks into one `AskUserQuestion`, recommendation first: anything on CLAUDE.md's ask-first list (a new dependency, deleting files), a change raising upstream traffic, a fix that widens past the item, and for U-items placement or interaction model, frontend-only vs. a backend change. Everything else proceeds on the item's Direction — one that already settles it needs no question.
- A visual or layout item (how it looks, not what it does): before building, mock it on dev:mock by injecting the proposed CSS at runtime, publish a private before/after page at both widths, and ask for the go-ahead on that page.

## Test first

- A test that fails for the reason the item describes; run it alone and confirm it fails.
  - Backend or shared frontend logic: `test/*.test.js`.
  - Behaviour in the browser: `e2e/scenarios.spec.ts`, titled `<scenario> edge: <what must hold>`, next to that scenario's tests; mock data in `e2e/fixtures.ts` / `e2e/mockApi.ts`; run with `npx playwright test -g "<title>"`. Timers: `page.clock.install()` before the first `goto`, then `page.clock.runFor(ms)`.
- **cleanup** items change no behaviour: the existing tests must pass before and after, no new test.
- **docs** items: the doc edit is the fix, no test; re-read the code it describes to confirm the new text.
- **perf** items: measure before and after (build sizes, outbound call counts from `GET /api/metrics`, a timing; for a list load, `node scripts/perf-measure.js`, [testing.md](../../../docs/dev/testing.md#measuring-performance)) and put the numbers in the commit body.
- Layout-only items (shift, overlap, spacing) skip the test; Look measures them instead.

## Fix

The smallest change that closes the item, following CLAUDE.md's code conventions and [frontend.md](../../../docs/dev/frontend.md)'s reactivity rules. Delete what it makes dead. Re-run the test.

## Look

For U-items and UI-visible C-items. On dev:mock ([testing.md](../../../docs/dev/testing.md#looking-at-the-ui)), started clean (`ux-measure.js --fresh`), at **1440×900** and **390×844** with [ux-review](../ux-review/SKILL.md)'s Mechanics, files named `ux-U<n>` / `ux-U<n>-<what>.png`: measure what the item is about (bounding boxes before/after, accessible names). `down` when done. Stale modules or a console error mid-edit: [pitfalls.md](../../../docs/dev/pitfalls.md).

**Re-check U<n>** (after its fix, asked on its own): find its commit with `git log -P --grep='\bU<n>\b'`, read the item's removed line in `git show <sha> -- docs/dev/improvements.md`, walk the scenarios it names this way, and file what still fails as a new item.

## Close and commit

- Remove the item from its backlog, or narrow it to what's left and say so; a section left empty reads `None open.` (Prettier rejects an empty one). A ◇ naming a U-item in journeys.md goes in the same commit: drop it once built, or re-point it to the item left (`npm run check` fails otherwise).
- Then CLAUDE.md's Development workflow and Changelog; the commit body names the item. For a U-item, the subject says what changed for the user, the body why.

## Review the batch

Once every item is committed, run `/code-review` over the batch's commits (`<first>^..HEAD`). Verify each finding against the code, fix the confirmed ones as follow-up commits, and list the dropped ones with why in the report.

## Report

One table — item, commit, how it was verified (test, measurement) — then anything narrowed rather than closed, and side effects worth knowing (e.g. a new trade-off on phone).
