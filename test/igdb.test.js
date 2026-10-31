'use strict';

process.env.DB_FILE = '';
process.env.TWITCH_CLIENT_ID = 'test-client';
process.env.TWITCH_CLIENT_SECRET = 'test-secret';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  isIgdbConfigured,
  searchIgdb,
  getIgdbGame,
  getIgdbGames,
  extractIgdbGame,
  steamAppidOf,
  normalizeName,
  rankIgdbResults,
  mergeSearchResults,
  _resetIgdb,
} = require('../lib/igdb');
const { _reset } = require('../lib/cache');
const { getCircuitBreakers } = require('../lib/circuitBreaker');
const { MISS_CACHE_TTL_MS } = require('../lib/config');

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const json = (body, status = 200) => ({ ok: status < 300, status, headers: new Headers(), json: async () => body });
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

beforeEach(() => {
  _reset();
  _resetIgdb();
});

// Answers token requests with tok-1, tok-2…, and IGDB queries with `games(opts, n)`; records both.
function mockIgdb(t, games = () => json([])) {
  const tokens = [];
  const queries = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (url === TOKEN_URL) {
      tokens.push(opts);
      return json({ access_token: `tok-${tokens.length}`, expires_in: 5_000_000, token_type: 'bearer' });
    }
    queries.push(opts);
    return games(opts, queries.length);
  });
  return { tokens, queries };
}

test('isIgdbConfigured: needs both Twitch credentials', (t) => {
  assert.equal(isIgdbConfigured(), true);
  t.after(() => (process.env.TWITCH_CLIENT_SECRET = 'test-secret'));
  delete process.env.TWITCH_CLIENT_SECRET;
  assert.equal(isIgdbConfigured(), false);
});

test('token: sent in the POST body, reused across queries, its header on each query', async (t) => {
  const { tokens, queries } = mockIgdb(t);
  await searchIgdb('portal');
  await searchIgdb('tunic');
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].method, 'POST');
  assert.deepEqual(Object.fromEntries(tokens[0].body), {
    client_id: 'test-client',
    client_secret: 'test-secret',
    grant_type: 'client_credentials',
  });
  assert.equal(queries.length, 2);
  assert.deepEqual(queries[1].headers, { 'Client-ID': 'test-client', Authorization: 'Bearer tok-1' });
});

test('token: renewed a day before it expires', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { tokens } = mockIgdb(t);
  await searchIgdb('portal');
  t.mock.timers.tick(5_000_000 * 1000 - 24 * 3600 * 1000 - 1);
  await searchIgdb('tunic');
  assert.equal(tokens.length, 1);
  t.mock.timers.tick(1);
  await searchIgdb('celeste');
  assert.equal(tokens.length, 2);
});

test('token: a failed request names its status, never the secret', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ message: 'invalid client secret' }, 403));
  const err = await getIgdbGame(1).catch((e) => e);
  assert.equal(err.isUpstream, true);
  assert.match(err.message, /token request failed \(403\)/);
  assert.doesNotMatch(err.message, /test-secret/);
});

test('a 401 renews the token and retries once', async (t) => {
  const { tokens, queries } = mockIgdb(t, (_opts, n) => (n === 1 ? json({}, 401) : json([{ id: 7, name: 'A' }])));
  assert.equal((await getIgdbGame(7)).name, 'A');
  assert.equal(tokens.length, 2);
  assert.equal(queries[1].headers.Authorization, 'Bearer tok-2');
});

test('a 401 answering a token already renewed by another query keeps the new one', async (t) => {
  const pending = [];
  const { tokens, queries } = mockIgdb(t, (opts) =>
    opts.headers.Authorization === 'Bearer tok-1'
      ? new Promise((resolve) => pending.push(resolve))
      : json([{ id: 1, name: 'A' }]),
  );
  const first = getIgdbGame(1);
  const second = getIgdbGame(2);
  await flush();
  assert.equal(pending.length, 2, 'both sent with the first token');
  pending[0](json({}, 401));
  await first;
  pending[1](json({}, 401));
  await second;
  assert.equal(tokens.length, 2, 'the second 401 renews nothing');
  assert.equal(queries.at(-1).headers.Authorization, 'Bearer tok-2');
});

test('a 429 holds the query until Retry-After has passed, then retries it', async (t) => {
  // Mocked time starts in the past, so the pause has already ended for later tests.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { queries } = mockIgdb(t, (_opts, n) =>
    n === 1 ? { ok: false, status: 429, headers: new Headers({ 'retry-after': '2' }) } : json([{ id: 3, name: 'C' }]),
  );
  const game = getIgdbGame(3);
  await flush();
  assert.equal(queries.length, 1);
  t.mock.timers.tick(1999);
  await flush();
  assert.equal(queries.length, 1, 'nothing goes out before Retry-After');
  t.mock.timers.tick(1);
  assert.equal((await game).name, 'C');
  assert.equal(queries.length, 2);
});

test('two 403s in a row trip the IGDB circuit breaker', async (t) => {
  const { queries } = mockIgdb(t, () => json({}, 403));
  await assert.rejects(() => getIgdbGame(1));
  await assert.rejects(() => getIgdbGame(2));
  assert.equal(getCircuitBreakers().igdb.tripCount, 1);
  const err = await getIgdbGame(3).catch((e) => e);
  assert.equal(err.isCircuitOpen, true);
  assert.equal(queries.length, 2, 'an open breaker sends nothing');
});

test('searchIgdb: the query escapes the term and keeps main games, remakes, remasters and ports', async (t) => {
  const { queries } = mockIgdb(t);
  await searchIgdb('say "hi" \\o/');
  assert.equal(
    queries[0].body,
    'search "say \\"hi\\" \\\\o/"; fields name, total_rating_count, first_release_date, platforms.abbreviation, ' +
      'cover.image_id, external_games.external_game_source, external_games.uid, ' +
      'remasters.external_games.external_game_source, remasters.external_games.uid, ' +
      'ports.external_games.external_game_source, ports.external_games.uid; ' +
      'where version_parent = null & game_type = (0,8,9,10,11); limit 20;',
  );
});

test('searchIgdb: exact title first, then most rated; cached per term', async (t) => {
  const { queries } = mockIgdb(t, () =>
    json([
      { id: 1, name: 'God of War Ragnarök: Valhalla', total_rating_count: 50 },
      { id: 2, name: 'God of War Ragnarök', total_rating_count: 10, first_release_date: 1667865600 },
      {
        id: 3,
        name: 'God of War',
        total_rating_count: 900,
        platforms: [{ abbreviation: 'PS4' }],
        cover: { image_id: 'co1' },
      },
    ]),
  );
  const results = await searchIgdb('God of War Ragnarok');
  assert.deepEqual(
    results.map((r) => r.id),
    [2, 3, 1],
  );
  assert.deepEqual(results[1], {
    id: 3,
    name: 'God of War',
    tinyImage: 'https://images.igdb.com/igdb/image/upload/t_cover_small/co1.jpg',
    platforms: ['PS4'],
    year: null,
    steamAppid: null,
  });
  assert.equal(results[0].year, 2022);
  await searchIgdb('god of war ragnarok');
  assert.equal(queries.length, 1);
});

test('steamAppidOf: its own Steam listing, else a remaster or port', () => {
  const steam = (uid) => ({
    external_games: [
      { external_game_source: 5, uid: 'x' },
      { external_game_source: 1, uid },
    ],
  });
  assert.equal(steamAppidOf(steam('620')), 620);
  // The Last of Us Part II (PS4): only its remaster is on Steam.
  assert.equal(steamAppidOf({ name: 'The Last of Us Part II', remasters: [steam('2531310')] }), 2531310);
  assert.equal(steamAppidOf({ ports: [{}, steam('1593500')] }), 1593500);
  assert.equal(steamAppidOf({ external_games: [{ external_game_source: 1, uid: 'not-a-number' }] }), null);
  assert.equal(steamAppidOf({}), null);
});

test('normalizeName / rankIgdbResults: accents, case and spacing are ignored', () => {
  assert.equal(normalizeName('  Pokémon  Légendes '), 'pokemon legendes');
  const ranked = rankIgdbResults(
    [
      { name: 'Ōkami HD', total_rating_count: 300 },
      { name: 'okami', total_rating_count: 1 },
    ],
    'Ōkami',
  );
  assert.equal(ranked[0].name, 'okami');
});

test('extractIgdbGame: the panel fields, with image URLs and company roles', () => {
  const game = extractIgdbGame({
    id: 9001,
    name: 'Astro Bot',
    url: 'https://www.igdb.com/games/astro-bot',
    summary: 'A platformer.',
    first_release_date: 1725840000,
    platforms: [{ abbreviation: 'PS5' }],
    cover: { image_id: 'cov' },
    screenshots: [{ image_id: 'sc1' }],
    artworks: [{ image_id: 'art', width: 1920, height: 1080 }],
    videos: [{ id: 5, video_id: 'yt123', name: 'Trailer' }],
    genres: [{ name: 'Platform' }],
    involved_companies: [
      { company: { name: 'Team Asobi' }, developer: true, publisher: false },
      { company: { name: 'Sony' }, developer: false, publisher: true },
    ],
    total_rating: 93.6,
    total_rating_count: 120,
  });
  assert.deepEqual(game, {
    id: 9001,
    name: 'Astro Bot',
    url: 'https://www.igdb.com/games/astro-bot',
    summary: 'A platformer.',
    cover: 'https://images.igdb.com/igdb/image/upload/t_cover_big/cov.jpg',
    banner: 'https://images.igdb.com/igdb/image/upload/t_1080p/art.jpg',
    bannerIsCover: false,
    thumb: 'https://images.igdb.com/igdb/image/upload/t_screenshot_med/art.jpg',
    platforms: ['PS5'],
    releaseDate: '2024-09-09',
    developers: ['Team Asobi'],
    publishers: ['Sony'],
    genres: ['Platform'],
    rating: { score: 94, count: 120 },
    screenshots: [
      {
        id: 'sc1',
        thumbnail: 'https://images.igdb.com/igdb/image/upload/t_screenshot_big/sc1.jpg',
        full: 'https://images.igdb.com/igdb/image/upload/t_1080p/sc1.jpg',
      },
    ],
    videos: [{ id: 5, youtubeId: 'yt123', name: 'Trailer', thumbnail: 'https://i.ytimg.com/vi/yt123/hqdefault.jpg' }],
    steamAppid: null,
  });
  assert.equal(extractIgdbGame({ id: 1, name: 'Unrated' }).rating, null);
});

test('extractIgdbGame: the banner is landscape art, else the first screenshot, else the cover', () => {
  const url = (size, id) => `https://images.igdb.com/igdb/image/upload/t_${size}/${id}.jpg`;
  const pick = (raw) => {
    const { banner, bannerIsCover, screenshots } = extractIgdbGame({ id: 1, name: 'G', ...raw });
    return { banner, bannerIsCover, screenshots: screenshots.map((s) => s.id) };
  };
  const cover = { image_id: 'cov' };
  const screenshots = [{ image_id: 'sc1' }, { image_id: 'sc2' }];
  const logo = { image_id: 'logo', width: 256, height: 256 };
  const ultraWide = { image_id: 'wide', width: 3840, height: 1240 };
  const keyArt = { image_id: 'key', width: 3840, height: 2160 };
  // A logo and an ultra-wide strip are skipped for the first artwork within 1.3–2.
  assert.deepEqual(pick({ cover, screenshots, artworks: [logo, ultraWide, keyArt] }), {
    banner: url('1080p', 'key'),
    bannerIsCover: false,
    screenshots: ['sc1', 'sc2'],
  });
  // No landscape artwork (or a record cached before artworks were requested): the first screenshot, listed once.
  assert.deepEqual(pick({ cover, screenshots, artworks: [logo, ultraWide] }), {
    banner: url('1080p', 'sc1'),
    bannerIsCover: false,
    screenshots: ['sc2'],
  });
  assert.deepEqual(pick({ cover }), { banner: url('cover_big', 'cov'), bannerIsCover: true, screenshots: [] });
  assert.deepEqual(pick({}), { banner: null, bannerIsCover: false, screenshots: [] });
});

test('extractIgdbGame: the table thumbnail is landscape art, else a screenshot, never the portrait cover', () => {
  const thumb = (raw) => extractIgdbGame({ id: 1, name: 'G', cover: { image_id: 'cov' }, ...raw }).thumb;
  const logo = { image_id: 'logo', width: 256, height: 256 };
  const keyArt = { image_id: 'key', width: 1920, height: 1080 };
  assert.equal(
    thumb({ artworks: [logo, keyArt] }),
    'https://images.igdb.com/igdb/image/upload/t_screenshot_med/key.jpg',
  );
  assert.equal(
    thumb({ artworks: [logo], screenshots: [{ image_id: 'sc1' }] }),
    'https://images.igdb.com/igdb/image/upload/t_screenshot_med/sc1.jpg',
  );
  assert.equal(thumb({}), null);
});

test('getIgdbGame: one query by id; an unknown id is null, cached for MISS_CACHE_TTL_MS', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { queries } = mockIgdb(t);
  assert.equal(await getIgdbGame(42), null);
  assert.match(
    queries[0].body,
    /^fields name, url, summary, .*external_games\.external_game_source.*; where id = 42;$/,
  );
  assert.equal(await getIgdbGame(42), null);
  assert.equal(queries.length, 1);
  t.mock.timers.tick(MISS_CACHE_TTL_MS);
  await getIgdbGame(42);
  assert.equal(queries.length, 2);
});

test('getIgdbGame: force skips the cache', async (t) => {
  const { queries } = mockIgdb(t, () => json([{ id: 5, name: 'E' }]));
  await getIgdbGame(5);
  await getIgdbGame(5);
  await getIgdbGame(5, { force: true });
  assert.equal(queries.length, 2);
});

const settled = async (games) => new Map(await Promise.all([...games].map(async ([id, g]) => [id, await g])));

test('getIgdbGames: one query for the uncached ids, each cached on its own, an unknown one as a miss', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { queries } = mockIgdb(t, (_opts, n) => json(n === 1 ? [{ id: 1, name: 'One' }] : [{ id: 2, name: 'Two' }]));
  await getIgdbGame(1); // cached by the one-game query first, so the batch leaves it out
  const games = await settled(getIgdbGames([1, 2, 3]));
  assert.match(queries[1].body, /^fields name, url, .*; where id = \(2,3\); limit 2;$/);
  assert.deepEqual(
    [...games].map(([id, g]) => [id, g?.name ?? null]),
    [
      [1, 'One'],
      [2, 'Two'],
      [3, null],
    ],
  );
  await settled(getIgdbGames([1, 2, 3, 3]));
  await getIgdbGame(2);
  assert.equal(queries.length, 2, 'every id answered from cache, the miss too');
  t.mock.timers.tick(MISS_CACHE_TTL_MS);
  await settled(getIgdbGames([2, 3]));
  assert.match(queries[2].body, /where id = \(3\); limit 1;$/);
});

test('getIgdbGames: 500 ids per query, with an explicit limit (IGDB returns 10 without one)', async (t) => {
  const { queries } = mockIgdb(t);
  const ids = Array.from({ length: 501 }, (_, i) => i + 1);
  await settled(getIgdbGames(ids));
  assert.deepEqual(
    queries.map((q) => q.body.match(/limit \d+;$/)[0]),
    ['limit 500;', 'limit 1;'],
  );
  assert.match(queries[1].body, /where id = \(501\);/);
});

test('getIgdbGames: a failed query rejects and caches nothing', async (t) => {
  const { queries } = mockIgdb(t, (_opts, n) => (n === 1 ? json({}, 500) : json([{ id: 1, name: 'One' }])));
  t.mock.method(console, 'warn', () => {});
  await assert.rejects(getIgdbGames([1]).get(1), /IGDB error 500/);
  assert.equal((await getIgdbGames([1]).get(1)).name, 'One');
  assert.equal(queries.length, 2);
});

// ── mergeSearchResults ───────────────────────────────────────────────────────

const igdbHit = (id, name, steamAppid = null, extra = {}) => ({
  id,
  name,
  tinyImage: null,
  platforms: ['PS5'],
  year: 2020,
  steamAppid,
  ...extra,
});
const keysOf = (rows) => rows.map((r) => r.appid);

test('mergeSearchResults: a Steam-linked IGDB hit is that Steam game, listed once', () => {
  const steam = [{ appid: 620, name: 'Portal 2', tinyImage: 's.jpg' }];
  const rows = mergeSearchResults(steam, [igdbHit(72, 'Portal 2', 620)], 'portal');
  assert.deepEqual(rows, steam);
});

test('mergeSearchResults: a linked game Steam did not return comes as the Steam game, without IGDB platforms or year', () => {
  const rows = mergeSearchResults([], [igdbHit(1, 'The Last of Us Part II', 2531310, { tinyImage: 'c.jpg' })], 'tlou');
  assert.deepEqual(rows, [{ appid: 2531310, name: 'The Last of Us Part II', tinyImage: 'c.jpg' }]);
});

test("mergeSearchResults: exact-name rows first, then Steam's order, then IGDB's other games", () => {
  const steam = [
    { appid: 1, name: 'Halo Infinite' },
    { appid: 2, name: 'Halo: The Master Chief Collection' },
  ];
  const rows = mergeSearchResults(steam, [igdbHit(10, 'Halo 3'), igdbHit(11, 'Halo')], 'halo');
  assert.deepEqual(keysOf(rows), ['igdb:11', 1, 2, 'igdb:10']);
  assert.deepEqual(rows[0], { appid: 'igdb:11', name: 'Halo', tinyImage: null, platforms: ['PS5'], year: 2020 });
});

test('mergeSearchResults: "God of War" — the Steam game and the 2005 PS2 one tie on the exact name, Steam first', () => {
  const steam = [
    { appid: 2322010, name: 'God of War Ragnarök' },
    { appid: 1593500, name: 'God of War' },
  ];
  const igdb = [
    igdbHit(1999, 'God of War', null, { platforms: ['PS2'], year: 2005 }),
    igdbHit(19560, 'God of War', 1593500),
  ];
  assert.deepEqual(keysOf(mergeSearchResults(steam, igdb, 'god of war')), [1593500, 'igdb:1999', 2322010]);
});

test('mergeSearchResults: the exact name matches regardless of accents, case and spacing', () => {
  const rows = mergeSearchResults(
    [{ appid: 1, name: 'Pokémon Legends' }],
    [igdbHit(5, 'Pokémon  Snap')],
    'pokemon snap',
  );
  assert.deepEqual(keysOf(rows), ['igdb:5', 1]);
});

test('mergeSearchResults: games IGDB adds are capped at 5; two IGDB games sharing a name both stay', () => {
  const igdb = Array.from({ length: 8 }, (_, i) => igdbHit(i + 1, 'Doom'));
  const rows = mergeSearchResults([{ appid: 2280, name: 'DOOM' }], igdb, 'doom');
  assert.deepEqual(keysOf(rows), [2280, 'igdb:1', 'igdb:2', 'igdb:3', 'igdb:4', 'igdb:5']);
});
