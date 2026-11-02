'use strict';

// Each local server's port: the main checkout (and CI) keeps the base, a worktree draws its own from
// its path, so agents running servers in parallel worktrees don't collide. An env var overrides.
//   node scripts/ports.js e2e|mock|perf   prints this checkout's port

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// e2e below Linux's ephemeral range (see playwright.config.ts); mock where `dev:mock` always was.
// perf: scripts/perf-measure.js's preview, below e2e's worktree range (28993–30992).
const PORTS = {
  e2e: { base: 28992, env: 'E2E_PORT' },
  mock: { base: 58993, env: 'MOCK_PORT' },
  perf: { base: 26991, env: 'PERF_PORT' },
};

function portOf(name, root = ROOT, env = process.env) {
  const { base, env: key } = PORTS[name];
  if (env[key]) return Number(env[key]);
  if (!fs.statSync(path.join(root, '.git'), { throwIfNoEntry: false })?.isFile()) return base;
  return base + 1 + (crypto.createHash('sha256').update(root).digest().readUInt16BE(0) % 2000);
}

if (require.main === module) {
  if (!PORTS[process.argv[2]]) {
    console.error(`Usage: node scripts/ports.js ${Object.keys(PORTS).join('|')}`);
    process.exit(1);
  }
  console.log(portOf(process.argv[2]));
}

module.exports = { portOf };
