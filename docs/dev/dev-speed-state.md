# dev-speed run state

Temporary: deleted in the last commit before the hand-off.

- Lane: 3 (e2e flakes), paused by the user on 2026-11-16.
  - C343: try 1 of 2: 0 failed in 120 (load median 42.5, max 53.3, 12 cores); try 2 stopped unfinished, rerun it. Then C302, C345, C299, C300.
  - C345 lead: `pauseAt(Date.now() + 1000)` before `goto`; a page load longer than 1 s leaves any timer or rAF the open waits on paused. Keep the trace and confirm.
- Lane 1 done: `gitCommonDir(cwd)` in `scripts/dev-metrics.js`, six callers and one test switched; `npm test` passes.
- Lane 2 done: checks rows carry `load` and `checkout`; format on Prettier's `--experimental-cli --no-parallel` (hook format 1.00 → 0.24 s CPU; hook-equivalent 26.4 → 25.4 s CPU, 4.29 → 4.20 s wall). Lint: contention, no change. Cold caches per checkout: out of reach (absolute-path keys). Details on P81/P82.
- Queue:
  - Hook: run `test` apart from (or with fewer workers beside) the other steps — format and lint walls are contention with test; gain unmeasured.
  - Temporary run-state docs under `docs/` need a CLAUDE.md index line (doc-lint); a run prompt could keep its state at `.claude/` or the branch's commit bodies instead.
