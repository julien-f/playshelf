'use strict';

// A branch's own worktree, ready to work in: `git worktree add` under the main checkout's
// .claude/worktrees/, then `npm ci` there. Prints its path and its e2e and mock ports; logs each run
// (dev-metrics `worktree`). Runs from any checkout.
//   node scripts/worktree.js <branch> [base]   (base: main)

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { record } = require('./dev-metrics');
const { gitCommonDir } = require('./git');
const { portOf } = require('./ports');

function main() {
  const [branch, base = 'main'] = process.argv.slice(2);
  if (!branch) {
    console.error('Usage: node scripts/worktree.js <branch> [base]');
    process.exit(1);
  }
  const dir = path.join(path.dirname(gitCommonDir(process.cwd())), '.claude/worktrees', branch.replaceAll('/', '-'));
  const start = Date.now();
  let ok = false;
  try {
    execFileSync('git', ['worktree', 'add', '-b', branch, dir, base], { stdio: 'inherit' });
    execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' });
    ok = true;
  } finally {
    record('worktree', { branch, ok, ms: Date.now() - start });
  }
  console.log(`${dir}\ne2e port ${portOf('e2e', dir)} · mock port ${portOf('mock', dir)}`);
}

main();
