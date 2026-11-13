'use strict';

// This file exercises the details rate limiter, so it opts INTO rate limiting
// (the main suite bypasses it) and sets a low max. Env must be read before the
// app is required, and node:test runs each file in its own process — so this
// configuration is isolated from the rest of the suite.
process.env.STEAM_API_KEY = 'test-key';
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_ENABLED = 'true';
process.env.SEARCH_RATE_LIMIT_MAX = '2';
process.env.DETAILS_RATE_LIMIT_MAX = '3';
process.env.GAME_SEARCH_RATE_LIMIT_MAX = '2';
process.env.ITAD_API_KEY = 'test-itad-key';
process.env.BUNDLES_RATE_LIMIT_MAX = '2';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { app } = require('../server');
const { _reset, setCache } = require('../lib/cache');
const { _resetAuth } = require('../lib/hltb');
const { ageCache } = require('./ageCache');
const { _reset: _resetMetrics } = require('../lib/metrics');

const api = supertest(app);

function workingDetailsFetch(fetchedAppids) {
  return async (url) => {
    const appid =
      url.match(/appids=(\d+)/)?.[1] || url.match(/%22appid%22%3A(\d+)/)?.[1] || url.match(/appid=(\d+)/)?.[1];
    if (appid) fetchedAppids.add(appid);
    if (url.includes('GetAppReviews')) {
      return {
        ok: true,
        json: async () => ({
          response: { query_summary: { total_reviews: 1000, total_positive: 900, review_score_desc: 'Very Positive' } },
        }),
      };
    }
    if (url.includes('IStoreBrowseService')) {
      return { ok: true, json: async () => ({ response: { store_items: [{ success: 1, tagids: [1001] }] } }) };
    }
    if (url.includes('ajaxgetstoretags')) {
      return { ok: true, json: async () => ({ tags: [{ tagid: 1001, name: 'Action' }] }) };
    }
    if (url.includes('appdetails')) {
      return {
        ok: true,
        json: async () => ({
          [appid]: {
            success: true,
            data: { name: 'Portal', genres: [], categories: [], developers: [], publishers: [] },
          },
        }),
      };
    }
    if (url.includes('protondb.com')) {
      return { ok: true, json: async () => ({ tier: 'gold', confidence: 'strong', total: 500 }) };
    }
    if (url.includes('search/site/init'))
      return { ok: true, json: async () => ({ token: 'tok', hpKey: 'k', hpVal: 'v' }) };
    if (url.includes('search/site'))
      return { ok: true, json: async () => ({ data: [{ game_name: 'Portal', comp_main: 36000, comp_plus: 72000 }] }) };
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

// Cache misses count against the budget; once exhausted, further misses 429.
// But a cache hit must always be served — it makes no upstream call, so the
// limiter skips it. This is the fix for "fast refresh 429s itself".
test('details limiter: counts cache misses but never counts cache hits', async (t) => {
  _reset();
  _resetAuth();
  const fetchedAppids = new Set();
  t.mock.method(globalThis, 'fetch', workingDetailsFetch(fetchedAppids));

  // Pre-cache appid 800 fully — this one should always be served.
  setCache('rating:800', { total_reviews: 1000, total_positive: 900, review_score_desc: 'Very Positive' });
  setCache('hltb:800', [{ game_id: 42, game_name: 'Portal', comp_main: 36000, comp_plus: 54000 }]);
  setCache('appdetails:800', { name: 'Portal', genres: [], categories: [], developers: [], publishers: [] });
  setCache('browse:800', { tagids: [1001] });
  setCache('tagnames:all', { 1001: 'Action' });
  setCache('protondb:800', { tier: 'gold', confidence: 'strong', total: 500 });

  // Three uncached appids consume the budget (max = 3).
  for (const appid of [801, 802, 803]) {
    const res = await api.get(`/api/game-details/${appid}`);
    assert.equal(res.status, 200, `miss ${appid} should succeed within budget`);
  }

  // A fourth cache miss is over budget → 429.
  const over = await api.get('/api/game-details/804');
  assert.equal(over.status, 429, 'a cache miss past the budget should be rate limited');
  const fresh = await api.get('/api/game-details/800?refresh=1');
  assert.equal(fresh.status, 200, 'a forced refresh of sources under FORCE_MIN_AGE_MINUTES old is answered from cache');
  assert.ok(!fetchedAppids.has('800'), 'nor fetched upstream');
  ageCache();
  const refresh = await api.get('/api/game-details/800?refresh=1');
  assert.equal(refresh.status, 429, 'a forced refresh of a cached key past the budget should be rate limited');

  // The cached appid is still served even though the budget is exhausted,
  // and crucially does NOT trigger any upstream fetch.
  _resetMetrics();
  const cached = await api.get('/api/game-details/800');
  assert.equal(cached.status, 200, 'a cache hit must bypass the limiter');
  assert.equal(cached.body.rating.score, 88);
  assert.ok(!fetchedAppids.has('800'), 'cache hit must not fetch upstream');
  // The skip's own checks aren't reads: only the route's count as hits in GET /api/metrics.
  const { cache } = (await api.get('/api/metrics')).body.sinceRestart;
  assert.deepEqual(cache.rating, { hits: 1, misses: 0, forced: 0 });
});

// Same "cache hits never count" rule as above, applied to the game-search limiter.
test('game search limiter: counts cache misses but never counts cache hits', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ items: [{ id: 400, name: 'Portal' }] }),
  }));

  setCache('search:cached term', [{ appid: 900, name: 'Pre-cached', tinyImage: null }]);

  // Two uncached terms consume the budget (max = 2).
  for (const term of ['term one', 'term two']) {
    const res = await api.get(`/api/search-games?q=${encodeURIComponent(term)}`);
    assert.equal(res.status, 200, `miss "${term}" should succeed within budget`);
  }

  // A third cache miss is over budget → 429.
  const over = await api.get('/api/search-games?q=term three');
  assert.equal(over.status, 429, 'a cache miss past the budget should be rate limited');

  // The cached term is still served even though the budget is exhausted.
  const cached = await api.get('/api/search-games?q=cached term');
  assert.equal(cached.status, 200, 'a cache hit must bypass the limiter');
  assert.deepEqual(cached.body.results, [{ appid: 900, name: 'Pre-cached', tinyImage: null }]);
});

// Same rule for the creator-games limiter; its cache key keeps the name's case.
test('creator games limiter: counts cache misses but never counts cache hits', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ total_count: 1, start: 0, results_html: '<a data-ds-itemkey="App_10">' }),
  }));
  setCache('creator:developer:Cached', { appids: [900], total: 1, capped: false });

  for (const name of ['One', 'Two']) {
    const res = await api.get(`/api/creator-games?role=developer&name=${name}`);
    assert.equal(res.status, 200, `miss "${name}" should succeed within budget`);
  }
  const caseVariant = await api.get('/api/creator-games?role=developer&name=cached');
  assert.equal(caseVariant.status, 429, 'another case is another name, so a miss');
  const refresh = await api.get('/api/creator-games?role=developer&name=Cached&refresh=1');
  assert.equal(refresh.status, 429, 'a forced refresh of a cached key past the budget should be rate limited');

  const cached = await api.get('/api/creator-games?role=developer&name=Cached');
  assert.equal(cached.status, 200, 'a cache hit must bypass the limiter');
  assert.deepEqual(cached.body.appids, [900]);
});

// Regression test for the bug reported live: switching between a handful of already-loaded
// accounts used to burn the whole per-minute search budget, since searchLimit's original skip()
// was just rateLimitBypassed() — every request counted, cache hit or not (unlike every other
// limiter in this file). searchLimit is shared by POST /api/common-games and POST /api/wishlist
// (see server.js), so this exercises the skip across both call shapes against one shared budget,
// the way they really share it.
test('search limiter: counts cache misses but never counts cache hits (common-games + wishlist)', async (t) => {
  _reset();
  const CACHED_COMMON = '76561198000000099';
  const CACHED_WISHLIST = '76561198000000199';
  const calledIds = new Set();
  t.mock.method(globalThis, 'fetch', async (url) => {
    const idMatch = url.match(/steamid=(\d+)/) || url.match(/steamids=([\d,]+)/);
    if (idMatch) idMatch[1].split(',').forEach((id) => calledIds.add(id));
    if (url.includes('GetOwnedGames')) return { ok: true, json: async () => ({ response: { games: [] } }) };
    if (url.includes('GetWishlist')) return { ok: true, json: async () => ({ response: {} }) };
    if (url.includes('GetPlayerSummaries')) return { ok: true, json: async () => ({ response: { players: [] } }) };
    throw new Error(`Unexpected fetch: ${url}`);
  });

  // Pre-cache one account fully on each route — these should always be served.
  setCache(`player:${CACHED_COMMON}`, { steamid: CACHED_COMMON, personaname: 'Cached', profileurl: '' });
  setCache(`games:${CACHED_COMMON}`, []);
  setCache(`player:${CACHED_WISHLIST}`, { steamid: CACHED_WISHLIST, personaname: 'Cached', profileurl: '' });
  setCache(`wishlist:${CACHED_WISHLIST}`, []);

  // Two uncached searches, one per route, consume the shared budget (max = 2).
  const miss1 = await api.post('/api/common-games').send({ members: ['76561198000000001'] });
  assert.equal(miss1.status, 200, 'first miss should succeed within budget');
  const miss2 = await api.post('/api/wishlist').send({ members: ['76561198000000002'] });
  assert.equal(miss2.status, 200, 'second miss should succeed within budget');

  // A third uncached search, on either route, is over budget → 429.
  const over = await api.post('/api/common-games').send({ members: ['76561198000000003'] });
  assert.equal(over.status, 429, 'a cache miss past the budget should be rate limited');
  const refresh = await api.post('/api/wishlist?refresh=1').send({ members: [CACHED_WISHLIST] });
  assert.equal(refresh.status, 429, 'a forced refresh of a cached key past the budget should be rate limited');

  // The fully-cached accounts are still served even though the budget is exhausted, and make no
  // upstream call at all.
  const cachedCommon = await api.post('/api/common-games').send({ members: [CACHED_COMMON] });
  assert.equal(cachedCommon.status, 200, 'a fully-cached account (common-games) must bypass the limiter');
  const cachedWishlist = await api.post('/api/wishlist').send({ members: [CACHED_WISHLIST] });
  assert.equal(cachedWishlist.status, 200, 'a fully-cached account (wishlist) must bypass the limiter');
  assert.ok(!calledIds.has(CACHED_COMMON) && !calledIds.has(CACHED_WISHLIST), 'cache hits must not fetch upstream');
});

// Regression test for the bug reported live: reloading the Bundles page a handful of times (or
// re-opening the same deep-linked bundle) used to burn the whole per-minute budget on requests
// that never made an upstream call, since bundlesLimit's original skip() was just
// rateLimitBypassed() — every request counted, cache hit or not (unlike every other limiter in
// this file). GET /api/bundles/:id (bundlesByIdLimit) has no skip of its own — see its own
// comment in server.js — so it isn't covered here.
test('bundles list limiter: counts cache misses but never counts cache hits', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => [{ id: 1, title: 'Bundle' }] }));

  setCache('itad-bundles:US:-publish:false:100:20', [{ id: 99, title: 'Pre-cached Page' }]);

  // Two uncached pages consume the budget (max = 2).
  for (const offset of [0, 20]) {
    const res = await api.get(`/api/bundles?offset=${offset}`);
    assert.equal(res.status, 200, `miss offset=${offset} should succeed within budget`);
  }

  const over = await api.get('/api/bundles?offset=40');
  assert.equal(over.status, 429, 'a cache miss past the budget should be rate limited');
  const refresh = await api.get('/api/bundles?offset=100&refresh=1');
  assert.equal(refresh.status, 429, 'a forced refresh of a cached key past the budget should be rate limited');

  const cached = await api.get('/api/bundles?offset=100');
  assert.equal(cached.status, 200, 'a cache hit must bypass the limiter');
  assert.deepEqual(cached.body.bundles, [{ id: 99, title: 'Pre-cached Page' }]);

  for (const query of ['offset=20000', 'offset=20000&refresh=1']) {
    const pastCap = await api.get(`/api/bundles?${query}`);
    assert.equal(
      pastCap.status,
      200,
      `a page past the offset cap never calls ITAD, so must bypass the limiter (${query})`,
    );
    assert.deepEqual(pastCap.body.bundles, []);
  }
});

test('bundles resolve limiter: counts cache misses but never counts fully-cached gid batches', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (String(url).includes('/service/shops/')) return { ok: true, json: async () => [{ id: 61, title: 'Steam' }] };
    const gids = JSON.parse(opts.body);
    return { ok: true, json: async () => Object.fromEntries(gids.map((g) => [g, ['app/1']])) };
  });

  setCache('itad-appid:018d937f-0000-7000-8000-000000000000', 555);

  for (const gid of ['018d937f-0000-7000-8000-00000000000a', '018d937f-0000-7000-8000-00000000000b']) {
    const res = await api.post('/api/bundles/resolve').send({ gids: [gid] });
    assert.equal(res.status, 200, `miss "${gid}" should succeed within budget`);
  }

  const over = await api.post('/api/bundles/resolve').send({ gids: ['018d937f-0000-7000-8000-00000000000c'] });
  assert.equal(over.status, 429, 'a cache miss past the budget should be rate limited');

  const cached = await api.post('/api/bundles/resolve').send({ gids: ['018d937f-0000-7000-8000-000000000000'] });
  assert.equal(cached.status, 200, 'an all-cached gid batch must bypass the limiter');
  assert.deepEqual(cached.body.appids, { '018d937f-0000-7000-8000-000000000000': 555 });
});

// A limiter actually rejecting a request must be visible in GET /api/metrics's own
// limiterTrips field (lib/metrics.js's recordLimiterTrip) — not just returned as a 429 to the
// caller that hit it, with no server-side trail of how often that's happening overall.
test('a rejected request is recorded in GET /api/metrics limiterTrips', async (t) => {
  _reset();
  _resetMetrics();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ items: [{ id: 400, name: 'Portal' }] }),
  }));

  // gameSearchLimit's own window-based budget is shared process-wide across every test in this
  // file (not reset by _reset()/_resetMetrics() above, which only touch the app cache/metrics
  // counters) — so exactly how many of these are rejected depends on what earlier tests in this
  // file already consumed. Firing several distinct-term requests and counting the rejections
  // ourselves, rather than assuming "first N succeed", keeps this robust to that shared state.
  let rejected = 0;
  for (let i = 0; i < 5; i++) {
    const res = await api.get(`/api/search-games?q=metrics-trip-term-${i}`);
    if (res.status === 429) rejected++;
  }
  assert.ok(rejected >= 1, 'expected at least one rejection to exercise the metrics path');

  const metrics = await api.get('/api/metrics');
  assert.equal(metrics.body.sinceRestart.limiterTrips.gameSearch, rejected);
  assert.equal(metrics.body.lastHour.limiterTrips.gameSearch, rejected);
});
