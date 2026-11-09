'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '../scripts/merge.js');

// A repo on main with a `feat` worktree one commit ahead.
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, 'main');
  const wt = path.join(root, 'feat');
  const env = { ...process.env, METRICS_DIR: root, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t' };
  Object.assign(env, { GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  const run = (cwd, ...args) => spawnSync('node', [SCRIPT, ...args], { cwd, env, encoding: 'utf8' });
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(main, 'a'), 'a\n');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'base');
  git(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
  fs.writeFileSync(path.join(wt, 'b'), 'b\n');
  git(wt, 'add', '.');
  git(wt, 'commit', '-qm', 'feature');
  return { main, wt, git, run };
}

test('merge: start merges in the worktree, finish fast-forwards main and cleans up', (t) => {
  const { main, wt, git, run } = setup(t);

  assert.equal(run(main, 'start', 'feat').status, 0);
  assert.equal(git(wt, 'branch', '--show-current'), 'feat-merge');
  assert.equal(git(main, 'status', '--porcelain'), '', 'nothing pending in the main checkout');
  fs.writeFileSync(path.join(wt, 'CHANGELOG.md'), 'entry\n');
  git(wt, 'add', '.');
  git(wt, 'commit', '-qm', 'Merge feat');
  const finished = run(main, 'finish', 'feat');

  assert.equal(finished.status, 0, finished.stderr);
  assert.equal(git(main, 'log', '-1', '--format=%s %p').split(' ').length, 4, 'a merge commit with two parents');
  assert.ok(fs.existsSync(path.join(main, 'CHANGELOG.md')));
  assert.ok(!fs.existsSync(wt));
  assert.equal(git(main, 'branch', '--list', 'feat*'), '');
});

test('merge: finish refuses a merge still pending', (t) => {
  const { main, git, run } = setup(t);
  run(main, 'start', 'feat');

  const finished = run(main, 'finish', 'feat');

  assert.equal(finished.status, 1);
  assert.match(finished.stderr, /still pending/);
  assert.equal(git(main, 'log', '-1', '--format=%s'), 'base');
});

test('merge: usage on bad arguments', () => {
  const r = spawnSync('node', [SCRIPT, 'merge'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Usage:/);
});
