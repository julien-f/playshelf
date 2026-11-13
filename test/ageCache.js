'use strict';

const { db } = require('../lib/db');
const { FORCE_MIN_AGE_MS } = require('../lib/config');

// Back-dates every cached row past FORCE_MIN_AGE_MINUTES, so a test's forced refresh refetches what it just fetched.
function ageCache(ms = FORCE_MIN_AGE_MS + 1000) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cache%'").all();
  for (const { name } of tables) db.prepare(`UPDATE ${name} SET ts = ts - ?`).run(ms);
}

module.exports = { ageCache };
