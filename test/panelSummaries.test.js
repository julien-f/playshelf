'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ratingSummary,
  linuxDeckSummary,
  toBeatSummary,
  achievementsSummary,
  priceSummary,
  dlcSummary,
  ownedBySummary,
  aboutSummary,
  tagsSummary,
  similarSummary,
  newsSummary,
  fmtCompactCount,
  protonTierColor,
} = require('../public/panelSummaries.ts');
const {
  formatMoney,
  scoreColor,
  computeSteamdbRating,
  fmtReleaseDate,
  DEAL_RECORD_TIERS,
} = require('../public/utils.ts');
const { fmtDatePart } = require('../public/dateTime.ts');
const { PRICES_UNAVAILABLE } = require('../public/priceLoading.ts');

const FAILED = { kind: 'figure', state: 'failed', fig: '⚠', qualifier: "didn't answer", tone: 'var(--warn)' };
const FAILED_TEXT = { kind: 'text', state: 'failed', text: "didn't answer", tone: 'var(--warn)' };

// A game whose details are in; `details` and the source lists override.
const game = ({ details = {}, ...rest } = {}) => ({
  name: 'Game',
  loading: false,
  pendingSources: [],
  failedSources: [],
  ...rest,
  details: { rating: null, hltb: null, meta: null, basics: null, tags: null, protondb: null, ...details },
});
const meta = (fields = {}) => ({ genres: [], categories: [], developers: [], publishers: [], dlc: [], ...fields });

test('fmtCompactCount: plain, thousands, millions', () => {
  assert.equal(fmtCompactCount(999), '999');
  assert.equal(fmtCompactCount(250_400), '250k');
  assert.equal(fmtCompactCount(2_100_000), '2.1m');
});

test('fmtCompactCount: a count that rounds to 1000k reads as 1m', () => {
  assert.equal(fmtCompactCount(999_499), '999k');
  assert.equal(fmtCompactCount(999_500), '1m');
  assert.equal(fmtCompactCount(999_999), '1m');
});

test('ratingSummary: the Weighted Rating in its score colour, over what it is and the review count', () => {
  const rating = { score: 9, desc: '', positive: 240_000, total: 250_000 };
  const steamdb = Math.round(computeSteamdbRating(240_000, 250_000));
  assert.deepEqual(ratingSummary(game({ details: { rating } })), {
    kind: 'figure',
    state: 'ready',
    fig: String(steamdb),
    qualifier: 'Weighted · 250k reviews',
    tone: scoreColor(steamdb),
  });
});

test('ratingSummary: loading, failed, empty', () => {
  assert.deepEqual(ratingSummary(game({ loading: true })), { kind: 'figure', state: 'loading' });
  assert.deepEqual(ratingSummary(game({ pendingSources: ['rating'] })), { kind: 'figure', state: 'loading' });
  assert.deepEqual(ratingSummary(game({ failedSources: ['rating'] })), FAILED);
  assert.deepEqual(ratingSummary(game()), { kind: 'figure', state: 'empty', qualifier: 'no rating' });
});

test('linuxDeckSummary: the ProtonDB tier in its colour, over the report count', () => {
  const protondb = { tier: 'gold', confidence: 'strong', total: 100 };
  assert.deepEqual(linuxDeckSummary(game({ details: { protondb } })), {
    kind: 'figure',
    state: 'ready',
    fig: 'Gold',
    qualifier: '100 reports',
    tone: protonTierColor('gold'),
  });
});

test('linuxDeckSummary: a provisional tier says so; an unknown count is left out', () => {
  const protondb = { tier: 'silver', confidence: null, total: null, pending: true };
  assert.deepEqual(linuxDeckSummary(game({ details: { protondb } })), {
    kind: 'figure',
    state: 'ready',
    fig: 'Silver ?',
    qualifier: 'provisional',
    tone: protonTierColor('silver'),
  });
});

test('one report or review reads singular', () => {
  const protondb = { tier: 'platinum', confidence: null, total: 1, pending: true };
  assert.equal(linuxDeckSummary(game({ details: { protondb } })).qualifier, '1 report · provisional');
  assert.equal(
    ratingSummary(game({ details: { rating: { positive: 1, total: 1 } } })).qualifier,
    'Weighted · 1 review',
  );
});

test('linuxDeckSummary: loading, failed, empty', () => {
  assert.deepEqual(linuxDeckSummary(game({ pendingSources: ['protondb'] })), { kind: 'figure', state: 'loading' });
  assert.deepEqual(linuxDeckSummary(game({ failedSources: ['protondb'] })), FAILED);
  assert.deepEqual(linuxDeckSummary(game()), { kind: 'figure', state: 'empty', qualifier: 'no reports' });
});

test('protonTierColor: a tier without a colour of its own gets the unknown one', () => {
  assert.match(protonTierColor('gold'), /var\(--tier-gold\)/);
  assert.match(protonTierColor('mythril'), /var\(--line-strong\)/);
});

const hltb = (fields) => ({ id: 1, main: null, extra: null, completionist: null, all: null, ...fields });

test('toBeatSummary: main story, with the completionist time', () => {
  const details = { hltb: hltb({ main: 26.7, completionist: 66.8, all: 30 }) };
  assert.deepEqual(toBeatSummary(game({ details })), {
    kind: 'figure',
    state: 'ready',
    fig: '26.7 h',
    qualifier: 'main · 66.8 h for 100%',
  });
});

test('toBeatSummary: main story alone', () => {
  assert.deepEqual(toBeatSummary(game({ details: { hltb: hltb({ main: 12 }) } })), {
    kind: 'figure',
    state: 'ready',
    fig: '12 h',
    qualifier: 'main',
  });
});

test('toBeatSummary: only All PlayStyles known', () => {
  assert.deepEqual(toBeatSummary(game({ details: { hltb: hltb({ all: 3 }) } })), {
    kind: 'figure',
    state: 'ready',
    fig: '3 h',
    qualifier: 'all playstyles',
  });
});

test('toBeatSummary: loading, failed, empty (no match, or a match with no times)', () => {
  assert.deepEqual(toBeatSummary(game({ pendingSources: ['hltb'] })), { kind: 'figure', state: 'loading' });
  assert.deepEqual(toBeatSummary(game({ failedSources: ['hltb'] })), FAILED);
  const empty = { kind: 'figure', state: 'empty', qualifier: 'no times' };
  assert.deepEqual(toBeatSummary(game()), empty);
  assert.deepEqual(toBeatSummary(game({ details: { hltb: hltb({}) } })), empty);
});

const achievements = (fields) => ({
  achievements: [],
  total: 2,
  unlocked: 1,
  private: false,
  playerCount: 1,
  steamUrl: null,
  ...fields,
});

test("achievementsSummary: one player's progress, with a bar", () => {
  assert.deepEqual(achievementsSummary(achievements(), 'Alice'), {
    kind: 'figure',
    state: 'ready',
    fig: '1 / 2',
    qualifier: 'Alice',
    tone: scoreColor(50),
    bar: 0.5,
  });
});

test("achievementsSummary: several players' progress is what any of them unlocked", () => {
  const s = achievementsSummary(achievements({ playerCount: 2, unlocked: 2 }), 'Alice + Bob');
  assert.equal(s.fig, '2 / 2');
  assert.equal(s.qualifier, 'Alice + Bob combined');
  assert.equal(s.bar, 1);
});

test('achievementsSummary: no player is the count alone, no bar', () => {
  assert.deepEqual(achievementsSummary(achievements({ playerCount: 0, unlocked: 0 }), null), {
    kind: 'figure',
    state: 'ready',
    fig: '2',
    qualifier: 'achievements',
  });
});

test('achievementsSummary: a private profile is the count, saying progress is private', () => {
  assert.deepEqual(achievementsSummary(achievements({ private: true, unlocked: 0 }), 'Alice'), {
    kind: 'figure',
    state: 'ready',
    fig: '2',
    qualifier: 'progress private',
  });
});

test('achievementsSummary: loading, failed, empty', () => {
  assert.deepEqual(achievementsSummary(undefined, 'Alice'), { kind: 'figure', state: 'loading' });
  assert.deepEqual(achievementsSummary(null, 'Alice'), FAILED);
  assert.deepEqual(achievementsSummary(achievements({ total: 0, unlocked: 0 }), 'Alice'), {
    kind: 'figure',
    state: 'empty',
    qualifier: 'no achievements',
  });
});

const price = (fields) => ({
  bestDealPrice: 4.99,
  bestDealCut: 75,
  steamRegular: 19.99,
  priceCurrency: 'USD',
  lowAll: 2.99,
  lowY1: 4.99,
  lowM3: 4.99,
  ...fields,
});
const offers = (fields) => ({ bundles: [], subscriptions: [], ...fields });

test('priceSummary: the Best Deal with its record glyph and colour, its discount and bundles', () => {
  const oneYear = DEAL_RECORD_TIERS[1];
  const bundles = [{ id: 1 }, { id: 2 }];
  assert.deepEqual(priceSummary(price(), offers({ bundles }), false), {
    kind: 'figure',
    state: 'ready',
    fig: `${formatMoney(4.99, 'USD')} ${oneYear.icon}`,
    qualifier: '-75% · 2 bundles',
    tone: oneYear.color,
  });
});

test('priceSummary: no record, no discount, one bundle', () => {
  const p = price({ bestDealPrice: 19.99, bestDealCut: 0, lowAll: 9.99, lowY1: 9.99, lowM3: 9.99 });
  assert.deepEqual(priceSummary(p, offers({ bundles: [{ id: 1 }] }), false), {
    kind: 'figure',
    state: 'ready',
    fig: formatMoney(19.99, 'USD'),
    qualifier: '1 bundle',
  });
});

test('priceSummary: offers still loading or failed leave the price line alone', () => {
  assert.equal(priceSummary(price(), undefined, false).qualifier, '-75%');
  assert.equal(priceSummary(price(), null, false).qualifier, '-75%');
  assert.equal(priceSummary(price(), offers({ subscriptions: null }), false).qualifier, '-75%');
});

test('priceSummary: a subscription leads, with its leaving date', () => {
  const subscriptions = [{ id: 1, name: 'Game Pass', leaving: '2026-12-31T12:00:00Z' }];
  assert.equal(
    priceSummary(price(), offers({ subscriptions }), false).qualifier,
    `in Game Pass until ${fmtDatePart('2026-12-31T12:00:00Z')} · -75%`,
  );
  const staying = [{ id: 1, name: 'Game Pass', leaving: null }];
  assert.equal(priceSummary(price(), offers({ subscriptions: staying }), false).qualifier, 'in Game Pass · -75%');
});

test('priceSummary: no price but a subscription or bundle is still an answer', () => {
  const subscriptions = [{ id: 1, name: 'Game Pass', leaving: null }];
  assert.deepEqual(priceSummary(price({ bestDealPrice: null }), offers({ subscriptions }), false), {
    kind: 'figure',
    state: 'ready',
    fig: '—',
    qualifier: 'in Game Pass',
  });
});

test('priceSummary: loading, failed, empty, IsThereAnyDeal not connected', () => {
  assert.deepEqual(priceSummary(undefined, undefined, false), { kind: 'figure', state: 'loading' });
  assert.deepEqual(priceSummary(null, offers(), false), FAILED);
  assert.deepEqual(priceSummary(price({ bestDealPrice: null, pricesFailed: true }), offers(), false), FAILED);
  assert.deepEqual(priceSummary(price({ bestDealPrice: null }), offers(), false), {
    kind: 'figure',
    state: 'empty',
    qualifier: 'no price',
  });
  // Its whole reason: the card can't open to say more.
  assert.deepEqual(priceSummary(null, null, true), { kind: 'figure', state: 'empty', qualifier: PRICES_UNAVAILABLE });
});

const dlcEntry = (appid, releaseDate, comingSoon = false) => ({
  appid,
  name: `D${appid}`,
  capsule: '',
  releaseDate,
  comingSoon,
});

test('dlcSummary: the count, without a qualifier until every entry is known', () => {
  const g = game({ details: { meta: meta({ dlc: [1, 2, 3] }) } });
  const ready = { kind: 'figure', state: 'ready', fig: '3' };
  assert.deepEqual(dlcSummary(g, undefined), ready);
  assert.deepEqual(dlcSummary(g, null), ready);
  assert.deepEqual(dlcSummary(g, [dlcEntry(1, '1 Jan, 2020'), dlcEntry(2, '2 Feb, 2021')]), ready);
});

test('dlcSummary: every entry known names the latest released one', () => {
  const g = game({ details: { meta: meta({ dlc: [1, 2, 3] }) } });
  const entries = [dlcEntry(1, '1 Jan, 2020'), dlcEntry(2, '2 Feb, 2021'), dlcEntry(3, 'Coming soon', true)];
  assert.deepEqual(dlcSummary(g, entries), {
    kind: 'figure',
    state: 'ready',
    fig: '3',
    qualifier: `latest ${fmtReleaseDate('2 Feb, 2021')}`,
  });
});

test('dlcSummary: loading, failed, empty', () => {
  assert.deepEqual(dlcSummary(game({ pendingSources: ['meta'] }), undefined), { kind: 'figure', state: 'loading' });
  assert.deepEqual(dlcSummary(game({ failedSources: ['meta'] }), undefined), FAILED);
  assert.deepEqual(dlcSummary(game({ details: { meta: meta() } }), undefined), {
    kind: 'figure',
    state: 'empty',
    qualifier: 'no DLC',
  });
});

const owner = (name, minutes) => ({ name, minutes, lastPlayedSec: 0, recentMinutes: 0 });

test('ownedBySummary: one owner is their name and hours', () => {
  const ready = { kind: 'figure', state: 'ready', fig: 'Alice', qualifier: '45m' };
  assert.deepEqual(ownedBySummary([owner('Alice', 45)], ['Alice']), ready);
  assert.deepEqual(ownedBySummary([owner('Alice', 45)], ['Alice', 'Bob', 'Carol']), ready);
  assert.equal(ownedBySummary([owner('Alice', 0)], ['Alice']).qualifier, 'not played');
});

test('ownedBySummary: several owners count against the members, naming who lacks it', () => {
  const owners = [owner('Alice', 60), owner('Carol', 0), owner('Dan', 5)];
  assert.deepEqual(ownedBySummary(owners, ['Alice', 'Bob', 'Carol', 'Dan']), {
    kind: 'figure',
    state: 'ready',
    fig: '3 / 4',
    qualifier: 'not Bob',
  });
  assert.equal(ownedBySummary(owners, ['Alice', 'Carol', 'Dan']).qualifier, 'everyone');
});

test('ownedBySummary: nobody owns it', () => {
  assert.deepEqual(ownedBySummary([], ['Alice']), { kind: 'figure', state: 'empty', qualifier: 'not owned' });
  assert.deepEqual(ownedBySummary([], ['Alice', 'Bob', 'Carol', 'Dan']), {
    kind: 'figure',
    state: 'empty',
    fig: '0 / 4',
    qualifier: 'not owned',
  });
});

test('ownedBySummary: loading', () => {
  assert.deepEqual(ownedBySummary(undefined, ['Alice']), { kind: 'figure', state: 'loading' });
});

// The browser decodes through DOMParser; this stand-in covers the one entity the tests use.
const decode = (s) => s.replace(/&amp;/g, '&');

test("aboutSummary: the description's first line, decoded", () => {
  const description = 'Dungeons &amp; Dragons, reborn.\nSecond line.';
  assert.deepEqual(aboutSummary(game({ details: { meta: meta({ description }) } }), decode), {
    kind: 'text',
    state: 'ready',
    text: 'Dungeons & Dragons, reborn.',
  });
});

test("aboutSummary: the browse item's description while the store part is coming", () => {
  const g = game({ pendingSources: ['meta'], details: { basics: { description: 'Fast.' } } });
  assert.deepEqual(aboutSummary(g, decode), { kind: 'text', state: 'ready', text: 'Fast.' });
});

test('aboutSummary: no store page, loading, failed, empty', () => {
  assert.deepEqual(aboutSummary(game(), decode), { kind: 'text', state: 'empty', text: 'Delisted: no description' });
  assert.deepEqual(aboutSummary(game({ loading: true }), decode), { kind: 'text', state: 'loading' });
  assert.deepEqual(aboutSummary(game({ pendingSources: ['meta'] }), decode), { kind: 'text', state: 'loading' });
  assert.deepEqual(aboutSummary(game({ failedSources: ['meta'] }), decode), FAILED_TEXT);
  assert.deepEqual(aboutSummary(game({ details: { meta: meta({ description: null }) } }), decode), {
    kind: 'text',
    state: 'empty',
    text: 'no description',
  });
});

test('tagsSummary: the top tag, then the genres, each once', () => {
  const g = game({ details: { tags: ['Action', 'RPG', 'Indie'], meta: meta({ genres: ['Action', 'Adventure'] }) } });
  assert.deepEqual(tagsSummary(g), { kind: 'text', state: 'ready', text: 'Action · Adventure' });
});

test('tagsSummary: the top tag alone while genres are coming; features when nothing else', () => {
  const pending = game({ pendingSources: ['meta'], details: { tags: ['Puzzle'] } });
  assert.deepEqual(tagsSummary(pending), { kind: 'text', state: 'ready', text: 'Puzzle' });
  const featuresOnly = game({ details: { meta: meta({ categories: ['Single-player', 'Steam Cloud'] }) } });
  assert.deepEqual(tagsSummary(featuresOnly), { kind: 'text', state: 'ready', text: 'Single-player · Steam Cloud' });
});

test('tagsSummary: loading, failed, empty', () => {
  assert.deepEqual(tagsSummary(game({ pendingSources: ['tags', 'meta'] })), { kind: 'text', state: 'loading' });
  assert.deepEqual(tagsSummary(game({ failedSources: ['tags', 'meta'] })), FAILED_TEXT);
  assert.deepEqual(tagsSummary(game({ details: { tags: [], meta: meta() } })), {
    kind: 'text',
    state: 'empty',
    text: 'no tags',
  });
});

test("similarSummary: the closest owned games when the account's taste is cached", () => {
  const g = game({ details: { tags: ['RPG'], meta: meta() } });
  assert.deepEqual(similarSummary(g, { closest: ['Alpha', 'Beta'], account: 'Alice' }), {
    kind: 'text',
    state: 'ready',
    text: 'Alpha, Beta',
  });
  assert.deepEqual(similarSummary(g, { closest: [], account: 'Alice' }), {
    kind: 'text',
    state: 'ready',
    text: 'No close match in this library',
  });
});

test("similarSummary: names the Owned list it needs when the taste isn't cached", () => {
  const g = game({ details: { tags: ['RPG'], meta: meta() } });
  assert.deepEqual(similarSummary(g, { closest: null, account: 'Alice' }), {
    kind: 'text',
    state: 'ready',
    text: "needs Alice's Owned list",
  });
});

test('similarSummary: on Owned or with no account, the publisher if it differs from the developer', () => {
  const other = game({ details: { meta: meta({ developers: ['Studio'], publishers: ['Big Pub'] }) } });
  const same = game({ details: { meta: meta({ developers: ['Studio'], publishers: ['Studio'] }) } });
  const none = game({ details: { meta: meta() } });
  assert.deepEqual(similarSummary(other, { closest: undefined, account: null }), {
    kind: 'text',
    state: 'ready',
    text: 'More from Big Pub',
  });
  const steam = { kind: 'text', state: 'ready', text: 'More like this on Steam' };
  assert.deepEqual(similarSummary(same, { closest: undefined, account: null }), steam);
  assert.deepEqual(similarSummary(none, { closest: undefined, account: null }), steam);
});

test('similarSummary: loading', () => {
  assert.deepEqual(similarSummary(game({ loading: true }), { closest: undefined, account: null }), {
    kind: 'text',
    state: 'loading',
  });
});

test("newsSummary: the latest post's date and title", () => {
  const news = [
    { title: 'Patch 2', url: '', date: 1_767_225_600, feedLabel: null },
    { title: 'Patch 1', url: '', date: 1_764_547_200, feedLabel: null },
  ];
  assert.deepEqual(newsSummary(news), { kind: 'text', state: 'ready', text: '2026-01-01 · Patch 2' });
});

test('newsSummary: no official posts is no card; loading, failed', () => {
  assert.equal(newsSummary([]), null);
  assert.deepEqual(newsSummary(undefined), { kind: 'text', state: 'loading' });
  assert.deepEqual(newsSummary(null), FAILED_TEXT);
});
