# dev-speed run state

Temporary: deleted in the last commit before the hand-off.

- Lane 3 done: C343, C302, C345, C299 (`--load=24`) and C300 (`--load=12`): 0 failed in 2 tries of 120 each, counts on the items, which stay open.
- Lane 1 done: `gitCommonDir(cwd)` in `scripts/dev-metrics.js`, six callers and one test switched; `npm test` passes.
- Lane 2 done: checks rows carry `load` and `checkout`; format on Prettier's `--experimental-cli --no-parallel` (hook format 1.00 → 0.24 s CPU; hook-equivalent 26.4 → 25.4 s CPU, 4.29 → 4.20 s wall). Lint: contention, no change. Cold caches per checkout: out of reach (absolute-path keys). Details on P81/P82.
- Queue:
  - Hook: run `test` apart from (or with fewer workers beside) the other steps — format and lint walls are contention with test; gain unmeasured.
  - Temporary run-state docs under `docs/` need a CLAUDE.md index line (doc-lint); a run prompt could keep its state at `.claude/` or the branch's commit bodies instead.
