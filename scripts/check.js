'use strict';

// `npm run check`: every check in parallel, one line each, full output only for the ones that fail —
// so nobody has to filter the output to find what broke. With --staged=<base> (the pre-commit hook),
// checks the commit against <base> instead: typecheck, lint and the CSS check run only when something
// they cover is staged; e2e is the pre-push hook's. Each run's step times and failures go to scripts/dev-metrics.js.

const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { record } = require('./dev-metrics');

const UI =
  /^(public|e2e)\/|^(playwright\.config\.ts|vite\.config\.js|tsconfig[^/]*\.json|eslint\.config\.[^/]*|package(-lock)?\.json)$/;

// Whether `files` include anything typecheck, lint, the CSS check or the e2e suite covers.
const touchesUi = (files) => files.some((f) => UI.test(f));

// `[name, npm script args]` for a full run (`staged` undefined) or a commit against `staged`.
function steps(staged, files = []) {
  const ui = staged === undefined || touchesUi(files);
  return [
    ['format', ['format:check']],
    ['changelog', staged === undefined ? ['check:changelog'] : ['check:changelog', '--', `--staged=${staged}`]],
    ['test', ['test']],
    ...(ui
      ? [
          ['typecheck', ['typecheck']],
          ['lint', ['lint']],
          ['css', ['check:css']],
        ]
      : []),
    ['comments', staged === undefined ? ['check:comments'] : ['check:comments', '--', `--staged=${staged}`]],
    ['doc-refs', ['check:doc-refs']],
    ['doc-lint', ['check:doc-lint']],
    ['journeys', ['check:journeys']],
    ['setup', ['check:setup']],
  ];
}

// Runs each `[name, command, args]` in parallel; resolves to `{ name, ok, ms, output }` in order.
function runAll(steps) {
  return Promise.all(
    steps.map(
      ([name, command, args]) =>
        new Promise((resolve) => {
          const start = Date.now();
          const child = spawn(command, args);
          let output = '';
          child.stdout.on('data', (d) => (output += d));
          child.stderr.on('data', (d) => (output += d));
          child.on('error', (err) => (output += err.message));
          child.on('close', (code) => resolve({ name, ok: code === 0, ms: Date.now() - start, output }));
        }),
    ),
  );
}

// The first package `lock` (package-lock.json's `packages`) pins that `installed` (npm's node_modules/.package-lock.json)
// lacks or holds at another version, or null: a checkout behind its lockfile fails builds with misleading errors.
function staleDep(lock, installed) {
  for (const [path, { version, optional }] of Object.entries(lock)) {
    if (!path || optional) continue;
    const name = path.replace(/^.*node_modules\//, '');
    const got = installed[path]?.version;
    if (got !== version) return got ? `${name} (${got}, locked ${version})` : `${name} (missing)`;
  }
  return null;
}

// A run's metrics row: a commit's (the pre-commit hook) or a full one's, each step's seconds and the failed ones.
// The load (sampled before the steps add theirs) and checkout let a p90 leave out runs under other sessions' load
// or in a fresh worktree's cold caches.
function runRow(staged, results, load) {
  return {
    run: staged === undefined ? 'full' : 'commit',
    load: Number(load.toFixed(1)),
    checkout: path.resolve(__dirname, '..'),
    seconds: Object.fromEntries(results.map((r) => [r.name, Number((r.ms / 1000).toFixed(1))])),
    failed: results.filter((r) => !r.ok).map((r) => r.name),
  };
}

async function main() {
  const load = os.loadavg()[0];
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const staged = process.argv
    .slice(2)
    .find((a) => a.startsWith('--staged='))
    ?.split('=')[1];
  const files =
    staged === undefined
      ? []
      : execFileSync('git', ['diff', '--cached', '--name-only', staged], { encoding: 'utf8' }).split('\n');
  let installed = {};
  try {
    installed = require('../node_modules/.package-lock.json').packages;
  } catch {
    // No node_modules: everything is missing.
  }
  const stale = staleDep(require('../package-lock.json').packages, installed);
  if (stale) {
    record('checks', { ...runRow(staged, [], load), failed: ['deps'] });
    console.log(`✗ node_modules is behind package-lock.json: ${stale}. Run npm ci.`);
    process.exit(1);
  }
  const results = await runAll(steps(staged, files).map(([name, args]) => [name, npm, ['run', '-s', ...args]]));
  record('checks', runRow(staged, results, load));
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name} (${(r.ms / 1000).toFixed(1)} s)`);
  for (const r of results.filter((r) => !r.ok)) console.log(`\n── ${r.name} failed ──\n${r.output.trimEnd()}`);
  if (results.some((r) => !r.ok)) process.exit(1);
}

if (require.main === module) main();

module.exports = { runAll, runRow, staleDep, steps, touchesUi };
