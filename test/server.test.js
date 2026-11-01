'use strict';

// Set env before requiring the app so module-level reads see test values.
process.env.STEAM_API_KEY = 'test-key';
process.env.NODE_ENV = 'test';
// Force the in-memory DB regardless of how this file is invoked — `npm test`
// already does this via a shell-level `DB_FILE=`, but running this file
// directly (e.g. `node --test test/server.test.js`, an IDE test runner) would
// otherwise fall through to default.env's DB_FILE=db.sqlite and let _reset()
// wipe the real cache.
process.env.DB_FILE = '';

const { beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { until } = require('./until');
const { freshNonce } = require('./openidNonce');
const http = require('node:http');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const supertest = require('supertest');
const morgan = require('morgan');
const { app } = require('../server');
const { _reset, setCache, getCachedAt, getCacheEntryCounts } = require('../lib/cache');
const { db } = require('../lib/db');
const { PREFS_MAX_BYTES, SYNCED_PREF_KEYS, getUserPrefs, setUserPref } = require('../lib/auth');
const { _resetAuth } = require('../lib/hltb');
const { _resetTagNameMap } = require('../lib/steam');
const { _resetCircuitBreakers } = require('../lib/circuitBreaker');
const { SESSION_TTL_MS, MISS_CACHE_TTL_MS } = require('../lib/config');
const { getMetrics } = require('../lib/metrics');
const { getSemaphoreStats } = require('../lib/upstream');

// The tag-name map's failure hold-off outlives _reset(), which only empties the cache.
beforeEach(_resetTagNameMap);

const api = supertest(app);

// Fixed Steam64 IDs that bypass the vanity-URL resolve step.
const ID1 = '76561198000000001';
const ID2 = '76561198000000002';
// ITAD game ids, the UUIDs the gid routes accept.
const GID1 = '018d937f-07a2-7270-8a54-6fd2c8f3c4b1';
const GID2 = '018d937f-07a2-7270-8a54-6fd2c8f3c4b2';

function makeLibraryFetch(games1 = [], games2 = []) {
  return async (url) => {
    if (url.includes('GetOwnedGames') && url.includes(ID1)) {
      return { ok: true, json: async () => ({ response: { games: games1 } }) };
    }
    if (url.includes('GetOwnedGames') && url.includes(ID2)) {
      return { ok: true, json: async () => ({ response: { games: games2 } }) };
    }
    if (url.includes('GetPlayerSummaries')) {
      const players = [ID1, ID2].map((id) => ({ steamid: id, personaname: id, profileurl: '' }));
      return { ok: true, json: async () => ({ response: { players } }) };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

// Fixture tag ids/names shared across tests — Steam tags are now fetched as an
// (appid → tagids) call plus a separate, shared (tagid → name) map.
const TAG_IDS = [1001, 1002];
const TAG_NAME_MAP = { 1001: 'Action', 1002: 'Co-op' };
// The demo link (extractDemoAppid) rides on the exact same IStoreBrowseService item as the
// tagids above — see the `tagsOk` flag below, which gates both.
const DEMO_APPID = 999900;

// `media`: the store page lists a screenshot and a trailer.
function makeDetailsFetch({ ratingOk = true, metaOk = true, tagsOk = true, type, media = false } = {}) {
  return async (url) => {
    if (url.includes('GetAppReviews')) {
      if (!ratingOk) return { ok: false, status: 503 };
      return {
        ok: true,
        json: async () => ({
          response: { query_summary: { total_reviews: 1000, total_positive: 900, review_score_desc: 'Very Positive' } },
        }),
      };
    }
    if (url.includes('IStoreBrowseService')) {
      if (!tagsOk) return { ok: false, status: 503 };
      return {
        ok: true,
        json: async () => ({
          response: { store_items: [{ success: 1, tagids: TAG_IDS, related_items: { demo_appid: [DEMO_APPID] } }] },
        }),
      };
    }
    if (url.includes('ajaxgetstoretags')) {
      if (!tagsOk) return { ok: false, status: 503 };
      return {
        ok: true,
        json: async () => ({
          tags: Object.entries(TAG_NAME_MAP).map(([tagid, name]) => ({ tagid: Number(tagid), name })),
        }),
      };
    }
    if (url.includes('appdetails')) {
      if (!metaOk) return { ok: false, status: 503 };
      const appid = url.match(/appids=(\d+)/)?.[1];
      return {
        ok: true,
        json: async () => ({
          [appid]: {
            success: true,
            data: {
              name: 'Portal',
              type,
              genres: [{ id: '1', description: 'Action' }],
              categories: [{ id: '9', description: 'Co-op' }],
              developers: ['Valve'],
              publishers: ['Valve'],
              ...(media && {
                screenshots: [{ id: 0, path_thumbnail: 'thumb.jpg', path_full: 'full.jpg' }],
                movies: [{ id: 1, name: 'Trailer', thumbnail: 'poster.jpg', hls_h264: 'trailer.m3u8' }],
              }),
            },
          },
        }),
      };
    }
    if (url.includes('protondb.com')) {
      return { ok: true, json: async () => ({ tier: 'gold', confidence: 'strong', total: 500 }) };
    }
    if (url.includes('GetNewsForApp')) {
      return {
        ok: true,
        json: async () => ({
          appnews: {
            newsitems: [
              {
                title: 'Patch 1.2 released',
                url: 'https://store.steampowered.com/news/app/1/view/123',
                date: 1700000000,
                feedlabel: 'Community Announcements',
                feedname: 'steam_community_announcements',
              },
            ],
          },
        }),
      };
    }
    if (url.includes('search/site/init')) {
      return { ok: true, json: async () => ({ token: 'tok', hpKey: 'k', hpVal: 'v' }) };
    }
    if (url.includes('search/site')) {
      return { ok: true, json: async () => ({ data: [{ game_name: 'Portal', comp_main: 36000, comp_plus: 72000 }] }) };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

// ── GET /api/health ───────────────────────────────────────────────────────────

test('GET /api/health: 200 with ok=true, configured=true, and cache stats', async () => {
  const res = await api.get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.configured, true);
  assert.equal(typeof res.body.cache?.entries, 'number');
});

test('GET /api/health: names the running build and when it started', async () => {
  const res = await api.get('/api/health');
  assert.equal(res.body.version, require('../package.json').version);
  assert.match(res.body.commit, /^[0-9a-f]{7,}$/); // the suite runs in a git checkout
  assert.equal(res.body.since, (await api.get('/api/metrics')).body.since);
});

test('GET /api/health: configured=false when STEAM_API_KEY is absent', async (t) => {
  const saved = process.env.STEAM_API_KEY;
  delete process.env.STEAM_API_KEY;
  t.after(() => {
    process.env.STEAM_API_KEY = saved;
  });

  const res = await api.get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.configured, false);
});

// ── GET /opensearch.xml ────────────────────────────────────────────────────────

test('GET /opensearch.xml: 200 with a search template built from the request host', async () => {
  const res = await api.get('/opensearch.xml');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /application\/opensearchdescription\+xml/);
  assert.match(res.text, /<ShortName>Playshelf<\/ShortName>/);
  assert.match(res.text, /<Url type="text\/html" template="http:\/\/[^"]+\/search\?q=\{searchTerms\}"\/>/);
});

// ── SPA fallback (public/index.html serves every client-routed path) ───────────

test('GET /some/client-side/route: 200 with the app shell HTML, not a 404', async () => {
  const res = await api.get('/lists/owned');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /html/);
});

test('GET / and /lists/owned: the app shell carries Open Graph tags with an absolute image URL, for chat link previews', async () => {
  for (const route of ['/', '/lists/owned']) {
    const res = await api.get(route).set('Host', 'app.example');
    assert.match(res.text, /<meta property="og:title" content="Playshelf" \/>/);
    assert.match(res.text, /<meta property="og:description" content="Explore Steam libraries [^"]+" \/>/);
    assert.match(res.text, /<meta property="og:image" content="http:\/\/app\.example\/og-image\.jpg" \/>/);
    assert.match(res.text, /<meta name="twitter:card" content="summary_large_image" \/>/);
  }
});

test('GET /game/:appid: the preview names and describes a cached game and shows its header image, without fetching', async (t) => {
  _reset();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => assert.fail('no upstream request'));
  setCache('meta:620', {
    name: 'Portal <2> & "co"',
    header_image: 'https://cdn.example/620/header.jpg',
    short_description: 'Think with &quot;portals&quot; &amp; &#8220;cake&#x201D; &amp;lt; &#9999999;',
  });
  const res = await api.get('/game/620');
  assert.match(res.text, /<meta property="og:title" content="Portal &lt;2&gt; &amp; &quot;co&quot;" \/>/);
  assert.match(res.text, /<meta property="og:image" content="https:\/\/cdn\.example\/620\/header\.jpg" \/>/);
  // Steam's entities decoded once, then escaped once: no `&amp;quot;` showing literally.
  const description = 'Think with &quot;portals&quot; &amp; “cake” &amp;lt; &amp;#9999999;';
  assert.ok(res.text.includes(`<meta property="og:description" content="${description}" />`));
  assert.ok(res.text.includes(`<meta name="description" content="${description}" />`));

  setCache('meta:622', { name: null, header_image: null, short_description: null });
  const nulls = await api.get('/game/622');
  assert.equal(nulls.status, 200);
  assert.match(nulls.text, /<meta property="og:title" content="Playshelf" \/>/);
  assert.match(nulls.text, /<meta property="og:description" content="Explore Steam libraries [^"]+" \/>/);

  const uncached = await api.get('/game/621');
  assert.match(uncached.text, /<meta property="og:title" content="Playshelf" \/>/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('GET /lists/bundle/:id: the preview names and describes a cached bundle of any region, without fetching', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => assert.fail('no upstream request'));
  const bundle = {
    id: 42,
    title: 'Narrative & Co Bundle',
    page: { name: 'Humble Bundle' },
    expiry: '2099-03-05T18:00:00Z',
    counts: { games: 8 },
    tiers: [{ games: [{ assets: {} }, { assets: { banner600: 'https://cdn.example/b600.jpg' } }] }],
  };
  // Found on the DE list's second page, as a visitor in the euro region cached it.
  const page = (bundles, offset) => [`itad-bundles:DE:-publish:false:${offset}:50`, { value: bundles, ts: Date.now() }];
  _reset([
    page(
      Array.from({ length: 50 }, (_, i) => ({ id: 1000 + i })),
      0,
    ),
    page([bundle], 50),
  ]);
  const res = await api.get('/lists/bundle/42');
  assert.match(res.text, /<meta property="og:title" content="Narrative &amp; Co Bundle" \/>/);
  assert.match(res.text, /<meta property="og:description" content="8 games · Humble Bundle · ends Mar 5, 2099" \/>/);
  assert.match(res.text, /<meta property="og:image" content="https:\/\/cdn\.example\/b600\.jpg" \/>/);

  const uncached = await api.get('/lists/bundle/43');
  assert.match(uncached.text, /<meta property="og:title" content="Playshelf" \/>/);

  // An ended bundle without games, on a cached page past an evicted one.
  const ended = { id: 44, title: 'Old', expiry: '2001-01-02T12:00:00Z', counts: { games: 1 } };
  _reset([[`itad-bundles:US:-publish:true:50:50`, { value: [ended], ts: Date.now() }]]);
  const old = await api.get('/lists/bundle/44');
  assert.equal(old.status, 200);
  assert.match(old.text, /<meta property="og:description" content="1 game · ended Jan 2, 2001" \/>/);
  assert.match(old.text, /<meta property="og:image" content="http:\/\/[^"]+\/og-image\.jpg" \/>/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("GET /lists/bundle/:id: a pick-and-mix bundle's preview takes Fanatical's end date from the cached feed", async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => assert.fail('no upstream request'));
  const bundle = {
    id: 45,
    title: 'Build Your Own Killer Bundle',
    page: { name: 'Fanatical' },
    url: 'https://www.fanatical.com/en/pick-and-mix/byo-killer',
    expiry: '2001-01-02T12:00:00Z',
    counts: { games: 30 },
    tiers: [{ price: null, games: [] }],
  };
  _reset([
    [`itad-bundles:US:-publish:true:0:50`, { value: [bundle], ts: Date.now() }],
    [
      'fanatical-pnm:v3',
      { value: { 'byo-killer': { tiers: [], products: [], validUntil: '2099-11-13T23:59:00.000Z' } }, ts: Date.now() },
    ],
  ]);
  const res = await api.get('/lists/bundle/45');
  assert.match(res.text, /<meta property="og:description" content="30 games · Fanatical · ends Nov 13, 2099" \/>/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('GET /lists/*?game=: a list opened on a cached game previews that game, before the list itself', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => assert.fail('no upstream request'));
  _reset();
  setCache('meta:620', { name: 'Portal 2', header_image: 'https://cdn.example/620.jpg', short_description: 'Think' });
  for (const route of ['/lists/owned?u=76561197960287930&game=620', '/lists/bundle/42?game=620&game=1']) {
    const res = await api.get(route);
    assert.match(res.text, /<meta property="og:title" content="Portal 2" \/>/, route);
  }
  for (const route of ['/lists/owned?game=-1', '/lists/owned?game=abc', '/about?game=620']) {
    const res = await api.get(route);
    assert.match(res.text, /<meta property="og:title" content="Playshelf" \/>/, route);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

// Two cached players (one known by a vanity name) and one only Steam could name.
const ALICE = '76561197960287930';
const BOB = '76561197960287931';
const seedPlayers = () =>
  _reset([
    [
      `player:${ALICE}`,
      {
        value: { personaname: 'Alice', avatarfull: 'https://avatars.example/a.jpg', realname: 'A. Secret' },
        ts: Date.now(),
      },
    ],
    [`player:${BOB}`, { value: { personaname: 'Bob', avatarfull: 'https://avatars.example/b.jpg' }, ts: Date.now() }],
    ['resolve:bobby', { value: BOB, ts: Date.now() }],
    ['resolve:nobody', { value: null, ts: Date.now() }],
  ]);

test('GET /lists/owned|wishlist?u=: names a cached account, with its avatar in a small card', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => assert.fail('no upstream request'));
  seedPlayers();
  const owned = await api.get(`/lists/owned?u=${ALICE}`);
  assert.match(owned.text, /<meta property="og:title" content="Alice's Library" \/>/);
  assert.match(owned.text, /<meta property="og:description" content="Alice's Steam games, with [^"]+" \/>/);
  assert.match(owned.text, /<meta property="og:image" content="https:\/\/avatars\.example\/a\.jpg" \/>/);
  assert.match(owned.text, /<meta name="twitter:card" content="summary" \/>/);
  assert.doesNotMatch(owned.text, /Secret/);

  // A profile URL, a vanity name, and a Family (no single avatar).
  const wishlist = await api.get('/lists/wishlist?u=https://steamcommunity.com/id/bobby/');
  assert.match(wishlist.text, /<meta property="og:title" content="Bob's Wishlist" \/>/);
  const family = await api.get(`/lists/owned?u=${ALICE},bobby`);
  assert.match(family.text, /<meta property="og:title" content="Alice \+ Bob's Library" \/>/);
  assert.match(family.text, /<meta name="twitter:card" content="summary_large_image" \/>/);

  // No account, several slots, a cached miss, an unknown vanity name, an unnamed steam64: the site card.
  for (const route of [
    '/lists/owned',
    `/lists/owned?u=${ALICE}&u=${BOB}`,
    '/lists/owned?u=nobody',
    '/lists/owned?u=stranger',
    '/lists/wishlist?u=76561197960287999',
  ]) {
    const res = await api.get(route);
    assert.match(res.text, /<meta property="og:title" content="Playshelf" \/>/, route);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('GET /lists/compare?u=&u=: names every cached player, as the page does', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => assert.fail('no upstream request'));
  seedPlayers();
  const res = await api.get(`/lists/compare?u=${ALICE}&u=bobby`);
  assert.match(res.text, /<meta property="og:title" content="Alice vs\. Bob" \/>/);
  assert.match(
    res.text,
    /<meta property="og:description" content="The Steam games Alice and Bob own, together and apart\." \/>/,
  );

  const many = Array.from({ length: 9 }, () => `u=${ALICE}`).join('&');
  for (const route of [`/lists/compare?u=${ALICE}`, `/lists/compare?u=${ALICE}&u=stranger`, `/lists/compare?${many}`]) {
    const other = await api.get(route);
    assert.match(other.text, /<meta property="og:title" content="Playshelf" \/>/, route);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('index.html links the SVG favicon, and raster icons, which link previews fall back to', () => {
  // The source, not the served shell: that one is a possibly stale dist/ build when one exists.
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg" \/>/);
  assert.ok(fs.existsSync(path.join(__dirname, '../static/favicon.svg')));
  assert.match(html, /<link rel="icon" type="image\/png" sizes="512x512" href="\/icon-512\.png" \/>/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png" \/>/);
});

test('GET /api/nonexistent-route: still 404s — the SPA fallback never shadows /api/*', async () => {
  const res = await api.get('/api/nonexistent-route');
  assert.equal(res.status, 404);
});

test('GET /some/path/that/looks/like/an/asset.js: 404s instead of being rewritten to the app shell', async () => {
  const res = await api.get('/some/path/that/looks/like/an/asset.js');
  assert.equal(res.status, 404);
});

// ── GET /api/metrics ───────────────────────────────────────────────────────────

test('GET /api/metrics: 200 with a since timestamp and per-group/label request counts', async (t) => {
  const GAME = { appid: 400, name: 'Portal' };
  t.mock.method(globalThis, 'fetch', makeLibraryFetch([GAME], []));
  await api.post('/api/common-games').send({ members: [ID1, ID2] });

  const res = await api.get('/api/metrics');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.since, 'number');
  const label = res.body.sinceRestart.groups['steam-api'].getOwnedGames;
  assert.ok(label.requests >= 1);
  assert.equal(typeof label.statusCounts, 'object');
  assert.equal(label.networkErrors, 0);
  assert.equal(typeof label.avgLatencyMs, 'number');
  assert.equal(typeof label.maxLatencyMs, 'number');
  assert.ok(res.body.lastHour.groups['steam-api'].getOwnedGames.requests >= 1);
  assert.equal(res.body.circuitBreakers['steam-store'].blockedUntil, 0);
  assert.equal(typeof res.body.circuitBreakers['steam-store'].tripCount, 'number');
  assert.equal(res.body.circuitBreakers['steam-store'].consecutive403s, 0);
  assert.deepEqual(Object.keys(res.body.circuitBreakers).sort(), ['hltb', 'protondb', 'steam-store']);
});

test('GET /api/metrics: includes semaphore, cache hit/entry, rate-limiter, and dedup stats', async (t) => {
  _reset();
  const GAME = { appid: 400, name: 'Portal' };
  t.mock.method(globalThis, 'fetch', makeLibraryFetch([GAME], []));
  await api.post('/api/common-games').send({ members: [ID1, ID2] });

  const res = await api.get('/api/metrics');
  assert.equal(res.status, 200);
  for (const name of ['store', 'tag', 'proton', 'hltb', 'itad-info']) {
    assert.equal(typeof res.body.semaphores[name].active, 'number');
    assert.equal(typeof res.body.semaphores[name].queued, 'number');
    assert.equal(typeof res.body.semaphores[name].maxQueueSeen, 'number');
    assert.equal(res.body.semaphores[name].rejected, 0);
  }
  // Only groups actually touched by this request are present — resolveSteamId short-circuits
  // on an already-Steam64 id without a cache read, so 'resolve' never shows up here, but
  // getOwnedGames/getPlayerSummaries do (games:/player: — both 'library'), same "absent when
  // never called" convention the rest of lib/metrics.js already uses.
  assert.equal(typeof res.body.sinceRestart.cacheHits.library.hits, 'number');
  assert.equal(typeof res.body.sinceRestart.cacheHits.library.misses, 'number');
  assert.equal(typeof res.body.sinceRestart.cacheHits.library.forced, 'number');
  assert.equal(typeof res.body.lastHour.cacheHits.library.hits, 'number');
  // cacheEntries, unlike cacheHits, always lists every group (a db.sqlite row count, not an
  // in-memory-since-restart counter — see lib/cache.js's getCacheEntryCounts).
  for (const label of ['library', 'resolve', 'rating', 'meta', 'search', 'news', 'bundles']) {
    assert.equal(typeof res.body.cacheEntries[label], 'number');
  }
  assert.equal(typeof res.body.sinceRestart.rateLimiters, 'object');
  assert.equal(typeof res.body.sinceRestart.dedupHits, 'object');
  // Two accounts resolved in the same POST /api/common-games share the 'steam' dedup instance
  // for anything they both trigger concurrently — not asserted on an exact count here (that's
  // covered by lib/dedup.js's own unit tests), just that the field is wired through.
});

// ── POST /api/common-games — input validation ─────────────────────────────────

test('POST /api/common-games: 400 when body has no members field', async () => {
  const res = await api.post('/api/common-games').send({});
  assert.equal(res.status, 400);
});

test('POST /api/common-games: 400 for the old { slots } and { users } bodies', async () => {
  for (const body of [{ slots: [[ID1]] }, { users: [ID1] }]) {
    const res = await api.post('/api/common-games').send(body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test('POST /api/common-games: 400 when members is an empty array', async () => {
  const res = await api.post('/api/common-games').send({ members: [] });
  assert.equal(res.status, 400);
});

test('POST /api/common-games: 400 when a member value is null', async () => {
  const res = await api.post('/api/common-games').send({ members: [null, ID1] });
  assert.equal(res.status, 400);
});

test('POST /api/common-games: 400 when a member value is an empty string', async () => {
  const res = await api.post('/api/common-games').send({ members: ['', ID1] });
  assert.equal(res.status, 400);
});

test('POST /api/common-games: 400 when members exceeds MAX_USERS', async () => {
  // Default MAX_USERS is 10.
  const members = Array.from({ length: 11 }, (_, i) => `7656119800000000${i}`);
  const res = await api.post('/api/common-games').send({ members });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Too many users/);
});

// ── POST /api/common-games — happy path ──────────────────────────────────────

test('POST /api/common-games: 200 with the full library and player of a single account', async (t) => {
  _reset();
  const GAME = { appid: 400, name: 'Portal' };
  t.mock.method(globalThis, 'fetch', makeLibraryFetch([GAME], []));

  const res = await api.post('/api/common-games').send({ members: [ID1] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.games, [{ appid: 400, name: 'Portal' }]);
  assert.equal(res.body.players.length, 1);
  assert.equal(res.body.players[0].steamid, ID1);
  assert.equal(res.body.players[0].gameCount, 1, "gameCount reflects that account's own library size");
});

test("POST /api/common-games: games is the alphabetical union of a Family's libraries, playtime covers every owned game", async (t) => {
  _reset();
  const SHARED = { appid: 400, name: 'Portal', playtime_forever: 10 };
  const ONLY1 = { appid: 440, name: 'TF2', playtime_forever: 20 };
  const ONLY2 = { appid: 220, name: 'Half-Life 2', playtime_forever: 30 };
  t.mock.method(globalThis, 'fetch', makeLibraryFetch([ONLY1, SHARED], [SHARED, ONLY2]));

  const res = await api.post('/api/common-games').send({ members: [ID1, ID2] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.games, [
    { appid: 220, name: 'Half-Life 2' },
    { appid: 400, name: 'Portal' },
    { appid: 440, name: 'TF2' },
  ]);
  assert.deepEqual(
    res.body.players.map((p) => [p.steamid, p.gameCount]),
    [
      [ID1, 2],
      [ID2, 2],
    ],
  );
  // An account has an entry only for the games it owns.
  assert.deepEqual(res.body.playtime, { 220: { [ID2]: 30 }, 400: { [ID1]: 10, [ID2]: 10 }, 440: { [ID1]: 20 } });
});

test('POST /api/common-games: lastPlayed carries rtime_last_played per account, 0 when absent', async (t) => {
  _reset();
  const GAME1 = { appid: 400, name: 'Portal', rtime_last_played: 1751846400 };
  const GAME2 = { appid: 400, name: 'Portal' }; // no rtime_last_played from this account
  t.mock.method(globalThis, 'fetch', makeLibraryFetch([GAME1], [GAME2]));

  const res = await api.post('/api/common-games').send({ members: [ID1, ID2] });
  assert.equal(res.status, 200);
  assert.equal(res.body.lastPlayed[400][ID1], 1751846400);
  assert.equal(res.body.lastPlayed[400][ID2], 0);
});

test('POST /api/common-games: recentPlaytime carries playtime_2weeks per account, only where played', async (t) => {
  _reset();
  const GAME1 = { appid: 400, name: 'Portal', playtime_2weeks: 90 };
  const GAME2 = { appid: 400, name: 'Portal' }; // not played lately: Steam leaves the field out
  t.mock.method(globalThis, 'fetch', makeLibraryFetch([GAME1], [GAME2]));

  const res = await api.post('/api/common-games').send({ members: [ID1, ID2] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.recentPlaytime, { 400: { [ID1]: 90 } });
});

test('POST /api/common-games: recentPlaytime leaves out a library cached over 14 days ago, whose two weeks are long gone', async (t) => {
  _reset();
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 1) });
  t.mock.method(globalThis, 'fetch', makeLibraryFetch([{ appid: 400, name: 'Portal', playtime_2weeks: 90 }]));
  await api.post('/api/common-games').send({ members: [ID1] });

  t.mock.timers.setTime(Date.UTC(2026, 0, 14));
  const recent = await api.post('/api/common-games').send({ members: [ID1] });
  assert.deepEqual(recent.body.recentPlaytime, { 400: { [ID1]: 90 } });
  t.mock.timers.setTime(Date.UTC(2026, 0, 16));
  const stale = await api.post('/api/common-games').send({ members: [ID1] });
  assert.deepEqual(stale.body.recentPlaytime, {});
});

// ── POST /api/common-games — upstream / user errors ──────────────────────────

test('POST /api/common-games: 502 when Steam API returns a server error', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));

  const res = await api.post('/api/common-games').send({ members: [ID1, ID2] });
  assert.equal(res.status, 502);
});

test('POST /api/common-games: 502 when GetOwnedGames answers {}', async (t) => {
  _reset();
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('GetPlayerSummaries')) return { ok: true, json: async () => ({ response: { players: [] } }) };
    return { ok: true, json: async () => ({}) };
  });
  const res = await api.post('/api/common-games').send({ members: [ID1, ID2] });
  assert.equal(res.status, 502);
});

test('POST /api/common-games: 400 when a library is private', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('GetPlayerSummaries')) {
      return { ok: true, json: async () => ({ response: { players: [] } }) };
    }
    // No `games` field → steam.js throws the private-library error
    return { ok: true, json: async () => ({ response: {} }) };
  });

  const res = await api.post('/api/common-games').send({ members: [ID1, ID2] });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /private/);
});

// ── POST /api/wishlist — input validation ─────────────────────────────────────

test('POST /api/wishlist: 400 when body has no members field', async () => {
  const res = await api.post('/api/wishlist').send({});
  assert.equal(res.status, 400);
});

test('POST /api/wishlist: 400 when members is an empty array', async () => {
  const res = await api.post('/api/wishlist').send({ members: [] });
  assert.equal(res.status, 400);
});

test('POST /api/wishlist: 400 when a member value is an empty string', async () => {
  const res = await api.post('/api/wishlist').send({ members: [''] });
  assert.equal(res.status, 400);
});

test('POST /api/wishlist: 400 when members exceeds MAX_USERS', async () => {
  // Default MAX_USERS is 10.
  const members = Array.from({ length: 11 }, (_, i) => `7656119800000000${i}`);
  const res = await api.post('/api/wishlist').send({ members });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Too many users/);
});

// ── POST /api/wishlist — happy path ───────────────────────────────────────────

function makeWishlistFetch(items1 = [], items2 = []) {
  return async (url) => {
    if (url.includes('GetWishlist') && url.includes(ID1)) {
      return { ok: true, json: async () => ({ response: { items: items1 } }) };
    }
    if (url.includes('GetWishlist') && url.includes(ID2)) {
      return { ok: true, json: async () => ({ response: { items: items2 } }) };
    }
    if (url.includes('GetPlayerSummaries')) {
      const players = [ID1, ID2].map((id) => ({ steamid: id, personaname: id, profileurl: '' }));
      return { ok: true, json: async () => ({ response: { players } }) };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

test('POST /api/wishlist: 200 with items for a single account', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', makeWishlistFetch([{ appid: 400, priority: 1, date_added: 1433965886 }]));

  const res = await api.post('/api/wishlist').send({ members: [ID1] });
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].appid, 400);
  assert.equal(res.body.items[0].priority, 1);
  assert.equal(res.body.items[0].dateAdded, '2015-06-10');
  assert.equal(res.body.players.length, 1);
  assert.equal(res.body.players[0].itemCount, 1);
});

test('POST /api/wishlist: unions two accounts, dedupes shared appid keeping first-seen', async (t) => {
  _reset();
  t.mock.method(
    globalThis,
    'fetch',
    makeWishlistFetch(
      [{ appid: 400, priority: 1, date_added: 1433965886 }],
      [
        { appid: 400, priority: 5, date_added: 1500000000 },
        { appid: 440, priority: 2, date_added: 1500000000 },
      ],
    ),
  );

  const res = await api.post('/api/wishlist').send({ members: [ID1, ID2] });
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 2);
  const shared = res.body.items.find((i) => i.appid === 400);
  assert.equal(shared.priority, 1, 'first-seen account wins for a shared appid');
  assert.ok(res.body.items.some((i) => i.appid === 440));
});

test('POST /api/wishlist: an account with no items field contributes nothing', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('GetPlayerSummaries')) return { ok: true, json: async () => ({ response: { players: [] } }) };
    if (url.includes(ID1)) return { ok: true, json: async () => ({ response: {} }) }; // private/empty
    if (url.includes(ID2))
      return {
        ok: true,
        json: async () => ({ response: { items: [{ appid: 400, priority: 1, date_added: 1433965886 }] } }),
      };
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const res = await api.post('/api/wishlist').send({ members: [ID1, ID2] });
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].appid, 400);
});

test('POST /api/wishlist: 502 when Steam API returns a server error', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));

  const res = await api.post('/api/wishlist').send({ members: [ID1] });
  assert.equal(res.status, 502);
});

// ── POST /api/friends — input validation ──────────────────────────────────────

test('POST /api/friends: 400 when body has no members field', async () => {
  const res = await api.post('/api/friends').send({});
  assert.equal(res.status, 400);
});

test('POST /api/friends: 400 when members is an empty array', async () => {
  const res = await api.post('/api/friends').send({ members: [] });
  assert.equal(res.status, 400);
});

test('POST /api/friends: 400 when a member value is an empty string', async () => {
  const res = await api.post('/api/friends').send({ members: [''] });
  assert.equal(res.status, 400);
});

test('POST /api/friends: 400 when members exceeds MAX_USERS', async () => {
  // Default MAX_USERS is 10.
  const members = Array.from({ length: 11 }, (_, i) => `7656119800000000${i}`);
  const res = await api.post('/api/friends').send({ members });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Too many users/);
});

// ── POST /api/friends — happy path ────────────────────────────────────────────

const FRIEND1 = '76561198000000099';

function makeFriendsFetch(friendIds1 = [], friendIds2 = []) {
  return async (url) => {
    if (url.includes('GetFriendList') && url.includes(ID1)) {
      return {
        ok: true,
        json: async () => ({
          friendslist: { friends: friendIds1.map((id) => ({ steamid: id, relationship: 'friend', friend_since: 0 })) },
        }),
      };
    }
    if (url.includes('GetFriendList') && url.includes(ID2)) {
      return {
        ok: true,
        json: async () => ({
          friendslist: { friends: friendIds2.map((id) => ({ steamid: id, relationship: 'friend', friend_since: 0 })) },
        }),
      };
    }
    if (url.includes('GetPlayerSummaries')) {
      const ids = url.split('steamids=')[1].split(',');
      const players = ids.map((id) => ({
        steamid: id,
        personaname: id,
        profileurl: '',
        avatarfull: '',
        timecreated: 1433965886,
        loccountrycode: 'US',
        realname: `Real ${id}`,
      }));
      return { ok: true, json: async () => ({ response: { players } }) };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

test('POST /api/friends: 200 with friends for a single account', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', makeFriendsFetch([FRIEND1]));

  const res = await api.post('/api/friends').send({ members: [ID1] });
  assert.equal(res.status, 200);
  assert.equal(res.body.friends.length, 1);
  assert.equal(res.body.friends[0].steamid, FRIEND1);
  assert.equal(res.body.friends[0].timecreated, 1433965886);
  assert.equal(res.body.friends[0].loccountrycode, 'US');
  assert.equal(res.body.friends[0].realname, `Real ${FRIEND1}`);
  assert.deepEqual(res.body.unavailable, []);
});

test('POST /api/friends: unions two accounts, dedupes a shared friend', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', makeFriendsFetch([FRIEND1], [FRIEND1, '76561198000000098']));

  const res = await api.post('/api/friends').send({ members: [ID1, ID2] });
  assert.equal(res.status, 200);
  assert.equal(res.body.friends.length, 2);
});

test('POST /api/friends: reports a private friends list as unavailable rather than empty', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('GetFriendList') && url.includes(ID1)) return { ok: false, status: 401 };
    if (url.includes('GetFriendList') && url.includes(ID2))
      return { ok: true, json: async () => ({ friendslist: { friends: [{ steamid: FRIEND1 }] } }) };
    if (url.includes('GetPlayerSummaries'))
      return {
        ok: true,
        json: async () => ({ response: { players: [{ steamid: FRIEND1, personaname: FRIEND1, profileurl: '' }] } }),
      };
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const res = await api.post('/api/friends').send({ members: [ID1, ID2] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.unavailable, [ID1]);
  assert.equal(res.body.friends.length, 1);
});

test('POST /api/friends: 502 when Steam API returns a server error', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));

  const res = await api.post('/api/friends').send({ members: [ID1] });
  assert.equal(res.status, 502);
});

// ── GET /api/game-details/:appid — input validation ──────────────────────────

test('GET /api/game-details/abc: 400 for non-numeric appid', async () => {
  const res = await api.get('/api/game-details/abc');
  assert.equal(res.status, 400);
});

test('GET /api/game-details/0: 400 for zero appid', async () => {
  const res = await api.get('/api/game-details/0');
  assert.equal(res.status, 400);
});

test('GET /api/game-details/-1: 400 for negative appid', async () => {
  const res = await api.get('/api/game-details/-1');
  assert.equal(res.status, 400);
});

// ── GET /api/game-details/:appid — happy path ────────────────────────────────

test('GET /api/game-details/:appid: 200 from cache without fetching', async (t) => {
  _reset();
  setCache('rating:400', { total_reviews: 1000, total_positive: 900, review_score_desc: 'Very Positive' });
  setCache('hltb:400', [{ game_id: 42, game_name: 'Portal', comp_main: 36000, comp_plus: 54000 }]);
  setCache('meta:400', {
    name: 'Portal',
    genres: [{ id: '1', description: 'Action' }],
    categories: [{ id: '9', description: 'Co-op' }],
    developers: ['Valve'],
    publishers: ['Valve'],
  });
  setCache('browse:400', {
    tagids: TAG_IDS,
    tags: [
      { tagid: 1001, weight: 400 },
      { tagid: 1002, weight: 100 },
    ],
    related_items: { demo_appid: [1714800] },
  });
  setCache('tagnames:all', TAG_NAME_MAP);
  setCache('protondb:400', { tier: 'gold', confidence: 'strong', total: 500 });

  let fetchCalled = false;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCalled = true;
  });

  const res = await api.get('/api/game-details/400');
  assert.equal(res.status, 200);
  assert.equal(res.body.rating?.total, 1000);
  assert.equal(res.body.rating?.desc, 'Very Positive');
  assert.equal(res.body.hltb?.main, 10);
  assert.deepEqual(res.body.meta?.genres, ['Action']);
  assert.deepEqual(res.body.tags, ['Action', 'Co-op']);
  assert.deepEqual(res.body.tagWeights, { Action: 1, 'Co-op': 0.25 });
  assert.equal(res.body.demo, 1714800);
  assert.equal(res.body.protondb?.tier, 'gold');
  assert.equal(fetchCalled, false);
});

test('GET /api/game-details/:appid: a warm request reads each cached meta-tier row once', async (t) => {
  _reset();
  for (const appid of [403, 404]) {
    setCache(`hltb:${appid}`, []);
    setCache(`meta:${appid}`, { name: 'X' });
    setCache(`browse:${appid}`, { tagids: TAG_IDS, related_items: { demo_appid: [1] } });
    setCache(`protondb:${appid}`, null);
  }
  setCache('tagnames:all', TAG_NAME_MAP);
  setCache('rating:404', { total_reviews: 1, total_positive: 1 });
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('should not fetch');
  });
  await api.get('/api/game-details/403');

  const metaHits = () => getMetrics().sinceRestart.cacheHits.meta.hits;
  const before = metaHits();
  const res = await api.get('/api/game-details/404');
  assert.deepEqual(res.body.tags, ['Action', 'Co-op']);
  assert.equal(res.body.demo, 1);
  // hltb, meta, browse and protondb: the browse row serves tags and demo, the tag names stay parsed
  assert.equal(metaHits() - before, 4);
});

test('GET /api/game-details/:appid: dates each source separately, and fetchedAt is the oldest of them', async (t) => {
  _reset();
  // Deliberately staggered: the panel's ↻ shows one figure for five sources cached under tiers
  // of 90-180 days, so an old store page dating the whole readout is the normal case — the
  // per-source breakdown behind it is what makes that figure interpretable.
  setCache('rating:402', { total_reviews: 10, total_positive: 9, review_score_desc: 'Positive' });
  setCache('hltb:402', [{ game_id: 1, game_name: 'X', comp_main: 3600 }]);
  setCache('meta:402', { name: 'X' });
  setCache('browse:402', { tagids: TAG_IDS });
  setCache('tagnames:all', TAG_NAME_MAP);
  setCache('protondb:402', { tier: 'gold' });
  const now = Date.now();
  // Backdated in place — the only way to get entries of genuinely different ages in one test
  // (setCache always stamps now). `meta:` lives in cache_meta, `rating:` in its own table.
  db.prepare('UPDATE cache_meta SET ts = ? WHERE key = ?').run(now - 5 * 86400000, 'meta:402');
  db.prepare('UPDATE cache_rating SET ts = ? WHERE key = ?').run(now - 86400000, 'rating:402');

  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('should not fetch');
  });
  const res = await api.get('/api/game-details/402');
  assert.equal(res.status, 200);
  assert.equal(res.body.fetchedAts.meta, now - 5 * 86400000);
  assert.equal(res.body.fetchedAts.rating, now - 86400000);
  assert.ok(res.body.fetchedAts.hltb > now - 86400000, 'untouched entries keep their own write time');
  // The visible figure is the oldest of the five, not the newest and not an average.
  assert.equal(res.body.fetchedAt, now - 5 * 86400000);
});

test('GET /api/game-details/:appid: 200 fetching fresh rating, HLTB, meta and tags', async (t) => {
  _reset();
  _resetAuth();
  t.mock.method(globalThis, 'fetch', makeDetailsFetch());

  const res = await api.get('/api/game-details/401');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.rating?.score, 'number');
  assert.equal(res.body.hltb?.main, 10);
  assert.deepEqual(res.body.meta?.genres, ['Action']);
  assert.deepEqual(res.body.meta?.categories, ['Co-op']);
  assert.ok(Array.isArray(res.body.tags), 'tags should be an array');
  assert.ok(res.body.tags.includes('Action'));
  assert.equal(res.body.demo, DEMO_APPID);
});

// ── GET /api/game-news/:appid ─────────────────────────────────────────────────
// Deliberately its own endpoint, not part of /api/game-details — see newsLimit's
// comment in server.js for why (no table column, so fetched on-demand per panel open
// rather than for every game in a whole loaded library/comparison).

test('GET /api/game-news/abc: 400 for non-numeric appid', async () => {
  const res = await api.get('/api/game-news/abc');
  assert.equal(res.status, 400);
});

test('GET /api/game-news/:appid: 200 with recent news items', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', makeDetailsFetch());

  const res = await api.get('/api/game-news/407');
  assert.equal(res.status, 200);
  assert.equal(res.body.news.length, 1);
  assert.equal(res.body.news[0].title, 'Patch 1.2 released');
  assert.equal(res.body.news[0].feedLabel, 'Community Announcements');
});

test('GET /api/game-news/:appid: 200 from cache without fetching', async (t) => {
  _reset();
  setCache('news:408', []);
  let fetchCalled = false;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCalled = true;
  });

  const res = await api.get('/api/game-news/408');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.news, []);
  assert.equal(fetchCalled, false);
});

test('GET /api/game-news/:appid: ?refresh=1 re-fetches despite the cache', async (t) => {
  _reset();
  const fetchMock = t.mock.method(globalThis, 'fetch', makeDetailsFetch());

  await api.get('/api/game-news/409').expect(200);
  await api.get('/api/game-news/409').expect(200);
  assert.equal(fetchMock.mock.callCount(), 1);
  const res = await api.get('/api/game-news/409?refresh=1').expect(200);
  assert.equal(fetchMock.mock.callCount(), 2);
  assert.equal(res.body.news.length, 1);
});

test("GET /api/game-details/:appid: a soundtrack isn't searched on HLTB, and reads as no data, not failed", async (t) => {
  _reset();
  _resetAuth();
  const fetchMock = t.mock.method(globalThis, 'fetch', makeDetailsFetch({ type: 'music' }));

  const res = await api.get('/api/game-details/412');
  assert.equal(res.status, 200);
  assert.equal(res.body.hltb, null);
  assert.ok(!res.body.failed?.includes('hltb'));
  assert.ok(!fetchMock.mock.calls.some((c) => String(c.arguments[0]).includes('howlongtobeat')));
});

test("GET /api/game-details/:appid: a soundtrack's skipped HLTB lookup is cached as a short-lived miss, so it has an age", async (t) => {
  _reset();
  _resetAuth();
  t.mock.method(globalThis, 'fetch', makeDetailsFetch({ type: 'music' }));

  const res = await api.get('/api/game-details/413').expect(200);
  assert.notEqual(res.body.fetchedAts.hltb, null);
  assert.notEqual(res.body.fetchedAt, null);
  const later = Date.now() + MISS_CACHE_TTL_MS + 1;
  t.mock.method(Date, 'now', () => later);
  assert.equal(getCachedAt('hltb:413'), undefined);
});

test('GET /api/game-details/:appid: 200 with null rating when reviews fetch fails', async (t) => {
  _reset();
  _resetAuth();
  t.mock.method(globalThis, 'fetch', makeDetailsFetch({ ratingOk: false }));

  const res = await api.get('/api/game-details/402');
  assert.equal(res.status, 200);
  assert.equal(res.body.rating, null);
  assert.equal(res.body.hltb?.main, 10);
  assert.ok(res.body.meta !== undefined, 'meta should still be present');
});

test('GET /api/game-details/:appid: 200 with null meta when appdetails fetch fails', async (t) => {
  _reset();
  _resetAuth();
  t.mock.method(globalThis, 'fetch', makeDetailsFetch({ metaOk: false }));

  const res = await api.get('/api/game-details/403');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.rating?.score, 'number');
  assert.equal(res.body.meta, null);
  assert.deepEqual(res.body.failed, ['hltb', 'meta'], "HLTB needs meta's name, so it failed too, not 'no data'");
});

test('GET /api/game-details/:appid: a failed store browse item logs once, for tags, not again for the demo', async (t) => {
  _reset();
  _resetAuth();
  const detailsFetch = makeDetailsFetch();
  t.mock.method(globalThis, 'fetch', async (url) =>
    url.includes('IStoreBrowseService') ? { ok: false, status: 503 } : detailsFetch(url),
  );
  const warn = t.mock.method(console, 'warn', () => {});

  const res = await api.get('/api/game-details/408');
  assert.deepEqual(res.body.failed, ['tags']);
  const lines = warn.mock.calls.map((c) => String(c.arguments[0]));
  assert.deepEqual(
    lines.filter((l) => l.startsWith('[game-details]')),
    ['[game-details] tags (appid 408):'],
  );
});

test('GET /api/game-details/:appid: names a failed source in `failed`, unlike one with no data', async (t) => {
  _reset();
  _resetAuth();
  t.mock.method(globalThis, 'fetch', makeDetailsFetch({ ratingOk: false }));
  const failing = await api.get('/api/game-details/406');
  assert.equal(failing.body.rating, null);
  assert.deepEqual(failing.body.failed, ['rating']);

  _reset();
  t.mock.method(globalThis, 'fetch', makeDetailsFetch());
  const fine = await api.get('/api/game-details/407');
  assert.equal(fine.body.failed, undefined);
});

test('GET /api/game-details/:appid: 200 with null tags and null demo when the Steam store browse fetch fails (same call backs both)', async (t) => {
  _reset();
  _resetAuth();
  t.mock.method(globalThis, 'fetch', makeDetailsFetch({ tagsOk: false }));

  const res = await api.get('/api/game-details/404');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.rating?.score, 'number');
  assert.ok(res.body.meta !== undefined, 'meta should still be present');
  assert.equal(res.body.tags, null);
  assert.equal(res.body.demo, null);
});

test('GET /api/game-details/:appid: only fetches sources not already cached', async (t) => {
  _reset();
  _resetAuth();
  setCache('rating:405', { total_reviews: 1000, total_positive: 900, review_score_desc: 'Very Positive' });
  setCache('meta:405', {
    name: 'Portal',
    genres: [{ id: '1', description: 'Action' }],
    categories: [{ id: '9', description: 'Co-op' }],
    developers: ['Valve'],
    publishers: ['Valve'],
  });

  let fetchedUrls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    fetchedUrls.push(url);
    if (url.includes('IStoreBrowseService'))
      return { ok: true, json: async () => ({ response: { store_items: [{ success: 1, tagids: TAG_IDS }] } }) };
    if (url.includes('ajaxgetstoretags'))
      return {
        ok: true,
        json: async () => ({
          tags: Object.entries(TAG_NAME_MAP).map(([tagid, name]) => ({ tagid: Number(tagid), name })),
        }),
      };
    if (url.includes('search/site/init'))
      return { ok: true, json: async () => ({ token: 'tok', hpKey: 'k', hpVal: 'v' }) };
    if (url.includes('search/site'))
      return { ok: true, json: async () => ({ data: [{ game_name: 'Portal', comp_main: 36000, comp_plus: 72000 }] }) };
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const res = await api.get('/api/game-details/405');
  assert.equal(res.status, 200);
  assert.equal(res.body.rating?.total, 1000);
  assert.deepEqual(res.body.meta?.genres, ['Action']);
  assert.equal(res.body.hltb?.main, 10);
  assert.ok(Array.isArray(res.body.tags));
  assert.ok(!fetchedUrls.some((u) => u.includes('GetAppReviews')), 'rating should not be re-fetched');
  assert.ok(
    !fetchedUrls.some((u) => u.includes('steampowered.com') && u.includes('appdetails')),
    'meta should not be re-fetched',
  );
});

// ── GET /api/game-details/:appid — "fast refresh" cache / dedup ──────────────
// A browser refresh fires the same /api/game-details/:appid requests again.
// These tests verify the server does NOT re-fetch upstream when it shouldn't.

// fetch mock that tallies how many times each upstream source is hit; `gate` holds every call until it resolves.
function makeCountingDetailsFetch(counts, { gate } = {}) {
  return async (url) => {
    await gate;
    if (url.includes('GetAppReviews')) {
      counts.rating++;
      return {
        ok: true,
        json: async () => ({
          response: { query_summary: { total_reviews: 1000, total_positive: 900, review_score_desc: 'Very Positive' } },
        }),
      };
    }
    if (url.includes('IStoreBrowseService')) {
      counts.tags++;
      return { ok: true, json: async () => ({ response: { store_items: [{ success: 1, tagids: TAG_IDS }] } }) };
    }
    if (url.includes('ajaxgetstoretags')) {
      counts.tags++;
      return {
        ok: true,
        json: async () => ({
          tags: Object.entries(TAG_NAME_MAP).map(([tagid, name]) => ({ tagid: Number(tagid), name })),
        }),
      };
    }
    if (url.includes('appdetails')) {
      counts.meta++;
      const appid = url.match(/appids=(\d+)/)?.[1];
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
    if (url.includes('search/site/init')) {
      counts.hltbInit++;
      return { ok: true, json: async () => ({ token: 'tok', hpKey: 'k', hpVal: 'v' }) };
    }
    if (url.includes('search/site')) {
      counts.hltb++;
      return { ok: true, json: async () => ({ data: [{ game_name: 'Portal', comp_main: 36000, comp_plus: 72000 }] }) };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

const dedupHits = (name) => getMetrics().sinceRestart.dedupHits[name] ?? 0;

// #1 — sequential refresh: second request must be served entirely from cache.
test('GET /api/game-details/:appid: a repeated request is served from cache, no re-fetch', async (t) => {
  _reset();
  _resetAuth();
  const counts = { rating: 0, hltb: 0, hltbInit: 0, meta: 0, tags: 0 };
  t.mock.method(globalThis, 'fetch', makeCountingDetailsFetch(counts));

  const res1 = await api.get('/api/game-details/500');
  assert.equal(res1.status, 200);
  assert.equal(counts.rating, 1);
  assert.equal(counts.hltb, 1);
  assert.equal(counts.meta, 1);
  assert.equal(counts.tags, 2, 'tags fetch = one IStoreBrowseService call + one ajaxgetstoretags call');

  // Simulates the page being refreshed: same appid requested again.
  const res2 = await api.get('/api/game-details/500');
  assert.equal(res2.status, 200);
  assert.deepEqual(res2.body, res1.body);
  assert.equal(counts.rating, 1, 'rating must not be re-fetched on refresh');
  assert.equal(counts.hltb, 1, 'HLTB must not be re-fetched on refresh');
  assert.equal(counts.meta, 1, 'meta must not be re-fetched on refresh');
  assert.equal(counts.tags, 2, 'tags must not be re-fetched on refresh');
});

// #2 — concurrent refresh: overlapping in-flight requests for the same appid
// must collapse onto a single upstream fetch via dedup.
test('GET /api/game-details/:appid: concurrent requests for the same appid dedup to one fetch', async (t) => {
  _reset();
  _resetAuth();
  const counts = { rating: 0, hltb: 0, hltbInit: 0, meta: 0, tags: 0 };
  const { promise: gate, resolve: release } = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', makeCountingDetailsFetch(counts, { gate }));

  const hits = dedupHits('details');
  const both = Promise.all([api.get('/api/game-details/501'), api.get('/api/game-details/501')]);
  await until(() => dedupHits('details') > hits, 'the second request joining the first');
  release();
  const [res1, res2] = await both;

  assert.equal(res1.status, 200);
  assert.equal(res2.status, 200);
  assert.deepEqual(res1.body, res2.body);
  assert.equal(counts.rating, 1, 'rating fetched once for two concurrent requests');
  assert.equal(counts.hltb, 1, 'HLTB fetched once for two concurrent requests');
  assert.equal(counts.meta, 1, 'meta fetched once for two concurrent requests');
  assert.equal(counts.tags, 2, 'tags fetched once for two concurrent requests (one browse + one name-map call)');
});

// A forced request never reuses the normal one's result, which can come from cache, but it does
// share a call to the upstream already under way: that call missed the cache, so it's current.
test('GET /api/game-details/:appid: ?refresh=1 alongside a normal request shares its in-flight upstream calls', async (t) => {
  _reset();
  _resetAuth();
  t.mock.method(console, 'warn', () => {});
  const counts = { rating: 0, hltb: 0, hltbInit: 0, meta: 0, tags: 0 };
  const { promise: gate, resolve: release } = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', makeCountingDetailsFetch(counts, { gate }));

  const hits = dedupHits('steam');
  const both = Promise.all([api.get('/api/game-details/503'), api.get('/api/game-details/503?refresh=1')]);
  // A lone request makes no 'steam' dedup hit; the forced one joins all five of its upstream calls.
  await until(() => dedupHits('steam') === hits + 5, 'the forced calls joining the normal ones');
  release();
  const [normal, forced] = await both;
  assert.equal(normal.status, 200);
  assert.equal(forced.status, 200);
  assert.equal(forced.body.rating.score, normal.body.rating.score);
  assert.equal(counts.rating, 1);
  assert.equal(counts.meta, 1);
});

test('GET /api/game-details/:appid: ?refresh=1 re-fetches every source despite the cache', async (t) => {
  _reset();
  _resetAuth();
  const counts = { rating: 0, hltb: 0, hltbInit: 0, meta: 0, tags: 0 };
  t.mock.method(globalThis, 'fetch', makeCountingDetailsFetch(counts));

  await api.get('/api/game-details/502').expect(200);
  await api.get('/api/game-details/502?refresh=1').expect(200);
  assert.equal(counts.rating, 2);
  assert.equal(counts.hltb, 2);
  assert.equal(counts.meta, 2);
  assert.ok(counts.tags >= 3, 'the store browse item is re-fetched');
});

// A game that isn't out yet has no reviews, ProtonDB reports or HLTB times: those misses, and its
// store page, are only true until release, so they expire like other misses instead of in a year.
for (const comingSoon of [true, false]) {
  test(`GET /api/game-details/:appid: ${comingSoon ? "an unreleased game's" : "a released game's"} empty sources ${comingSoon ? 'expire within a day' : 'keep the long tier'}`, async (t) => {
    _reset();
    _resetAuth();
    t.mock.method(globalThis, 'fetch', async (url) => {
      if (url.includes('appdetails'))
        return {
          ok: true,
          json: async () => ({
            777: { success: true, data: { name: 'Soon', release_date: { coming_soon: comingSoon, date: 'Q4 2027' } } },
          }),
        };
      if (url.includes('GetAppReviews'))
        return {
          ok: true,
          json: async () => ({ response: { query_summary: { total_reviews: 0, total_positive: 0 } } }),
        };
      if (url.includes('protondb.com')) return { ok: false, status: 404 };
      if (url.includes('search/site/init'))
        return { ok: true, json: async () => ({ token: 'tok', hpKey: 'k', hpVal: 'v' }) };
      if (url.includes('search/site')) return { ok: true, json: async () => ({ data: [] }) };
      if (url.includes('IStoreBrowseService'))
        return { ok: true, json: async () => ({ response: { store_items: [{ success: 1, tagids: [] }] } }) };
      if (url.includes('ajaxgetstoretags'))
        return { ok: true, json: async () => ({ tags: [{ tagid: 1, name: 'Action' }] }) };
      throw new Error(`Unexpected fetch: ${url}`);
    });
    await api.get('/api/game-details/777').expect(200);

    const later = Date.now() + MISS_CACHE_TTL_MS + 1000;
    t.mock.method(Date, 'now', () => later);
    for (const source of ['rating', 'protondb', 'hltb', 'meta']) {
      const cachedAt = getCachedAt(`${source}:777`);
      assert.equal(cachedAt === undefined, comingSoon, source);
    }
    assert.notEqual(getCachedAt('browse:777'), undefined, 'tags are not a miss');
  });
}

// ── GET /api/game-meta/:appid ─────────────────────────────────────────────────

test('GET /api/game-meta/:appid: store metadata only, one upstream call', async (t) => {
  _reset();
  _resetAuth();
  const urls = [];
  const detailsFetch = makeDetailsFetch();
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(url);
    return detailsFetch(url);
  });
  const res = await api.get('/api/game-meta/400').expect(200);
  assert.equal(typeof res.body.meta.name, 'string');
  assert.equal(urls.length, 1);
  assert.match(urls[0], /appdetails/);
});

test("GET /api/game-meta/:appid: 502 when the store can't be reached or answers with HTML", async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const fetchImpl of [
    async () => {
      throw new TypeError('fetch failed');
    },
    async () => new Response('<!DOCTYPE html><html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
  ]) {
    _reset();
    _resetCircuitBreakers();
    t.mock.method(globalThis, 'fetch', fetchImpl);
    await api.get('/api/game-meta/400').expect(502);
  }
});

test('GET /api/game-meta/:appid: 400 for an invalid appid, 502 when the store fails', async (t) => {
  _reset();
  _resetCircuitBreakers();
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', makeDetailsFetch({ metaOk: false }));
  await api.get('/api/game-meta/abc').expect(400);
  await api.get('/api/game-meta/400').expect(502);
});

// #3 — real browser-abort on fast refresh. supertest awaits the full response,
// so this uses a raw http request destroyed mid-flight against app.listen().
// Question: when the client disconnects before setCache runs, does the server
// still complete the upstream work and cache it (so the refresh is a cache hit),
// or is the work stranded (forcing the refresh to re-fetch)?
test('GET /api/game-details/:appid: a request aborted mid-flight still caches, so refresh does not re-fetch', async (t) => {
  _reset();
  _resetAuth();
  const counts = { rating: 0, hltb: 0, hltbInit: 0, meta: 0, tags: 0 };
  const { promise: gate, resolve: release } = Promise.withResolvers();
  const countingFetch = makeCountingDetailsFetch(counts, { gate });
  let started = 0;
  t.mock.method(globalThis, 'fetch', (url) => (started++, countingFetch(url)));

  const server = app.listen(0);
  t.after(() => new Promise((r) => server.close(r)));
  let sockets = 0;
  server.on('connection', (socket) => (sockets++, socket.once('close', () => sockets--)));
  await new Promise((r) => server.once('listening', r));

  // Killed once the handler has started its upstream fetches, held until the server sees the disconnect.
  const req = http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/game-details/600' });
  req.on('error', () => {}); // destroy() surfaces ECONNRESET — expected, ignore
  await until(() => started, 'the first upstream fetch');
  req.destroy();
  await until(() => sockets === 0, 'the server seeing the disconnect');
  release();

  // The stranded handler's upstream work done (meta → HLTB's search is its longest chain), then its setCache.
  await until(() => counts.rating && counts.hltb && counts.meta && counts.tags === 2, 'the stranded fetches');
  await new Promise((r) => setImmediate(r));

  // The refresh: same appid requested again.
  const res = await api.get('/api/game-details/600');
  assert.equal(res.status, 200);
  assert.equal(
    counts.rating,
    1,
    'aborted request should have completed and cached the rating — refresh must not re-fetch',
  );
  assert.equal(counts.hltb, 1, 'aborted request should have completed and cached HLTB');
  assert.equal(counts.meta, 1, 'aborted request should have completed and cached meta');
  assert.equal(counts.tags, 2, 'aborted request should have completed and cached tags');
});

test('GET /api/game-details/:appid: failed fetch is not cached, retried on next request', async (t) => {
  _reset();
  _resetAuth();
  let hltbCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('GetAppReviews'))
      return {
        ok: true,
        json: async () => ({
          response: { query_summary: { total_reviews: 1000, total_positive: 900, review_score_desc: 'Very Positive' } },
        }),
      };
    if (url.includes('appdetails')) {
      const appid = url.match(/appids=(\d+)/)?.[1];
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
    if (url.includes('search/site/init'))
      return { ok: true, json: async () => ({ token: 'tok', hpKey: 'k', hpVal: 'v' }) };
    if (url.includes('search/site')) {
      hltbCalls++;
      return { ok: false, status: 503 };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const res1 = await api.get('/api/game-details/406');
  assert.equal(res1.status, 200);
  assert.equal(res1.body.hltb, null);

  const res2 = await api.get('/api/game-details/406');
  assert.equal(res2.status, 200);
  assert.equal(hltbCalls, 2, 'HLTB should be retried — failed fetch must not be cached');
});

// ── POST /api/game-details/stream ────────────────────────────────────────────

function parseSseEvents(body) {
  return body
    .split('\n\n')
    .filter((c) => c.startsWith('data: '))
    .map((c) => JSON.parse(c.slice(6)));
}

function ssePost(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// The stream is the one large response (a whole library's details), so it is gzipped for
// clients that accept it, flushed once per event-loop turn so rows still arrive as each game resolves.
for (const encoding of ['gzip', 'identity']) {
  test(`POST /api/game-details/stream: ${encoding === 'gzip' ? 'gzipped' : 'plain'} for Accept-Encoding: ${encoding}`, async (t) => {
    _reset();
    _resetAuth();
    t.mock.method(globalThis, 'fetch', makeDetailsFetch());
    const server = app.listen(0);
    t.after(() => new Promise((r) => server.close(r)));
    await new Promise((r) => server.once('listening', r));

    const payload = JSON.stringify({ games: [{ appid: 400 }, { appid: 401 }] });
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: server.address().port,
          path: '/api/game-details/stream',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept-Encoding': encoding },
        },
        (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => resolve({ headers: r.headers, body: Buffer.concat(chunks) }));
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
    assert.equal(res.headers['content-encoding'], encoding === 'gzip' ? 'gzip' : undefined);
    const text = (encoding === 'gzip' ? zlib.gunzipSync(res.body) : res.body).toString();
    const events = parseSseEvents(text);
    assert.deepEqual(events.map((e) => e.appid).sort(), [400, 401, undefined]);
    assert.equal(events.at(-1).done, true);
  });
}

// Flushes are batched per event-loop turn: a game's event must still reach the client while
// another game is pending, else this deadlocks (the slow game only answers once the first arrives).
test(
  'POST /api/game-details/stream: a gzipped event arrives while other games are pending',
  { timeout: 20_000 },
  async (t) => {
    _reset();
    _resetAuth();
    const SLOW = 777777;
    let release;
    const released = new Promise((r) => {
      release = r;
    });
    t.after(() => release()); // on failure, so the server can close
    const fetchDetails = makeDetailsFetch();
    t.mock.method(globalThis, 'fetch', async (url, opts) => {
      if (String(url).includes(String(SLOW))) await released;
      return fetchDetails(url, opts);
    });
    const server = app.listen(0);
    t.after(() => new Promise((r) => server.close(r)));
    await new Promise((r) => server.once('listening', r));

    const text = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: server.address().port,
          path: '/api/game-details/stream',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip' },
        },
        (r) => {
          let body = '';
          r.pipe(zlib.createGunzip())
            .on('data', (c) => {
              body += c;
              if (body.includes('"appid":400')) release();
            })
            .on('end', () => resolve(body))
            .on('error', reject);
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify({ games: [{ appid: 400 }, { appid: SLOW }] }));
    });
    assert.deepEqual(
      parseSseEvents(text).map((e) => e.appid),
      [400, SLOW, undefined],
    );
  },
);

test('POST /api/game-details/stream: 400 for empty games list', async () => {
  const res = await api.post('/api/game-details/stream').send({ games: [] });
  assert.equal(res.status, 400);
});

test('POST /api/game-details/stream: 400 for invalid appid in list', async () => {
  const res = await api.post('/api/game-details/stream').send({ games: [{ appid: 'abc' }] });
  assert.equal(res.status, 400);
});

test('POST /api/game-details/stream: 400 when games list exceeds STREAM_MAX_GAMES', async () => {
  const max = Number(process.env.STREAM_MAX_GAMES);
  const games = Array.from({ length: max + 1 }, (_, i) => ({ appid: i + 1 }));
  const res = await api.post('/api/game-details/stream').send({ games });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Too many games/);
});

test('POST /api/game-details/stream: streams one event per game plus a done event from cache', async (t) => {
  _reset();
  const rawRating = { total_reviews: 1000, total_positive: 900, review_score_desc: 'Very Positive' };
  const rawHltb = [{ game_id: 42, game_name: 'Portal', comp_main: 36000, comp_plus: 54000 }];
  const rawMeta = {
    name: 'Portal',
    genres: [{ id: '1', description: 'Action' }],
    categories: [{ id: '9', description: 'Co-op' }],
    developers: ['Valve'],
    publishers: ['Valve'],
  };
  const rawProtonDb = { tier: 'gold', confidence: 'strong', total: 500 };
  setCache('rating:400', rawRating);
  setCache('hltb:400', rawHltb);
  setCache('meta:400', rawMeta);
  setCache('browse:400', { tagids: TAG_IDS });
  setCache('protondb:400', rawProtonDb);
  setCache('rating:401', rawRating);
  setCache('hltb:401', rawHltb);
  setCache('meta:401', rawMeta);
  setCache('browse:401', { tagids: TAG_IDS });
  setCache('protondb:401', rawProtonDb);
  setCache('tagnames:all', TAG_NAME_MAP);

  const server = app.listen(0);
  t.after(() => new Promise((r) => server.close(r)));
  await new Promise((r) => server.once('listening', r));

  const res = await ssePost(server.address().port, '/api/game-details/stream', {
    games: [{ appid: 400 }, { appid: 401 }],
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream');
  const events = parseSseEvents(res.body);
  const gameEvents = events.filter((e) => !e.done);
  const doneEvent = events.find((e) => e.done);
  assert.equal(gameEvents.length, 2);
  assert.ok(gameEvents.some((e) => e.appid === 400));
  assert.ok(gameEvents.some((e) => e.appid === 401));
  assert.ok(doneEvent, 'must end with a done event');
});

test('POST /api/game-details/stream: fetches fresh details and streams them', async (t) => {
  _reset();
  _resetAuth();
  t.mock.method(globalThis, 'fetch', makeDetailsFetch());

  const server = app.listen(0);
  t.after(() => new Promise((r) => server.close(r)));
  await new Promise((r) => server.once('listening', r));

  const res = await ssePost(server.address().port, '/api/game-details/stream', { games: [{ appid: 700 }] });

  assert.equal(res.status, 200);
  const events = parseSseEvents(res.body);
  const gameEvent = events.find((e) => e.appid === 700);
  assert.ok(gameEvent, 'must emit an event for the requested appid');
  assert.equal(typeof gameEvent.rating?.score, 'number');
  assert.equal(gameEvent.hltb?.main, 10);
  assert.deepEqual(gameEvent.meta?.genres, ['Action']);
});

test('POST /api/game-details/stream: leaves out screenshots and trailers, keeps the banner', async (t) => {
  _reset();
  _resetAuth();
  t.mock.method(globalThis, 'fetch', makeDetailsFetch({ media: true }));
  const server = app.listen(0);
  t.after(() => new Promise((r) => server.close(r)));
  await new Promise((r) => server.once('listening', r));

  const res = await ssePost(server.address().port, '/api/game-details/stream', { games: [{ appid: 400 }] });
  const { meta } = parseSseEvents(res.body).find((e) => e.appid === 400);
  assert.equal(meta.name, 'Portal');
  assert.match(meta.banner, /header\.jpg/);
  assert.equal('screenshots' in meta, false);
  assert.equal('movies' in meta, false);
});

// fetchGameDetails' result is shared with GET /api/game-details through dedupDetails: the stream strips a copy.
test('POST /api/game-details/stream: a GET /api/game-details sharing its fetch keeps the media', async (t) => {
  _reset();
  _resetAuth();
  const { promise: released, resolve: release } = Promise.withResolvers();
  const detailsFetch = makeDetailsFetch({ media: true });
  let storeCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('appdetails')) storeCalls++;
    await released;
    return detailsFetch(url);
  });
  const server = app.listen(0);
  t.after(() => new Promise((r) => server.close(r)));
  await new Promise((r) => server.once('listening', r));

  const single = api.get('/api/game-details/400').then((r) => r);
  await until(() => storeCalls === 1, "the GET's store fetch"); // under way first
  const hits = dedupHits('details');
  const stream = ssePost(server.address().port, '/api/game-details/stream', { games: [{ appid: 400 }] });
  await until(() => dedupHits('details') > hits, "the stream joining the GET's lookup");
  release();
  const [one, streamed] = await Promise.all([single, stream]);
  assert.equal(storeCalls, 1); // one fetch, shared
  assert.equal(one.body.meta.screenshots.length, 1);
  assert.equal(one.body.meta.movies.length, 1);
  assert.equal('screenshots' in parseSseEvents(streamed.body).find((e) => e.appid === 400).meta, false);
});

test('POST /api/game-details/stream: then GET /api/game-meta answers the media from cache', async (t) => {
  _reset();
  _resetAuth();
  const urls = [];
  const detailsFetch = makeDetailsFetch({ media: true });
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(url);
    return detailsFetch(url);
  });
  const server = app.listen(0);
  t.after(() => new Promise((r) => server.close(r)));
  await new Promise((r) => server.once('listening', r));

  await ssePost(server.address().port, '/api/game-details/stream', { games: [{ appid: 400 }] });
  urls.length = 0;
  const res = await api.get('/api/game-meta/400').expect(200);
  assert.deepEqual(urls, []);
  assert.equal(res.body.meta.screenshots.length, 1);
  assert.equal(res.body.meta.movies.length, 1);
});

// The client never sends a name (see fetchGameDetails in server.js — the server always
// resolves it from store metadata itself, keyed on the appid, rather than trusting one from
// the client). This must still work for wishlist rows, which have no name of their own to
// begin with (GetWishlist returns only appid/priority/date_added) — getHLTB would otherwise
// short-circuit to null immediately on an empty name (`if (!name) return null`).
test('POST /api/game-details/stream: resolves HLTB name from store metadata', async (t) => {
  _reset();
  _resetAuth();
  let hltbSearchCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('GetAppReviews')) {
      return {
        ok: true,
        json: async () => ({
          response: { query_summary: { total_reviews: 1000, total_positive: 900, review_score_desc: 'Very Positive' } },
        }),
      };
    }
    if (url.includes('IStoreBrowseService')) {
      return { ok: true, json: async () => ({ response: { store_items: [{ success: 1, tagids: TAG_IDS }] } }) };
    }
    if (url.includes('ajaxgetstoretags')) {
      return {
        ok: true,
        json: async () => ({
          tags: Object.entries(TAG_NAME_MAP).map(([tagid, name]) => ({ tagid: Number(tagid), name })),
        }),
      };
    }
    if (url.includes('appdetails')) {
      const appid = url.match(/appids=(\d+)/)?.[1];
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
    if (url.includes('search/site/init')) {
      return { ok: true, json: async () => ({ token: 'tok', hpKey: 'k', hpVal: 'v' }) };
    }
    if (url.includes('search/site')) {
      hltbSearchCalls++;
      return { ok: true, json: async () => ({ data: [{ game_name: 'Portal', comp_main: 36000, comp_plus: 54000 }] }) };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const server = app.listen(0);
  t.after(() => new Promise((r) => server.close(r)));
  await new Promise((r) => server.once('listening', r));

  const res = await ssePost(server.address().port, '/api/game-details/stream', { games: [{ appid: 701 }] });

  assert.equal(res.status, 200);
  const events = parseSseEvents(res.body);
  const gameEvent = events.find((e) => e.appid === 701);
  assert.ok(gameEvent, 'must emit an event for the requested appid');
  assert.equal(gameEvent.meta?.name, 'Portal');
  assert.equal(hltbSearchCalls, 1, 'HLTB should have been searched using the name resolved from store metadata');
  assert.equal(gameEvent.hltb?.main, 10, 'HLTB result should be present, not short-circuited to null');
});

// fetchGameDetails' own logErr (server.js) is a second, separate consumer of the isLogged
// flag besides routeErrorStatus (covered under GET /api/search-games below) — this closes the
// loop on that one too, since a batch stream is exactly the "hundreds of near-identical lines"
// scenario the flag exists to prevent.
test('POST /api/game-details/stream: does not log [game-details] for meta blocked by an already-open circuit', async (t) => {
  _reset();
  _resetAuth();
  _resetCircuitBreakers();
  t.after(_resetCircuitBreakers);
  const warnMock = t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    // The store blocks everything, as it does when it starts answering 403.
    if (url.includes('store.steampowered.com')) return { ok: false, status: 403 };
    if (url.includes('GetAppReviews')) return { ok: true, json: async () => ({ response: {} }) };
    if (url.includes('IStoreBrowseService'))
      return {
        ok: true,
        json: async () => ({ response: { store_items: [{ success: 1, tagids: [], related_items: {} }] } }),
      };
    if (url.includes('protondb.com')) return { ok: false, status: 404 }; // "no reports yet", not an error
    if (url.includes('search/site/init'))
      return { ok: true, json: async () => ({ token: 'tok', hpKey: 'k', hpVal: 'v' }) };
    if (url.includes('search/site')) return { ok: true, json: async () => ({ data: [] }) };
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const server = app.listen(0);
  t.after(() => new Promise((r) => server.close(r)));
  await new Promise((r) => server.once('listening', r));

  // The first game's meta and tag-name 403s trip the circuit (2 consecutive 403s) — these ARE
  // new information and are expected to log normally.
  await ssePost(server.address().port, '/api/game-details/stream', { games: [{ appid: 900 }] });
  assert.equal(warnMock.mock.calls.filter((c) => /\[circuit-breaker\]/.test(c.arguments[0])).length, 1);
  warnMock.mock.resetCalls();

  // Another game while the circuit is still open — its meta call is immediately an
  // circuit-open error and must not log its own [game-details] line.
  const res = await ssePost(server.address().port, '/api/game-details/stream', { games: [{ appid: 901 }] });
  const gameEvent = parseSseEvents(res.body).find((e) => e.appid === 901);
  assert.equal(gameEvent.meta, null);
  assert.equal(warnMock.mock.calls.filter((c) => /\[game-details\]/.test(c.arguments[0])).length, 0);
});

// An HLTB outage warns once from lib/hltb.js (throttled), not once per game from logErr.
for (const [what, hltbFetch, line] of [
  ['init', () => ({ ok: false, status: 503 }), /^\[HLTB\] init failed/],
  [
    'search',
    (url) =>
      url.includes('search/site/init')
        ? { ok: true, json: async () => ({ token: 'tok', hpKey: 'k', hpVal: 'v' }) }
        : { ok: false, status: 500 },
    /^\[HLTB\] search failed/,
  ],
]) {
  test(`GET /api/game-details: a failing HLTB ${what} warns once for a batch, with no [game-details] hltb line`, async (t) => {
    _reset();
    _resetAuth();
    t.after(_resetAuth);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() }); // the batch stays in one 30 s window
    const warnMock = t.mock.method(console, 'warn', () => {});
    t.mock.method(globalThis, 'fetch', async (url) => {
      if (url.includes('howlongtobeat.com')) return hltbFetch(url);
      if (url.includes('appdetails')) {
        const appid = url.match(/appids=(\d+)/)?.[1];
        return { ok: true, json: async () => ({ [appid]: { success: true, data: { name: `Game ${appid}` } } }) };
      }
      if (url.includes('GetAppReviews')) return { ok: true, json: async () => ({ response: {} }) };
      if (url.includes('IStoreBrowseService'))
        return {
          ok: true,
          json: async () => ({ response: { store_items: [{ success: 1, tagids: [], related_items: {} }] } }),
        };
      if (url.includes('ajaxgetstoretags'))
        return { ok: true, json: async () => ({ tags: [{ tagid: 1, name: 'Action' }] }) };
      if (url.includes('protondb.com')) return { ok: false, status: 404 };
      throw new Error(`Unexpected fetch: ${url}`);
    });

    for (const appid of [911, 912, 913]) {
      const res = await api.get(`/api/game-details/${appid}`);
      assert.ok(res.body.failed.includes('hltb'));
    }
    const lines = warnMock.mock.calls.map((c) => String(c.arguments[0]));
    assert.deepEqual(
      lines.filter((l) => l.startsWith('[game-details]')),
      [],
    );
    assert.equal(lines.filter((l) => line.test(l)).length, 1);
  });
}

// ── GET /api/search-games ─────────────────────────────────────────────────────

// ── GET /api/creator-games ────────────────────────────────────────────────────

test('GET /api/creator-games: 400 (no fetch) on a bad role or an empty name', async (t) => {
  _reset();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('should not fetch');
  });
  assert.equal((await api.get('/api/creator-games?role=studio&name=Foo')).status, 400);
  assert.equal((await api.get('/api/creator-games?role=developer&name=%20')).status, 400);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('GET /api/creator-games: 200 with appids, total and fetchedAt; refresh=1 re-fetches', async (t) => {
  _reset();
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) => {
    assert.match(url, /search\/results\/\?developer=Foo/);
    return {
      ok: true,
      json: async () => ({ total_count: 1, start: 0, results_html: '<a data-ds-itemkey="App_10">' }),
    };
  });
  const res = await api.get('/api/creator-games?role=developer&name=%20Foo%20');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.appids, [10]);
  assert.equal(res.body.total, 1);
  assert.equal(res.body.capped, false);
  assert.equal(res.body.fetchedAt, getCachedAt('creator:developer:Foo'));
  await api.get('/api/creator-games?role=developer&name=Foo');
  assert.equal(fetchMock.mock.callCount(), 1);
  await api.get('/api/creator-games?role=developer&name=Foo&refresh=1');
  assert.equal(fetchMock.mock.callCount(), 2);
});

test('GET /api/creator-games: 502 when the store search fails', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 500 }));
  const res = await api.get('/api/creator-games?role=publisher&name=Foo');
  assert.equal(res.status, 502);
  assert.ok(res.body.error);
});

// ── GET /api/game-pass ───────────────────────────────────────────────────────

test('GET /api/game-pass: 200 with appids, games not on Steam and fetchedAt; refresh=1 re-fetches', async (t) => {
  _reset();
  process.env.ITAD_API_KEY = 'test-itad-key';
  setCache('itad-shop:microsoft store', 48);
  setCache('itad-appid:g1', 10);
  setCache('msstore-title:B', 'Bee');
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) => {
    assert.match(url, /^https:\/\/catalog\.gamepass\.com\/.*market=DE/);
    return { ok: true, json: async () => [{ siglId: 'x' }, { id: 'A' }, { id: 'B' }] };
  });
  setCache('gamepass:pc:DE', [
    { id: 'A', gid: 'g1' },
    { id: 'B', gid: null },
  ]);
  const res = await api.get('/api/game-pass?country=de');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.appids, [10]);
  assert.deepEqual(res.body.notOnSteam, [{ id: 'B', title: 'Bee' }]);
  assert.equal(res.body.failed, 0);
  assert.equal(res.body.fetchedAt, getCachedAt('gamepass:pc:DE'));
  assert.equal(fetchMock.mock.callCount(), 0);
  fetchMock.mock.mockImplementation(async (url) =>
    url.startsWith('https://catalog.gamepass.com/')
      ? { ok: true, json: async () => [{ id: 'A' }, { id: 'B' }] }
      : { ok: true, json: async () => ({ A: 'g1' }) },
  );
  await api.get('/api/game-pass?country=DE&refresh=1');
  assert.equal(fetchMock.mock.callCount(), 2, 'the catalog and its ITAD lookup');
});

test('GET /api/game-pass: 502 when the catalog fails', async (t) => {
  _reset();
  process.env.ITAD_API_KEY = 'test-itad-key';
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 500 }));
  const res = await api.get('/api/game-pass');
  assert.equal(res.status, 502);
  assert.ok(res.body.error);
});

test('GET /api/search-games: empty results (no fetch) when q is missing', async (t) => {
  _reset();
  let fetchCalled = false;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCalled = true;
  });
  const res = await api.get('/api/search-games');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { results: [] });
  assert.equal(fetchCalled, false);
});

test('GET /api/search-games: empty results (no fetch) when q is below the minimum length', async (t) => {
  _reset();
  let fetchCalled = false;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCalled = true;
  });
  const res = await api.get('/api/search-games?q=a');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { results: [] });
  assert.equal(fetchCalled, false);
});

test('GET /api/search-games: 200 with results shaped for the frontend dropdown', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.match(url, /storesearch/);
    return {
      ok: true,
      json: async () => ({ items: [{ id: 400, name: 'Portal', tiny_image: 'https://example.com/400.jpg' }] }),
    };
  });
  const res = await api.get('/api/search-games?q=portal');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { results: [{ appid: 400, name: 'Portal', tinyImage: 'https://example.com/400.jpg' }] });
});

test('GET /api/search-games: a repeated query is served from cache, no re-fetch', async (t) => {
  _reset();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ items: [{ id: 400, name: 'Portal' }] }),
  }));
  await api.get('/api/search-games?q=portal');
  const firstCalls = fetchMock.mock.callCount();
  await api.get('/api/search-games?q=portal');
  assert.equal(fetchMock.mock.callCount(), firstCalls);
});

test('GET /api/search-games: ?refresh=1 is ignored — a cached term never re-fetches', async (t) => {
  _reset();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ items: [{ id: 400, name: 'Portal' }] }),
  }));
  await api.get('/api/search-games?q=portal');
  const firstCalls = fetchMock.mock.callCount();
  await api.get('/api/search-games?q=portal&refresh=1');
  assert.equal(fetchMock.mock.callCount(), firstCalls);
});

test('GET /api/search-games: 502 when the store search endpoint errors', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));
  const res = await api.get('/api/search-games?q=portal');
  assert.equal(res.status, 502);
});

test('GET /api/search-games: 504 with a [timeout:...] log when the upstream call times out', async (t) => {
  _reset();
  const errorMock = t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  });
  const res = await api.get('/api/search-games?q=timeout-term');
  assert.equal(res.status, 504);
  assert.ok(errorMock.mock.calls.some((c) => c.arguments[0] === '[timeout:search-games]'));
});

// A request blocked by an already-open circuit still 502s, but must not log its own
// [upstream:...] line — that's an expected, already-explained consequence of the trip itself
// (see the one-time [circuit-breaker] warning lib/steam.js logs at the moment it trips), not
// new information worth repeating once per blocked request.
test('GET /api/search-games: a request blocked by an open circuit returns 502 without its own [upstream:...] log line', async (t) => {
  _reset();
  _resetCircuitBreakers();
  t.after(_resetCircuitBreakers);
  const errorMock = t.mock.method(console, 'error', () => {});
  const warnMock = t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 403 }));

  // Two distinct uncached terms trip the circuit (2 consecutive 403s).
  await api.get('/api/search-games?q=trip-term-a');
  await api.get('/api/search-games?q=trip-term-b');
  const tripWarnings = warnMock.mock.calls.filter((c) => /\[circuit-breaker\]/.test(c.arguments[0]));
  assert.equal(tripWarnings.length, 1, 'the trip itself is still logged once');

  const errorsBefore = errorMock.mock.callCount();
  const res = await api.get('/api/search-games?q=trip-term-c');
  assert.equal(res.status, 502);
  assert.equal(
    errorMock.mock.callCount(),
    errorsBefore,
    'no new [upstream:...] line for a call blocked by the already-open circuit',
  );
});

// ── GET /api/achievements/:appid ─────────────────────────────────────────────

function makeAchievementsFetch({ achieved = [] } = {}) {
  return async (url) => {
    if (url.includes('GetSchemaForGame')) {
      return {
        ok: true,
        json: async () => ({
          game: {
            availableGameStats: {
              achievements: [
                {
                  name: 'ACH_1',
                  displayName: 'First',
                  description: 'Do the thing',
                  icon: 'i1',
                  icongray: 'g1',
                  hidden: 0,
                },
                {
                  name: 'ACH_2',
                  displayName: 'Second',
                  description: 'Do another thing',
                  icon: 'i2',
                  icongray: 'g2',
                  hidden: 0,
                },
              ],
            },
          },
        }),
      };
    }
    if (url.includes('GetGlobalAchievementPercentagesForApp')) {
      return {
        ok: true,
        json: async () => ({
          achievementpercentages: {
            achievements: [
              { name: 'ACH_1', percent: '42.0' },
              { name: 'ACH_2', percent: '8.5' },
            ],
          },
        }),
      };
    }
    if (url.includes('GetPlayerAchievements')) {
      return {
        ok: true,
        json: async () => ({
          playerstats: {
            success: true,
            achievements: [
              {
                apiname: 'ACH_1',
                achieved: achieved.includes('ACH_1') ? 1 : 0,
                unlocktime: achieved.includes('ACH_1') ? 1700000000 : 0,
              },
              {
                apiname: 'ACH_2',
                achieved: achieved.includes('ACH_2') ? 1 : 0,
                unlocktime: achieved.includes('ACH_2') ? 1700000001 : 0,
              },
            ],
          },
        }),
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

test('GET /api/achievements/:appid: a failed rarity lookup warns and says so, unlike a game with no rarity data', async (t) => {
  _reset();
  const warn = t.mock.method(console, 'warn', () => {});
  const base = makeAchievementsFetch();
  t.mock.method(globalThis, 'fetch', async (url) =>
    url.includes('GetGlobalAchievementPercentagesForApp') ? { ok: false, status: 503 } : base(url),
  );
  const res = await api.get('/api/achievements/401').expect(200);
  assert.equal(res.body.rarityFailed, true);
  assert.ok(res.body.achievements.every((a) => a.globalPct === null));
  assert.ok(warn.mock.calls.some((c) => /^\[achievements\]/.test(c.arguments[0])));

  _reset();
  t.mock.method(globalThis, 'fetch', makeAchievementsFetch());
  assert.equal((await api.get('/api/achievements/402').expect(200)).body.rarityFailed, undefined);
});

test('GET /api/achievements/:appid: no steamids returns the achievement list with playerCount 0, no progress claimed', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', makeAchievementsFetch());

  const res = await api.get('/api/achievements/400');
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 2);
  assert.equal(res.body.unlocked, 0);
  assert.equal(res.body.private, false);
  assert.equal(res.body.playerCount, 0);
  assert.equal(res.body.achievements[0].globalPct, 42);
  assert.equal(
    res.body.achievements.every((a) => a.achieved === false),
    true,
  );
});

test('GET /api/achievements/:appid: with steamids returns unlock progress and playerCount', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', makeAchievementsFetch({ achieved: ['ACH_1'] }));

  const res = await api.get(`/api/achievements/400?steamids=${ID1}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.playerCount, 1);
  assert.equal(res.body.unlocked, 1);
  assert.equal(res.body.private, false);
  const first = res.body.achievements.find((a) => a.apiname === 'ACH_1');
  assert.equal(first.achieved, true);
  assert.equal(first.unlocktime, 1700000000);
});

test("GET /api/achievements/:appid: unlocked counts only the schema's achievements, not ones added since it was cached", async (t) => {
  _reset();
  const base = makeAchievementsFetch({ achieved: ['ACH_1'] });
  t.mock.method(globalThis, 'fetch', async (url) => {
    const res = await base(url);
    if (!url.includes('GetPlayerAchievements')) return res;
    const body = await res.json();
    body.playerstats.achievements.push({ apiname: 'ACH_NEW', achieved: 1, unlocktime: 1700000002 });
    return { ok: true, json: async () => body };
  });

  const res = await api.get(`/api/achievements/400?steamids=${ID1}`).expect(200);
  assert.equal(res.body.total, 2);
  assert.equal(res.body.unlocked, 1);
});

test('GET /api/achievements/:appid: a member with a real unlock time wins over one whose time is unknown (0), in either order', async (t) => {
  for (const ids of [`${ID1},${ID2}`, `${ID2},${ID1}`]) {
    _reset();
    const base = makeAchievementsFetch({ achieved: ['ACH_1'] });
    t.mock.method(globalThis, 'fetch', async (url) => {
      const res = await base(url);
      if (!url.includes('GetPlayerAchievements') || !url.includes(ID1)) return res;
      const body = await res.json();
      body.playerstats.achievements[0].unlocktime = 0;
      return { ok: true, json: async () => body };
    });
    const res = await api.get(`/api/achievements/400?steamids=${ids}`).expect(200);
    assert.equal(res.body.achievements.find((a) => a.apiname === 'ACH_1').unlocktime, 1700000000, ids);
  }
});

test('GET /api/achievements/:appid: ?refresh=1 re-fetches the schema, rarity and player progress', async (t) => {
  _reset();
  const achievementsFetch = makeAchievementsFetch();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(url);
    return achievementsFetch(url);
  });
  const count = (part) => calls.filter((u) => u.includes(part)).length;

  await api.get(`/api/achievements/401?steamids=${ID1}`).expect(200);
  await api.get(`/api/achievements/401?steamids=${ID1}`).expect(200);
  await api.get(`/api/achievements/401?steamids=${ID1}&refresh=1`).expect(200);
  for (const part of ['GetSchemaForGame', 'GetGlobalAchievementPercentagesForApp', 'GetPlayerAchievements']) {
    assert.equal(count(part), 2, part);
  }
});

test('GET /api/achievements/:appid: private/no-data account is distinguished from no steamids at all', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('GetSchemaForGame')) {
      return {
        ok: true,
        json: async () => ({
          game: {
            availableGameStats: {
              achievements: [
                { name: 'ACH_1', displayName: 'First', description: '', icon: 'i1', icongray: 'g1', hidden: 0 },
              ],
            },
          },
        }),
      };
    }
    if (url.includes('GetGlobalAchievementPercentagesForApp')) return { ok: false, status: 403 };
    if (url.includes('GetPlayerAchievements')) return { ok: false, status: 403 }; // private profile
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const res = await api.get(`/api/achievements/400?steamids=${ID1}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.playerCount, 1);
  assert.equal(res.body.private, true);
});

test('GET /api/achievements/:appid: short-circuits on appdetails-confirmed zero achievements — schema/rarity/player calls are never made', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('appdetails')) {
      return {
        ok: true,
        json: async () => ({ 400: { success: true, data: { achievements: { total: 0, highlighted: [] } } } }),
      };
    }
    // Any of these firing would mean the short-circuit didn't work — fail loudly rather
    // than silently answering with fabricated achievement data.
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const res = await api.get(`/api/achievements/400?steamids=${ID1}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { achievements: [], total: 0, unlocked: 0, private: false, playerCount: 1 });
});

test('GET /api/achievements/:appid: appdetails failure falls back to the schema fetch instead of erroring', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('appdetails')) return { ok: false, status: 503 };
    return makeAchievementsFetch()(url);
  });

  const res = await api.get('/api/achievements/400');
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 2);
});

test('GET /api/achievements/:appid: schema-confirmed zero achievements skips rarity/per-player calls', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('appdetails')) {
      // achievementCount unknown (field absent) — forces the route to actually ask the schema.
      return { ok: true, json: async () => ({ 400: { success: true, data: {} } }) };
    }
    if (url.includes('GetSchemaForGame')) {
      return { ok: true, json: async () => ({ game: { availableGameStats: {} } }) }; // no achievements key
    }
    // Rarity/per-player firing here would mean the sequencing regressed back to batching
    // them alongside the schema fetch.
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const res = await api.get(`/api/achievements/400?steamids=${ID1}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { achievements: [], total: 0, unlocked: 0, private: false, playerCount: 1 });
});

test('GET /api/achievements/:appid: an unreleased game (schema 403, no achievements field in appdetails) answers empty instead of 502', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async (url) => {
    // Exactly what a pre-order page returns: no `achievements` key at all, so the route's
    // achievementCount short-circuit can't fire and the schema fetch is what has to cope.
    if (url.includes('appdetails')) return { ok: true, json: async () => ({ 400: { success: true, data: {} } }) };
    if (url.includes('GetSchemaForGame')) return { ok: false, status: 403, text: async () => '{"game":{}}' };
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const res = await api.get(`/api/achievements/400?steamids=${ID1}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { achievements: [], total: 0, unlocked: 0, private: false, playerCount: 1 });
});

test('GET /api/achievements/:appid: too many steamids is a 400', async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `7656119800000${String(i).padStart(4, '0')}`).join(',');
  const res = await api.get(`/api/achievements/400?steamids=${ids}`);
  assert.equal(res.status, 400);
});

test('GET /api/achievements/abc: 400 for non-numeric appid', async () => {
  const res = await api.get('/api/achievements/abc');
  assert.equal(res.status, 400);
});

// ── GET /api/bundles, POST /api/bundles/resolve ──────────────────────────────

test('GET /api/bundles: 503 when ITAD_API_KEY is not configured', async () => {
  const prev = process.env.ITAD_API_KEY;
  delete process.env.ITAD_API_KEY;
  try {
    const res = await api.get('/api/bundles');
    assert.equal(res.status, 503);
    // Shown as is to visitors, who can't act on a setup hint.
    assert.match(res.body.error, /aren't available on this instance/);
    assert.doesNotMatch(res.body.error, /ITAD_API_KEY|\.env/);
  } finally {
    if (prev !== undefined) process.env.ITAD_API_KEY = prev;
  }
});

test('POST /api/bundles/resolve: 503 when ITAD_API_KEY is not configured', async () => {
  const prev = process.env.ITAD_API_KEY;
  delete process.env.ITAD_API_KEY;
  try {
    const res = await api.post('/api/bundles/resolve').send({ gids: ['a'] });
    assert.equal(res.status, 503);
  } finally {
    if (prev !== undefined) process.env.ITAD_API_KEY = prev;
  }
});

test('GET /api/bundles: 200 with bundle list, defaults applied', async (t) => {
  _reset();
  process.env.ITAD_API_KEY = 'test-itad-key';
  const bundles = [{ id: 1, title: 'Test Bundle' }];
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.match(url, /\/bundles\/v1\?/);
    assert.match(url, /country=US/);
    assert.match(url, /offset=0/);
    assert.match(url, /limit=20/);
    return { ok: true, json: async () => bundles };
  });
  const res = await api.get('/api/bundles');
  assert.equal(res.status, 200);
  // fetchedAt is the age of this page of the list — a real timestamp here, since the fetch above
  // wrote its own cache entry (see the "Updated <when>" readout on the browse page).
  assert.deepEqual({ ...res.body, fetchedAt: undefined }, { bundles, offset: 0, limit: 20, fetchedAt: undefined });
  assert.equal(typeof res.body.fetchedAt, 'number');
});

test('POST /api/prices: reports fetchedAt for the batch', async (t) => {
  _reset();
  process.env.ITAD_API_KEY = 'test-itad-key';
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/service/shops/')) return { ok: true, json: async () => [{ id: 61, title: 'Steam' }] };
    return { ok: true, json: async () => [{ id: GID1, deals: [], historyLow: { all: null, y1: null, m3: null } }] };
  });
  const res = await api.post('/api/prices').send({ gids: [GID1] });
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.fetchedAt, 'number');
});

test('GET /api/bundles: clamps limit and validates country', async (t) => {
  _reset();
  process.env.ITAD_API_KEY = 'test-itad-key';
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.match(url, /country=US/); // invalid country falls back to default
    assert.match(url, /limit=50/); // clamped from 999
    return { ok: true, json: async () => [] };
  });
  const res = await api.get('/api/bundles?country=usa&limit=999');
  assert.equal(res.status, 200);
});

test('GET /api/bundles: 502 when the upstream call fails', async (t) => {
  _reset();
  process.env.ITAD_API_KEY = 'test-itad-key';
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 500 }));
  const res = await api.get('/api/bundles');
  assert.equal(res.status, 502);
});

test('GET /api/bundles and /api/game-bundles: a non-array 200 is a 502, refetched next time', async (t) => {
  _reset();
  process.env.ITAD_API_KEY = 'test-itad-key';
  t.mock.method(console, 'error', () => {});
  setCache('itad-gid:400', 'gid-1');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return { ok: true, json: async () => ({ error: 'oops' }) };
  });
  for (const path of ['/api/bundles', '/api/bundles', '/api/game-bundles/400', '/api/game-bundles/400']) {
    const res = await api.get(path);
    assert.equal(res.status, 502, path);
  }
  assert.equal(calls, 4);
});

test('an unexpected error answers 500 with a generic message, an unreadable reply 502 without quoting it', async (t) => {
  _reset();
  process.env.ITAD_API_KEY = 'test-itad-key';
  const logged = t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => {
      throw new TypeError('Cannot read properties of undefined (internal detail)');
    },
  }));
  let res = await api.get('/api/bundles');
  assert.equal(res.status, 500);
  assert.doesNotMatch(res.body.error, /internal detail/);
  assert.match(String(logged.mock.calls.at(-1).arguments[1]), /internal detail/);

  _reset();
  t.mock.method(globalThis, 'fetch', async () => new Response('<!DOCTYPE html><p>secret</p>', { status: 200 }));
  res = await api.get('/api/bundles');
  assert.equal(res.status, 502);
  assert.doesNotMatch(res.body.error, /DOCTYPE|secret/);
});

// ── GET /api/game-bundles/:appid ──────────────────────────────────────────────

test('GET /api/game-bundles/:appid: 503 when ITAD_API_KEY is not configured', async () => {
  const prev = process.env.ITAD_API_KEY;
  delete process.env.ITAD_API_KEY;
  try {
    const res = await api.get('/api/game-bundles/400');
    assert.equal(res.status, 503);
  } finally {
    if (prev !== undefined) process.env.ITAD_API_KEY = prev;
  }
});

test('GET /api/game-bundles/abc: 400 for non-numeric appid', async () => {
  process.env.ITAD_API_KEY = 'test-itad-key';
  const res = await api.get('/api/game-bundles/abc');
  assert.equal(res.status, 400);
});

test('GET /api/game-bundles/:appid: empty without an ITAD listing, no bundle lookup', async (t) => {
  _reset();
  process.env.ITAD_API_KEY = 'test-itad-key';
  setCache('itad-gid:400', null);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 500 }));
  const res = await api.get('/api/game-bundles/400');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { bundles: [] });
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('GET /api/game-bundles/:appid: 200 with the bundles the game is in', async (t) => {
  _reset();
  process.env.ITAD_API_KEY = 'test-itad-key';
  setCache('itad-gid:400', 'gid-1');
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.match(String(url), /\/games\/bundles\/v2\?.*id=gid-1.*country=DE/);
    return {
      ok: true,
      json: async () => [
        {
          id: 7,
          title: 'B',
          page: { name: 'Humble Bundle' },
          url: 'https://shop.example/7',
          expiry: null,
          tiers: [{ price: { amount: 5, currency: 'EUR' }, games: [{ id: 'gid-1' }] }],
        },
      ],
    };
  });
  const res = await api.get('/api/game-bundles/400?country=de');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.bundles, [
    {
      id: 7,
      title: 'B',
      shop: 'Humble Bundle',
      url: 'https://shop.example/7',
      expiry: null,
      tierPrice: 5,
      tierCurrency: 'EUR',
      tierPriceMax: null,
    },
  ]);
});

test('GET /api/game-bundles/:appid: ?refresh=1 re-fetches the bundles despite the cache', async (t) => {
  _reset();
  process.env.ITAD_API_KEY = 'test-itad-key';
  setCache('itad-gid:402', 'gid-2');
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) => {
    assert.match(String(url), /\/games\/bundles\/v2\?/);
    return { ok: true, json: async () => [] };
  });

  await api.get('/api/game-bundles/402').expect(200);
  await api.get('/api/game-bundles/402').expect(200);
  assert.equal(fetchMock.mock.callCount(), 1);
  await api.get('/api/game-bundles/402?refresh=1').expect(200);
  assert.equal(fetchMock.mock.callCount(), 2);
});

test('GET /api/game-bundles/:appid: adds Fanatical pick-and-mix tiers to a null-price bundle', async (t) => {
  _reset();
  process.env.ITAD_API_KEY = 'test-itad-key';
  setCache('itad-gid:400', 'gid-1');
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).startsWith('https://www.fanatical.com/'))
      return {
        ok: true,
        json: async () => ({
          pickandmix: [{ slug: 'byo-test', tiers: [{ quantity: 3, price: { EUR: 500 } }], products: [] }],
        }),
      };
    return {
      ok: true,
      json: async () => [
        {
          id: 43,
          title: 'BYO',
          page: { name: 'Fanatical' },
          url: 'https://www.fanatical.com/en/pick-and-mix/byo-test',
          tiers: [{ price: null, games: [{ id: 'gid-1' }] }],
        },
      ],
    };
  });
  const res = await api.get('/api/game-bundles/400');
  assert.equal(res.status, 200);
  assert.equal(res.body.bundles[0].tierPrice, null);
  assert.deepEqual(res.body.bundles[0].pickAndMix, [{ quantity: 3, prices: { EUR: 5 } }]);
});

test('GET /api/game-bundles/:appid: 502 when the upstream call fails', async (t) => {
  _reset();
  process.env.ITAD_API_KEY = 'test-itad-key';
  setCache('itad-gid:400', 'gid-1');
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 500 }));
  const res = await api.get('/api/game-bundles/400');
  assert.equal(res.status, 502);
});

test("GET /api/bundles: a Fanatical pick-and-mix ITAD expired early is appended to the active list, with Fanatical's end date", async (t) => {
  _reset();
  process.env.ITAD_API_KEY = 'test-itad-key';
  const killer = {
    id: 16542,
    title: 'Build Your Own Killer Bundle',
    page: { name: 'Fanatical' },
    url: 'https://www.fanatical.com/en/pick-and-mix/byo-killer',
    expiry: '2001-01-01T00:58:54+01:00',
    publish: '2026-09-07T13:00:00Z',
    tiers: [{ price: null, games: [{ id: 'gid-k' }] }],
  };
  const feed = {
    pickandmix: [
      {
        slug: 'byo-killer',
        type: 'bundle',
        valid_from: '2026-09-07T13:00:00.000Z',
        valid_until: '2099-11-13T23:59:00.000Z',
        tiers: [{ quantity: 5, price: { USD: 599 } }],
        products: [],
      },
    ],
  };
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).startsWith('https://www.fanatical.com/')) return { ok: true, json: async () => feed };
    const expired = new URL(url).searchParams.get('expired') === 'true';
    return { ok: true, json: async () => (expired ? [killer] : [{ id: 1, title: 'Humble One' }]) };
  });
  const res = await api.get('/api/bundles?limit=50');
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.bundles.map((b) => [b.id, b.expiry ?? null]),
    [
      [1, null],
      [16542, '2099-11-13T23:59:00.000Z'],
    ],
  );
  // The next page (the client asks while a page holds 50) and "Include expired" add nothing more.
  assert.deepEqual((await api.get('/api/bundles?limit=50&offset=2')).body.bundles, [{ id: 1, title: 'Humble One' }]);
  const withExpired = await api.get('/api/bundles?limit=50&expired=1');
  assert.deepEqual(
    withExpired.body.bundles.map((b) => [b.id, b.expiry]),
    [[16542, '2099-11-13T23:59:00.000Z']],
  );
  const calls = fetchMock.mock.callCount();
  await api.get('/api/bundles?limit=50');
  assert.equal(fetchMock.mock.callCount(), calls, 'every page cached');
});

test('GET /api/game-bundles/:appid: a bundle ITAD expired early is added from the cached list pages', async (t) => {
  _reset();
  process.env.ITAD_API_KEY = 'test-itad-key';
  setCache('itad-gid:400', 'gid-k');
  const killer = {
    id: 16542,
    title: 'Build Your Own Killer Bundle',
    page: { name: 'Fanatical' },
    url: 'https://www.fanatical.com/en/pick-and-mix/byo-killer',
    expiry: '2001-01-01T00:58:54+01:00',
    publish: '2026-09-07T13:00:00Z',
    tiers: [{ price: null, games: [{ id: 'gid-k' }] }],
  };
  setCache('itad-bundles:US:-publish:false:0:50', [{ id: 1 }]);
  setCache('itad-bundles:US:-publish:true:0:50', [{ id: 2 }, killer]);
  setCache('fanatical-pnm:v3', {
    'byo-killer': {
      tiers: [{ quantity: 5, prices: { USD: 5.99 } }],
      products: [],
      type: 'bundle',
      validFrom: '2026-09-07T13:00:00.000Z',
      validUntil: '2099-11-13T23:59:00.000Z',
    },
  });
  // ITAD's own answer for the game: current bundles only, so not the Killer one.
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => [] }));
  const res = await api.get('/api/game-bundles/400');
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.bundles.map((b) => [b.id, b.expiry]),
    [[16542, '2099-11-13T23:59:00.000Z']],
  );
  assert.equal(fetchMock.mock.callCount(), 1, "only ITAD's game-bundles call");
});

// ── GET /api/bundles/:id ──────────────────────────────────────────────────────

test('GET /api/bundles/:id: 503 when ITAD_API_KEY is not configured', async () => {
  const prev = process.env.ITAD_API_KEY;
  delete process.env.ITAD_API_KEY;
  try {
    const res = await api.get('/api/bundles/42');
    assert.equal(res.status, 503);
  } finally {
    if (prev !== undefined) process.env.ITAD_API_KEY = prev;
  }
});

test('GET /api/bundles/abc: 400 for non-numeric id', async () => {
  process.env.ITAD_API_KEY = 'test-itad-key';
  const res = await api.get('/api/bundles/abc');
  assert.equal(res.status, 400);
});

test('GET /api/bundles/:id: 200 with the matching bundle', async (t) => {
  _reset();
  process.env.ITAD_API_KEY = 'test-itad-key';
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = new URL(url);
    if (u.searchParams.get('expired') === 'true') return { ok: true, json: async () => [] };
    return { ok: true, json: async () => [{ id: 42, title: 'Deep-Linked Bundle' }] };
  });
  const res = await api.get('/api/bundles/42');
  assert.equal(res.status, 200);
  assert.equal(res.body.bundle?.title, 'Deep-Linked Bundle');
});

test('GET /api/bundles/:id: adds Fanatical pick-and-mix tiers and product names to a null-price bundle', async (t) => {
  _reset();
  process.env.ITAD_API_KEY = 'test-itad-key';
  const bundle = {
    id: 43,
    title: 'BYO',
    page: { name: 'Fanatical' },
    url: 'https://www.fanatical.com/en/pick-and-mix/byo-test',
    tiers: [{ price: null, games: [{ id: 'g1', slug: 'x-game', title: 'X Game' }] }],
  };
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).startsWith('https://www.fanatical.com/'))
      return {
        ok: true,
        json: async () => ({
          pickandmix: [
            {
              slug: 'byo-test',
              tiers: [{ quantity: 3, price: { EUR: 500 } }],
              products: [{ name: 'X Game', slug: 'x-game' }],
            },
          ],
        }),
      };
    return { ok: true, json: async () => (new URL(url).searchParams.get('expired') === 'true' ? [] : [bundle]) };
  });
  const res = await api.get('/api/bundles/43');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.bundle.pickAndMix, [{ quantity: 3, prices: { EUR: 5 } }]);
  assert.deepEqual(res.body.bundle.pickAndMixNames, { g1: 'X Game' });
});

test('GET /api/bundles/:id: 404 when the id is never found', async (t) => {
  _reset();
  process.env.ITAD_API_KEY = 'test-itad-key';
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => [] }));
  const res = await api.get('/api/bundles/999999');
  assert.equal(res.status, 404);
});

test('POST /api/bundles/resolve: 400 without gids', async () => {
  process.env.ITAD_API_KEY = 'test-itad-key';
  const res = await api.post('/api/bundles/resolve').send({});
  assert.equal(res.status, 400);
});

test('POST /api/bundles/resolve: 200 with resolved appids map', async (t) => {
  _reset();
  process.env.ITAD_API_KEY = 'test-itad-key';
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (String(url).includes('/service/shops/')) return { ok: true, json: async () => [{ id: 61, title: 'Steam' }] };
    const gids = JSON.parse(opts.body);
    const body = Object.fromEntries(gids.map((g) => [g, g === GID1 ? ['app/400'] : null]));
    return { ok: true, json: async () => body };
  });
  const res = await api.post('/api/bundles/resolve').send({ gids: [GID1, GID2] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { appids: { [GID1]: 400, [GID2]: null } });
});

test('POST /api/bundles/resolve: a gid whose Steam expansion errored is reported as failed, not as no Steam listing', async (t) => {
  _reset();
  process.env.ITAD_API_KEY = 'test-itad-key';
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const u = String(url);
    if (u.includes('/service/shops/')) return { ok: true, json: async () => [{ id: 61, title: 'Steam' }] };
    if (u.includes('/lookup/shop/')) {
      const gids = JSON.parse(opts.body);
      return { ok: true, json: async () => Object.fromEntries(gids.map((g) => [g, ['sub/1234']])) };
    }
    return { ok: false, status: 500 }; // packagedetails and the games/info/v2 fallback
  });
  const res = await api
    .post('/api/bundles/resolve')
    .send({ gids: [GID1] })
    .expect(200);
  assert.deepEqual(res.body, { appids: {}, failed: [GID1] });
});

test('POST /api/prices: 503 when ITAD_API_KEY is not configured', async () => {
  const prev = process.env.ITAD_API_KEY;
  delete process.env.ITAD_API_KEY;
  try {
    const res = await api.post('/api/prices').send({ gids: ['a'] });
    assert.equal(res.status, 503);
  } finally {
    if (prev !== undefined) process.env.ITAD_API_KEY = prev;
  }
});

test('POST /api/prices: 400 with neither gids nor appids', async () => {
  process.env.ITAD_API_KEY = 'test-itad-key';
  const res = await api.post('/api/prices').send({});
  assert.equal(res.status, 400);
});

test('POST /api/prices: 400 with both gids and appids', async () => {
  process.env.ITAD_API_KEY = 'test-itad-key';
  const res = await api.post('/api/prices').send({ gids: [GID1], appids: [400] });
  assert.equal(res.status, 400);
});

test('POST /api/prices: 200 with Steam regular price and historical lows, by gids', async (t) => {
  _reset();
  process.env.ITAD_API_KEY = 'test-itad-key';
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/service/shops/')) return { ok: true, json: async () => [{ id: 61, title: 'Steam' }] };
    if (String(url).includes('/games/prices/v3')) {
      return {
        ok: true,
        json: async () => [
          {
            id: GID1,
            historyLow: { all: { amount: 1, amountInt: 100, currency: 'USD' }, y1: null, m3: null },
            deals: [
              {
                shop: { id: 61, name: 'Steam' },
                regular: { amount: 20, amountInt: 2000, currency: 'USD' },
                price: { amount: 20, amountInt: 2000, currency: 'USD' },
              },
              {
                shop: { id: 6, name: 'Fanatical' },
                regular: { amount: 20, amountInt: 2000, currency: 'USD' },
                price: { amount: 15, amountInt: 1500, currency: 'USD' },
                cut: 25,
              },
            ],
          },
        ],
      };
    }
    return { ok: false, status: 500 };
  });
  const res = await api.post('/api/prices?country=US').send({ gids: [GID1] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.prices[GID1], {
    steamRegular: { amount: 20, amountInt: 2000, currency: 'USD' },
    lowAll: { amount: 1, amountInt: 100, currency: 'USD' },
    lowY1: null,
    lowM3: null,
    bestDeal: { price: { amount: 15, amountInt: 1500, currency: 'USD' }, shop: 'Fanatical', url: null },
  });
});

test('POST /api/prices: refresh=1 bypasses the price cache and re-fetches, without re-resolving gids', async (t) => {
  _reset();
  process.env.ITAD_API_KEY = 'test-itad-key';
  let priceCalls = 0;
  let resolveCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (String(url).includes('/service/shops/')) return { ok: true, json: async () => [{ id: 61, title: 'Steam' }] };
    if (String(url).includes('/lookup/id/shop/')) {
      resolveCalls++;
      const keys = JSON.parse(opts.body);
      return { ok: true, json: async () => Object.fromEntries(keys.map((k) => [k, 'gid-1'])) };
    }
    if (String(url).includes('/games/prices/v3')) {
      priceCalls++;
      return {
        ok: true,
        json: async () => [
          {
            id: 'gid-1',
            historyLow: { all: null, y1: null, m3: null },
            deals: [
              {
                shop: { id: 61, name: 'Steam' },
                regular: { amount: 20, amountInt: 2000, currency: 'USD' },
                price: { amount: 20, amountInt: 2000, currency: 'USD' },
                cut: 0,
              },
            ],
          },
        ],
      };
    }
    return { ok: false, status: 500 };
  });
  await api.post('/api/prices?country=US').send({ appids: [400] });
  assert.equal(priceCalls, 1);
  assert.equal(resolveCalls, 1);

  const cached = await api.post('/api/prices?country=US').send({ appids: [400] });
  assert.equal(priceCalls, 1, 'plain repeat should be a cache hit');
  assert.equal(resolveCalls, 1, 'gid resolution should also be cached');
  assert.equal(cached.status, 200);

  const refreshed = await api.post('/api/prices?country=US&refresh=1').send({ appids: [400] });
  assert.equal(refreshed.status, 200);
  assert.equal(priceCalls, 2, 'refresh=1 should re-fetch the price even though it was cached');
  assert.equal(resolveCalls, 1, 'refresh=1 should NOT force the appid→gid resolution — that stays cached');
});

test('POST /api/prices: 400 with appids that are not positive integers', async () => {
  process.env.ITAD_API_KEY = 'test-itad-key';
  const res = await api.post('/api/prices').send({ appids: [400, 'nope'] });
  assert.equal(res.status, 400);
});

test('POST /api/prices: 200 by appids — resolves to gids first, then prices, keyed back by appid', async (t) => {
  _reset();
  process.env.ITAD_API_KEY = 'test-itad-key';
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (String(url).includes('/service/shops/')) return { ok: true, json: async () => [{ id: 61, title: 'Steam' }] };
    if (String(url).includes('/lookup/id/shop/')) {
      const keys = JSON.parse(opts.body); // ["app/400", "app/500"]
      const body = Object.fromEntries(keys.map((k) => [k, k === 'app/400' ? 'gid-1' : null]));
      return { ok: true, json: async () => body };
    }
    if (String(url).includes('/games/prices/v3')) {
      return {
        ok: true,
        json: async () => [
          {
            id: 'gid-1',
            historyLow: { all: null, y1: null, m3: null },
            deals: [
              {
                shop: { id: 61, name: 'Steam' },
                regular: { amount: 20, amountInt: 2000, currency: 'USD' },
                price: { amount: 20, amountInt: 2000, currency: 'USD' },
                cut: 0,
              },
            ],
          },
        ],
      };
    }
    return { ok: false, status: 500 };
  });
  const res = await api.post('/api/prices?country=US').send({ appids: [400, 500] });
  assert.equal(res.status, 200);
  // 400 resolved to a real gid and got priced; 500 had no ITAD listing at all (null gid) — both
  // still get an entry, keyed by their own appid, not the internal gid.
  assert.deepEqual(res.body.prices['400'], {
    steamRegular: { amount: 20, amountInt: 2000, currency: 'USD' },
    lowAll: null,
    lowY1: null,
    lowM3: null,
    bestDeal: { price: { amount: 20, amountInt: 2000, currency: 'USD' }, shop: 'Steam', url: null },
  });
  assert.deepEqual(res.body.prices['500'], {
    steamRegular: null,
    lowAll: null,
    lowY1: null,
    lowM3: null,
    bestDeal: null,
  });
});

for (const [name, path, body, error] of [
  [
    'POST /api/prices: 400 when gids are not all ITAD ids',
    '/api/prices',
    { gids: [GID1, 42] },
    /gids must be ITAD game ids/,
  ],
  [
    'POST /api/prices: 400 with more than 500 games',
    '/api/prices',
    { appids: Array.from({ length: 501 }, (_, i) => i + 1) },
    /Too many games/,
  ],
  [
    'POST /api/bundles/resolve: 400 with more than 500 games',
    '/api/bundles/resolve',
    { gids: Array.from({ length: 501 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`) },
    /Too many games/,
  ],
]) {
  test(name, async (t) => {
    _reset();
    process.env.ITAD_API_KEY = 'test-itad-key';
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 500 }));
    const res = await api.post(path).send(body);
    assert.equal(res.status, 400);
    assert.match(res.body.error, error);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
}

// Every upstream call answers 500: each route maps the failure to a 502 with its message.
for (const [name, request] of [
  ['GET /api/bundles/:id', () => api.get('/api/bundles/9001')],
  ['POST /api/bundles/resolve', () => api.post('/api/bundles/resolve').send({ gids: [GID1] })],
  ['POST /api/prices', () => api.post('/api/prices').send({ gids: [GID1] })],
  ['GET /api/game-news/:appid', () => api.get('/api/game-news/9002')],
  ['GET /api/achievements/:appid', () => api.get('/api/achievements/9003')],
]) {
  test(`${name}: 502 when the upstream call fails`, async (t) => {
    _reset();
    _resetCircuitBreakers();
    process.env.ITAD_API_KEY = 'test-itad-key';
    t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'warn', () => {});
    t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 500 }));
    const res = await request();
    assert.equal(res.status, 502);
    assert.match(res.body.error, /error 500/);
  });
}

// ── Route input validation (each input lands in a cache key) ─────────────────

const cacheRows = () => Object.values(getCacheEntryCounts()).reduce((a, b) => a + b, 0);

for (const path of ['/api/bundles/resolve', '/api/prices']) {
  test(`POST ${path}: 400 for a gid that isn't an ITAD id, nothing fetched or cached`, async (t) => {
    _reset();
    process.env.ITAD_API_KEY = 'test-itad-key';
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({}) }));
    const res = await api.post(path).send({ gids: [GID1, 'x'.repeat(90_000)] });
    assert.equal(res.status, 400);
    assert.equal(typeof res.body.error, 'string');
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.equal(cacheRows(), 0);
  });
}

test('POST /api/common-games: 400 for a 90 KB vanity name, nothing fetched or cached', async (t) => {
  _reset();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ response: { success: 42 } }),
  }));
  const res = await api.post('/api/common-games').send({ members: ['x'.repeat(90_000)] });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.length < 200, 'the error does not echo the whole input');
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(cacheRows(), 0);
});

test('GET /api/achievements/:appid: 400 for a steamids value that is no Steam account, nothing fetched or cached', async (t) => {
  _reset();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ response: { success: 42 } }),
  }));
  const res = await api.get(`/api/achievements/400?steamids=${ID1},${'x'.repeat(4000)}`);
  assert.equal(res.status, 400);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(cacheRows(), 0);
});

// Every form the frontend sends: a Steam64 id (signed-in user, resolved accounts), a vanity name
// (Home's normalizeInput), a profile URL (Compare's typed slots and `u=` links pass it through raw).
for (const member of [
  ID1,
  'gaben',
  ' gaben ',
  'some_name-2',
  'https://steamcommunity.com/id/gaben/',
  'https://steamcommunity.com/id/gaben',
  `https://steamcommunity.com/profiles/${ID1}`,
  `https://steamcommunity.com/profiles/${ID1}/`,
]) {
  test(`POST /api/common-games: accepts the frontend's member form ${JSON.stringify(member)}`, async (t) => {
    _reset();
    const library = makeLibraryFetch([{ appid: 1, name: 'A' }]);
    t.mock.method(globalThis, 'fetch', async (url) =>
      url.includes('ResolveVanityURL')
        ? { ok: true, json: async () => ({ response: { success: 1, steamid: ID1 } }) }
        : library(url),
    );
    const res = await api.post('/api/common-games').send({ members: [member] });
    assert.equal(res.status, 200, res.body.error);
  });
}

test('GET /api/bundles: a country outside the region list falls back to US', async (t) => {
  _reset();
  process.env.ITAD_API_KEY = 'test-itad-key';
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    return { ok: true, json: async () => [] };
  });
  await api.get('/api/bundles?country=zz').expect(200);
  await api.get('/api/bundles?country=de').expect(200);
  const itad = urls.filter((u) => u.startsWith('https://api.isthereanydeal.com/'));
  assert.match(itad[0], /country=US/);
  assert.match(itad[1], /country=DE/);
});

test('GET /api/bundles: an unknown sort falls back to the default, offset is an integer', async (t) => {
  _reset();
  process.env.ITAD_API_KEY = 'test-itad-key';
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(new URL(String(url)).searchParams);
    return { ok: true, json: async () => [{ id: 1, title: 'B' }] };
  });
  await api.get('/api/bundles?sort=junk&offset=50.5').expect(200);
  assert.equal(urls[0].get('sort'), '-publish');
  assert.equal(urls[0].get('offset'), '50');
});

test('GET /api/bundles: a non-finite offset reads as 0, a fractional limit clamps to 1', async (t) => {
  _reset();
  process.env.ITAD_API_KEY = 'test-itad-key';
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(new URL(String(url)).searchParams);
    return { ok: true, json: async () => [{ id: 1, title: 'B' }] };
  });
  const res = await api.get('/api/bundles?offset=Infinity&limit=0.5').expect(200);
  assert.equal(res.body.offset, 0);
  assert.equal(res.body.limit, 1);
  assert.equal(urls[0].get('offset'), '0');
  assert.equal(urls[0].get('limit'), '1');
});

// Load more stops at an empty page: a clamped offset would serve the cap's page again and again.
test('GET /api/bundles: an empty page past the offset cap, without an upstream call', async (t) => {
  _reset();
  process.env.ITAD_API_KEY = 'test-itad-key';
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => [{ id: 1 }] }));
  const res = await api.get('/api/bundles?offset=1e9').expect(200);
  assert.deepEqual(res.body.bundles, []);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(cacheRows(), 0);
});

// ── fetchedAt (how old the served data is) ────────────────────────────────────

test('POST /api/common-games: fetchedAt is null on a fresh fetch, then the cache write time', async (t) => {
  _reset();
  const GAME = { appid: 400, name: 'Portal' };
  t.mock.method(globalThis, 'fetch', makeLibraryFetch([GAME], []));

  const fresh = await api.post('/api/common-games').send({ members: [ID1] });
  assert.equal(fresh.status, 200);
  // The library was fetched during this very request, so the entry it wrote is "just now" —
  // reported as a real timestamp, not null (null only happens when a key isn't cached at all).
  assert.equal(typeof fresh.body.fetchedAt, 'number');

  const cached = await api.post('/api/common-games').send({ members: [ID1] });
  assert.equal(cached.body.fetchedAt, fresh.body.fetchedAt);
});

test('POST /api/common-games: fetchedAt reports the OLDEST member', async (t) => {
  _reset();
  const old = Date.now() - 60 * 60 * 1000;
  _reset([
    [`games:${ID1}`, { value: [{ appid: 400, name: 'Portal', playtime_forever: 0 }], ts: old }],
    [`games:${ID2}`, { value: [{ appid: 400, name: 'Portal', playtime_forever: 0 }], ts: Date.now() }],
    [`player:${ID1}`, { value: { steamid: ID1, personaname: 'A', profileurl: '' }, ts: Date.now() }],
    [`player:${ID2}`, { value: { steamid: ID2, personaname: 'B', profileurl: '' }, ts: Date.now() }],
  ]);
  t.mock.method(globalThis, 'fetch', makeLibraryFetch([], []));

  const res = await api.post('/api/common-games').send({ members: [ID1, ID2] });
  assert.equal(res.status, 200);
  assert.equal(res.body.fetchedAt, old);
});

test('POST /api/wishlist: fetchedAt comes from the wishlist entries', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', makeWishlistFetch([{ appid: 400, priority: 1 }], []));
  const res = await api.post('/api/wishlist').send({ members: [ID1] });
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.fetchedAt, 'number');
});

test('POST /api/game-details/stream: caps in-flight appids and stops fetching once the client disconnects', async (t) => {
  _reset();
  const concurrency = Number(process.env.STREAM_CONCURRENCY);
  // Every appid queues one reviews call on its semaphore (3 at a time): active + queued counts the appids in flight.
  const reviewsPending = () => {
    const { active, queued } = getSemaphoreStats().reviews;
    return active + queued;
  };
  let started = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (!String(url).includes('GetAppReviews')) return { ok: true, json: async () => ({}) };
    started++;
    await gate;
    return {
      ok: true,
      json: async () => ({
        response: { query_summary: { review_score_desc: 'x', total_positive: 1, total_negative: 0, total_reviews: 1 } },
      }),
    };
  });

  const server = http.createServer(app).listen(0);
  // On a failure too: a held game or an open connection would keep the file from exiting.
  t.after(() => {
    release();
    server.closeAllConnections();
    server.close();
  });
  let sockets = 0;
  server.on('connection', (socket) => (sockets++, socket.once('close', () => sockets--)));
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const payload = JSON.stringify({ games: Array.from({ length: 200 }, (_, i) => ({ appid: i + 1 })) });
  const req = http.request({
    host: '127.0.0.1',
    port,
    path: '/api/game-details/stream',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  });
  req.write(payload);
  req.end();
  await new Promise((r) => req.once('response', r));

  // Only STREAM_CONCURRENCY of the 200 are ever in flight — the whole list used to be
  // dispatched synchronously, straight onto lib/steam.js's shared semaphore queues.
  await until(() => reviewsPending() >= concurrency, 'every worker queuing its first game');
  await new Promise((r) => setImmediate(r)); // a pool past its cap queues more games here
  assert.equal(reviewsPending(), concurrency);

  req.destroy();
  await until(() => sockets === 0, 'the server seeing the disconnect');
  const startedAtDisconnect = started;
  release();
  await until(() => reviewsPending() === 0, 'the held games answered');
  await new Promise((r) => setImmediate(r)); // a pool that kept going starts its next games here
  // A disconnect stops the pool within one appid per worker, rather than working
  // through the remaining 180-odd games for a client that has gone.
  assert.ok(started - startedAtDisconnect <= concurrency, `kept going: ${started - startedAtDisconnect}`);
});

test('POST /api/game-details/stream: fully cached games come first, ahead of uncached ones listed before them', async (t) => {
  _reset();
  _resetAuth();
  const cached = [1001, 1002, 1003, 1004, 1005];
  for (const appid of cached) {
    setCache(`rating:${appid}`, { total_reviews: 10, total_positive: 9, review_score_desc: 'Positive' });
    setCache(`hltb:${appid}`, []);
    setCache(`meta:${appid}`, { name: `Game ${appid}` });
    setCache(`browse:${appid}`, { tagids: TAG_IDS });
    setCache(`protondb:${appid}`, null);
  }
  setCache('tagnames:all', TAG_NAME_MAP);
  // Uncached games' reviews hang until released, holding the workers that took them.
  let started = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) => {
    if (!String(url).includes('GetAppReviews')) return { ok: true, json: async () => ({}) };
    started++;
    await gate;
    return { ok: true, json: async () => ({ response: { query_summary: { total_reviews: 0 } } }) };
  });

  const server = app.listen(0);
  t.after(() => new Promise((r) => server.close(r)));
  await new Promise((r) => server.once('listening', r));
  const uncached = Array.from({ length: 20 }, (_, i) => i + 1);
  const response = ssePost(server.address().port, '/api/game-details/stream', {
    games: [...uncached, ...cached].map((appid) => ({ appid })),
  });
  // The pool's workers take their first game together, before any request goes out.
  await until(() => started > 0, 'an uncached game reaching the reviews endpoint');
  release();
  const events = parseSseEvents((await response).body).filter((e) => e.appid);
  assert.deepEqual(
    events.slice(0, cached.length).map((e) => e.appid),
    cached,
  );
  assert.equal(events.length, uncached.length + cached.length);
  // Only the order changes: the same games reach the upstreams.
  assert.equal(
    fetchMock.mock.calls.filter(({ arguments: [url] }) => String(url).includes('GetAppReviews')).length,
    uncached.length,
  );
});

// ── Authentication (Steam OpenID) ────────────────────────────────────────────

// supertest serves each request on a fresh port; the callback checks return_to against the host.
const HOST = 'app.example';

// Runs the full login handshake through a cookie-persisting agent and returns it, already
// signed in as `steamid`. Mocks the one outbound call (the check_authentication POST to Steam).
async function loginAs(t, steamid) {
  const agent = supertest.agent(app);
  const loginRes = await agent.get('/auth/steam/login').set('Host', HOST).expect(302);
  const returnTo = new URL(new URL(loginRes.headers.location).searchParams.get('openid.return_to'));
  const state = returnTo.searchParams.get('state');

  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, text: async () => 'is_valid:true' }));
  await agent
    .get('/auth/steam/callback')
    .set('Host', HOST)
    .query({ state, ...steamAssertion(steamid, returnTo.href) })
    .expect(302)
    .expect('Location', '/');

  return agent;
}

// The openid.* params Steam appends to return_to after signing `steamid` in, each with its own
// nonce: the callback rejects a reused one.
function steamAssertion(steamid, returnTo) {
  const claimedId = `https://steamcommunity.com/openid/id/${steamid}`;
  return {
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'id_res',
    'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
    'openid.claimed_id': claimedId,
    'openid.identity': claimedId,
    'openid.return_to': returnTo,
    'openid.response_nonce': freshNonce(),
    'openid.assoc_handle': '1234567890',
    'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
    'openid.sig': 'abc',
  };
}

test('GET /auth/steam/login: redirects to Steam with a return_to and state, and sets a state cookie', async () => {
  const res = await api.get('/auth/steam/login').expect(302);
  const location = new URL(res.headers.location);
  assert.equal(location.hostname, 'steamcommunity.com');
  assert.match(res.headers['set-cookie'][0], /^steam_login_state=/);
});

test('GET /auth/steam/callback: 400 when the state cookie is missing or does not match', async () => {
  await api.get('/auth/steam/callback').query({ state: 'nope' }).expect(400);
});

test('GET /auth/steam/callback: 400 when Steam does not confirm the assertion', async (t) => {
  const loginRes = await api.get('/auth/steam/login').set('Host', HOST).expect(302);
  const stateCookie = loginRes.headers['set-cookie'][0];
  const state = new URL(new URL(loginRes.headers.location).searchParams.get('openid.return_to')).searchParams.get(
    'state',
  );

  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, text: async () => 'is_valid:false' }));
  await api
    .get('/auth/steam/callback')
    .set('Host', HOST)
    .set('Cookie', stateCookie)
    .query({
      state,
      ...steamAssertion('76561198000000201', new URL(loginRes.headers.location).searchParams.get('openid.return_to')),
    })
    .expect(400);
});

test('GET /auth/steam/callback: 502 when Steam cannot be reached to verify the assertion', async (t) => {
  const steamid = '76561198000000210';
  const loginRes = await api.get('/auth/steam/login').set('Host', HOST).expect(302);
  const stateCookie = loginRes.headers['set-cookie'][0];
  const returnTo = new URL(new URL(loginRes.headers.location).searchParams.get('openid.return_to'));

  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed');
  });
  const res = await api
    .get('/auth/steam/callback')
    .set('Host', HOST)
    .set('Cookie', stateCookie)
    .query({ state: returnTo.searchParams.get('state'), ...steamAssertion(steamid, returnTo.href) })
    .expect(502);
  const cookies = String(res.headers['set-cookie']);
  assert.match(cookies, /steam_login_state=;.*Max-Age=0/);
  assert.ok(!cookies.includes('sid='));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE steamid = ?').get(steamid).n, 0);
});

test("GET /auth/steam/callback: 400 for another site's assertion replayed with this site's own state", async (t) => {
  const loginRes = await api.get('/auth/steam/login').set('Host', HOST).expect(302);
  const stateCookie = loginRes.headers['set-cookie'][0];
  const state = new URL(new URL(loginRes.headers.location).searchParams.get('openid.return_to')).searchParams.get(
    'state',
  );

  // Steam would confirm it: the signature is genuine, only for a login at another site.
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({ ok: true, text: async () => 'is_valid:true' }));
  const res = await api
    .get('/auth/steam/callback')
    .set('Host', HOST)
    .set('Cookie', stateCookie)
    .query({
      state,
      ...steamAssertion('76561198000000203', 'https://evil.example/auth/steam/callback?state=x'),
    })
    .expect(400);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.ok(!String(res.headers['set-cookie']).includes('sid='));
});

test('request log: the Steam callback is logged without its query, which carries the signed assertion', () => {
  const logUrl = (originalUrl) => morgan.url({ originalUrl, url: originalUrl }, {});
  assert.equal(logUrl('/auth/steam/callback?state=s&openid.sig=abc'), '/auth/steam/callback');
  assert.equal(logUrl('/AUTH/Steam/callback/?state=s&openid.sig=abc'), '/AUTH/Steam/callback/');
  assert.equal(logUrl('/api/library?steamid=1'), '/api/library?steamid=1');
});

test('login flow → GET /api/me: returns the signed-in steamid and empty prefs on first login', async (t) => {
  const agent = await loginAs(t, '76561198000000202');
  const res = await agent.get('/api/me').expect(200);
  assert.deepEqual(res.body, { steamid: '76561198000000202', prefs: {} });
});

test("GET /api/me: 200 with a null steamid/prefs when not signed in — checking status isn't an error", async () => {
  const res = await api.get('/api/me').expect(200);
  assert.deepEqual(res.body, { steamid: null, prefs: null });
});

test('PUT /api/me/prefs/:key: saves one key with its updatedAt, visible from a later GET /api/me', async (t) => {
  const agent = await loginAs(t, '76561198000000203');
  await agent
    .put('/api/me/prefs/myAccount')
    .send({ value: { id: '76561198000000203' }, updatedAt: 1000 })
    .expect(200);
  const res = await agent.get('/api/me').expect(200);
  assert.deepEqual(res.body.prefs, { myAccount: { value: { id: '76561198000000203' }, updatedAt: 1000 } });
});

test('PUT /api/me/prefs/:key: merges into existing prefs, leaving other keys untouched', async (t) => {
  const agent = await loginAs(t, '76561198000000206');
  await agent.put('/api/me/prefs/region').send({ value: 1, updatedAt: 1000 }).expect(200);
  await agent.put('/api/me/prefs/lists').send({ value: 2, updatedAt: 1000 }).expect(200);
  const res = await agent.get('/api/me').expect(200);
  assert.deepEqual(res.body.prefs, { region: { value: 1, updatedAt: 1000 }, lists: { value: 2, updatedAt: 1000 } });
});

test('PUT /api/me/prefs/:key: a later write replaces an earlier one, and replies { ok: true }', async (t) => {
  const agent = await loginAs(t, '76561198000000207');
  await agent.put('/api/me/prefs/region').send({ value: 'old', updatedAt: 1000 }).expect(200);
  const res = await agent.put('/api/me/prefs/region').send({ value: 'new', updatedAt: 2000 }).expect(200);
  assert.deepEqual(res.body, { ok: true });
  const me = await agent.get('/api/me').expect(200);
  assert.deepEqual(me.body.prefs.region, { value: 'new', updatedAt: 2000 });
});

test('PUT /api/me/prefs/:key: a write always overwrites, even with a lower updatedAt than what is stored', async (t) => {
  const agent = await loginAs(t, '76561198000000208');
  await agent.put('/api/me/prefs/region').send({ value: 'new', updatedAt: 2000 }).expect(200);
  await agent.put('/api/me/prefs/region').send({ value: 'explicit-save', updatedAt: 1000 }).expect(200);
  const me = await agent.get('/api/me').expect(200);
  assert.deepEqual(me.body.prefs.region, { value: 'explicit-save', updatedAt: 1000 });
});

test('PUT /api/me/prefs/:key: 400 when the body has no value field or a non-numeric updatedAt', async (t) => {
  const agent = await loginAs(t, '76561198000000204');
  await agent.put('/api/me/prefs/region').send({ notValue: 1, updatedAt: 1000 }).expect(400);
  await agent.put('/api/me/prefs/region').send({ value: 1, updatedAt: 'not-a-number' }).expect(400);
  await agent.put('/api/me/prefs/region').send({ value: 1 }).expect(400);
});

test('PUT /api/me/prefs/:key: 401 when not signed in', async () => {
  await api.put('/api/me/prefs/region').send({ value: 1, updatedAt: 1000 }).expect(401);
});

test('PUT /api/me/prefs/:key: 400 for a key the app never syncs', async (t) => {
  const agent = await loginAs(t, '76561198000000210');
  await agent.put('/api/me/prefs/anything').send({ value: 1, updatedAt: 1000 }).expect(400);
  await agent.put('/api/me/prefs/ranking%3Anot-a-list-id').send({ value: 1, updatedAt: 1000 }).expect(400);
  const me = await agent.get('/api/me').expect(200);
  assert.deepEqual(me.body.prefs, {});
});

test('PUT /api/me/prefs/:key: accepts every key the frontend syncs, and only those', async (t) => {
  const { SYNCED_PREF_KEYS: frontendKeys } = require('../public/syncedPrefKeys.ts');
  assert.deepEqual([...SYNCED_PREF_KEYS].sort(), [...frontendKeys].sort());
  const agent = await loginAs(t, '76561198000000211');
  for (const key of [...frontendKeys, 'ranking:0b7e6c1a-3f2d-4e5a-9b8c-1d2e3f4a5b6c']) {
    await agent
      .put(`/api/me/prefs/${encodeURIComponent(key)}`)
      .send({ value: 1, updatedAt: 1000 })
      .expect(200);
  }
});

test("PUT /api/me/prefs/:key: 413 once the account's prefs would pass PREFS_MAX_BYTES", async (t) => {
  const steamid = '76561198000000212';
  const agent = await loginAs(t, steamid);
  const big = 'x'.repeat(90_000);
  for (let i = 0; Object.keys(getUserPrefs(steamid)).length * 90_000 < PREFS_MAX_BYTES; i++) {
    setUserPref(steamid, `ranking:00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, big, 1000);
  }
  await agent.put('/api/me/prefs/region').send({ value: big, updatedAt: 1000 }).expect(413);
  // Overwriting a stored key counts only its new size, not the old one too.
  await agent
    .put('/api/me/prefs/ranking%3A00000000-0000-4000-8000-000000000000')
    .send({ value: 'small', updatedAt: 2000 })
    .expect(200);
});

test('PUT /api/me/prefs/:key: PREFS_MAX_BYTES counts UTF-8 bytes, not characters', async (t) => {
  const steamid = '76561198000000214';
  const agent = await loginAs(t, steamid);
  // 3 bytes a character: the cap in bytes, a third of it in characters.
  setUserPref(steamid, 'lists', '€'.repeat(PREFS_MAX_BYTES / 3), 1000);
  await agent
    .put('/api/me/prefs/region')
    .send({ value: 'x'.repeat(1000), updatedAt: 1000 })
    .expect(413);
  // A multibyte value within the cap in bytes still fits on its own.
  await agent
    .put('/api/me/prefs/lists')
    .send({ value: '€'.repeat((PREFS_MAX_BYTES - 100) / 3), updatedAt: 2000 })
    .expect(200);
});

test('PUT /api/me/prefs/:key: accepts one key larger than the default JSON body limit, up to PREFS_MAX_BYTES', async (t) => {
  const steamid = '76561198000000213';
  const agent = await loginAs(t, steamid);
  const big = 'x'.repeat(PREFS_MAX_BYTES - 100);
  await agent.put('/api/me/prefs/region').send({ value: big, updatedAt: 1000 }).expect(200);
  assert.equal(getUserPrefs(steamid).region.value.length, big.length);
  // Express matches routes case-insensitively, so the size limit must follow the route, not a path copy.
  await agent.put('/API/me/prefs/region').send({ value: big, updatedAt: 2000 }).expect(200);
  await agent.put('/api/me/prefs/region').expect(400);
});

test('POST /auth/logout: session stops working afterwards', async (t) => {
  const agent = await loginAs(t, '76561198000000205');
  const before = await agent.get('/api/me').expect(200);
  assert.equal(before.body.steamid, '76561198000000205');
  await agent.post('/auth/logout').expect(200);
  const after = await agent.get('/api/me').expect(200);
  assert.equal(after.body.steamid, null);
});

test('GET /api/me: a session past SESSION_TTL_MS is signed out and its row deleted', async (t) => {
  const steamid = '76561198000000209';
  const agent = await loginAs(t, steamid);
  const countSessions = () => db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE steamid = ?').get(steamid).n;
  assert.equal(countSessions(), 1);

  const expiredAt = Date.now() + SESSION_TTL_MS + 1000;
  t.mock.method(Date, 'now', () => expiredAt);
  const res = await agent.get('/api/me').expect(200);
  assert.deepEqual(res.body, { steamid: null, prefs: null });
  assert.equal(countSessions(), 0);
});

test('a repeated query param is read as one string, not answered with a 500', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed');
  });
  for (const url of ['/api/search-games?q=a&q=b', '/api/achievements/1?steamids=a&steamids=b']) {
    const res = await api.get(url);
    assert.notEqual(res.status, 500, url);
    assert.match(res.type, /json/);
  }
});

test('malformed JSON gets a 400 { error }, not an HTML stack trace', async () => {
  const res = await api.post('/api/common-games').set('Content-Type', 'application/json').send('{bad').expect(400);
  assert.match(res.type, /json/);
  assert.equal(typeof res.body.error, 'string');
  assert.doesNotMatch(res.text, /at .*\.js:\d+/);
});

test('a POST without a JSON body is a 400, not a 500', async () => {
  for (const url of ['/api/common-games', '/api/wishlist', '/api/friends', '/api/game-details/stream']) {
    const res = await api.post(url).set('Content-Type', 'text/plain').send('x');
    assert.equal(res.status, 400, url);
    assert.equal(typeof res.body.error, 'string', url);
  }
});

test('POST /api/game-details/stream: a null entry in games is a 400', async () => {
  await api
    .post('/api/game-details/stream')
    .send({ games: [null] })
    .expect(400);
});
