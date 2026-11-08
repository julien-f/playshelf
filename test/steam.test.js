'use strict';

// Force the in-memory DB regardless of how this file is invoked — `npm test`
// already does this via a shell-level `DB_FILE=`, but running this file
// directly (e.g. `node --test test/steam.test.js`, an IDE test runner) would
// otherwise fall through to default.env's DB_FILE=db.sqlite and let _reset()
// wipe the real cache. Must be set before requiring lib/cache.
process.env.DB_FILE = '';

const { beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { ageCache } = require('./ageCache');
const { getMetrics } = require('../lib/metrics');
const {
  peekSteamId,
  resolveSteamId,
  getOwnedGames,
  getWishlist,
  getFriendList,
  getPlayerSummaries,
  getGameRating,
  getAppDetails,
  getStoreBrowseItem,
  resolveSteamTags,
  extractDemoAppid,
  resolveSteamPackageAppids,
  resolveSteamBundleAppids,
  searchStoreGames,
  gameBasics,
  searchCreatorGames,
  getProtonDbStatus,
  getGameSchema,
  getPlayerAchievements,
  getGlobalAchievementPercentages,
  getGameNews,
  _resetTagNameMap,
  _resetPauses,
} = require('../lib/steam');
const { getUpstreamStats, createSemaphore } = require('../lib/upstream');
const { _reset, getCachedAt, setCache } = require('../lib/cache');
const { getCircuitBreakers, _resetCircuitBreakers } = require('../lib/circuitBreaker');
const { db } = require('../lib/db');
const { MISS_CACHE_TTL_MS, META_CACHE_TTL_MS } = require('../lib/config');

// The tag-name map's failure hold-off outlives _reset(), which only empties the cache.
beforeEach(_resetTagNameMap);

function makeReviewResponse(total, positive, desc = 'Very Positive') {
  return {
    ok: true,
    json: async () => ({
      response: { query_summary: { total_reviews: total, total_positive: positive, review_score_desc: desc } },
    }),
  };
}

test('steam-store circuit breaker: blockedUntil is 0 when the circuit has never tripped', async (t) => {
  _reset();
  _resetCircuitBreakers();
  t.after(_resetCircuitBreakers);
  assert.equal(getCircuitBreakers()['steam-store'].blockedUntil, 0);
});

test('steam-store circuit breaker: trips (blockedUntil in the future) after 2 consecutive 403s, and blocks further calls without hitting fetch', async (t) => {
  _reset();
  _resetCircuitBreakers();
  t.after(_resetCircuitBreakers);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 403 }));

  await assert.rejects(
    () => getAppDetails(400),
    (err) => err.isUpstream === true,
  );
  await assert.rejects(
    () => getAppDetails(401),
    (err) => err.isUpstream === true,
  );
  assert.equal(fetchMock.mock.callCount(), 2);

  const { blockedUntil } = getCircuitBreakers()['steam-store'];
  assert.ok(blockedUntil > Date.now());

  // Circuit is now open — a third call must reject immediately (circuit-open message) without
  // calling fetch again at all.
  await assert.rejects(() => getAppDetails(402), /circuit open/);
  assert.equal(fetchMock.mock.callCount(), 2);
});

test('steam-store circuit breaker: requests already queued when it trips never reach Steam', async (t) => {
  _reset();
  _resetCircuitBreakers();
  t.after(_resetCircuitBreakers);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 403 }));

  // storeLimit runs 2 at a time; at most one more can start between the first 403 and the
  // second, which trips the breaker. The rest were queued and must fail without a request.
  const results = await Promise.allSettled([410, 411, 412, 413, 414, 415].map((appid) => getAppDetails(appid)));
  assert.ok(results.every((r) => r.status === 'rejected'));
  assert.ok(fetchMock.mock.callCount() <= 3, `${fetchMock.mock.callCount()} requests`);
});

test('fetchStoreApi: the circuit-open error is marked isLogged so callers can skip re-logging it', async (t) => {
  _reset();
  _resetCircuitBreakers();
  t.after(_resetCircuitBreakers);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 403 }));

  await assert.rejects(() => getAppDetails(420));
  await assert.rejects(() => getAppDetails(421)); // trips it
  await assert.rejects(
    () => getAppDetails(422),
    (err) => /circuit open/.test(err.message) && err.isLogged === true && err.isUpstream === true,
  );
});

test('steam-store circuit breaker: logs a [circuit-breaker] warning exactly once at the moment it trips, not on every blocked call after', async (t) => {
  _reset();
  _resetCircuitBreakers();
  t.after(_resetCircuitBreakers);
  const warnMock = t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 403 }));

  await assert.rejects(() => getAppDetails(430));
  assert.equal(warnMock.mock.callCount(), 0, 'a single 403 must not warn — it has not tripped anything yet');

  await assert.rejects(() => getAppDetails(431)); // the trip itself
  assert.equal(warnMock.mock.callCount(), 1);
  assert.match(warnMock.mock.calls[0].arguments[0], /\[circuit-breaker\]/);

  // Further calls while blocked are silent — they're an expected consequence of the trip
  // already logged above, not new information.
  await assert.rejects(() => getAppDetails(432));
  await assert.rejects(() => getAppDetails(433));
  assert.equal(warnMock.mock.callCount(), 1);
});

test('steam-store circuit breaker: tripCount increments on trip and stays 0 until then', async (t) => {
  _reset();
  _resetCircuitBreakers();
  t.after(_resetCircuitBreakers);
  assert.equal(getCircuitBreakers()['steam-store'].tripCount, 0);

  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 403 }));
  await assert.rejects(() => getAppDetails(400));
  assert.equal(getCircuitBreakers()['steam-store'].tripCount, 0, 'a single 403 must not trip it');
  await assert.rejects(() => getAppDetails(401));
  assert.equal(getCircuitBreakers()['steam-store'].tripCount, 1, 'two consecutive 403s trip it once');
});

test('fetchStoreApi: a 429 holds every queued store request until Retry-After has passed', async (t) => {
  _reset();
  _resetCircuitBreakers();
  t.after(_resetCircuitBreakers);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  };
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return calls === 1
      ? { ok: false, status: 429, headers: new Headers({ 'retry-after': '2' }) }
      : makeAppDetailsResponse(500);
  });

  const first = getAppDetails(500);
  await flush();
  const second = getAppDetails(501); // queued after Steam asked us to slow down
  await flush();
  assert.equal(calls, 1);

  t.mock.timers.tick(1999);
  await flush();
  assert.equal(calls, 1, 'nothing goes out before Retry-After');

  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls, 3, 'the retry and the queued request go out once it has passed');
  await Promise.all([first, second]);
});

test("a store details 429 doesn't pause the store's other calls", async (t) => {
  _reset();
  t.after(_resetPauses);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  };
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    if (String(url).includes('appdetails'))
      return { ok: false, status: 429, headers: new Headers({ 'retry-after': '60' }) };
    if (String(url).includes('storesearch')) return { ok: true, status: 200, json: async () => ({ items: [] }) };
    return { ok: true, status: 200, json: async () => ({ response: { store_items: [] } }) };
  });

  const details = getAppDetails(520).catch(() => {});
  await flush();
  const search = searchStoreGames('portal');
  await flush();
  assert.ok(
    urls.some((url) => url.includes('storesearch')),
    'the search goes out during the details pause',
  );
  await search;
  for (let retry = 0; retry < 3; retry++) {
    t.mock.timers.tick(60 * 1000);
    await flush();
  }
  await details;
});

// One pause per call group: the 429 shown is refused (no retry), the call queued after it waits out Retry-After.
for (const [group, refused, queued, ok] of [
  [
    'key-less Steam API',
    () => getWishlist('76561197960287930'),
    () => getGameNews(620),
    { ok: true, json: async () => ({ appnews: { newsitems: [] } }) },
  ],
  [
    'store browse',
    () => getStoreBrowseItem(620),
    () => getStoreBrowseItem(400),
    { ok: true, json: async () => ({ response: { store_items: [] } }) },
  ],
  ['ProtonDB', () => getProtonDbStatus(620), () => getProtonDbStatus(400), { ok: false, status: 404 }],
]) {
  test(`${group}: a 429 holds the group's next call until Retry-After has passed`, async (t) => {
    _reset();
    t.after(_resetPauses);
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    const flush = async () => {
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    };
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () =>
      ++calls === 1 ? { ok: false, status: 429, headers: new Headers({ 'retry-after': '2' }) } : ok,
    );

    await assert.rejects(refused, /429/);
    const second = queued();
    await flush();
    t.mock.timers.tick(1999);
    await flush();
    assert.equal(calls, 1, 'nothing goes out before Retry-After');

    t.mock.timers.tick(1);
    await flush();
    assert.equal(calls, 2, 'the queued call goes out once it has passed');
    await second;
  });
}

test('steam-store circuit breaker: consecutive403s exposes pre-trip state and resets on success', async (t) => {
  _reset();
  _resetCircuitBreakers();
  t.after(_resetCircuitBreakers);
  assert.equal(getCircuitBreakers()['steam-store'].consecutive403s, 0);

  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 403 }));
  await assert.rejects(() => getAppDetails(410));
  assert.equal(
    getCircuitBreakers()['steam-store'].consecutive403s,
    1,
    'a single 403 is visible before it trips anything',
  );

  t.mock.method(globalThis, 'fetch', async () => makeAppDetailsResponse(500));
  await getAppDetails(411);
  assert.equal(getCircuitBreakers()['steam-store'].consecutive403s, 0, 'a success resets the streak');
});

test('getUpstreamStats: reports each semaphore under its group, live active/queued and a lifetime queue-depth high-water mark', async (t) => {
  _reset();
  const releases = [];
  // tagLimit (concurrency 3, no minIntervalMs cooldown, unlike storeLimit's 500ms one — see
  // its own comment in lib/steam.js) backs getStoreBrowseItem, so contention here resolves
  // deterministically without a cross-test real-time release delay to account for.
  t.mock.method(
    globalThis,
    'fetch',
    () =>
      new Promise((resolve) => {
        releases.push(() =>
          resolve({ ok: true, json: async () => ({ response: { store_items: [{ success: 1, related_items: {} }] } }) }),
        );
      }),
  );

  const results = Promise.all([704, 705, 706, 707].map((appid) => getStoreBrowseItem(appid)));
  await new Promise((r) => setImmediate(r)); // let the first three fetches actually start

  const busy = getUpstreamStats()['steam-browse'].semaphores;
  assert.equal(busy.tag.active, 3);
  assert.equal(busy.tag.queued, 1);
  assert.ok(busy.tag.maxQueueSeen >= 1);

  // Drain whatever fetch calls show up until all four resolve — the 4th call's own fetch
  // doesn't start until a slot frees up, so this polls rather than releasing everything up front.
  let settled = false;
  results.then(() => {
    settled = true;
  });
  while (!settled) {
    while (releases.length) releases.shift()();
    await new Promise((r) => setImmediate(r));
  }

  // A high-water mark must not reset back down once the queue has drained.
  const stats = getUpstreamStats();
  assert.ok(stats['steam-browse'].semaphores.tag.maxQueueSeen >= 1);
  assert.equal(typeof stats['steam-store'].semaphores.store.active, 'number');
  assert.equal(typeof stats.protondb.semaphores.proton.queued, 'number');
  assert.equal(typeof stats['steam-reviews'].semaphores.reviews.rejected, 'number');
});

// createSemaphore's maxQueue safety valve is tested directly here (rather than by exhausting
// storeLimit/tagLimit/protonLimit's real, deliberately-generous 20000-deep queue — see
// SEMAPHORE_MAX_QUEUE's own comment in lib/upstream.js).
test('createSemaphore: rejected counts calls turned away once maxQueue is hit, active/queued unaffected', async (t) => {
  const warnMock = t.mock.method(console, 'warn', () => {});
  const sem = createSemaphore(1, 0, 'test-sem', { maxQueue: 1 }); // 1 concurrent slot, queue depth 1
  let releaseFirst;
  const p1 = sem(
    () =>
      new Promise((r) => {
        releaseFirst = r;
      }),
  ); // occupies the one active slot
  const p2 = sem(() => Promise.resolve('queued')); // fills the one queue slot
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(sem.getStats(), { active: 1, queued: 1, maxQueueSeen: 1, rejected: 0 });

  // A 3rd call is turned away outright — the queue is already full.
  await assert.rejects(() => sem(() => Promise.resolve('never runs')), /Too many queued/);
  assert.equal(sem.getStats().rejected, 1);
  assert.equal(sem.getStats().active, 1, 'a rejection must not touch active');
  assert.equal(sem.getStats().queued, 1, 'a rejection must not touch queued — it never entered the queue');
  assert.equal(warnMock.mock.callCount(), 1);
  assert.match(warnMock.mock.calls[0].arguments[0], /\[semaphore:test-sem\]/);

  releaseFirst('done');
  assert.equal(await p1, 'done');
  assert.equal(await p2, 'queued');
});

test('getGameRating: throws when fetch fails', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));
  await assert.rejects(
    () => getGameRating(400),
    (err) => err.isUpstream === true,
  );
});

test('getGameRating: returns null when there are no reviews', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => makeReviewResponse(0, 0));
  const result = await getGameRating(400);
  assert.equal(result, null);
});

test('getGameRating: asks GetAppReviews for every language and purchase type', async (t) => {
  _reset();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => makeReviewResponse(10, 9));
  await getGameRating(620);
  const url = new URL(fetchMock.mock.calls[0].arguments[0]);
  assert.equal(url.origin + url.pathname, 'https://api.steampowered.com/IUserReviewsService/GetAppReviews/v1/');
  assert.deepEqual(JSON.parse(url.searchParams.get('input_json')), {
    appid: 620,
    languages: ['all'],
    purchase_type: 1,
    num_per_page: 1,
  });
});

test('getGameRating: returns null for an empty response (unknown appid)', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ response: {} }) }));
  assert.equal(await getGameRating(999999999), null);
});

test("getGameRating: 403s don't trip the store's circuit breaker", async (t) => {
  _reset();
  _resetCircuitBreakers();
  t.after(_resetCircuitBreakers);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 403 }));
  await assert.rejects(() => getGameRating(400));
  await assert.rejects(() => getGameRating(401));
  assert.equal(getCircuitBreakers()['steam-store'].blockedUntil, 0);
});

test('getGameRating: returns correct shape', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => makeReviewResponse(1000, 900, 'Very Positive'));
  const result = await getGameRating(400);
  assert.equal(typeof result.score, 'number');
  assert.equal(result.desc, 'Very Positive');
  assert.equal(result.positive, 900);
  assert.equal(result.total, 1000);
});

test('getGameRating: Wilson score is lower than raw ratio', async (t) => {
  // Wilson score accounts for uncertainty, so it's always below pos/total
  _reset();
  t.mock.method(globalThis, 'fetch', async () => makeReviewResponse(1000, 900, 'Very Positive'));
  const result = await getGameRating(400);
  const rawRatio = Math.round((900 / 1000) * 100); // 90
  assert.ok(result.score < rawRatio, `expected Wilson score ${result.score} < raw ratio ${rawRatio}`);
});

test('getGameRating: score is within valid range', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => makeReviewResponse(1000, 900, 'Very Positive'));
  const result = await getGameRating(400);
  assert.ok(result.score >= 0 && result.score <= 100, `score out of range: ${result.score}`);
});

test('getGameRating: higher positive ratio yields higher score', async (t) => {
  _reset();
  let callCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    callCount++;
    return callCount === 1
      ? makeReviewResponse(1000, 600) // 60% positive
      : makeReviewResponse(1000, 900); // 90% positive
  });

  const low = await getGameRating(1);
  const high = await getGameRating(2);
  assert.ok(high.score > low.score, `expected ${high.score} > ${low.score}`);
});

test('getGameRating: more reviews tightens the confidence interval', async (t) => {
  // Same 80% ratio but 10 vs 10000 reviews — larger sample → score closer to raw ratio
  _reset();
  let callCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    callCount++;
    return callCount === 1
      ? makeReviewResponse(10, 8) // 80% with few reviews
      : makeReviewResponse(10000, 8000); // 80% with many reviews
  });

  const fewReviews = await getGameRating(1);
  const manyReviews = await getGameRating(2);
  assert.ok(
    manyReviews.score > fewReviews.score,
    `expected larger sample score ${manyReviews.score} > small sample score ${fewReviews.score}`,
  );
});

// ── resolveSteamId ────────────────────────────────────────────────────────────

test('resolveSteamId: returns Steam64 ID directly without fetching', async (t) => {
  _reset();
  let fetchCalled = false;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCalled = true;
  });

  const result = await resolveSteamId('76561198000000001');
  assert.equal(result, '76561198000000001');
  assert.equal(fetchCalled, false);
});

test('resolveSteamId: resolves vanity URL via Steam API', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ response: { success: 1, steamid: '76561198000000001' } }),
  }));

  const result = await resolveSteamId('gaben');
  assert.equal(result, '76561198000000001');
});

test('resolveSteamId: resolves the name or Steam64 id inside a steamcommunity.com profile URL', async (t) => {
  _reset();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ response: { success: 1, steamid: '76561198000000001' } }),
  }));

  assert.equal(await resolveSteamId('https://steamcommunity.com/id/gaben/'), '76561198000000001');
  assert.match(String(fetchMock.mock.calls[0].arguments[0]), /vanityurl=gaben$/);
  assert.equal(peekSteamId('steamcommunity.com/id/gaben'), '76561198000000001', 'shares the name cache entry');
  assert.equal(await resolveSteamId('https://www.steamcommunity.com/profiles/76561198000000002'), '76561198000000002');
  assert.equal(peekSteamId('steamcommunity.com/profiles/76561198000000002/'), '76561198000000002');
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('resolveSteamId: caches resolved ID — second call skips fetch', async (t) => {
  _reset();
  let fetchCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCount++;
    return { ok: true, json: async () => ({ response: { success: 1, steamid: '76561198000000001' } }) };
  });

  await resolveSteamId('gaben2');
  await resolveSteamId('gaben2');
  assert.equal(fetchCount, 1, 'second call should be served from cache');
});

test('resolveSteamId: throws with isUpstream when Steam API returns non-ok', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));

  await assert.rejects(
    () => resolveSteamId('gaben3'),
    (err) => err.isUpstream === true && /503/.test(err.message),
  );
});

test('resolveSteamId: throws user error when account is not found', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ response: { success: 42 } }),
  }));

  await assert.rejects(
    () => resolveSteamId('nobody'),
    (err) => !err.isUpstream && err.isClientError === true && /Cannot find Steam account/.test(err.message),
  );
});

// ── getOwnedGames ─────────────────────────────────────────────────────────────

test('getOwnedGames: fetches and returns game list', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ response: { games: [{ appid: 400, name: 'Portal' }] } }),
  }));

  const games = await getOwnedGames('76561198000000001');
  assert.equal(games.length, 1);
  assert.equal(games[0].appid, 400);
});

test('getOwnedGames: caches result — second call skips fetch', async (t) => {
  _reset();
  let fetchCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCount++;
    return { ok: true, json: async () => ({ response: { games: [] } }) };
  });

  await getOwnedGames('76561198000000002');
  await getOwnedGames('76561198000000002');
  assert.equal(fetchCount, 1, 'second call should be served from cache');
});

test('getOwnedGames: throws with isUpstream when Steam API returns non-ok', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));

  await assert.rejects(
    () => getOwnedGames('76561198000000003'),
    (err) => err.isUpstream === true,
  );
});

test('getOwnedGames: throws user error when library is private', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ response: {} }), // no `games` field
  }));

  await assert.rejects(
    () => getOwnedGames('76561198000000004'),
    (err) => !err.isUpstream && err.isClientError === true && /private/.test(err.message),
  );
});

test('resolveSteamId and getOwnedGames: a reply of another shape is an upstream error, not cached', async (t) => {
  _reset();
  let calls = 0;
  // ResolveVanityURL documents 1 (found) and 42 (no match); any other code is a failure.
  const bodies = [{}, { response: { success: 1 } }, { response: { success: 2 } }, {}, { response: { games: {} } }];
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => bodies[calls++] }));
  await assert.rejects(() => resolveSteamId('shape'), { isUpstream: true });
  await assert.rejects(() => resolveSteamId('shape'), { isUpstream: true });
  await assert.rejects(() => resolveSteamId('shape'), { isUpstream: true });
  await assert.rejects(() => getOwnedGames('76561198000000011'), { isUpstream: true });
  await assert.rejects(() => getOwnedGames('76561198000000011'), { isUpstream: true });
  assert.equal(calls, 5);
});

// ── getWishlist ───────────────────────────────────────────────────────────────

test('getWishlist: fetches and returns wishlist items', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ response: { items: [{ appid: 400, priority: 1, date_added: 1433965886 }] } }),
  }));

  const items = await getWishlist('76561198000000001');
  assert.equal(items.length, 1);
  assert.equal(items[0].appid, 400);
});

// The endpoint answers the same without a key, so the key isn't sent to an undocumented service.
test('getWishlist: sends no API key', async (t) => {
  _reset();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ response: {} }),
  }));

  await getWishlist('76561198000000001');
  const url = new URL(fetchMock.mock.calls[0].arguments[0]);
  assert.equal(url.searchParams.get('steamid'), '76561198000000001');
  assert.equal(url.searchParams.has('key'), false);
});

test('getWishlist: caches result — second call skips fetch', async (t) => {
  _reset();
  let fetchCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCount++;
    return { ok: true, json: async () => ({ response: { items: [] } }) };
  });

  await getWishlist('76561198000000002');
  await getWishlist('76561198000000002');
  assert.equal(fetchCount, 1, 'second call should be served from cache');
});

test('getWishlist: throws with isUpstream when Steam API returns non-ok', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));

  await assert.rejects(
    () => getWishlist('76561198000000003'),
    (err) => err.isUpstream === true,
  );
});

test('getWishlist: returns empty array (does not throw) when response has no items field', async (t) => {
  // Private wishlist, private profile, and a genuinely empty wishlist are all
  // indistinguishable — all return `{"response":{}}`. Unlike getOwnedGames,
  // getWishlist must not throw here, since there's no way to tell them apart.
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ response: {} }),
  }));

  const items = await getWishlist('76561198000000004');
  assert.deepEqual(items, []);
});

// ── getFriendList ─────────────────────────────────────────────────────────────

test('getFriendList: fetches and returns friend steamids', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({
      friendslist: { friends: [{ steamid: '76561198000000099', relationship: 'friend', friend_since: 0 }] },
    }),
  }));

  const friends = await getFriendList('76561198000000001');
  assert.deepEqual(friends, ['76561198000000099']);
});

test('getFriendList: caches result — second call skips fetch', async (t) => {
  _reset();
  let fetchCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCount++;
    return { ok: true, json: async () => ({ friendslist: { friends: [] } }) };
  });

  await getFriendList('76561198000000002');
  await getFriendList('76561198000000002');
  assert.equal(fetchCount, 1, 'second call should be served from cache');
});

test('getFriendList: returns null (does not throw) on 401 — private friends list', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 401 }));
  const unexpected = () => getMetrics().sinceRestart.outbound['steam-api']?.getFriendList?.unexpected ?? 0;
  const before = unexpected();

  const friends = await getFriendList('76561198000000003');
  assert.equal(friends, null);
  assert.equal(unexpected(), before, 'a declared 401 is an answer, not an alert');
});

test('getFriendList: throws with isUpstream when Steam API returns non-ok', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));

  await assert.rejects(
    () => getFriendList('76561198000000004'),
    (err) => err.isUpstream === true,
  );
});

// ── getPlayerSummaries ────────────────────────────────────────────────────────

test('getPlayerSummaries: fetches and returns player list', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ response: { players: [{ steamid: '76561198000000001', personaname: 'Alice' }] } }),
  }));

  const players = await getPlayerSummaries(['76561198000000001']);
  assert.equal(players.length, 1);
  assert.equal(players[0].personaname, 'Alice');
});

test('getPlayerSummaries: caches result — second call skips fetch', async (t) => {
  _reset();
  let fetchCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCount++;
    return {
      ok: true,
      json: async () => ({
        response: { players: [{ steamid: '76561198000000005', personaname: 'User5', profileurl: '' }] },
      }),
    };
  });

  await getPlayerSummaries(['76561198000000005']);
  await getPlayerSummaries(['76561198000000005']);
  assert.equal(fetchCount, 1, 'second call should be served from cache');
});

test('getPlayerSummaries: a concurrent call joins the in-flight fetch for an id instead of re-fetching it', async (t) => {
  _reset();
  const ID_A = '76561198000000011';
  const ID_B = '76561198000000012';
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const ids = new URL(url).searchParams.get('steamids').split(',');
    requested.push(...ids);
    await new Promise((r) => setTimeout(r, 10));
    return {
      ok: true,
      json: async () => ({ response: { players: ids.map((id) => ({ steamid: id, personaname: `P${id}` })) } }),
    };
  });

  const [first, second] = await Promise.all([getPlayerSummaries([ID_A]), getPlayerSummaries([ID_A, ID_B])]);
  assert.deepEqual(requested.sort(), [ID_A, ID_B], 'ID_A is fetched once, not once per call');
  assert.equal(first[0].personaname, `P${ID_A}`);
  assert.deepEqual(
    second.map((p) => p.personaname),
    [`P${ID_A}`, `P${ID_B}`],
  );
});

test("getPlayerSummaries: asks for at most 100 ids per call, Steam's documented limit", async (t) => {
  _reset();
  const batches = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const ids = new URL(url).searchParams.get('steamids').split(',');
    batches.push(ids.length);
    return {
      ok: true,
      json: async () => ({ response: { players: ids.map((steamid) => ({ steamid, personaname: steamid })) } }),
    };
  });

  const ids = Array.from({ length: 250 }, (_, i) => String(76561198000001000n + BigInt(i)));
  const players = await getPlayerSummaries(ids);
  assert.deepEqual(batches, [100, 100, 50]);
  assert.equal(players.length, 250);
  assert.ok(
    players.every((p) => p.personaname === p.steamid),
    'every id gets its real summary',
  );
});

test('getPlayerSummaries: sends its chunks 3 at a time, the same number of calls', async (t) => {
  _reset();
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls++;
    maxActive = Math.max(maxActive, ++active);
    await new Promise(setImmediate);
    active--;
    const ids = new URL(url).searchParams.get('steamids').split(',');
    return { ok: true, json: async () => ({ response: { players: ids.map((steamid) => ({ steamid })) } }) };
  });
  const ids = Array.from({ length: 500 }, (_, i) => String(76561198000002000n + BigInt(i)));
  await getPlayerSummaries(ids);
  assert.deepEqual({ calls, maxActive }, { calls: 5, maxActive: 3 });
});

test('getPlayerSummaries: a chunk refused by a spent budget keeps the names its sibling chunks fetch', async (t) => {
  _reset();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (calls++ === 1) throw Object.assign(new Error('budget'), { isBudgetExhausted: true });
    await new Promise(setImmediate);
    const ids = new URL(url).searchParams.get('steamids').split(',');
    return {
      ok: true,
      json: async () => ({ response: { players: ids.map((steamid) => ({ steamid, personaname: 'n' })) } }),
    };
  });
  const ids = Array.from({ length: 300 }, (_, i) => String(76561198000003000n + BigInt(i)));
  const players = await getPlayerSummaries(ids);
  assert.equal(players.filter((p) => p.personaname === 'n').length, 200);
});

test('getPlayerSummaries: returns placeholder players when API fails, does not cache', async (t) => {
  _reset();
  let fetchCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCount++;
    return { ok: false, status: 503 };
  });

  const ids = ['76561198000000006'];
  const result = await getPlayerSummaries(ids);
  assert.equal(result.length, 1);
  assert.equal(result[0].steamid, ids[0]);
  assert.equal(result[0].personaname, ids[0]);
  assert.equal(result[0].placeholder, true, 'flagged, so the client never stores it as a name');

  // Since failure result wasn't cached, next call hits the API again
  await getPlayerSummaries(ids);
  assert.equal(fetchCount, 2, 'fallback result must not be cached');
});

test('getPlayerSummaries: a failed call warns [steam] and yields placeholders instead of rejecting', async (t) => {
  _reset();
  const warn = t.mock.method(console, 'warn', () => {});
  for (const fetchImpl of [
    async () => ({ ok: false, status: 503 }),
    async () => {
      throw new TypeError('fetch failed');
    },
  ]) {
    t.mock.method(globalThis, 'fetch', fetchImpl);
    const [p] = await getPlayerSummaries(['76561198000000009']);
    assert.deepEqual(p, {
      steamid: '76561198000000009',
      personaname: '76561198000000009',
      profileurl: '',
      placeholder: true,
    });
  }
  assert.equal(warn.mock.callCount(), 2);
  assert.match(warn.mock.calls[0].arguments[0], /^\[steam\]/);
});

test('getPlayerSummaries: a forced call that fails falls back to the cached player, not a placeholder', async (t) => {
  _reset();
  t.mock.method(console, 'warn', () => {});
  const cached = { steamid: '76561198000000010', personaname: 'User10', profileurl: 'u', avatar: 'a.jpg' };
  setCache('player:76561198000000010', cached);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));

  assert.deepEqual(await getPlayerSummaries(['76561198000000010'], { force: true }), [cached]);
});

test('getPlayerSummaries: cache key is order-independent', async (t) => {
  _reset();
  let fetchCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCount++;
    return {
      ok: true,
      json: async () => ({
        response: {
          players: [
            { steamid: '76561198000000007', personaname: 'User7', profileurl: '' },
            { steamid: '76561198000000008', personaname: 'User8', profileurl: '' },
          ],
        },
      }),
    };
  });

  await getPlayerSummaries(['76561198000000008', '76561198000000007']);
  await getPlayerSummaries(['76561198000000007', '76561198000000008']); // reversed order
  assert.equal(fetchCount, 1, 'reversed order should hit same cache entries');
});

// ── getAppDetails ─────────────────────────────────────────────────────────────

function makeAppDetailsResponse(appid, data = null) {
  const entry = data ? { success: true, data } : { success: false };
  return { ok: true, json: async () => ({ [String(appid)]: entry }) };
}

// Simulate a 429 response with a near-zero Retry-After so retries complete instantly in tests.
function make429Response() {
  return { ok: false, status: 429, headers: { get: (h) => (h === 'retry-after' ? '0.001' : null) } };
}

test('getAppDetails: throws when fetch fails', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));
  await assert.rejects(
    () => getAppDetails(400),
    (err) => err.isUpstream === true,
  );
});

test('getGameRating: retries on 429 and succeeds on third attempt', async (t) => {
  _reset();
  let callCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    callCount++;
    return callCount < 3 ? make429Response() : makeReviewResponse(1000, 900, 'Very Positive');
  });
  const result = await getGameRating(400);
  assert.equal(callCount, 3);
  assert.equal(result.total, 1000);
});

test('getGameRating: throws isUpstream after exhausting 429 retries', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => make429Response());
  await assert.rejects(
    () => getGameRating(400),
    (err) => err.isUpstream === true && /rate limited/.test(err.message),
  );
});

test('fetchStoreApi: a redirect fails with its target instead of being followed', async (t) => {
  _reset();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({
    ok: false,
    status: 302,
    headers: new Headers({ location: 'https://store.steampowered.com/' }),
  }));
  await assert.rejects(
    () => getAppDetails(400),
    (err) => err.isUpstream === true && /302 redirect to https:\/\/store\.steampowered\.com\//.test(err.message),
  );
  assert.equal(fetchMock.mock.calls[0].arguments[1].redirect, 'manual');
});

test('getAppDetails: retries on 429 and succeeds on third attempt', async (t) => {
  _reset();
  let callCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    callCount++;
    return callCount < 3
      ? make429Response()
      : makeAppDetailsResponse(400, {
          genres: [{ id: '1', description: 'Action' }],
          categories: [],
          developers: [],
          publishers: [],
        });
  });
  const result = await getAppDetails(400);
  assert.equal(callCount, 3);
  assert.deepEqual(result.genres, ['Action']);
});

test('getAppDetails: returns null when success is false', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => makeAppDetailsResponse(400, null));
  assert.equal(await getAppDetails(400), null);
});

test('getAppDetails: accepts an entry keyed under another appid when its steam_appid matches', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () =>
    makeAppDetailsResponse(3290770, { steam_appid: 1656930, name: 'Coridden' }),
  );
  assert.equal((await getAppDetails(1656930)).name, 'Coridden');
});

test('getAppDetails: ignores an entry keyed under another appid whose steam_appid differs', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () =>
    makeAppDetailsResponse(3290770, { steam_appid: 3290770, name: 'Other' }),
  );
  assert.equal(await getAppDetails(1656930), null);
});

test('getAppDetails: returns genres, categories, developers and publishers', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () =>
    makeAppDetailsResponse(400, {
      genres: [
        { id: '1', description: 'Action' },
        { id: '25', description: 'Adventure' },
      ],
      categories: [{ id: '9', description: 'Co-op' }],
      developers: ['Valve'],
      publishers: ['Valve'],
    }),
  );
  const result = await getAppDetails(400);
  assert.deepEqual(result.genres, ['Action', 'Adventure']);
  assert.deepEqual(result.categories, ['Co-op']);
  assert.deepEqual(result.developers, ['Valve']);
  assert.deepEqual(result.publishers, ['Valve']);
});

test('getAppDetails: dedupes genres/categories that share the same label but different ids', async (t) => {
  // Real-world case (app 3357650): Steam lists distinct ids 55/56 both labeled "DualShock
  // Controller Support" and 57/58 both "DualSense Controller Support" — since only the label
  // is ever displayed, the duplicate id is never meaningful and shouldn't render as a
  // repeated pill/table entry.
  _reset();
  t.mock.method(globalThis, 'fetch', async () =>
    makeAppDetailsResponse(400, {
      genres: [
        { id: '1', description: 'Action' },
        { id: '2', description: 'Action' },
      ],
      categories: [
        { id: 55, description: 'DualShock Controller Support' },
        { id: 56, description: 'DualShock Controller Support' },
        { id: 57, description: 'DualSense Controller Support' },
      ],
      developers: ['Valve'],
      publishers: ['Valve'],
    }),
  );
  const result = await getAppDetails(400);
  assert.deepEqual(result.genres, ['Action']);
  assert.deepEqual(result.categories, ['DualShock Controller Support', 'DualSense Controller Support']);
});

test('getAppDetails: handles missing optional fields with empty arrays', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => makeAppDetailsResponse(400, {}));
  assert.deepEqual(await getAppDetails(400), {
    name: null,
    type: null,
    genres: [],
    categories: [],
    developers: [],
    publishers: [],
    description: null,
    releaseDate: null,
    comingSoon: false,
    metacritic: null,
    capsule: 'https://cdn.akamai.steamstatic.com/steam/apps/400/capsule_sm_120.jpg',
    thumb: null,
    banner: 'https://cdn.akamai.steamstatic.com/steam/apps/400/header.jpg',
    movies: [],
    screenshots: [],
    dlc: [],
    fullgame: null,
    website: null,
    achievementCount: null,
    platforms: [],
    languages: [],
    isFree: false,
    priceInitial: null,
  });
});

test('getAppDetails: requests the US region so price_overview is always USD', async (t) => {
  _reset();
  let requestedUrl;
  t.mock.method(globalThis, 'fetch', async (url) => {
    requestedUrl = url;
    return makeAppDetailsResponse(400, {});
  });
  await getAppDetails(400);
  assert.match(requestedUrl, /(?:\?|&)cc=us(?:&|$)/);
});

test('getAppDetails: extracts isFree from is_free', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => makeAppDetailsResponse(400, { is_free: true }));
  const result = await getAppDetails(400);
  assert.equal(result.isFree, true);
});

test('getAppDetails: isFree defaults to false when is_free is absent', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => makeAppDetailsResponse(400, {}));
  const result = await getAppDetails(400);
  assert.equal(result.isFree, false);
});

test('getAppDetails: extracts priceInitial (undiscounted launch price, in cents) from price_overview', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () =>
    makeAppDetailsResponse(400, {
      price_overview: { currency: 'USD', initial: 5999, final: 2999, discount_percent: 50 },
    }),
  );
  const result = await getAppDetails(400);
  assert.equal(result.priceInitial, 5999, 'uses the undiscounted `initial` price, not the discounted `final` one');
});

test('getAppDetails: priceInitial is null when price_overview is absent (free game or no price data)', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => makeAppDetailsResponse(400, {}));
  const result = await getAppDetails(400);
  assert.equal(result.priceInitial, null);
});

test('getAppDetails: extracts dlc appid list', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => makeAppDetailsResponse(400, { dlc: [123, 456] }));
  const result = await getAppDetails(400);
  assert.deepEqual(result.dlc, [123, 456]);
});

test('getAppDetails: dlc defaults to empty array when field is not an array', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => makeAppDetailsResponse(400, { dlc: 'not-an-array' }));
  const result = await getAppDetails(400);
  assert.deepEqual(result.dlc, []);
});

test('getAppDetails: extracts fullgame (a DLC app pointing back at its base game)', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () =>
    makeAppDetailsResponse(500, { fullgame: { appid: '400', name: 'Portal' } }),
  );
  const result = await getAppDetails(500);
  assert.deepEqual(result.fullgame, { appid: 400, name: 'Portal' });
});

test('getAppDetails: fullgame is null when absent (a base game, not DLC)', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => makeAppDetailsResponse(400, {}));
  const result = await getAppDetails(400);
  assert.equal(result.fullgame, null);
});

test('getAppDetails: extracts type', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => makeAppDetailsResponse(400, { type: 'music' }));
  const result = await getAppDetails(400);
  assert.equal(result.type, 'music');
});

test('getAppDetails: type is null when absent', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => makeAppDetailsResponse(400, {}));
  const result = await getAppDetails(400);
  assert.equal(result.type, null);
});

test('getAppDetails: extracts website field', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => makeAppDetailsResponse(400, { website: 'https://example.com' }));
  const result = await getAppDetails(400);
  assert.equal(result.website, 'https://example.com');
});

test('getAppDetails: website is null when absent', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => makeAppDetailsResponse(400, {}));
  const result = await getAppDetails(400);
  assert.equal(result.website, null);
});

test('getAppDetails: extracts achievementCount from achievements.total', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () =>
    makeAppDetailsResponse(400, {
      achievements: { total: 42, highlighted: [{ name: 'ACH_1', path: 'i1' }] },
    }),
  );
  const result = await getAppDetails(400);
  assert.equal(result.achievementCount, 42);
});

test('getAppDetails: achievementCount is 0 (not null) when Steam reports zero achievements', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () =>
    makeAppDetailsResponse(400, { achievements: { total: 0, highlighted: [] } }),
  );
  const result = await getAppDetails(400);
  assert.equal(result.achievementCount, 0);
});

test('getAppDetails: achievementCount is null when the achievements field is absent', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => makeAppDetailsResponse(400, {}));
  const result = await getAppDetails(400);
  assert.equal(result.achievementCount, null);
});

test('getAppDetails: extracts platforms as an array of supported OS names', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () =>
    makeAppDetailsResponse(400, {
      platforms: { windows: true, mac: false, linux: true },
    }),
  );
  const result = await getAppDetails(400);
  assert.deepEqual(result.platforms, ['Windows', 'Linux']);
});

test('getAppDetails: platforms is empty array when the field is absent', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => makeAppDetailsResponse(400, {}));
  const result = await getAppDetails(400);
  assert.deepEqual(result.platforms, []);
});

test('getAppDetails: parses supported_languages into a clean array of names', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () =>
    makeAppDetailsResponse(400, {
      supported_languages:
        'English<strong>*</strong>, French, German<br><strong>*</strong>languages with full audio support',
    }),
  );
  const result = await getAppDetails(400);
  assert.deepEqual(result.languages, ['English', 'French', 'German']);
});

test('getAppDetails: languages is empty array when supported_languages is absent', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => makeAppDetailsResponse(400, {}));
  const result = await getAppDetails(400);
  assert.deepEqual(result.languages, []);
});

test('getAppDetails: extracts name field', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => makeAppDetailsResponse(400, { name: 'Portal' }));
  const result = await getAppDetails(400);
  assert.equal(result.name, 'Portal');
});

test('getAppDetails: uses capsule_imagev5 when present', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () =>
    makeAppDetailsResponse(400, {
      capsule_imagev5: 'https://cdn.akamai.steamstatic.com/steam/apps/400/capsule_184x69.jpg',
      capsule_image: 'https://cdn.akamai.steamstatic.com/steam/apps/400/capsule_231x87.jpg',
    }),
  );
  const result = await getAppDetails(400);
  assert.equal(result.capsule, 'https://cdn.akamai.steamstatic.com/steam/apps/400/capsule_184x69.jpg');
});

test('getAppDetails: the table thumbnail is capsule_image, the 231×87 capsule', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () =>
    makeAppDetailsResponse(400, {
      capsule_imagev5: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/400/capsule_184x69.jpg',
      capsule_image: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/400/capsule_231x87.jpg',
    }),
  );
  const result = await getAppDetails(400);
  assert.equal(
    result.thumb,
    'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/400/capsule_231x87.jpg',
  );
  assert.equal(
    result.capsule,
    'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/400/capsule_184x69.jpg',
  );
});

test('getAppDetails: comingSoon reflects release_date.coming_soon', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () =>
    makeAppDetailsResponse(400, {
      release_date: { coming_soon: true, date: 'Oct 14, 2026' },
    }),
  );
  const result = await getAppDetails(400);
  assert.equal(result.comingSoon, true);
  assert.equal(result.releaseDate, 'Oct 14, 2026');
});

test('getAppDetails: falls back to capsule_image when capsule_imagev5 is absent', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () =>
    makeAppDetailsResponse(400, {
      capsule_image: 'https://cdn.akamai.steamstatic.com/steam/apps/400/capsule_231x87.jpg',
    }),
  );
  const result = await getAppDetails(400);
  assert.equal(result.capsule, 'https://cdn.akamai.steamstatic.com/steam/apps/400/capsule_231x87.jpg');
});

test('getAppDetails: falls back to constructed sm_120 URL when no capsule fields present', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => makeAppDetailsResponse(400, {}));
  const result = await getAppDetails(400);
  assert.equal(result.capsule, 'https://cdn.akamai.steamstatic.com/steam/apps/400/capsule_sm_120.jpg');
});

test('getAppDetails: uses header_image for the panel hero banner when present', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () =>
    makeAppDetailsResponse(400, {
      header_image: 'https://cdn.akamai.steamstatic.com/steam/apps/400/header_real.jpg',
    }),
  );
  const result = await getAppDetails(400);
  assert.equal(result.banner, 'https://cdn.akamai.steamstatic.com/steam/apps/400/header_real.jpg');
});

test('getAppDetails: falls back to constructed header.jpg URL when header_image is absent', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => makeAppDetailsResponse(400, {}));
  const result = await getAppDetails(400);
  assert.equal(result.banner, 'https://cdn.akamai.steamstatic.com/steam/apps/400/header.jpg');
});

test('getAppDetails: extracts movies with hls field', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () =>
    makeAppDetailsResponse(400, {
      movies: [
        {
          id: 1,
          name: 'Trailer',
          thumbnail: 'https://example.com/thumb.jpg',
          hls_h264: 'https://example.com/vid.m3u8',
          highlight: true,
        },
        { id: 2, name: 'Gameplay', thumbnail: 'https://example.com/thumb2.jpg', highlight: false },
      ],
    }),
  );
  const result = await getAppDetails(400);
  assert.equal(result.movies.length, 2);
  assert.equal(result.movies[0].thumbnail, 'https://example.com/thumb.jpg');
  assert.equal(result.movies[0].hls, 'https://example.com/vid.m3u8');
  assert.equal(result.movies[0].name, 'Trailer');
  assert.equal(result.movies[1].hls, null);
});

test('getAppDetails: caps movies at 5', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () =>
    makeAppDetailsResponse(400, {
      movies: Array.from({ length: 8 }, (_, i) => ({
        id: i,
        name: `T${i}`,
        thumbnail: '',
        hls_h264: `https://example.com/${i}.m3u8`,
      })),
    }),
  );
  const result = await getAppDetails(400);
  assert.equal(result.movies.length, 5);
});

// ── resolveSteamTags / extractDemoAppid ────────────────────────────────────
// Both read the same cached IStoreBrowseService item (see getStoreBrowseItem in
// lib/steam.js) — tags via its `tagids` field, the demo link via `related_items.demo_appid`
// — so they're tested together here rather than in separate sections.
const steamTags = (appid) => resolveSteamTags(getStoreBrowseItem(appid));
const gameDemo = async (appid) => extractDemoAppid(await getStoreBrowseItem(appid));

// Routes the shared fetch mock by URL: IStoreBrowseService for the per-app store browse item
// (tagids + related_items), ajaxgetstoretags for the tagid → name map.
function mockTagEndpoints(
  t,
  { tagids = [], tags, nameMap = { 1: 'Action' }, demoAppid, browseOk = true, namesOk = true } = {},
) {
  let browseCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('IStoreBrowseService')) {
      browseCalls++;
      if (!browseOk) return { ok: false, status: 503 };
      return {
        ok: true,
        json: async () => ({
          response: {
            store_items: [
              {
                success: 1,
                tagids,
                ...(tags ? { tags } : {}),
                ...(demoAppid != null ? { related_items: { demo_appid: [demoAppid] } } : {}),
              },
            ],
          },
        }),
      };
    }
    if (String(url).includes('ajaxgetstoretags')) {
      if (!namesOk) return { ok: false, status: 503 };
      return {
        ok: true,
        json: async () => ({ tags: Object.entries(nameMap).map(([tagid, name]) => ({ tagid: Number(tagid), name })) }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  return () => browseCalls;
}

test('resolveSteamTags: returns every tag in weight order, resolved via the name map (no display cap)', async (t) => {
  _reset();
  const tagids = Array.from({ length: 30 }, (_, i) => 100 + i); // already weight-ordered
  const nameMap = Object.fromEntries(tagids.map((id) => [id, `Tag${id}`]));
  mockTagEndpoints(t, { tagids, nameMap });

  const result = await steamTags(400);
  assert.equal(result.length, 30);
  assert.equal(result[0].name, 'Tag100');
  assert.equal(result[29].name, 'Tag129');
});

test('resolveSteamTags: weights each tag relative to the top one', async (t) => {
  _reset();
  mockTagEndpoints(t, {
    tagids: [1, 2, 3],
    tags: [
      { tagid: 1, weight: 10000 },
      { tagid: 2, weight: 3333 },
      { tagid: 3, weight: 154 },
    ],
    nameMap: { 1: 'Action', 2: 'Indie', 3: 'Roguelike' },
  });

  assert.deepEqual(await steamTags(400), [
    { name: 'Action', weight: 1 },
    { name: 'Indie', weight: 0.33 },
    { name: 'Roguelike', weight: 0.02 },
  ]);
});

test('resolveSteamTags: a null weight when the item has no tag weights', async (t) => {
  _reset();
  mockTagEndpoints(t, { tagids: [1], nameMap: { 1: 'Action' } });

  assert.deepEqual(await steamTags(400), [{ name: 'Action', weight: null }]);
});

test('resolveSteamTags: returns empty array when the app has no tagids', async (t) => {
  _reset();
  mockTagEndpoints(t, { tagids: [] });

  const result = await steamTags(400);
  assert.deepEqual(result, []);
});

test('resolveSteamTags: returns empty array when the store item lookup is unsuccessful', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('IStoreBrowseService')) {
      return { ok: true, json: async () => ({ response: { store_items: [{ success: 0 }] } }) };
    }
    return { ok: true, json: async () => ({ tags: [{ tagid: 1, name: 'Action' }] }) };
  });

  const result = await steamTags(400);
  assert.deepEqual(result, []);
});

test('resolveSteamTags: drops tagids with no matching name in the map', async (t) => {
  _reset();
  mockTagEndpoints(t, { tagids: [1, 2, 3], nameMap: { 1: 'Action', 3: 'Indie' } });

  const result = await steamTags(400);
  assert.deepEqual(
    result.map((t) => t.name),
    ['Action', 'Indie'],
  );
});

test('resolveSteamTags: throws isUpstream when the tagid fetch fails', async (t) => {
  _reset();
  mockTagEndpoints(t, { browseOk: false });
  await assert.rejects(
    () => steamTags(400),
    (err) => err.isUpstream === true,
  );
});

test('resolveSteamTags: throws isUpstream when the tag name map fetch fails', async (t) => {
  _reset();
  mockTagEndpoints(t, { tagids: [1], namesOk: false });
  await assert.rejects(
    () => steamTags(400),
    (err) => err.isUpstream === true,
  );
});

// Observed live: ajaxgetstoretags returning a 200 OK with a literal JSON `null` body during
// what looked like an upstream hiccup, rather than the usual `{tags: [...]}` shape.
// Destructuring straight off that would throw an opaque TypeError instead of a clean,
// caller-recognizable upstream error.
test('resolveSteamTags: throws isUpstream (not a raw TypeError) when the tag name map response body is null', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('IStoreBrowseService')) {
      return { ok: true, json: async () => ({ response: { store_items: [{ success: 1, tagids: [1] }] } }) };
    }
    if (String(url).includes('ajaxgetstoretags')) {
      return { ok: true, json: async () => null };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  await assert.rejects(
    () => steamTags(400),
    (err) => err.isUpstream === true,
  );
});

// A cached `{}` would read as "no tags" on every game for the meta TTL.
for (const body of [{}, { tags: [] }, { tags: 'x' }, { tags: [null] }, { tags: [{}] }]) {
  test(`resolveSteamTags: throws isUpstream and caches nothing when the tag name map body is ${JSON.stringify(body)}`, async (t) => {
    _reset();
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => body }));

    await assert.rejects(
      () => resolveSteamTags(Promise.resolve({ tagids: [1] })),
      (err) => err.isUpstream === true,
    );
    assert.equal(getCachedAt('tagnames:all'), undefined);
  });
}

test('resolveSteamTags: holds off refetching the tag name map briefly after a failure', async (t) => {
  _reset();
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let ok = false;
  const fetchMock = t.mock.method(globalThis, 'fetch', async () =>
    ok ? { ok: true, json: async () => ({ tags: [{ tagid: 1, name: 'Action' }] }) } : { ok: false, status: 503 },
  );
  const tags = () => resolveSteamTags(Promise.resolve({ tagids: [1] }));

  await assert.rejects(tags, (err) => err.isUpstream === true);
  ok = true;
  await assert.rejects(tags, (err) => err.isUpstream === true);
  assert.equal(fetchMock.mock.callCount(), 1, 'no refetch within the hold-off');

  t.mock.timers.tick(31 * 1000);
  assert.deepEqual(await tags(), [{ name: 'Action', weight: null }]);
  assert.equal(fetchMock.mock.callCount(), 2);
});

test('extractDemoAppid: returns the demo appid from related_items.demo_appid', async (t) => {
  _reset();
  mockTagEndpoints(t, { tagids: [], nameMap: {}, demoAppid: 1714800 });

  const result = await gameDemo(1634360);
  assert.equal(result, 1714800);
});

test('extractDemoAppid: returns null when the game has no demo', async (t) => {
  _reset();
  mockTagEndpoints(t, { tagids: [], nameMap: {} });

  const result = await gameDemo(400);
  assert.equal(result, null);
});

test('extractDemoAppid: returns null when the store item lookup is unsuccessful', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('IStoreBrowseService')) {
      return { ok: true, json: async () => ({ response: { store_items: [{ success: 0 }] } }) };
    }
    return { ok: true, json: async () => ({ tags: [] }) };
  });

  const result = await gameDemo(400);
  assert.equal(result, null);
});

// A stream resolves tags for every game against the same ~430-entry map.
test('resolveSteamTags: parses the tag name map once while its row is live', async (t) => {
  _reset();
  mockTagEndpoints(t, { nameMap: { 1: 'Action' } });
  await resolveSteamTags(Promise.resolve({ tagids: [1] }));

  const parse = t.mock.method(JSON, 'parse');
  assert.deepEqual(await resolveSteamTags(Promise.resolve({ tagids: [1] })), [{ name: 'Action', weight: null }]);
  assert.equal(parse.mock.callCount(), 0);
});

test('resolveSteamTags: fetches the tag name map alongside a pending store browse item', async (t) => {
  _reset();
  let releaseBrowse;
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    if (String(url).includes('IStoreBrowseService')) {
      await new Promise((r) => (releaseBrowse = r));
      return { ok: true, json: async () => ({ response: { store_items: [{ success: 1, tagids: [1] }] } }) };
    }
    return { ok: true, json: async () => ({ tags: [{ tagid: 1, name: 'Action' }] }) };
  });

  const tags = resolveSteamTags(getStoreBrowseItem(400));
  await new Promise((r) => setImmediate(r));
  assert.ok(
    urls.some((u) => u.includes('ajaxgetstoretags')),
    'the name map request should not wait on the browse item',
  );
  releaseBrowse();
  assert.deepEqual(await tags, [{ name: 'Action', weight: null }]);
});

test('resolveSteamTags: re-fetches the tag name map once its row expires', async (t) => {
  const now = Date.now();
  _reset([['tagnames:all', { value: { 1: 'Old' }, ts: now }]]);
  assert.deepEqual(await resolveSteamTags(Promise.resolve({ tagids: [1] })), [{ name: 'Old', weight: null }]);

  _reset([['tagnames:all', { value: { 1: 'Old' }, ts: now - META_CACHE_TTL_MS - 1 }]]);
  mockTagEndpoints(t, { nameMap: { 1: 'New' } });
  assert.deepEqual(await resolveSteamTags(Promise.resolve({ tagids: [1] })), [{ name: 'New', weight: null }]);
});

test('resolveSteamTags: reads a tag name map row rewritten since the last read', async () => {
  const now = Date.now();
  _reset([['tagnames:all', { value: { 1: 'Old' }, ts: now - 1000 }]]);
  assert.deepEqual(await resolveSteamTags(Promise.resolve({ tagids: [1] })), [{ name: 'Old', weight: null }]);

  _reset([['tagnames:all', { value: { 1: 'New' }, ts: now }]]);
  assert.deepEqual(await resolveSteamTags(Promise.resolve({ tagids: [1] })), [{ name: 'New', weight: null }]);
});

test('resolveSteamTags: does not pair a map with a row rewritten while it was being read', async () => {
  const now = Date.now();
  _reset([['tagnames:all', { value: { 1: 'Old' }, ts: now - 5000 }]]);
  const first = resolveSteamTags(Promise.resolve({ tagids: [1] }));
  _reset([['tagnames:all', { value: { 1: 'New' }, ts: now - 4000 }]]);
  assert.deepEqual(await first, [{ name: 'Old', weight: null }]);

  assert.deepEqual(await resolveSteamTags(Promise.resolve({ tagids: [1] })), [{ name: 'New', weight: null }]);
});

// ── resolveSteamPackageAppids / resolveSteamBundleAppids ────────────────────────

test('resolveSteamPackageAppids: returns the single appid a Steam "sub" (package) contains', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.ok(String(url).includes('packageids=776544'));
    return {
      ok: true,
      json: async () => ({ 776544: { success: true, data: { apps: [{ id: 2169570, name: 'Redwall' }] } } }),
    };
  });

  const result = await resolveSteamPackageAppids(776544);
  assert.deepEqual(result, [2169570]);
});

test('resolveSteamPackageAppids: returns null and caches the miss when the package does not exist', async (t) => {
  _reset();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return { ok: true, json: async () => ({ 999: { success: false } }) };
  });

  const result = await resolveSteamPackageAppids(999);
  assert.equal(result, null);
  await resolveSteamPackageAppids(999);
  assert.equal(calls, 1, 'a confirmed miss should be cached, not re-fetched');
});

test('resolveSteamPackageAppids: throws isUpstream on a non-ok response', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 500 }));
  await assert.rejects(
    () => resolveSteamPackageAppids(1),
    (err) => err.isUpstream === true,
  );
});

test('resolveSteamBundleAppids: returns every appid a Steam bundle spans', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.ok(String(url).includes('bundleids=4995'));
    return { ok: true, json: async () => [{ bundleid: 4995, appids: [396750, 688700, 709150] }] };
  });

  const result = await resolveSteamBundleAppids(4995);
  assert.deepEqual(result, [396750, 688700, 709150]);
});

test('resolveSteamBundleAppids: returns null and caches the miss when the bundle id is unknown', async (t) => {
  _reset();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return { ok: true, json: async () => [] };
  });

  const result = await resolveSteamBundleAppids(999999999);
  assert.equal(result, null);
  await resolveSteamBundleAppids(999999999);
  assert.equal(calls, 1, 'a confirmed miss should be cached, not re-fetched');
});

// ── getProtonDbStatus ──────────────────────────────────────────────────────────

test('getProtonDbStatus: returns tier, confidence and total', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({
      tier: 'gold',
      bestReportedTier: 'platinum',
      confidence: 'strong',
      score: 0.71,
      total: 2009,
      trendingTier: 'platinum',
    }),
  }));

  const result = await getProtonDbStatus(400);
  assert.deepEqual(result, { tier: 'gold', confidence: 'strong', total: 2009 });
});

// "Unreleased" is inferred (a coming-soon browse item and no reviews), so a forced refresh asks rather than wipe a summary.
test('getProtonDbStatus: a forced lookup of an unreleased game asks ProtonDB instead of wiping its cached summary', async (t) => {
  _reset();
  _resetCircuitBreakers();
  setCache('protondb:401', { tier: 'gold', confidence: 'good', total: 9 });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ tier: 'gold', confidence: 'good', total: 10 }),
  }));
  assert.deepEqual(await getProtonDbStatus(401, { unreleased: true }), { tier: 'gold', confidence: 'good', total: 9 });
  assert.equal(fetchMock.mock.callCount(), 0);
  ageCache();
  assert.deepEqual(await getProtonDbStatus(401, { unreleased: true, force: true }), {
    tier: 'gold',
    confidence: 'good',
    total: 10,
  });
});

// A 404 means "ProtonDB has no reports for this appid" — not an upstream failure —
// same treatment as getGameRating's "no reviews yet" case.
test('getProtonDbStatus: two 403s in a row (a blanket bot-block) open the circuit, failing fast without a request', async (t) => {
  _reset();
  _resetCircuitBreakers();
  t.after(_resetCircuitBreakers);
  t.mock.method(console, 'warn', () => {});
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 403, text: async () => '' }));

  await assert.rejects(() => getProtonDbStatus(400));
  await assert.rejects(() => getProtonDbStatus(401));
  await assert.rejects(() => getProtonDbStatus(402), /circuit open/);
  assert.equal(fetchMock.mock.callCount(), 2);
  assert.ok(getCircuitBreakers().protondb.blockedUntil > Date.now());
});

test('getProtonDbStatus: requests already queued when the circuit opens never reach ProtonDB', async (t) => {
  _reset();
  _resetCircuitBreakers();
  t.after(_resetCircuitBreakers);
  t.mock.method(console, 'warn', () => {});
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 403, text: async () => '' }));

  // protonLimit runs 3 at a time; at most one more can start between the first 403 and the
  // second, which opens the circuit. The rest were queued and must fail without a request.
  const results = await Promise.allSettled([410, 411, 412, 413, 414, 415, 416, 417].map((a) => getProtonDbStatus(a)));
  assert.ok(results.every((r) => r.status === 'rejected'));
  assert.ok(fetchMock.mock.callCount() <= 4, `${fetchMock.mock.callCount()} requests`);
});

test('getProtonDbStatus: returns null on 404 (no reports for this appid)', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 404 }));
  const result = await getProtonDbStatus(999999999);
  assert.equal(result, null);
});

// "pending" means too few reports for ProtonDB to confidently assign a tier, but ProtonDB
// still publishes its own best-guess provisionalTier from those same reports — surfaced here
// (flagged `pending: true`) rather than collapsed to null, since showing a low-confidence
// guess beats showing nothing (confirmed live: an appid with 3 real reports showed no data
// at all here before this, despite protondb.com itself showing those 3 reports).
test('getProtonDbStatus: a "pending" tier with a provisionalTier is surfaced as pending', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ tier: 'pending', provisionalTier: 'platinum', confidence: 'inadequate', total: 3 }),
  }));
  const result = await getProtonDbStatus(400);
  assert.deepEqual(result, { tier: 'platinum', confidence: 'inadequate', total: 3, pending: true });
});

// No provisionalTier at all (ProtonDB has nothing to guess from) still collapses to null —
// there's no lesser value worth surfacing at that point.
test('getProtonDbStatus: a "pending" tier with no provisionalTier returns null', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ tier: 'pending', confidence: 'low', total: 2 }),
  }));
  const result = await getProtonDbStatus(400);
  assert.equal(result, null);
});

test('getProtonDbStatus: throws isUpstream for a non-404 error', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503, text: async () => '' }));
  await assert.rejects(
    () => getProtonDbStatus(400),
    (err) => err.isUpstream === true,
  );
});

test('getProtonDbStatus: caches result — second call skips fetch', async (t) => {
  _reset();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return { ok: true, json: async () => ({ tier: 'platinum', confidence: 'strong', total: 10 }) };
  });

  await getProtonDbStatus(400);
  await getProtonDbStatus(400);
  assert.equal(calls, 1);
});

test('getProtonDbStatus: caches the null result of a 404 too', async (t) => {
  _reset();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return { ok: false, status: 404 };
  });

  await getProtonDbStatus(400);
  await getProtonDbStatus(400);
  assert.equal(calls, 1);
});

// ── searchStoreGames ──────────────────────────────────────────────────────────

test('searchStoreGames: extracts appid, name and tinyImage, capped at 10', async (t) => {
  _reset();
  const items = Array.from({ length: 12 }, (_, i) => ({
    id: 400 + i,
    name: `Game ${i}`,
    tiny_image: `https://example.com/${i}.jpg`,
  }));
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ items }) }));

  const result = await searchStoreGames('portal');
  assert.equal(result.length, 10);
  assert.deepEqual(result[0], { appid: 400, name: 'Game 0', tinyImage: 'https://example.com/0.jpg' });
});

test('searchStoreGames: returns empty array when items field is missing', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({}) }));
  assert.deepEqual(await searchStoreGames('xyz'), []);
});

test('searchStoreGames: drops an item whose id is not a positive integer, so it never reaches the cache', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({
      items: [
        { id: '"><img src=x onerror=alert(1)>', name: 'Bad' },
        { id: null, name: 'Null' },
        { id: 400, name: 'Portal' },
      ],
    }),
  }));
  assert.deepEqual(await searchStoreGames('portal'), [{ appid: 400, name: 'Portal', tinyImage: null }]);
});

test('searchStoreGames: tinyImage is null when absent', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ items: [{ id: 400, name: 'Portal' }] }),
  }));
  assert.deepEqual(await searchStoreGames('portal'), [{ appid: 400, name: 'Portal', tinyImage: null }]);
});

test('searchStoreGames: caches result — second call skips fetch', async (t) => {
  _reset();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ items: [{ id: 400, name: 'Portal' }] }),
  }));
  await searchStoreGames('portal');
  await searchStoreGames('portal');
  assert.equal(fetchMock.mock.callCount(), 2, 'one search and one demo check, both for the first call');
});

test('searchStoreGames: cache key is case-insensitive', async (t) => {
  _reset();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ items: [{ id: 400, name: 'Portal' }] }),
  }));
  await searchStoreGames('Portal');
  await searchStoreGames('PORTAL');
  assert.equal(fetchMock.mock.callCount(), 2, 'one search and one demo check, both for the first call');
});

// Storesearch lists a game and its demo alike (`type: "app"`); GetItems' `type` 1 marks the demo.
function mockSearchWithBrowse(t, browse) {
  return t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('/storesearch/')) {
      return {
        ok: true,
        json: async () => ({
          items: [
            { id: 4338750, name: 'Stack Order' },
            { id: 4645100, name: 'Stack Order Demo' },
          ],
        }),
      };
    }
    assert.match(url, /IStoreBrowseService\/GetItems/);
    return browse(url);
  });
}

test('searchStoreGames: drops demos in one batched store browse call', async (t) => {
  _reset();
  const fetchMock = mockSearchWithBrowse(t, (url) => {
    const { ids } = JSON.parse(decodeURIComponent(url.split('input_json=')[1]));
    assert.deepEqual(ids, [{ appid: 4338750 }, { appid: 4645100 }]);
    return {
      ok: true,
      json: async () => ({
        response: {
          store_items: [
            { success: 1, appid: 4338750, type: 0 },
            { success: 1, appid: 4645100, type: 1 },
          ],
        },
      }),
    };
  });
  assert.deepEqual(await searchStoreGames('stack order'), [{ appid: 4338750, name: 'Stack Order', tinyImage: null }]);
  assert.equal(fetchMock.mock.callCount(), 2);
});

test('searchStoreGames: keeps demos, briefly cached, when the store browse call fails', async (t) => {
  _reset();
  const warnMock = t.mock.method(console, 'warn', () => {});
  mockSearchWithBrowse(t, () => ({ ok: false, status: 500 }));
  const results = await searchStoreGames('stack order');
  assert.deepEqual(
    results.map((r) => r.appid),
    [4338750, 4645100],
  );
  assert.match(warnMock.mock.calls[0].arguments[0], /^\[search\]/);
  const { expires } = db.prepare('SELECT expires FROM cache_search WHERE key = ?').get('search:stack order');
  assert.ok(expires - Date.now() <= MISS_CACHE_TTL_MS);
});

test('searchStoreGames: throws isUpstream when fetch fails', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));
  await assert.rejects(
    () => searchStoreGames('portal'),
    (err) => err.isUpstream === true,
  );
});

// ── searchCreatorGames ────────────────────────────────────────────────────────

const creatorRow = (key, appids = key.slice(4)) => `<a href="x" data-ds-appid="${appids}" data-ds-itemkey="${key}">`;

test('searchCreatorGames: keeps App_ rows only, deduped, and asks for one page of games by exact name', async (t) => {
  _reset();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({
      total_count: 4,
      start: 0,
      results_html: [
        creatorRow('App_10'),
        creatorRow('Sub_77', '10,11'),
        creatorRow('App_12'),
        creatorRow('App_10'),
      ].join('\n'),
    }),
  }));
  assert.deepEqual(await searchCreatorGames('publisher', 'Foo, Inc.'), { appids: [10, 12], total: 4, capped: false });
  const url = new URL(fetchMock.mock.calls[0].arguments[0]);
  assert.equal(url.pathname, '/search/results/');
  assert.equal(url.searchParams.get('publisher'), 'Foo, Inc.');
  assert.equal(url.searchParams.get('category1'), '998');
  assert.equal(url.searchParams.get('count'), '100');
});

test('searchCreatorGames: capped once Steam has more than one page', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ total_count: 101, start: 0, results_html: creatorRow('App_10') }),
  }));
  assert.equal((await searchCreatorGames('developer', 'Foo')).capped, true);
});

test('searchCreatorGames: cache key keeps the case, as Steam matches it', async (t) => {
  _reset();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ total_count: 1, start: 0, results_html: creatorRow('App_10') }),
  }));
  await searchCreatorGames('developer', 'Foo');
  await searchCreatorGames('developer', 'Foo');
  await searchCreatorGames('developer', 'FOO');
  assert.equal(fetchMock.mock.callCount(), 2);
});

test('searchCreatorGames: force bypasses the cache', async (t) => {
  _reset();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ total_count: 1, start: 0, results_html: creatorRow('App_10') }),
  }));
  await searchCreatorGames('developer', 'Foo');
  await searchCreatorGames('developer', 'Foo', { force: true });
  assert.equal(fetchMock.mock.callCount(), 2);
});

test('searchCreatorGames: no match is an empty list on the short miss expiry', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ total_count: 0, start: -1, results_html: '' }),
  }));
  assert.deepEqual(await searchCreatorGames('developer', 'Nobody'), { appids: [], total: 0, capped: false });
  const { expires } = db.prepare('SELECT expires FROM cache_search WHERE key = ?').get('creator:developer:Nobody');
  assert.ok(expires - Date.now() <= MISS_CACHE_TTL_MS);
});

test('searchCreatorGames: an unexpected reply shape throws isUpstream and caches nothing', async (t) => {
  _reset();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ success: 1 }) }));
  await assert.rejects(
    () => searchCreatorGames('developer', 'Foo'),
    (err) => err.isUpstream === true,
  );
  await assert.rejects(() => searchCreatorGames('developer', 'Foo'));
  assert.equal(fetchMock.mock.callCount(), 2);
});

test('searchCreatorGames: throws isUpstream when fetch fails', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));
  await assert.rejects(
    () => searchCreatorGames('developer', 'Foo'),
    (err) => err.isUpstream === true,
  );
});

// ── getGameSchema ─────────────────────────────────────────────────────────────

test('getGameSchema: extracts the game name and achievement fields', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({
      game: {
        gameName: 'Deus Ex Human Revolution',
        availableGameStats: {
          achievements: [
            {
              name: 'ACH_WIN',
              displayName: 'Winner',
              description: 'Win a match',
              icon: 'a.jpg',
              icongray: 'a_gray.jpg',
              hidden: 0,
            },
          ],
        },
      },
    }),
  }));
  const result = await getGameSchema(400);
  assert.deepEqual(result, {
    name: 'Deus Ex Human Revolution',
    achievements: [
      {
        apiname: 'ACH_WIN',
        name: 'Winner',
        description: 'Win a match',
        icon: 'a.jpg',
        icongray: 'a_gray.jpg',
        hidden: false,
      },
    ],
  });
});

const LEGACY_ICON = 'https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/400/abc.jpg';
const NEW_ICON = 'https://shared.fastly.steamstatic.com/community_assets/images/apps/400/abc.jpg';

test('getGameSchema: moves legacy-CDN icons to the host that has them, leaving other values alone', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({
      game: {
        availableGameStats: {
          achievements: [
            { name: 'A', icon: LEGACY_ICON, icongray: LEGACY_ICON },
            { name: 'B', icon: 'https://example.com/b.jpg', icongray: null },
          ],
        },
      },
    }),
  }));
  const [a, b] = (await getGameSchema(400)).achievements;
  assert.equal(a.icon, NEW_ICON);
  assert.equal(a.icongray, NEW_ICON);
  assert.equal(b.icon, 'https://example.com/b.jpg');
  assert.equal(b.icongray, null);
});

test('getGameSchema: fixes legacy-CDN icons already in the cache without refetching', async (t) => {
  _reset();
  setCache('gameschema:400', {
    name: 'X',
    achievements: [
      { apiname: 'A', name: 'A', icon: LEGACY_ICON, icongray: LEGACY_ICON, hidden: false },
      { apiname: 'B', name: 'B', hidden: false },
    ],
  });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('should not fetch');
  });
  const [a, b] = (await getGameSchema(400)).achievements;
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(a.icon, NEW_ICON);
  assert.equal(a.icongray, NEW_ICON);
  assert.deepEqual(b, { apiname: 'B', name: 'B', hidden: false });
});

test('getGameSchema: returns no name and no achievements for an empty schema', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ game: {} }) }));
  assert.deepEqual(await getGameSchema(400), { name: null, achievements: [] });
});

test('getGameSchema: caches result — second call skips fetch', async (t) => {
  _reset();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ game: {} }) }));
  await getGameSchema(400);
  await getGameSchema(400);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('getGameSchema: throws isUpstream when fetch fails', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));
  await assert.rejects(
    () => getGameSchema(400),
    (err) => err.isUpstream === true,
  );
});

test('getGameSchema: returns no achievements (not throw) on a 403 with a JSON body — no schema published for this appid', async (t) => {
  _reset();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({
    ok: false,
    status: 403,
    text: async () => '{"game":{}}',
  }));
  assert.deepEqual(await getGameSchema(400), { name: null, achievements: [] });
  // Cached, so an unreleased game doesn't cost an upstream call on every panel open.
  assert.deepEqual(await getGameSchema(400), { name: null, achievements: [] });
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('getGameSchema: throws isUpstream on a 403 with an HTML body — a rejected key, not a missing schema', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: false,
    status: 403,
    text: async () => '<html><head><title>Forbidden</title></head><body>Access is denied.</body></html>',
  }));
  await assert.rejects(
    () => getGameSchema(400),
    (err) => err.isUpstream === true && /key rejected/.test(err.message),
  );
});

// ── getPlayerAchievements ─────────────────────────────────────────────────────

test('getPlayerAchievements: extracts achieved state and unlocktime', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({
      playerstats: {
        success: true,
        achievements: [
          { apiname: 'ACH_WIN', achieved: 1, unlocktime: 1700000000 },
          { apiname: 'ACH_LOSE', achieved: 0, unlocktime: 0 },
        ],
      },
    }),
  }));
  const result = await getPlayerAchievements('7656119123456789', 400);
  assert.deepEqual(result, [
    { apiname: 'ACH_WIN', achieved: true, unlocktime: 1700000000 },
    { apiname: 'ACH_LOSE', achieved: false, unlocktime: 0 },
  ]);
});

test('getPlayerAchievements: returns null (not throw) on 400 — game has no stats', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 400 }));
  assert.equal(await getPlayerAchievements('7656119123456789', 400), null);
});

test('getPlayerAchievements: returns null (not throw) on 403 — private profile', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 403 }));
  assert.equal(await getPlayerAchievements('7656119123456789', 400), null);
});

test('getPlayerAchievements: returns null when success is false', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ playerstats: { success: false } }),
  }));
  assert.equal(await getPlayerAchievements('7656119123456789', 400), null);
});

test('getPlayerAchievements: throws isUpstream for a non-400/403 error', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));
  await assert.rejects(
    () => getPlayerAchievements('7656119123456789', 400),
    (err) => err.isUpstream === true,
  );
});

test('getPlayerAchievements: caches result — second call skips fetch', async (t) => {
  _reset();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ playerstats: { success: true, achievements: [] } }),
  }));
  await getPlayerAchievements('7656119123456789', 400);
  await getPlayerAchievements('7656119123456789', 400);
  assert.equal(fetchMock.mock.callCount(), 1);
});

// ── getGlobalAchievementPercentages ──────────────────────────────────────────

test('getGlobalAchievementPercentages: maps apiname to percent as a number', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({
      achievementpercentages: {
        achievements: [
          { name: 'PORTAL_GET_PORTALGUNS', percent: '80.9' },
          { name: 'PORTAL_LONGJUMP', percent: '14.1' },
        ],
      },
    }),
  }));
  const result = await getGlobalAchievementPercentages(400);
  assert.deepEqual(result, { PORTAL_GET_PORTALGUNS: 80.9, PORTAL_LONGJUMP: 14.1 });
});

test('getGlobalAchievementPercentages: returns null (not throw) on 403 — no stats or unknown appid', async (t) => {
  _reset();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 403 }));
  assert.equal(await getGlobalAchievementPercentages(400), null);
  assert.equal(await getGlobalAchievementPercentages(400), null);
  assert.equal(fetchMock.mock.callCount(), 1, 'the cached miss answered the second call');
});

test('getGlobalAchievementPercentages: throws isUpstream for a non-403 error', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));
  await assert.rejects(
    () => getGlobalAchievementPercentages(400),
    (err) => err.isUpstream === true,
  );
});

test('getGlobalAchievementPercentages: caches result — second call skips fetch', async (t) => {
  _reset();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ achievementpercentages: { achievements: [] } }),
  }));
  await getGlobalAchievementPercentages(400);
  await getGlobalAchievementPercentages(400);
  assert.equal(fetchMock.mock.callCount(), 1);
});

// ── getGameNews ────────────────────────────────────────────────────────────────

test('getGameNews: extracts title, url, date and feedLabel, capped at 20', async (t) => {
  _reset();
  const newsitems = Array.from({ length: 25 }, (_, i) => ({
    gid: String(i),
    title: `Update ${i}`,
    url: `https://store.steampowered.com/news/app/400/view/${i}`,
    date: 1700000000 + i,
    feedlabel: 'Community Announcements',
    feedname: 'steam_community_announcements',
    contents: 'ignored',
  }));
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ appnews: { appid: 400, newsitems, count: 25 } }),
  }));

  const result = await getGameNews(400);
  assert.equal(result.length, 20);
  assert.deepEqual(result[0], {
    title: 'Update 0',
    url: 'https://store.steampowered.com/news/app/400/view/0',
    date: 1700000000,
    feedLabel: 'Community Announcements',
  });
});

test('getGameNews: filters out syndicated third-party press, keeping only steam_community_announcements', async (t) => {
  _reset();
  const newsitems = [
    {
      title: 'Пресса на русском',
      url: 'https://x/1',
      date: 1700000002,
      feedlabel: 'Gamemag.ru',
      feedname: 'Gamemag.ru',
    },
    {
      title: 'RPS coverage',
      url: 'https://x/2',
      date: 1700000001,
      feedlabel: 'Rock, Paper, Shotgun',
      feedname: 'Rock, Paper, Shotgun',
    },
    {
      title: 'Official patch notes',
      url: 'https://x/3',
      date: 1700000000,
      feedlabel: 'Community Announcements',
      feedname: 'steam_community_announcements',
    },
  ];
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ appnews: { newsitems } }),
  }));

  const result = await getGameNews(400);
  assert.equal(result.length, 1);
  assert.equal(result[0].title, 'Official patch notes');
});

test('getGameNews: returns empty array when newsitems is missing', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ appnews: { appid: 400, count: 0 } }),
  }));
  assert.deepEqual(await getGameNews(400), []);
});

test('getGameNews: a reply of another shape is an upstream error, not cached', async (t) => {
  _reset();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return { ok: true, json: async () => (calls === 1 ? {} : { appnews: { newsitems: {} } }) };
  });
  for (let i = 0; i < 2; i++) await assert.rejects(() => getGameNews(400), { isUpstream: true });
  assert.equal(calls, 2);
});

test('getGameNews: feedLabel is null when absent', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({
      appnews: {
        newsitems: [
          { title: 'Update', url: 'https://x/1', date: 1700000000, feedname: 'steam_community_announcements' },
        ],
      },
    }),
  }));
  const result = await getGameNews(400);
  assert.equal(result[0].feedLabel, null);
});

test('getGameNews: throws isUpstream when fetch fails', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));
  await assert.rejects(
    () => getGameNews(400),
    (err) => err.isUpstream === true,
  );
});

test('getGameNews: caches result — second call skips fetch', async (t) => {
  _reset();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ appnews: { newsitems: [] } }),
  }));
  await getGameNews(400);
  await getGameNews(400);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('resolveSteamId: caches a failed lookup and re-throws it without a second upstream call', async (t) => {
  _reset();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return { ok: true, json: async () => ({ response: { success: 42 } }) };
  });
  await assert.rejects(() => resolveSteamId('nope'), /Cannot find Steam account/);
  await assert.rejects(() => resolveSteamId('nope'), /Cannot find Steam account/);
  assert.equal(calls, 1, 'the cached miss answered the second call');
});

const browseItem = (fields) => ({ success: 1, name: 'Game', type: 0, basic_info: {}, assets: {}, ...fields });

test('gameBasics: converts a browse item to appdetails shapes', () => {
  const basics = gameBasics(
    browseItem({
      basic_info: { short_description: 'Desc', developers: [{ name: 'Dev' }], publishers: [{ name: 'Pub' }] },
      release: { steam_release_date: 1303186800 },
      platforms: { windows: true, mac: true, steamos_linux: true },
      assets: { asset_url_format: 'steam/apps/620/${FILENAME}?t=1', small_capsule: 'a/c.jpg', header: 'h.jpg' },
    }),
    620,
  );
  assert.deepEqual(basics, {
    name: 'Game',
    type: 'game',
    capsule: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/620/a/c.jpg?t=1',
    thumb: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/620/a/c.jpg?t=1',
    banner: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/620/h.jpg?t=1',
    description: 'Desc',
    releaseDate: 'Apr 18, 2011', // Steam's Pacific date; Apr 19 in UTC
    comingSoon: false,
    platforms: ['Windows', 'Mac', 'Linux'],
    developers: ['Dev'],
    publishers: ['Pub'],
  });
});

test('gameBasics: an unconfirmed type and a coming-soon date short of a full one stay null', () => {
  const basics = gameBasics(
    browseItem({
      type: 7,
      release: { steam_release_date: 1830000000, is_coming_soon: true, coming_soon_display: 'date_quarter' },
    }),
    1,
  );
  assert.equal(basics.type, null);
  assert.equal(basics.releaseDate, null);
  assert.equal(basics.comingSoon, true);
});

test('gameBasics: an item cached before basics were requested falls back to cached appdetails, never fetching', (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('should not fetch');
  });
  assert.equal(gameBasics({ success: 1, tagids: [] }, 640), null);
  setCache('meta:640', { name: 'Cached', type: 'game', release_date: { date: 'Jan 1, 2020' }, developers: ['D'] });
  const basics = gameBasics({ success: 1, tagids: [] }, 640);
  assert.equal(basics.name, 'Cached');
  assert.equal(basics.releaseDate, 'Jan 1, 2020');
  assert.deepEqual(basics.developers, ['D']);
  assert.equal('genres' in basics, false);
});
