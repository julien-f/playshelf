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

// Sized like a real warm stream (measured 2026-11-02 on 300 cached games: 3.2 KB raw, 570 B gzipped a game), ±25%.
test('mockApi: big-library adds 1200 synthetic games, streamed at a real event size', async () => {
  const zlib = require('node:zlib');
  const { respond } = await import('../e2e/mockApi.ts');
  const states = new Set(['big-library']);
  const library = respond('POST', new URL('/api/common-games', 'http://localhost'), '{"members":["alice"]}', states);
  const { games } = JSON.parse(library.body);
  assert.equal(games.length, 1206);
  const { body } = respond(
    'POST',
    new URL('/api/game-details/stream', 'http://localhost'),
    JSON.stringify({ games }),
    states,
  );
  const raw = Buffer.byteLength(body) / games.length;
  const gzipped = zlib.gzipSync(body).length / games.length;
  assert.ok(raw > 2400 && raw < 4000, `raw ${Math.round(raw)} B/game`);
  assert.ok(gzipped > 430 && gzipped < 720, `gzipped ${Math.round(gzipped)} B/game (raw ${Math.round(raw)})`);
});
