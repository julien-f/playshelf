'use strict';

// "Misses count, hits don't" for the limiters server-ratelimit.test.js doesn't cover. Its own
// file so every limiter starts with a full budget: limiter counts persist per process, and that
// file's search test already spends searchLimit's.
process.env.STEAM_API_KEY = 'test-key';
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_ENABLED = 'true';
process.env.SEARCH_RATE_LIMIT_MAX = '2';
process.env.FRIENDS_RATE_LIMIT_MAX = '2';
process.env.DETAILS_RATE_LIMIT_MAX = '2';
process.env.ACHIEVEMENTS_RATE_LIMIT_MAX = '2';
process.env.BUNDLES_RATE_LIMIT_MAX = '2';
process.env.GAME_SEARCH_RATE_LIMIT_MAX = '2';
process.env.ITAD_API_KEY = 'test-itad-key';
process.env.TWITCH_CLIENT_ID = 'test-client';
process.env.TWITCH_CLIENT_SECRET = 'test-secret';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { app } = require('../server');
const { _reset, setCache } = require('../lib/cache');

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
    if (url.includes('GetSchemaForGame'))
      return json({ game: { availableGameStats: { achievements: [{ name: 'A', displayName: 'A' }] } } });
    if (url.includes('GetGlobalAchievementPercentages')) return json({ achievementpercentages: { achievements: [] } });
    if (url.includes('GetPlayerAchievements')) return json({ playerstats: { success: true, achievements: [] } });
    if (url.includes('/service/shops/')) return json([{ id: 61, title: 'Steam' }]);
    if (url.includes('/lookup/id/shop/'))
      return json(Object.fromEntries(JSON.parse(opts.body).map((key) => [key, `gid-${key.slice(4)}`])));
    if (url.includes('/games/prices/')) return json([]);
    if (url.includes('/games/bundles/')) return json([]);
    if (url.includes('oauth2/token')) return json({ access_token: 'tok', expires_in: 5_000_000 });
    if (url.includes('api.igdb.com')) return json([{ id: 1, name: 'Some Game' }]);
    if (url.includes('storesearch')) return json({ items: [] });
    if (url.includes('search/site/init')) return json({ token: 't', hpKey: 'k', hpVal: 'v' });
    if (url.includes('howlongtobeat.com/api/search/site')) return json({ data: [] });
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return calls;
}

// Each miss succeeds within budget, `over` is then rate limited, and each hit is still served
// without any upstream call.
async function assertMissesCountHitsDont(calls, { misses, over, hits }) {
  for (const [label, send] of Object.entries(misses)) {
    const res = await send();
    assert.equal(res.status, 200, `miss "${label}" should succeed within budget`);
  }
  const rejected = await over();
  assert.equal(rejected.status, 429, 'a cache miss past the budget should be rate limited');
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

  const commonGames = (members) => () => api.post('/api/common-games').send({ members });
  await assertMissesCountHitsDont(calls, {
    misses: {
      'uncached Steam64': commonGames(['76561198000000001']),
      'unresolved vanity': commonGames(['newvanity']),
    },
    over: commonGames(['76561198000000002']),
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

  const friends = (members) => () => api.post('/api/friends').send({ members });
  await assertMissesCountHitsDont(calls, {
    misses: {
      'uncached Steam64': friends(['76561198000000001']),
      'unresolved vanity': friends(['newvanity']),
    },
    over: friends(['76561198000000002']),
    hits: {
      'cached Steam64': friends([CACHED]),
      'cached vanity': friends(['cachedvanity']),
    },
  });
});

test('igdbGame limiter: counts a miss of either source and a refresh, never a cache hit', async (t) => {
  _reset();
  const calls = mockUpstreams(t);
  setCache('igdb:410', { id: 410, name: 'Cached' });
  setCache('hltb:igdb:410', []);
  setCache('igdb:411', { id: 411, name: 'No HLTB yet' });

  const igdbGame = (id) => () => api.get(`/api/igdb-game/${id}`);
  await assertMissesCountHitsDont(calls, {
    misses: { 400: igdbGame(400), 'cached game, uncached HLTB': igdbGame(411) },
    over: igdbGame(402),
    hits: { 410: igdbGame(410) },
  });
  assert.equal((await api.get('/api/igdb-game/410?refresh=1')).status, 429);
});

test('gameSearch limiter: a term counts until both Steam and IGDB have it cached', async (t) => {
  _reset();
  const calls = mockUpstreams(t);
  setCache('search:steam only', []);
  setCache('search:both', []);
  setCache('igdb-search:both', []);

  const search = (q) => () => api.get(`/api/search-games?q=${encodeURIComponent(q)}`);
  await assertMissesCountHitsDont(calls, {
    misses: { uncached: search('uncached'), 'cached by Steam only': search('steam only') },
    over: search('another'),
    hits: { both: search('both') },
  });
});

test('news limiter: counts cache misses but never counts cache hits', async (t) => {
  _reset();
  const calls = mockUpstreams(t);
  setCache('news:410', []);

  const news = (appid) => () => api.get(`/api/game-news/${appid}`);
  await assertMissesCountHitsDont(calls, {
    misses: { 400: news(400), 401: news(401) },
    over: news(402),
    hits: { 410: news(410) },
  });
});

test('achievements limiter: counts cache misses but never counts cache hits', async (t) => {
  _reset();
  const calls = mockUpstreams(t);
  const PLAYER = '76561198000000099';
  // Not part of the skip: a cached positive count just keeps the route off the store API.
  for (const appid of [500, 501, 502, 510]) setCache(`meta:${appid}`, { name: 'Game', achievementCount: 1 });
  setCache('schema:510', [{ apiname: 'A', name: 'A', hidden: false }]);
  setCache('achrarity:510', { A: 50 });
  setCache(`playerach:${PLAYER}:510`, []);
  setCache('achrarity:500', { A: 50 });
  setCache(`playerach:${PLAYER}:500`, []);
  setCache('resolve:cachedvanity', PLAYER);

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
    hits: {
      'schema, rarity and player cached': achievements(510, PLAYER),
      'cached vanity': achievements(510, 'cachedvanity'),
      'no steamids': achievements(510),
    },
  });
});

test('prices limiter: counts cache misses but never counts cache hits, for gids and appids', async (t) => {
  _reset();
  const calls = mockUpstreams(t);
  setCache('itad-shop:steam', 61);
  setCache('itad-price:US:cached-gid', { id: 'cached-gid', historyLow: {}, deals: [] });
  setCache('itad-gid:600', 'cached-gid');
  setCache('itad-gid:601', null); // not on ITAD: nothing left to price
  setCache('itad-gid:602', 'unpriced-gid');

  const prices = (body) => () => api.post('/api/prices').send(body);
  await assertMissesCountHitsDont(calls, {
    misses: {
      'uncached gid': prices({ gids: ['new-gid'] }),
      'unresolved appid': prices({ appids: [650] }),
    },
    over: prices({ appids: [602] }),
    hits: {
      'cached gid': prices({ gids: ['cached-gid'] }),
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

  const gameBundles = (appid) => () => api.get(`/api/game-bundles/${appid}`);
  await assertMissesCountHitsDont(calls, {
    misses: { 'unresolved appid': gameBundles(700), 'uncached bundles': gameBundles(701) },
    over: gameBundles(702),
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
  setCache('gamepass:pc:FR', [{ id: 'A', gid: 'g1' }]);

  const gamePass = (query) => () => api.get(`/api/game-pass?${query}`);
  await assertMissesCountHitsDont(calls, {
    misses: { 'uncached market': gamePass('country=US'), 'another market': gamePass('country=DE') },
    over: gamePass('country=JP'),
    hits: { 'cached market': gamePass('country=fr') },
  });
});
