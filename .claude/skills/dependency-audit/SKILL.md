---
name: dependency-audit
description: Audit npm dependencies for unused, missing, outdated, duplicated or vulnerable packages, and refresh package-lock.json. Use when asked to check, review or update dependencies, or before a release.
---

# Dependency audit

Read-only by default. Nothing below writes until the "Applying" section, which needs an explicit go-ahead.

## 1. Findings

`node scripts/deps-audit.js --full` prints only problems; exits 1 on a failing one:

- **Declared but unused / Imported but undeclared** — from source, configs, npm scripts and `docs/`. `@babel/core` is exempt: it's `@babel/eslint-parser`'s required peer, never imported (`docs/dev/architecture.md`'s `eslint.config.mjs` bullet).
- **Vulnerabilities** (`npm audit`) — expected: none.
- **Lockfile out of sync** (`npm ci --dry-run`, `EUSAGE`) and **Invalid tree** (`npm ls --all`).
- **Behind its own range** — fixed by `npm update`, no `package.json` edit. **Range bump available** — needs `npm install <pkg>@latest`.
- **Collapsible duplicates** (`npm dedupe --dry-run`). Major splits it can't collapse (e.g. `vite-plugin-solid`'s Babel 7 tree beside the linter's Babel 8) are upstream, dev-only and not findings.

## Stale `typescript` peer ranges

An `ERESOLVE` warning, or an `invalid` `typescript` under Invalid tree, means a new package has a stale `typescript` peer range: add it to `package.json`'s `overrides` like the existing `@typescript-eslint/*` entries (safe — nothing there loads TypeScript), rather than bumping `eslint-plugin-solid` or declaring the noise benign.

## Applying

Confirm the changes first, then:

1. `npm update` for in-range drift, `npm install <pkg>@latest` for a range bump.
2. `npm run build` and `npm run test:e2e` — the pre-commit hook runs the rest, since the lockfile is staged. A 0.x minor bump can break like a major one even when its README and types show only additions. Report real output.
3. A lockfile-only change is still a code change: `CHANGELOG.md` entry in the same commit, per `CLAUDE.md`.
4. Surface new lint violations from a plugin bump rather than silencing them with `eslint-disable`.
5. An updated `@vates/data-table-solid` (or any package an improvements.md item waits on): re-check every item citing its issues (`grep -n 'vatesfr/data-table' docs/dev/improvements.md`) on `dev:mock`, and drop or narrow the ones it fixed — 0.16 shipped five such fixes that sat unnoticed.
