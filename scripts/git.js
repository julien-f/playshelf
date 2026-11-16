'use strict';

const { execFileSync } = require('node:child_process');

// The absolute git dir shared by every checkout of the repo `cwd` is in; its parent is the main checkout.
function gitCommonDir(cwd) {
  return execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

module.exports = { gitCommonDir };
