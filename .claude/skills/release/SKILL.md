---
name: release
description: Cut a release — pick the version, consolidate CHANGELOG.md's Unreleased section into a dated version, bump package.json, commit and tag. Use when asked to release, cut, tag or version the app.
argument-hint: '[X.Y.Z]'
---

# Release

Only on an explicit request. Tags are `vX.Y.Z`, annotated, message `vX.Y.Z` (see `git show v0.4.0`).

## 0. Preconditions

- On `main`, clean tree (`git status --short` empty), and `## [Unreleased]` has entries.
- `git log --oneline $(git describe --tags --abbrev=0)..` — what the release covers; every code commit in it should have its changelog entry.
- `node scripts/deps-audit.js --full` exits 0; anything it fails on is [dependency-audit](../dependency-audit/SKILL.md)'s to fix first.

## 1. Pick the version

Pre-1.0: **minor** for anything under Added/Changed/Removed, **patch** for Fixed/Security only. Propose it with `AskUserQuestion`; the user decides.

## 2. Consolidate the changelog

`[Unreleased]` accumulates one entry per commit. CHANGELOG.md is too large to `Read` whole; read the section with `sed -n '/^## \[Unreleased\]/,/^## \[[0-9]/p' CHANGELOG.md`. Before cutting:

- Keep bullet order within each category; merge bullets that describe the same feature's evolution into its final state.
- Rewrite for a reader of the release, not of the commits: what changed for users first, implementation detail only when a developer needs it; drop internal references (`UX backlog U<n>`, file-by-file notes). Keep it short — CLAUDE.md's doc-prose rules apply.
- Show the consolidated section to the user before going on.

Then rename it `## [X.Y.Z] - YYYY-MM-DD` (today) and add an empty `## [Unreleased]` above it. `npm run format` — the pre-commit hook rejects an unformatted file (a bare `npx prettier --write` wipes Prettier's cache).

## 3. Bump, commit, tag

```bash
npm version X.Y.Z --no-git-tag-version   # package.json + package-lock.json
git add CHANGELOG.md package.json package-lock.json
git commit -m "Release X.Y.Z"            # body: one line on what the release is about
git tag -a vX.Y.Z -m vX.Y.Z
```

## 4. Push

Only when asked: `git push --follow-tags`.
