'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  COUNTRY_OPTIONS,
  TIMEZONE_COUNTRY,
  detectCountry,
  AUTO_COUNTRY,
  getStoredRegion,
  setStoredRegion,
  currentRegion,
  regionLabel,
} = require('../public/region.ts');

// region.js reads a handful of global-scoped APIs live on every call (no module-level state of
// its own to reset between tests — see setPref/getPref's own equivalent note in prefs.js) —
// localStorage (via prefs.js) and Intl.DateTimeFormat/Intl.Locale (detectCountry). Each test stubs only what it needs and afterEach restores
// the real Intl.DateTimeFormat/Intl.Locale so no test leaks a stub into another.
const { makeMemoryLocalStorage } = require('./memoryStorage.js');

const realDateTimeFormat = Intl.DateTimeFormat;
const realLocale = Intl.Locale;

// `timeZone: undefined` simulates Intl.DateTimeFormat itself throwing (unsupported), matching
// detectCountry's own try/catch around it.
function stubTimeZone(timeZone) {
  Intl.DateTimeFormat =
    timeZone === undefined
      ? function () {
          throw new Error('unsupported');
        }
      : function () {
          return { resolvedOptions: () => ({ timeZone }) };
        };
}

// `region: undefined` simulates Intl.Locale itself throwing (unsupported/unparseable tag).
function stubLocaleRegion(region) {
  Intl.Locale =
    region === undefined
      ? function () {
          throw new Error('unparseable');
        }
      : function () {
          return { maximize: () => ({ region }) };
        };
}

beforeEach(() => {
  global.localStorage = makeMemoryLocalStorage();
});

afterEach(() => {
  Intl.DateTimeFormat = realDateTimeFormat;
  Intl.Locale = realLocale;
  delete global.navigator;
  delete global.window;
});

// ── COUNTRY_OPTIONS / TIMEZONE_COUNTRY ──────────────────────────────────────────

test('COUNTRY_OPTIONS: includes the expected curated codes', () => {
  const codes = COUNTRY_OPTIONS.map((c) => c.code);
  assert.deepEqual(codes, ['US', 'GB', 'DE', 'CA', 'AU', 'JP', 'BR', 'RU', 'TR', 'UA', 'AR', 'IN', 'CN', 'KR', 'MX']);
});

test('TIMEZONE_COUNTRY: maps a representative zone per country to a COUNTRY_OPTIONS code', () => {
  const validCodes = new Set(COUNTRY_OPTIONS.map((c) => c.code));
  for (const code of Object.values(TIMEZONE_COUNTRY)) assert.ok(validCodes.has(code), code);
  assert.equal(TIMEZONE_COUNTRY['Europe/Paris'], 'DE');
  assert.equal(TIMEZONE_COUNTRY['Asia/Tokyo'], 'JP');
});

// ── detectCountry ────────────────────────────────────────────────────────────

test('detectCountry: resolves a known timezone directly, without consulting navigator.language', () => {
  stubTimeZone('Europe/Paris');
  stubLocaleRegion('US'); // would mislead if this were consulted — confirms timezone wins
  assert.equal(detectCountry(), 'DE');
});

test('detectCountry: falls back to navigator.language region when the timezone is unmapped', () => {
  stubTimeZone('Africa/Cairo'); // not in TIMEZONE_COUNTRY
  stubLocaleRegion('JP');
  global.navigator = { language: 'ja-JP' };
  assert.equal(detectCountry(), 'JP');
});

test('detectCountry: falls back to US when neither timezone nor language resolve to anything', () => {
  stubTimeZone('Africa/Cairo');
  stubLocaleRegion('ZZ'); // not one of COUNTRY_OPTIONS' codes
  global.navigator = { language: 'xx-ZZ' };
  assert.equal(detectCountry(), 'US');
});

test('detectCountry: falls back to US when Intl.DateTimeFormat and Intl.Locale both throw', () => {
  stubTimeZone(undefined);
  stubLocaleRegion(undefined);
  global.navigator = { language: 'en-US' };
  assert.equal(detectCountry(), 'US');
});

test('detectCountry: falls back to language when Intl.DateTimeFormat itself throws', () => {
  stubTimeZone(undefined);
  stubLocaleRegion('DE');
  global.navigator = { language: 'de-DE' };
  assert.equal(detectCountry(), 'DE');
});

// ── getStoredRegion / setStoredRegion ────────────────────────────────────────

test('getStoredRegion: returns AUTO_COUNTRY when nothing was ever stored', () => {
  assert.equal(getStoredRegion(), AUTO_COUNTRY);
});

test('setStoredRegion/getStoredRegion: round-trips a real country code', () => {
  setStoredRegion('DE');
  assert.equal(getStoredRegion(), 'DE');
});

test('setStoredRegion/getStoredRegion: round-trips AUTO_COUNTRY itself', () => {
  setStoredRegion('DE');
  setStoredRegion(AUTO_COUNTRY);
  assert.equal(getStoredRegion(), AUTO_COUNTRY);
});

test('getStoredRegion: falls back to AUTO_COUNTRY for an unrecognized stored value', () => {
  global.localStorage.setItem('steam.isonoe.net:prefs', JSON.stringify({ region: 'ZZ' }));
  assert.equal(getStoredRegion(), AUTO_COUNTRY);
});

test('currentRegion is reactive: an effect follows setStoredRegion', async () => {
  const { createRoot, createEffect } = await import('solid-js');
  setStoredRegion('US');
  const seen = [];
  const dispose = createRoot((dispose) => {
    createEffect(() => seen.push(currentRegion()));
    return dispose;
  });
  setStoredRegion('GB');
  dispose();
  assert.deepEqual(seen, ['US', 'GB']);
});

test('setStoredRegion: never throws when window is undefined (Node/test environment)', () => {
  assert.doesNotThrow(() => setStoredRegion('GB'));
});

// ── currentRegion ────────────────────────────────────────────────────────────

test('currentRegion: passes a stored country code straight through', () => {
  setStoredRegion('DE');
  assert.equal(currentRegion(), 'DE');
});

test('currentRegion: resolves AUTO_COUNTRY to a live detectCountry() result', () => {
  stubTimeZone('Asia/Tokyo');
  setStoredRegion(AUTO_COUNTRY);
  assert.equal(currentRegion(), 'JP');
});

test('regionLabel: resolves a curated code to its label, and passes an unknown one through', () => {
  assert.equal(regionLabel('DE'), 'Europe / Germany (EUR)');
  assert.equal(regionLabel('US'), 'United States (USD)');
  assert.equal(regionLabel('ZZ'), 'ZZ');
});
