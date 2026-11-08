'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'db-query.js');

test('db-query: prints rows as JSON lines and refuses to write', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-query-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const file = path.join(dir, 'db.sqlite');
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE t (k TEXT, v INTEGER); INSERT INTO t VALUES ('a', 1), ('b', 2)");
  db.close();
  const env = { ...process.env, DB_FILE: file };

  const out = execFileSync(process.execPath, [SCRIPT, 'SELECT k, v FROM t ORDER BY k'], { env, encoding: 'utf8' });
  assert.deepStrictEqual(out.trim().split('\n').map(JSON.parse), [
    { k: 'a', v: 1 },
    { k: 'b', v: 2 },
  ]);

  const write = spawnSync(process.execPath, [SCRIPT, 'DELETE FROM t'], { env, encoding: 'utf8' });
  assert.notStrictEqual(write.status, 0);
  assert.match(write.stderr, /readonly/);
});

test('db-query: reads the statement from stdin when given none', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-query-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const file = path.join(dir, 'db.sqlite');
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE t (k TEXT); INSERT INTO t VALUES ('it''s $here')");
  db.close();

  const out = execFileSync(process.execPath, [SCRIPT], {
    env: { ...process.env, DB_FILE: file },
    input: "SELECT k\nFROM t\nWHERE k = 'it''s $here';\n",
    encoding: 'utf8',
  });
  assert.deepStrictEqual(JSON.parse(out), { k: "it's $here" });
});
