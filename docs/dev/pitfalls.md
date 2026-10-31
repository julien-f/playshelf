# Pitfalls

Surprising behaviors, misleading errors and their fixes. One entry each: symptom first (exact error text when there is one), then cause and fix. Delete entries once obsolete.

## An upstream fails with `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`

- **Symptom**: a `[tag]` warning in the server log with that error, for every uncached game, while cached ones still show.
- **Cause**: the endpoint answered HTML: it was retired and redirects to a home page (Steam's `appreviews`, 2026-10-22), or it serves a block page. `fetch` follows redirects, so metrics count the final page's 200. Steam store calls don't follow them: they fail with `Steam store: 302 redirect to …` and count as 302.
- **Fix**: `curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' '<url>'`; then check the upstream's announcements for a replacement.

## Tests run slowly when started without `npm test`

- **Symptom**: `node --test` on store-backed tests spends most of its time idle.
- **Cause**: upstream calls are paced by `STORE_MIN_INTERVAL_MS` (500 ms) and `UPSTREAM_MIN_INTERVAL_MS` (1000 ms, both in `default.env`), which `npm test` sets to 0.
- **Fix**: run a single file with `npm run test:one test/<name>.test.js`, which sets them to 0.

## A unit test still sees an earlier test's module state after `delete require.cache[…]`

- **Symptom**: a module-level value (a memoized fetch, a counter) carries over between tests even though each test deletes the module from `require.cache` and requires it again.
- **Cause**: a `.ts` module's own `import`s go through Node's ESM loader, which `require.cache` doesn't cover, so only the module required directly is reloaded.
- **Fix**: keep state a test must reset in a factory the test calls (like `createPanelDataCache()`), not at module level in an imported module.

## `ReferenceError: <name> is not defined` in the browser console mid-edit

- **Symptom**: the console of a page open on a dev server logs `ReferenceError` for a function that exists, with two `ListRoute.tsx?t=…` versions in the stack.
- **Cause**: hot reload picked up a module between two edits (e.g. a call added before its import).
- **Fix**: reload the page and check again before treating it as a bug.

## A commit fails on `TypeError: … is not a function` in a test it doesn't include

- **Symptom**: the pre-commit hook's `test` step fails in a new test file that isn't staged, e.g. `TypeError: needsRestart is not a function`.
- **Cause**: the hook sets aside unstaged edits to tracked files but leaves untracked ones, so a new test for code you haven't staged runs against the old code.
- **Fix**: commit a script and its new test together, and move other changes' untracked tests out of the tree until their commit.

## `dev:mock` measures a layout from older CSS

- **Symptom**: after commits in the main checkout, a page measured on `:58993` shows old CSS (a desktop rule missing, a box at its pre-change width) though the file on disk has the change.
- **Cause**: the server kept serving modules from before the commits; a reload doesn't fix it.
- **Fix**: `node scripts/mock-server.js up` restarts a server it started at another git HEAD. Uncommitted edits don't move HEAD: run `down` then `up` if they look stale.

## A ux-review at 390 px sees desktop-only UI on "phone"

- **Symptom**: a hint or hover affordance hidden on touch screens (e.g. `/rank`'s `.rank-hint`) still shows in a 390×844 Playwright MCP screenshot.
- **Cause**: `ux-measure.js` and `browser_resize` only shrink the viewport; the browser keeps its mouse, so `(any-pointer: fine)` / `(hover: hover)` still match.
- **Fix**: check touch-only rules in the e2e `phone` project (`hasTouch: true`), not on a resized desktop browser.

## A blank page right after starting `npm run dev:mock`

- **Symptom**: the app stays blank; the server logs `The request id ".../node_modules/@solidjs/router/..." is outside of Vite serving allow list`, and the browser gets a 403 for it.
- **Cause**: a page requested Solid's router while Vite was still optimizing dependencies on startup.
- **Fix**: wait a few seconds and reload; the same file is then served (200).

## `page.goto: net::ERR_ABORTED` right after closing the panel or lightbox in an e2e test

- **Symptom**: a `page.goto` issued straight after a ×/Esc close fails with `net::ERR_ABORTED`, on CI more than locally.
- **Cause**: the close steps history back over the overlay's own entry (`overlayHistory.ts`) with an asynchronous `history.go`, and that traversal aborts the navigation already under way.
- **Fix**: wait for the step's `popstate` before navigating (see the L4 Recently Looked Up test).

## Exit 144, then `Port 58991 is already in use` (or 58993), after `pkill -f`

- **Symptom**: `pkill -f vite` (or `node server.js`) ends the command with exit 144, and the next start fails on a busy port or gets connection refused.
- **Cause**: the pattern matches the shell running the `pkill` command itself, so it kills that shell, and it can miss the server's actual process.
- **Fix**: stop servers with `node scripts/mock-server.js down` / `node scripts/dev-server.js down`, never `pkill`.

## A new `/api` route answers `Cannot GET` (404) under `npm run dev`

- **Symptom**: the page says a source "didn't answer"; `curl localhost:3000/api/<route>` returns Express's `Cannot GET /api/<route>` HTML.
- **Cause**: another worktree's dev server already holds port 3000, so this checkout's backend never binds and Vite proxies `/api` to the other one, which runs older code.
- **Fix**: `node scripts/session-end.js` lists running servers; start this one on a free port with `PORT=3001 npm run dev` (Vite's proxy reads the same `PORT`), or stop the other.

## `document is not defined` in `browser_run_code_unsafe`

- **Symptom**: `ReferenceError: document is not defined` (or `localStorage`, `setTimeout`, `require`) from a Playwright MCP code call.
- **Cause**: the code runs in Playwright's sandbox with `page`, not in the page.
- **Fix**: DOM and storage access go inside `page.evaluate(() => …)`; wait with `page.waitForTimeout(ms)`; pass a script file through `filename`.

## `File access denied … is outside allowed roots` from Playwright MCP

- **Symptom**: a screenshot path or `filename` in the scratchpad or `/tmp` is refused.
- **Cause**: the Playwright MCP server reads and writes only under the repo's `.playwright-mcp/`.
- **Fix**: keep MCP inputs and outputs under `.playwright-mcp/` (gitignored).

## A background agent's chained `git` command or heredoc is refused

- **Symptom**: in an agent worktree (`.claude/worktrees/`), a chained command (`git add … && git commit …`) or a multi-line `python3` heredoc is denied, while the same steps run one by one go through.
- **Cause**: a background agent can't answer a permission prompt, so any command its rules don't allow outright is refused, and a compound command is judged as a whole.
- **Fix**: one plain command per call; commit with `git commit -F <file>` instead of a heredoc message, and write scripts to a file before running them.

## `window is not defined` requiring a table module from a unit test

- **Symptom**: `require('../public/gameColumns.ts')` (or any module importing `@vates/data-table-solid`) throws `ReferenceError: window is not defined` under `node:test`.
- **Cause**: `@vates/data-table-solid` touches `window` when it loads.
- **Fix**: resolve it to `@vates/data-table-core`, which provides the helpers, with a `module.registerHooks` resolve hook in the test (see `test/gameColumns.test.js`; needs Node ≥ 22.15).

## A unit test's effect never re-runs on a module's signal

- **Symptom**: an effect created in a test with `require('solid-js')` runs once and never again when a `public/` module's signal changes.
- **Cause**: `require` loads solid-js's CommonJS build, while the `.ts` modules `import` its ESM build: two Solid instances that don't see each other's signals.
- **Fix**: `await import('solid-js')` in the test (see `test/authStore.test.js`).

## The e2e run fails at start while agents run in parallel

- **Symptom**: `npm run test:e2e` (or the pre-commit hook's e2e step) fails at start with `http://localhost:28992 is already used, make sure that nothing is running on the port/url`.
- **Cause**: a run never reuses a server already on its port (it would serve another checkout's build). Each worktree draws its own port from its path (`portOf` in `scripts/ports.js`), so this takes two runs in the same checkout, or two worktree paths landing on the same port.
- **Fix**: wait for the other run, or pick a port: `E2E_PORT=<free port> git commit …` (or `npm run test:e2e`).

## A column menu opened by an e2e click closes at once on phone, on CI only

- **Symptom**: after `menu.click()`, the next step waits forever for an item of the header menu (`locator.click: Test timeout`); the error context shows the menu closed.
- **Cause**: the header button sits past the phone's right edge (grouping widens the table; CI's fonts add a few pixels more than local ones). `click()` scrolls `.dt-table-wrap` to reach it, that scroll event fires after the menu opened, and data-table closes a menu on any scroll outside it.
- **Fix**: `await menu.scrollIntoViewIfNeeded()`, then wait a frame (`page.evaluate(() => new Promise(requestAnimationFrame))`) before the click. To reproduce locally, narrow the viewport until the button straddles the edge (e.g. 370 px).

## A merge fails the hook in the main checkout, though the branch passed

- **Symptom**: `scripts/check.js` (the hooks, `npm run check`) stops with `✗ node_modules is behind package-lock.json: <package> (…). Run npm ci.` Before that check existed, the same cause showed as `error TS2353: … does not exist in type 'ColumnDef<…>'` or `Rolldown failed to resolve import "lucide-solid/icons/blend"`.
- **Cause**: worktrees run their own `npm ci`; the main checkout's `node_modules` stays at whatever it last installed, behind the lockfile.
- **Fix**: `npm ci` in the main checkout, then commit the merge again (it stays staged).

## Another agent's commit shows a branch as merged without its changes

- **Symptom**: `git log --graph` shows someone else's commit with a branch as second parent, but its tree lacks that branch's changes, which are still staged.
- **Cause**: a merge left pending in the main checkout (`--no-commit`, or a hook that blocked the merge commit) keeps `MERGE_HEAD`; the next `git commit` there, by any agent, becomes the merge and takes only what that agent staged.
- **Fix**: never leave a merge pending in the main checkout: on a blocked merge commit, retry at once (another run on the e2e port: `E2E_PORT=<free port>`, above) or `git merge --abort`. Once absorbed, commit the staged changes on top, naming the absorbing commit in the message.

## A worktree agent's branch lacks the latest commits

- **Symptom**: an agent started with `isolation: "worktree"` doesn't see a commit just made on `main` (e.g. backlog items it was asked to fix: "the section reads None open").
- **Cause**: the worktree branches from `origin/main`, not local `main`, which is ahead until pushed.
- **Fix**: have the agent run `git merge --ff-only main` first (BATCH.md's lane template does), and commit what it needs before launching it.

## Two agents' commits swap messages

- **Symptom**: a commit made with `git commit -F <scratchpad>/msg.txt` carries another agent's message.
- **Cause**: the session scratchpad is shared by every agent, so a generic file name is overwritten between one agent's write and its commit.
- **Fix**: name message files per agent or lane (`msg-<lane>.txt`).

## An e2e layout test fails in CI only

- **Symptom**: a position or size check passes locally and fails in CI by a few pixels.
- **Cause**: something other than the committed fonts drives the layout there (the e2e browser already renders with `e2e/fonts/`, testing.md): a glyph DejaVu lacks falling back to a system font, or a Chromium version gap.
- **Fix**: fix the CSS (size to content, set a line height), not the threshold. To find the change that broke it, diff against the last green run's commit (`gh run view <id> --json headSha`), not just the newest commit: one push can carry many.

## A closed `[popover]` panel shows anyway

- **Symptom**: a popover panel sits on the page, in flow under its button, before anything opened it; `toBeHidden()` on it fails.
- **Cause**: the browser hides a closed popover with a user-agent `display: none`, which any `display` in the app's CSS (`.account-chip-panel`'s `flex`) overrides.
- **Fix**: set a panel's `display` only while open, `:popover-open { display: flex }`, as `.account-chip-panel` does in `styles/components.css`.

## A `.dt-*` override has no effect

- **Symptom**: a rule restyling the table library (e.g. `.table-container .dt-th { background: … }`) shows in DevTools as overridden by the library's own rule, though its selector is more specific: the header row turns the library's light default.
- **Cause**: `@vates/data-table-solid` injects an unlayered `<style>`, and an unlayered rule beats any rule in a `@layer`, whatever its specificity or order.
- **Fix**: keep every `.dt-*` override, and the `html:root { --color-* }` theme, in the unlayered `styles/vendor-data-table.css`, not in a layer.

## A tainted-canvas fallback can't be tested through `page.route`

- **Symptom**: an image served by `route.fulfill` without `Access-Control-Allow-Origin` still loads with `crossOrigin = 'anonymous'` and its canvas reads fine, so the "no CORS" path never runs (seen checking the panel tint, `artTint.ts`).
- **Cause**: observed with Playwright's Chromium: a fulfilled cross-origin response passes the CORS check whatever its headers.
- **Fix**: serve the image from a real server on another origin (`python3 -m http.server` on a spare port) and call the code from the page.

## A Lucide icon that exists fails the typecheck

- **Symptom**: `error TS2307: Cannot find module 'lucide-solid/icons/history' or its corresponding type declarations.`, though `node_modules/lucide-solid/dist/source/icons/history.jsx` exists and the dev server renders it.
- **Cause**: some icon names are aliases kept for renamed icons; they ship as source re-exports with no `.d.ts`.
- **Fix**: import the canonical name the alias re-exports (`history.jsx` imports `./rotate-ccw-clock`), which has types.

## ← and → draw smaller than ↑ and ↓, or in another face

- **Symptom**: in the same text, ← → render small and thin beside ↑ ↓, or in a different face.
- **Cause**: the system faces in the font stacks differ in arrow coverage; seen in Chromium on Fedora: Noto Sans has none of U+2190–U+2193, so each falls back on its own, and Liberation Mono draws ← → at half the height of ↑ ↓.
- **Fix**: key caps go through `Kbd.tsx`, which draws all four arrows as Lucide icons; elsewhere, use a Lucide icon rather than a text arrow that must match its neighbours.

## An e2e locator's element goes `null` mid-test while the list looks unchanged

- **Symptom**: `boundingBox()` (or another one-shot read) returns `null` under load, e.g. F1's "a DLC's capsule that fails to load hides" failing 3 in 60 runs beside another suite.
- **Cause**: a prop passed as `body={body()}` is a getter, so every signal `body()` reads rebuilds its whole DOM; the DLC card swapped its streamed list for a new one when loading finished, detaching the element the locator had found.
- **Fix**: build the JSX once (`body={body}`) with `<Show>`/`<For>` inside, over one memo for every state, so entries already shown keep their element (as `DlcSection` in `panel.tsx`).

## `<A> and 'use' router primitives can be only used inside a Route.` from a table toolbar

- **Symptom**: that uncaught error, from a component using `useNavigate`/`useLocation`/`<A>` in a list's table toolbar.
- **Cause**: `ListRoute.tsx` renders the table (and its `toolbarEnd`) with its own `render()` call, outside the router's context.
- **Fix**: pass a callback from the route instead, or render the control in the route's own JSX (the hero).

## A Playwright `page.route('**/api/prices', …)` never fires

- **Symptom**: the handler (holding or failing a response) is skipped and the real mock answers, sometimes making a test flaky rather than failing.
- **Cause**: a glob matches the whole URL, query included, so `**/api/prices` misses `/api/prices?country=…`.
- **Fix**: end the glob with `**` (`**/api/prices**`), or spell out the query.

## Staging one hunk from a patch lands it in the wrong place

- **Symptom**: `pre-commit` fails `format` on lines that look right in the working tree; the staged file (`git show :<file>`) has them inside another function.
- **Cause**: a patch made with `git diff -U0` and staged with `git apply --cached --unidiff-zero` carries no context, so its line numbers count the hunks left out: it applies at the shifted line.
- **Fix**: build the staged content from `HEAD` (`git show HEAD:<file>`, edit, then `git update-index --cacheinfo 100644,$(git hash-object -w <copy>),<file>`), or commit the hunks in the order they sit in the file.

## Focus or `blur` behaves impossibly in Playwright's Firefox

- **Symptom**: after a click into an iframe, Playwright's `firefox` fires no `blur`/`focusout` in the parent, and `element.focus()` there can't take focus back (`document.activeElement` stays the `<iframe>`).
- **Cause**: Playwright's patched Firefox build emulates focus; stock Firefox fires both and refocuses.
- **Fix**: check focus behaviour on stock Firefox: `firefox.launch({ channel: 'moz-firefox', executablePath: <the system firefox>, headless: true })` (WebDriver BiDi).
