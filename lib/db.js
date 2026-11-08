'use strict';

const { DatabaseSync } = require('node:sqlite');
const { DB_BUSY_TIMEOUT_MS } = require('./config'); // loads .env/default.env — must run before DB_FILE is read below

const DB_PATH = process.env.DB_FILE || ':memory:';

const db = new DatabaseSync(DB_PATH, { timeout: DB_BUSY_TIMEOUT_MS });

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');

// Ordered, append-only, applied incrementally against whatever `user_version` the database is
// already at — never drop-and-recreate, so upgrading never loses data (cache rows included).
// Version 7 is the pre-migration baseline (this repo's old wipe-on-mismatch SCHEMA_VERSION), so
// a database already at 7 treats it as already applied; new migrations start at 8. Once a
// migration has shipped, never edit it — add a new one instead, even to fix it.
// The cache tables versions 7 and 12 create, frozen with them: a new GROUPS table (lib/cache.js)
// gets its own migration (table and `<table>_expiry` index), never an entry here.
const CACHE_TABLES = Object.freeze([
  'cache_library',
  'cache_resolve',
  'cache_rating',
  'cache_meta',
  'cache_search',
  'cache_news',
  'cache_bundles',
  'cache_itad_ids',
]);

const MIGRATIONS = [
  {
    version: 7,
    up(db) {
      for (const table of CACHE_TABLES) {
        db.exec(
          `CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value TEXT NOT NULL, ts INTEGER NOT NULL, expires INTEGER)`,
        );
      }
    },
  },
  {
    // Steam-authenticated users and their server-synced preferences (lib/auth.js). `prefs` holds
    // the same opaque JSON blob the frontend used to keep in localStorage only, so the sync layer
    // above it doesn't need its own schema.
    version: 8,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          steamid TEXT PRIMARY KEY,
          prefs TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          steamid TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        )
      `);
    },
  },
  {
    // Splits users' single `prefs` JSON blob (version 8) into one row per key, each with its own
    // `updated_at` — needed so the frontend (prefs.ts/authStore.ts) can merge a device's local
    // prefs against the server's by last-write-wins per key, rather than only ever comparing "do
    // both sides have anything at all" once at first sign-in. `users.prefs` is left in place
    // (migrations only add, never drop — see this file's own comment above) but unused from here
    // on; any data already in it is copied forward below rather than silently orphaned. A key's
    // `updated_at` copied this way is the user row's own `updated_at`, since version 8 never
    // tracked per-key write times — real per-key times only start accumulating from this point on.
    version: 9,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_prefs (
          steamid TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (steamid, key)
        )
      `);
      const insert = db.prepare(
        'INSERT OR IGNORE INTO user_prefs (steamid, key, value, updated_at) VALUES (?, ?, ?, ?)',
      );
      for (const { steamid, prefs, updated_at } of db.prepare('SELECT steamid, prefs, updated_at FROM users').all()) {
        let parsed;
        try {
          parsed = JSON.parse(prefs);
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== 'object') continue;
        for (const [key, value] of Object.entries(parsed)) insert.run(steamid, key, JSON.stringify(value), updated_at);
      }
    },
  },
  {
    // Outbound status counts per UTC day (lib/metrics.js), kept across restarts.
    version: 10,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS metrics_daily (
          day TEXT NOT NULL,
          grp TEXT NOT NULL,
          label TEXT NOT NULL,
          status TEXT NOT NULL,
          count INTEGER NOT NULL,
          PRIMARY KEY (day, grp, label, status)
        )
      `);
    },
  },
  {
    // sessions.id now holds a SHA-256 of the cookie's id (lib/auth.js): rows keyed by the raw id
    // could never match again, and a db.sqlite copy would still hold them as live sessions.
    version: 11,
    up(db) {
      db.exec('DELETE FROM sessions');
    },
  },
  {
    // Lets the hourly sweep (lib/cache.js `evictSql`) find expired rows without a full scan.
    version: 12,
    up(db) {
      for (const table of CACHE_TABLES) db.exec(`CREATE INDEX IF NOT EXISTS ${table}_expiry ON ${table} (expires, ts)`);
    },
  },
  {
    // Fills each store page's `appdetails:` row (lib/steam.js's trimAppDetails) from its `meta:` row, keeping its write
    // time and expiry. The trim is frozen here as it was then.
    version: 13,
    up(db) {
      const pick = (o, keys) =>
        o && typeof o === 'object' && !Array.isArray(o)
          ? Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]))
          : o;
      const pickEach = (list, keys, max = list?.length) =>
        Array.isArray(list) ? list.slice(0, max).map((item) => pick(item, keys)) : list;
      const trim = (raw) => {
        if (!raw) return raw;
        const fields = pick(raw, [
          ...['name', 'type', 'developers', 'publishers', 'short_description', 'capsule_imagev5', 'capsule_image'],
          ...['header_image', 'dlc', 'website', 'platforms', 'supported_languages', 'is_free'],
          ...[
            'genres',
            'categories',
            'release_date',
            'metacritic',
            'screenshots',
            'movies',
            'fullgame',
            'achievements',
          ],
          'price_overview',
        ]);
        return {
          ...fields,
          ...('genres' in fields && { genres: pickEach(fields.genres, ['description']) }),
          ...('categories' in fields && { categories: pickEach(fields.categories, ['description']) }),
          ...('release_date' in fields && { release_date: pick(fields.release_date, ['date', 'coming_soon']) }),
          ...('metacritic' in fields && { metacritic: pick(fields.metacritic, ['score', 'url']) }),
          ...('screenshots' in fields && {
            screenshots: pickEach(fields.screenshots, ['id', 'path_thumbnail', 'path_full'], 10),
          }),
          ...('movies' in fields && { movies: pickEach(fields.movies, ['id', 'name', 'thumbnail', 'hls_h264'], 5) }),
          ...('fullgame' in fields && { fullgame: pick(fields.fullgame, ['appid', 'name']) }),
          ...('achievements' in fields && { achievements: pick(fields.achievements, ['total']) }),
          ...('price_overview' in fields && { price_overview: pick(fields.price_overview, ['initial']) }),
        };
      };
      const insert = db.prepare('INSERT OR IGNORE INTO cache_meta (key, value, ts, expires) VALUES (?, ?, ?, ?)');
      const rows = db.prepare("SELECT key, value, ts, expires FROM cache_meta WHERE key >= 'meta:' AND key < 'meta;'");
      for (const { key, value, ts, expires } of rows.all()) {
        insert.run(`appdetails:${key.slice('meta:'.length)}`, JSON.stringify(trim(JSON.parse(value))), ts, expires);
      }
    },
  },
];

function migrate(db, migrations) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  const pending = migrations.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  for (const m of pending) {
    db.exec('BEGIN');
    try {
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

migrate(db, MIGRATIONS);

const SLOW_SWEEP_MS = 1000; // lib/metrics.js ALERT.loopDelayMs

// Runs an expiry sweep, warning when it blocked the event loop long enough to alert.
function sweep(tag, run) {
  const start = performance.now();
  run();
  const ms = Math.round(performance.now() - start);
  if (ms >= SLOW_SWEEP_MS) console.warn(`[${tag}] expiry sweep blocked the event loop for ${ms} ms`);
}

module.exports = { db, DB_PATH, migrate, MIGRATIONS, CACHE_TABLES, sweep };
