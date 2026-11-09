'use strict';

// `npm run dev` in the background: `node scripts/dev-server.js up|down` (background-server.js). In a worktree it
// takes the worktree's own ports (ports.js) and the main checkout's `.env` and cache database, which a second
// server may share (data.md), so it neither clashes with the main checkout's server nor refills a cache upstream.

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const { execFileSync } = require('node:child_process');
const { portOf } = require('./ports');

// The environment for a server in `root`, the main checkout being `main`; links `.env` from `main` when `root` has none.
function worktreeEnv(root, main) {
  if (root === main) return {};
  const mainEnv = path.join(main, '.env');
  const hasEnv = fs.existsSync(mainEnv);
  if (hasEnv && !fs.existsSync(path.join(root, '.env'))) fs.symlinkSync(mainEnv, path.join(root, '.env'));
  const dbFile = (hasEnv && util.parseEnv(fs.readFileSync(mainEnv, 'utf8')).DB_FILE) || 'db.sqlite';
  return {
    DEV_PORT: String(portOf('dev', root)),
    PORT: String(portOf('backend', root)),
    DB_FILE: path.resolve(main, dbFile),
  };
}

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root });
  const env = worktreeEnv(path.resolve(root), path.dirname(common.toString().trim()));
  require('./background-server').cli({ name: 'dev-server', npmScript: 'dev', port: portOf('dev'), env });
}

module.exports = { worktreeEnv };
