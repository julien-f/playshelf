'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('record appends time-stamped rows that history reads back, oldest first; none yet reads as empty', () => {
  process.env.METRICS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-'));
  const { record, history } = require('../scripts/dev-metrics');
  assert.deepEqual(history('x'), []);
  record('x', { a: 1 });
  record('x', { a: 2 });
  const rows = history('x');
  assert.deepEqual(
    rows.map((r) => r.a),
    [1, 2],
  );
  assert.ok(!Number.isNaN(Date.parse(rows[0].at)));
  fs.rmSync(process.env.METRICS_DIR, { recursive: true });
  delete process.env.METRICS_DIR;
});

test("gitCommonDir: the main checkout's absolute .git, from the main checkout and a worktree", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-common-')));
  try {
    const main = path.join(tmp, 'repo');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const git = (...args) => execFileSync('git', args, { cwd: main, stdio: 'ignore', env });
    fs.mkdirSync(main);
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
    const wt = path.join(main, '.claude', 'worktrees', 'wt');
    git('worktree', 'add', '-q', wt);
    const { gitCommonDir } = require('../scripts/dev-metrics');
    assert.equal(gitCommonDir(main), path.join(main, '.git'));
    assert.equal(gitCommonDir(wt), path.join(main, '.git'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
