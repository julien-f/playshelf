'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarize, compare, previousRun, PROFILE } = require('../scripts/perf-measure');

const run = (doneMs) => ({ doneMs });
const only = (rows, key) => rows.find((r) => r.key === key);

test('perf-measure summarize: median (even counts average the middle two), min and max per metric', () => {
  assert.deepEqual(summarize([run(30), run(10), run(20)]).doneMs, { median: 20, min: 10, max: 30 });
  assert.deepEqual(summarize([run(40), run(10), run(20), run(30)]).doneMs, { median: 25, min: 10, max: 40 });
});

test('perf-measure compare: a change counts only when the ranges do not overlap', () => {
  const previous = { stats: { doneMs: { median: 100, min: 90, max: 110 } } };
  assert.equal(only(compare(summarize([run(105), run(120)]), previous), 'doneMs').changed, false);
  const faster = only(compare(summarize([run(70), run(80)]), previous), 'doneMs');
  assert.deepEqual([faster.changed, faster.before], [true, 100]);
  assert.equal(only(compare(summarize([run(70)]), undefined), 'doneMs').before, null);
});

test('perf-measure previousRun: the latest successful run with the same profile', () => {
  const rows = [
    { profile: PROFILE, outcome: 'ok', commit: 'a' },
    { profile: 'other', outcome: 'ok', commit: 'b' },
    { profile: PROFILE, outcome: 'failed', commit: 'c' },
  ];
  assert.equal(previousRun(rows).commit, 'a');
  assert.equal(previousRun([]), undefined);
});
