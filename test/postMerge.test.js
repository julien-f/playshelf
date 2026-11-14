'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '../scripts/post-merge.js');

// A repo on main and a `feat` branch whose commit writes `files`; a fake `npm` on PATH records its args.
function setup(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'post-merge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\necho "$@" >> "${root}/npm-calls"\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, METRICS_DIR: root };
  Object.assign(env, {
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  });
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'package-lock.json'), '{}\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feat');
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), content);
  git('add', '.');
  git('commit', '-qm', 'feature');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--no-ff', '-m', 'merge', 'feat');
  const run = () => spawnSync('node', [SCRIPT], { cwd: repo, env, encoding: 'utf8' });
  const npmCalls = () =>
    fs.existsSync(path.join(root, 'npm-calls')) ? fs.readFileSync(path.join(root, 'npm-calls'), 'utf8') : '';
  const logged = () => fs.readFileSync(path.join(root, 'post-merge.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return { run, npmCalls, logged };
}

test('post-merge: a merge that changed package-lock.json runs npm ci and logs it', (t) => {
  const { run, npmCalls, logged } = setup(t, { 'package-lock.json': '{"changed":true}\n' });
  assert.equal(run().status, 0);
  assert.match(npmCalls(), /^ci\b/);
  assert.deepEqual(
    logged().map(({ lockChanged, ok }) => ({ lockChanged, ok })),
    [{ lockChanged: true, ok: true }],
  );
});

test('post-merge: a merge that left package-lock.json alone runs nothing', (t) => {
  const { run, npmCalls, logged } = setup(t, { other: 'x\n' });
  assert.equal(run().status, 0);
  assert.equal(npmCalls(), '');
  assert.deepEqual(
    logged().map(({ lockChanged, ok }) => ({ lockChanged, ok })),
    [{ lockChanged: false, ok: true }],
  );
});
