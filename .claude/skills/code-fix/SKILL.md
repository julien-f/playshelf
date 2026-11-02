---
name: code-fix
description: Fix items from the code backlog (docs/dev/code-backlog.md) — test first, fix, close the item, one commit each. Use when asked to fix, implement or close a C-item or a code-audit finding.
---

# Code fix

Works through the named `C<n>` items in [code-backlog.md](../../../docs/dev/code-backlog.md), in order, one commit each. Finding new problems is [code-audit](../code-audit/SKILL.md)'s job; this one fixes what's there. A UI-visible fix also follows [ux-fix](../ux-fix/SKILL.md)'s step 3 (look at it on `dev:mock`).

Above about five items, run them as a parallel batch: [BATCH.md](BATCH.md).

## 0. Before starting

- Read every requested item, the doc its dimension names in code-audit, then the code involved, callers included.
- Re-verify each item still holds; one that doesn't is closed without a commit, and said so.
- A bug whose cause commit you find: `node scripts/backlog-run-log.js --escape <sha> <C<n>>` ([backlog-run](../backlog-run/SKILL.md#5-log)).
- Batch the real forks into one `AskUserQuestion`, recommendation first: anything on CLAUDE.md's ask-first list (a new dependency, deleting files), a change raising upstream traffic, a fix that widens past the item. Everything else proceeds on the item's Direction.

## 1. Test first

- A test in `test/*.test.js` (backend, shared frontend logic) or `e2e/` (behaviour in the browser) that fails for the reason the item describes; run it alone and confirm it fails.
- **cleanup** items change no behaviour: the existing tests must pass before and after, no new test.
- **docs** items: the doc edit is the fix, no test; re-read the code it describes to confirm the new text, and `npm run check` covers the rest.
- **perf** items: measure before and after (build sizes, outbound call counts from `GET /api/metrics`, a timing; for a list load, `node scripts/perf-measure.js`, [testing.md](../../../docs/dev/testing.md#measuring-performance)) and put the numbers in the commit body.

## 2. Fix

The smallest change that closes the item, following CLAUDE.md's code conventions and [frontend.md](../../../docs/dev/frontend.md)'s reactivity rules. Delete what it makes dead. Re-run the step 1 test.

## 3. Close and commit

- Remove the item from code-backlog.md, or narrow it to what's left and say so; a section left empty reads `None open.` (Prettier rejects an empty one).
- Then CLAUDE.md's Development workflow and Changelog; the commit body names `C<n>`.

## 4. Review the batch

Once every item is committed, run `/code-review` over the batch's commits (`<first>^..HEAD`). Verify each finding against the code, fix the confirmed ones as follow-up commits, and list the dropped ones with why in the report.

## Report

One table — item, commit, how it was verified (test, measurement) — then anything narrowed rather than closed.
