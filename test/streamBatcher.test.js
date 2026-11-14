'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStreamBatcher, FLUSH_MS } = require('../public/streamBatcher.ts');

test('createStreamBatcher: does not apply anything until a flush happens', () => {
  const applied = [];
  const batcher = createStreamBatcher({ apply: (e) => applied.push(e), isStale: () => false });
  batcher.push('a', 1);
  batcher.push('b', 1);
  assert.deepEqual(applied, []);
});

test('createStreamBatcher: flushNow() applies every pending event in push order', () => {
  const applied = [];
  const batcher = createStreamBatcher({ apply: (e) => applied.push(e), isStale: () => false });
  batcher.push('a', 1);
  batcher.push('b', 1);
  batcher.push('c', 1);
  batcher.flushNow();
  assert.deepEqual(applied, ['a', 'b', 'c']);
});

test('createStreamBatcher: a second flushNow() with nothing new queued applies nothing more', () => {
  const applied = [];
  const batcher = createStreamBatcher({ apply: (e) => applied.push(e), isStale: () => false });
  batcher.push('a', 1);
  batcher.flushNow();
  batcher.flushNow();
  assert.deepEqual(applied, ['a']);
});

test('createStreamBatcher: drops events whose generation is stale by flush time', () => {
  const applied = [];
  let currentGen = 1;
  const batcher = createStreamBatcher({ apply: (e) => applied.push(e), isStale: (gen) => gen !== currentGen });
  batcher.push('from-gen-1', 1);
  currentGen = 2; // a newer load superseded this one before the flush ran
  batcher.push('from-gen-2', 2);
  batcher.flushNow();
  assert.deepEqual(applied, ['from-gen-2']);
});

test('createStreamBatcher: onFlush runs once per flushNow(), even when nothing was pending', () => {
  let flushes = 0;
  const batcher = createStreamBatcher({
    apply: () => {},
    isStale: () => false,
    onFlush: () => {
      flushes++;
    },
  });
  batcher.flushNow();
  batcher.push('a', 1);
  batcher.flushNow();
  assert.equal(flushes, 2);
});

test('createStreamBatcher: schedules exactly one timer regardless of how many pushes happen before it fires', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const applied = [];
  const batcher = createStreamBatcher({ apply: (e) => applied.push(e), isStale: () => false });
  batcher.push('a', 1);
  batcher.push('b', 1);
  batcher.push('c', 1);
  t.mock.timers.tick(FLUSH_MS);
  assert.deepEqual(applied, ['a', 'b', 'c']);
});
