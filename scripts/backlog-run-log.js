'use strict';

// Records a backlog-run skill run's review yield, and bugs later traced back to one ("escapes"), in
// dev-metrics; `setup-facts.js --cost` summarizes them (`summary` below).
//   node scripts/backlog-run-log.js '<run json>'        see the skill's step 5 for the fields
//   node scripts/backlog-run-log.js --escape <sha> <item>
//   node scripts/backlog-run-log.js --summary

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { record, history } = require('./dev-metrics');

const ROOT = path.join(__dirname, '..');
const PHASE_FIELDS = {
  triage: ['tokens'],
  plan: ['agents', 'rounds', 'tokens', 'blocking', 'other', 'applied'],
  code: ['agents', 'tokens', 'blocking', 'other', 'applied'],
};

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }).trim();
const isCount = (n) => Number.isInteger(n) && n >= 0;

function runProblems(run) {
  const problems = [];
  const item = /^([CU]\d+|feature:[a-z0-9-]+)$/;
  if (!Array.isArray(run.items) || !run.items.length || !run.items.every((i) => item.test(i)))
    problems.push('items: a non-empty list of C<n>/U<n>/feature:<slug>');
  if (Number.isNaN(Date.parse(run.started))) problems.push('started: an ISO time');
  if (typeof run.merge !== 'string' || !run.merge) problems.push('merge: the merge commit');
  for (const [phase, fields] of Object.entries(PHASE_FIELDS)) {
    const values = run.phases?.[phase];
    if (!values && phase === 'triage') continue;
    for (const field of fields) if (!isCount(values?.[field])) problems.push(`phases.${phase}.${field}: a count`);
  }
  return problems;
}

// The run whose merge brought `sha` in: reachable from the merge, not from its first parent.
function runFor(sha, runs, isAncestor) {
  return runs.find((run) => isAncestor(sha, run.merge) && !isAncestor(sha, `${run.merge}^1`));
}

const per100k = (n, tokens) => (tokens ? ((n * 100000) / tokens).toFixed(1) : '–');
const pct = (n, of) => (of ? `${Math.round((n * 100) / of)}%` : '–');

// `checks`: check.js rows, for the commits each run's hooks blocked.
function summary(runs, escapes, checks) {
  if (!runs.length) return 'Backlog runs (scripts/backlog-run-log.js): none yet';
  const sum = (phase, field) => runs.reduce((n, run) => n + (run.phases[phase]?.[field] ?? 0), 0);
  const phase = (name, blockingLabel) => {
    const tokens = sum(name, 'tokens');
    const found = sum(name, 'blocking') + sum(name, 'other');
    return `${name} ${Math.round(tokens / runs.length / 1000)}k tokens/run, ${per100k(sum(name, 'blocking'), tokens)} ${blockingLabel} and ${per100k(sum(name, 'other'), tokens)} other per 100k, ${pct(sum(name, 'applied'), found)} applied`;
  };
  const minutes = runs.map((run) => (Date.parse(run.mergedAt) - Date.parse(run.started)) / 60000).sort((a, b) => a - b);
  const blocked = runs.reduce(
    (n, run) =>
      n +
      checks.filter(
        (c) =>
          c.run === 'commit' &&
          c.failed.length &&
          Date.parse(c.at) >= Date.parse(run.started) &&
          Date.parse(c.at) <= Date.parse(run.mergedAt),
      ).length,
    0,
  );
  return `Backlog runs (scripts/backlog-run-log.js): ${runs.length}, median ${Math.round(minutes[Math.floor(minutes.length / 2)])} min, ${blocked} blocked commits · ${phase('plan', 'required')} · ${phase('code', 'bugs')} · ${escapes.length} escapes (${(escapes.length / runs.length).toFixed(1)} per run)`;
}

function main(args) {
  if (args[0] === '--summary')
    return console.log(summary(history('backlog-run'), history('backlog-escape'), history('checks')));
  if (args[0] === '--escape') {
    const [, sha, item] = args;
    if (!sha || !/^[CU]\d+$/.test(item ?? '')) throw new Error('usage: --escape <sha> <C<n>|U<n>>');
    const isAncestor = (a, b) => {
      try {
        git('merge-base', '--is-ancestor', a, b);
        return true;
      } catch {
        return false;
      }
    };
    const run = runFor(git('rev-parse', '--verify', `${sha}^{commit}`), history('backlog-run'), isAncestor);
    if (!run) throw new Error(`${sha} came in through no recorded backlog run`);
    record('backlog-escape', { item, sha, merge: run.merge });
    return console.log(`${item} recorded as an escape of the run that merged ${run.merge.slice(0, 7)}`);
  }
  const run = JSON.parse(args[0] ?? 'null') ?? {};
  const problems = runProblems(run);
  if (problems.length) throw new Error(`not recorded:\n  ${problems.join('\n  ')}`);
  const merge = git('rev-parse', '--verify', `${run.merge}^{commit}`);
  record('backlog-run', { ...run, merge, mergedAt: git('log', '-1', '--format=%cI', merge) });
  console.log(`Recorded the run that merged ${merge.slice(0, 7)}`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { runProblems, runFor, summary };
