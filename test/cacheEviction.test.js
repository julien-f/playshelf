'use strict';

process.env.DB_FILE = ''; // _reset() empties the cache tables: never the real db.sqlite
const { mock, test } = require('node:test');
const assert = require('node:assert/strict');

// Faked before lib/cache loads, so the eviction interval it arms on load runs on this clock.
mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
const { getCacheEntryCounts, getCachedAt, _reset, _evictSql, STALE_GRACE_MS } = require('../lib/cache');
const { db, CACHE_TABLES } = require('../lib/db');
const { LIBRARY_CACHE_TTL_MS, RATING_CACHE_TTL_MS } = require('../lib/config');

test('expired rows are evicted every hour, not only at startup', () => {
  const rows = () => getCacheEntryCounts().library;
  _reset([['games:k', { value: 'v', ts: Date.now() - LIBRARY_CACHE_TTL_MS + 1000 }]]);
  mock.timers.tick(30 * 60 * 1000);
  assert.equal(rows(), 1, 'expired, but not evicted before the hour');
  mock.timers.tick(30 * 60 * 1000);
  assert.equal(rows(), 0);
});

test('the sweep evicts rows past their own expiry and rows past their TTL, and keeps the rest', () => {
  const now = Date.now();
  _reset([
    ['games:own-past', { value: 'v', ts: now, expires: now - 1 }],
    ['games:own-future', { value: 'v', ts: now - LIBRARY_CACHE_TTL_MS - 1, expires: now + 2 * 60 * 60 * 1000 }],
    ['games:ttl-past', { value: 'v', ts: now - LIBRARY_CACHE_TTL_MS + 1000 }],
    ['games:ttl-fresh', { value: 'v', ts: now }],
  ]);
  mock.timers.tick(60 * 60 * 1000);
  assert.equal(getCacheEntryCounts().library, 2);
  assert.notEqual(getCachedAt('games:own-future'), undefined);
  assert.notEqual(getCachedAt('games:ttl-fresh'), undefined);
});

test("the sweep keeps a grace group's expired rows until the grace is over", () => {
  const now = Date.now();
  _reset([
    ['rating:own', { value: 'v', ts: now, expires: now - STALE_GRACE_MS + 2 * 60 * 60 * 1000 }],
    ['rating:ttl', { value: 'v', ts: now - RATING_CACHE_TTL_MS - STALE_GRACE_MS + 2 * 60 * 60 * 1000 }],
    ['rating:gone', { value: 'v', ts: now, expires: now - STALE_GRACE_MS - 1 }],
  ]);
  mock.timers.tick(60 * 60 * 1000);
  assert.equal(getCacheEntryCounts().rating, 2);
  mock.timers.tick(2 * 60 * 60 * 1000);
  assert.equal(getCacheEntryCounts().rating, 0);
});

test("every cache table's sweep reads only its expiry index, never scans the table", () => {
  for (const table of CACHE_TABLES) {
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${_evictSql(table)}`)
      .all(0, 0)
      .map((r) => r.detail);
    assert.ok(!plan.some((d) => /^SCAN/.test(d)), `${table}: ${plan.join(' | ')}`);
    assert.ok(
      plan.some((d) => d.includes(`${table}_expiry`)),
      `${table}: ${plan.join(' | ')}`,
    );
  }
});
