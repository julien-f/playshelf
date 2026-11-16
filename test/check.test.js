'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { coldSteps, runAll, runRow, staleDep, steps, touchesUi } = require('../scripts/check');

test('runAll: every step runs, in order, with its pass/fail and output', async () => {
  const node = process.execPath;
  const results = await runAll([
    ['pass', node, ['-e', 'console.log("fine")']],
    ['fail', node, ['-e', 'console.error("broke"); process.exit(2)']],
  ]);
  assert.deepStrictEqual(
    results.map(({ name, ok, output }) => ({ name, ok, output: output.trim() })),
    [
      { name: 'pass', ok: true, output: 'fine' },
      { name: 'fail', ok: false, output: 'broke' },
    ],
  );
});

test('steps: never e2e (pre-push runs it); a commit has the UI checks only when UI files are staged', () => {
  const names = (staged, files) => steps(staged, files).map(([name]) => name);
  const always = ['format', 'changelog', 'test', 'comments', 'doc-refs', 'doc-lint', 'journeys', 'setup'];
  const ui = ['typecheck', 'lint', 'css'];
  assert.deepStrictEqual(names().sort(), [...always, ...ui].sort());
  assert.deepStrictEqual(names('HEAD', ['lib/steam.js', 'docs/dev/data.md', '']).sort(), always.sort());
  assert.deepStrictEqual(names('HEAD', ['public/app.tsx']).sort(), [...always, ...ui].sort());
  assert.deepStrictEqual(names('HEAD', ['package-lock.json']).sort(), [...always, ...ui].sort());
  assert.deepStrictEqual(steps('HEAD~1')[1][1], ['check:changelog', '--', '--staged=HEAD~1']);
});

test('runRow: full run or commit, the load and cold steps given, seconds per step, the failed steps', () => {
  const results = [
    { name: 'test', ok: true, ms: 4321 },
    { name: 'lint', ok: false, ms: 1000 },
  ];
  const { checkout, ...row } = runRow('HEAD', results, { load: 3.14, cold: ['lint'] });
  assert.deepStrictEqual(row, {
    run: 'commit',
    load: 3.1,
    cold: ['lint'],
    seconds: { test: 4.3, lint: 1 },
    failed: ['lint'],
  });
  assert.strictEqual(checkout, path.resolve(__dirname, '..'));
  assert.strictEqual(runRow(undefined, [], { load: 0, cold: [] }).run, 'full');
});

test('coldSteps: the steps whose script names a cache location not there yet', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-'));
  try {
    fs.mkdirSync(path.join(root, 'warm'));
    const scripts = { a: 'x --cache-location warm/', b: 'y --cache-location cold/c.json', c: 'z' };
    assert.deepStrictEqual(
      coldSteps(
        [
          ['A', ['a']],
          ['B', ['b']],
          ['C', ['c']],
        ],
        scripts,
        root,
      ),
      ['B'],
    );
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test('touchesUi: frontend, e2e and their configs count; backend, docs and scripts do not', () => {
  assert.strictEqual(touchesUi(['docs/dev/data.md', 'lib/steam.js', 'scripts/e2e.js']), false);
  assert.strictEqual(touchesUi(['docs/dev/data.md', 'public/panel.tsx']), true);
  assert.strictEqual(touchesUi(['vite.config.js']), true);
});

test("staleDep: the first locked package node_modules lacks or holds at another version; a platform's optional one doesn't count", () => {
  const lock = {
    '': { name: 'playshelf' },
    'node_modules/a': { version: '1.0.0' },
    'node_modules/b': { version: '2.0.0' },
    'node_modules/@esbuild/win32-x64': { version: '0.1.0', optional: true },
  };
  const installed = { 'node_modules/a': { version: '1.0.0' }, 'node_modules/b': { version: '2.0.0' } };
  assert.strictEqual(staleDep(lock, installed), null);
  assert.strictEqual(staleDep(lock, { 'node_modules/a': { version: '1.0.0' } }), 'b (missing)');
  assert.strictEqual(
    staleDep(lock, { ...installed, 'node_modules/a': { version: '0.9.0' } }),
    'a (0.9.0, locked 1.0.0)',
  );
});
