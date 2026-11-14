# Dev workflow speed (branch `dev-workflow-speed`) — delete before the merge

Goal: fastest, most reliable dev workflow; stop when the three best remaining levers each gain < 5 % on their target, or wait on a user decision. Active time only (in-process timings, step counts), load noted with each measure.

## Baseline (2026-11-14)

Sources: `.git/dev-metrics/checks.jsonl` (hook runs since 2026-10-25), transcripts since 2026-10-25 (287 files), `gh run list`, own runs. Machine: 12 cores.

| Target                   | Measure                                             | Baseline                                                                               |
| ------------------------ | --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| pre-commit, UI commit    | checks.jsonl `commit` rows with `e2e`, slowest step | p50 68 s, p90 116 s (e2e desktop; 253 runs)                                            |
| pre-commit, other commit | slowest non-e2e step                                | p50 6.4 s, p90 12.7 s (format p50 5.8, test 5.2)                                       |
| UI commit, agent side    | CLAUDE.md: phone e2e by hand before each UI commit  | + ~60 s per UI commit                                                                  |
| full `npm run test:e2e`  | `setup-facts.js --cost`                             | 122 s at load 0.6; ~8 min at load ~50 (P63)                                            |
| CI                       | `gh run view`                                       | e2e job 7 min 14 s (test step 6 min 37 s, 2 workers); check job 47 s                   |
| E2E_DEFER                | transcripts, `E2E_DEFER=1 … git commit`             | 202 of 880 commits, 19 sessions                                                        |
| hook bypass              | `--no-verify`                                       | 1                                                                                      |
| hook e2e failures        | transcripts, `✗ e2e` in commit/merge/push output    | 14                                                                                     |
| bash-guard refusals      | `.git/dev-metrics/bash-guard.jsonl`                 | 0 since 2026-11-02                                                                     |
| permission denials       | `setup-facts.js --transcripts`                      | 0 by the classifier (11 AskUserQuestion rejections: ~/.claude, P65)                    |
| volume                   | git                                                 | 784 commits since 2026-10-13 for 57 pushes (~14/push); 204 UI commits since 2026-10-25 |

Flake baseline: `node scripts/e2e-flakes.js --repeat=5 --load=12` (load 46.8, max 86.7, 2231 s): 43 flagged, 41 of them ENOENT on traces caused by my own concurrent e2e runs in the same checkout (fixed, L4); real: Clear search [desktop] 1/5 (`toBeVisible`), screenshot zoom [phone] 1/5 (timeout, C234). Its flakes.jsonl row is polluted by the 41.

## Levers (estimated gain / cost)

1. **pre-commit e2e → pre-push** (S): UI commit hook 68 s → ~6 s, phone-by-hand rule dropped, E2E_DEFER deleted (202 commits). Loses: e2e per intermediate commit; still caught by pre-push (both widths on HEAD) and CI.
2. **CI e2e sharded** (S): 7.2 min → ~3 min.
3. **Local Playwright workers** (S): measure 6 (default) vs 8/12 at real load.
4. **Flakes found by the baseline run** (S–M each): root-cause fixes.
5. **P64 phone subset** (L): up to −45 % of pre-push and CI e2e; triage of ~450 tests, risk of missing a phone regression.
6. **format on staged files** (S): non-UI commit 6.4 s → ~5.2 s (test bound).

## Done

- **L1 pre-commit e2e → pre-push** (P74): UI commit hook 68 s p50 (253 runs) → 13–20 s slowest step at load ~40 (3 runs, `node scripts/check.js --staged=HEAD~1` on a UI commit), the unit suite now the long pole. Re-measure at normal load.

- **L1b format cache** (P75): a cacheless `npx prettier` (1164 calls for 885 commits in transcripts) deleted the default cache, so the hook's format step re-read the tree. Dedicated `--cache-location`: 14.5 s → 0.85 s CPU, 32–65 s → 1.8–4.5 s at load 45–85 (4 runs each, `npx prettier --write PLAN.md; npm run -s format:check`).

- **L1c eslint cache** (P76): `--cache` (no type-aware rule): 3.3–3.6 s → 0.56–0.61 s CPU, 6.6–11.5 s → 1.6–3.4 s wall at load ~42; one large file touched: 1.24 s CPU.
- **L2 CI e2e in 4 shards** (P77): unmeasured until the branch runs CI (needs a push: asked). Estimate from the last run: test step 6 min 37 s / 4 + ~45 s of setup ≈ 2.5 min, plus a ~20 s summary job, vs 7 min 14 s.
- **L3 e2e build skip** (P78): `scripts/e2e.js` skips `vite build` when public/, static/, configs and lockfile hash as the build in place; 502 of 848 transcript e2e runs had no frontend change since the previous. One-test run (`node scripts/e2e.js --project=desktop -g 'A1: first visit'`): 20.8–23.0 s → 8.7–9.6 s at load ~40 (3 alternating pairs).
- **L4 per-port e2e output dir** (P79): two e2e runs in one checkout (sessions sharing the main checkout; `claimPort` allows it) shared `test-results/`, which each run empties on start, deleting the other's traces. Reproduction (40 phone tests, a second run started mid-way): 6 failed, 12 ENOENT → 0 failed in 5 of 5.
- **L5 Clear search flake** (P61): root cause an app bug, a search answering after × replaced the recents (any input now invalidates the in-flight search). New test fails before, passes after; `e2e-flakes.js --repeat=24 --load=24 --workers=12 -g 'Clear search'`: 0 of 144 at load median 40.5 (was 1/5 in the baseline run). Changelog at merge: "Clearing the nav search no longer lets a late answer replace the recently looked-up games".

## Negative results

- **Unit tests in one process** (`--test-isolation=none`): fails (shared module state, e.g. `Date is already being mocked`), and 23 s wall vs 15 s default at load ~42, though 8.4 s vs 19.4 s CPU. Would need every file made state-clean: not worth it.
- **auth.test.js nonce sweep** (O(n) per claim, O(n²) over the test's 10k sign-ins): stopping the sweep at the first live nonce saves 0.56 s CPU of the suite's ~19 s (< 5 %), in security code. Reverted.
- **Playwright workers 10 vs 6** (default): full desktop suite, 3 alternating pairs at load 23–64: 6 → 79/96/155 s, 10 → 108/78/98 s (medians 96 vs 98), and one more failure at 10. Load noise dominates; kept the default.
