'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseGameKey, isIgdbKey, isIgdbRow, isSteamRow, igdbIdOf } = require('../public/gameKey.ts');

test('parseGameKey: a Steam appid is a number', () => {
  assert.equal(parseGameKey('440'), 440);
});

test('parseGameKey: igdb:N, plain or percent-encoded, is an IGDB key', () => {
  assert.equal(parseGameKey('igdb:9001'), 'igdb:9001');
  assert.equal(parseGameKey('igdb%3A9001'), 'igdb:9001');
  assert.equal(parseGameKey('IGDB:0042'), 'igdb:42');
});

test('parseGameKey: anything else is NaN or a number, for the appid check to refuse', () => {
  assert.ok(Number.isNaN(parseGameKey('igdb:0')));
  assert.ok(Number.isNaN(parseGameKey('igdb:x')));
  assert.ok(Number.isNaN(parseGameKey('abc')));
});

test('isIgdbKey / igdbIdOf', () => {
  assert.equal(isIgdbKey('igdb:7'), true);
  assert.equal(isIgdbKey(7), false);
  assert.equal(isIgdbKey(null), false);
  assert.equal(igdbIdOf('igdb:7'), 7);
});

// A list's table row for a game outside Steam has an igdb key but isn't the panel's IgdbRow.
test("isIgdbRow / isSteamRow: by the panel row's IGDB load, and by key", () => {
  const panelRow = { appid: 'igdb:7', name: '', igdb: undefined };
  const tableRow = { appid: 'igdb:7', name: '', source: 'igdb' };
  assert.equal(isIgdbRow(panelRow), true);
  assert.equal(isIgdbRow(tableRow), false);
  assert.equal(isIgdbRow({ appid: 440, name: '' }), false);
  assert.equal(isSteamRow(tableRow), false);
  assert.equal(isSteamRow({ appid: 440 }), true);
});
