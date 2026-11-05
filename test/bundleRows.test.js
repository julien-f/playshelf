'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  cheapestTierPrice,
  fmtBundleDateTime,
  fmtBundleDatePart,
  fmtBundleTimePart,
  toBundleRow,
  bundleOwnership,
  bundleCovers,
  shopHue,
  bundleUrgency,
  bundleEndsIn,
  compareEndsIn,
  ENDS_IN,
  bundleAge,
  compareBundleAge,
  BUNDLE_AGE,
  bundleTierSummary,
  bundlePricingModel,
  filterTiers,
  activeTierPrice,
  atTier,
  pickTiers,
  pickRate,
  cheapestPicks,
  pickPlanDetail,
  savingsText,
  tierGroupKey,
  tierGroupLabel,
  tierValues,
  sumBestDeals,
  savingTier,
  bundlePackages,
  wholePackages,
} = require('../public/bundleRows.ts');

const HOUR = 3600000;
const DAY = 24 * HOUR;

function withBanner(id) {
  return {
    id,
    assets: {
      boxart: `https://assets.example/${id}/boxart.jpg`,
      banner145: `https://assets.example/${id}/banner145.jpg`,
    },
  };
}

function bundle(overrides = {}) {
  return {
    id: 1,
    title: 'A Bundle',
    page: { name: 'Fanatical' },
    counts: { games: 12 },
    publish: '2026-08-01T10:00:00+02:00',
    expiry: '2026-09-01T10:00:00+02:00',
    tiers: [{ price: { amount: 5, currency: 'USD' } }],
    ...overrides,
  };
}

// ── cheapestTierPrice ────────────────────────────────────────────────────────────────────────

test('cheapestTierPrice: picks the lowest-priced tier regardless of tier order', () => {
  const b = bundle({
    tiers: [
      { price: { amount: 25, currency: 'EUR' } },
      { price: { amount: 5, currency: 'EUR' } },
      { price: { amount: 15, currency: 'EUR' } },
    ],
  });
  assert.deepEqual(cheapestTierPrice(b), { amount: 5, currency: 'EUR' });
});

test('cheapestTierPrice: null when no tier carries a price (a "Build Your Own" bundle)', () => {
  assert.equal(cheapestTierPrice(bundle({ tiers: [{ price: null }, { price: null }] })), null);
});

test('cheapestTierPrice: a real zero-amount tier is a price, not a missing one', () => {
  assert.deepEqual(cheapestTierPrice(bundle({ tiers: [{ price: { amount: 0, currency: 'USD' } }] })), {
    amount: 0,
    currency: 'USD',
  });
});

test('cheapestTierPrice: ignores priceless tiers alongside priced ones', () => {
  const b = bundle({ tiers: [{ price: null }, { price: { amount: 9, currency: 'USD' } }] });
  assert.deepEqual(cheapestTierPrice(b), { amount: 9, currency: 'USD' });
});

test('cheapestTierPrice: no tiers at all', () => {
  assert.equal(cheapestTierPrice(bundle({ tiers: [] })), null);
  assert.equal(cheapestTierPrice(bundle({ tiers: undefined })), null);
});

// ── fmtBundleDateTime ────────────────────────────────────────────────────────────────────────────

test('fmtBundleDateTime: formats an ITAD timestamp as its own local date and time', () => {
  // Deliberately an offset timestamp whose UTC date differs from its local one in a negative-
  // offset timezone: this is what `toISOString().slice(0, 10)` gets wrong.
  const iso = '2026-09-25T01:30:00+02:00';
  const expected = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  assert.equal(
    fmtBundleDateTime(iso),
    `${expected.getFullYear()}-${pad(expected.getMonth() + 1)}-${pad(expected.getDate())}` +
      ` ${pad(expected.getHours())}:${pad(expected.getMinutes())}`,
  );
});

test('fmtBundleDatePart / fmtBundleTimePart: the two halves the stacked cell renders', () => {
  const iso = '2026-09-25T01:30:00+02:00';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  assert.equal(fmtBundleDatePart(iso), `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  assert.equal(fmtBundleTimePart(iso), `${pad(d.getHours())}:${pad(d.getMinutes())}`);
  // Together they're exactly the flat form the column's own `format` (and so the table's search)
  // still returns.
  assert.equal(fmtBundleDateTime(iso), `${fmtBundleDatePart(iso)} ${fmtBundleTimePart(iso)}`);
});

test('fmtBundleTimePart: empty for a missing date, so the cell renders no second line at all', () => {
  for (const v of [null, undefined, '', 'not a date']) {
    assert.equal(fmtBundleTimePart(v), '');
    assert.equal(fmtBundleDatePart(v), '—');
    // No trailing space from an empty time half.
    assert.equal(fmtBundleDateTime(v), '—');
  }
});

test('fmtBundleDateTime: keeps the time that distinguishes two same-day bundles', () => {
  // The reason the time is shown at all: the table sorts on the full timestamp, so a pair of rows
  // both reading "2026-09-04" would otherwise look arbitrarily ordered.
  const early = fmtBundleDateTime('2026-09-04T16:55:38+02:00');
  const late = fmtBundleDateTime('2026-09-04T20:35:03+02:00');
  assert.notEqual(early, late);
  assert.ok(early < late, `${early} should render before ${late}`);
});

test('fmtBundleDateTime: missing/unparseable dates render as an em dash', () => {
  assert.equal(fmtBundleDateTime(null), '—');
  assert.equal(fmtBundleDateTime(undefined), '—');
  assert.equal(fmtBundleDateTime(''), '—');
  assert.equal(fmtBundleDateTime('not a date'), '—');
});

// ── bundleCovers ─────────────────────────────────────────────────────────────────────────────

test('bundleCovers: takes the first four banners in tier order', () => {
  const b = bundle({
    tiers: [
      { price: { amount: 5, currency: 'USD' }, games: [withBanner('a'), withBanner('b')] },
      { price: { amount: 15, currency: 'USD' }, games: [withBanner('c'), withBanner('d'), withBanner('e')] },
    ],
  });
  assert.deepEqual(bundleCovers(b), [
    'https://assets.example/a/banner145.jpg',
    'https://assets.example/b/banner145.jpg',
    'https://assets.example/c/banner145.jpg',
    'https://assets.example/d/banner145.jpg',
  ]);
});

test('bundleCovers: dedupes a game listed in several tiers', () => {
  const b = bundle({
    tiers: [
      { price: { amount: 5, currency: 'USD' }, games: [withBanner('a')] },
      { price: { amount: 15, currency: 'USD' }, games: [withBanner('a'), withBanner('b')] },
    ],
  });
  assert.deepEqual(bundleCovers(b), [
    'https://assets.example/a/banner145.jpg',
    'https://assets.example/b/banner145.jpg',
  ]);
});

test('bundleCovers: skips games with no artwork rather than leaving a hole', () => {
  const b = bundle({ tiers: [{ price: null, games: [{ assets: {} }, { assets: null }, {}, withBanner('a')] }] });
  assert.deepEqual(bundleCovers(b), ['https://assets.example/a/banner145.jpg']);
});

test('bundleCovers: empty for a bundle with no games/tiers at all', () => {
  assert.deepEqual(bundleCovers(bundle({ tiers: [] })), []);
  assert.deepEqual(bundleCovers(bundle({ tiers: [{ price: null, games: null }] })), []);
});

test('bundleCovers: honors an explicit max', () => {
  const b = bundle({ tiers: [{ price: null, games: [withBanner('a'), withBanner('b'), withBanner('c')] }] });
  assert.equal(bundleCovers(b, 2).length, 2);
});

// ── bundleTierSummary ────────────────────────────────────────────────────────────────────────

test("bundleTierSummary: one entry per tier, in order, with that tier's own game count", () => {
  const b = bundle({
    tiers: [
      { price: { amount: 5, currency: 'USD' }, games: [withBanner('a')] },
      { price: { amount: 15, currency: 'USD' }, games: [withBanner('a'), withBanner('b'), withBanner('c')] },
    ],
  });
  assert.deepEqual(bundleTierSummary(b), [
    { price: 5, currency: 'USD', gameCount: 1 },
    // Deliberately not deduped against the cheaper tier: a pricier tier includes everything below
    // it, and the card presents these as tiers, not as a partition that should sum to the total.
    { price: 15, currency: 'USD', gameCount: 3 },
  ]);
});

test('bundleTierSummary: a pick-and-mix tier keeps a null price (rendered "Varies", never Free)', () => {
  const b = bundle({ tiers: [{ price: null, games: [withBanner('a')] }] });
  assert.deepEqual(bundleTierSummary(b), [{ price: null, currency: null, gameCount: 1 }]);
});

test('bundleTierSummary: a real zero-amount tier is a price, not a missing one', () => {
  const b = bundle({ tiers: [{ price: { amount: 0, currency: 'EUR' }, games: [] }] });
  assert.deepEqual(bundleTierSummary(b), [{ price: 0, currency: 'EUR', gameCount: 0 }]);
});

test('bundleTierSummary: empty for a bundle with no tiers', () => {
  assert.deepEqual(bundleTierSummary(bundle({ tiers: [] })), []);
  assert.deepEqual(bundleTierSummary(bundle({ tiers: undefined })), []);
});

test('bundleTierSummary: drops an empty unpriced tier and marks add-ons (bundle 14804)', () => {
  const b = bundle({
    tiers: [
      { price: { amount: 22.07, currency: 'USD' }, games: [{}, {}, {}] },
      { price: null, games: [], addon: true },
      { price: { amount: 2, currency: 'USD' }, games: [{}], addon: true },
    ],
  });
  assert.deepEqual(bundleTierSummary(b), [
    { price: 22.07, currency: 'USD', gameCount: 3 },
    { price: 2, currency: 'USD', gameCount: 1, addon: true },
  ]);
});

// ── bundlePricingModel ───────────────────────────────────────────────────────────────────────

test('bundlePricingModel: tiered, fixed or pick, from the base tiers only', () => {
  const t = (price, extra = {}) => ({ price, currency: price == null ? null : 'USD', gameCount: 1, ...extra });
  assert.equal(bundlePricingModel([t(5), t(12)]), 'tiered');
  assert.equal(bundlePricingModel([t(5), t(10.55), t(18.99, { gameCount: 0 })]), 'tiered', 'empty priced tiers count');
  // Bundle 16689: five base tiers and two add-ons, one priced like a base tier.
  assert.equal(
    bundlePricingModel([t(4), t(6), t(9), t(13), t(16), t(2, { addon: true }), t(4, { addon: true })]),
    'tiered',
  );
  assert.equal(bundlePricingModel([t(22.07), t(2, { addon: true })]), 'fixed', 'one base tier beside an add-on');
  assert.equal(bundlePricingModel([t(0)]), 'fixed', 'a free tier is a price');
  assert.equal(bundlePricingModel([t(2, { quantity: 1 }), t(3.5, { quantity: 3 })]), 'pick');
  assert.equal(bundlePricingModel([t(null, { gameCount: 15 })]), 'pick', 'Build your own with no known rates');
  assert.equal(bundlePricingModel([]), 'fixed', 'no tiers: nothing to choose');
});

// ── filterTiers / activeTierPrice / atTier ───────────────────────────────────────────────────

const usd = (price, gameCount = 1) => ({ price, currency: 'USD', gameCount });

test('filterTiers: two or more priced tiers filter; one tier, a Varies one or pick-and-mix do not', () => {
  assert.deepEqual(filterTiers([usd(5), usd(12)]), [usd(5), usd(12)]);
  assert.deepEqual(filterTiers([usd(5)]), []);
  assert.deepEqual(filterTiers([usd(5), { price: null, currency: null, gameCount: 3 }]), []);
  assert.deepEqual(filterTiers([usd(4), usd(6), { ...usd(2), addon: true }]), [usd(4), usd(6)], 'add-ons apart');
  assert.deepEqual(filterTiers([usd(4), { ...usd(2), addon: true }]), [], 'one base tier');
  assert.deepEqual(
    filterTiers([
      { ...usd(2), quantity: 1 },
      { ...usd(3.5), quantity: 3 },
    ]),
    [],
  );
});

test("activeTierPrice: a max alone equal to a tier's price selects it", () => {
  const tiers = [usd(1), usd(10.99), usd(15)];
  assert.equal(activeTierPrice({ min: '', max: String(10.99) }, tiers), 10.99);
  assert.equal(activeTierPrice({ min: '', max: '7' }, tiers), null, 'no tier at that price');
  assert.equal(activeTierPrice({ min: '1', max: '15' }, tiers), null, 'a min set by hand');
  assert.equal(activeTierPrice({ min: '', max: '' }, tiers), null);
  assert.equal(activeTierPrice(undefined, tiers), null);
  assert.equal(activeTierPrice({ min: '', max: '15' }, [usd(15)]), null, 'a lone tier filters nothing');
});

test("atTier: paying a tier gets its games and every cheaper tier's, never a Varies one", () => {
  assert.equal(atTier({ tierPrice: 5 }, 12), true);
  assert.equal(atTier({ tierPrice: 12 }, 12), true);
  assert.equal(atTier({ tierPrice: 15 }, 12), false);
  assert.equal(atTier({ tierPrice: 0 }, 12), true, 'a free tier');
  assert.equal(atTier({ tierPrice: null }, 12), false);
  assert.equal(atTier({ tierPrice: 2, addon: true }, 12), false, 'an add-on is bought apart');
});

// ── shopHue ──────────────────────────────────────────────────────────────────────────────────

test('shopHue: deterministic, and in range for every shop name seen live', () => {
  for (const name of [
    'Humble Bundle',
    'Fanatical',
    'GreenManGaming',
    'GreenMan Gaming',
    'IndieGala',
    'Itch.io',
    'Digiphile',
    '',
  ]) {
    const hue = shopHue(name);
    assert.equal(hue, shopHue(name), `${name} must hash consistently`);
    assert.ok(Number.isInteger(hue) && hue >= 0 && hue < 360, `${name} hue out of range: ${hue}`);
  }
});

test('shopHue: different shops get different hues (no collision among the live shop names)', () => {
  const names = ['Humble Bundle', 'Fanatical', 'GreenManGaming', 'IndieGala', 'Itch.io', 'Digiphile'];
  assert.equal(new Set(names.map(shopHue)).size, names.length);
});

// ── bundleUrgency ────────────────────────────────────────────────────────────────────────────

test('bundleUrgency: tiers by how much time is left', () => {
  const now = Date.parse('2026-09-07T12:00:00Z');
  const at = (ms) => new Date(now + ms).toISOString();
  assert.deepEqual(bundleUrgency(at(-HOUR), now), { tier: 'ended', label: 'ended' });
  // Inside the last day the label counts hours — that's the window where 20h vs 2h changes what
  // you do about it.
  assert.deepEqual(bundleUrgency(at(20 * 60000), now), { tier: 'urgent', label: '<1h' });
  assert.deepEqual(bundleUrgency(at(6 * HOUR), now), { tier: 'urgent', label: 'in 6h' });
  // Floored, never rounded up: 90 minutes left is "in 1h", not "in 2h".
  assert.deepEqual(bundleUrgency(at(90 * 60000), now), { tier: 'urgent', label: 'in 1h' });
  assert.deepEqual(bundleUrgency(at(23 * HOUR), now), { tier: 'urgent', label: 'in 23h' });
  // Past 24h it's whole days again — "in 30h" is no more actionable and harder to read.
  assert.deepEqual(bundleUrgency(at(30 * HOUR), now), { tier: 'urgent', label: 'in 1d' });
  assert.deepEqual(bundleUrgency(at(4 * DAY), now), { tier: 'soon', label: 'in 4d' });
  // Past a week out the date alone carries it — no label, so it renders as nothing.
  assert.deepEqual(bundleUrgency(at(20 * DAY), now), { tier: 'later', label: '' });
});

test('bundleUrgency: no expiry (open-ended bundle) and unparseable dates are not urgency at all', () => {
  assert.equal(bundleUrgency(null), null);
  assert.equal(bundleUrgency(undefined), null);
  assert.equal(bundleUrgency(''), null);
  assert.equal(bundleUrgency('not a date'), null);
});

// ── bundleEndsIn / compareEndsIn ─────────────────────────────────────────────────────────────

test('bundleEndsIn: one label per urgency tier, and a named bucket for no end date', () => {
  const now = Date.parse('2026-09-07T12:00:00Z');
  const at = (ms) => new Date(now + ms).toISOString();
  assert.equal(bundleEndsIn(at(-HOUR), now), ENDS_IN.ended);
  assert.equal(bundleEndsIn(at(6 * HOUR), now), ENDS_IN.urgent);
  // The 48h boundary the hero tile's own count is drawn at.
  assert.equal(bundleEndsIn(at(47 * HOUR), now), ENDS_IN.urgent);
  assert.equal(bundleEndsIn(at(49 * HOUR), now), ENDS_IN.soon);
  assert.equal(bundleEndsIn(at(6 * DAY), now), ENDS_IN.soon);
  assert.equal(bundleEndsIn(at(8 * DAY), now), ENDS_IN.later);
  // An open-ended bundle and an unparseable date are both "no deadline to show", not missing data.
  assert.equal(bundleEndsIn(null, now), ENDS_IN.open);
  assert.equal(bundleEndsIn('not a date', now), ENDS_IN.open);
});

test('compareEndsIn: orders by urgency, not alphabetically', () => {
  const sorted = [ENDS_IN.ended, ENDS_IN.later, ENDS_IN.open, ENDS_IN.soon, ENDS_IN.urgent].sort(compareEndsIn);
  assert.deepEqual(sorted, [ENDS_IN.urgent, ENDS_IN.soon, ENDS_IN.later, ENDS_IN.open, ENDS_IN.ended]);
});

// ── bundleAge / compareBundleAge ─────────────────────────────────────────────────────────────

test('bundleAge: buckets a bundle by how long ago it was published', () => {
  const now = Date.parse('2026-09-07T12:00:00Z');
  const ago = (ms) => new Date(now - ms).toISOString();
  assert.equal(bundleAge(ago(2 * HOUR), now), BUNDLE_AGE.fresh);
  // The 24h boundary the hero tile's "New" count is drawn at.
  assert.equal(bundleAge(ago(23 * HOUR), now), BUNDLE_AGE.fresh);
  assert.equal(bundleAge(ago(25 * HOUR), now), BUNDLE_AGE.week);
  assert.equal(bundleAge(ago(6 * DAY), now), BUNDLE_AGE.week);
  assert.equal(bundleAge(ago(8 * DAY), now), BUNDLE_AGE.older);
  assert.equal(bundleAge(null, now), BUNDLE_AGE.unknown);
  assert.equal(bundleAge('not a date', now), BUNDLE_AGE.unknown);
});

test('compareBundleAge: orders newest-first, not alphabetically', () => {
  const sorted = [BUNDLE_AGE.older, BUNDLE_AGE.unknown, BUNDLE_AGE.week, BUNDLE_AGE.fresh].sort(compareBundleAge);
  assert.deepEqual(sorted, [BUNDLE_AGE.fresh, BUNDLE_AGE.week, BUNDLE_AGE.older, BUNDLE_AGE.unknown]);
});

// ── toBundleRow ──────────────────────────────────────────────────────────────────────────────

test('toBundleRow: flattens every field the table sorts/filters/groups on', () => {
  const b = bundle({ tiers: [{ price: { amount: 5, currency: 'USD' }, games: [withBanner('a')] }] });
  const row = toBundleRow(b, Date.parse('2026-08-15T00:00:00Z'));
  assert.deepEqual(row, {
    id: 1,
    title: 'A Bundle',
    shop: 'Fanatical',
    games: 12,
    tierCount: 1,
    price: 5,
    currency: 'USD',
    pickQuantity: null,
    publish: '2026-08-01T10:00:00+02:00',
    expiry: '2026-09-01T10:00:00+02:00',
    status: 'Active',
    covers: ['https://assets.example/a/banner145.jpg'],
    gids: ['a'],
  });
});

test('toBundleRow: gids lists a game once though it sits in several tiers', () => {
  const tiers = [{ games: [{ id: 'a' }] }, { games: [{ id: 'a' }, { id: 'b' }] }, { games: null }];
  assert.deepEqual(toBundleRow(bundle({ tiers }), Date.now()).gids, ['a', 'b']);
});

test('toBundleRow: status is Expired once the expiry is in the past', () => {
  const b = bundle({ expiry: '2026-09-01T10:00:00+02:00' });
  assert.equal(toBundleRow(b, Date.parse('2026-09-02T00:00:00Z')).status, 'Expired');
  assert.equal(toBundleRow(b, Date.parse('2026-08-31T00:00:00Z')).status, 'Active');
});

test('toBundleRow: a bundle with no expiry at all counts as Active', () => {
  assert.equal(toBundleRow(bundle({ expiry: null }), Date.now()).status, 'Active');
});

test('toBundleRow: a priceless bundle keeps null price/currency (rendered "Varies", never Free)', () => {
  const row = toBundleRow(bundle({ tiers: [{ price: null }, { price: null }] }), Date.now());
  assert.equal(row.price, null);
  assert.equal(row.currency, null);
  assert.equal(row.tierCount, 2);
});

test('toBundleRow: missing shop/game count become null rather than empty strings or 0', () => {
  const row = toBundleRow(bundle({ page: null, counts: null }), Date.now());
  assert.equal(row.shop, null);
  assert.equal(row.games, null);
});

// ── Fanatical pick-and-mix ───────────────────────────────────────────────────────────────────

const PICKS_RAW = [
  { quantity: 1, prices: { USD: 1.49, EUR: 1.55 } },
  { quantity: 6, prices: { USD: 6.99, EUR: 7.25 } },
  { quantity: 12, prices: { USD: 12.99, EUR: 13.5 } },
];
const PICKS = pickTiers(PICKS_RAW, 'USD');

test('pickTiers: the region currency when every tier has it, else USD, else nothing', () => {
  assert.deepEqual(pickTiers(PICKS_RAW, 'EUR')[1], { quantity: 6, price: { amount: 7.25, currency: 'EUR' } });
  assert.equal(pickTiers(PICKS_RAW, 'BRL')[0].price.currency, 'USD');
  assert.deepEqual(pickTiers([{ quantity: 1, prices: { GBP: 1 } }], 'EUR'), []);
  assert.deepEqual(pickTiers(null, 'USD'), []);
});

test('pickRate: the rate the pick count reaches, the smallest tier for none', () => {
  assert.deepEqual(pickRate(PICKS, 0), { amount: 1.49, currency: 'USD' });
  assert.deepEqual(pickRate(PICKS, 7), { amount: 6.99 / 6, currency: 'USD' });
  assert.deepEqual(pickRate(PICKS, 5), { amount: 6.99 / 6, currency: 'USD' });
  assert.deepEqual(pickRate(PICKS, 12), { amount: 12.99 / 12, currency: 'USD' });
  assert.equal(pickRate([], 3), null);
});

test('cheapestPicks: every pick at the rate of the largest tier reached', () => {
  assert.deepEqual(cheapestPicks(PICKS, 7), { cost: 8.16, currency: 'USD', tier: PICKS[1], spare: 0 });
  assert.deepEqual(cheapestPicks(PICKS, 11), { cost: 12.82, currency: 'USD', tier: PICKS[1], spare: 0 });
  assert.deepEqual(cheapestPicks(PICKS, 25), { cost: 27.06, currency: 'USD', tier: PICKS[2], spare: 0 });
  assert.deepEqual(cheapestPicks(PICKS, 1), { cost: 1.49, currency: 'USD', tier: PICKS[0], spare: 0 });
});

test('cheapestPicks: rounding up to a tier when its price beats the rate below', () => {
  assert.deepEqual(cheapestPicks(PICKS, 5), { cost: 6.99, currency: 'USD', tier: PICKS[1], spare: 1 });
});

test('cheapestPicks: below the smallest tier, that tier is the minimum', () => {
  const tiers = pickTiers([{ quantity: 3, prices: { USD: 3 } }], 'USD');
  assert.deepEqual(cheapestPicks(tiers, 2), { cost: 3, currency: 'USD', tier: tiers[0], spare: 1 });
});

test('cheapestPicks: nothing to plan without tiers or picks', () => {
  assert.equal(cheapestPicks([], 3), null);
  assert.equal(cheapestPicks(PICKS, 0), null);
});

test('bundleTierSummary: Fanatical quantity tiers replace the null-price tier', () => {
  const b = { tiers: [{ price: null, games: [{}, {}, {}] }], pickAndMix: PICKS_RAW };
  assert.deepEqual(bundleTierSummary(b, 'EUR')[0], { price: 1.55, currency: 'EUR', gameCount: 3, quantity: 1 });
  assert.deepEqual(bundleTierSummary(b), [{ price: null, currency: null, gameCount: 3 }]);
});

test('toBundleRow: a pick-and-mix bundle lists its smallest tier, with its quantity', () => {
  const row = toBundleRow({ id: 1, title: 'B', tiers: [{ price: null }], pickAndMix: PICKS_RAW }, Date.now(), 'EUR');
  assert.equal(row.price, 1.55);
  assert.equal(row.currency, 'EUR');
  assert.equal(row.pickQuantity, 1);
});

test('pickPlanDetail: the rate, or the tier filled with its spare picks', () => {
  assert.equal(pickPlanDetail(cheapestPicks(PICKS, 7), 7), '7 picks · $1.17/game');
  assert.equal(pickPlanDetail(cheapestPicks(PICKS, 5), 5), '5 picks · 6-game tier · 1 more free');
  assert.equal(pickPlanDetail(cheapestPicks(PICKS, 1), 1), '1 pick · 1-game tier');
});

test('savingsText: saved, overpaid or even against the best deals, estimated in the region currency', () => {
  const plan = cheapestPicks(PICKS, 5);
  assert.deepEqual(savingsText(plan.cost, 23.4, 'USD', 'USD'), { text: 'saves $16.41', overpays: false });
  assert.deepEqual(savingsText(plan.cost, 5, 'USD', 'USD'), { text: '$1.99 more', overpays: true });
  assert.deepEqual(savingsText(plan.cost, 6.99, 'USD', 'USD'), { text: 'same as best deals', overpays: false });
  assert.match(savingsText(plan.cost, 23.4, 'USD', 'EUR').text, /^saves \$16\.41 \(≈ €[\d.]+\)$/);
});

// ── Steam packages ───────────────────────────────────────────────────────────────────────────

test('bundlePackages: only gids spanning several rows, led by their first', () => {
  const pkgs = bundlePackages([
    { gid: 'a', title: 'Solo', appid: 1 },
    { gid: 'p', title: 'Pack', appid: 2 },
    { gid: 'p', title: 'Pack', appid: 3 },
  ]);
  assert.equal(pkgs.has(1), false);
  assert.deepEqual(pkgs.get(2), { gid: 'p', title: 'Pack', size: 2, lead: true });
  assert.deepEqual(pkgs.get(3), { gid: 'p', title: 'Pack', size: 2, lead: false });
});

test('wholePackages: ticking or unticking one row of a package does the same to the rest', () => {
  const [solo, p1, p2] = [{ gid: undefined }, { gid: 'p' }, { gid: 'p' }];
  const all = [solo, p1, p2];
  const gidOf = (r) => r.gid;
  assert.deepEqual(wholePackages(new Set([solo]), [solo, p1], all, gidOf), [solo, p1, p2]);
  assert.deepEqual(wholePackages(new Set([solo, p1, p2]), [solo, p2], all, gidOf), [solo]);
  assert.equal(wholePackages(new Set(), [solo], all, gidOf), null);
  assert.equal(wholePackages(new Set([solo]), [solo, p1, p2], all, gidOf), null);
});

// ── bundleOwnership ──────────────────────────────────────────────────────────────────────────

const owns = (owned, wished) => (appid) => ({ inLibrary: owned.includes(appid), onWishlist: wished.includes(appid) });

test('bundleOwnership: counts each Steam game once, a package per appid, a non-Steam game not at all', () => {
  const appids = new Map([
    ['a', 1],
    ['pack', [2, 3]],
    ['dup', 1],
    ['course', null],
  ]);
  const got = bundleOwnership(['a', 'pack', 'dup', 'course'], appids, new Set(), owns([1], [3]));
  assert.deepEqual(got, { steam: 3, owned: 1, wishlist: 1 });
});

test('bundleOwnership: undefined while a gid or the ownership is still loading', () => {
  assert.equal(bundleOwnership(['a', 'b'], new Map([['a', 1]]), new Set(), owns([], [])), undefined);
  assert.equal(
    bundleOwnership(['a'], new Map([['a', 1]]), new Set(), () => null),
    undefined,
  );
});

test('bundleOwnership: null once a gid failed to resolve, never a partial count', () => {
  assert.equal(bundleOwnership(['a', 'b'], new Map([['a', 1]]), new Set(['b']), owns([1], [])), null);
});

test('bundleOwnership: a failed wishlist fetch leaves that count unknown, not zero', () => {
  const status = (appid) => ({ inLibrary: appid === 1, onWishlist: null });
  assert.deepEqual(
    bundleOwnership(
      ['a', 'b'],
      new Map([
        ['a', 1],
        ['b', 2],
      ]),
      new Set(),
      status,
    ),
    {
      steam: 2,
      owned: 1,
      wishlist: null,
    },
  );
});

// ── tierGroupKey / tierGroupLabel / savingTier ───────────────────────────────────────────────

test('tierGroupKey: base tiers by price, then add-ons, then unpriced games', () => {
  const keys = [{ tierPrice: 12 }, { tierPrice: 2, addon: true }, { tierPrice: null }, { tierPrice: 5 }].map(
    tierGroupKey,
  );
  assert.deepEqual(
    [...keys].sort((a, b) => a - b),
    [keys[3], keys[0], keys[1], keys[2]],
  );
  assert.notEqual(tierGroupKey({ tierPrice: 4 }), tierGroupKey({ tierPrice: 4, addon: true }), "16689's two $4");
});

test("tierGroupLabel: a tier's price and its step over the one below; a range, an add-on, a fixed price", () => {
  const tiers = [usd(5, 2), usd(12, 2), usd(18, 0), { ...usd(2), addon: true }];
  const label = (row, model = 'tiered', rangeMax = new Map()) =>
    tierGroupLabel(tierGroupKey(row), tiers, model, rangeMax, 'USD');
  assert.equal(label({ tierPrice: 5 }), '$5.00 tier');
  assert.equal(label({ tierPrice: 12 }), '$12.00 tier · +$7.00 over $5.00');
  assert.equal(label({ tierPrice: 12 }, 'tiered', new Map([[12, 18]])), "$12.00–$18.00 · which tier isn't listed");
  assert.equal(label({ tierPrice: 2, addon: true }), '$2.00 add-on');
  assert.equal(label({ tierPrice: null }), 'Varies');
  assert.equal(tierGroupLabel(12, [usd(12)], 'fixed', new Map(), 'USD'), '$12.00 · every game');
  assert.match(tierGroupLabel(5, tiers, 'tiered', new Map(), 'EUR'), /^\$5\.00 \(≈ €[\d.]+\) tier$/);
  // An unpriced base tier with games beside priced ones: no "every game", the step still from the priced ones.
  const varies = { price: null, currency: null, gameCount: 3 };
  assert.equal(tierGroupLabel(5, [usd(5), varies], 'fixed', new Map(), 'USD'), '$5.00 tier');
  assert.equal(
    tierGroupLabel(12, [usd(5), usd(12), varies], 'tiered', new Map(), 'USD'),
    '$12.00 tier · +$7.00 over $5.00',
  );
});

test("tierGroupLabel with a tier's value: what its step buys, against those games' best deals", () => {
  const tiers = [usd(5), usd(12), { ...usd(2), addon: true }];
  const label = (key, value, rangeMax = new Map()) => tierGroupLabel(key, tiers, 'tiered', rangeMax, 'USD', value);
  const v = (fresh, deals, unpriced = 0) => ({ fresh, deals, unpriced });
  assert.equal(label(5, v(3, 9.12)), '$5.00 tier · saves $4.12 · 3 new worth $9.12', 'the first step is its price');
  assert.equal(label(12, v(2, 24.38)), '$12.00 tier · saves $17.38 · +$7.00 for 2 new worth $24.38');
  assert.equal(label(12, v(1, 4.49)), '$12.00 tier · $2.51 cheaper apart · +$7.00 for 1 new worth $4.49');
  assert.equal(label(12, v(1, 7)), '$12.00 tier · same as apart · +$7.00 for 1 new worth $7.00');
  assert.equal(label(12, v(0, 0)), '$12.00 tier · nothing new · +$7.00');
  assert.equal(label(12, v(2, null, 1)), '$12.00 tier · +$7.00 for 2 new · 1 unpriced');
  assert.equal(label(tierGroupKey({ tierPrice: 2, addon: true }), v(1, 3)), '$2.00 add-on · 1 new worth $3.00');
  assert.equal(
    label(5, v(2, 20), new Map([[5, 12]])),
    "$5.00–$12.00 · which tier isn't listed · 2 new worth $20.00",
    'no verdict when the tier is unknown',
  );
  assert.match(
    tierGroupLabel(12, tiers, 'tiered', new Map(), 'EUR', v(2, 24.38)),
    /^\$12\.00 \(≈ €[\d.]+\) tier · saves \$17\.38 \(≈ €[\d.]+\) · \+\$7\.00 for 2 new worth \$24\.38 \(≈ €[\d.]+\)$/,
    "a USD bundle: each figure in the tier's currency, estimated once in the region's",
  );
});

test("tierValues: each group's games not owned, once per ITAD game, summed in the tier's currency", () => {
  const tiers = [usd(5), usd(12), usd(20), { ...usd(2), addon: true }];
  const row = (appid, tierPrice, bestDealPrice, extra = {}) => ({
    appid,
    tierPrice,
    bestDealPrice,
    priceCurrency: 'USD',
    inLibrary: false,
    ...extra,
  });
  const rows = [
    row(1, 5, 3, { inLibrary: true }),
    row(8, 20, 9, { inLibrary: true }), // a tier all owned: nothing new
    row(2, 5, 4),
    row(3, 12, 10, { gid: 'pkg' }),
    row(4, 12, 10, { gid: 'pkg' }), // the same package: its deal counts once
    row(5, 12, null),
    row(6, 2, 1, { addon: true }),
    row(7, null, 2), // Varies: no group value
  ];
  const values = tierValues(rows, tiers, (r) => r.gid ?? r.appid);
  assert.deepEqual(values.get(5), { fresh: 1, unpriced: 0, deals: 4 });
  assert.deepEqual(values.get(12), { fresh: 3, unpriced: 1, deals: null });
  assert.deepEqual(values.get(tierGroupKey({ tierPrice: 2, addon: true })), { fresh: 1, unpriced: 0, deals: 1 });
  assert.deepEqual(values.get(20), { fresh: 0, unpriced: 0, deals: 0 });
  assert.equal(values.size, 4);
  assert.equal(
    sumBestDeals([row(3, 12, 10, { gid: 'pkg' }), row(4, 12, 10, { gid: 'pkg' })], 'USD', (r) => r.gid),
    10,
  );
});

test('savingTier: the cheapest tier holding every new game, the pressed one, or none when unknown', () => {
  const tiers = [usd(5), usd(12), { ...usd(2), addon: true }];
  assert.deepEqual(
    savingTier([{ tierPrice: 5 }, { tierPrice: 5 }], tiers, null),
    usd(5),
    'all new games in the cheapest',
  );
  assert.deepEqual(savingTier([{ tierPrice: 5 }, { tierPrice: 12 }], tiers, null), usd(12));
  assert.deepEqual(savingTier([{ tierPrice: 5 }], tiers, 12), usd(12), 'the pressed tier');
  assert.equal(savingTier([{ tierPrice: 5, tierPriceMax: 12 }], tiers, 5), null, 'may sit past the pressed tier');
  assert.deepEqual(savingTier([{ tierPrice: 5, tierPriceMax: 12 }], tiers, null), usd(12));
  assert.equal(savingTier([], tiers, null), null, 'nothing new');
  assert.equal(savingTier([{ tierPrice: null }], tiers, null), null, 'an unpriced game');
});
