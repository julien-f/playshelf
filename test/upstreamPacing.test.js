'use strict';

// Opts back into the pacing `npm test` turns off; each test file runs in its own process.
process.env.DB_FILE = '';
process.env.UPSTREAM_MIN_INTERVAL_MS = '1000';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getProtonDbStatus, getStoreBrowseItem } = require('../lib/steam');
const { getHLTB, _resetAuth } = require('../lib/hltb');
const { _reset } = require('../lib/cache');
const { createRetryingFetch, createSemaphore, createWindow } = require('../lib/upstream');

const flush = () => new Promise((r) => setImmediate(r));

// HLTB, ProtonDB and the store browse API are unsanctioned: 3 requests in flight each, and a
// slot waits UPSTREAM_MIN_INTERVAL_MS before its next request (≈ 3 req/s).
for (const [name, call, respond] of [
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
]) {
  // A failed request (here a network error) holds its slot too: an erroring upstream must not get unpaced retries.
  for (const fails of [false, true]) {
    test(`${name}: a slot waits UPSTREAM_MIN_INTERVAL_MS before its next request${fails ? ', even after a failure' : ''}`, async (t) => {
      _reset();
      _resetAuth();
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const urls = [];
      const isPaced = (url) => !url.includes('search/site/init');
      const paced = () => urls.filter(isPaced).length;
      t.mock.method(globalThis, 'fetch', async (url) => {
        urls.push(url);
        if (fails && isPaced(url)) throw new TypeError('fetch failed');
        return respond(url);
      });

      const calls = Promise.allSettled(Array.from({ length: 6 }, (_, i) => call(i)));
      try {
        for (let i = 0; i < 5; i++) await flush();
        assert.equal(paced(), 3, 'only 3 in flight before any slot frees up');

        t.mock.timers.tick(999);
        for (let i = 0; i < 5; i++) await flush();
        assert.equal(paced(), 3, 'a slot stays busy for the whole interval');

        t.mock.timers.tick(1);
        for (let i = 0; i < 5; i++) await flush();
        assert.equal(paced(), 6);
        assert.deepEqual(
          (await calls).map(({ status }) => status),
          Array(6).fill(fails ? 'rejected' : 'fulfilled'),
        );
      } finally {
        // Frees every slot, even after a failed assertion: the next variant shares this semaphore.
        for (let round = 0; round < 2; round++) {
          t.mock.timers.tick(1000);
          for (let i = 0; i < 5; i++) await flush();
        }
      }
    });
  }
}

test('createRetryingFetch: without a retry count, a 429 fails instead of being retried', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  let calls = 0;
  const retryingFetch = createRetryingFetch({
    trackedFetch: async () => (++calls === 1 ? { status: 429, headers: new Headers() } : { status: 200 }),
    name: 'Test',
  });
  let settled;
  retryingFetch('label', 'https://example.test/').then(
    () => (settled = 'fulfilled'),
    () => (settled = 'rejected'),
  );
  for (let i = 0; i < 10; i++) await flush();
  t.mock.timers.tick(60 * 1000);
  for (let i = 0; i < 10; i++) await flush();
  assert.equal(settled, 'rejected');
  assert.equal(calls, 1);
});

const settle = async () => {
  for (let i = 0; i < 10; i++) await flush();
};

test('createWindow: past `max` sends in the window, the next waits until the oldest send leaves it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const window = createWindow(2, 1000);
  const granted = [];
  for (let i = 0; i < 3; i++) void window.reserve().then((place) => granted.push(place));
  await settle();
  assert.equal(granted.length, 2);
  granted[0].send();
  t.mock.timers.tick(500);
  granted[1].send();
  t.mock.timers.tick(499);
  await settle();
  assert.equal(granted.length, 2, 'the first send is still in the window');
  t.mock.timers.tick(1);
  await settle();
  assert.equal(granted.length, 3);
});

test('createWindow: a place released without being sent frees at once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const window = createWindow(1, 1000);
  const granted = [];
  for (let i = 0; i < 2; i++) void window.reserve().then((place) => granted.push(place));
  await settle();
  granted[0].release();
  await settle();
  assert.equal(granted.length, 2);
});

test('createRetryingFetch: a call waiting on its window holds no slot of the shared limit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const limit = createSemaphore(1, 0, 'window-test');
  const urls = [];
  const trackedFetch = async (label, url) => (urls.push(url), { status: 200 });
  const windowed = createRetryingFetch({ limit, window: createWindow(1, 1000), trackedFetch, name: 'Test' });
  const other = createRetryingFetch({ limit, trackedFetch, name: 'Test' });
  void windowed('label', 'w1');
  void windowed('label', 'w2');
  void other('label', 'o1');
  await settle();
  assert.deepEqual(urls, ['w1', 'o1']);
  t.mock.timers.tick(1000);
  await settle();
  assert.deepEqual(urls, ['w1', 'o1', 'w2']);
});

test('createRetryingFetch: each retry of a 429 takes its own place in the window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let calls = 0;
  const retryingFetch = createRetryingFetch({
    window: createWindow(1, 10000),
    trackedFetch: async () =>
      ++calls === 1 ? { status: 429, headers: new Headers({ 'retry-after': '1' }) } : { status: 200 },
    name: 'Test',
    retries: 1,
  });
  void retryingFetch('label', 'https://example.test/');
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(calls, 1, 'the retry waits for the window, not only Retry-After');
  t.mock.timers.tick(9000);
  await settle();
  assert.equal(calls, 2);
});

test('createWindow: reports its live state, and the wait of each reservation that had to queue', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const waits = [];
  const window = createWindow(1, 1000, 'stats-test', (ms) => waits.push(ms));
  const granted = [];
  for (let i = 0; i < 3; i++) void window.reserve().then((place) => granted.push(place));
  await settle();
  assert.deepEqual(window.getStats(), { max: 1, inWindow: 0, reserved: 1, waiting: 2, maxQueueSeen: 2 });
  granted[0].send();
  assert.deepEqual(window.getStats(), { max: 1, inWindow: 1, reserved: 0, waiting: 2, maxQueueSeen: 2 });
  t.mock.timers.tick(1000);
  await settle();
  assert.deepEqual(waits, [1000], 'the first went at once, unrecorded; the second waited a full window');
  assert.equal(window.getStats().waiting, 1);
});
