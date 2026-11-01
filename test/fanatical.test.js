'use strict';

process.env.DB_FILE = '';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  pickAndMixSlug,
  parsePickAndMix,
  matchPickAndMix,
  getPickAndMix,
  withPickAndMix,
  withCachedPickAndMix,
} = require('../lib/fanatical');
const { _reset, setCache } = require('../lib/cache');

const ITAD_URL =
  'https://www.awin1.com/cread.php?awinmid=118821&awinaffid=235265&ued=https%3A%2F%2Fwww.fanatical.com%2Fen%2Fpick-and-mix%2Fbuild-your-own-killer-bundle';

const FEED = {
  pickandmix: [
    {
      slug: 'build-your-own-killer-bundle',
      type: 'bundle',
      valid_from: '2026-09-07T13:00:00.000Z',
      valid_until: '2026-11-13T23:59:00.000Z',
      tiers: [
        { quantity: 6, price: { USD: 699, CAD: 1789.9999999999998 } },
        { quantity: 1, price: { USD: 149, CAD: 250 } },
      ],
      products: [{ _id: 'p1', name: 'Rain World', slug: 'rain-world', cover: 'x.jpeg' }, { name: '' }],
    },
    { slug: 'no-tiers', tiers: [] },
  ],
};

const fanaticalBundle = (over = {}) => ({
  id: 1,
  expiry: '2026-11-01T00:58:54+01:00',
  page: { name: 'Fanatical' },
  url: ITAD_URL,
  tiers: [{ price: null, games: [] }],
  ...over,
});

test('pickAndMixSlug: reads the slug out of ITAD affiliate redirects and direct links', () => {
  assert.equal(pickAndMixSlug(ITAD_URL), 'build-your-own-killer-bundle');
  assert.equal(pickAndMixSlug('https://www.fanatical.com/de/pick-and-mix/foo-bar?x=1'), 'foo-bar');
  assert.equal(pickAndMixSlug('https://www.fanatical.com/en/bundle/foo'), null);
  assert.equal(pickAndMixSlug(null), null);
  assert.equal(pickAndMixSlug('%E0%A4%A'), null); // malformed escape
});

test('parsePickAndMix: major units, rounded, quantity-ascending, empty bundles dropped', () => {
  assert.deepEqual(parsePickAndMix(FEED), {
    'build-your-own-killer-bundle': {
      tiers: [
        { quantity: 1, prices: { USD: 1.49, CAD: 2.5 } },
        { quantity: 6, prices: { USD: 6.99, CAD: 17.9 } },
      ],
      products: [{ name: 'Rain World', slug: 'rain-world' }],
      type: 'bundle',
      validFrom: '2026-09-07T13:00:00.000Z',
      validUntil: '2026-11-13T23:59:00.000Z',
    },
  });
  assert.deepEqual(parsePickAndMix(null), {});
  // Dates and type are optional: a missing or malformed one is null, not a reason to drop the tiers.
  const [entry] = Object.values(
    parsePickAndMix({ pickandmix: [{ slug: 's', valid_until: 'soon', tiers: [{ quantity: 1, price: { USD: 1 } }] }] }),
  );
  assert.deepEqual([entry.type, entry.validFrom, entry.validUntil], [null, null, null]);
});

test('matchPickAndMix: by slug, title, subtitled title or base title; the rest left out', () => {
  const products = [
    { name: 'RoboCop: Rogue City', slug: 'robocop-rogue-city' },
    { name: 'Café Owner™ & Friends', slug: 'cafe-x' },
    { name: 'Dead Finger Dice: A Billionaire Killing Game', slug: 'dfd' },
    { name: 'Insurmountable + Supporter Pack', slug: 'ins' },
    { name: 'Unrelated Game', slug: 'u' },
    { name: 'Another One', slug: 'a' },
  ];
  const game = (id, slug, title) => ({ id, slug, title });
  const bundle = {
    tiers: [
      {
        games: [
          game('g1', 'robocop-rogue-city', 'Robocop Renamed'),
          game('g2', 'cafe-owner', 'Cafe Owner and Friends'),
          game('g3', 'dead-finger-dice', 'Dead Finger Dice'),
          game('g4', 'insurmountable', 'Insurmountable - Supporter Bundle'),
          game('g5', 'renamed', 'Renamed Pack'),
        ],
      },
      { games: [game('g1', 'robocop-rogue-city', 'Robocop Renamed')] },
    ],
  };
  assert.deepEqual(matchPickAndMix(bundle, products), {
    g1: 'RoboCop: Rogue City',
    g2: 'Café Owner™ & Friends',
    g3: 'Dead Finger Dice: A Billionaire Killing Game',
    g4: 'Insurmountable + Supporter Pack',
  });
});

test('matchPickAndMix: the one game and one product left in a bundle whose counts agree are paired', () => {
  const bundle = (titles) => ({
    tiers: [{ games: titles.map((title, i) => ({ id: `g${i}`, slug: `s${i}`, title })) }],
  });
  const products = [{ name: 'Fearmonium' }, { name: 'Classic Adventure Triple Pack' }];
  assert.deepEqual(matchPickAndMix(bundle(['Fearmonium', 'The Pixel Pulps Collection']), products), {
    g0: 'Fearmonium',
    g1: 'Classic Adventure Triple Pack',
  });
  // An extra game on ITAD's side means the leftover could be either.
  assert.deepEqual(matchPickAndMix(bundle(['Fearmonium', 'The Pixel Pulps Collection', 'Other']), products), {
    g0: 'Fearmonium',
  });
});

test('matchPickAndMix: a subtitle prefix shared by two products matches neither', () => {
  const products = [{ name: 'Doom: One' }, { name: 'Doom: Two' }];
  assert.deepEqual(matchPickAndMix({ tiers: [{ games: [{ id: 'g', slug: 'doom', title: 'Doom' }] }] }, products), {});
});

test('withPickAndMix: enriches only null-price Fanatical bundles, one cached fetch', async (t) => {
  _reset();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return { ok: true, json: async () => FEED };
  });
  const priced = fanaticalBundle({ id: 2, tiers: [{ price: { amount: 5, currency: 'USD' } }] });
  const humble = { id: 3, page: { name: 'Humble Bundle' }, url: ITAD_URL, tiers: [{ price: null }] };
  const [a, b, c] = await withPickAndMix([fanaticalBundle(), priced, humble]);
  assert.equal(a.pickAndMix.length, 2);
  assert.equal(a.pickAndMixNames, undefined);
  // Fanatical's own end date replaces ITAD's, which runs early (integrations.md).
  assert.equal(a.expiry, '2026-11-13T23:59:00.000Z');
  assert.equal(b, priced);
  assert.equal(c, humble);
  const games = [{ id: 'g1', slug: 'rain-world', title: 'Rain World' }];
  const [named] = await withPickAndMix([fanaticalBundle({ tiers: [{ price: null, games }] })], { names: true });
  assert.deepEqual(named.pickAndMixNames, { g1: 'Rain World' });
  assert.equal(calls, 1);
});

test('withPickAndMix: no fetch at all when nothing needs it', async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => assert.fail('should not fetch'));
  const bundles = [{ id: 1, page: { name: 'Humble Bundle' }, tiers: [{ price: null }] }];
  assert.equal(await withPickAndMix(bundles), bundles);
});

test('getPickAndMix: a failed fetch degrades to no tiers and is not retried per request', async (t) => {
  _reset();
  let calls = 0;
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return { ok: false, status: 403 };
  });
  const [b] = await withPickAndMix([fanaticalBundle()]);
  assert.equal(b.pickAndMix, undefined);
  await getPickAndMix();
  assert.equal(calls, 1);
});

test('getPickAndMix: re-fetches for an unknown slug once the map is old, keeping it on failure', async (t) => {
  _reset();
  t.mock.method(console, 'warn', () => {});
  const old = { known: { tiers: [{ quantity: 1, prices: { USD: 1 } }], products: [] } };
  setCache('fanatical-pnm:v3', old);
  const later = Date.now() + 2 * 60 * 60 * 1000;
  t.mock.method(Date, 'now', () => later);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return { ok: false, status: 500 };
  });
  assert.deepEqual(await getPickAndMix(['known']), old);
  assert.equal(calls, 0);
  assert.deepEqual(await getPickAndMix(['new-one']), old);
  assert.equal(calls, 1);
});

test("withPickAndMix: ITAD's end date stays when the feed has none", async (t) => {
  _reset();
  const feed = { pickandmix: [{ ...FEED.pickandmix[0], valid_until: undefined }] };
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => feed }));
  const [b] = await withPickAndMix([fanaticalBundle()]);
  assert.equal(b.expiry, '2026-11-01T00:58:54+01:00');
});

test("withCachedPickAndMix: Fanatical's end date from the cached feed only, never fetching", async (t) => {
  _reset();
  t.mock.method(globalThis, 'fetch', async () => assert.fail('should not fetch'));
  const bundle = fanaticalBundle();
  assert.equal(withCachedPickAndMix(bundle), bundle);
  setCache('fanatical-pnm:v3', parsePickAndMix(FEED));
  assert.equal(withCachedPickAndMix(bundle).expiry, '2026-11-13T23:59:00.000Z');
});
