---
name: ux-review
description: Run a UX/UI design review of the app by walking the user journeys in docs/dev/journeys.md in a real browser, record findings in docs/dev/improvements.md, and report them ranked. Also re-checks one backlog item after its fix. Use when asked for a design, usability, UX or UI review, or to re-check a flow or a U-item after a UI change.
---

# UX review

Judges the app against [docs/dev/journeys.md](../../../docs/dev/journeys.md) and [ui-guidelines.md](../../../docs/dev/ui-guidelines.md), not general taste. A finding is friction on a scenario's path, a broken **Expect**/**Edges** line, or a guideline broken along the way. A ◇ is a known target tracked by the U-item beside it, not a defect — note how far the UI gets toward it on that item, nothing more.

## Scope

- **Default: the core journeys** ([journeys.md](../../../docs/dev/journeys.md)'s intro) **and those with a ★ step** (`node scripts/journey-coverage.js`), each walked as its persona ([Who uses it](../../../docs/dev/journeys.md#who-uses-it)). A named scenario, group or route narrows it; "full" walks every scenario.
- **Re-check `U<n>`**: walk only the scenarios that [improvements.md](../../../docs/dev/improvements.md) item names, confirm the fix, then drop or narrow the item.
- A scenario that's wrong about the app (a step that doesn't exist, a stale expectation) is a finding against the doc.
- Say which scenarios were walked and which were skipped, and why.

## Which server

- **Mocked first: `npm run dev:mock` (its port: `node scripts/ports.js mock`; `node scripts/mock-server.js up` starts or reuses it, `down` stops it)** for clarity, layout, keyboard, consistency and the empty/error states — `document.cookie = 'mock=no-itad'` (or another state from `e2e/mockApi.ts`'s header) before a load switches one on; clear it after. Its storage is separate from the real prefs, so no seed/restore — but it keeps earlier runs' lists, so start clean: `node scripts/ux-measure.js --fresh /` and run it (clears it, sets `alice`; `bob`, `carol` are in `e2e/fixtures.ts`). A state the fixtures lack is a gap in `e2e/mockApi.ts` to report, not a reason to switch servers.
- **Real: `npm run dev` (its port: `node scripts/ports.js dev`; `node scripts/dev-server.js up|down`)** only for what mocks can't show — loading and progress on a real library, freshness ages, real upstream failures — and for scenarios needing real data. Those visits need the demo state below.

## Demo state (real server only) — before the first page load

Seed before opening _any_ route and restore only on the way out, as in [testing.md](../../../docs/dev/testing.md#looking-at-the-ui) (`empty` for a first visit, A1).

- Only the demo account (in the script) may be typed, except accounts the user names for this review. Those: never committed, screenshots only in `.playwright-mcp/`, called Friend A/B everywhere — in the report and in improvements.md, never by their Steam name. On the real server, skip A4 while no allowed account has a public friends list; mocks have one (Alice's).
- Stay inside [integrations.md](../../../docs/dev/integrations.md#trust-tiers)'s trust tiers: one pass per scenario, no repeated ↻ refreshes. A large library's first load streams for minutes (uncached details are throttled) — judge the feedback, don't wait for it to finish.

## Walk each scenario

Start the server(s) you need (`up` reuses a running one). At **1440×900** and **390×844**, following its steps as a user would — mouse first, then keyboard only. The resized browser keeps its mouse: touch-only rules show at 390 px anyway, so judge them in the e2e `phone` project ([testing.md](../../../docs/dev/testing.md#looking-at-the-ui)).

Check at each step:

- **Clarity** — is the next action obvious? Are labels and icons self-explanatory without the docs?
- **Feedback** — loading, progress, success and failure all visible, _where the user is looking_ (not scrolled out of view); the "how fresh is this?" ages present.
- **Empty and error states** — private profile, no results, missing `ITAD_API_KEY`, upstream failure: does the screen say what happened and what to do?
- **Consistency** — same action, same name and place across routes.
- **Keyboard and accessibility** — focus visible and in a sensible order, Esc/arrow shortcuts as in `?`, names on icon-only buttons, contrast.
- **Layout** — no horizontal page scroll on phone, nothing clipped or overlapping, touch targets usable, nothing jumping under the pointer.
- **Console** — errors and warnings.

## Mechanics

- **Layout per route**: `node scripts/ux-measure.js [--state=…] --name=ux-<scenario> /route…`, then `browser_run_code_unsafe` with `filename: .playwright-mcp/measure.js` — first-row position, block heights, overflow, targets under 24 px, unnamed controls and console errors at both widths, with screenshots.
- **Batch each step in one `browser_run_code_unsafe` call**: act, then measure with `page.evaluate` (focus, bounding boxes, computed styles, accessible names, `scrollWidth > innerWidth`), then screenshot. Far cheaper than click-by-click snapshots.
- **Screenshots** go to `.playwright-mcp/ux-<scenario>-<what>.png` (the main checkout's, even from a worktree) (gitignored — never `docs/images/`); `Read` them to look, `magick <in> -crop WxH+X+Y <out>` for detail.
- **Native dialogs** (`prompt`/`confirm`) block the page: register `page.once('dialog', …)` before the click that opens one.
- **Copied links**: stub `navigator.clipboard.writeText` in the page to capture them.
- **A fresh browser** (S3, shared links): `page.context().browser().newContext()` — its own empty storage, so nothing to restore.
- **Console noise**: editing `AppShell.tsx` mid-run reloads the page (`@refresh reload`) — re-open what you were checking.

## Teardown

After any real-server visit, restore the demo state; don't finish while `steam.isonoe.net:prefs.backup` is still present.

## Record and report

- Record every finding in [improvements.md](../../../docs/dev/improvements.md): numbered on from `node scripts/backlog-next.js U` (never reuse a closed item's number), under its area, `**U<n> · <severity> · <scenarios>** — problem. Direction.` A finding whose cause commit is already known: `--escape` as [code-fix's step 0](../code-fix/SKILL.md#0-before-starting). Update or drop items the run shows fixed.
- **Severity**: _blocker_ (the goal can't be reached) · _major_ (reached with real confusion or a workaround) · _minor_ (friction) · _polish_.
- Report one table ranked by severity (a core journey first within a severity), then one line on what worked well enough to keep:

| U   | Severity | Scenario | Where | Finding | Suggestion |
| --- | -------- | -------- | ----- | ------- | ---------- |

- Findings only — fix nothing. Then offer, in one `AskUserQuestion`, to fix the set you recommend (and why not the rest), planned as in [code-fix's BATCH.md](../code-fix/BATCH.md) step 1; each fix is its own commit, and a re-check closes it.
