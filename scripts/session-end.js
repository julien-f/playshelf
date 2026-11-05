'use strict';

// What's left before closing a session, across every worktree of this repo: unpushed or unpulled
// main (as of the last fetch), a main checkout off main, uncommitted changes, merged worktrees and
// branches, background servers still running, workarounds whose upstream bug closed or isn't filed,
// and what production's metrics say needs a look (prod-check.js).
// Prints nothing-left when clean; logs each run (dev-metrics `session-end`). Runs from any checkout.
//   node scripts/session-end.js

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { record } = require('./dev-metrics');
const upstreamBugs = require('./upstream-bugs');
const prodCheck = require('./prod-check');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// `{ ahead, behind, worktrees: [{ path, branch, main, dirty, merged, servers }], mergedBranches }` → one line per thing left.
function leftovers({ ahead, behind, worktrees, mergedBranches }) {
  const out = [];
  if (ahead) out.push(`main: ${ahead} commit(s) not pushed`);
  if (behind) out.push(`main: ${behind} commit(s) behind origin/main`);
  for (const w of worktrees) {
    const where = w.main ? 'main checkout' : `worktree ${w.path}`;
    if (w.main && w.branch !== 'main') out.push(`${where}: on ${w.branch ?? 'a detached HEAD'}, not main`);
    if (w.dirty.length)
      out.push(`${where}: ${w.dirty.length} uncommitted change(s): ${w.dirty.slice(0, 5).join(', ')}`);
    if (!w.main && w.merged) out.push(`${where}: ${w.branch} is merged into main, remove it`);
    for (const s of w.servers) out.push(`${where}: ${s} still running`);
  }
  for (const b of mergedBranches) out.push(`branch ${b}: merged into main, delete it`);
  return out;
}

function state() {
  const common = path.resolve(git(process.cwd(), 'rev-parse', '--git-common-dir'));
  const root = path.dirname(common);
  const count = (range) => Number(git(root, 'rev-list', '--count', range));
  const worktrees = git(root, 'worktree', 'list', '--porcelain')
    .split('\n\n')
    .map((block) => {
      const wtPath = /^worktree (.+)$/m.exec(block)[1];
      const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
      const pidDir = path.join(wtPath, '.playwright-mcp');
      const servers = fs.existsSync(pidDir)
        ? fs
            .readdirSync(pidDir)
            .filter((f) => f.endsWith('.pid') && alive(Number(fs.readFileSync(path.join(pidDir, f), 'utf8'))))
            .map((f) => f.slice(0, -'.pid'.length))
        : [];
      return {
        path: wtPath,
        branch,
        main: wtPath === root,
        // Not git(): trimming would eat the first line's leading status column.
        dirty: execFileSync('git', ['status', '--porcelain'], { cwd: wtPath, encoding: 'utf8' })
          .split('\n')
          .filter(Boolean)
          .map((l) => l.slice(3)),
        merged: branch != null && branch !== 'main' && git(root, 'branch', '--merged', 'main', '--list', branch) !== '',
        servers,
      };
    });
  const checkedOut = new Set(worktrees.map((w) => w.branch));
  const mergedBranches = git(root, 'branch', '--merged', 'main', '--format=%(refname:short)')
    .split('\n')
    .filter((b) => b && b !== 'main' && !checkedOut.has(b));
  return { ahead: count('origin/main..main'), behind: count('main..origin/main'), worktrees, mergedBranches };
}

if (require.main === module) {
  Promise.all([upstreamBugs.check(), prodCheck.check()]).then(([{ left }, prod]) => {
    const lines = [...leftovers(state()), ...left, ...prod];
    console.log(lines.length ? lines.join('\n') : 'nothing left');
    record('session-end', { left: lines.length });
  });
}

module.exports = { leftovers };
