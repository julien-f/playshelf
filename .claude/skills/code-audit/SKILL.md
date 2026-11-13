---
name: code-audit
description: Audit the codebase (not a diff) for simplification, correctness, security, performance, reliability, upstream-compliance, test-coverage and doc-accuracy issues, record verified findings in docs/dev/code-backlog.md, and report them ranked. Use when asked to review, audit or assess the code or app as a whole, or one dimension of it (e.g. "security review of the app", "where can the code be simpler", "are the docs still accurate?").
---

# Code audit

Judges the code against this repo's own rules and docs, not general taste. A diff goes to `/code-review`, `/simplify` or `/security-review` instead; dependencies go to [dependency-audit](../dependency-audit/SKILL.md). Findings only, no fixes: [code-fix](../code-fix/SKILL.md) fixes them.

## Scope

- **Argument**: one dimension (below), optionally a path (`lib/`, `public/panel.tsx`). No argument: audit the dimension with the oldest last audit in [code-backlog.md](../../../docs/dev/code-backlog.md)'s header (ties: the first in step 2's order) and say which, without asking.
- **One dimension over the whole codebase**: one `Agent` per area (backend · `ListRoute` · panel and lightbox · table and routes · stores), launched in one message, each given the dimension's checklist, the finding bar and what's out of scope; verify every finding yourself before recording it.
- **`all`** runs every dimension: one `Agent` subagent per dimension, launched in one message, each given its checklist below and the finding bar. It's expensive — only on an explicit request.
- Say what was covered and what was skipped, and why.

## 1. Facts first

Run before reading code, so the review doesn't spend effort on what tools already say:

- `npm run check` — a failure is a finding as-is; don't re-derive it.
- `npm run build` — chunk sizes, for **perf**.
- `node scripts/deps-audit.js` and `npm audit` — for **security** and **simplify**; anything beyond that is dependency-audit's job.
- `node scripts/dead-exports.js` — for **simplify**: frontend exports no other file uses.
- Read [code-backlog.md](../../../docs/dev/code-backlog.md) and [pitfalls.md](../../../docs/dev/pitfalls.md): what's already recorded is not a new finding.

## 2. Review the dimension

Read the doc each dimension names first; it defines what "wrong" means here.

- **simplify** — CLAUDE.md's Simplicity rules: dead exports, params, flags and branches; duplication across modules (and code better moved to a shared one); abstractions or options with a single caller; temporary code whose removal condition has been met; hand-rolled code a dependency already in use provides.
- **correctness** — wrong results in a reachable state: state, classes or flags set on one path and never cleared on another; timers restarted without resetting what they guard; callers reading one helper's result differently (e.g. "failed" taken for "off"); edge inputs (empty, one item, repeated, out of order) through branches no test reaches. Races on stale responses stay under **reliability**.
- **security** — request input (steam IDs, vanity names, list params, query strings) reaching upstream URLs, SQL or file paths; SQL built by interpolation instead of bound parameters (`lib/db.js`, `lib/cache.js`); raw HTML in the frontend (`innerHTML`); `express-rate-limit` coverage per route; security headers; `lib/auth.js` session, cookie and redirect handling; secrets or upstream keys reaching logs, responses or the bundle.
- **perf** — [data.md](../../../docs/dev/data.md)'s cache tiers and TTLs vs. what the code does; outbound calls vs. [observability.md](../../../docs/dev/observability.md)'s budgets (N+1 fetches, missing dedup via `lib/dedup.js`); sqlite queries without an index; chunk sizes and what lands in the initial bundle; [frontend.md](../../../docs/dev/frontend.md)'s reactivity rules in hot paths (the game table, streaming loads).
- **reliability** — routes not mapping errors through `routeErrorStatus`; optional sources (HLTB, ProtonDB, reviews) failing the request instead of degrading with a `[tag]` warning; fetches without a timeout; unhandled rejections; races on stale responses (`public/staleGuard.ts`).
- **compliance** — anything raising request volume or changing request shape toward an upstream, against [integrations.md](../../../docs/dev/integrations.md#trust-tiers)'s trust tiers; inferred upstream rules in code that integrations.md or [bundles-and-prices.md](../../../docs/dev/bundles-and-prices.md) doesn't record.
- **docs** — each `docs/` file against the code it describes, one `Agent` per doc instead of per area: behavior, numbers (vs. `default.env`), module and route lists, keys, design described as built (a feature the doc names that the code lacks), [features.md](../../../docs/user/features.md) vs. what the UI does. `npm run check` already covers names, links and prose shape; this is what it can't see. The `file:line` is the doc's; a code bug found on the way goes under its own dimension.
- **tests** — `lib/` modules and `server.js` routes with no test in `test/`; branches the tests never reach (error and degrade paths first); journey steps no e2e test locks (`node scripts/journey-coverage.js`).

## 3. The finding bar

A finding has a `file:line`, a concrete scenario (input or state → wrong result, cost or exposure), a fix direction and an effort (S/M/L). Then verify each one adversarially — re-read the code around it, callers included, trying to prove it wrong — and drop what doesn't survive. A claim that something has one caller, is always passed or never reached holds only after grepping every route and entry point, not the obvious one (`panelOpen` has two).

Not findings: style (ESLint and Prettier own it), "might need later" generality, a rule's deliberate exceptions (an `eslint-disable` with a reason, a pitfalls.md entry), anything already in the backlog.

## Record and report

- Record each finding in [code-backlog.md](../../../docs/dev/code-backlog.md) under its dimension: numbered on from `node scripts/backlog-next.js C` (never reuse a closed item's number), `**C<n> · <severity> · <effort>** — problem at \`file:line\`. Direction.`Backtick only names that exist in the code (doc-refs flags the rest); a helper the Direction proposes goes unquoted. A finding whose cause commit is already known:`--escape` as [code-fix's step 0](../code-fix/SKILL.md#0-before-starting). Drop or narrow items the run shows fixed, and set the header's last-audited date (today) for each dimension covered.
- **Severity**: _critical_ (exploitable, or loses or corrupts data) · _major_ (a real bug, cost or risk users or the upstreams feel) · _minor_ · _cleanup_ (simpler code, no behaviour change).
- Report one table ranked by severity, then effort:

| C   | Severity | Effort | Dimension | Where | Finding | Direction |
| --- | -------- | ------ | --------- | ----- | ------- | --------- |

- Fix nothing. Then offer, in one `AskUserQuestion`, to fix the set you recommend (and why not the rest), planned as in [code-fix's BATCH.md](../code-fix/BATCH.md) step 1.
