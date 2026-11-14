'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  flattenBundleGames,
  fetchBundleById,
  resolveBundleAppids,
  resolveBundleGames,
  fetchBundleContents,
  BundleNotFoundError,
} = require('../public/bundleData.ts');

const { withFetch } = require('./withFetch.js');

function game(id, title = id) {
  return { id, slug: id, title, type: 'game', assets: null };
}

// ── flattenBundleGames ───────────────────────────────────────────────────────────────────────

test("flattenBundleGames: flattens every tier's games into one list", () => {
  const bundle = {
    tiers: [
      { price: { amount: 500, currency: 'USD' }, games: [game('a')], addon: false },
      { price: { amount: 1000, currency: 'USD' }, games: [game('b')], addon: false },
    ],
  };
  const flat = flattenBundleGames(bundle);
  assert.deepEqual(
    flat.map((g) => g.gid),
    ['a', 'b'],
  );
});

test("flattenBundleGames: a game repeated across tiers is deduped, keeping the cheapest (first-seen) tier's price", () => {
  const bundle = {
    tiers: [
      { price: { amount: 500, currency: 'USD' }, games: [game('a')], addon: false },
      { price: { amount: 1500, currency: 'USD' }, games: [game('a'), game('b')], addon: false },
    ],
  };
  const flat = flattenBundleGames(bundle);
  assert.equal(flat.length, 2);
  const a = flat.find((g) => g.gid === 'a');
  assert.equal(a.tierPrice, 500);
});

test('flattenBundleGames: a null tier price (e.g. a "Build Your Own" pick-and-mix tier) maps to null, not 0', () => {
  const bundle = { tiers: [{ price: null, games: [game('a')], addon: false }] };
  const flat = flattenBundleGames(bundle);
  assert.equal(flat[0].tierPrice, null);
  assert.equal(flat[0].tierCurrency, null);
});

test('flattenBundleGames: priced tiers ITAD left empty make the last listed tier a price range', () => {
  const bundle = {
    tiers: [
      { price: { amount: 5, currency: 'USD' }, games: [game('a')], addon: false },
      { price: { amount: 10, currency: 'USD' }, games: [game('b')], addon: false },
      { price: { amount: 15, currency: 'USD' }, games: [], addon: false },
      { price: { amount: 20, currency: 'USD' }, games: [], addon: false },
    ],
  };
  const [a, b] = flattenBundleGames(bundle);
  assert.equal(a.tierPriceMax, null);
  assert.equal(b.tierPrice, 10);
  assert.equal(b.tierPriceMax, 20);
});

test('flattenBundleGames: a trailing empty unpriced tier leaves the price exact', () => {
  const bundle = {
    tiers: [
      { price: { amount: 5, currency: 'USD' }, games: [game('a')], addon: false },
      { price: null, games: [], addon: false },
    ],
  };
  assert.equal(flattenBundleGames(bundle)[0].tierPriceMax, null);
});

test("flattenBundleGames: an add-on tier after empty priced tiers doesn't hide the range", () => {
  const bundle = {
    tiers: [
      { price: { amount: 5, currency: 'USD' }, games: [game('a')], addon: false },
      { price: { amount: 15, currency: 'USD' }, games: [], addon: false },
      { price: { amount: 2, currency: 'USD' }, games: [game('x')], addon: true },
    ],
  };
  const [a, x] = flattenBundleGames(bundle);
  assert.equal(a.tierPriceMax, 15);
  assert.equal(x.tierPriceMax, null);
});

test('flattenBundleGames: marks addon games from an addon tier', () => {
  const bundle = { tiers: [{ price: { amount: 100, currency: 'USD' }, games: [game('a')], addon: true }] };
  assert.equal(flattenBundleGames(bundle)[0].addon, true);
});

test('flattenBundleGames: no tiers at all yields an empty list', () => {
  assert.deepEqual(flattenBundleGames({ tiers: [] }), []);
});

// ── fetchBundleById ──────────────────────────────────────────────────────────────────────────

test('fetchBundleById: fetches GET /api/bundles/:id, with an optional country param, and unwraps the { bundle, fetchedAt } response', async (t) => {
  let seenUrl;
  withFetch(t, async (url) => {
    seenUrl = url;
    return { ok: true, json: async () => ({ bundle: { id: 42, title: 'Bundle' }, fetchedAt: 1700000000000 }) };
  });

  const { bundle, fetchedAt } = await fetchBundleById(42, { country: 'US' });
  assert.equal(seenUrl, '/api/bundles/42?country=US');
  assert.equal(bundle.id, 42);
  // How old the server's cached copy is — the bundle hero's own Updated tile.
  assert.equal(fetchedAt, 1700000000000);
});

test('fetchBundleById: a 404 is a BundleNotFoundError, any other failure a plain Error', async (t) => {
  withFetch(t, async (url) => ({
    ok: false,
    status: url.includes('/1') ? 404 : 502,
    json: async () => ({ error: 'nope' }),
  }));
  await assert.rejects(fetchBundleById(1), BundleNotFoundError);
  await assert.rejects(fetchBundleById(2), (err) => !(err instanceof BundleNotFoundError) && err.message === 'nope');
});

test('fetchBundleById: a response with no fetchedAt at all reports null, not undefined', async (t) => {
  withFetch(t, async () => ({ ok: true, json: async () => ({ bundle: { id: 7 } }) }));
  assert.equal((await fetchBundleById(7)).fetchedAt, null);
});

test('fetchBundleById: no country param when omitted', async (t) => {
  let seenUrl;
  withFetch(t, async (url) => {
    seenUrl = url;
    return { ok: true, json: async () => ({ bundle: { id: 1 } }) };
  });
  await fetchBundleById(1);
  assert.equal(seenUrl, '/api/bundles/1');
});

test("fetchBundleById: a non-http(s) ITAD link becomes null, so the hero can't render it as an href", async (t) => {
  withFetch(t, async () => ({
    ok: true,
    json: async () => ({
      bundle: { id: 1, url: 'javascript:alert(1)', details: 'https://isthereanydeal.com/bundles/1/' },
    }),
  }));
  const { bundle } = await fetchBundleById(1);
  assert.equal(bundle.url, null);
  assert.equal(bundle.details, 'https://isthereanydeal.com/bundles/1/');
});

test('fetchBundleById: throws with the server error message on a non-2xx response', async (t) => {
  withFetch(t, async () => ({ ok: false, json: async () => ({ error: 'not found' }) }));
  await assert.rejects(() => fetchBundleById(999), /not found/);
});

// ── resolveBundleAppids ──────────────────────────────────────────────────────────────────────

test('resolveBundleAppids: posts gids, returns the gid->appid map as-is, and no failed gids when none are listed', async (t) => {
  let seenBody;
  withFetch(t, async (url, opts) => {
    seenBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ appids: { a: 440, b: null } }) };
  });

  const res = await resolveBundleAppids(['a', 'b']);
  assert.deepEqual(seenBody, { gids: ['a', 'b'] });
  assert.deepEqual(res, { appids: { a: 440, b: null }, failed: [] });
});

test('resolveBundleAppids: throws with the server error message on a non-2xx response', async (t) => {
  withFetch(t, async () => ({ ok: false, json: async () => ({ error: 'resolution failed' }) }));
  await assert.rejects(() => resolveBundleAppids(['a']), /resolution failed/);
});

// ── resolveBundleGames ───────────────────────────────────────────────────────────────────────

test('resolveBundleGames: splits into resolved (with appid)/unresolved, preserving cheapest-tier order', async (t) => {
  const bundle = { tiers: [{ price: { amount: 500, currency: 'USD' }, games: [game('a'), game('b')], addon: false }] };
  withFetch(t, async () => ({ ok: true, json: async () => ({ appids: { a: 440, b: null } }) }));

  const { resolved, unresolved } = await resolveBundleGames(bundle);
  assert.deepEqual(
    resolved.map((g) => g.appid),
    [440],
  );
  assert.deepEqual(
    unresolved.map((g) => g.gid),
    ['b'],
  );
});

test('resolveBundleGames: a gid the server failed to resolve is failed, not one with no Steam listing', async (t) => {
  const bundle = { tiers: [{ price: null, games: [game('a'), game('b'), game('c')], addon: false }] };
  withFetch(t, async () => ({ ok: true, json: async () => ({ appids: { a: 440, b: null }, failed: ['c'] }) }));

  const { resolved, unresolved, failed } = await resolveBundleGames(bundle);
  assert.deepEqual(
    resolved.map((g) => g.appid),
    [440],
  );
  assert.deepEqual(
    unresolved.map((g) => g.gid),
    ['b'],
  );
  assert.deepEqual(
    failed.map((g) => g.gid),
    ['c'],
  );
});

test('resolveBundleGames: two distinct gids resolving to the same appid keep only the first occurrence', async (t) => {
  const bundle = { tiers: [{ price: { amount: 500, currency: 'USD' }, games: [game('a'), game('b')], addon: false }] };
  withFetch(t, async () => ({ ok: true, json: async () => ({ appids: { a: 440, b: 440 } }) }));

  const { resolved } = await resolveBundleGames(bundle);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].gid, 'a');
});

// A gid resolving to a Steam "sub"/"bundle" spanning several apps (e.g. a base game plus its
// DLC sold as one SKU) becomes one row per appid, each sharing the gid's own tier price.
test("resolveBundleGames: a gid resolving to an array of appids becomes one row per appid, sharing the gid's tier metadata", async (t) => {
  const bundle = {
    tiers: [{ price: { amount: 2999, currency: 'USD' }, games: [game('everspace-ultimate')], addon: false }],
  };
  withFetch(t, async () => ({
    ok: true,
    json: async () => ({ appids: { 'everspace-ultimate': [396750, 688700, 709150] } }),
  }));

  const { resolved, unresolved } = await resolveBundleGames(bundle);
  assert.deepEqual(unresolved, []);
  assert.deepEqual(
    resolved.map((g) => g.appid),
    [396750, 688700, 709150],
  );
  assert.ok(resolved.every((g) => g.gid === 'everspace-ultimate' && g.tierPrice === 2999));
});

test('resolveBundleGames: an appid from an expanded array already seen elsewhere is deduped, same as a plain duplicate', async (t) => {
  const bundle = {
    tiers: [
      {
        price: { amount: 2999, currency: 'USD' },
        games: [game('everspace-base'), game('everspace-ultimate')],
        addon: false,
      },
    ],
  };
  withFetch(t, async () => ({
    ok: true,
    json: async () => ({ appids: { 'everspace-base': 396750, 'everspace-ultimate': [396750, 688700] } }),
  }));

  const { resolved } = await resolveBundleGames(bundle);
  assert.deepEqual(
    resolved.map((g) => g.appid),
    [396750, 688700],
  );
  assert.equal(resolved[0].gid, 'everspace-base', 'first occurrence (the plain appid) wins the dedup');
});

// ── fetchBundleContents ──────────────────────────────────────────────────────────────────────

test('fetchBundleContents: fetches the bundle, resolves it, returns its title and flat appid Set', async (t) => {
  const calls = [];
  withFetch(t, async (url, opts) => {
    calls.push(url);
    if (url.startsWith('/api/bundles/42')) {
      return {
        ok: true,
        json: async () => ({
          bundle: { id: 42, title: 'Pack', tiers: [{ price: null, games: [game('a')], addon: false }] },
        }),
      };
    }
    return { ok: true, json: async () => ({ appids: { a: 440 } }) };
  });

  const { title, appids } = await fetchBundleContents('42');
  assert.equal(title, 'Pack');
  assert.deepEqual(appids, new Set([440]));
  assert.equal(calls[0], '/api/bundles/42');
});
