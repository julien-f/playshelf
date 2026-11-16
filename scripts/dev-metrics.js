'use strict';

// Local history of the dev loop's numbers (gate timings, check runs, skill evals), one JSONL file per
// kind under the git common dir: never committed, and shared by every worktree so fix-batch lanes count.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// The absolute git dir shared by every checkout of the repo `cwd` is in; its parent is the main checkout.
function gitCommonDir(cwd) {
  return execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

// METRICS_DIR: tests only.
function file(name) {
  if (process.env.METRICS_DIR) return path.join(process.env.METRICS_DIR, `${name}.jsonl`);
  return path.join(gitCommonDir(ROOT), 'dev-metrics', `${name}.jsonl`);
}

// Appends `row`, stamped with the time; a failure only warns, so it never fails a check or a commit.
function record(name, row) {
  try {
    const f = file(name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n');
  } catch (err) {
    console.warn(`[dev-metrics] not recorded: ${err.message}`);
  }
}

// Every row recorded under `name`, oldest first.
function history(name) {
  try {
    return fs
      .readFileSync(file(name), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

module.exports = { record, history, gitCommonDir };
