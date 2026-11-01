# CLAUDE.md

Working conventions for this repo. Documentation lives in `docs/` — keep it there, not here (see Where things belong below).

## Project context

- **Stack**: Node >=22.15 + Express 5 backend, Solid + TypeScript frontend bundled by Vite, `node:sqlite` for `db.sqlite`; npm. Setup, dev servers and ports are in [README.md](README.md).
- **Tests**: `npm test` (no real database), one file with `npm run test:one test/<name>.test.js`; end-to-end `npm run test:e2e` (every `/api` call mocked). Details, the hooks, and the rules for writing reliable tests: [testing.md](docs/dev/testing.md#writing-reliable-tests).
- **Looking at the UI**: `npm run dev:mock` (or `node scripts/mock-server.js up` from an agent session), not the real dev server — that one writes the user's real prefs, so follow [testing.md](docs/dev/testing.md)'s seed/restore steps before using it.

## Where things are documented

- [README.md](README.md) — what the app is, setup, dev commands
- [docs/user/features.md](docs/user/features.md) · [docs/user/configuration.md](docs/user/configuration.md) — user-facing: what it does, every setting
- [docs/dev/architecture.md](docs/dev/architecture.md) — backend modules, build/dev setup, API routes, request flow
- [docs/dev/frontend.md](docs/dev/frontend.md) — SPA routes, module map, **reactivity rules**, URL state
- [docs/dev/game-table.md](docs/dev/game-table.md) — the game table, each list kind, saved views
- [docs/dev/panel-and-lightbox.md](docs/dev/panel-and-lightbox.md) — the side panel, the lightbox, the presentation window
- [docs/dev/lists-and-accounts.md](docs/dev/lists-and-accounts.md) — the account/list data model and its localStorage schema
- [docs/dev/integrations.md](docs/dev/integrations.md) — Steam/HLTB/ITAD/ProtonDB, including which endpoints are undocumented and the compliance notes on them
- [docs/dev/data.md](docs/dev/data.md) — `db.sqlite`, cache tiers and TTLs, the three refresh paths
- [docs/dev/observability.md](docs/dev/observability.md) — `GET /api/metrics`, outbound budgets, proactive log warnings
- [docs/dev/journeys.md](docs/dev/journeys.md) — user journeys (goal, numbered steps, done-when); the basis for design reviews and end-to-end tests
- [docs/dev/ui-guidelines.md](docs/dev/ui-guidelines.md) — UI conventions where scenarios and feature docs are silent, and the checklist for a new UI feature
- [docs/dev/improvements.md](docs/dev/improvements.md) — UX backlog from design reviews, keyed to scenarios
- [docs/dev/code-backlog.md](docs/dev/code-backlog.md) — code backlog from `code-audit` runs (simplify, security, perf, reliability, compliance, tests)
- [docs/dev/setup-backlog.md](docs/dev/setup-backlog.md) — `setup-review` proposals: changes applied and the measure each must move, open ones, declined ones with the reason
- [docs/dev/decisions.md](docs/dev/decisions.md) — Weighted Rating vs. Wilson score, the Production Tier heuristic, player likeness as a count, native trailer playback, linting with Babel
- [docs/dev/testing.md](docs/dev/testing.md) — unit and e2e tests, the mocked server, the real dev server's prefs seed/restore, the git hooks
- [docs/dev/pitfalls.md](docs/dev/pitfalls.md) — surprising behaviors, misleading errors and their fixes; on an unexpected error, `grep -ri '<fragment>' docs/ .claude/skills/` first
- [docs/images/](docs/images) — the screenshots the docs embed; shooting them is the `screenshots` skill

Read the relevant one before changing that area. Two are load-bearing: **frontend.md's reactivity rules** (`npm run lint` enforces the no-reactive-`const` one), and **integrations.md's trust tiers** — several upstreams are undocumented and unsanctioned, so don't scale request volume without revisiting them.

## Code conventions

- **Types**: `tsc --noEmit`, strict, over `public/**/*.{ts,tsx}`, plus `e2e/` via `tsconfig.e2e.json` — the backend is plain JS.
- **Error handling**: routes catch and map through `routeErrorStatus` (client error → 400, upstream → 502, timeout → 504, anything unmarked → 500) and reply `{ error }`, generic for a 500 or an unparseable upstream body: the detail stays in the log. Check an upstream body's shape before caching it, else throw `upstreamError`. An optional source (HLTB, ProtonDB, reviews) that fails logs a `[tag]`-prefixed `console.warn` and degrades instead of failing the request; the UI then says the source didn't answer rather than showing no data.
- **Lint**: `eslint public --max-warnings=0`, via eslint-plugin-solid; stays at 0 problems (a warning fails it), and the few intended violations carry a targeted `eslint-disable-next-line` with a reason.
- **Upstream workarounds**: the comment ends `Remove once <Bugzilla or GitHub issue URL> is fixed` (`id=TODO` until filed), so `node scripts/upstream-bugs.js` lists them with each bug's state.
- **Format**: Prettier over the whole tree (`.prettierrc.json`); `npm run format` rewrites, `npm run format:check` verifies. Let it format instead of hand-formatting, and don't fight its output.

## Working style

These add to the user-level `~/.claude/CLAUDE.md` working style.

- Concision extends to code comments and doc prose:
  - Code comments: one line (two at most, for a _why_ that needs it), stating the _why_, only when it isn't obvious from the code; skip the comment entirely if the code speaks for itself. This governs new comments; leave the long-form ones already in the tree alone.
  - Doc prose (this file, `README.md`, `CHANGELOG.md`, `docs/`): short bullets over paragraphs; no preamble, no summary section, lead with the point. Docs state current behavior and its why, never how it got there (that's commits and `CHANGELOG.md`); each number lives in one place (`default.env`, or the doc that owns it) and the others link it.
- Saying something is done includes where to see it: the route and steps for a UI change, the link to a posted comment or issue after checking it exists.
- A user-facing feature's plan review includes one as the app's users ([journeys.md](docs/dev/journeys.md)'s _Who / goal_): would they use it, is it worth its place?
- When code models an upstream's behavior (pricing, limits, matching rules) from inference rather than its docs, state the assumption in the plan and confirm it before building on it; record confirmed rules and remaining assumptions in [integrations.md](docs/dev/integrations.md).

## Ask first

- Besides the user-level list: deleting or hand-editing `db.sqlite` (`npm run cache:clear` empties its cache tables without touching the file), overwriting the `steam.isonoe.net:prefs` localStorage backup a screenshot run left behind.
- **Environments**: local dev servers, `dev:mock` and the test suites are safe; the live site (steam.isonoe.net) and its server need explicit approval.
- Committing: approving a multi-step plan is the go-ahead to commit each step.

## Where things belong

The user-level rules apply; here:

- Substantial detail goes in a `docs/` file linked from Where things are documented above, not duplicated in this file.
- `.env` is gitignored; `default.env` documents every setting.

## Git workflow

- **Message format**: a plain imperative subject, no Conventional Commits prefix — the `feat:`/`fix:` prefixes in older history were dropped; don't reintroduce them.
- Ordinary changes commit directly to `main` — this is a solo repo with no PR/review process. A complex feature (multiple concerns, significant refactoring, a new subsystem) spanning more than one commit gets a dedicated branch instead, worked in its own worktree (`node scripts/worktree.js <branch>`: adds it and runs `npm ci`): other agents share the main checkout, so never switch its branch. A worktree's e2e and mock servers get their own ports (`node scripts/ports.js e2e|mock`).
- A merge into `main` that conflicts is made in the branch's worktree, never in the main checkout: `git switch --no-track -c <branch>-merge main`, `git merge --no-ff <branch>`, resolve and commit there, then `git merge --ff-only <branch>-merge` in the main checkout. Its commit runs the full pre-commit hook for minutes, and a merge pending that long in the shared checkout gets aborted or absorbed by another session ([pitfalls.md](docs/dev/pitfalls.md)).
- Before closing a session, or when asked what's left: `node scripts/session-end.js` lists unpushed commits, uncommitted changes, merged worktrees and branches, running servers, and workarounds whose upstream bug closed or isn't filed yet.
- Chasing a CI-only failure: experiment on a branch and run CI there (`gh workflow run CI --ref <branch>`), never by pushing to `main`.
- A parallel fix batch ([BATCH.md](.claude/skills/code-fix/BATCH.md)) works the same way, one branch per lane, each closed with `git merge --no-ff`.

## Development workflow

After making changes:

1. Update or add tests to cover the change: the single-file command while iterating, then `npm run format`. Before committing a UI change, run only `npm run test:e2e -- --project=phone`: the hook runs desktop e2e, pre-push both widths. Fixing a failing or flaky test: search [code-backlog.md](docs/dev/code-backlog.md) for its name first, and close the matching item in the same commit.
2. Update any affected documentation — see Where things belong above — and `CHANGELOG.md` (see Changelog below).
3. Record what was surprising, misleading or broken, and its fix: as a comment or test when tied to specific code, otherwise as a rule in the doc its reader is in (keeping the exact error text), or in [pitfalls.md](docs/dev/pitfalls.md) when no doc fits; machine-specific ones in Claude's memory. Symptom first (exact error text), then cause and fix. Delete entries once obsolete.
4. Verify with `npm run check` (its steps: `steps()` in [check.js](scripts/check.js)). When committing, the `pre-commit` hook runs its relevant steps on what's staged (plus desktop e2e on UI changes; fix-batch lanes defer it with `E2E_DEFER=1` and run the suite once before reporting, [BATCH.md](.claude/skills/code-fix/BATCH.md)) and blocks on failure, so don't also run it by hand; the `pre-push` hook runs what CI runs (see [testing.md](docs/dev/testing.md#hooks)). Fix what it reports.

## Changelog

Every code change updates `CHANGELOG.md`, in the same commit as the code it documents — on a feature branch, by its `--no-ff` merge instead (one entry per feature, not per step). The pre-commit hook enforces it for `public/`, `lib/` and `server.js` on `main`, the pre-merge-commit hook on merges; `SKIP_CHANGELOG=1 git commit` only for one that genuinely needs no entry (a pure refactor). Add entries with `node scripts/changelog-add.js <Section> "<entry>"` (it files them under `## [Unreleased]`), in [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) sections (Added / Changed / Fixed / Removed) plus a last `### Development` for changes only contributors see (tooling, checks, mock data). One user-facing line per entry, no implementation detail; `npm run check` enforces the structure and length.
