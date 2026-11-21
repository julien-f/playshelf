'use strict';

// Facts for setup-review (declared in docs/dev/setup-backlog.md); its transcript digest is the user-level skill's own.
//   node scripts/setup-facts.js                    each script's callers (tests and the changelog excluded —
//                                                  a script only they mention has no caller), and which read
//                                                  arguments without printing a usage line
//   node scripts/setup-facts.js --cost             the peak load average, time and output size of the gates an agent runs, each
//                                                  gate's change since the last run, and the check runs (hooks
//                                                  included) since then: blocked commits, timings (scripts/dev-metrics.js)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { record, history } = require('./dev-metrics');
const backlogRuns = require('./backlog-run-log');
const { describeRun } = require('./e2e-flakes');

const ROOT = path.join(__dirname, '..');
const COST_SCRIPTS = ['check', 'test', 'test:e2e', 'build'];

// `files`: [relPath, text] pairs; a script is called as `scripts/<name>(.js)` or `./<name>(.js)`.
function callers(name, files) {
  const ref = new RegExp(`(?:scripts/|\\./)${name}(?:\\.js)?(?![\\w-])`);
  return files
    .filter(([file, text]) => file !== `scripts/${name}.js` && !file.startsWith('test/') && ref.test(text))
    .map(([file]) => file);
}

function argsWithoutUsage(source) {
  return source.includes('process.argv') && !source.includes('Usage');
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

function cost() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  console.log(`CLAUDE.md (loaded every turn): ${kb(fs.statSync(path.join(ROOT, 'CLAUDE.md')).size)}`);
  const docs = fs
    .readdirSync(path.join(ROOT, 'docs'), { recursive: true })
    .filter((f) => f.endsWith('.md'))
    .map((f) => [`docs/${f.split(path.sep).join('/')}`, fs.statSync(path.join(ROOT, 'docs', f)).size])
    .sort((a, b) => b[1] - a[1]);
  console.log(
    `Largest docs: ${docs
      .slice(0, 5)
      .map(([f, size]) => `${f} ${kb(size)}`)
      .join(', ')}`,
  );
  const last = history('cost').at(-1);
  // The 1-minute load after each script, so another session's run during the timings shows.
  const loads = [os.loadavg()[0]];
  const seconds = {};
  for (const script of COST_SCRIPTS) {
    const start = Date.now();
    const { status, stdout, stderr } = spawnSync(npm, ['run', '-s', script], { cwd: ROOT, encoding: 'utf8' });
    loads.push(os.loadavg()[0]);
    const run = { seconds: Number(((Date.now() - start) / 1000).toFixed(1)), out: stdout + stderr, status };
    console.log(costLine(script, run, last));
    if (!status) seconds[script] = run.seconds;
  }
  const load = Number(Math.max(...loads).toFixed(1));
  console.log(loadLine(load, last));
  record('cost', { seconds, load });
  const since = last?.at ?? '';
  console.log(
    `Check runs${since ? ` since ${since.slice(0, 10)}` : ''} (scripts/check.js): ${checkStats(history('checks').filter((r) => r.at > since))}`,
  );
  console.log(backlogRuns.summary(history('backlog-run'), history('backlog-escape'), history('checks')));
  console.log(
    `Hook e2e runs since ${since.slice(0, 10) || 'ever'} (scripts/e2e.js): ${e2eRunStats(history('e2e-runs').filter((r) => r.at > since))}`,
  );
  const flakes = history('flakes').at(-1);
  if (flakes) console.log(`Last e2e flake measure (scripts/e2e-flakes.js): ${describeRun(flakes)}`);
}

// Check runs → `12 commits (2 blocked: lint ×2), median 3.1 s, slowest step e2e 18.0 s · 3 full runs (0 failed)`.
function checkStats(rows) {
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  const total = (r) => Math.max(0, ...Object.values(r.seconds)); // steps run in parallel
  const part = (run, label) => {
    const mine = rows.filter((r) => r.run === run);
    const failed = mine.filter((r) => r.failed.length);
    const counts = new Map();
    for (const name of failed.flatMap((r) => r.failed)) counts.set(name, (counts.get(name) ?? 0) + 1);
    const why = [...counts].map(([name, n]) => `${name} ×${n}`).join(', ');
    const slowest = mine.flatMap((r) => Object.entries(r.seconds)).sort((a, b) => b[1] - a[1])[0];
    return `${mine.length} ${label} (${failed.length} ${run === 'commit' ? 'blocked' : 'failed'}${why ? `: ${why}` : ''})${mine.length ? `, median ${median(mine.map(total))} s, slowest step ${slowest[0]} ${slowest[1]} s` : ''}`;
  };
  return `${part('commit', 'commits')} · ${part('full', 'full runs')}`;
}

// Hook e2e runs, by projects asked → which ran: `desktop+phone ×3: phone 2, skipped 1 · desktop ×5: desktop 5`.
function e2eRunStats(rows) {
  const groups = Map.groupBy(rows, (r) => r.asked.join('+'));
  if (!groups.size) return 'none';
  return [...groups]
    .map(([asked, runs]) => {
      const counts = Map.groupBy(runs, (r) => r.ran.join('+') || 'skipped');
      return `${asked} ×${runs.length}: ${[...counts].map(([ran, rs]) => `${ran} ${rs.length}`).join(', ')}`;
    })
    .join(' · ');
}

// Timings swing with other sessions' load, so a ⚠ below is read against both runs' load.
function loadLine(load, last) {
  const before = last?.load === undefined ? 'not recorded' : `${last.load} on ${last.at.slice(0, 10)}`;
  return `Peak load average: ${load} on ${os.cpus().length} cores (last run: ${before})`;
}

// A failed run (e.g. e2e's port taken by another checkout) is no baseline: it isn't recorded or compared.
function costLine(script, { seconds, out, status }, last) {
  const size = `${seconds} s, ${kb(out.length)}, ${out.split('\n').length} lines`;
  if (status) return `npm run ${script}: ${size}, exit ${status}, not recorded`;
  return `npm run ${script}: ${size}${costDelta(last?.seconds[script], seconds, last?.at)}`;
}

// ` (+30% since 2026-10-12) ⚠` against the last --cost run; ⚠ past SLOWER.
const SLOWER = 0.25;
function costDelta(before, now, at) {
  if (!before) return '';
  const change = (now - before) / before;
  return ` (${change >= 0 ? '+' : ''}${Math.round(change * 100)}% since ${at.slice(0, 10)})${change > SLOWER ? ' ⚠' : ''}`;
}

function scripts() {
  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && !f.startsWith('docs/images/') && !['package-lock.json', 'CHANGELOG.md'].includes(f))
    .map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]);
  for (const [file, source] of files.filter(([f]) => /^scripts\/[^/]+\.js$/.test(f))) {
    const name = path.basename(file, '.js');
    const by = callers(name, files);
    const notes = [by.length ? `called by ${by.join(', ')}` : 'NO CALLER'];
    if (argsWithoutUsage(source)) notes.push('reads arguments, no usage line');
    console.log(`${name}: ${notes.join('; ')}`);
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && args[0] !== '--cost')) {
    console.error('Usage: node scripts/setup-facts.js [--cost]');
    process.exit(1);
  }
  if (args[0] === '--cost') cost();
  else scripts();
}

module.exports = { callers, argsWithoutUsage, costDelta, costLine, loadLine, checkStats, e2eRunStats };
