'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runProblems, runFor, summary } = require('../scripts/backlog-run-log');

const RUN = {
  items: ['U166', 'U167'],
  started: '2026-10-18T13:00:00Z',
  merge: 'm1',
  mergedAt: '2026-10-18T15:20:00+02:00',
  phases: {
    plan: { agents: 3, rounds: 2, tokens: 200000, blocking: 10, other: 10, applied: 15 },
    code: { agents: 1, tokens: 100000, blocking: 1, other: 3, applied: 4 },
  },
};

test('runProblems: a complete run passes; triage is optional; a missing count or a bad item is named', () => {
  assert.deepEqual(runProblems(RUN), []);
  assert.deepEqual(runProblems({ ...RUN, phases: { ...RUN.phases, triage: { tokens: 5 } } }), []);
  assert.deepEqual(runProblems({ ...RUN, items: ['feature:wishlist-notes'] }), []);
  const bad = {
    ...RUN,
    items: ['fix it'],
    phases: { plan: RUN.phases.plan, code: { ...RUN.phases.code, tokens: -1 } },
  };
  assert.deepEqual(runProblems(bad), [
    'items: a non-empty list of C<n>/U<n>/feature:<slug>',
    'phases.code.tokens: a count',
  ]);
});

test('runFor: the run whose merge brought the commit in, not one that already had it', () => {
  // c1 came in with m1; m2 merged later, so c1 is also reachable from m2 but through m2^1.
  const reach = { m1: ['c1'], 'm1^1': [], m2: ['c1', 'c2'], 'm2^1': ['c1'] };
  const isAncestor = (sha, ref) => reach[ref].includes(sha);
  const runs = [{ merge: 'm1' }, { merge: 'm2' }];
  assert.equal(runFor('c1', runs, isAncestor).merge, 'm1');
  assert.equal(runFor('c2', runs, isAncestor).merge, 'm2');
  assert.equal(runFor('c3', runs, isAncestor), undefined);
});

test('summary: per-phase yield per 100k tokens, applied share, minutes, blocked commits within the run, escapes', () => {
  const checks = [
    { at: '2026-10-18T13:10:00.000Z', run: 'commit', failed: ['comments'] },
    { at: '2026-10-18T13:11:00.000Z', run: 'commit', failed: [] },
    { at: '2026-10-18T14:00:00.000Z', run: 'commit', failed: ['lint'] }, // after the merge
  ];
  assert.equal(
    summary([RUN], [{ item: 'C1' }], checks),
    'Backlog runs (scripts/backlog-run-log.js): 1, median 20 min, 1 blocked commits · plan 200k tokens/run, 5.0 required and 5.0 other per 100k, 75% applied · code 100k tokens/run, 1.0 bugs and 3.0 other per 100k, 100% applied · 1 escapes (1.0 per run)',
  );
  assert.equal(summary([], [], []), 'Backlog runs (scripts/backlog-run-log.js): none yet');
});
