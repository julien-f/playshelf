# Pitfalls

Surprising behaviors, misleading errors and their fixes. One entry each: symptom first (exact error text when there is one), then cause and fix. Delete entries once obsolete.

## Dev servers

### `is outside of Vite serving allow list`: a blank page after `npm run dev:mock`

- **Symptom**: the app stays blank; the server logs `The request id ".../node_modules/@solidjs/router/..." is outside of Vite serving allow list`, and the browser gets a 403 for it.
- **Cause**: a page requested Solid's router while Vite was still optimizing dependencies on startup. `node scripts/mock-server.js up` waits for that; a server started by hand doesn't.
- **Fix**: wait a few seconds and reload; the same file is then served (200).

### `dev:mock` serves older CSS or modules

- **Symptom**: a page shows CSS or code older than the file on disk, and a reload doesn't fix it.
- **Cause**: `node scripts/mock-server.js up` restarts a server it started at another git HEAD, but uncommitted edits don't move HEAD.
- **Fix**: `node scripts/mock-server.js down`, then `up`.

### `ReferenceError: <name> is not defined` in the browser console mid-edit

- **Symptom**: the console of a page open on a dev server logs `ReferenceError` for a function that exists, with two `ListRoute.tsx?t=…` versions in the stack.
- **Cause**: hot reload picked up a module between two edits (e.g. a call added before its import).
- **Fix**: reload the page and check again before treating it as a bug.

### `listen EADDRINUSE`: a new `/api` route answers `Cannot GET` under `npm run dev`

- **Symptom**: the page says a source "didn't answer"; `curl localhost:3000/api/<route>` returns Express's `Cannot GET /api/<route>` HTML; the `backend` log says `Error: cannot listen on <host>:3000: listen EADDRINUSE`.
- **Cause**: another worktree's dev server already holds port 3000, so this checkout's backend never binds and Vite proxies `/api` to the other one, which runs older code.
- **Fix**: `ss -ltnp 'sport = :3000'` names the process holding the port (`node scripts/session-end.js` lists only servers started through `mock-server.js`/`dev-server.js`); start this checkout's with `node scripts/dev-server.js up`, which gives a worktree its own ports, or stop the other.

## Tests

### `TypeError: … is not a function` from the pre-commit hook in a test the commit doesn't include

- **Symptom**: the hook's `test` step fails in a new test file that isn't staged, e.g. `TypeError: needsRestart is not a function`.
- **Cause**: the hook sets aside unstaged edits to tracked files but leaves untracked ones, so a new test for code you haven't staged runs against the old code.
- **Fix**: commit a script and its new test together, and move other changes' untracked tests out of the tree until their commit.

## Git, hooks and parallel agents

### `node_modules is behind package-lock.json` on a commit in the main checkout

- **Symptom**: `scripts/check.js` (the hooks, `npm run check`) stops with `✗ node_modules is behind package-lock.json: <package> (…). Run npm ci.`, though the branch passed (typically a merge that brings a lockfile change).
- **Cause**: worktrees run their own `npm ci`; the main checkout's `node_modules` stays at whatever it last installed.
- **Fix**: `npm ci` in the main checkout, then commit the merge again (it stays staged).

### `Connection to github.com closed by remote host` during `git push`

- **Symptom**: the pre-push hook's e2e output shows `Connection to github.com closed by remote host`, then `error: failed to push some refs`, even when every test passes.
- **Cause**: git opens the SSH connection before running the hook; GitHub drops it while the full e2e run (~8 min) keeps it idle.
- **Fix**: run `npm run test:e2e -- --if-changed` before pushing: its passing run is recorded, so the hook skips e2e and pushes at once.

### Another agent's commit shows a branch as merged without its changes

- **Symptom**: `git log --graph` shows someone else's commit with a branch as second parent, but its tree lacks that branch's changes, which are still staged.
- **Cause**: a merge left pending in the main checkout (`--no-commit`, conflicts, or a hook that blocked the merge commit) keeps `MERGE_HEAD`; the next `git commit` there, by any agent, becomes the merge and takes only what that agent staged. Another session may instead abort it (`reset: moving to HEAD` in the reflog, the merge's new files left untracked), even while its own commit runs the hook.
- **Fix**: merge in the branch's worktree with `node scripts/merge.js start|finish`, as CLAUDE.md's Git workflow says; `git merge --abort` one left pending. Once absorbed, commit the staged changes on top, naming the absorbing commit in the message.

### `fatal: this operation must be run in a work tree` after a commit

- **Symptom**: other checkouts fail with that error (`core.bare` turned `true`), stray commits from a test's throwaway repo sit on a branch, or branches you never made appear.
- **Cause**: a test spawned `git` with the hook's `GIT_DIR`/`GIT_INDEX_FILE`, so it acted on the real repo; `npm test` strips `GIT_*` (`test/gitEnv.js`), so the test ran another way.
- **Fix**: `git config core.bare false`, then move the affected refs back with `git update-ref` (their reflogs show the previous commit).

### A `Merge lane …` commit carries another session's backlog edits

- **Symptom**: the merge carries `docs/dev/improvements.md` (or `code-backlog.md`) lines no lane wrote, and that file's uncommitted edits vanish from `git status` in the main checkout.
- **Cause**: a hand `git add` of a whole backlog file during the merge swept in another session's uncommitted edits (`node scripts/batch.js merge` stages only the lane's).
- **Fix**: `git restore --source=HEAD^1 --staged <file>`, then `git commit --amend`: the swept-in edits leave the commit and stay in the working tree.

### Staging one hunk from a patch lands it in the wrong place

- **Symptom**: `pre-commit` fails `format` on lines that look right in the working tree; the staged file (`git show :<file>`) has them inside another function.
- **Cause**: a patch made with `git diff -U0` and staged with `git apply --cached --unidiff-zero` carries no context, so its line numbers count the hunks left out: it applies at the shifted line.
- **Fix**: build the staged content from `HEAD` (`git show HEAD:<file>`, edit, then `git update-index --cacheinfo 100644,$(git hash-object -w <copy>),<file>`), or commit the hunks in the order they sit in the file.
