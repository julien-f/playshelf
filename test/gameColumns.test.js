'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerHooks } = require('node:module');

// @vates/data-table-solid touches `window` on load; the helpers gameColumns.ts uses are core's,
// re-exported. Drop once it loads in Node.
registerHooks({
  resolve(specifier, context, next) {
    return next(specifier === '@vates/data-table-solid' ? '@vates/data-table-core' : specifier, context);
  },
});

const {
  endOfReleasePeriod,
  releaseSortTimestamp,
  compareDateMissingLast,
  computePriceStatus,
  computeOwnershipStatus,
  priceTierBucket,
  formatPriceTier,
  scoreBucket,
  halfDecadeBucket,
  withMissingGroup,
  tagMatchScore,
  CORE_COLUMNS,
  IGDB_RATING_COLUMN,
  NOT_ON_STEAM,
  markSteamOnly,
  steamPlatformNames,
  renderNameCell,
} = require('../public/gameColumns.ts');

const { fmtLocalDate, fmtReleaseDate } = require('../public/utils.ts');

const day = (y, m, d) => new Date(y, m - 1, d).getTime();

test('endOfReleasePeriod: anchors a coarse date at the end of its period', () => {
  for (const [input, expected] of [
    ['Spring 2026', day(2026, 6, 20)],
    ['Summer 2026', day(2026, 9, 21)],
    ['Fall 2026', day(2026, 12, 20)],
    ['Autumn 2026', day(2026, 12, 20)],
    ['fall 2026', day(2026, 12, 20)],
    ['Winter 2026', day(2027, 3, 19)], // winter spills into the next year
    ['Q1 2026', day(2026, 3, 31)],
    ['Q2 2026', day(2026, 6, 30)],
    ['Q3 2026', day(2026, 9, 30)],
    ['Q4 2026', day(2026, 12, 31)],
    ['q4 2026', day(2026, 12, 31)],
    ['2026', day(2026, 12, 31) + 1],
    ['2026 or later', day(2026, 12, 31) + 1],
    ['October 2026', day(2026, 10, 31)],
    ['February 2024', day(2024, 2, 29)],
    ['  Q2 2026  ', day(2026, 6, 30)],
    ['Oct 14, 2025', day(2025, 10, 14)],
  ]) {
    assert.equal(endOfReleasePeriod(input), expected, input);
  }
});

// lib/streamEvent.mjs: an ISO date would parse as UTC midnight, the day before west of UTC.
test("endOfReleasePeriod: a game outside Steam's stream date is that local day, shown as it", () => {
  const { igdbStreamEvent } = require('../lib/streamEvent.mjs');
  const game = { name: 'G', genres: [], developers: [], publishers: [], platforms: [] };
  const dateOf = (releaseDate) =>
    igdbStreamEvent('igdb:1', { game: { ...game, releaseDate }, hltb: null }).meta.releaseDate;
  for (const [iso, y, m, d] of [
    ['2024-09-06', 2024, 9, 6],
    ['2005-03-22', 2005, 3, 22],
    ['2025-12-31', 2025, 12, 31],
  ]) {
    assert.equal(endOfReleasePeriod(dateOf(iso)), day(y, m, d), iso);
    assert.equal(fmtReleaseDate(dateOf(iso)), fmtLocalDate(new Date(y, m - 1, d)), iso);
  }
  assert.equal(dateOf(null), null);
});

test('endOfReleasePeriod: placeholders have no date, so range filters and date-tree skip them', () => {
  for (const input of ['Coming soon', 'To be announced', 'TBA', 'nonsense']) {
    assert.ok(Number.isNaN(endOfReleasePeriod(input)), input);
  }
});

test('releaseSortTimestamp: placeholders sort after every date, Coming soon before TBA', () => {
  const expected = [
    'Oct 14, 2026',
    'October 2026',
    'Fall 2026',
    'Q4 2026',
    '2026', // just after Q4 of the same year
    'Winter 2026',
    'Q1 2027',
    '2999',
    'Coming soon',
    'TBA',
  ];
  const sorted = [...expected].reverse().sort((a, b) => releaseSortTimestamp(a) - releaseSortTimestamp(b));
  assert.deepEqual(sorted, expected);
});

test('releaseSortTimestamp: placeholder spellings and plain dates', () => {
  assert.equal(releaseSortTimestamp('coming soon'), releaseSortTimestamp('Coming soon'));
  assert.equal(releaseSortTimestamp('To be announced'), releaseSortTimestamp('TBA'));
  assert.equal(releaseSortTimestamp(' tba '), releaseSortTimestamp('TBA'));
  assert.equal(releaseSortTimestamp('Q3 2026'), day(2026, 9, 30));
  assert.ok(Number.isNaN(releaseSortTimestamp('nonsense')));
});

test('compareDateMissingLast: dated, then placeholders, then missing, the same on a repeat sort', () => {
  const dated = ['Oct 14, 2026', 'Q4 2026', '2026', 'Coming soon', 'TBA'];
  const input = [null, 'TBA', 'nonsense', '2026', '', 'Oct 14, 2026', 'Coming soon', 'Q4 2026'];
  for (let i = 0; i < 2; i++) {
    const asc = [...input].sort((a, b) => compareDateMissingLast(a, b, 'asc'));
    assert.deepEqual(asc.slice(0, 5), dated);
    const desc = [...input].sort((a, b) => -compareDateMissingLast(a, b, 'desc')); // the table flips the sign for desc
    assert.deepEqual(desc.slice(0, 5), [...dated].reverse());
    for (const sorted of [asc, desc]) assert.deepEqual(new Set(sorted.slice(5)), new Set([null, '', 'nonsense']));
  }
});

test('compareDateMissingLast: still in date order past more distinct dates than its memo keeps', () => {
  const days = Array.from({ length: 12_000 }, (_, i) => fmtLocalDate(new Date(2000, 0, 1 + i)));
  const sorted = [...days].reverse().sort((a, b) => compareDateMissingLast(a, b, 'asc'));
  assert.deepEqual(sorted, days);
});

test('computePriceStatus: loading, no data, record tiers, sale, full price', () => {
  for (const [name, row, expected] of [
    ['still loading', {}, undefined],
    ['no price data', { bestDealPrice: null }, null],
    ['at the all-time low', { bestDealPrice: 10, lowAll: 10, lowY1: 10, lowM3: 10, bestDealCut: 50 }, 'All-Time Low'],
    ['below the all-time low', { bestDealPrice: 9, lowAll: 10, bestDealCut: 50 }, 'All-Time Low'],
    ['1-year low', { bestDealPrice: 10, lowAll: 5, lowY1: 10, lowM3: 10, bestDealCut: 50 }, '1-Year Low'],
    ['3-month low', { bestDealPrice: 10, lowAll: 5, lowY1: 8, lowM3: 10, bestDealCut: 50 }, '3-Month Low'],
    ['discounted, not a low', { bestDealPrice: 10, lowAll: 5, lowY1: 8, lowM3: 9, bestDealCut: 25 }, 'On Sale'],
    ['confirmed full price', { bestDealPrice: 20, lowAll: 5, bestDealCut: 0 }, 'Not Discounted'],
    ['full price that is also the low', { bestDealPrice: 20, lowAll: 20, lowM3: 20, bestDealCut: 0 }, 'Not Discounted'],
    ['no discount data', { bestDealPrice: 20, lowAll: 5, bestDealCut: null }, null],
  ]) {
    assert.equal(computePriceStatus(row), expected, name);
  }
});

test('computeOwnershipStatus: unknown vs. each combination', () => {
  for (const [row, expected] of [
    [{}, null],
    [{ inLibrary: null, onWishlist: null }, null],
    [{ inLibrary: false, onWishlist: false }, 'Not Owned'],
    [{ inLibrary: true, onWishlist: false }, 'Owned'],
    [{ inLibrary: false, onWishlist: true }, 'Wishlisted'],
    [{ inLibrary: true, onWishlist: true }, 'Owned & Wishlisted'],
    [{ inLibrary: null, onWishlist: false }, null],
    [{ inLibrary: null, onWishlist: true }, 'Wishlisted'],
    [{ inLibrary: false, onWishlist: null }, 'Not Owned'],
  ]) {
    assert.equal(computeOwnershipStatus(row), expected, JSON.stringify(row));
  }
});

test("priceTierBucket: Steam's price tiers, Free apart from cheap", () => {
  for (const [input, expected] of [
    [0, -1],
    [0.01, 0],
    [4.99, 0],
    [5, 5],
    [14.99, 5],
    [15, 15],
    [29.99, 15],
    [30, 30],
    [49.99, 30],
    [50, 50],
    [74.99, 50],
    [75, 75],
    [99.99, 75],
    [100, 100],
    [500, 100],
    [-1, null],
    [NaN, null],
    [undefined, null],
  ]) {
    assert.equal(priceTierBucket(input), expected, String(input));
  }
  assert.equal(withMissingGroup(priceTierBucket)(null), null, 'a missing price is not Free');
});

test('priceTierBucket: a currency far from dollar scale is bucketed in USD, a near one as is', () => {
  assert.equal(priceTierBucket(1980, 'JPY'), '$5', '¥1,980 is about $13');
  assert.equal(formatPriceTier('$5'), '$5–$15');
  assert.equal(formatPriceTier('$100'), '$100+');
  assert.equal(priceTierBucket(0, 'JPY'), -1, 'Free stays Free');
  assert.equal(priceTierBucket(4.99, 'EUR'), 0, 'a near currency keeps its .99 tier');
  assert.equal(priceTierBucket(14.99, 'GBP'), 5);
  assert.equal(priceTierBucket(1980, 'XYZ'), 100, 'an unknown currency is bucketed as is');
  const byRow = withMissingGroup((v, row) => priceTierBucket(v, row.priceCurrency));
  assert.equal(byRow(1980, { priceCurrency: 'JPY' }), '$5');
  assert.equal(byRow(null, { priceCurrency: 'JPY' }), null);
});

test('scoreBucket: 5-point steps from 60, one bucket below, 100 folded into 95', () => {
  for (const [input, expected] of [
    [0, -1],
    [59.99, -1],
    [NaN, -1],
    [60, 60],
    [64.9, 60],
    [65, 65],
    [94.99, 90],
    [95, 95],
    [99.6, 95],
    [100, 95],
  ]) {
    assert.equal(scoreBucket(input), expected, String(input));
  }
});

test('halfDecadeBucket: 1-3-10 log steps, zero apart from below one', () => {
  for (const [input, expected] of [
    [0, 0],
    [0.5, 0.5],
    [1, 1],
    [2.9, 1],
    [3, 3],
    [9.9, 3],
    [10, 10],
    [29, 10],
    [30, 30],
    [99, 30],
    [100, 100],
    [2_500_000, 1_000_000],
  ]) {
    assert.equal(halfDecadeBucket(input), expected, String(input));
  }
  assert.equal(withMissingGroup(halfDecadeBucket)(null), null, 'a failed fetch is not zero');
});

test('Released year grouping: "Coming soon"/"TBA" keep their own groups, no date in "—"', () => {
  const col = CORE_COLUMNS.find((c) => c.key === 'releaseDate');
  const label = (v) => {
    const key = col.groupValue(v);
    return col.groupFormat(key == null ? '' : String(key));
  };
  assert.equal(label('Fall 2026'), '2026');
  assert.equal(label('Coming soon'), 'Coming soon');
  assert.equal(label('To be announced'), 'To be announced');
  assert.equal(label(null), '—');
});

test("tagMatchScore: averages the filtered tags' relative weights, an absent tag counting 0", () => {
  const weights = { Roguelike: 1, Action: 0.5, Indie: null };
  assert.equal(tagMatchScore(weights, new Set(['Roguelike'])), 100);
  assert.equal(tagMatchScore(weights, new Set(['Roguelike', 'Action'])), 75);
  assert.equal(tagMatchScore(weights, new Set(['Action', 'Co-op'])), 25);
  assert.equal(tagMatchScore(weights, new Set(['Indie'])), 0);
});

test("tagMatchScore: with the filter's All mode, the weakest filtered tag sets the score", () => {
  const weights = { Roguelike: 1, Action: 0.5 };
  assert.equal(tagMatchScore(weights, new Set(['Roguelike', 'Action']), true), 50);
  assert.equal(tagMatchScore(weights, new Set(['Roguelike', 'Co-op']), true), 0);
});

test('tagMatchScore: no score without a tag filter or tag weights', () => {
  assert.equal(tagMatchScore({ Action: 1 }, undefined), null);
  assert.equal(tagMatchScore({ Action: 1 }, new Set()), null);
  assert.equal(tagMatchScore(null, new Set(['Action'])), null);
});

// Enough DOM for a cell's render: elements with text, class, title and children.
function withDom(fn) {
  const node = (text = '') => ({
    textContent: text,
    className: '',
    title: '',
    style: {},
    children: [],
    append(...kids) {
      this.children.push(...kids);
    },
    appendChild(kid) {
      this.children.push(kid);
    },
  });
  globalThis.document = { createElement: () => node(), createTextNode: (text) => node(text) };
  try {
    return fn();
  } finally {
    delete globalThis.document;
  }
}

const IGDB_ROW = { appid: 'igdb:9001', name: 'Console Quest', source: 'igdb', steamdbRating: 0, genres: ['Adventure'] };
const steamOnly = (key) => markSteamOnly(CORE_COLUMNS).find((c) => c.key === key);

test('markSteamOnly: a game outside Steam reads "Not on Steam" in a Steam-only column, shown as n/a', () => {
  const col = steamOnly('steamdbRating');
  assert.equal(col.value(IGDB_ROW), NOT_ON_STEAM);
  assert.equal(col.value({ appid: 620, steamdbRating: 91 }), 91);
  assert.equal(col.format(NOT_ON_STEAM), NOT_ON_STEAM, 'its checklist entry and group label');
  const cell = withDom(() => col.render(col.value(IGDB_ROW), IGDB_ROW));
  assert.equal(cell.textContent, 'n/a');
  assert.equal(cell.className, 'cell-na');
  assert.equal(cell.title, "Steam only — this game isn't on Steam");
  assert.equal(steamOnly('genres').value(IGDB_ROW), NOT_ON_STEAM, "IGDB's genres aren't Steam's");
  for (const key of ['hltbAll', 'releaseDate', 'developers', 'platforms'])
    assert.equal(
      steamOnly(key),
      CORE_COLUMNS.find((c) => c.key === key),
      key,
    );
});

test('markSteamOnly: a game outside Steam sorts last both ways, after missing data, and groups last', () => {
  for (const key of ['steamdbRating', 'reviewsTotal', 'hasDemo', 'genres']) {
    const { compare } = steamOnly(key);
    for (const dir of ['asc', 'desc']) {
      const sign = dir === 'asc' ? 1 : -1;
      for (const other of [null, 1, true, 'Action'])
        assert.ok(sign * compare(NOT_ON_STEAM, other, dir) > 0, `${key} ${dir} ${other}`);
      assert.equal(compare(NOT_ON_STEAM, NOT_ON_STEAM, dir), 0);
    }
  }
  const { compare, groupValue, groupFormat } = steamOnly('steamdbRating');
  assert.ok(compare(null, 90, 'desc') * -1 > 0, 'missing data still after a score');
  assert.equal(groupValue(NOT_ON_STEAM, IGDB_ROW), NOT_ON_STEAM);
  assert.equal(groupFormat(NOT_ON_STEAM), NOT_ON_STEAM);
  assert.equal(groupFormat(''), '—', 'a Steam game with no rating keeps its own group');
});

test("A game outside Steam's failed IGDB fields show ⚠ naming IGDB", () => {
  const row = { ...IGDB_ROW, developers: [], failedSources: ['igdb', 'hltb'] };
  const col = CORE_COLUMNS.find((c) => c.key === 'developers');
  const cell = withDom(() => col.render([], row));
  assert.equal(cell.textContent, '⚠');
  assert.match(cell.title, /^IGDB didn't answer/);
  const steam = withDom(() => col.render([], { appid: 620, developers: [], failedSources: ['igdb'] }));
  assert.notEqual(steam.textContent, '⚠');
});

test('IGDB Rating: a score out of 100, as the panel reads it; a Steam game has none', () => {
  const rated = { ...IGDB_ROW, igdbRating: { score: 84, count: 120 } };
  assert.equal(IGDB_RATING_COLUMN.value(rated), 84);
  assert.equal(withDom(() => IGDB_RATING_COLUMN.render(84, rated)).textContent, '84/100');
  assert.equal(IGDB_RATING_COLUMN.value({ appid: 620 }), null);
  assert.equal(withDom(() => IGDB_RATING_COLUMN.render(null, { appid: 620 })).textContent, '—');
});

test('A game outside Steam: its platforms in Steam\'s words, under its name with "Not on Steam"', () => {
  assert.deepEqual(steamPlatformNames(['PC', 'Mac', 'Linux', 'PS5']), ['Windows', 'Mac', 'Linux', 'PS5']);
  const row = { ...IGDB_ROW, platforms: ['PS5', 'Switch', 'Windows', 'Xbox Series X|S'] };
  const cell = withDom(() => renderNameCell('Console Quest', row));
  assert.deepEqual(
    cell.children.map((c) => c.textContent),
    ['Console Quest', 'Not on Steam · PS5 · Switch +2'],
  );
});
