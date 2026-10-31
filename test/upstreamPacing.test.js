'use strict';

// Opts back into the pacing `npm test` turns off; each test file runs in its own process.
process.env.DB_FILE = '';
process.env.UPSTREAM_MIN_INTERVAL_MS = '1000';
process.env.TWITCH_CLIENT_ID = 'test-client';
process.env.TWITCH_CLIENT_SECRET = 'test-secret';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getProtonDbStatus, getStoreBrowseItem } = require('../lib/steam');
const { getHLTB, _resetAuth } = require('../lib/hltb');
const { getIgdbGame, _resetIgdb } = require('../lib/igdb');
const { _reset } = require('../lib/cache');

const flush = () => new Promise((r) => setImmediate(r));

// HLTB, ProtonDB and the store browse API are unsanctioned: 3 requests in flight each, and a
// slot waits UPSTREAM_MIN_INTERVAL_MS before its next request (≈ 3 req/s). IGDB allows 4 req/s.
const isLogin = (url) => url.includes('search/site/init') || url.includes('oauth2/token');
for (const [name, call, respond, slots = 3] of [
  [
    'ProtonDB',
    (i) => getProtonDbStatus(500 + i),
    () => ({ ok: true, status: 200, json: async () => ({ tier: 'gold', confidence: 'strong', total: 1 }) }),
  ],
  [
    'store browse',
    (i) => getStoreBrowseItem(600 + i),
    () => ({ ok: true, status: 200, json: async () => ({ response: { store_items: [{ success: 1 }] } }) }),
  ],
  [
    'HLTB search',
    (i) => getHLTB(700 + i, `Game ${i}`),
    (url) =>
      url.includes('search/site/init')
        ? { ok: true, status: 200, json: async () => ({ token: 't', hpKey: 'k', hpVal: 'v' }) }
        : { ok: true, status: 200, json: async () => ({ data: [] }) },
  ],
  [
    'IGDB',
    (i) => getIgdbGame(800 + i),
    (url) =>
      url.includes('oauth2/token')
        ? { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 5_000_000 }) }
        : { ok: true, status: 200, json: async () => [] },
    4,
  ],
]) {
  test(`${name}: a slot waits UPSTREAM_MIN_INTERVAL_MS before its next request`, async (t) => {
    _reset();
    _resetAuth();
    _resetIgdb();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const urls = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
      urls.push(url);
      return respond(url);
    });
    const paced = () => urls.filter((url) => !isLogin(url)).length;

    const calls = Array.from({ length: 2 * slots }, (_, i) => call(i));
    for (let i = 0; i < 5; i++) await flush();
    assert.equal(paced(), slots, `only ${slots} in flight before any slot frees up`);

    t.mock.timers.tick(999);
    for (let i = 0; i < 5; i++) await flush();
    assert.equal(paced(), slots, 'a slot stays busy for the whole interval');

    t.mock.timers.tick(1);
    for (let i = 0; i < 5; i++) await flush();
    assert.equal(paced(), 2 * slots);
    await Promise.all(calls);
  });
}
