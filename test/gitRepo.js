'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// A git repo at `<dir>/repo` with one commit and a worktree at `.claude/worktrees/wt`, as the scripts expect.
function repoWithWorktree(dir) {
  const main = path.join(dir, 'repo');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => execFileSync('git', args, { cwd: main, stdio: 'ignore', env });
  fs.mkdirSync(main);
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
  const wt = path.join(main, '.claude', 'worktrees', 'wt');
  git('worktree', 'add', '-q', wt);
  return { main, wt };
}

module.exports = { repoWithWorktree };
