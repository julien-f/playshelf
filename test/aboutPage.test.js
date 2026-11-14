'use strict';

// About's "Data sources" and "What's stored" are hand-written: they once missed Fanatical and PC Game Pass and stated stale cache durations (C325).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const about = fs.readFileSync(path.join(root, 'public', 'AboutRoute.tsx'), 'utf8');
const env = Object.fromEntries(
  [...fs.readFileSync(path.join(root, 'default.env'), 'utf8').matchAll(/^([A-Z_]+)=(\d+)$/gm)].map((m) => [
    m[1],
    Number(m[2]),
  ]),
);

const SOURCE_OF_GROUP = {
  'steam-api': 'Steam Web API',
  'steam-reviews': 'Steam Web API',
  'steam-store': 'Steam Store',
  'steam-browse': 'Steam Store',
  'steam-openid': 'Steam sign-in',
  hltb: 'HowLongToBeat',
  protondb: 'ProtonDB',
  itad: 'IsThereAnyDeal',
  fanatical: 'Fanatical',
  gamepass: 'Microsoft',
};

test('every outbound group is named among About’s data sources', () => {
  const groups = fs
    .readdirSync(path.join(root, 'lib'))
    .filter((f) => /\.m?js$/.test(f))
    .flatMap((f) => [
      ...fs.readFileSync(path.join(root, 'lib', f), 'utf8').matchAll(/createTrackedFetch\('([^']+)'\)/g),
    ])
    .map((m) => m[1]);
  assert.ok(groups.length > 0);
  for (const group of groups) {
    const source = SOURCE_OF_GROUP[group];
    assert.ok(source, `outbound group "${group}" has no About source: add it to the page and to SOURCE_OF_GROUP`);
    assert.ok(about.includes(`<strong>${source}</strong>`), `About doesn't name ${source}`);
  }
});

test('About’s stated durations still bound the cache and session settings', () => {
  const ttls = Object.entries(env).filter(([key]) => key.endsWith('_CACHE_TTL_MINUTES'));
  assert.ok(ttls.length > 0);
  assert.match(about, /within a year/);
  for (const [key, minutes] of ttls) assert.ok(minutes <= 366 * 24 * 60, `${key} outlasts "within a year"`);
  assert.match(about, /within a month/);
  assert.ok(env.LIBRARY_CACHE_TTL_MINUTES <= 31 * 24 * 60, 'LIBRARY_CACHE_TTL_MINUTES outlasts "within a month"');
  assert.ok(
    about.includes(`${env.SESSION_TTL_DAYS} days`),
    'About states another session length than SESSION_TTL_DAYS',
  );
});
