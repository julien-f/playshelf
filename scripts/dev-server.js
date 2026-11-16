'use strict';

// `npm run dev` in the background: `node scripts/dev-server.js up|down` (background-server.js).
// In a worktree: its own ports, the main checkout's settings and cache database (data.md: a second server may share it).

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const { portOf } = require('./ports');
const { gitCommonDir } = require('./git');

// The environment for a server in `root`, the main checkout being `main`: main's `.env`, then the overrides.
function worktreeEnv(root, main) {
  if (root === main) return {};
  const mainEnv = path.join(main, '.env');
  const settings = fs.existsSync(mainEnv) ? util.parseEnv(fs.readFileSync(mainEnv, 'utf8')) : {};
  return {
    ...settings,
    DEV_PORT: String(portOf('dev', root)),
    PORT: String(portOf('backend', root)),
    DB_FILE: path.resolve(main, settings.DB_FILE || 'db.sqlite'),
  };
}

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const env = worktreeEnv(path.resolve(root), path.dirname(gitCommonDir(root)));
  require('./background-server').cli({ name: 'dev-server', npmScript: 'dev', port: portOf('dev'), env });
}

module.exports = { worktreeEnv };
