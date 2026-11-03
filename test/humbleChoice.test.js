'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { choiceEndMs, choiceMonth, currentChoice, withChoiceEnd } = require('../lib/humbleChoice');

const iso = (ms) => new Date(ms).toISOString();

test('choiceEndMs: the first Tuesday of the next month at 10:00 Pacific, PST or PDT', () => {
  assert.equal(iso(choiceEndMs(2026, 9)), '2026-11-03T18:00:00.000Z'); // October 2026, observed on humblebundle.com
  assert.equal(iso(choiceEndMs(2026, 8)), '2026-10-06T17:00:00.000Z'); // PDT
  assert.equal(iso(choiceEndMs(2026, 11)), '2027-01-05T18:00:00.000Z'); // across the year
  assert.equal(iso(choiceEndMs(2022, 9)), '2022-11-01T17:00:00.000Z'); // a November Tuesday still in PDT
});

test('choiceMonth: only a Humble Bundle membership link', () => {
  const url = 'https://www.humblebundle.com/membership/october-2026?partner=itad';
  assert.deepEqual(choiceMonth({ page: { name: 'Humble Bundle' }, url }), {
    year: 2026,
    month: 9,
    key: 'october-2026',
  });
  // ITAD's affiliate links wrap the store URL, encoded.
  const wrapped = `https://example.com/r?u=${encodeURIComponent(url)}`;
  assert.equal(choiceMonth({ page: { name: 'Humble Bundle' }, url: wrapped })?.key, 'october-2026');
  assert.equal(choiceMonth({ page: { name: 'Fanatical' }, url }), null);
  assert.equal(
    choiceMonth({ page: { name: 'Humble Bundle' }, url: 'https://www.humblebundle.com/games/factory-must-grow' }),
    null,
  );
  assert.equal(choiceMonth({ page: { name: 'Humble Bundle' }, url: '%E0' }), null);
});

test('currentChoice: switches month at the previous one’s end', () => {
  assert.deepEqual(currentChoice(Date.parse('2026-11-03T17:59:59Z')), {
    key: 'october-2026',
    startMs: Date.parse('2026-10-06T17:00:00Z'),
  });
  assert.equal(currentChoice(Date.parse('2026-11-03T18:00:00Z')).key, 'november-2026');
  assert.equal(currentChoice(Date.parse('2027-01-02T00:00:00Z')).key, 'december-2026');
});

test("withChoiceEnd: Humble's end date replaces ITAD's on Choice bundles only", () => {
  const october = {
    id: 16635,
    page: { name: 'Humble Bundle' },
    url: 'https://www.humblebundle.com/membership/october-2026',
    expiry: '2026-11-03T17:00:00+01:00',
  };
  const other = { id: 1, page: { name: 'Humble Bundle' }, url: 'https://www.humblebundle.com/games/x', expiry: 'x' };
  const [a, b] = withChoiceEnd([october, other]);
  assert.equal(a.expiry, '2026-11-03T18:00:00.000Z');
  assert.equal(b, other);
});
