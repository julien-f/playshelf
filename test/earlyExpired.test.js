'use strict';

process.env.DB_FILE = '';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findEarlyExpired } = require('../lib/earlyExpired');
const { _reset, setCache } = require('../lib/cache');

const NOW = Date.parse('2026-10-20T00:00:00Z'); // October 2026's Choice on sale

// A feed entry: a games pick-and-mix live by Fanatical's dates unless overridden.
const entry = (over = {}) => ({
  tiers: [{ quantity: 1, prices: { USD: 1 } }],
  products: [],
  type: 'bundle',
  validFrom: '2026-09-07T13:00:00.000Z',
  validUntil: '2099-01-01T00:00:00.000Z',
  ...over,
});
const pnm = (slug, over = {}) => ({
  page: { name: 'Fanatical' },
  url: `https://www.fanatical.com/en/pick-and-mix/${slug}`,
  tiers: [{ price: null, games: [] }],
  publish: '2026-10-01T00:00:00Z',
  ...over,
});
const choice = (month, over = {}) => ({
  page: { name: 'Humble Bundle' },
  url: `https://www.humblebundle.com/membership/${month}?partner=itad`,
  publish: '2026-10-06T19:42:27Z',
  ...over,
});
const filler = (n, publish) => Array.from({ length: n }, (_, i) => ({ id: 9000 + i, publish }));

test("findEarlyExpired: a live feed bundle missing from the active list is found on ITAD's expired pages", async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => assert.fail('should not fetch'));
  setCache('fanatical-pnm:v3', {
    killer: entry(),
    listed: entry(),
    book: entry({ type: 'book-bundle' }),
    ended: entry({ validUntil: '2001-01-01T00:00:00.000Z' }),
    future: entry({ validFrom: '2099-01-01T00:00:00.000Z' }),
  });
  const killer = pnm('killer', { id: 16542 });
  const pages = [
    [...filler(49, '2026-10-30T00:00:00Z'), pnm('ended', { id: 1 })],
    [killer, ...filler(49, '2026-09-01T00:00:00Z')],
  ];
  const asked = [];
  const load = async (params) => {
    asked.push(params);
    return pages[params.offset / 50];
  };
  assert.deepEqual(await findEarlyExpired([pnm('listed', { id: 2 }), choice('october-2026')], load, NOW), [killer]);
  assert.deepEqual(asked, [
    { offset: 0, limit: 50, sort: '-publish', expired: true },
    { offset: 50, limit: 50, sort: '-publish', expired: true },
  ]);
});

test('findEarlyExpired: no page read when nothing is missing, and the walk stops before the bundle went live', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => assert.fail('should not fetch'));
  setCache('fanatical-pnm:v3', { listed: entry() });
  let calls = 0;
  const load = async () => {
    calls++;
    return filler(50, '2026-08-01T00:00:00Z');
  };
  const october = choice('october-2026');
  assert.deepEqual(await findEarlyExpired([pnm('listed'), october], load, NOW), []);
  assert.equal(calls, 0);
  // Never on ITAD: the first page already predates its validFrom by more than the margin.
  setCache('fanatical-pnm:v3', { never: entry() });
  assert.deepEqual(await findEarlyExpired([october], load, NOW), []);
  assert.equal(calls, 1);
  // A page missing from the cache (a cache-only loader) ends the walk.
  assert.deepEqual(await findEarlyExpired([october], async () => undefined, NOW), []);
});

test('findEarlyExpired: a failed feed finds nothing', async (t) => {
  _reset();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 403 }));
  assert.deepEqual(await findEarlyExpired([choice('october-2026')], async () => assert.fail('no page'), NOW), []);
});

// 2026-11-03: ITAD expired October's Choice at 16:00Z, Humble sold it until 18:00Z.
test("findEarlyExpired: the Choice on sale is found on ITAD's expired pages until Humble's end", async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => assert.fail('should not fetch'));
  setCache('fanatical-pnm:v3', {});
  const october = choice('october-2026', { id: 16635 });
  const page = [...filler(40, '2026-10-20T00:00:00Z'), october, ...filler(9, '2026-10-01T00:00:00Z')];
  const load = async () => page;
  assert.deepEqual(await findEarlyExpired([], load, Date.parse('2026-11-03T17:30:00Z')), [october]);
  // November's is on sale from 18:00Z: October stays expired.
  assert.deepEqual(await findEarlyExpired([], load, Date.parse('2026-11-03T18:00:00Z')), []);
});
