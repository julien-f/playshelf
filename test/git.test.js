'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gitCommonDir } = require('../scripts/git');
const { repoWithWorktree } = require('./gitRepo');

test("gitCommonDir: the main checkout's absolute .git, from the main checkout and a worktree", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-common-')));
  try {
    const { main, wt } = repoWithWorktree(tmp);
    assert.equal(gitCommonDir(main), path.join(main, '.git'));
    assert.equal(gitCommonDir(wt), path.join(main, '.git'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
