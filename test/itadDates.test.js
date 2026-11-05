'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { overrideExpiry, itadDateAgreement, _reset } = require('../lib/itadDates');

const NOW = Date.parse('2026-11-05T12:00:00Z');
beforeEach(_reset);

test('overrideExpiry: replaces the expiry', () => {
  const bundle = { id: 1, title: 'Killer', expiry: '2026-11-01T00:58:54+01:00' };
  assert.deepEqual(overrideExpiry(bundle, '2026-11-13T23:59:00.000Z', 'Fanatical', NOW), {
    ...bundle,
    expiry: '2026-11-13T23:59:00.000Z',
  });
});

test('itadDateAgreement: per source, a bundle counted once with its latest verdict, agreeing to the minute', () => {
  overrideExpiry({ id: 1, expiry: '2026-11-01T00:58:54+01:00' }, '2026-11-13T23:59:00.000Z', 'Fanatical', NOW);
  overrideExpiry({ id: 1, expiry: '2026-11-13T23:59:40Z' }, '2026-11-13T23:59:00.000Z', 'Fanatical', NOW);
  overrideExpiry({ id: 2, expiry: null }, '2026-11-20T00:00:00.000Z', 'Fanatical', NOW);
  overrideExpiry({ id: 3, expiry: '2026-12-01T18:00:00Z' }, '2026-12-01T18:00:00.000Z', 'Humble Choice', NOW);
  assert.deepEqual(itadDateAgreement(), [
    { source: 'Fanatical', agree: 1, seen: 2 },
    { source: 'Humble Choice', agree: 1, seen: 1 },
  ]);
});

test('itadDateAgreement: leaves out bundles no longer on sale, whose ITAD date will never be fixed', () => {
  overrideExpiry({ id: 4, expiry: '2026-10-06T16:00:00Z' }, '2026-10-06T17:00:00.000Z', 'Humble Choice', NOW);
  assert.deepEqual(itadDateAgreement(), []);
});
