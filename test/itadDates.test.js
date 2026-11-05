'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => {
  delete require.cache[require.resolve('../lib/itadDates')];
  return require('../lib/itadDates');
};

test('overrideExpiry: replaces the expiry and logs nothing while ITAD disagrees', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const bundle = { id: 1, title: 'Killer', expiry: '2026-11-01T00:58:54+01:00' };
  assert.deepEqual(load().overrideExpiry(bundle, '2026-11-13T23:59:00.000Z', 'Fanatical'), {
    ...bundle,
    expiry: '2026-11-13T23:59:00.000Z',
  });
  assert.equal(log.mock.callCount(), 0);
});

test('overrideExpiry: says once per bundle when ITAD agrees to the minute', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const { overrideExpiry } = load();
  const bundle = { id: 2, title: 'Humble Choice (Nov 2026)', expiry: '2026-12-01T19:00:20+01:00' };
  overrideExpiry(bundle, '2026-12-01T18:00:00.000Z', "Humble's schedule");
  overrideExpiry(bundle, '2026-12-01T18:00:00.000Z', "Humble's schedule");
  assert.equal(log.mock.callCount(), 1);
  assert.match(
    log.mock.calls[0].arguments[0],
    /^\[itad-dates\] .*bundle 2 \(Humble Choice \(Nov 2026\)\).*Humble's schedule/,
  );
});
