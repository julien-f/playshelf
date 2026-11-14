---
name: ux-fix
description: Fix items from the UX backlog (docs/dev/improvements.md) — test first, fix, check on the mocked server, close the item, one commit each. Use when asked to fix, implement or close a U-item or a ux-review finding.
---

# UX fix

Works through the named `U<n>` items in [improvements.md](../../../docs/dev/improvements.md), in order, one commit each. Finding new problems is [ux-review](../ux-review/SKILL.md)'s job; this one fixes what's there.

Above about five items, run them as a parallel batch: [code-fix's BATCH.md](../code-fix/BATCH.md).

## 0. Before starting

- Read every requested item, the scenario it names in [journeys.md](../../../docs/dev/journeys.md) and the [UI guidelines](../../../docs/dev/ui-guidelines.md) it touches, then the code involved. A bug whose cause commit you find: `--escape` as [code-fix's step 0](../code-fix/SKILL.md#0-before-starting).
- Batch the real design forks into one `AskUserQuestion`, recommendation first: placement or interaction model, frontend-only vs. a backend change, anything on CLAUDE.md's ask-first list (a new dependency). Everything else proceeds on the obvious fix — an item whose "Direction" already settles it needs no question.
- A visual or layout item (how it looks, not what it does): before building, mock it on dev:mock by injecting the proposed CSS at runtime, publish a private before/after page at both widths, and ask for the go-ahead on that page.

## 1. Test first

- Behaviour: a test in `e2e/scenarios.spec.ts` titled `<scenario> edge: <what must hold>`, next to that scenario's tests; backend logic: `test/*.test.js`. Mock data the test needs goes in `e2e/fixtures.ts` / `e2e/mockApi.ts`.
- Run it alone (`npx playwright test -g "<title>"`) and confirm it fails for the reason the item describes. Timers: `page.clock.install()` before the first `goto`, then `page.clock.runFor(ms)`.
- Layout-only items (shift, overlap, spacing) skip the test; step 3 measures them instead.

## 2. Fix

The smallest change that closes the item, following [frontend.md](../../../docs/dev/frontend.md)'s reactivity rules. Re-run the step 1 test.

## 3. Look at it

- `node scripts/mock-server.js up` (`dev:mock`, its port from `node scripts/ports.js mock`; its own storage: no demo-prefs seed/restore; `down` when done). Check at **1440×900** and **390×844** with [ux-review](../ux-review/SKILL.md)'s Mechanics, starting clean (`ux-measure.js --fresh`), naming files `ux-U<n>` / `ux-U<n>-<what>.png`; measure what the item is about (bounding boxes before/after, accessible names).
- This is the item's re-check — no separate ux-review run.
- A stale-module error after editing a widely imported file: restart the server (`down`, then `up`). A console error that appeared mid-edit: reload before believing it (pitfalls.md).

## 4. Close and commit

- Remove the item from improvements.md, or narrow it to what's left and say so. A ◇ naming it in journeys.md goes in the same commit: drop the ◇ once built, or re-point it to the item left (`npm run check` fails otherwise).
- Then CLAUDE.md's Development workflow and Changelog; the subject says what changed for the user, the body names `U<n>` and why.

## 5. Review the batch

As [code-fix's step 4](../code-fix/SKILL.md#4-review-the-batch).

## Report

One table — item, commit, how it was verified (test, measurement) — then anything narrowed rather than closed, and side effects worth knowing (e.g. a new trade-off on phone).
