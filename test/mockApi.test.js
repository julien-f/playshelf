'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ask = async (path) => {
  const { respond } = await import('../e2e/mockApi.ts');
  const res = respond('GET', new URL(path, 'http://localhost'), null);
  return { status: res.status, body: JSON.parse(res.body) };
};

// As server.js: a store with no page for the appid leaves every source empty, not failed.
test('mockApi: game details for an appid outside the fixtures answer empty, as the real API does', async () => {
  const { status, body } = await ask('/api/game-details/999999');
  assert.equal(status, 200);
  assert.equal(body.meta, null);
  assert.equal(body.rating, null);
  assert.equal(body.failed, undefined);
});

test('mockApi: game meta for an appid outside the fixtures is null', async () => {
  assert.deepEqual(await ask('/api/game-meta/999999'), { status: 200, body: { meta: null } });
});

test('mockApi: igdb:9001 is a game outside Steam with a cover; other IGDB ids are unknown', async () => {
  const { status, body } = await ask('/api/igdb-game/9001');
  assert.equal(status, 200);
  assert.equal(body.game.id, 9001);
  assert.equal(body.game.steamAppid, null);
  assert.ok(body.game.cover);
  assert.equal((await ask('/api/igdb-game/9002')).body.game.steamAppid, 620);
  assert.equal((await ask('/api/igdb-game/1')).status, 404);
  assert.equal((await ask('/api/health')).body.igdbConfigured, true);
});

// As server.js (lib/searchMerge.mjs): IGDB's games merge into Steam's, a Steam-linked one once.
test('mockApi: a search merges the IGDB fixtures, the Steam exact name first on a tie', async () => {
  const keys = async (q) => (await ask(`/api/search-games?q=${q}`)).body.results.map((r) => r.appid);
  assert.deepEqual(await keys('portal'), [620]);
  assert.deepEqual(await keys('god of war'), [1593500, 'igdb:9003']);
  assert.deepEqual(await keys('console quest'), ['igdb:9001', 'igdb:9004']);
});

// As server.js's stream: an `igdb:N` key is echoed, Steam-shaped; unconfigured, it fails and says so once.
test('mockApi: the details stream answers games outside Steam as the real API does', async () => {
  const { respond } = await import('../e2e/mockApi.ts');
  const stream = (states = []) =>
    respond(
      'POST',
      new URL('/api/game-details/stream', 'http://localhost'),
      '{"games":[{"appid":1145360},{"appid":"igdb:9001"},{"appid":"igdb:1"}]}',
      new Set(states),
    )
      .body.split('\n\n')
      .filter((c) => c.startsWith('data: '))
      .map((c) => JSON.parse(c.slice(6)));
  const byKey = new Map(stream().map((e) => [e.appid, e]));
  assert.equal(byKey.get('igdb:9001').meta.name, 'Console Quest');
  assert.equal(byKey.get('igdb:9001').source, 'igdb');
  assert.equal(byKey.get('igdb:1').meta, null);
  const unconfigured = stream(['no-igdb']);
  assert.equal(unconfigured.filter((e) => e.unavailable).length, 1);
  assert.deepEqual(unconfigured.find((e) => e.appid === 'igdb:9001').failed, ['igdb']);
});

// As server.js's stream (lib/streamEvent.mjs): media come from /api/game-meta, the banner stays.
test('mockApi: the details stream leaves out media and keeps the banner, as the real API does', async () => {
  const { respond } = await import('../e2e/mockApi.ts');
  const res = respond('POST', new URL('/api/game-details/stream', 'http://localhost'), '{"games":[{"appid":1145360}]}');
  const [event] = res.body
    .split('\n\n')
    .filter((c) => c.startsWith('data: '))
    .map((c) => JSON.parse(c.slice(6)));
  assert.equal(event.appid, 1145360);
  assert.ok('banner' in event.meta);
  assert.equal('screenshots' in event.meta, false);
  assert.equal('movies' in event.meta, false);
  assert.equal((await ask('/api/game-meta/1145360')).body.meta.screenshots.length, 3);
});
