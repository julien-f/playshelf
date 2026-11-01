'use strict';

// Force the in-memory DB regardless of how this file is invoked — see steam.test.js's own
// comment on why this must be set before requiring lib/cache.
process.env.DB_FILE = '';
process.env.ITAD_API_KEY = 'test-itad-key';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  getSteamShopId,
  getBundles,
  findBundleById,
  resolveSteamAppIds,
  resolveItadIds,
  priceCacheKey,
  getPrices,
  extractPriceInfo,
  getGameBundles,
  extractGameBundles,
} = require('../lib/itad');
const { _reset, isCached } = require('../lib/cache');

const SHOPS = [
  { id: 2, title: 'AllYouPlay' },
  { id: 61, title: 'Steam' },
  { id: 8, title: 'Fanatical' },
];

test('getSteamShopId: finds and caches the Steam entry', async (t) => {
  _reset();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return { ok: true, json: async () => SHOPS };
  });
  const id = await getSteamShopId();
  assert.equal(id, 61);
  await getSteamShopId();
  assert.equal(calls, 1, 'second call should hit the cache, not fetch again');
});

test('getSteamShopId: throws when no Steam entry is present', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => [{ id: 2, title: 'AllYouPlay' }] }));
  await assert.rejects(
    () => getSteamShopId(),
    (err) => err.isUpstream === true,
  );
});

// One page of the bundle list, as server.js's parseBundlesQuery builds it.
const PAGE = { country: 'US', offset: 0, limit: 20, sort: '-publish', expired: false };

test('getBundles: throws on upstream error', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 500 }));
  await assert.rejects(
    () => getBundles(PAGE),
    (err) => err.isUpstream === true,
  );
});

test('getBundles: returns and caches the bundle list', async (t) => {
  _reset();
  const bundles = [{ id: 1, title: 'Test Bundle' }];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return { ok: true, json: async () => bundles };
  });
  const result = await getBundles(PAGE);
  assert.deepEqual(result, bundles);
  await getBundles(PAGE);
  assert.equal(calls, 1, 'identical params should hit the cache');
  await getBundles({ ...PAGE, country: 'DE' });
  assert.equal(calls, 2, 'a different country is a different cache key');
});

test('getBundles: replaces a mistyped optional field and keeps the bundle, so the page keeps its length', async (t) => {
  _reset();
  const warn = t.mock.method(console, 'warn', () => {});
  const good = { id: 1, title: 'A', expiry: null, tiers: [{ games: [{ assets: { banner600: 'u' } }] }] };
  const bad = {
    id: 2,
    title: 'B',
    expiry: 5,
    page: { name: 7 },
    counts: 'x',
    tiers: [{ games: [{ assets: { banner600: 1 } }, 'x'] }, { games: 'x' }, null],
  };
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => [good, bad] }));
  const page = JSON.parse(JSON.stringify(await getBundles(PAGE)));
  assert.deepEqual(page, [
    good,
    { id: 2, title: 'B', expiry: null, page: {}, tiers: [{ games: [{ assets: {} }] }, { games: [] }] },
  ]);
  assert.match(warn.mock.calls[0].arguments[0], /^\[itad\] bundle 2: replaced mistyped expiry, page\.name, counts, /);
});

test('getBundles: a bundle without an id or title fails its page', async (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const bad of [{ id: 'x', title: 'D' }, { id: 4 }, null]) {
    _reset();
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => [{ id: 1, title: 'A' }, bad] }));
    await assert.rejects(
      () => getBundles(PAGE),
      (err) => err.isUpstream === true,
    );
  }
});

test('findBundleById: walks past a full page holding a mistyped bundle (C269)', async (t) => {
  _reset();
  t.mock.method(console, 'warn', () => {});
  const page1 = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, title: `Active ${i + 1}`, tiers: i ? [] : 'x' }));
  t.mock.method(globalThis, 'fetch', makeBundlesPager({ active: [...page1, { id: 999, title: 'Target' }] }));
  assert.equal((await findBundleById(999, { country: 'US' }))?.bundle?.title, 'Target');
});

// ITAD's `mature` is an *include* switch, not an "only mature" filter, and this app never hides a
// bundle from whoever's browsing — see getBundles' own comment for what the old `mature=false`
// default actually cost (measured live: 33 of 35 active bundles, one of them an ordinary Humble
// narrative-games bundle). Asserted on the outgoing request rather than the response, since the
// filtering happens upstream.
test('getBundles: always asks ITAD to include mature-flagged bundles', async (t) => {
  _reset();
  let requested = null;
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested = new URL(url);
    return { ok: true, json: async () => [] };
  });
  await getBundles(PAGE);
  assert.equal(requested.searchParams.get('mature'), 'true');
});

// Simulates paginated GET /bundles/v1 responses for findBundleById — `active`/`expired` are
// flat arrays of bundle objects; each fetch slices out one 50-item page based on offset.
function makeBundlesPager({ active = [], expired = [] } = {}) {
  return async (url) => {
    const u = new URL(url);
    const isExpired = u.searchParams.get('expired') === 'true';
    const offset = Number(u.searchParams.get('offset'));
    const limit = Number(u.searchParams.get('limit'));
    const source = isExpired ? expired : active;
    return { ok: true, json: async () => source.slice(offset, offset + limit) };
  };
}

test('findBundleById: finds a bundle on the first page of active bundles', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', makeBundlesPager({ active: [{ id: 42, title: 'Found Me' }] }));
  const result = await findBundleById(42, { country: 'US' });
  assert.equal(result?.bundle?.title, 'Found Me');
  // The page it was found on, so the route can date what it returns (getCachedAt).
  assert.equal(result?.cacheKey, 'itad-bundles:US:-publish:false:0:50');
});

test('findBundleById: pages through active bundles before falling back to expired ones', async (t) => {
  _reset();
  const page1 = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, title: `Active ${i + 1}` }));
  const target = { id: 999, title: 'Expired Target' };
  t.mock.method(globalThis, 'fetch', makeBundlesPager({ active: page1, expired: [...page1, target] }));
  const result = await findBundleById(999, { country: 'US' });
  assert.equal(result?.bundle?.title, 'Expired Target');
  assert.equal(result?.cacheKey, 'itad-bundles:US:-publish:true:50:50');
});

// The deep-link path inherits getBundles' mature handling — a link to a mature-flagged bundle has
// to resolve, not 404 (it used to, and the old comment defending that was circular: the app's own
// UI couldn't link to one only because the list was hiding them too).
test('findBundleById: includes mature-flagged bundles in its search', async (t) => {
  _reset();
  const requested = [];
  const pager = makeBundlesPager({ active: [{ id: 42, title: 'Found Me' }] });
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(new URL(url));
    return pager(url);
  });
  await findBundleById(42, { country: 'US' });
  assert.ok(requested.length > 0, 'expected at least one upstream page fetch');
  for (const u of requested) assert.equal(u.searchParams.get('mature'), 'true');
});

test('findBundleById: returns null when the id is never found within the search budget', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', makeBundlesPager({ active: [{ id: 1, title: 'Only Bundle' }] }));
  const result = await findBundleById(999999, { country: 'US' });
  assert.equal(result, null);
});

test('resolveSteamAppIds: resolves, caches, and treats a missing mapping as null', async (t) => {
  _reset();
  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    fetchCalls++;
    if (String(url).includes('/service/shops/')) return { ok: true, json: async () => SHOPS };
    // lookup/{shopId}/gid/v1
    const gids = JSON.parse(opts.body);
    const body = {};
    for (const gid of gids) body[gid] = gid === 'gid-known' ? ['app/292030', 'sub/1234'] : null;
    return { ok: true, json: async () => body };
  });

  const result = await resolveSteamAppIds(['gid-known', 'gid-missing']);
  assert.equal(result.get('gid-known'), 292030);
  assert.equal(result.get('gid-missing'), null);

  const callsBefore = fetchCalls;
  const again = await resolveSteamAppIds(['gid-known', 'gid-missing']);
  assert.equal(again.get('gid-known'), 292030);
  assert.equal(fetchCalls, callsBefore, 'both gids should now be cached individually');
});

test('resolveSteamAppIds: looks gids up in batches of at most 200', async (t) => {
  _reset();
  const sizes = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (String(url).includes('/service/shops/')) return { ok: true, json: async () => SHOPS };
    const gids = JSON.parse(opts.body);
    sizes.push(gids.length);
    return { ok: true, json: async () => Object.fromEntries(gids.map((g) => [g, ['app/1']])) };
  });
  const gids = Array.from({ length: 450 }, (_, i) => `gid-${i}`);
  const result = await resolveSteamAppIds(gids);
  assert.deepEqual(sizes, [200, 200, 50]);
  assert.equal(result.size, 450);
});

// Mocks ITAD with batch calls held in flight for one event-loop turn; counts them and the most at once.
function mockBatchConcurrency(t, reply, { fail = () => false } = {}) {
  const stats = { calls: 0, maxActive: 0 };
  let active = 0;
  Object.defineProperty(stats, 'active', { get: () => active }); // not enumerable: kept out of deepEqual
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (String(url).includes('/service/shops/')) return { ok: true, json: async () => SHOPS };
    const n = stats.calls++;
    stats.maxActive = Math.max(stats.maxActive, ++active);
    await new Promise(setImmediate);
    active--;
    if (fail(n)) return { ok: false, status: 500 };
    const sent = JSON.parse(opts.body);
    return { ok: true, json: async () => reply(sent) };
  });
  return stats;
}

const ids1000 = (prefix) => Array.from({ length: 1000 }, (_, i) => `${prefix}${i}`);

test('batch lookups send their 200-id chunks 3 at a time, the same number of calls', async (t) => {
  _reset();
  let stats = mockBatchConcurrency(t, (gids) => Object.fromEntries(gids.map((g) => [g, ['app/1']])));
  assert.equal((await resolveSteamAppIds(ids1000('gid-'))).size, 1000);
  assert.deepEqual(stats, { calls: 5, maxActive: 3 }, 'resolveSteamAppIds');

  stats = mockBatchConcurrency(t, (keys) => Object.fromEntries(keys.map((k) => [k, `gid-${k}`])));
  const appids = Array.from({ length: 1000 }, (_, i) => i + 1);
  assert.equal((await resolveItadIds(appids)).get(1000), 'gid-app/1000');
  assert.deepEqual(stats, { calls: 5, maxActive: 3 }, 'resolveItadIds');

  stats = mockBatchConcurrency(t, (gids) => gids.map((id) => ({ ...PRICE_ENTRY, id })));
  assert.equal((await getPrices(ids1000('p-'), { country: 'US' })).size, 1000);
  assert.deepEqual(stats, { calls: 5, maxActive: 3 }, 'getPrices');
});

test('batch lookups start no chunk after one fails', async (t) => {
  _reset();
  const stats = mockBatchConcurrency(t, (gids) => gids.map((id) => ({ ...PRICE_ENTRY, id })), {
    fail: (n) => n === 0,
  });
  await assert.rejects(
    () => getPrices(ids1000('p-'), { country: 'US' }),
    (err) => err.isUpstream === true,
  );
  assert.equal(stats.calls, 3, 'only the chunks already in flight');
  assert.equal(stats.active, 0, 'rejects once those have settled, so a retry cannot resend them');
});

test('resolveItadIds: a failed chunk keeps the chunks that succeeded', async (t) => {
  _reset();
  const reply = (keys) => Object.fromEntries(keys.map((k) => [k, `gid-${k}`]));
  const appids = Array.from({ length: 1000 }, (_, i) => i + 1);
  let stats = mockBatchConcurrency(t, reply, { fail: (n) => n === 3 });
  await assert.rejects(() => resolveItadIds(appids), { isUpstream: true });
  stats = mockBatchConcurrency(t, reply);
  assert.equal((await resolveItadIds(appids)).size, 1000);
  assert.equal(stats.calls, 1, 'only the failed chunk is sent again');
});

test('resolveSteamAppIds: a failed chunk keeps the chunks that succeeded', async (t) => {
  _reset();
  const reply = (gids) => Object.fromEntries(gids.map((g) => [g, ['app/1']]));
  let stats = mockBatchConcurrency(t, reply, { fail: (n) => n === 3 });
  await assert.rejects(() => resolveSteamAppIds(ids1000('gid-')), { isUpstream: true });
  stats = mockBatchConcurrency(t, reply);
  assert.equal((await resolveSteamAppIds(ids1000('gid-'))).size, 1000);
  assert.equal(stats.calls, 1, 'only the failed chunk is sent again');
});

test('getPrices and the id lookups: a reply of another shape is an upstream error', async (t) => {
  const cases = [
    ['getPrices', () => getPrices(['g'], { country: 'US' }), [null, { error: 'x' }]],
    ['resolveItadIds', () => resolveItadIds([1]), [null, []]],
    ['resolveSteamAppIds', () => resolveSteamAppIds(['g']), [null, []]],
  ];
  for (const [name, call, bodies] of cases) {
    for (const body of bodies) {
      _reset();
      t.mock.method(globalThis, 'fetch', async (url) => ({
        ok: true,
        json: async () => (String(url).includes('/service/shops/') ? SHOPS : body),
      }));
      await assert.rejects(call, { isUpstream: true }, `${name} ${JSON.stringify(body)}`);
    }
  }
});

// Mocks the three-domain fetch graph resolveSteamAppIds' fallbacks can reach: ITAD's shop
// lookup (`shopEntries`, keyed by gid), Steam's packagedetails/ajaxresolvebundles (`steam`,
// keyed by "sub/<id>"/"bundle/<id>"), and ITAD's games/info/v2 (`info`, keyed by gid) —
// `info`/`steam` entries are optional; a URL with no matching entry falls through to `{ ok:
// false, status: 404 }` rather than a shape mismatch throwing somewhere unexpected.
function makeResolveFetch({ shopEntries, steam = {}, info = {} }) {
  return async (url, opts) => {
    const u = String(url);
    if (u.includes('/service/shops/')) return { ok: true, json: async () => SHOPS };
    if (u.includes('/lookup/shop/')) {
      const gids = JSON.parse(opts.body);
      return { ok: true, json: async () => Object.fromEntries(gids.map((g) => [g, shopEntries[g] ?? null])) };
    }
    if (u.includes('/api/packagedetails')) {
      const id = new URL(u).searchParams.get('packageids');
      const key = `sub/${id}`;
      return key in steam ? { ok: true, json: async () => ({ [id]: steam[key] }) } : { ok: false, status: 404 };
    }
    if (u.includes('/actions/ajaxresolvebundles')) {
      const id = new URL(u).searchParams.get('bundleids');
      const key = `bundle/${id}`;
      return key in steam ? { ok: true, json: async () => steam[key] } : { ok: true, json: async () => [] };
    }
    if (u.includes('/games/info/')) {
      const gid = new URL(u).searchParams.get('id');
      return gid in info ? { ok: true, json: async () => info[gid] } : { ok: true, json: async () => ({}) };
    }
    return { ok: false, status: 404 };
  };
}

test('resolveSteamAppIds: a gid listed only as a Steam "sub" (single-item package) expands via Steam\'s own packagedetails', async (t) => {
  _reset();
  t.mock.method(
    globalThis,
    'fetch',
    makeResolveFetch({
      shopEntries: { 'gid-sub-only': ['sub/1234'] },
      steam: { 'sub/1234': { success: true, data: { apps: [{ id: 292030 }] } } },
    }),
  );
  const result = await resolveSteamAppIds(['gid-sub-only']);
  assert.equal(result.get('gid-sub-only'), 292030);
});

test('resolveSteamAppIds: a gid listed as a Steam "bundle" spanning several apps resolves to an array', async (t) => {
  _reset();
  t.mock.method(
    globalThis,
    'fetch',
    makeResolveFetch({
      shopEntries: { 'gid-bundle': ['bundle/4995'] },
      steam: { 'bundle/4995': [{ bundleid: 4995, appids: [396750, 688700, 709150] }] },
    }),
  );
  const result = await resolveSteamAppIds(['gid-bundle']);
  assert.deepEqual(result.get('gid-bundle'), [396750, 688700, 709150]);
});

test("resolveSteamAppIds: falls back to games/info/v2's own appid when the Steam-side sub/bundle expansion comes up empty", async (t) => {
  _reset();
  t.mock.method(
    globalThis,
    'fetch',
    makeResolveFetch({
      shopEntries: { 'gid-sub-only': ['sub/1234'] },
      steam: { 'sub/1234': { success: false } },
      info: { 'gid-sub-only': { appid: 292030 } },
    }),
  );
  const result = await resolveSteamAppIds(['gid-sub-only']);
  assert.equal(result.get('gid-sub-only'), 292030);
});

test('resolveSteamAppIds: the games/info/v2 fallback sends the gid encoded', async (t) => {
  _reset();
  const gid = 'gid&id=other';
  t.mock.method(
    globalThis,
    'fetch',
    makeResolveFetch({
      shopEntries: { [gid]: ['sub/1234'] },
      steam: { 'sub/1234': { success: false } },
      info: { [gid]: { appid: 292030 } },
    }),
  );
  const result = await resolveSteamAppIds([gid]);
  assert.equal(result.get(gid), 292030);
});

test('resolveSteamAppIds: still resolves to null when neither the Steam expansion nor the games/info/v2 fallback has an appid', async (t) => {
  _reset();
  t.mock.method(
    globalThis,
    'fetch',
    makeResolveFetch({
      shopEntries: { 'gid-sub-only': ['sub/1234'] },
      steam: { 'sub/1234': { success: false } },
      info: { 'gid-sub-only': { title: 'No Steam Listing' } },
    }),
  );
  const result = await resolveSteamAppIds(['gid-sub-only']);
  assert.equal(result.get('gid-sub-only'), null);
});

test('resolveSteamAppIds: runs at most 3 games/info/v2 fallbacks at once', async (t) => {
  _reset();
  const gids = Array.from({ length: 10 }, (_, i) => `gid-sub-${i}`);
  const base = makeResolveFetch({
    shopEntries: Object.fromEntries(gids.map((g, i) => [g, [`sub/${i}`]])),
    steam: Object.fromEntries(gids.map((_, i) => [`sub/${i}`, { success: false }])),
  });
  let inFlight = 0;
  let maxInFlight = 0;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (!String(url).includes('/games/info/')) return base(url, opts);
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight--;
    return base(url, opts);
  });
  await resolveSteamAppIds(gids);
  assert.ok(maxInFlight <= 3, `${maxInFlight} at once`);
});

test('resolveSteamAppIds: a games/info/v2 fallback that errored is left out, not cached as "not on Steam"', async (t) => {
  _reset();
  const base = makeResolveFetch({
    shopEntries: { 'gid-sub-only': ['sub/1234'] },
    steam: { 'sub/1234': { success: false } },
  });
  let infoCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (!String(url).includes('/games/info/')) return base(url, opts);
    infoCalls++;
    return { ok: false, status: 500 };
  });
  assert.equal((await resolveSteamAppIds(['gid-sub-only'])).has('gid-sub-only'), false);
  await resolveSteamAppIds(['gid-sub-only']);
  assert.equal(infoCalls, 2, 'retried on the next resolve');
});

test('resolveSteamAppIds: a failed Steam-side expansion falls back to games/info/v2 rather than throwing', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const u = String(url);
    if (u.includes('/api/packagedetails')) throw new Error('network error');
    return makeResolveFetch({
      shopEntries: { 'gid-sub-only': ['sub/1234'] },
      info: { 'gid-sub-only': { appid: 292030 } },
    })(url, opts);
  });
  const result = await resolveSteamAppIds(['gid-sub-only']);
  assert.equal(result.get('gid-sub-only'), 292030);
});

test('resolveSteamAppIds: a games/info/v2 fallback that throws leaves out only that gid', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (String(url).includes('/games/info/')) throw new Error('network error');
    return makeResolveFetch({
      shopEntries: { 'gid-app': ['app/100'], 'gid-sub-only': ['sub/1234'] },
      steam: { 'sub/1234': { success: false } },
    })(url, opts);
  });
  const result = await resolveSteamAppIds(['gid-app', 'gid-sub-only']);
  assert.equal(result.get('gid-app'), 100);
  assert.equal(result.has('gid-sub-only'), false);
});

test('resolveSteamAppIds: a gid with no shop entry at all never triggers the games/info/v2 fallback', async (t) => {
  _reset();
  let infoCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (String(url).includes('/games/info/')) infoCalls++;
    return makeResolveFetch({ shopEntries: { 'gid-missing': null } })(url, opts);
  });
  const result = await resolveSteamAppIds(['gid-missing']);
  assert.equal(result.get('gid-missing'), null);
  assert.equal(infoCalls, 0, 'a gid ITAD has no Steam shop entry for at all should not spend a games/info/v2 request');
});

test('resolveSteamAppIds: throws when the lookup call fails', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/service/shops/')) return { ok: true, json: async () => SHOPS };
    return { ok: false, status: 502 };
  });
  await assert.rejects(
    () => resolveSteamAppIds(['gid-x']),
    (err) => err.isUpstream === true,
  );
});

test('resolveItadIds: resolves, caches, and treats a missing mapping as null', async (t) => {
  _reset();
  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    fetchCalls++;
    if (String(url).includes('/service/shops/')) return { ok: true, json: async () => SHOPS };
    // lookup/id/shop/{shopId}/v1 — keyed by exactly what was sent ("app/<id>")
    const keys = JSON.parse(opts.body);
    const body = {};
    for (const key of keys) body[key] = key === 'app/400' ? 'gid-known' : null;
    return { ok: true, json: async () => body };
  });

  const result = await resolveItadIds([400, 500]);
  assert.equal(result.get(400), 'gid-known');
  assert.equal(result.get(500), null);

  const callsBefore = fetchCalls;
  const again = await resolveItadIds([400, 500]);
  assert.equal(again.get(400), 'gid-known');
  assert.equal(fetchCalls, callsBefore, 'both appids should now be cached individually');
});

test('resolveItadIds: throws when the lookup call fails', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/service/shops/')) return { ok: true, json: async () => SHOPS };
    return { ok: false, status: 502 };
  });
  await assert.rejects(
    () => resolveItadIds([400]),
    (err) => err.isUpstream === true,
  );
});

const PRICE_ENTRY = {
  id: 'gid-1',
  historyLow: {
    all: { amount: 0.99, amountInt: 99, currency: 'USD' },
    y1: { amount: 0.99, amountInt: 99, currency: 'USD' },
    m3: { amount: 9.99, amountInt: 999, currency: 'USD' },
  },
  deals: [
    {
      shop: { id: 61, name: 'Steam' },
      regular: { amount: 19.99, amountInt: 1999, currency: 'USD' },
      price: { amount: 19.99, amountInt: 1999, currency: 'USD' },
    },
    {
      shop: { id: 6, name: 'Fanatical' },
      regular: { amount: 14.99, amountInt: 1499, currency: 'USD' },
      price: { amount: 11.24, amountInt: 1124, currency: 'USD' },
      cut: 25,
      url: 'https://next.isthereanydeal.com/link/abc',
    },
  ],
};

test('getPrices: fetches, caches per (gid, country), and treats a missing gid as null', async (t) => {
  _reset();
  let priceCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/games/prices/v3')) {
      priceCalls++;
      return { ok: true, json: async () => [PRICE_ENTRY] };
    }
    return { ok: false, status: 500 };
  });
  const result = await getPrices(['gid-1', 'gid-missing'], { country: 'US' });
  assert.deepEqual(result.get('gid-1'), PRICE_ENTRY);
  assert.equal(result.get('gid-missing'), null);

  const callsBefore = priceCalls;
  await getPrices(['gid-1', 'gid-missing'], { country: 'US' });
  assert.equal(priceCalls, callsBefore, 'both should now be cached');

  await getPrices(['gid-1'], { country: 'DE' });
  assert.equal(priceCalls, callsBefore + 1, 'a different country is a different cache entry');
});

test('getPrices: force bypasses the cache read and re-fetches', async (t) => {
  _reset();
  let priceCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/games/prices/v3')) {
      priceCalls++;
      return { ok: true, json: async () => [PRICE_ENTRY] };
    }
    return { ok: false, status: 500 };
  });
  await getPrices(['gid-1'], { country: 'US' });
  assert.equal(priceCalls, 1);

  await getPrices(['gid-1'], { country: 'US' });
  assert.equal(priceCalls, 1, 'plain call should be a cache hit');

  const result = await getPrices(['gid-1'], { country: 'US', force: true });
  assert.equal(priceCalls, 2, 'force should re-fetch even though the entry is cached');
  assert.deepEqual(result.get('gid-1'), PRICE_ENTRY);
});

test('getPrices: skips a reply entry with no id, leaving its gid absent → null', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => [null, { historyLow: PRICE_ENTRY.historyLow }, { id: 7 }, PRICE_ENTRY],
  }));
  const result = await getPrices(['gid-1', 'gid-2'], { country: 'US' });
  assert.deepEqual(
    [...result],
    [
      ['gid-1', PRICE_ENTRY],
      ['gid-2', null],
    ],
  );
  assert.equal(isCached(priceCacheKey(undefined, 'US')), false);
  assert.equal(isCached(priceCacheKey(7, 'US')), false);
});

test('getPrices: throws on upstream error', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 500 }));
  await assert.rejects(
    () => getPrices(['gid-1'], { country: 'US' }),
    (err) => err.isUpstream === true,
  );
});

test("extractPriceInfo: pulls Steam's regular price and the three historical lows", () => {
  const info = extractPriceInfo(PRICE_ENTRY, 61);
  assert.deepEqual(info.steamRegular, { amount: 19.99, amountInt: 1999, currency: 'USD' });
  assert.deepEqual(info.lowAll, PRICE_ENTRY.historyLow.all);
  assert.deepEqual(info.lowY1, PRICE_ENTRY.historyLow.y1);
  assert.deepEqual(info.lowM3, PRICE_ENTRY.historyLow.m3);
});

test("extractPriceInfo: bestDeal picks the cheapest current price across every shop, Steam included, and carries that deal's own url", () => {
  const info = extractPriceInfo(PRICE_ENTRY, 61);
  assert.deepEqual(info.bestDeal, {
    price: { amount: 11.24, amountInt: 1124, currency: 'USD' },
    shop: 'Fanatical',
    url: 'https://next.isthereanydeal.com/link/abc',
  });
});

test('extractPriceInfo: bestDeal.url is null when the deal has no url', () => {
  const noUrl = {
    ...PRICE_ENTRY,
    deals: PRICE_ENTRY.deals.map((d) => {
      const { url, ...rest } = d;
      return rest;
    }),
  };
  assert.equal(extractPriceInfo(noUrl, 61).bestDeal.url, null);
});

test('extractPriceInfo: bestDeal is null when no deal has a price', () => {
  const noPrices = { ...PRICE_ENTRY, deals: PRICE_ENTRY.deals.map(({ price, ...d }) => d) };
  assert.equal(extractPriceInfo(noPrices, 61).bestDeal, null);
});

test('extractPriceInfo: all fields null for a missing entry or a shop with no Steam deal', () => {
  assert.deepEqual(extractPriceInfo(null, 61), {
    steamRegular: null,
    lowAll: null,
    lowY1: null,
    lowM3: null,
    bestDeal: null,
  });
  const noSteam = { ...PRICE_ENTRY, deals: [PRICE_ENTRY.deals[1]] };
  assert.equal(extractPriceInfo(noSteam, 61).steamRegular, null);
});

test('getBundles: { force: true } bypasses the cache and re-fetches', async (t) => {
  _reset();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return { ok: true, json: async () => [{ id: 1, title: 'B' }] };
  });
  await getBundles(PAGE);
  await getBundles(PAGE);
  assert.equal(calls, 1, 'second call served from cache');
  await getBundles({ ...PAGE, force: true });
  assert.equal(calls, 2, 'forced call re-fetches');
});

test('getGameBundles: fetches per (gid, country), caches, and honours force', async (t) => {
  _reset();
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    return { ok: true, json: async () => [{ id: 1, title: 'B' }] };
  });
  assert.deepEqual(await getGameBundles('g1', { country: 'FR' }), [{ id: 1, title: 'B' }]);
  await getGameBundles('g1', { country: 'FR' });
  assert.equal(urls.length, 1, 'second call served from cache');
  assert.match(urls[0], /\/games\/bundles\/v2\?.*id=g1.*country=FR/);
  await getGameBundles('g1', { country: 'FR', force: true });
  assert.equal(urls.length, 2, 'forced call re-fetches');
});

test('getGameBundles: throws on upstream error', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 500 }));
  await assert.rejects(
    () => getGameBundles('g1'),
    (err) => err.isUpstream === true,
  );
});

test('extractGameBundles: keeps the cheapest tier holding the game, null for a pick-and-mix tier', () => {
  const price = (amount) => ({ amount, amountInt: amount * 100, currency: 'USD' });
  const bundles = [
    {
      id: 1,
      title: 'Tiered',
      page: { name: 'Humble Bundle' },
      url: 'https://shop.example/1',
      expiry: '2026-10-24T05:59:43+02:00',
      tiers: [
        { price: price(1), games: [{ id: 'other' }] },
        { price: price(8), games: [{ id: 'g1' }] },
        { price: price(15), games: [{ id: 'g1' }] },
      ],
    },
    { id: 2, title: 'Pick', page: { name: 'Fanatical' }, tiers: [{ price: null, games: [{ id: 'g1' }] }] },
  ];
  assert.deepEqual(extractGameBundles(bundles, 'g1'), [
    {
      id: 1,
      title: 'Tiered',
      shop: 'Humble Bundle',
      url: 'https://shop.example/1',
      expiry: '2026-10-24T05:59:43+02:00',
      tierPrice: 8,
      tierCurrency: 'USD',
      tierPriceMax: null,
    },
    {
      id: 2,
      title: 'Pick',
      shop: 'Fanatical',
      url: null,
      expiry: null,
      tierPrice: null,
      tierCurrency: null,
      tierPriceMax: null,
    },
  ]);
});

test('extractGameBundles: priced tiers ITAD left empty make the last listed tier a price range', () => {
  const price = (amount) => ({ amount, amountInt: amount * 100, currency: 'EUR' });
  const bundle = (id) => ({
    id,
    title: 'Untiered',
    page: { name: 'Humble Bundle' },
    tiers: [
      { price: price(5), games: [{ id: 'g0' }] },
      { price: price(10), games: [{ id: 'g1' }] },
      { price: price(15), games: [] },
      { price: null, games: [] },
    ],
  });
  assert.equal(extractGameBundles([bundle(1)], 'g1')[0].tierPriceMax, 15);
  assert.equal(extractGameBundles([bundle(1)], 'g0')[0].tierPriceMax, null);
});
