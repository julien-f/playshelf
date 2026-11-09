'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { worktreeEnv } = require('../scripts/dev-server');
const { portOf } = require('../scripts/ports');

test("worktreeEnv: nothing in the main checkout; in a worktree, its ports and the main checkout's .env and database", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-server-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const main = path.join(dir, 'main');
  const wt = path.join(dir, 'wt');
  fs.mkdirSync(main);
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: elsewhere\n');
  fs.writeFileSync(path.join(main, '.env'), 'PORT=3000\nDB_FILE=cache/db.sqlite\n');

  assert.deepEqual(worktreeEnv(main, main), {});
  assert.deepEqual(worktreeEnv(wt, main), {
    DEV_PORT: String(portOf('dev', wt)),
    PORT: String(portOf('backend', wt)),
    DB_FILE: path.join(main, 'cache/db.sqlite'),
  });
  assert.equal(fs.readlinkSync(path.join(wt, '.env')), path.join(main, '.env'));
});
