# Testing and looking at the UI

## Unit tests

- `node:test` + `supertest`, flat in `test/*.test.{js,ts}`.
- `npm test` (~6 s) runs with `DB_FILE=`, so no real database is touched.
- Single file: `npm run test:one test/<name>.test.js` — same env as `npm test` (upstream pacing at 0, unlike a bare `node --test`), which hardcodes its glob.
- Both preload `test/gitEnv.js`, which strips `GIT_*` from the environment: hooks and `git rebase -x` export `GIT_DIR`/`GIT_INDEX_FILE`, which would point a test's git calls at the real repo.
- `--conditions=browser` loads solid-js's browser build: under Node's default (server build) effects and memos never re-run and `createResource` throws, so reactivity couldn't be tested.
- **A test's `require` and a `.ts` module's own `import`s load separate copies** of a module (CommonJS vs. Node's ESM loader, each with its own cache), so:
  - `delete require.cache[…]` doesn't reset a module-level value (a memoized fetch, a counter) of a module that a `.ts` file imports: keep state a test must reset in a factory the test calls (like `createPanelDataCache()`).
  - An effect created with `require('solid-js')` runs once and never again on a `public/` module's signal: `require` loads solid-js's CommonJS build, the `.ts` modules its ESM one. Use `await import('solid-js')` (see `test/authStore.test.js`).
  - `require('../public/gameColumns.ts')` (or any module importing `@vates/data-table-solid`) throws `ReferenceError: window is not defined`: the library touches `window` when it loads. Resolve it to `@vates/data-table-core`, which provides the helpers, with a `module.registerHooks` resolve hook (see `test/gameColumns.test.js`).

## End-to-end tests

- `npm run test:e2e` (both widths, timed by `node scripts/setup-facts.js --cost`; Playwright, `e2e/`, against a production build) runs the tests of [journeys.md](journeys.md)'s journeys at desktop (1440×900) and phone (390×844) widths.
- A test's title maps it to a journey: `A1: …` covers A1's built steps, `A1.1,3-4: …` only those steps, `A1 edge: …` its edges; `npm run check` fails on a title naming no journey or step, or a ◇ one. `node scripts/journey-coverage.js` shows which journey steps they lock.
- After an `npm install` that updates Playwright, run `npx playwright install chromium-headless-shell`: otherwise every test fails with `Executable doesn't exist at …/chrome-headless-shell`, buried under a follow-on `uncaught page errors` failure.
- The browser renders with the committed DejaVu fonts (`e2e/fonts/`, through `FONTCONFIG_FILE`), not the machine's: layout checks measure the same locally and in CI. DejaVu is also Ubuntu's and Debian's default and wider than most, so an overflow shows up locally. Linux only (fontconfig).
  - A layout check that still fails in CI only, by a few pixels: something else drives the layout there (a glyph DejaVu lacks falling back to a system font, a Chromium version gap). Fix the CSS (size to content, set a line height), not the threshold; to find the breaking change, diff against the last green run's commit (`gh run view <id> --json headSha`), since one push can carry many.
- Every `/api` call is mocked in the browser (`e2e/mockApi.ts`): no backend, no upstream traffic. Fixtures use made-up accounts only.
- The presentation window (a popup) gets its stubs from `e2e/presentationHooks.ts`, injected into its HTML by a context route: init scripts miss a popup's first document about one run in four, so fake time on the main page only ([page.clock](#writing-reliable-tests)).
- The hooks run it ([Hooks](#hooks)); both skip each width already passed on the same build (sourcemaps aside), `e2e/` and test config (`scripts/e2e.js`): a push after a UI commit runs only phone. `E2E_DEFER=1` skips the pre-commit e2e, for fix-batch lanes only ([BATCH.md](../../.claude/skills/code-fix/BATCH.md)), which run the suite once before reporting.
- Each checkout's run takes its port from `node scripts/ports.js e2e`; when another run holds it (a lock in `node_modules/.cache/`) or something listens there, `scripts/e2e.js` moves to the next free one. A set `E2E_PORT` fails instead.
- `npm run test:e2e -- --since=<ref>` skips the run when the commits since `<ref>` touch none of those files (`check.js`'s `touchesUi`): a fix-batch lane's doc- or backend-only work.
- `node scripts/e2e-flakes.js [--repeat=N] [--load=THREADS] [playwright args…]` runs the suite N times (default 5), beside THREADS busy-looping threads, and prints each test's failure rate and the slowest tests. The added load stacks on other sessions', so it logs the load sampled during the run (`.git/dev-metrics/flakes.jsonl`; `setup-facts.js --cost` shows the last one). 5 repeats find candidates; a flake's procedure is under [Writing reliable tests](#writing-reliable-tests). A full passing run records the e2e pass like any other.
- `E2E_SHOTS=1 npm run test:e2e` keeps each test's final screen, plus any `shot(page, name)` (`e2e/state.ts`), under `test-results/`, one folder per test and width — a way to look at a UI change without touching real prefs.

## Writing reliable tests

Each rule comes from a flake it fixed; add one when a fix teaches something new.

- No real-time wait: drive time with the fake clock (`page.clock`, `node:test`'s `mock.timers`), or wait on the state (`until` in `test/until.js`; not in a test faking `setTimeout`, where it hangs instead of failing: await a promise the code resolves). A real wait is a window that load closes or stretches; `test/e2eWaits.test.js` fails on a `waitForTimeout` whose line doesn't say `// real time: <why>`.
  - `page.clock` is the whole context's: install it after `startPresenting`, not before (the popup's first document misses it about one run in four). Timers armed before the install keep real time.
  - A window between two inputs (double-tap, a wheel gesture's end, a burst's settle): `pauseAt`, then `runFor` past it.
  - Paused, `requestAnimationFrame` and debounced writes (the lightbox's status line) wait too: assert on what changes at once (its counter).
- After an overlay's ×/Esc close, wait for its `popstate` before a `page.goto`: the close steps history back asynchronously (`overlayHistory.ts`), and that traversal aborts the navigation with `net::ERR_ABORTED`.
- A `page.route` glob matches the whole URL, query included: end it with `**` (`**/api/prices**`), or the handler is silently skipped for `/api/prices?country=…`.
- Wait for the state the next step needs, not a proxy: `not lb--loading` holds before the lightbox opens and before its media arrive (`stillShown`); `waitForResponse` resolves before the app's handlers run.
- A "nothing after" check advances the fake clock past the window, then asserts; break the app once to see it fail.
- Mocked "fetched" stamps take the answer's time: a module-level `Date.now()` ages with the worker.
- `Event.timeStamp` is real time: app code a test drives by the clock reads `performance.now()` or `Date.now()`.
- A tainted-canvas fallback can't be tested through `page.route`: Playwright's Chromium passes a fulfilled cross-origin response through the CORS check whatever its headers, so an image without `Access-Control-Allow-Origin` still loads with `crossOrigin = 'anonymous'` and its canvas reads fine (seen on the panel tint, `artTint.ts`). Serve it from a real server on another origin (`python3 -m http.server` on a spare port) and call the code from the page.
- A flake: reproduce it with `node scripts/e2e-flakes.js --repeat=24 --load=24 --project=… -g …` and Playwright's `--workers=12` (the full suite's contention: alone it rarely fails), fix the cause, then show 0 failures over at least twice the runs it took to fail, under the same load.

## Looking at the UI

- **Mocked** (the default): `npm run dev:mock` (its port: `node scripts/ports.js mock`) serves the app against the e2e fixtures — no backend or upstream traffic, and its own localStorage, so no demo-prefs seed/restore. The `mock` cookie switches on error and slow states (`e2e/mockApi.ts`).
  - From an agent session, `node scripts/mock-server.js up|down` starts or reuses it in the background.
  - `node scripts/ux-measure.js [--fresh] [--state=…] /route…` writes a Playwright file measuring those routes at both widths.
  - A resized desktop browser keeps its mouse, so `(hover: hover)` and `(any-pointer: fine)` still match at 390 px: check touch-only rules in the e2e `phone` project (`hasTouch: true`).
- **Playwright MCP**: `browser_run_code_unsafe` runs in Playwright's sandbox with `page`, not in the page (`ReferenceError: document is not defined`, or `localStorage`, `setTimeout`, `require`): DOM and storage go inside `page.evaluate(() => …)`, waits through `page.waitForTimeout(ms)`, a script file through `filename`.
  - It reads and writes only under the repo's `.playwright-mcp/` (gitignored; else `File access denied … is outside allowed roots`) — from a worktree, the **main checkout's**: a screenshot reported as written isn't in the worktree's.
- **Real dev server**: only for real data or real loading times; `node scripts/dev-server.js up|down` runs it the same way; in a worktree, on its own ports (`node scripts/ports.js dev`) with the main checkout's `.env` settings and `db.sqlite`, so never start `server.js` by hand. Its pages write the user's real prefs (every route but `/about`, `/game/:appid` included), so:
  1. before the first load, run `node scripts/demo-prefs.js seed --file` (or `empty`, for a first visit) and its `.playwright-mcp/demo-seed.js` with `browser_run_code_unsafe`'s `filename`;
  2. afterwards, `restore --file` and `demo-restore.js`, then confirm `steam.isonoe.net:prefs.backup` is gone.
  - Seeding refuses while a backup exists: restore that one first, never overwrite it.

## Measuring performance

- `node scripts/perf-measure.js [--runs=N]` (default 7, after one discarded warm-up) loads Owned on a production build served by `MOCK_API=1 vite preview`, with the `big-library` mock state: 1206 games whose events match a real warm stream's size, raw and gzipped (`e2e/bigLibrary.ts`).
  - Each run: a fresh Chromium context at the code backlog's phone profile (390×844, CPU ×4, 1.6 Mbps / 150 ms, through CDP), then Owned → Home → Owned in the app.
  - It prints each metric's median and range against the last recorded run, flagging a change only when the ranges don't overlap and the medians differ by 5% or more, and records the run in `.git/dev-metrics/perf.jsonl`.
  - Use it for a performance change's before/after, and put both in the commit body. On demand only: runner noise keeps it out of checks, hooks and CI; compare runs from the same machine.
- Recalibrating `e2e/bigLibrary.ts` after a change to the stream's payload: copy `db.sqlite` to a scratch file, run `server.js` on it with `node --require <preload>`, a preload setting `globalThis.fetch` to one that throws (no upstream traffic), POST cached appids (`meta:` keys in `cache_meta`) to the stream with and without `Accept-Encoding: gzip`, and divide each size by the game count; `test/mockApi.test.js` holds the target. Delete the copy after.
- What it can't show:
  - Server and upstream time (the mock answers at once; read `GET /api/metrics`), so not a server-side cache change.
  - A cold load's split `fast`/`store` events: the mock sends one event per game, as a warm cache does, so `list:listed` ≈ `list:done`.
  - Image bytes: every request off localhost fails at once (no traffic to Steam's CDN), so images are counted, not timed.
  - A change to the stream's payload, unless the same commit changes `e2e/mockApi.ts`, which builds it by hand.
  - HTTP/2: `vite preview` serves HTTP/1.1, six connections per host, which can lengthen a chain of chunk loads.

## Skill evals

- `node scripts/skill-evals.js [SKILL...]` runs each `.claude/skills/<name>/evals.json` routing case through headless `claude -p` and reports which skill it loaded (~30 s for all; each run stops at its first tool call). `--repeat=N` measures how stable a route is; a single run can pass by luck.
- `--dry-run` also runs each skill's `dryRun` command to the end in `auto` permission mode (about $1 and 1–2 min each, capped by `--budget`) and reports its denied and failed calls. Only skills safe to run unattended have one.
- Each run's routing score and dry-run results are kept locally (`scripts/dev-metrics.js`), and the routing line names the last comparable run's score.
- Runs use a throwaway clone (no remote; `node_modules` reflinked for `--dry-run`) of the working tree, or of `--ref=<REF>` to compare a skill change before and after, and write no session transcripts. Not part of `check`: it costs real tokens.

## Checks

- `npm run check` runs `steps()` in `scripts/check.js`, in parallel; the hooks run them too ([Hooks](#hooks)).
- Every `scripts/check.js` run (both hooks and `npm run check`) logs its step times and failures to `.git/dev-metrics/` (`scripts/dev-metrics.js`: local, shared by worktrees), as does `scripts/backlog-run-log.js` (each backlog-run's review yield and its escapes) — project scripts log there, not in `~/.claude/logs`; `node scripts/setup-facts.js --cost` summarizes them.
- `scripts/doc-refs.js` lists references in the docs, CLAUDE.md, README.md and the skills that fail to resolve: backticked identifiers found nowhere in the code, links to missing files or headings, missing `npm run` scripts, `scripts/*.js` files or flags. Each is either stale (fix the doc) or deliberate history (add it to `HISTORY` there, which reports an entry no doc mentions any more).
- `scripts/doc-lint.js` fails on history phrasing ("used to", "no longer"… outside quotes), a paragraph over 1000 characters, and a `docs/` file missing from CLAUDE.md's index.

## Hooks

- `pre-commit` (`.githooks/pre-commit`, enabled by `npm install`): `git diff --cached --check`, then `npm run check`'s steps (each `scripts/check.js` run first stops if `node_modules` is behind `package-lock.json`) in parallel on the staged content (unstaged edits to tracked files are set aside, then restored; untracked files stay, so a commit lacking one can still pass) — typecheck, lint, the CSS check and desktop e2e only when `public/`, `e2e/` or a frontend config is staged (`node scripts/setup-facts.js --cost` times it). It blocks the commit on failure. `npm install` also points `git blame` at `.git-blame-ignore-revs`.
- `pre-merge-commit`: the changelog check on the merge's whole diff — a feature branch's own commits skip the entry requirement, so its merge into `main` must carry them.
- `pre-push`: what CI runs (`npm run check`, then both widths of e2e) on HEAD; refuses a push of anything else or with untracked files, and sets uncommitted edits to tracked files aside for the checks, then restores them.
- Claude Code `PreToolUse` hook (`.claude/settings.json`): `scripts/bash-guard.js` refuses `pkill`, `killall` and `kill $(pgrep …)`, whose pattern matches the agent's own shell (exit 144) and can miss the server, and names the `down` scripts instead; each refusal goes to `.git/dev-metrics/bash-guard.jsonl`.
- CI (`.github/workflows/ci.yml`): `npm run check` and the e2e suite as two parallel jobs on Node 24, on every push to `main`, every PR and on demand (`workflow_dispatch`: `gh workflow run CI --ref <branch>`); the run's summary lists the journey steps the tests lock.
