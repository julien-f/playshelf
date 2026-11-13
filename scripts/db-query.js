'use strict';

// Runs one SQL statement against DB_FILE opened read-only and prints the rows as JSON, one per line —
// for looking into the cache without inline `node -e` quoting, and without any chance of writing.
//   node scripts/db-query.js "SELECT count(*) AS n FROM cache_meta"
//   node scripts/db-query.js < query.sql   (or a quoted heredoc: a multi-line statement, no shell quoting)

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

require('../lib/config'); // loads .env + default.env as a side effect

const sql = (process.argv[2] ?? (process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8'))).trim();
if (!sql) {
  console.error('Usage: node scripts/db-query.js "<sql>"   or   node scripts/db-query.js < query.sql');
  process.exit(1);
}
if (!process.env.DB_FILE) {
  console.error('DB_FILE is empty — in-memory database, nothing to query.');
  process.exit(1);
}

const db = new DatabaseSync(process.env.DB_FILE, { readOnly: true });
for (const row of db.prepare(sql).iterate()) console.log(JSON.stringify(row));
