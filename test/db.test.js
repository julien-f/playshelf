'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { db: appDb, migrate, MIGRATIONS, CACHE_TABLES, sweep } = require('../lib/db');

test('migrate: a fresh database ends up at the latest version with every table', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db, MIGRATIONS);
  const { user_version } = db.prepare('PRAGMA user_version').get();
  assert.equal(user_version, MIGRATIONS.at(-1).version);
  for (const table of [
    'cache_library',
    'cache_resolve',
    'cache_rating',
    'cache_meta',
    'cache_search',
    'cache_news',
    'cache_bundles',
    'cache_itad_ids',
  ]) {
    assert.doesNotThrow(() => db.prepare(`SELECT * FROM ${table}`).all());
  }
});

test('CACHE_TABLES is frozen with the shipped migrations 7 and 12 that loop over it', () => {
  assert.ok(Object.isFrozen(CACHE_TABLES), 'a new cache table gets its own migration, not an entry here');
});

test("migrate: a database already at a migration's version treats it as applied, preserving existing rows", () => {
  const db = new DatabaseSync(':memory:');
  for (const table of CACHE_TABLES)
    db.exec(`CREATE TABLE ${table} (key TEXT PRIMARY KEY, value TEXT NOT NULL, ts INTEGER NOT NULL, expires INTEGER)`);
  db.exec("INSERT INTO cache_library (key, value, ts) VALUES ('k', 'v', 1)");
  db.exec('PRAGMA user_version = 7');

  migrate(db, MIGRATIONS);

  const row = db.prepare('SELECT value FROM cache_library WHERE key = ?').get('k');
  assert.equal(row.value, 'v');
});

test('migrate: running twice is a no-op the second time', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db, MIGRATIONS);
  db.exec("INSERT INTO cache_library (key, value, ts) VALUES ('k', 'v', 1)");

  migrate(db, MIGRATIONS);

  const row = db.prepare('SELECT value FROM cache_library WHERE key = ?').get('k');
  assert.equal(row.value, 'v');
});

test('migrate: a failed migration rolls back and leaves user_version unchanged', () => {
  const db = new DatabaseSync(':memory:');
  const migrations = [
    {
      version: 1,
      up(db) {
        db.exec('CREATE TABLE t (id INTEGER)');
      },
    },
    {
      version: 2,
      up() {
        throw new Error('boom');
      },
    },
  ];

  migrate(db, [migrations[0]]);
  assert.throws(() => migrate(db, migrations), /boom/);

  const { user_version } = db.prepare('PRAGMA user_version').get();
  assert.equal(user_version, 1);
});

test('migrate: version 9 splits an existing users.prefs blob into one user_prefs row per key', () => {
  const db = new DatabaseSync(':memory:');
  migrate(
    db,
    MIGRATIONS.filter((m) => m.version <= 8),
  );
  db.exec(`
    INSERT INTO users (steamid, prefs, created_at, updated_at)
    VALUES ('1', '${JSON.stringify({ region: 'DE', myAccount: { id: '1' } })}', 1000, 5000)
  `);

  migrate(db, MIGRATIONS);

  // node:sqlite rows are null-prototype objects — spread into plain ones so deepEqual doesn't
  // trip over the prototype difference.
  const rows = db
    .prepare('SELECT key, value, updated_at FROM user_prefs WHERE steamid = ? ORDER BY key')
    .all('1')
    .map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { key: 'myAccount', value: JSON.stringify({ id: '1' }), updated_at: 5000 },
    { key: 'region', value: JSON.stringify('DE'), updated_at: 5000 },
  ]);
});

test('migrate: version 9 tolerates a user with no prefs at all', () => {
  const db = new DatabaseSync(':memory:');
  migrate(
    db,
    MIGRATIONS.filter((m) => m.version <= 8),
  );
  db.exec("INSERT INTO users (steamid, created_at, updated_at) VALUES ('1', 1000, 1000)");

  assert.doesNotThrow(() => migrate(db, MIGRATIONS));
  const rows = db.prepare('SELECT * FROM user_prefs WHERE steamid = ?').all('1');
  assert.deepEqual(rows, []);
});

test('migrate: version 11 signs everyone out, since sessions stored before it are keyed by the raw id', () => {
  const db = new DatabaseSync(':memory:');
  migrate(
    db,
    MIGRATIONS.filter((m) => m.version <= 10),
  );
  db.exec("INSERT INTO users (steamid, created_at, updated_at) VALUES ('1', 1000, 1000)");
  db.exec("INSERT INTO sessions (id, steamid, expires_at) VALUES ('raw-id', '1', 9999999999999)");

  migrate(db, MIGRATIONS);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
});

test("migrate: version 13 fills each store page's trimmed appdetails row from its meta row, keeping its expiry", () => {
  const db = new DatabaseSync(':memory:');
  migrate(
    db,
    MIGRATIONS.filter((m) => m.version <= 12),
  );
  const page = { name: 'G', detailed_description: 'long', achievements: { total: 2, highlighted: [] } };
  const insert = db.prepare('INSERT INTO cache_meta (key, value, ts, expires) VALUES (?, ?, ?, ?)');
  insert.run('meta:1', JSON.stringify(page), 1000, null);
  insert.run('meta:2', 'null', 2000, 9000);
  insert.run('metacritic:3', '{}', 3000, null); // not a store page, though it starts alike
  insert.run('browse:4', '{}', 4000, null);

  migrate(db, MIGRATIONS);

  const rows = db.prepare('SELECT key, value, ts, expires FROM cache_meta ORDER BY key').all();
  assert.deepEqual(
    rows.map((r) => ({ ...r })),
    [
      { key: 'appdetails:1', value: '{"name":"G","achievements":{"total":2}}', ts: 1000, expires: null },
      { key: 'appdetails:2', value: 'null', ts: 2000, expires: 9000 },
      { key: 'browse:4', value: '{}', ts: 4000, expires: null },
      { key: 'meta:1', value: JSON.stringify(page), ts: 1000, expires: null },
      { key: 'meta:2', value: 'null', ts: 2000, expires: 9000 },
      { key: 'metacritic:3', value: '{}', ts: 3000, expires: null },
    ],
  );
});

test("requiring lib/db picks up default.env's DB_FILE even without a shell-level DB_FILE set", () => {
  // Regression test: lib/db.js used to read process.env.DB_FILE before lib/config.js had loaded
  // default.env (whichever of lib/db.js's requirers happened to require lib/config first), so it
  // silently always fell back to ':memory:'. Runs in a fresh process with a clean env and cwd, so
  // require order isn't influenced by whatever this test file (or npm test's own DB_FILE=) has
  // already loaded, and default.env's `DB_FILE=db.sqlite` lands in a throwaway directory instead
  // of the real one.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'db-test-'));
  try {
    const env = { ...process.env };
    delete env.DB_FILE;
    execFileSync(
      process.execPath,
      ['-e', "require('" + path.join(__dirname, '..', 'lib', 'db').replace(/\\/g, '\\\\') + "')"],
      { cwd, env },
    );
    assert.ok(
      fs.existsSync(path.join(cwd, 'db.sqlite')),
      "expected default.env's DB_FILE=db.sqlite to be honored, not :memory:",
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('lib/db opens the database with a busy timeout', () => {
  assert.ok(appDb.prepare('PRAGMA busy_timeout').get().timeout > 0);
});

test('migrate: every cache table gets its expiry index', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db, MIGRATIONS);
  for (const table of CACHE_TABLES) {
    const names = db
      .prepare(`PRAGMA index_list(${table})`)
      .all()
      .map((r) => r.name);
    assert.ok(names.includes(`${table}_expiry`), `${table}: ${names}`);
  }
});

test('sweep: warns only when it blocked the event loop for a second or more', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const now = t.mock.method(performance, 'now', () => 0);
  sweep('cache', () => now.mock.mockImplementation(() => 999));
  assert.equal(warn.mock.callCount(), 0);
  now.mock.mockImplementation(() => 0);
  sweep('cache', () => now.mock.mockImplementation(() => 1000));
  assert.deepEqual(warn.mock.calls[0].arguments, ['[cache] expiry sweep blocked the event loop for 1000 ms']);
});
