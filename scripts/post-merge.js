'use strict';

// The post-merge hook: `npm ci` when the merge (or pull) changed package-lock.json, so this checkout's
// node_modules keep up with it (pitfalls.md's "node_modules is behind package-lock.json"). Logs each run
// (dev-metrics `post-merge`). A failure only warns: the merge is already done.

const { spawnSync } = require('node:child_process');
const { record } = require('./dev-metrics');

function main() {
  const start = Date.now();
  let lockChanged = false;
  let ok = false;
  try {
    // Exit 1: the lockfile differs between the merge's two sides.
    lockChanged =
      spawnSync('git', ['diff', '--quiet', 'ORIG_HEAD', 'HEAD', '--', 'package-lock.json'], { stdio: 'inherit' })
        .status === 1;
    if (lockChanged) {
      console.log('post-merge: package-lock.json changed, running npm ci');
      ok = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { stdio: 'inherit' }).status === 0;
      if (!ok) console.warn('post-merge: npm ci failed; run it by hand');
    } else ok = true;
  } finally {
    record('post-merge', { lockChanged, ok, seconds: Math.round((Date.now() - start) / 1000) });
  }
}

if (require.main === module) main();
