'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  getCached,
  getCachedAt,
  setCache,
  getCacheEntryCounts,
  createCachedFetch,
  isAnsweredFromCache,
  isCached,
  capExpiry,
  _reset,
} = require('../lib/cache');
const { db } = require('../lib/db');
const { getMetrics } = require('../lib/metrics');
const { createDedup } = require('../lib/dedup');
const { LIBRARY_CACHE_TTL_MS, BUNDLES_CACHE_TTL_MS, FORCE_MIN_AGE_MS } = require('../lib/config');

// ── getCached ─────────────────────────────────────────────────────────────────

test('getCached: returns undefined for missing key', () => {
  _reset();
  assert.equal(getCached('games:x'), undefined);
});

test('getCached: returns value within TTL', () => {
  _reset();
  setCache('games:k', 'hello');
  assert.equal(getCached('games:k'), 'hello');
});

test('getCached: returns undefined when entry is expired', () => {
  _reset([['games:k', { value: 'stale', ts: Date.now() - LIBRARY_CACHE_TTL_MS - 1 }]]);
  assert.equal(getCached('games:k'), undefined);
});

test('getCached: deletes expired entry from the cache', () => {
  _reset([['games:k', { value: 'stale', ts: Date.now() - LIBRARY_CACHE_TTL_MS - 1 }]]);
  getCached('games:k');
  assert.equal(getCached('games:k'), undefined);
});

test('getCached: returns undefined for entry just past TTL boundary', () => {
  _reset([['games:k', { value: 'v', ts: Date.now() - LIBRARY_CACHE_TTL_MS - 1 }]]);
  assert.equal(getCached('games:k'), undefined);
});

test('getCached: returns value for entry just within TTL boundary', () => {
  _reset([['games:k', { value: 'v', ts: Date.now() - LIBRARY_CACHE_TTL_MS + 5_000 }]]);
  assert.equal(getCached('games:k'), 'v');
});

// ── setCache ──────────────────────────────────────────────────────────────────

test('setCache: stored value is retrievable', () => {
  _reset();
  setCache('games:k', { foo: 1 });
  assert.deepEqual(getCached('games:k'), { foo: 1 });
});

test('setCache: null is a valid cached value, distinct from a miss', () => {
  _reset();
  setCache('hltb:k', null);
  assert.equal(getCached('hltb:k'), null);
});

test('setCache: overwrites an existing entry and resets timestamp', () => {
  _reset([['games:k', { value: 'old', ts: Date.now() - 50_000 }]]);
  setCache('games:k', 'new');
  assert.equal(getCached('games:k'), 'new');
});

// ── getCacheEntryCounts ───────────────────────────────────────────────────────

test('getCacheEntryCounts: counts rows per group label, zero for an untouched group', () => {
  _reset();
  setCache('games:a', 1);
  setCache('games:b', 2);
  setCache('resolve:x', 'id');

  const counts = getCacheEntryCounts();
  assert.equal(counts.library, 2);
  assert.equal(counts.resolve, 1);
  assert.equal(counts.rating, 0);
});

test('getCacheEntryCounts: a deleted (expired, then read) entry is no longer counted', () => {
  _reset([['games:k', { value: 'stale', ts: Date.now() - LIBRARY_CACHE_TTL_MS - 1 }]]);
  getCached('games:k'); // triggers the expired-entry delete
  assert.equal(getCacheEntryCounts().library, 0);
});

// ── getCachedAt ───────────────────────────────────────────────────────────────

test('getCachedAt: returns the write time of a cached entry', () => {
  _reset();
  const before = Date.now();
  setCache('games:when', ['a']);
  const at = getCachedAt('games:when');
  assert.ok(at >= before && at <= Date.now());
});

test('getCachedAt: undefined for a missing key, and for an expired one', () => {
  _reset([['games:old', { value: ['a'], ts: Date.now() - LIBRARY_CACHE_TTL_MS - 1000 }]]);
  assert.equal(getCachedAt('games:missing'), undefined);
  assert.equal(getCachedAt('games:old'), undefined);
});

// ── group routing ─────────────────────────────────────────────────────────────

test('ITAD identity mappings outlive the bundle/price tier they used to share', () => {
  // Written well past BUNDLES_CACHE_TTL_MS ago: a bundle listing that old is gone, while the
  // appid↔gid mapping — which nothing about time invalidates — is still there.
  const old = Date.now() - BUNDLES_CACHE_TTL_MS - 1000;
  _reset([
    ['itad-bundles:US:-publish:false:0:20', { value: [{ id: 1 }], ts: old }],
    ['itad-appid:some-gid', { value: 440, ts: old }],
    ['itad-gid:440', { value: 'some-gid', ts: old }],
    ['itad-shop:steam', { value: 61, ts: old }],
  ]);
  assert.equal(getCached('itad-bundles:US:-publish:false:0:20'), undefined);
  assert.equal(getCached('itad-appid:some-gid'), 440);
  assert.equal(getCached('itad-gid:440'), 'some-gid');
  assert.equal(getCached('itad-shop:steam'), 61);
});

test('getCacheEntryCounts: lists the itad-ids group separately from bundles', () => {
  _reset();
  setCache('itad-appid:g', 1);
  setCache('itad-bundles:k', []);
  const counts = getCacheEntryCounts();
  assert.equal(counts['itad-ids'], 1);
  assert.equal(counts.bundles, 1);
});

// ── per-entry TTL (cached misses) ─────────────────────────────────────────────

test('setCache: ttlMs overrides the group TTL for that one entry', () => {
  _reset();
  setCache('meta:1', null, { ttlMs: 50 });
  setCache('meta:2', { name: 'Portal' });
  // Both sit in the meta group (TTL measured in months), but the first carries its own expiry.
  _reset([
    ['meta:1', { value: null, ts: Date.now() - 1000, expires: Date.now() - 500 }],
    ['meta:2', { value: { name: 'Portal' }, ts: Date.now() - 1000 }],
  ]);
  assert.equal(getCached('meta:1'), undefined, 'per-entry expiry applies');
  assert.deepEqual(getCached('meta:2'), { name: 'Portal' }, 'group TTL still applies to the rest');
});

test('getCachedAt: honours a per-entry expiry too', () => {
  _reset([['meta:3', { value: null, ts: Date.now() - 1000, expires: Date.now() - 500 }]]);
  assert.equal(getCachedAt('meta:3'), undefined);
});

test('every key prefix has an explicit TTL group, and an unknown one throws', () => {
  const old = Date.now() - BUNDLES_CACHE_TTL_MS - 1000;
  _reset([
    ['itad-gamebundles:US:gid', { value: [], ts: old }],
    ['playerach:1:440', { value: [], ts: old }],
  ]);
  assert.equal(getCached('itad-gamebundles:US:gid'), undefined, 'bundles tier, not the 30-day library tier');
  assert.deepEqual(getCached('playerach:1:440'), [], 'library tier');
  assert.throws(() => setCache('nope:1', 1), /no TTL group for key nope:1/);
});

// ── Forced reads ──────────────────────────────────────────────────────────────

const cacheEvents = (group) => getMetrics().sinceRestart.cache[group] ?? { hits: 0, forced: 0 };

// A refresh seconds after a fetch would re-spend every upstream call for the same answer (C297).
test('getCached: a forced read of a per-game row younger than FORCE_MIN_AGE_MS is answered, as a hit', () => {
  for (const key of ['meta:1', 'hltb:1', 'rating:1', 'news:1']) {
    _reset([[key, { value: 'v', ts: Date.now() - FORCE_MIN_AGE_MS + 60_000 }]]);
    const group = key === 'rating:1' ? 'rating' : key === 'news:1' ? 'news' : 'meta';
    const before = cacheEvents(group);
    assert.equal(getCached(key, { force: true }), 'v', key);
    assert.equal(isAnsweredFromCache(key, { force: true }), true, key);
    assert.deepEqual([cacheEvents(group).hits - before.hits, cacheEvents(group).forced - before.forced], [1, 0], key);
  }
});

test('getCached: a forced read of a per-game row past FORCE_MIN_AGE_MS refetches', () => {
  _reset([['meta:1', { value: 'v', ts: Date.now() - FORCE_MIN_AGE_MS - 60_000 }]]);
  assert.equal(getCached('meta:1', { force: true }), undefined);
  assert.equal(isAnsweredFromCache('meta:1', { force: true }), false);
});

// A user who just bought a game or unlocked an achievement must see it.
test('getCached: a forced read of a library row refetches however young', () => {
  _reset([['games:k', { value: 'v', ts: Date.now() - 60_000 }]]);
  assert.equal(getCached('games:k', { force: true }), undefined);
  assert.equal(isAnsweredFromCache('games:k', { force: true }), false);
  assert.equal(isCached('games:k'), true);
});

test('isAnsweredFromCache: without options, a live row answers', () => {
  _reset([['games:k', { value: 'v', ts: Date.now() - 60_000 }]]);
  assert.equal(isAnsweredFromCache('games:k'), true);
});

// ── setCache ──────────────────────────────────────────────────────────────────

// A store page's two rows must not be left half written (lib/steam.js's getAppDetails).
test('setCache: rows written alongside are written all or none', () => {
  _reset();
  assert.throws(() => setCache('appdetails:1', 'trimmed', { alongside: [['nope:1', 'whole']] }), /no TTL group/);
  assert.equal(getCachedAt('appdetails:1'), undefined);
});

// ── createCachedFetch ─────────────────────────────────────────────────────────

test('createCachedFetch: a hit skips the load; concurrent misses load once; force reloads', async () => {
  _reset();
  const cachedFetch = createCachedFetch(createDedup());
  let loads = 0;
  const load = async () => ({ value: `v${++loads}` });
  const [a, b] = await Promise.all([cachedFetch('games:k', {}, load), cachedFetch('games:k', {}, load)]);
  assert.deepEqual([a, b, loads], ['v1', 'v1', 1]);
  assert.equal(await cachedFetch('games:k', {}, load), 'v1');
  assert.equal(await cachedFetch('games:k', { force: true }, load), 'v2');
});

test("createCachedFetch: the load's ttlMs sets the entry's expiry; a throw caches nothing", async () => {
  _reset();
  const cachedFetch = createCachedFetch(createDedup());
  await cachedFetch('games:short', {}, async () => ({ value: null, ttlMs: -1 }));
  assert.equal(getCached('games:short'), undefined, 'expired at once');
  await assert.rejects(
    cachedFetch('games:bad', {}, async () => {
      throw new Error('upstream');
    }),
  );
  assert.equal(getCached('games:bad'), undefined);
});

// Capped on every read of a coming-soon row (lib/steam.js): one already within the cap costs no write.
test('capExpiry: brings the expiry forward, and writes nothing when it is already within the cap', () => {
  _reset();
  setCache('meta:1', 'v');
  const writes = () => db.prepare('SELECT total_changes() AS n').get().n;
  let before = writes();
  assert.equal(capExpiry('meta:1', 1000), true);
  assert.equal(writes(), before + 1);
  assert.ok(getCachedAt('meta:1') !== undefined);
  before = writes();
  assert.equal(capExpiry('meta:1', 2000), false);
  assert.equal(writes(), before);
});
