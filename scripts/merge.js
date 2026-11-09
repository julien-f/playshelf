'use strict';

// A feature branch's `--no-ff` merge into main, made in the branch's own worktree so a merge left
// pending never sits in the shared main checkout (pitfalls.md). Logs each step (dev-metrics `merge`).
//   node scripts/merge.js start <branch>    in its worktree: a <branch>-merge branch off main, merging <branch> uncommitted
//   (add the CHANGELOG entry, resolve any conflict, `git commit` there)
//   node scripts/merge.js finish <branch>   main fast-forwards to it, then the worktree and both branches go

const { execFileSync } = require('node:child_process');
const { record } = require('./dev-metrics');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const succeeds = (cwd, ...args) => {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

// `git worktree list --porcelain` → [{ path, branch }], the main checkout first.
function worktrees(cwd) {
  return git(cwd, 'worktree', 'list', '--porcelain')
    .split('\n\n')
    .map((block) => ({
      path: /^worktree (.*)$/m.exec(block)[1],
      branch: /^branch refs\/heads\/(.*)$/m.exec(block)?.[1],
    }));
}

function fail(message) {
  throw Object.assign(new Error(message), { expected: true });
}

function start(branch, cwd) {
  const wt = worktrees(cwd).find((w) => w.branch === branch);
  if (!wt) fail(`no worktree has ${branch} checked out`);
  if (git(wt.path, 'status', '--porcelain', '--untracked-files=no')) fail(`${wt.path} has uncommitted changes`);
  git(wt.path, 'switch', '--no-track', '-c', `${branch}-merge`, 'main');
  if (!succeeds(wt.path, 'merge', '--no-ff', '--no-commit', branch)) {
    if (!succeeds(wt.path, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')) {
      git(wt.path, 'switch', branch);
      git(wt.path, 'branch', '-d', `${branch}-merge`);
      fail(`git merge didn't start in ${wt.path}; run it there to see why`);
    }
    console.log(`conflicts in ${wt.path}: resolve them, add the CHANGELOG entry, commit there, then \`finish\``);
    return;
  }
  if (!succeeds(wt.path, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')) fail(`${branch} is already in main`);
  console.log(
    `merging in ${wt.path}: add the CHANGELOG entry, commit there, then \`node scripts/merge.js finish ${branch}\``,
  );
}

function finish(branch, cwd) {
  const [main, ...others] = worktrees(cwd);
  const wt = others.find((w) => w.branch === `${branch}-merge`);
  if (!wt) fail(`no worktree has ${branch}-merge checked out: run \`start\` first`);
  if (succeeds(wt.path, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'))
    fail(`the merge is still pending in ${wt.path}: commit it`);
  if (
    !succeeds(wt.path, 'merge-base', '--is-ancestor', branch, 'HEAD') ||
    !succeeds(wt.path, 'rev-parse', '-q', '--verify', 'HEAD^2')
  )
    fail(`${branch}-merge's last commit isn't the merge of ${branch}`);
  if (git(wt.path, 'status', '--porcelain')) fail(`${wt.path} has changes left: commit or remove them`);
  if (main.branch !== 'main') fail(`the main checkout is on ${main.branch}, not main`);
  git(main.path, 'merge', '--ff-only', `${branch}-merge`);
  git(main.path, 'worktree', 'remove', wt.path);
  git(main.path, 'branch', '-d', `${branch}-merge`, branch);
  console.log(`main is at ${git(main.path, 'log', '-1', '--format=%h %s')}; worktree and branches removed`);
}

function main() {
  const [step, branch] = process.argv.slice(2);
  if (!['start', 'finish'].includes(step) || !branch) {
    console.error('Usage: node scripts/merge.js start|finish <branch>');
    process.exit(1);
  }
  let ok = false;
  try {
    (step === 'start' ? start : finish)(branch, process.cwd());
    ok = true;
  } catch (err) {
    console.error(`merge: ${err.expected ? err.message : err.stderr?.toString().trim() || err.message}`);
    process.exitCode = 1;
  } finally {
    record('merge', { step, branch, ok });
  }
}

main();
