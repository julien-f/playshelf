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
  assert.equal((await ask('/api/igdb-game/9002')).status, 404);
  assert.equal((await ask('/api/health')).body.igdbConfigured, true);
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
