'use strict';

// "Misses count, hits don't" for the limiters server-ratelimit.test.js doesn't cover. Its own
// file so every limiter starts with a full budget: limiter counts persist per process, and that
// file's search test already spends searchLimit's.
process.env.STEAM_API_KEY = 'test-key';
process.env.NODE_ENV = 'test';
process.env.PUBLIC_ORIGIN = 'https://app.example';
process.env.RATE_LIMIT_ENABLED = 'true';
process.env.SEARCH_RATE_LIMIT_MAX = '2';
process.env.FRIENDS_RATE_LIMIT_MAX = '2';
process.env.DETAILS_RATE_LIMIT_MAX = '2';
process.env.ACHIEVEMENTS_RATE_LIMIT_MAX = '2';
process.env.BUNDLES_RATE_LIMIT_MAX = '2';
process.env.PREFS_RATE_LIMIT_MAX = '2';
process.env.ITAD_API_KEY = 'test-itad-key';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { app } = require('../server');
const { _reset, setCache } = require('../lib/cache');
const { ageCache } = require('./ageCache');
const { SESSION_COOKIE, createSession, upsertUser } = require('../lib/auth');

const api = supertest(app);

const RESOLVED_VANITY = '76561198000000500';

// Answers every upstream these routes call, recording each URL.
function mockUpstreams(t) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    url = String(url);
    calls.push(url);
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (url.includes('ResolveVanityURL')) return json({ response: { success: 1, steamid: RESOLVED_VANITY } });
    if (url.includes('GetPlayerSummaries')) return json({ response: { players: [] } });
    if (url.includes('GetOwnedGames')) return json({ response: { games: [] } });
    if (url.includes('GetFriendList')) return json({ friendslist: { friends: [] } });
    if (url.includes('GetNewsForApp')) return json({ appnews: { newsitems: [] } });
    if (url.includes('appdetails')) {
      const appid = url.match(/appids=(\d+)/)[1];
      return json({ [appid]: { success: true, data: { name: 'Game' } } });
    }
    if (url.includes('GetSchemaForGame'))
      return json({ game: { availableGameStats: { achievements: [{ name: 'A', displayName: 'A' }] } } });
    if (url.includes('GetGlobalAchievementPercentages')) return json({ achievementpercentages: { achievements: [] } });
    if (url.includes('GetPlayerAchievements')) return json({ playerstats: { success: true, achievements: [] } });
    if (url.includes('/service/shops/')) return json([{ id: 61, title: 'Steam' }]);
    if (url.includes('/lookup/id/shop/'))
      return json(Object.fromEntries(JSON.parse(opts.body).map((key) => [key, `gid-${key.slice(4)}`])));
    if (url.includes('/games/prices/')) return json([]);
    if (url.includes('/games/bundles/')) return json([]);
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return calls;
}

// Each miss succeeds within budget, `over` and `refresh` (a forced refresh of a cached key) are
// then rate limited, and each hit is still served without any upstream call.
async function assertMissesCountHitsDont(calls, { misses, over, refresh, hits }) {
  for (const [label, send] of Object.entries(misses)) {
    const res = await send();
    assert.equal(res.status, 200, `miss "${label}" should succeed within budget`);
  }
  const rejected = await over();
  assert.equal(rejected.status, 429, 'a cache miss past the budget should be rate limited');
  const refreshed = await refresh();
  assert.equal(refreshed.status, 429, 'a forced refresh of a cached key past the budget should be rate limited');
  for (const [label, send] of Object.entries(hits)) {
    const before = calls.length;
    const res = await send();
    assert.equal(res.status, 200, `hit "${label}" must bypass the limiter`);
    assert.deepEqual(calls.slice(before), [], `hit "${label}" must not fetch upstream`);
  }
}

test('search limiter: a cached vanity name skips it like a cached Steam64 id', async (t) => {
  _reset();
  const calls = mockUpstreams(t);
  const CACHED = '76561198000000099';
  setCache(`player:${CACHED}`, { steamid: CACHED, personaname: 'Cached', profileurl: '' });
  setCache(`games:${CACHED}`, []);
  setCache('resolve:cachedvanity', CACHED);

  const commonGames =
    (members, refresh = false) =>
    () =>
      api.post(`/api/common-games${refresh ? '?refresh=1' : ''}`).send({ members });
  await assertMissesCountHitsDont(calls, {
    misses: {
      'uncached Steam64': commonGames(['76561198000000001']),
      'unresolved vanity': commonGames(['newvanity']),
    },
    over: commonGames(['76561198000000002']),
    refresh: commonGames([CACHED], true),
    hits: {
      'cached Steam64': commonGames([CACHED]),
      'cached vanity': commonGames(['cachedvanity']),
    },
  });
});

test('friends limiter: counts cache misses but never counts cache hits', async (t) => {
  _reset();
  const calls = mockUpstreams(t);
  const CACHED = '76561198000000099';
  setCache(`friends:${CACHED}`, []);
  setCache('resolve:cachedvanity', CACHED);

  const friends =
    (members, refresh = false) =>
    () =>
      api.post(`/api/friends${refresh ? '?refresh=1' : ''}`).send({ members });
  await assertMissesCountHitsDont(calls, {
    misses: {
      'uncached Steam64': friends(['76561198000000001']),
      'unresolved vanity': friends(['newvanity']),
    },
    over: friends(['76561198000000002']),
    refresh: friends([CACHED], true),
    hits: {
      'cached Steam64': friends([CACHED]),
      'cached vanity': friends(['cachedvanity']),
    },
  });
});

test('news limiter: counts cache misses but never counts cache hits', async (t) => {
  _reset();
  const calls = mockUpstreams(t);
  setCache('news:410', []);
  ageCache();
  setCache('news:411', []);

  const news = (path) => () => api.get(`/api/game-news/${path}`);
  await assertMissesCountHitsDont(calls, {
    misses: { 400: news(400), 401: news(401) },
    over: news(402),
    refresh: news('410?refresh=1'),
    hits: { 410: news(410), 'forced, under FORCE_MIN_AGE_MINUTES old': news('411?refresh=1') },
  });
});

test('achievements limiter: counts cache misses but never counts cache hits', async (t) => {
  _reset();
  const calls = mockUpstreams(t);
  const PLAYER = '76561198000000099';
  // Not part of the skip: a cached positive count just keeps the route off the store API.
  for (const appid of [500, 501, 502, 510]) setCache(`appdetails:${appid}`, { name: 'Game', achievementCount: 1 });
  setCache('gameschema:510', { name: 'A', achievements: [{ apiname: 'A', name: 'A', hidden: false }] });
  setCache('achrarity:510', { A: 50 });
  setCache(`playerach:${PLAYER}:510`, []);
  setCache('achrarity:500', { A: 50 });
  setCache(`playerach:${PLAYER}:500`, []);
  setCache('resolve:cachedvanity', PLAYER);
  ageCache();
  setCache('gameschema:511', { name: 'A', achievements: [{ apiname: 'A', name: 'A', hidden: false }] });
  setCache('achrarity:511', { A: 50 });
  setCache('appdetails:511', { name: 'Game', achievementCount: 1 });

  const achievements =
    (appid, steamids = '') =>
    () =>
      api.get(`/api/achievements/${appid}?steamids=${steamids}`);
  await assertMissesCountHitsDont(calls, {
    misses: {
      'uncached schema': achievements(500, PLAYER),
      'cached schema, uncached player': achievements(510, '76561198000000001'),
    },
    over: achievements(502),
    refresh: achievements('510', `${PLAYER}&refresh=1`),
    hits: {
      'schema, rarity and player cached': achievements(510, PLAYER),
      'cached vanity': achievements(510, 'cachedvanity'),
      'no steamids': achievements(510),
      'forced, no steamids, under FORCE_MIN_AGE_MINUTES old': achievements('511', '&refresh=1'),
    },
  });
});

test('prices limiter: counts cache misses but never counts cache hits, for gids and appids', async (t) => {
  _reset();
  const calls = mockUpstreams(t);
  setCache('itad-shop:steam', 61);
  setCache('itad-price:US:018d937f-0000-7000-8000-000000000000', {
    id: '018d937f-0000-7000-8000-000000000000',
    historyLow: {},
    deals: [],
  });
  setCache('itad-gid:600', '018d937f-0000-7000-8000-000000000000');
  setCache('itad-gid:601', null); // not on ITAD: nothing left to price
  setCache('itad-gid:602', 'unpriced-gid');

  const prices =
    (body, query = '') =>
    () =>
      api.post(`/api/prices${query}`).send(body);
  await assertMissesCountHitsDont(calls, {
    misses: {
      'uncached gid': prices({ gids: ['018d937f-0000-7000-8000-000000000001'] }),
      'unresolved appid': prices({ appids: [650] }),
    },
    over: prices({ appids: [602] }),
    refresh: prices({ gids: ['018d937f-0000-7000-8000-000000000000'] }, '?refresh=1'),
    hits: {
      'cached gid': prices({ gids: ['018d937f-0000-7000-8000-000000000000'] }),
      'appids with cached price and null gid': prices({ appids: [600, 601] }),
    },
  });
});

test('game bundles limiter: counts cache misses but never counts cache hits', async (t) => {
  _reset();
  const calls = mockUpstreams(t);
  setCache('itad-shop:steam', 61);
  setCache('itad-gid:710', 'bundled-gid');
  setCache('itad-gamebundles:US:bundled-gid', []);
  setCache('itad-gid:711', null);
  setCache('itad-gid:701', 'unbundled-gid');

  const gameBundles = (path) => () => api.get(`/api/game-bundles/${path}`);
  await assertMissesCountHitsDont(calls, {
    misses: { 'unresolved appid': gameBundles(700), 'uncached bundles': gameBundles(701) },
    over: gameBundles(702),
    refresh: gameBundles('710?refresh=1'),
    hits: { 'cached bundles': gameBundles(710), 'null gid': gameBundles(711) },
  });
});

test('game pass limiter: counts cache misses but never counts cache hits', async (t) => {
  _reset();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('https://catalog.gamepass.com/')) return { ok: true, json: async () => [{ id: 'A' }] };
    return { ok: true, json: async () => ({ A: 'g1' }) };
  });
  setCache('itad-shop:microsoft store', 48);
  setCache('itad-appid:g1', 10);
  setCache('gamepass:pc:CA', [{ id: 'A', gid: 'g1' }]);
  setCache('itad-appid:g2', null);
  setCache('msstore-title:B', 'Not on Steam');
  setCache('msstore-title:C', 'Not on ITAD');
  setCache('gamepass:pc:GB', [
    { id: 'A', gid: 'g1' },
    { id: 'B', gid: 'g2' },
    { id: 'C', gid: undefined },
    { id: 'E', gid: 'g2' }, // another edition of B: the route never fetches its title
  ]);
  // The route still resolves uncached gids and fetches uncached titles behind a cached catalog.
  setCache('gamepass:pc:AU', [{ id: 'A', gid: 'g-unresolved' }]);
  setCache('gamepass:pc:MX', [{ id: 'D', gid: undefined }]);

  const gamePass = (query) => () => api.get(`/api/game-pass?${query}`);
  await assertMissesCountHitsDont(calls, {
    misses: { 'uncached market': gamePass('country=US'), 'another market': gamePass('country=DE') },
    over: gamePass('country=JP'),
    refresh: gamePass('country=ca&refresh=1'),
    hits: { 'cached market': gamePass('country=ca'), 'cached titles': gamePass('country=gb') },
  });
  assert.equal((await gamePass('country=au')()).status, 429, 'an unresolved gid behind a cached catalog counts');
  assert.equal((await gamePass('country=mx')()).status, 429, 'an uncached title behind a cached catalog counts');
});

test('meta limiter: counts cache misses but never counts cache hits', async (t) => {
  _reset();
  const calls = mockUpstreams(t);
  setCache('appdetails:810', { name: 'Cached' });

  const meta = (appid) => api.get(`/api/game-meta/${appid}`);
  assert.equal((await meta(800)).status, 200);
  assert.equal((await meta(801)).status, 200);
  assert.equal((await meta(802)).status, 429, 'a cache miss past the budget should be rate limited');
  const before = calls.length;
  assert.equal((await meta(810)).status, 200, 'a cached game must bypass the limiter');
  assert.deepEqual(calls.slice(before), [], 'a cached game must not fetch upstream');
});

// No skip on these two: every request counts, whatever the cache holds.
test('bundle-by-id limiter: counts every request, twice the bundles budget', async () => {
  const max = Number(process.env.BUNDLES_RATE_LIMIT_MAX) * 2;
  for (let i = 0; i < max; i++) assert.equal((await api.get('/api/bundles/abc')).status, 400);
  assert.equal((await api.get('/api/bundles/abc')).status, 429);
});

test('auth limiter: login and callback share one budget', async () => {
  for (let i = 0; i < 20; i++) assert.equal((await api.get('/auth/steam/login')).status, 302);
  assert.equal((await api.get('/auth/steam/callback')).status, 429);
});

// After the test above spent sign-in's budget: a first sign-in pushes every local key at once.
test('prefs limiter: counts every write, signed in or not, apart from sign-in', async () => {
  upsertUser('76561198000000601');
  const alice = `${SESSION_COOKIE}=${createSession('76561198000000601')}`;
  const put = (cookie) => api.put('/api/me/prefs/myAccount').set('Cookie', cookie).send({ value: null, updatedAt: 1 });

  assert.equal((await put(alice)).status, 200);
  assert.equal((await put(`${SESSION_COOKIE}=forged`)).status, 401);
  assert.equal((await put(alice)).status, 429, 'a write without a session counts too');
});
