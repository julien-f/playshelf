'use strict';

// An exhausted outbound budget warns once (lib/metrics.js's chargeBudget); the requests it then
// refuses must not each log again. Its own file: the budget is read from the env at load time.
process.env.STEAM_API_KEY = 'test-key';
process.env.NODE_ENV = 'test';
process.env.DB_FILE = '';
process.env.OUTBOUND_HOURLY_MAX = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { app } = require('../server');
const { _reset } = require('../lib/cache');
const { createTrackedFetch, _reset: _resetMetrics } = require('../lib/metrics');

const api = supertest(app);

// Spends each group's single allowed call, then logs from here on are what refused calls print.
async function exhaust(t, groups) {
  _reset();
  _resetMetrics();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({}) }));
  for (const group of groups) await createTrackedFetch(group)('spend', 'https://example.com/');
  const warn = t.mock.method(console, 'warn', () => {});
  const error = t.mock.method(console, 'error', () => {});
  return { warn, error };
}

test('a route refused by an exhausted budget replies 502 without logging it again', async (t) => {
  const { warn, error } = await exhaust(t, ['steam-store']);
  for (const q of ['term-a', 'term-b']) {
    const res = await api.get(`/api/search-games?q=${q}`);
    assert.equal(res.status, 502);
  }
  assert.equal(warn.mock.calls.filter((c) => /\[budget:steam-store\]/.test(c.arguments[0])).length, 1);
  assert.deepEqual(
    error.mock.calls.map((c) => c.arguments[0]),
    [],
  );
});

test('game details refused by exhausted budgets log no [game-details] line', async (t) => {
  const { warn } = await exhaust(t, ['steam-store', 'steam-reviews', 'steam-browse', 'protondb']);
  const res = await api.get('/api/game-details/900');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.failed, ['rating', 'hltb', 'tags', 'protondb', 'meta']);
  assert.deepEqual(
    warn.mock.calls.filter((c) => /\[game-details\]/.test(c.arguments[0])).map((c) => c.arguments[0]),
    [],
  );
});
