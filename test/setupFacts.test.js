'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const {
  callers,
  argsWithoutUsage,
  costDelta,
  costLine,
  loadLine,
  checkStats,
  e2eRunStats,
} = require('../scripts/setup-facts');

test('callers matches script paths and relative requires, not substrings', () => {
  const files = [
    ['package.json', '"check": "node scripts/check.js"'],
    ['scripts/other.js', "require('./journey-coverage')"],
    ['docs/a.md', 'run `scripts/changelog-check.js` and the check step'],
    ['scripts/check.js', 'scripts/check.js itself'],
    ['test/check.test.js', "require('../scripts/check')"],
  ];
  assert.deepEqual(callers('check', files), ['package.json']);
  assert.deepEqual(callers('journey-coverage', files), ['scripts/other.js']);
  assert.deepEqual(callers('changelog-check', files), ['docs/a.md']);
});

test('argsWithoutUsage flags argument parsing with no usage line', () => {
  assert.equal(argsWithoutUsage('const [a] = process.argv.slice(2);'), true);
  assert.equal(argsWithoutUsage("process.argv; console.error('Usage: x');"), false);
  assert.equal(argsWithoutUsage('console.log(1);'), false);
});

test('costDelta: the change since the last run, flagged past 25% slower; nothing without a last run', () => {
  assert.equal(costDelta(undefined, 10, undefined), '');
  assert.equal(costDelta(20, 22, '2026-10-12T08:00:00Z'), ' (+10% since 2026-10-12)');
  assert.equal(costDelta(20, 40, '2026-10-12T08:00:00Z'), ' (+100% since 2026-10-12) ⚠');
  assert.equal(costDelta(20, 15, '2026-10-12T08:00:00Z'), ' (-25% since 2026-10-12)');
});

test('costLine: size and change since the last run; a failed run is marked not recorded, with no change', () => {
  const last = { at: '2026-10-12T08:00:00Z', seconds: { 'test:e2e': 50 } };
  assert.equal(
    costLine('test:e2e', { seconds: 60, out: 'a\nb', status: 0 }, last),
    'npm run test:e2e: 60 s, 0.0 KB, 2 lines (+20% since 2026-10-12)',
  );
  assert.equal(
    costLine('test:e2e', { seconds: 9.9, out: 'x', status: 1 }, last),
    'npm run test:e2e: 9.9 s, 0.0 KB, 1 lines, exit 1, not recorded',
  );
});

test("loadLine: the run's peak load and the last run's, so a ⚠ is read against other sessions' load", () => {
  const cores = os.cpus().length;
  assert.equal(loadLine(32.5, undefined), `Peak load average: 32.5 on ${cores} cores (last run: not recorded)`);
  assert.equal(
    loadLine(32.5, { at: '2026-11-14T19:37:16Z', seconds: {} }),
    `Peak load average: 32.5 on ${cores} cores (last run: not recorded)`,
  );
  assert.equal(
    loadLine(4, { at: '2026-11-14T19:37:16Z', seconds: {}, load: 30.2 }),
    `Peak load average: 4 on ${cores} cores (last run: 30.2 on 2026-11-14)`,
  );
});

test('checkStats: commits blocked and by which step, median run, slowest step; full runs apart', () => {
  const rows = [
    { run: 'commit', seconds: { test: 3, e2e: 18 }, failed: [] },
    { run: 'commit', seconds: { test: 3, lint: 2 }, failed: ['lint'] },
    { run: 'commit', seconds: { test: 4 }, failed: [] },
    { run: 'full', seconds: { test: 6 }, failed: [] },
  ];
  assert.equal(
    checkStats(rows),
    '3 commits (1 blocked: lint ×1), median 4 s, slowest step e2e 18 s · 1 full runs (0 failed), median 6 s, slowest step test 6 s',
  );
  assert.equal(checkStats([]), '0 commits (0 blocked) · 0 full runs (0 failed)');
});

test('e2eRunStats: hook e2e runs grouped by the projects asked, then by those run', () => {
  const row = (asked, ran) => ({ asked, ran, ok: true });
  const rows = [
    row(['desktop', 'phone'], ['phone']),
    row(['desktop', 'phone'], []),
    row(['desktop', 'phone'], ['phone']),
    row(['desktop'], ['desktop']),
  ];
  assert.equal(e2eRunStats(rows), 'desktop+phone ×3: phone 2, skipped 1 · desktop ×1: desktop 1');
  assert.equal(e2eRunStats([]), 'none');
});
