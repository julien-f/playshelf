'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prodCheck, expectedStatuses } = require('../scripts/prod-check');

const NOW = Date.parse('2026-11-05T16:00:00Z');
const EXPECTED = { getProtonDbStatus: ['404'] };
const healthy = () => ({
  since: Date.parse('2026-11-03T18:00:00Z'),
  commit: 'abc1234',
  alerts: [{ level: 'info', where: 'server', message: 'started less than an hour ago: lastHour is partial' }],
  sinceRestart: { eventLoop: { maxDelayMs: 26 }, inbound: { 'GET /api/x': { statusClasses: { '2xx': 5 } } } },
  daily: { '2026-11-05': { protondb: { getProtonDbStatus: { 200: 3, 404: 9 } } } },
});
const run = (m, opts = {}) => prodCheck(m, { behind: 0, expected: EXPECTED, now: NOW, ...opts });

test('prodCheck: nothing to say about a healthy production', () => {
  assert.deepEqual(run(healthy()).lines, []);
});

test('prodCheck: warn alerts and the ITAD end-date one, not other info', () => {
  const m = healthy();
  m.alerts.push(
    { level: 'warn', where: 'eventLoop', message: 'blocked 3567 ms in the last hour' },
    { level: 'info', where: 'itad-dates', message: 'ITAD agrees' },
  );
  assert.deepEqual(run(m).lines, ['prod eventLoop: blocked 3567 ms in the last hour', 'prod itad-dates: ITAD agrees']);
});

test('prodCheck: an event-loop block since the last run, past startup and not already alerted', () => {
  const m = healthy();
  m.sinceRestart.eventLoop = { maxDelayMs: 26827, maxDelayAt: '2026-11-04T21:01:16.334Z' };
  assert.deepEqual(run(m).lines, ['prod eventLoop: blocked 26827 ms at 2026-11-04T21:01:16.334Z']);
  assert.deepEqual(run(m, { last: { at: '2026-11-05T08:00:00Z' } }).lines, []);
  m.sinceRestart.eventLoop.maxDelayAt = '2026-11-03T18:01:00Z'; // loading the cache
  assert.deepEqual(run(m).lines, []);
});

test('prodCheck: inbound 5xx since the last run', () => {
  const m = healthy();
  m.sinceRestart.inbound['GET /api/x'] = { statusClasses: { '5xx': 2 }, lastServerErrorAt: '2026-11-05T10:00:00Z' };
  assert.deepEqual(run(m).lines, ['prod GET /api/x: 2 server errors since restart, last at 2026-11-05T10:00:00Z']);
  assert.deepEqual(run(m, { last: { at: '2026-11-05T11:00:00Z' } }).lines, []);
});

test('prodCheck: unexpected upstream statuses, only what grew since the last run', () => {
  const m = healthy();
  m.daily['2026-11-05'].hltb = { search: { 200: 5, 429: 4 } };
  m.daily['2026-11-05']['steam-store'] = { getAppDetails: { network: 1 } };
  const first = run(m);
  assert.deepEqual(first.lines, [
    'prod hltb.search 429: 4 on 2026-11-05',
    'prod steam-store.getAppDetails network: 1 on 2026-11-05',
  ]);
  m.daily['2026-11-05'].hltb.search[429] = 6;
  assert.deepEqual(run(m, { last: { at: '2026-11-05T15:00:00Z', seen: first.seen } }).lines, [
    'prod hltb.search 429: 2 on 2026-11-05',
  ]);
});

test('prodCheck: a deployed commit behind origin/main, or unknown here', () => {
  assert.deepEqual(run(healthy(), { behind: 3 }).lines, [
    'prod deploy: production runs abc1234, 3 commit(s) behind origin/main',
  ]);
  assert.deepEqual(run(healthy(), { behind: null }).lines, [
    'prod deploy: production runs abc1234, unknown here (git fetch?)',
  ]);
});

test("expectedStatuses: reads each call's declared statuses from lib/", () => {
  const e = expectedStatuses();
  assert.deepEqual(e.getProtonDbStatus, ['404']);
  assert.deepEqual(e.getPlayerAchievements, ['400', '403']);
  assert.equal(Object.keys(e).length, 7, 'one per `expected: [` in lib/: a new one must be found too');
});
