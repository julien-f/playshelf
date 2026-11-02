'use strict';

// Lists the Steam accounts DB_FILE knows: those with a cached profile, and those who signed in.
// Opens it read-only. Dates are UTC.
//   node scripts/accounts.js

const { DatabaseSync } = require('node:sqlite');
const { record } = require('./dev-metrics');

const date = (ms) => (ms == null ? null : new Date(ms).toISOString().slice(0, 16).replace('T', ' '));

function accounts(db) {
  const cached = db
    .prepare(
      `SELECT substr(p.key, 8) AS steamid, json_extract(p.value, '$.personaname') AS name, p.ts,
         EXISTS (SELECT 1 FROM cache_library g WHERE g.key = 'games:' || substr(p.key, 8)) AS library
       FROM cache_library p WHERE p.key LIKE 'player:%' ORDER BY p.ts DESC`,
    )
    .all()
    .map(({ steamid, name, ts, library }) => ({ steamid, name, cached: date(ts), library: Boolean(library) }));
  const signedIn = db
    .prepare(
      `SELECT u.steamid, json_extract(c.value, '$.personaname') AS name, u.created_at,
         (SELECT max(expires_at) FROM sessions s WHERE s.steamid = u.steamid) AS session_until
       FROM users u LEFT JOIN cache_library c ON c.key = 'player:' || u.steamid ORDER BY u.created_at`,
    )
    .all()
    .map(({ steamid, name, created_at, session_until }) => ({
      steamid,
      name,
      first_login: date(created_at),
      session_until: date(session_until),
    }));
  return { cached, signedIn };
}

function main() {
  require('../lib/config'); // loads .env + default.env as a side effect
  if (!process.env.DB_FILE) {
    console.error('DB_FILE is empty — in-memory database, nothing to list.');
    process.exit(1);
  }
  const { cached, signedIn } = accounts(new DatabaseSync(process.env.DB_FILE, { readOnly: true }));
  console.log(`Cached profiles (${cached.length}):`);
  console.table(cached);
  console.log(`Signed in (${signedIn.length}):`);
  console.table(signedIn);
  record('accounts', { cached: cached.length, signedIn: signedIn.length });
}

if (require.main === module) main();

module.exports = { accounts };
