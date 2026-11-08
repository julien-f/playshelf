'use strict';

// Opts into the HLTB search cap `npm test` turns off; the window is module state, so it has a file of its own.
process.env.DB_FILE = '';
process.env.UPSTREAM_MIN_INTERVAL_MS = '0';
process.env.HLTB_SEARCH_MAX_PER_5_MIN = '2';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getHLTB, _resetAuth } = require('../lib/hltb');
const { _reset } = require('../lib/cache');

const WINDOW_MS = 5 * 60 * 1000;
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

// Each test starts an hour after the last, so the window's earlier places have all expired.
let start = 0;
function setup(t, { searchStatus = () => 200 } = {}) {
  _reset();
  _resetAuth();
  start += 60 * 60 * 1000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: start });
  const inits = [];
  const searches = []; // { name, token }
  let token = 't1';
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.includes('search/site/init')) {
      inits.push(token);
      return { ok: true, status: 200, json: async () => ({ token, hpKey: 'k', hpVal: 'v' }) };
    }
    const name = JSON.parse(init.body).searchTerms.join(' ');
    searches.push({ name, token: init.headers['X-Auth-Token'] });
    const status = searchStatus(name);
    return { ok: status === 200, status, headers: new Headers(), json: async () => ({ data: [] }) };
  });
  return { inits, searches, rotate: (next) => (token = next) };
}

test('HLTB search: at most HLTB_SEARCH_MAX_PER_5_MIN sent in any 5 minutes; the token init takes no place', async (t) => {
  const { inits, searches } = setup(t);
  const calls = Promise.allSettled([1, 2, 3].map((i) => getHLTB(i, `Game ${i}`)));
  await flush();
  assert.deepEqual(
    searches.map((s) => s.name),
    ['Game 1', 'Game 2'],
  );
  assert.equal(inits.length, 1);

  t.mock.timers.tick(WINDOW_MS);
  await flush();
  assert.equal(searches.length, 3);
  assert.deepEqual(
    (await calls).map((r) => r.status),
    ['fulfilled', 'fulfilled', 'fulfilled'],
  );
});

test('HLTB search: a search that waited past the token lifetime sends a fresh token', async (t) => {
  const { searches, rotate } = setup(t);
  const calls = Promise.allSettled([1, 2, 3].map((i) => getHLTB(i, `Game ${i}`)));
  await flush();
  rotate('t2');
  t.mock.timers.tick(WINDOW_MS);
  await flush();
  assert.deepEqual(
    searches.map((s) => s.token),
    ['t1', 't1', 't2'],
  );
  await calls;
});

test('HLTB search: a priority lookup goes ahead of a queued backlog', async (t) => {
  const { searches } = setup(t);
  const backlog = [1, 2, 3, 4].map((i) => getHLTB(i, `Game ${i}`));
  await flush();
  const lookup = getHLTB(9, 'Looked up', { priority: true });
  await flush();
  t.mock.timers.tick(WINDOW_MS);
  await flush();
  assert.deepEqual(
    searches.map((s) => s.name),
    ['Game 1', 'Game 2', 'Looked up', 'Game 3'],
  );
  t.mock.timers.tick(WINDOW_MS);
  await flush();
  await Promise.allSettled([...backlog, lookup]);
});

test('HLTB search: a search refused with 429 still used its place', async (t) => {
  const { searches } = setup(t, { searchStatus: (name) => (name === 'Game 1' ? 429 : 200) });
  const calls = Promise.allSettled([1, 2, 3].map((i) => getHLTB(i, `Game ${i}`)));
  await flush();
  t.mock.timers.tick(30 * 1000); // past the 429 pause
  await flush();
  assert.equal(searches.length, 2);

  t.mock.timers.tick(WINDOW_MS);
  await flush();
  assert.equal(searches.length, 3);
  assert.deepEqual(
    (await calls).map((r) => r.status),
    ['rejected', 'fulfilled', 'fulfilled'],
  );
});
