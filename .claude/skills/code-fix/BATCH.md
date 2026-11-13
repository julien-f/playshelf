# Fix batch

Above about five items, code-fix and ux-fix run as parallel lanes: one background agent per lane, in its own worktree, merged `--no-ff`.

## 1. Plan (before any go-ahead)

- Commit the backlog first: a worktree only sees committed items.
- `node scripts/batch.js plan [--lanes=6] <items…>` groups the items into lanes that cite no code within 80 lines of each other (a file mentioned without any line counts whole), writes the manifest (`.claude/batch/`, gitignored) and prints an estimate from past batches. A bare `name.ts` counts when it names exactly one tracked file. Place by hand what it lists as naming no file. Lanes can still meet in code an item doesn't cite (a renamed helper's callers): `merge` then lists the conflicted files to resolve by hand, keeping both lanes' intent.
- Pull out of the lanes, to do yourself on `main` after the merges: an item whose fix changes what callers in other lanes read (a helper's return shape), and an item with an open fork.
- Present the recommended items (and why not the others), the lanes, the serial items and the estimate in one `AskUserQuestion`.

## 2. Launch

One `Agent` per lane, all in one message, `isolation: "worktree"`, with the lane template below. Each lane's report arrives as its notification: post one line per report or block, no polling (`node scripts/batch.js status` shows progress on demand).

## 3. Merge each lane as it reports

- `node scripts/batch.js merge <branch>`: merges `--no-ff --no-commit`, keeps both sides of CHANGELOG conflicts, and replays the lane's backlog edits on `main`'s side — lines it deleted are closed, lines it rewrote are narrowed — then prints which. journeys.md isn't replayed: a lane that dropped a closed item's ◇ merges it as an ordinary edit, so two lanes touching one journey line conflict there. Commit with `E2E_DEFER=1`, plus `SKIP_CHANGELOG=1` when `merge` says the lane added no entry (`Merge lane <X>: …`, body naming the items; the lane ran e2e before reporting), then `git worktree remove` and `git branch -d`.
- Then launch a background `Agent` to run `/code-review <merge>^1..<merge>` and report its findings without fixing them; it replaces code-fix's step 4 for the batch. Review the conflicts you resolved by hand yourself: a lane's review can't see where two lanes meet.
- Record what a lane reports as new problems, once verified, as backlog items.

## 4. After the lanes

`npm run test:e2e` once over the merged lanes, then the serial items, then the skill's look (ux-fix step 3; code-fix's UI-visible items), then the lane reviews' findings (verify each, fix the confirmed ones as follow-up commits, list the dropped ones with why), then `node scripts/batch.js record` (feeds the next estimate) and `node scripts/setup-facts.js --agents` (each agent's time, turns, failed calls, gate and tool time) for the report.

## Lane template

```
You fix <items> from <backlog file> in this repo, in your own git worktree (your working directory); commit on its branch, never touch main or push. The user approved the plan, which covers one commit per item.
- First run `git merge --ff-only main`: worktrees branch from origin/main, which lags local main. Then `npm ci`: an agent worktree has no `node_modules` of its own, and the main checkout's fail the hook ("node_modules is behind package-lock.json").
- Follow .claude/skills/<code-fix|ux-fix>/SKILL.md steps 0–<last step before the look>, one commit per item, skip the dev:mock look. Each fix commit deletes its own item's line from <backlog file> and touches no other item; a narrowed item's line is rewritten to what's left, never deleted.
- Blocked by something outside your items (a check red on main, a hook): SendMessage the lead with the cause and keep going on what you can; don't end the run.
- A real fork (fix widens past the item, a dependency, more upstream traffic): skip the item and report it.
- Stay in your worktree: no `git -C <main checkout>`, `--prefix` or `cwd` parameter; one plain command per Bash call, no `&&`/`;` chains or heredocs (you can't answer a permission prompt, and a chain is judged whole, so it's refused).
- Commit messages: write them to <scratchpad>/msg-<lane>.txt (the scratchpad is shared, a generic name gets overwritten), then `E2E_DEFER=1 git commit -F <file>`.
- Before each commit, run only your item's test file: the commit hook runs the unit suite, typecheck and lint, so don't run them by hand.
- Before reporting, run `npm run test:e2e -- --since=main` once (both widths; skipped when your commits touch no UI file) and fix what fails: re-run only the failures (`-- --last-failed`) until green. No full-suite rerun: the lead runs it once over the merged lanes. Don't start it while your `/code-review` runs.
- Then run `/code-review medium <your first commit>^..HEAD` and fix each confirmed finding, test first, as a follow-up commit; the lead's review of the merge then only has to catch where lanes meet.
Report: item → commit → how verified; review findings fixed and dropped (with why); anything skipped or narrowed and why; new problems found.
```
