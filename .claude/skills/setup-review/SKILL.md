---
name: setup-review
description: Review the Claude Code setup — skills, scripts, hooks, settings, CLAUDE.md and Claude memory — for drift, contradictions, duplication, prose steps better scripted, wasted time or tokens and skills better merged, split or renamed, and ways to extend what exists, mining the session transcripts since its last run for repeated friction, and report ranked proposals. Use when asked — as a request or a question ("shall we review the skills?") — to review, audit or improve the skills, scripts, hooks, settings, CLAUDE.md (this repo's or ~/.claude's) or agent setup, or how they could be more useful.
---

# Setup review

Judges the setup against CLAUDE.md's Where things belong and Working style rules, and keeps its proposals in [setup-backlog.md](../../../docs/dev/setup-backlog.md) so each run checks the last one's. No edits until the user picks from the report. App code goes to [code-audit](../code-audit/SKILL.md), dependencies to [dependency-audit](../dependency-audit/SKILL.md).

## Scope

- **Files**: `.claude/skills/*/SKILL.md` and `evals.json`, `scripts/`, `.githooks/`, `.github/workflows/`, `.claude/settings.json` and `settings.local.json`, `package.json`'s `scripts`, `CLAUDE.md`, how `docs/` is split and indexed (not what each doc says: that's code-audit's **docs**), and this repo's Claude memory (`~/.claude/projects/<this repo's slug>/memory/`).
- **Argument `evals`** adds the evals to step 1 (a few minutes, a few dollars).
- **Transcripts**: step 3 runs by default, over the sessions since the ledger's last read. Argument `no-transcripts` skips it (say so); `transcripts=N` instead reads the last N sessions, ledger aside.

## 0. The ledger

Read [setup-backlog.md](../../../docs/dev/setup-backlog.md). Re-run each **Watching** item's measure: report it as met (remove it) or missed (move it to Open with what the numbers show). Open and Declined items are not new findings; a Declined one comes back only with evidence its reason didn't foresee.

## 1. Facts first

- `npm run check:doc-refs`: stale script names, flags, npm scripts and links in skills and CLAUDE.md. A failure is a finding as-is.
- `npm run check:setup`: skill frontmatter, and allows covering an ask-first action. A failure or a `settings.local.json` warning is a finding as-is.
- `node scripts/setup-facts.js`: each script's callers, and which read arguments without a usage line (a script taking only optional flags may not need one).
- `node scripts/setup-facts.js --cost` (~2–3 min): the peak load average, time and output size of `check`, `test`, `test:e2e` and `build`, each one's change since the last run (⚠ past 25% slower: a **Cost** finding, and any doc quoting that time is stale), the check runs since (blocked commits and by which step), [backlog-run](../backlog-run/SKILL.md)'s review yield per phase (a phase whose findings per 100k tokens stay low over 3+ runs is a **Cost** finding: one generalist, or skip it below a diff size) and escapes per run, CLAUDE.md's size and the largest docs — the numbers the **Cost** and **Docs** checks judge.
- With `evals`: `node scripts/skill-evals.js --repeat=3 --dry-run` ([testing.md](../../../docs/dev/testing.md#skill-evals)). A routing miss is a **Triggers** finding; a dry run's denied calls are **Permissions** ones, its failed calls **Staleness** or **Prose → script** ones.
- Read every skill, CLAUDE.md, both settings files and the memory files in full.

## 2. Review

- **Contradictions**: a skill that disagrees with CLAUDE.md (CLAUDE.md wins), or two skills that disagree with each other.
- **Prose → script**: deterministic steps a skill makes the agent do by hand (fixed command sequences, parsing, counting) that a script would make repeatable.
- **Duplication**: the same procedure in several skills, or a CLAUDE.md rule repeated in a skill. Propose one owner and a link from the others.
- **Triggers**: skill descriptions whose "Use when" overlaps another skill's, built-in ones included (`/code-review`, `/simplify`, `/security-review`), or misses how the user actually asks. A phrasing the transcripts show misrouted, and a skill with no `evals.json`, are findings: propose the routing case with the fix.
- **Structure**: skills always run back to back or sharing most steps (merge), a skill with independent modes each loading the other's text (split), a name or description that doesn't match how the user asks (rename), a skill nothing has run lately (delete; `--transcripts` counts runs). Changing them needs the user's approval like adding one.
- **Scripts**: ones with no caller, overlapping jobs, missing usage messages on bad arguments.
- **Memory**: project rules kept in memory (they bind only one machine: move them to CLAUDE.md or a skill), memory repeating CLAUDE.md or a skill, stale entries.
- **Hooks**: "always do X after Y" rules in CLAUDE.md or a skill that only a hook can guarantee.
- **Permissions**: allows that pre-approve CLAUDE.md's ask-first actions beyond those `check:setup` knows (an ask-first rule it lacks is a finding too), and dead one-off entries, in both settings files. For missing allows, propose running the built-in `fewer-permission-prompts` skill (it writes settings) rather than reviewing transcripts by hand.
- **Cost**: time and tokens every session pays — CLAUDE.md lines that could load on demand (a skill, a linked doc); commands or skill steps whose output floods the context (prefer a quiet mode or a script printing only what matters); slow steps and work run twice or when nothing it covers changed; skill patterns that fan out agents, snapshot click by click or read whole files where an excerpt does.
- **Docs**: the transcripts' doc reads against the docs' sizes — a big doc read whole in many sessions for one part (split it, or move that part where it's needed), docs always read together (merge), a doc nobody reads (delete or fold into another), a fact agents explored the code for that no doc holds (add it where they looked first).
- **Staleness**: rules about code, files or procedures that no longer exist; rules nothing has needed lately (prefer deleting them).
- **Extensions**: ways to make what exists more useful — a mode or argument a skill lacks, script output a skill re-derives by hand, one skill's result that could feed another, a check that could run earlier (CI → pre-push → pre-commit), a script that could answer a question agents explore for. Speculative ideas are welcome; mark those without usage evidence as such.

## 3. Transcripts

- `node scripts/setup-facts.js --transcripts=<DATE> --digest=<scratchpad>/digest`, DATE being the ledger's "Transcripts read up to" (`--transcripts` alone, the last 20 sessions, when it says never), counts what needs no judgment over the sessions since: largest outputs and slowest calls by command, command pairs repeated across sessions, calls the permission classifier denied or you rejected, each skill's runs, longest run, tokens and interrupts, interrupts, which docs were read and how often whole (subagents included), and how the user answered each skill's questions — a skill whose recommendation is often overridden, answered in free text or sent back to clarify recommends badly or asks what a default would settle.
- Then read the digests (one compact file per session; never the raw `.jsonl`) for what does need judgment, seen in at least two sessions — yourself under about 50 KB in all, else one `Agent` subagent:
  - the user correcting the agent the same way (a rule missing, unclear or ignored), interrupts and rejections included;
  - the same command failing the same way (a pitfalls.md entry or a fix);
  - the script's repeated pairs that are a real procedure (a script or skill candidate);
  - setup proposals the user turned down or answered in their own words (a Declined ledger entry, or a better proposal);
  - per skill run: steps skipped or improvised (the skill is wrong or missing one), the user correcting the agent during or right after it, a question asked every run that a default would settle, a report the user reshapes.

Each pattern comes with the sessions and a short quote. It quotes no secrets, and nothing from the transcripts leaves the report.

## 4. The finding bar

A finding names a `file:line` (or the sessions), the friction it causes, the change, its target (CLAUDE.md, a skill, a script, a hook, settings) and an effort (S/M/L). Unless it is an **Extensions** idea, it also names its measure: the command whose output shows the friction (a `setup-facts` line, a check, a transcript count), with today's value as the baseline and a target. Verify each one adversarially (re-read the files involved, trying to prove it wrong) and drop what doesn't survive; an **Extensions** idea is checked only for not already existing. Prefer tightening or deleting a rule over adding one. A kind of finding the ledger shows in two runs, and that a rule can catch, is proposed as a rule in `scripts/setup-lint.js` (or another `check` step) rather than found by reading again.

Not findings: wording taste, Prettier's output, deliberate exceptions recorded with a reason (`HISTORY` in `scripts/doc-refs.js`).

## Report

One table, ranked by how often the friction bites, then effort:

| P   | Target | Where | Friction | Proposed change | Measure: baseline → target | Effort | Recommend |
| --- | ------ | ----- | -------- | --------------- | -------------------------- | ------ | --------- |

Number findings on from `node scripts/backlog-next.js P`; the report also lists the Watching items' results from step 0.

Then one `AskUserQuestion`: apply the recommended set, plus any real choice among the rest. Adding a skill, hook or agent still needs that explicit approval (CLAUDE.md, Ask first).

## Applying

- Update [setup-backlog.md](../../../docs/dev/setup-backlog.md) in the first commit: applied items under Watching (`**P<n> · <target> · <effort>** — change. Measure: \`command\` — baseline → target.`), the rest of the recommended set under Open, the ones the user turned down under Declined with their reason; set the header's dates (today, and the newest entry `--transcripts` printed).
- Follow CLAUDE.md's Development workflow; a `scripts/` change gets a Development changelog entry and a test.
- A skill's description or steps change: run `node scripts/skill-evals.js --repeat=3 <skill>` before (`--ref=HEAD`) and after; report both, and keep the change only if routing doesn't regress.
- Memory edits are outside the repo: say which entries were moved or deleted.
