'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createPanelDataCache,
  achievementsAccountKey,
  achievementsRequestUrl,
  achievementsSteamUrl,
  PANEL_SETTLE_MS,
} = require('../public/panelData.ts');
const { CLIENT_CACHE_MAX_AGE_MS } = require('../public/accountData.ts');

const meta = (id) => ({ name: `DLC ${id}`, capsule: `c${id}.jpg`, releaseDate: '1 Jan, 2020', comingSoon: false });

test('fetchDlc: store metadata only, at most 4 requests at once, each DLC fetched once', async (t) => {
  const urls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(url);
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    const id = Number(url.split('/').pop());
    return { ok: true, json: async () => ({ meta: meta(id) }) };
  });
  const { fetchDlc } = createPanelDataCache();

  const ids = Array.from({ length: 10 }, (_, i) => 100 + i);
  const first = await fetchDlc(ids.slice(0, 6));
  assert.deepEqual(
    first.map((d) => d.name),
    ids.slice(0, 6).map((id) => `DLC ${id}`),
  );
  assert.ok(urls.every((u) => u.startsWith('/api/game-meta/')));
  assert.ok(maxInFlight <= 4, `${maxInFlight} in flight`);

  const more = await fetchDlc(ids); // "Show more": the first 6 are already known
  assert.equal(more.length, 10);
  assert.equal(urls.length, 10);
});

test('fetchDlc: a DLC that fails to load is left out', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) =>
    url.endsWith('/201')
      ? { ok: false, json: async () => ({ error: 'x' }) }
      : { ok: true, json: async () => ({ meta: meta(200) }) },
  );
  const { fetchDlc } = createPanelDataCache();
  assert.deepEqual(
    (await fetchDlc([200, 201])).map((d) => d.appid),
    [200],
  );
});

// Answers the panel's routes from `data`, or fails every one but /api/health while `state.down`.
function mockPanelRoutes(t, data, { itadConfigured = true } = {}) {
  const state = { down: false, limited: false, urls: [] };
  t.mock.method(globalThis, 'fetch', async (url) => {
    state.urls.push(url);
    const json = (body, ok = true) => ({ ok, status: ok ? 200 : 502, json: async () => body });
    if (url === '/api/health') return json({ itadConfigured });
    if (state.down) return json({ error: 'upstream down' }, false);
    if (state.limited) return { ok: false, status: 429, json: async () => ({ error: LIMITED }) };
    if (url.startsWith('/api/game-news/')) return json({ news: data.news });
    if (url.startsWith('/api/achievements/')) return json(data.achievements);
    if (url.startsWith('/api/prices')) return json({ prices: { 620: data.price } });
    if (url.startsWith('/api/game-bundles/')) return json({ bundles: data.bundles });
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return state;
}

const LIMITED = 'Too many new lookups from your network this hour.';

const DATA = {
  news: [{ title: 'Patch' }],
  achievements: { achievements: [{ name: 'A' }], total: 1, unlocked: 0, private: false, playerCount: 1 },
  price: { steamRegular: { amount: 10, currency: 'EUR' } },
  bundles: [{ title: 'Bundle' }],
};

test('a failed forced refresh keeps what each source last loaded', async (t) => {
  const state = mockPanelRoutes(t, DATA);
  const cache = createPanelDataCache();
  const members = ['76561198000000001'];
  const loadAll = (opts) =>
    Promise.all([
      cache.fetchNews(620, opts),
      cache.fetchAchievements(620, members, opts),
      cache.fetchPrice(620, 'FR', opts),
      cache.fetchBundles(620, 'FR', opts),
    ]);

  const [news, achievements, price, bundles] = await loadAll();
  assert.deepEqual(news, DATA.news);
  assert.equal(achievements.total, 1);
  assert.equal(price.steamRegular, 10);
  assert.deepEqual(bundles, DATA.bundles);

  state.down = true;
  assert.deepEqual(await loadAll({ refresh: true }), [news, achievements, price, bundles]);
  // An unforced call answers from the cache synchronously, not with a promise.
  assert.equal(cache.fetchAchievements(620, members), achievements);
  assert.equal(cache.fetchPrice(620, 'FR'), price);
});

test('an entry past the max age reads as missing: refetched, and not a fallback', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const state = mockPanelRoutes(t, DATA);
  const cache = createPanelDataCache();
  await cache.fetchPrice(620, 'FR');
  t.mock.timers.tick(CLIENT_CACHE_MAX_AGE_MS - 1);
  assert.equal(cache.fetchPrice(620, 'FR') instanceof Promise, false, 'still fresh');
  t.mock.timers.tick(1);
  const asked = state.urls.length;
  state.down = true;
  const stale = cache.fetchPrice(620, 'FR');
  assert.ok(stale instanceof Promise, 'refetched');
  assert.equal(await stale, null, "yesterday's price isn't shown as a fallback");
  assert.equal(state.urls.length, asked + 1);
});

test('price and bundles are cached per region, and asked in it', async (t) => {
  const state = mockPanelRoutes(t, DATA);
  const cache = createPanelDataCache();
  await Promise.all([cache.fetchPrice(620, 'FR'), cache.fetchBundles(620, 'FR')]);
  await Promise.all([cache.fetchPrice(620, 'US'), cache.fetchBundles(620, 'US')]);
  await Promise.all([cache.fetchPrice(620, 'FR'), cache.fetchBundles(620, 'FR')]);
  assert.deepEqual(
    state.urls.filter((url) => url !== '/api/health'),
    [
      '/api/prices?country=FR',
      '/api/game-bundles/620?country=FR',
      '/api/prices?country=US',
      '/api/game-bundles/620?country=US',
    ],
  );
});

test("a source that fails before loading anything reads as null (didn't answer)", async (t) => {
  const state = mockPanelRoutes(t, DATA);
  state.down = true;
  const cache = createPanelDataCache();
  assert.deepEqual(
    await Promise.all([
      cache.fetchNews(620),
      cache.fetchAchievements(620, []),
      cache.fetchPrice(620, 'FR'),
      cache.fetchBundles(620, 'FR'),
    ]),
    [null, null, null, null],
  );
});

test("a lookup refused past this client's share keeps the server's message until one succeeds", async (t) => {
  const state = mockPanelRoutes(t, DATA);
  const cache = createPanelDataCache();
  const members = ['76561198000000001'];
  state.down = true;
  await Promise.all([cache.fetchAchievements(620, members), cache.fetchPrice(620, 'FR')]);
  assert.equal(cache.achievementsRefusal(620, members), undefined, 'a plain failure is no refusal');
  state.down = false;
  state.limited = true;
  const force = { refresh: true };
  assert.deepEqual(
    await Promise.all([cache.fetchAchievements(620, members, force), cache.fetchPrice(620, 'FR', force)]),
    [null, null],
  );
  assert.equal(cache.achievementsRefusal(620, members), LIMITED);
  assert.equal(cache.priceRefusal(620, 'FR'), LIMITED);
  assert.equal(cache.priceRefusal(620, 'US'), undefined);
  state.limited = false;
  await Promise.all([cache.fetchAchievements(620, members, force), cache.fetchPrice(620, 'FR', force)]);
  assert.equal(cache.achievementsRefusal(620, members), undefined);
  assert.equal(cache.priceRefusal(620, 'FR'), undefined);
});

test('a refused bundles lookup keeps the server message', async (t) => {
  const state = mockPanelRoutes(t, DATA);
  state.limited = true;
  const cache = createPanelDataCache();
  assert.equal(await cache.fetchBundles(620, 'FR'), null);
  assert.equal(cache.bundlesRefusal(620, 'FR'), LIMITED);
  state.limited = false;
  await cache.fetchBundles(620, 'FR'); // a refusal isn't cached: the next open asks again
  assert.equal(cache.bundlesRefusal(620, 'FR'), undefined);
  assert.deepEqual(cache.fetchBundles(620, 'FR'), DATA.bundles);
});

// With mocked timers a paused load never settles: this fails rather than hanging the test.
const unpaused = (p) => Promise.race([p, new Promise((_, reject) => setImmediate(() => reject(new Error('paused'))))]);

test('settled: an answer known without a request skips the pause', async (t) => {
  const state = mockPanelRoutes(t, DATA, { itadConfigured: false });
  const cache = createPanelDataCache();
  await cache.isItadConfigured();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const settled = () => true;
  assert.equal(await unpaused(cache.fetchBundles(620, 'FR', { settled })), null);
  assert.equal(await unpaused(cache.fetchPrice(620, 'FR', { settled })), null);
  assert.equal((await unpaused(cache.fetchAchievements(620, [], { settled, achievementCount: 0 }))).total, 0);
  assert.deepEqual(state.urls, ['/api/health']);
});

test('settled: a game left and come back to within the pause is fetched once', async (t) => {
  const state = mockPanelRoutes(t, DATA);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cache = createPanelDataCache();
  let open = null;
  const members = ['76561198000000001'];
  const loadAll = (appid) => {
    open = appid;
    const settled = () => open === appid;
    return Promise.all([
      cache.fetchNews(appid, { settled }),
      cache.fetchAchievements(appid, members, { settled }),
      cache.fetchPrice(appid, 'FR', { settled }),
      cache.fetchBundles(appid, 'FR', { settled }),
    ]);
  };
  const passed = [];
  for (const appid of [1, 2, 1]) {
    passed.push(loadAll(appid));
    t.mock.timers.tick(50);
    await new Promise(setImmediate);
  }
  t.mock.timers.tick(PANEL_SETTLE_MS);
  await Promise.all(passed);
  assert.deepEqual(
    state.urls.filter((url) => url !== '/api/health'),
    [
      '/api/game-news/1',
      '/api/achievements/1?steamids=76561198000000001',
      '/api/prices?country=FR',
      '/api/game-bundles/1?country=FR',
    ],
  );
});

test('settled: a call with no pause answers without waiting on a paused one for its key', async (t) => {
  mockPanelRoutes(t, DATA);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cache = createPanelDataCache();
  cache.fetchNews(620, { settled: () => false });
  assert.deepEqual(await unpaused(cache.fetchNews(620)), DATA.news);
});

test('settled: a ↻ during the pause wins over the paused load', async (t) => {
  const answers = new Map(); // url → its response, sent when the test says
  t.mock.method(
    globalThis,
    'fetch',
    (url) =>
      new Promise((resolve) =>
        answers.set(url, () =>
          resolve({
            ok: true,
            status: 200,
            json: async () => ({ news: [url.includes('refresh=1') ? 'fresh' : 'stale'] }),
          }),
        ),
      ),
  );
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cache = createPanelDataCache();
  const paused = cache.fetchNews(620, { settled: () => true });
  const forced = cache.fetchNews(620, { refresh: true });
  t.mock.timers.tick(PANEL_SETTLE_MS);
  await new Promise(setImmediate);
  // The forced answer first, then any the paused load sent.
  for (const answer of answers.values()) {
    answer();
    await new Promise(setImmediate);
  }
  assert.deepEqual(await forced, ['fresh']);
  assert.deepEqual(await paused, ['fresh']);
  assert.deepEqual(cache.fetchNews(620), ['fresh']);
  assert.deepEqual([...answers.keys()], ['/api/game-news/620?refresh=1']);
});

test('settled: only the game still open after the pause is fetched; a cached one answers at once', async (t) => {
  const state = mockPanelRoutes(t, DATA);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cache = createPanelDataCache();
  let open = null;
  const members = ['76561198000000001'];
  const loadAll = (appid) => {
    const settled = () => open === appid;
    return Promise.all([
      cache.fetchNews(appid, { settled }),
      cache.fetchAchievements(appid, members, { settled }),
      cache.fetchPrice(appid, 'FR', { settled }),
      cache.fetchBundles(appid, 'FR', { settled }),
    ]);
  };
  const passed = [];
  for (let appid = 1; appid <= 10; appid++) {
    open = appid;
    passed.push(loadAll(appid));
    t.mock.timers.tick(50);
    await new Promise(setImmediate);
  }
  t.mock.timers.tick(PANEL_SETTLE_MS);
  await Promise.all(passed);
  const requests = () => state.urls.filter((url) => url !== '/api/health');
  assert.deepEqual(requests(), [
    '/api/game-news/10',
    '/api/achievements/10?steamids=76561198000000001',
    '/api/prices?country=FR',
    '/api/game-bundles/10?country=FR',
  ]);

  open = 10;
  assert.notEqual(cache.fetchNews(10, { settled: () => true }) instanceof Promise, true, 'answered synchronously');
  assert.equal(requests().length, 4);
});

test('fetchAchievements: achievementCount 0 answers "no achievements" without a request', async (t) => {
  const state = mockPanelRoutes(t, DATA);
  const { fetchAchievements } = createPanelDataCache();
  const result = await fetchAchievements(620, ['a', 'b'], { achievementCount: 0 });
  assert.deepEqual(result, {
    achievements: [],
    total: 0,
    unlocked: 0,
    private: false,
    playerCount: 2,
    steamUrl: null,
  });
  assert.deepEqual(state.urls, []);
});

test('isItadOff: only once /api/health says ITAD is not configured', async (t) => {
  const state = mockPanelRoutes(t, DATA, { itadConfigured: false });
  const cache = createPanelDataCache();
  assert.equal(cache.isItadOff(), false, 'not asked yet');
  assert.equal(await cache.fetchPrice(620, 'FR'), null);
  assert.equal(await cache.fetchBundles(620, 'FR'), null);
  assert.equal(cache.isItadOff(), true);
  assert.deepEqual(state.urls, ['/api/health'], 'asked once, and no ITAD route called');
});

test('isItadOff: a failed /api/health is not "off", and is asked again next time', async (t) => {
  let healthCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === '/api/health') {
      healthCalls++;
      return { ok: false, status: 502, json: async () => ({}) };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  const cache = createPanelDataCache();
  assert.equal(await cache.fetchPrice(620, 'FR'), null);
  assert.equal(cache.isItadOff(), false);
  await cache.fetchPrice(620, 'FR', { refresh: true }); // unforced, the cached null answers
  assert.equal(healthCalls, 2);
});

test('achievementsAccountKey: sorts, so member order never yields two keys for one slot', () => {
  assert.equal(achievementsAccountKey(['2', '1']), achievementsAccountKey(['1', '2']));
  assert.equal(achievementsAccountKey(['1', '2']), '1,2');
});

test('achievementsAccountKey: no account is its own key, distinct from any real one', () => {
  assert.equal(achievementsAccountKey([]), '');
});

test('achievementsRequestUrl: sends steamids only when there is an account', () => {
  assert.equal(achievementsRequestUrl(440, ['1', '2']), '/api/achievements/440?steamids=1%2C2');
  assert.equal(achievementsRequestUrl(440, []), '/api/achievements/440');
});

test('achievementsRequestUrl: refresh adds refresh=1, with or without an account', () => {
  assert.equal(achievementsRequestUrl(440, ['1'], { refresh: true }), '/api/achievements/440?steamids=1&refresh=1');
  assert.equal(achievementsRequestUrl(440, [], { refresh: true }), '/api/achievements/440?refresh=1');
});

test('achievementsSteamUrl: links the first member of a Family; null with no account', () => {
  assert.equal(
    achievementsSteamUrl(440, ['76561198000000001', '76561198000000002']),
    'https://steamcommunity.com/profiles/76561198000000001/stats/440/achievements/',
  );
  assert.equal(achievementsSteamUrl(440, []), null);
});
