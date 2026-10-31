'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseGameKey, isIgdbKey, igdbIdOf } = require('../public/gameKey.ts');

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
