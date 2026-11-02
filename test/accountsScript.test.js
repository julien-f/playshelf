'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../lib/db');
const { accounts } = require('../scripts/accounts');

test('accounts: cached profiles with their library flag, and signed-in users with their latest session', () => {
  const put = db.prepare('INSERT INTO cache_library (key, value, ts) VALUES (?, ?, ?)');
  put.run('player:1', JSON.stringify({ personaname: 'Alice' }), Date.UTC(2026, 0, 2));
  put.run('games:1', '[]', Date.UTC(2026, 0, 2));
  put.run('player:2', JSON.stringify({ personaname: 'Bob' }), Date.UTC(2026, 0, 3));
  put.run('playerach:2:620', '{}', Date.UTC(2026, 0, 3));
  db.prepare('INSERT INTO users (steamid, created_at, updated_at) VALUES (?, ?, ?)').run('1', Date.UTC(2026, 0, 1), 0);
  const session = db.prepare('INSERT INTO sessions (id, steamid, expires_at) VALUES (?, ?, ?)');
  session.run('a', '1', Date.UTC(2026, 0, 5));
  session.run('b', '1', Date.UTC(2026, 0, 9));

  assert.deepEqual(accounts(db), {
    cached: [
      { steamid: '2', name: 'Bob', cached: '2026-01-03 00:00', library: false },
      { steamid: '1', name: 'Alice', cached: '2026-01-02 00:00', library: true },
    ],
    signedIn: [{ steamid: '1', name: 'Alice', first_login: '2026-01-01 00:00', session_until: '2026-01-09 00:00' }],
  });
});
