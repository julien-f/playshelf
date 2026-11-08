'use strict';

const { db, sweep } = require('./db');
const {
  LIBRARY_CACHE_TTL_MS,
  RESOLVE_CACHE_TTL_MS,
  RATING_CACHE_TTL_MS,
  META_CACHE_TTL_MS,
  SEARCH_CACHE_TTL_MS,
  NEWS_CACHE_TTL_MS,
  FORCE_MIN_AGE_MS,
  BUNDLES_CACHE_TTL_MS,
  ITAD_ID_CACHE_TTL_MS,
  EXPIRED_SWEEP_INTERVAL_MS,
} = require('./config');
const { recordCacheEvent } = require('./metrics');

// How long an expired row of a `grace` group is kept to answer a failed refetch (createCachedFetch).
const STALE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

// One table per TTL group — eviction is a single DELETE per table. Table creation lives in
// lib/db.js's migrations, not here — adding a group here requires a migration to go with it.
// `label` is a short,
// external-facing name for the group (used by recordCacheEvent above and getCacheEntryCounts
// below, for GET /api/metrics) — kept separate from `table` so that internal identifier is
// free to stay as-is even though it isn't something anyone outside this file should need to
// know about.
const GROUPS = [
  {
    table: 'cache_library',
    label: 'library',
    ttl: LIBRARY_CACHE_TTL_MS,
    prefixes: ['games:', 'player:', 'wishlist:', 'friends:', 'playerach:'],
  },
  { table: 'cache_resolve', label: 'resolve', ttl: RESOLVE_CACHE_TTL_MS, prefixes: ['resolve:'] },
  // `forceMinAge`: a per-game group, whose rows a refresh just after a fetch gets as they are (isAnsweredFromCache).
  // `grace`: how long its expired rows stay, served when their refetch fails.
  {
    table: 'cache_rating',
    label: 'rating',
    ttl: RATING_CACHE_TTL_MS,
    forceMinAge: true,
    grace: STALE_GRACE_MS,
    prefixes: ['rating:'],
  },
  {
    table: 'cache_meta',
    label: 'meta',
    ttl: META_CACHE_TTL_MS,
    forceMinAge: true,
    grace: STALE_GRACE_MS,
    prefixes: [
      'hltb:',
      'meta:',
      'appdetails:',
      'browse:',
      'tagnames:',
      'protondb:',
      'gameschema:',
      'achrarity:',
      'steampkg:',
      'steambundle:',
      'msstore-title:',
    ],
  },
  { table: 'cache_search', label: 'search', ttl: SEARCH_CACHE_TTL_MS, prefixes: ['search:', 'creator:'] },
  {
    table: 'cache_news',
    label: 'news',
    ttl: NEWS_CACHE_TTL_MS,
    forceMinAge: true,
    prefixes: ['news:'],
  },
  // ITAD bundle listings and per-region price lookups — the genuinely time-sensitive half of
  // the ITAD data (a bundle goes live or expires; a sale starts or ends).
  // `fanatical-pnm:` is Fanatical's pick-and-mix tier prices (lib/fanatical.js), the same kind of bundle data;
  // `gamepass:` the PC Game Pass catalog (lib/gamepass.js), which changes as often.
  {
    table: 'cache_bundles',
    label: 'bundles',
    ttl: BUNDLES_CACHE_TTL_MS,
    prefixes: ['itad-bundles:', 'itad-gamebundles:', 'itad-price:', 'fanatical-pnm:', 'gamepass:'],
  },
  // ITAD identity mappings: the Steam shop id, and both directions of the ITAD gid ↔ Steam appid
  // resolution (`itad-appid:` from resolveSteamAppIds, `itad-gid:` from resolveItadIds): nothing
  // about them is time-sensitive (a game's Steam listing doesn't move), so not the bundles tier.
  {
    table: 'cache_itad_ids',
    label: 'itad-ids',
    ttl: ITAD_ID_CACHE_TTL_MS,
    prefixes: ['itad-shop:', 'itad-appid:', 'itad-gid:'],
  },
];

function groupFor(key) {
  for (const g of GROUPS) {
    if (g.prefixes.some((p) => key.startsWith(p))) return g;
  }
  // No catch-all: a silent fallback once filed bundle data under the 30-day library tier.
  throw new Error(`[cache] no TTL group for key ${key}`);
}

// `COALESCE(expires, ts + ttl) < now`, written so it reads the `<table>_expiry` index (lib/db.js):
// a scan reads every row's overflow pages to reach `ts`/`expires`, stored after `value`.
const evictSql = (table) => `DELETE FROM ${table} WHERE expires < ? OR (expires IS NULL AND ts < ?)`;

// Prepared statements per table
const stmts = Object.fromEntries(
  GROUPS.map(({ table }) => [
    table,
    {
      get: db.prepare(`SELECT value, ts, expires FROM ${table} WHERE key = ?`),
      getTs: db.prepare(`SELECT ts, expires FROM ${table} WHERE key = ?`),
      set: db.prepare(`INSERT OR REPLACE INTO ${table} (key, value, ts, expires) VALUES (?, ?, ?, ?)`),
      setExpires: db.prepare(`UPDATE ${table} SET expires = ? WHERE key = ?`),
      evict: db.prepare(evictSql(table)),
      count: db.prepare(`SELECT COUNT(*) AS n FROM ${table}`),
    },
  ]),
);

// Evict entries past their expiry (and their group's `grace`) at startup, then hourly: reads never delete.
// TTL changes take effect immediately on the next restart.
function evictExpired() {
  sweep('cache', () => {
    const now = Date.now();
    for (const { table, ttl, grace = 0 } of GROUPS) stmts[table].evict.run(now - grace, now - ttl - grace);
  });
}
evictExpired();
setInterval(evictExpired, EXPIRED_SWEEP_INTERVAL_MS).unref();

// When does this row stop being valid? — its own `expires` when it has one, otherwise its
// group's TTL counted from the write time.
const expiryOf = (row, ttl) => (row.expires === null || row.expires === undefined ? row.ts + ttl : row.expires);

// { force: true } treats the entry as a miss without deleting it — the caller is
// expected to setCache() a fresh value right after, which overwrites it anyway. Every outcome
// is reported to lib/metrics.js's recordCacheEvent — see its own comment for why hit/miss/
// forced tracking lives there rather than as a local counter in this file: a collapsing hit
// rate on one label (TTL misconfigured, an eviction bug, a route calling `{force: true}` more
// than expected) needs the same sinceRestart/lastHour treatment every other counter in
// GET /api/metrics gets, and that bookkeeping is centralized in lib/metrics.js.
// { record: false } is for a rate limiter's skip peeking at a value the route then reads itself,
// and for the app shell's link-preview lookup, which isn't a tier lookup either.
function getCached(key, { force = false, record = true } = {}) {
  const { table, label, ttl } = groupFor(key);
  const recordEvent = (outcome) => record && recordCacheEvent(label, outcome);
  if (force && !isAnsweredFromCache(key, { force })) {
    recordEvent('forced');
    return undefined;
  }
  const row = stmts[table].get.get(key);
  if (!row) {
    recordEvent('misses');
    return undefined;
  }
  if (Date.now() < expiryOf(row, ttl)) {
    recordEvent('hits');
    return JSON.parse(row.value);
  }
  recordEvent('misses');
  return undefined;
}

// Splits a batch into its cache hits (id -> value) and the ids still to fetch.
function partitionCached(ids, keyOf, opts) {
  const hits = new Map();
  const uncached = [];
  for (const id of ids) {
    const hit = getCached(keyOf(id), opts);
    if (hit !== undefined) hits.set(id, hit);
    else uncached.push(id);
  }
  return { hits, uncached };
}

// In lib/cache.js, not lib/upstream.js: lib/metrics.js requires upstream.js, so that would be a cycle.
function createCachedFetch(withDedup) {
  return async (key, { force = false }, load) => {
    const hit = getCached(key, { force });
    if (hit !== undefined) return hit;
    try {
      return await withDedup(key, async () => {
        const { value, ttlMs, alongside } = await load();
        setCache(key, value, { ttlMs, alongside });
        return value;
      });
    } catch (err) {
      // Outside withDedup: a client whose budget is spent mustn't hand its fallback to the others waiting.
      const stale = force ? undefined : getExpired(key);
      if (!stale) throw err;
      // A held lookup was warned when it failed; a spent budget is one client's, not the upstream's.
      if (!err?.isLogged && !err?.isBudgetExhausted)
        console.warn(
          `[cache] ${key}: refetch failed (${err?.message}), serving the value from ${new Date(stale.ts).toISOString()}`,
        );
      return stale.value;
    }
  };
}

// An expired row still within its group's `grace`, as { value, ts }.
function getExpired(key) {
  const { table, ttl, grace = 0 } = groupFor(key);
  const row = stmts[table].get.get(key);
  if (!row || Date.now() >= expiryOf(row, ttl) + grace) return undefined;
  return { value: JSON.parse(row.value), ts: row.ts };
}

// When was this key's cached value written? — undefined when it isn't cached (or has expired, unless `expired`
// asks for a row kept within its group's grace: the age of a value served after a failed refetch). Backs the
// "Updated <when>" readout the frontend shows next to its ↻ Refresh buttons: with tiers
// measured in weeks or more, the age of what's on screen is something the user has to be able
// to see, not just something the server knows. Deliberately does NOT
// record a cache event — this is metadata about an entry, not a read of it.
function getCachedAt(key, { expired = false } = {}) {
  const { table, ttl, grace = 0 } = groupFor(key);
  const row = stmts[table].getTs.get(key);
  if (!row) return undefined;
  if (Date.now() >= expiryOf(row, ttl) + (expired ? grace : 0)) return undefined;
  return row.ts;
}

// Whether the key holds a live entry, without reading its value or counting as a cache read.
const isCached = (key) => getCachedAt(key) !== undefined;

// Whether a read of `key` is answered from the cache: a forced one only from a `forceMinAge` group's row younger than FORCE_MIN_AGE_MS.
function isAnsweredFromCache(key, { force = false } = {}) {
  const at = getCachedAt(key);
  if (at === undefined) return false;
  return !force || (groupFor(key).forceMinAge === true && Date.now() - at < FORCE_MIN_AGE_MS);
}

// `ttlMs` overrides the key's group TTL for this one entry. Used for cached *misses* — a
// confirmed "this appid has no store page" / "this game has no Steam listing" / "no such vanity
// URL" — which are worth caching (they otherwise cost an upstream call every single time
// someone asks) but must not inherit a tier TTL measured in months: an unreleased game gets a
// store page, a listing gets added, a person registers the vanity URL they were about to. See
// MISS_CACHE_TTL_MINUTES/RESOLVE_MISS_CACHE_TTL_MINUTES in default.env.
// `alongside`: more [key, value] rows written with the same write time and expiry (lib/steam.js's store page).
function setCache(key, value, { ttlMs, alongside = [] } = {}) {
  const now = Date.now();
  const rows = [[key, value], ...alongside].map(([k, v]) => [stmts[groupFor(k).table].set, k, JSON.stringify(v)]);
  // One transaction: never one row without the other, and one commit.
  db.exec('BEGIN');
  try {
    for (const [set, k, v] of rows) set.run(k, v, now, ttlMs === undefined ? null : now + ttlMs);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Brings an entry's expiry forward to at most `capOf(ts)` (its write time), for a lifetime only known after it was
// cached (a source that had nothing because the game isn't out yet). True when it wrote.
function capExpiry(key, capOf) {
  const { table, ttl } = groupFor(key);
  const row = stmts[table].getTs.get(key);
  if (!row) return false;
  // A row already within the cap (one read again) costs no write.
  const capped = capOf(row.ts);
  if (capped >= expiryOf(row, ttl)) return false;
  stmts[table].setExpires.run(capped, key);
  return true;
}

// Per-group cache row counts for GET /api/metrics — unlike recordCacheEvent's hit/miss/forced
// counters (in-memory, reset on restart), row counts are read straight from db.sqlite so they
// reflect entries from before the current process even started. Read alongside `cache` (GET /api/metrics), this
// tells apart "few entries, lots of misses" (a TTL too short, evicting before reuse) from "many
// entries, lots of misses" (a large/low-locality key space the cache structurally can't help
// much with) — neither is distinguishable from hit/miss counts alone.
function getCacheEntryCounts() {
  return Object.fromEntries(GROUPS.map(({ table, label }) => [label, stmts[table].count.get().n]));
}

// Test-only: wipes cache rows. Does NOT touch recordCacheEvent's hit/miss/forced counters —
// those now live in lib/metrics.js, which has its own `_reset` for that (see test callers).
function _reset(entries = []) {
  for (const { table } of GROUPS) db.exec(`DELETE FROM ${table}`);
  for (const [key, entry] of entries) {
    const { table } = groupFor(key);
    stmts[table].set.run(key, JSON.stringify(entry.value), entry.ts, entry.expires ?? null);
  }
}

module.exports = {
  GROUPS,
  STALE_GRACE_MS,
  getCached,
  partitionCached,
  createCachedFetch,
  getCachedAt,
  isCached,
  isAnsweredFromCache,
  setCache,
  capExpiry,
  getCacheEntryCounts,
  _reset,
  _evictSql: evictSql,
};
