'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fmtDateTime, fmtDatePart, fmtTimePart } = require('../public/dateTime.ts');

// ── fmtDateTime ──────────────────────────────────────────────────────────────────────────────

test('fmtDateTime: formats an ITAD timestamp as its own local date and time', () => {
  // Deliberately an offset timestamp whose UTC date differs from its local one in a negative-
  // offset timezone: this is what `toISOString().slice(0, 10)` gets wrong.
  const iso = '2026-09-25T01:30:00+02:00';
  const expected = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  assert.equal(
    fmtDateTime(iso),
    `${expected.getFullYear()}-${pad(expected.getMonth() + 1)}-${pad(expected.getDate())}` +
      ` ${pad(expected.getHours())}:${pad(expected.getMinutes())}`,
  );
});

test('fmtDatePart / fmtTimePart: the two halves the stacked cell renders', () => {
  const iso = '2026-09-25T01:30:00+02:00';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  assert.equal(fmtDatePart(iso), `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  assert.equal(fmtTimePart(iso), `${pad(d.getHours())}:${pad(d.getMinutes())}`);
  // Together they're exactly the flat form the column's own `format` (and so the table's search)
  // still returns.
  assert.equal(fmtDateTime(iso), `${fmtDatePart(iso)} ${fmtTimePart(iso)}`);
});

test('fmtTimePart: empty for a missing date, so the cell renders no second line at all', () => {
  for (const v of [null, undefined, '', 'not a date']) {
    assert.equal(fmtTimePart(v), '');
    assert.equal(fmtDatePart(v), '—');
    // No trailing space from an empty time half.
    assert.equal(fmtDateTime(v), '—');
  }
});

test('fmtDateTime: keeps the time that distinguishes two same-day bundles', () => {
  // The reason the time is shown at all: the table sorts on the full timestamp, so a pair of rows
  // both reading "2026-09-04" would otherwise look arbitrarily ordered.
  const early = fmtDateTime('2026-09-04T16:55:38+02:00');
  const late = fmtDateTime('2026-09-04T20:35:03+02:00');
  assert.notEqual(early, late);
  assert.ok(early < late, `${early} should render before ${late}`);
});

test('fmtDateTime: missing/unparseable dates render as an em dash', () => {
  assert.equal(fmtDateTime(null), '—');
  assert.equal(fmtDateTime(undefined), '—');
  assert.equal(fmtDateTime(''), '—');
  assert.equal(fmtDateTime('not a date'), '—');
});
