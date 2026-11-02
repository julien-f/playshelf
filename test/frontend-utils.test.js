'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeInput,
  steamVanity,
  safeHref,
  scoreColor,
  fmtH,
  fmtTime,
  fmtPlaytime,
  fmtLastPlayed,
  fmtLocalDate,
  fmtReleaseDate,
  countryFlag,
  esc,
  computeSteamdbRating,
  computeProductionTier,
  dealRecordTier,
  fmtAge,
  oldestFetchedAt,
  isTextEntry,
  detailsPending,
  mediaPending,
  noStorePage,
  steamAppAsset,
} = require('../public/utils.ts');

// ── normalizeInput ────────────────────────────────────────────────────────────

test('normalizeInput: returns plain usernames unchanged', () => {
  assert.equal(normalizeInput('gaben'), 'gaben');
});

test('normalizeInput: extracts username from /id/ URL', () => {
  assert.equal(normalizeInput('https://steamcommunity.com/id/gaben/'), 'gaben');
});

test('normalizeInput: extracts username from /id/ URL without protocol', () => {
  assert.equal(normalizeInput('steamcommunity.com/id/gaben'), 'gaben');
});

test('normalizeInput: extracts 64-bit ID from /profiles/ URL', () => {
  assert.equal(normalizeInput('https://steamcommunity.com/profiles/76561198000000001'), '76561198000000001');
});

test('normalizeInput: returns non-Steam URLs unchanged', () => {
  const url = 'https://store.steampowered.com/app/400';
  assert.equal(normalizeInput(url), url);
});

test('normalizeInput: returns plain Steam64 ID unchanged', () => {
  assert.equal(normalizeInput('76561198000000001'), '76561198000000001');
});

// ── steamVanity ───────────────────────────────────────────────────────────────

test('steamVanity: extracts the custom-URL name from a /id/ profile URL', () => {
  assert.equal(steamVanity('https://steamcommunity.com/id/gaben/'), 'gaben');
});

test('steamVanity: a /profiles/<steam64> URL means no custom name was ever set', () => {
  assert.equal(steamVanity('https://steamcommunity.com/profiles/76561198000000001'), null);
});

test('steamVanity: no profile URL at all (a profile Steam knew nothing about) is null', () => {
  assert.equal(steamVanity(''), null);
  assert.equal(steamVanity(undefined), null);
});

// ── safeHref ──────────────────────────────────────────────────────────────────

test('safeHref: keeps an http(s) URL, turns anything else (javascript:, data:, missing) into ""', () => {
  assert.equal(safeHref('https://store.steampowered.com/'), 'https://store.steampowered.com/');
  assert.equal(safeHref('HTTP://x/'), 'HTTP://x/');
  assert.equal(safeHref('javascript:alert(1)'), '');
  assert.equal(safeHref('data:text/html,x'), '');
  assert.equal(safeHref(null), '');
  assert.equal(safeHref(undefined), '');
});

// ── scoreColor ────────────────────────────────────────────────────────────────

test('scoreColor: returns muted color for null', () => {
  assert.equal(scoreColor(null), 'var(--muted)');
});

test('scoreColor: returns muted color for undefined', () => {
  assert.equal(scoreColor(undefined), 'var(--muted)');
});

test('scoreColor: 80 returns good (top tier)', () => {
  assert.equal(scoreColor(80), 'var(--good)');
  assert.equal(scoreColor(100), 'var(--good)');
});

test('scoreColor: 79 returns body text (second tier)', () => {
  assert.equal(scoreColor(79), 'var(--text-body)');
  assert.equal(scoreColor(65), 'var(--text-body)');
});

test('scoreColor: 64 returns warn (third tier)', () => {
  assert.equal(scoreColor(64), 'var(--warn)');
  assert.equal(scoreColor(50), 'var(--warn)');
});

test('scoreColor: 49 returns bad (bottom tier)', () => {
  assert.equal(scoreColor(49), 'var(--bad)');
  assert.equal(scoreColor(0), 'var(--bad)');
});

// ── fmtH ─────────────────────────────────────────────────────────────────────

test('fmtH: formats integer hours without decimal', () => {
  assert.equal(fmtH(10), '10h');
});

test('fmtH: formats float that is a whole number without decimal', () => {
  assert.equal(fmtH(10.0), '10h');
});

test('fmtH: formats non-integer hours to one decimal place', () => {
  assert.equal(fmtH(10.5), '10.5h');
  assert.equal(fmtH(1.25), '1.3h');
});

// ── esc ───────────────────────────────────────────────────────────────────────

test('esc: passes safe strings through unchanged', () => {
  assert.equal(esc('hello world'), 'hello world');
});

test('esc: encodes ampersands', () => {
  assert.equal(esc('a & b'), 'a &amp; b');
});

test('esc: encodes angle brackets', () => {
  assert.equal(esc('<script>'), '&lt;script&gt;');
});

test('esc: encodes double quotes', () => {
  assert.equal(esc('"quoted"'), '&quot;quoted&quot;');
});

test('esc: handles multiple special chars in one string', () => {
  assert.equal(esc('<a href="x&y">'), '&lt;a href=&quot;x&amp;y&quot;&gt;');
});

test('esc: coerces non-string input via String()', () => {
  assert.equal(esc(42), '42');
});

// ── fmtPlaytime ───────────────────────────────────────────────────────────────

test('fmtPlaytime: returns empty string for 0', () => {
  assert.equal(fmtPlaytime(0), '');
});

test('fmtPlaytime: returns empty string for null/undefined', () => {
  assert.equal(fmtPlaytime(null), '');
  assert.equal(fmtPlaytime(undefined), '');
});

test('fmtPlaytime: formats minutes under an hour', () => {
  assert.equal(fmtPlaytime(47), '47m');
  assert.equal(fmtPlaytime(1), '1m');
});

test('fmtPlaytime: formats exactly 60 minutes as 1h', () => {
  assert.equal(fmtPlaytime(60), '1h');
});

test('fmtPlaytime: rounds to nearest hour above 60 minutes', () => {
  assert.equal(fmtPlaytime(90), '2h');
  assert.equal(fmtPlaytime(120), '2h');
});

// ── fmtLastPlayed ─────────────────────────────────────────────────────────────

test('fmtLastPlayed: returns empty string for 0/null/undefined', () => {
  assert.equal(fmtLastPlayed(0), '');
  assert.equal(fmtLastPlayed(null), '');
  assert.equal(fmtLastPlayed(undefined), '');
});

test('fmtLastPlayed: formats a Unix timestamp as an ISO date', () => {
  assert.equal(fmtLastPlayed(1751846400), '2025-07-07');
});

test('fmtLocalDate: the local calendar day, not the UTC one', () => {
  const tz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    assert.equal(fmtLocalDate(new Date('2026-10-24T03:00:00Z')), '2026-10-23');
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

test('fmtReleaseDate: a day-precise release reads as an ISO date, a coarse one as Steam wrote it', () => {
  assert.equal(fmtReleaseDate('Oct 13, 2026'), '2026-10-13');
  assert.equal(fmtReleaseDate('13 Oct, 2026'), '2026-10-13');
  for (const s of ['Q4 2026', 'Fall 2026', 'October 2026', '2026', 'Coming soon']) assert.equal(fmtReleaseDate(s), s);
});

// ── countryFlag ────────────────────────────────────────────────────────────────

test('countryFlag: converts a 2-letter ISO code to its flag emoji', () => {
  assert.equal(countryFlag('US'), '🇺🇸');
  assert.equal(countryFlag('fr'), '🇫🇷'); // case-insensitive
});

test('countryFlag: returns empty string for missing/malformed input', () => {
  assert.equal(countryFlag(null), '');
  assert.equal(countryFlag(undefined), '');
  assert.equal(countryFlag(''), '');
  assert.equal(countryFlag('USA'), '');
  assert.equal(countryFlag('1'), '');
});

// ── computeSteamdbRating ───────────────────────────────────────────────────────

test('computeSteamdbRating: returns null with no reviews', () => {
  assert.equal(computeSteamdbRating(0, 0), null);
});

test("computeSteamdbRating: 90/100 lands around 87-88 at this app's shrink strength", () => {
  assert.equal(Math.round(computeSteamdbRating(90, 100)), 88);
});

test('computeSteamdbRating: pulls a tiny 100%-positive sample well below 100', () => {
  assert.ok(computeSteamdbRating(2, 2) < 80);
});

test('computeSteamdbRating: a large sample stays much closer to the raw ratio than a small one', () => {
  const raw = 97;
  const smallSampleDiff = Math.abs(computeSteamdbRating(97, 100) - raw);
  const largeSampleDiff = Math.abs(computeSteamdbRating(48500, 50000) - raw);
  assert.ok(largeSampleDiff < smallSampleDiff);
});

test('computeSteamdbRating: returns unrounded precision, not an integer', () => {
  const rating = computeSteamdbRating(9123, 10000);
  assert.notEqual(rating, Math.round(rating));
});

// ── computeProductionTier ───────────────────────────────────────────────────────

test('computeProductionTier: null for DLC/expansion appids, regardless of price', () => {
  assert.equal(computeProductionTier({ isDlc: true, priceInitial: 5999, reviewsTotal: 1000000 }), null);
});

test('computeProductionTier: null for non-game content types (e.g. a soundtrack), regardless of price', () => {
  assert.equal(computeProductionTier({ type: 'music', priceInitial: 5999, reviewsTotal: 1000000 }), null);
});

test('computeProductionTier: AAA at $50+ launch price, even with zero reviews (fresh release)', () => {
  assert.equal(computeProductionTier({ priceInitial: 5999, reviewsTotal: 0 }), 'AAA');
});

test('computeProductionTier: AA when priced $20-$50 with enough reviews', () => {
  assert.equal(computeProductionTier({ priceInitial: 2999, reviewsTotal: 25000 }), 'AA');
});

test('computeProductionTier: AA when priced $20-$50 with a Metacritic entry, even with few reviews', () => {
  assert.equal(computeProductionTier({ priceInitial: 2999, reviewsTotal: 100, hasMetacritic: true }), 'AA');
});

test('computeProductionTier: Indie when priced $20-$50 but neither reviews nor Metacritic clear the bar', () => {
  assert.equal(computeProductionTier({ priceInitial: 2499, reviewsTotal: 100 }), 'Indie');
});

test('computeProductionTier: Indie under $20 regardless of review count', () => {
  assert.equal(computeProductionTier({ priceInitial: 999, reviewsTotal: 500000 }), 'Indie');
});

test('computeProductionTier: free-to-play AAA needs very high review volume', () => {
  assert.equal(computeProductionTier({ isFree: true, reviewsTotal: 250000 }), 'AAA');
});

test('computeProductionTier: free-to-play without enough reviews defaults to Indie', () => {
  assert.equal(computeProductionTier({ isFree: true, reviewsTotal: 1000 }), 'Indie');
});

test('computeProductionTier: null when priced but priceInitial is missing (no price signal at all)', () => {
  assert.equal(computeProductionTier({ priceInitial: null, reviewsTotal: 500000 }), null);
});

// ── dealRecordTier ───────────────────────────────────────────────────────────────
// Single shared source for the Best Deal cell's badge, the side panel's Price card, and the
// Price Status column (renderBestDeal in bundles.js/library.js, priceHtml in panel.js,
// computePriceStatus/PRICE_STATUS_TIERS in bundles.js/library.js) — see its own comment in
// public/utils.js for why: hand-duplicating this tier logic in each place is exactly what let a
// 3-month-low tier go missing from two of them.

test('dealRecordTier: null when price is missing', () => {
  assert.equal(dealRecordTier(null, { lowAll: 10, lowY1: 15, lowM3: 20 }), null);
  assert.equal(dealRecordTier(undefined, { lowAll: 10, lowY1: 15, lowM3: 20 }), null);
});

test('dealRecordTier: null when price beats none of the three windows', () => {
  assert.equal(dealRecordTier(25, { lowAll: 10, lowY1: 15, lowM3: 20 }), null);
});

test('dealRecordTier: null when none of the three lows are known', () => {
  assert.equal(dealRecordTier(5, {}), null);
});

test('dealRecordTier: all-time low takes priority even when the price also matches 1yr/3mo', () => {
  const rec = dealRecordTier(10, { lowAll: 10, lowY1: 10, lowM3: 10 });
  assert.equal(rec.tier, 'all-time');
  assert.equal(rec.statusLabel, 'All-Time Low');
  assert.equal(rec.tooltipLabel, 'all-time low');
  assert.equal(rec.icon, '🔥');
  assert.equal(rec.bold, true);
});

test('dealRecordTier: 1yr low when it beats the 1yr/3mo windows but not the all-time one', () => {
  const rec = dealRecordTier(15, { lowAll: 10, lowY1: 15, lowM3: 15 });
  assert.equal(rec.tier, '1yr');
  assert.equal(rec.statusLabel, '1-Year Low');
  assert.equal(rec.icon, '★');
  assert.ok(!rec.bold);
});

test('dealRecordTier: 3mo low when it beats only the 3mo window', () => {
  const rec = dealRecordTier(20, { lowAll: 10, lowY1: 15, lowM3: 20 });
  assert.equal(rec.tier, '3mo');
  assert.equal(rec.statusLabel, '3-Month Low');
  assert.equal(rec.icon, '☆');
});

test('dealRecordTier: <= not < — a price equal to the historical low still counts as a record', () => {
  assert.equal(dealRecordTier(10, { lowAll: 10 }).tier, 'all-time');
});

// ITAD's historyLow includes undiscounted prices (docs/dev/integrations.md), so a full price can equal it.
test('dealRecordTier: null for a deal with no discount, even at the historical low', () => {
  assert.equal(dealRecordTier(20, { lowAll: 20, bestDealCut: 0 }), null);
  assert.equal(dealRecordTier(20, { lowAll: 20, steamRegular: 20 }), null);
  assert.equal(dealRecordTier(19, { lowAll: 20, steamRegular: 20 }).tier, 'all-time');
  // A sub-1% discount rounds its cut to 0, but it is still below Steam's regular price.
  assert.equal(dealRecordTier(59.79, { lowAll: 59.89, bestDealCut: 0, steamRegular: 59.99 }).tier, 'all-time');
});

test('dealRecordTier: a missing individual low is skipped in favor of a matching one further down the list', () => {
  const rec = dealRecordTier(20, { lowAll: null, lowY1: null, lowM3: 20 });
  assert.equal(rec.tier, '3mo');
});

// ── oldestFetchedAt ───────────────────────────────────────────────────────────

test('oldestFetchedAt: keeps the oldest age, a fresh fetch counting as now', () => {
  const now = 1_700_000_000_000;
  const pages = [now - 3 * 86_400_000, null, now - 3_600_000];
  const age = pages.reduce((prev, at) => oldestFetchedAt(prev, at, now), undefined);
  assert.equal(age, now - 3 * 86_400_000);
  assert.equal(oldestFetchedAt(undefined, null, now), now);
});

// ── fmtAge ────────────────────────────────────────────────────────────────────

test('fmtAge: null (nothing cached — fetched fresh) reads as just now', () => {
  assert.equal(fmtAge(null), 'just now');
  assert.equal(fmtAge(undefined), 'just now');
});

test('fmtAge: under a minute, in either direction, is just now', () => {
  const now = 1_700_000_000_000;
  assert.equal(fmtAge(now - 30_000, now), 'just now');
  // A small clock skew between server and browser must never read as "in the future".
  assert.equal(fmtAge(now + 30_000, now), 'just now');
});

test('fmtAge: steps through minutes, hours, days and months', () => {
  const now = 1_700_000_000_000;
  const min = 60_000,
    hour = 60 * min,
    day = 24 * hour;
  assert.equal(fmtAge(now - 5 * min, now), '5 min ago');
  assert.equal(fmtAge(now - 3 * hour, now), '3h ago');
  assert.equal(fmtAge(now - day, now), '1 day ago');
  assert.equal(fmtAge(now - 6 * day, now), '6 days ago');
  assert.equal(fmtAge(now - 45 * day, now), '1 month ago');
  assert.equal(fmtAge(now - 70 * day, now), '2 months ago');
});

// ── isTextEntry ───────────────────────────────────────────────────────────────

test('isTextEntry: a text field, textarea or select swallows keys', () => {
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'search' }), true);
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'number' }), true);
  assert.equal(isTextEntry({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTextEntry({ tagName: 'SELECT' }), true);
});

// The regression this exists for: the game table puts a checkbox on every row, and treating one
// as text entry killed every page shortcut (R, ↑/↓, /, ?) for as long as focus sat on it.
test('isTextEntry: a checkbox, radio or button does not', () => {
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'radio' }), false);
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'range' }), false);
  assert.equal(isTextEntry({ tagName: 'BUTTON' }), false);
});

test('isTextEntry: contenteditable counts, a plain element does not', () => {
  assert.equal(isTextEntry({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTextEntry({ tagName: 'DIV' }), false);
  assert.equal(isTextEntry({ tagName: 'IMG' }), false);
});

test('isTextEntry: no focused element at all', () => {
  assert.equal(isTextEntry(null), false);
  assert.equal(isTextEntry(undefined), false);
});

// ── fmtTime ───────────────────────────────────────────────────────────────────

test('fmtTime: returns 0:00 for 0', () => {
  assert.equal(fmtTime(0), '0:00');
});

test('fmtTime: returns 0:00 for negative', () => {
  assert.equal(fmtTime(-1), '0:00');
});

test('fmtTime: returns 0:00 for NaN', () => {
  assert.equal(fmtTime(NaN), '0:00');
});

test('fmtTime: returns 0:00 for Infinity', () => {
  assert.equal(fmtTime(Infinity), '0:00');
});

test('fmtTime: formats seconds under a minute', () => {
  assert.equal(fmtTime(5), '0:05');
  assert.equal(fmtTime(59), '0:59');
});

test('fmtTime: formats exactly one minute', () => {
  assert.equal(fmtTime(60), '1:00');
});

test('fmtTime: formats minutes and seconds', () => {
  assert.equal(fmtTime(90), '1:30');
  assert.equal(fmtTime(125), '2:05');
});

test('fmtTime: truncates fractional seconds', () => {
  assert.equal(fmtTime(61.9), '1:01');
});

test('fmtTime: pads seconds with leading zero', () => {
  assert.equal(fmtTime(61), '1:01');
  assert.equal(fmtTime(600), '10:00');
});

test('detailsPending: media may still come until they load, fail, or there is no store page', () => {
  const details = (meta) => ({ rating: null, hltb: null, meta, tags: null, demo: null, protondb: null });
  const streamed = { name: 'Hades' }; // the details stream leaves media out
  const filled = { name: 'Hades', screenshots: [], movies: [] };
  assert.equal(detailsPending({ details: null }), true);
  assert.equal(detailsPending({ details: details(streamed) }), true);
  assert.equal(detailsPending({ details: details(streamed), mediaFailed: true }), false);
  assert.equal(detailsPending({ details: details(filled) }), false);
  assert.equal(detailsPending({ details: details(null) }), false);
  assert.equal(detailsPending({ details: details(null), failedSources: ['meta'] }), true);
});

test('noStorePage: only once details are in and the store answered with no page', () => {
  const details = (meta) => ({ rating: null, hltb: null, meta, tags: null, demo: null, protondb: null });
  assert.equal(noStorePage({ details: null }), false);
  assert.equal(noStorePage({ details: details({ name: 'Hades' }) }), false);
  assert.equal(noStorePage({ details: details(null), failedSources: ['meta'] }), false);
  assert.equal(noStorePage({ details: details(null), failedSources: [] }), true);
});

test('steamAppAsset: the conventional CDN path, kept for a delisted game', () => {
  assert.equal(
    steamAppAsset(28050, 'capsule_231x87.jpg'),
    'https://cdn.akamai.steamstatic.com/steam/apps/28050/capsule_231x87.jpg',
  );
});

// What a wait on media can end on: a failed store page brings none until ↻, so it isn't waited for.
test('mediaPending: only a game whose media are loading', () => {
  const details = (meta) => ({ rating: null, hltb: null, meta, tags: null, demo: null, protondb: null });
  assert.equal(mediaPending({ details: null }), false);
  assert.equal(mediaPending({ details: details({ name: 'Hades' }) }), true);
  assert.equal(mediaPending({ details: details({ name: 'Hades' }), mediaFailed: true }), false);
  assert.equal(mediaPending({ details: details({ name: 'Hades', screenshots: [] }) }), false);
  assert.equal(mediaPending({ details: details(null), failedSources: ['meta'] }), false);
});
