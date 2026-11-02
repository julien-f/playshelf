'use strict';

process.env.DB_FILE = ''; // _reset() empties metrics_daily: never the real db.sqlite
const { test } = require('node:test');
process.env.OUTBOUND_HOURLY_MAX = '5';
process.env.OUTBOUND_DAILY_MAX = '50';
const assert = require('node:assert/strict');
const {
  createTrackedFetch,
  recordLimiterTrip,
  recordDedupHit,
  recordCacheEvent,
  startEventLoopSampling,
  getMetrics,
  _reset,
} = require('../lib/metrics');
const { db } = require('../lib/db');

test.beforeEach(() => _reset());

test('trackedFetch: calls fetch with the same url/opts and returns its result', async () => {
  let seen;
  const t = createTrackedFetch('grp').bind(null, 'label');
  const restore = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, status: 200, marker: 'res' };
  };
  try {
    const res = await t('https://example.com/x', { signal: 'sig' });
    assert.deepEqual(seen, { url: 'https://example.com/x', opts: { signal: 'sig' } });
    assert.equal(res.marker, 'res');
  } finally {
    globalThis.fetch = restore;
  }
});

test('getMetrics: counts requests per group/label independently (sinceRestart)', async () => {
  const restore = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  try {
    await createTrackedFetch('steam-api')('getOwnedGames', 'u1');
    await createTrackedFetch('steam-api')('getOwnedGames', 'u2');
    await createTrackedFetch('steam-api')('getWishlist', 'u3');
    await createTrackedFetch('itad')('getPrices', 'u4');

    const { sinceRestart } = getMetrics();
    assert.equal(sinceRestart.groups['steam-api'].getOwnedGames.requests, 2);
    assert.equal(sinceRestart.groups['steam-api'].getWishlist.requests, 1);
    assert.equal(sinceRestart.groups.itad.getPrices.requests, 1);
  } finally {
    globalThis.fetch = restore;
  }
});

test('getMetrics: distinguishes labels within the same group (e.g. resolveItadIds vs getPrices)', async () => {
  const restore = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  try {
    await createTrackedFetch('itad')('resolveItadIds', 'u1');
    await createTrackedFetch('itad')('resolveItadIds', 'u2');
    await createTrackedFetch('itad')('resolveItadIds', 'u3');
    // getPrices never called — should be absent, not present with requests: 0 — so it doesn't
    // look the same as "resolveItadIds is also stalled".
    const { sinceRestart } = getMetrics();
    assert.equal(sinceRestart.groups.itad.resolveItadIds.requests, 3);
    assert.equal(sinceRestart.groups.itad.getPrices, undefined);
  } finally {
    globalThis.fetch = restore;
  }
});

test('getMetrics: sinceRestart buckets outcomes by raw HTTP status code, not a blanket error count', async () => {
  const statuses = [200, 200, 429, 403];
  let i = 0;
  const restore = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: statuses[i] < 400, status: statuses[i++] });
  try {
    for (let n = 0; n < statuses.length; n++) await createTrackedFetch('steam-store')('getAppDetails', 'u');

    const entry = getMetrics().sinceRestart.groups['steam-store'].getAppDetails;
    assert.equal(entry.requests, 4);
    assert.deepEqual(entry.statusCounts, { 200: 2, 429: 1, 403: 1 });
  } finally {
    globalThis.fetch = restore;
  }
});

test('getMetrics: sinceRestart counts a thrown/network fetch failure separately from statusCounts', async () => {
  const restore = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('timeout');
  };
  try {
    await assert.rejects(() => createTrackedFetch('hltb')('search', 'u'));
    const entry = getMetrics().sinceRestart.groups.hltb.search;
    assert.equal(entry.requests, 1);
    assert.equal(entry.networkErrors, 1);
    assert.deepEqual(entry.statusCounts, {});
  } finally {
    globalThis.fetch = restore;
  }
});

test('getMetrics: lastHour mirrors sinceRestart while everything happened within the hour', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const restore = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  try {
    await createTrackedFetch('hltb')('search', 'u1');
    recordLimiterTrip('details');
    recordDedupHit('steam');
    recordCacheEvent('library', 'hits');
    t.mock.timers.tick(10 * 60 * 1000); // 10 minutes later
    globalThis.fetch = async () => {
      t.mock.timers.tick(40);
      throw new Error('timeout');
    };
    await assert.rejects(() => createTrackedFetch('hltb')('search', 'u2'));
    recordCacheEvent('library', 'forced');

    // Whole objects, so a field the last-hour sum misses shows up here.
    const { sinceRestart, lastHour } = getMetrics();
    assert.equal(sinceRestart.groups.hltb.search.requests, 2);
    assert.deepEqual(lastHour, sinceRestart);
  } finally {
    globalThis.fetch = restore;
  }
});

test('getMetrics: lastHour drops entries older than an hour but sinceRestart keeps them', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const restore = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  try {
    await createTrackedFetch('hltb')('search', 'u1'); // this one will age out
    t.mock.timers.tick(61 * 60 * 1000); // 61 minutes later
    await createTrackedFetch('hltb')('search', 'u2');

    const { sinceRestart, lastHour } = getMetrics();
    assert.equal(sinceRestart.groups.hltb.search.requests, 2); // lifetime total unaffected
    assert.equal(lastHour.groups.hltb.search.requests, 1); // only the recent one
  } finally {
    globalThis.fetch = restore;
  }
});

test('getMetrics: lastHour re-filters at read time even with no writes since aging out', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const restore = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  try {
    await createTrackedFetch('hltb')('search', 'u1');
    assert.equal(getMetrics().lastHour.groups.hltb.search.requests, 1);

    t.mock.timers.tick(61 * 60 * 1000); // idle for over an hour — no new requests
    assert.equal(getMetrics().lastHour.groups.hltb.search.requests, 0);
  } finally {
    globalThis.fetch = restore;
  }
});

test('getMetrics: sinceRestart/lastHour report avg/max latency per label', async (t) => {
  const durations = [10, 20, 30];
  let i = 0;
  const restore = globalThis.fetch;
  t.mock.timers.enable({ apis: ['Date'] });
  globalThis.fetch = async () => {
    t.mock.timers.tick(durations[i++]);
    return { ok: true, status: 200 };
  };
  try {
    for (let n = 0; n < durations.length; n++) await createTrackedFetch('steam-store')('getAppDetails', 'u');

    const { sinceRestart, lastHour } = getMetrics();
    const entry = sinceRestart.groups['steam-store'].getAppDetails;
    // avg of 10/20/30 = 20, max = 30
    assert.equal(entry.avgLatencyMs, 20);
    assert.equal(entry.maxLatencyMs, 30);
    assert.equal(lastHour.groups['steam-store'].getAppDetails.avgLatencyMs, 20);
    assert.equal(lastHour.groups['steam-store'].getAppDetails.maxLatencyMs, 30);
  } finally {
    globalThis.fetch = restore;
  }
});

test('getMetrics: p50/p95 latency per label are bucket upper bounds, capped by the largest seen', async (t) => {
  const durations = [10, 20, 30, 40, 3000];
  let i = 0;
  const restore = globalThis.fetch;
  t.mock.timers.enable({ apis: ['Date'] });
  globalThis.fetch = async () => {
    t.mock.timers.tick(durations[i++]);
    return { ok: true, status: 200 };
  };
  try {
    for (let n = 0; n < durations.length; n++) await createTrackedFetch('hltb')('search', 'u');
    const { sinceRestart, lastHour } = getMetrics();
    for (const entry of [sinceRestart.groups.hltb.search, lastHour.groups.hltb.search]) {
      assert.equal(entry.p50LatencyMs, 50);
      assert.equal(entry.p95LatencyMs, 3000);
    }
  } finally {
    globalThis.fetch = restore;
  }
});

test('getMetrics: a thrown/network failure still counts toward latency (not just successes)', async (t) => {
  const restore = globalThis.fetch;
  t.mock.timers.enable({ apis: ['Date'] });
  globalThis.fetch = async () => {
    t.mock.timers.tick(50);
    throw new Error('timeout');
  };
  try {
    await assert.rejects(() => createTrackedFetch('hltb')('search', 'u'));
    const entry = getMetrics().sinceRestart.groups.hltb.search;
    assert.equal(entry.avgLatencyMs, 50);
    assert.equal(entry.maxLatencyMs, 50);
  } finally {
    globalThis.fetch = restore;
  }
});

test('recordLimiterTrip: counts trips per limiter name under sinceRestart, absent for one never tripped', () => {
  recordLimiterTrip('details');
  recordLimiterTrip('details');
  recordLimiterTrip('search');

  const { sinceRestart } = getMetrics();
  assert.equal(sinceRestart.rateLimiters.details, 2);
  assert.equal(sinceRestart.rateLimiters.search, 1);
  assert.equal(sinceRestart.rateLimiters.gameSearch, undefined);
});

test('recordLimiterTrip: lastHour drops trips older than an hour but sinceRestart keeps them', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  recordLimiterTrip('details');
  t.mock.timers.tick(61 * 60 * 1000);
  recordLimiterTrip('details');

  const { sinceRestart, lastHour } = getMetrics();
  assert.equal(sinceRestart.rateLimiters.details, 2);
  assert.equal(lastHour.rateLimiters.details, 1);
});

test('recordDedupHit: counts hits per name under sinceRestart, ignores an unnamed (undefined) dedup instance', () => {
  recordDedupHit('steam');
  recordDedupHit('steam');
  recordDedupHit('itad');
  recordDedupHit(undefined);

  const { sinceRestart } = getMetrics();
  assert.equal(sinceRestart.dedupHits.steam, 2);
  assert.equal(sinceRestart.dedupHits.itad, 1);
  assert.equal(Object.keys(sinceRestart.dedupHits).length, 2);
});

test('recordDedupHit: lastHour drops hits older than an hour but sinceRestart keeps them', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  recordDedupHit('steam');
  t.mock.timers.tick(61 * 60 * 1000);
  recordDedupHit('steam');

  const { sinceRestart, lastHour } = getMetrics();
  assert.equal(sinceRestart.dedupHits.steam, 2);
  assert.equal(lastHour.dedupHits.steam, 1);
});

test('recordCacheEvent: tallies hits/misses/forced per group under sinceRestart', () => {
  recordCacheEvent('library', 'hits');
  recordCacheEvent('library', 'hits');
  recordCacheEvent('library', 'misses');
  recordCacheEvent('library', 'forced');
  recordCacheEvent('rating', 'misses');

  const { sinceRestart } = getMetrics();
  assert.deepEqual(sinceRestart.cacheHits.library, { hits: 2, misses: 1, forced: 1 });
  assert.deepEqual(sinceRestart.cacheHits.rating, { hits: 0, misses: 1, forced: 0 });
});

test('recordCacheEvent: lastHour drops events older than an hour but sinceRestart keeps them', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  recordCacheEvent('library', 'hits');
  t.mock.timers.tick(61 * 60 * 1000);
  recordCacheEvent('library', 'misses');

  const { sinceRestart, lastHour } = getMetrics();
  assert.deepEqual(sinceRestart.cacheHits.library, { hits: 1, misses: 1, forced: 0 });
  assert.deepEqual(lastHour.cacheHits.library, { hits: 0, misses: 1, forced: 0 });
});

test('getMetrics: lastHour keeps exactly the last hour as the window rolls over', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200 }));
  // One event of each kind per minute (fetches every 15) for 90 minutes: the window wraps once and reuses its oldest minutes.
  for (let minute = 0; minute < 90; minute++) {
    if (minute % 15 === 0) await createTrackedFetch('hltb')('search', 'u'); // stays under OUTBOUND_HOURLY_MAX
    recordLimiterTrip('details');
    recordDedupHit('steam');
    recordCacheEvent('library', minute % 2 ? 'hits' : 'misses');
    t.mock.timers.tick(60 * 1000);
  }
  t.mock.timers.setTime(89.5 * 60 * 1000); // halfway through the last recorded minute

  const { sinceRestart, lastHour } = getMetrics();
  assert.equal(sinceRestart.groups.hltb.search.requests, 6);
  assert.equal(lastHour.groups.hltb.search.requests, 4);
  assert.deepEqual(lastHour.groups.hltb.search.statusCounts, { 200: 4 });
  assert.equal(lastHour.rateLimiters.details, 60);
  assert.equal(lastHour.dedupHits.steam, 60);
  assert.deepEqual(lastHour.cacheHits.library, { hits: 30, misses: 30, forced: 0 });
});

test('getMetrics: lastHour drops an event at the start of its 61st minute', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  recordDedupHit('steam');
  t.mock.timers.setTime(60 * 60 * 1000 - 1);
  assert.equal(getMetrics().lastHour.dedupHits.steam, 1);
  t.mock.timers.setTime(60 * 60 * 1000);
  assert.equal(getMetrics().lastHour.dedupHits.steam, 0);
});

test('getMetrics: lastHour ignores minutes ahead of a clock stepped back', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  t.mock.timers.setTime(30 * 60 * 1000);
  recordDedupHit('steam');
  t.mock.timers.setTime(10 * 60 * 1000);
  assert.equal(getMetrics().lastHour.dedupHits.steam, 0);
});

test('getMetrics: includes a stable "since" timestamp', () => {
  const { since } = getMetrics();
  assert.equal(typeof since, 'number');
  assert.ok(since <= Date.now());
});

test('_reset: clears all counters, including rate-limiter trips, dedup hits, and cache events', async () => {
  const restore = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  try {
    await createTrackedFetch('hltb')('search', 'u1');
    recordLimiterTrip('details');
    recordDedupHit('steam');
    recordCacheEvent('library', 'hits');
    assert.equal(getMetrics().sinceRestart.groups.hltb.search.requests, 1);
    _reset();
    const metrics = getMetrics();
    assert.deepEqual(metrics.sinceRestart.groups, {});
    assert.deepEqual(metrics.sinceRestart.rateLimiters, {});
    assert.deepEqual(metrics.sinceRestart.dedupHits, {});
    assert.deepEqual(metrics.sinceRestart.cacheHits, {});
  } finally {
    globalThis.fetch = restore;
  }
});

// ── outbound budgets ──────────────────────────────────────────────────────────

test('trackedFetch: refuses calls past the hourly budget, per group', async (t) => {
  _reset();
  const restore = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200 });
  t.after(() => {
    globalThis.fetch = restore;
  });
  t.mock.method(console, 'warn', () => {});

  const max = Number(process.env.OUTBOUND_HOURLY_MAX);
  for (let i = 0; i < max; i++) await createTrackedFetch('grp')('label', 'u');
  await assert.rejects(() => createTrackedFetch('grp')('label', 'u'), /budget for grp exhausted/);
  // A refused call isn't a request this process made, so it must not be counted as one.
  assert.equal(getMetrics().sinceRestart.groups.grp.label.requests, max);
  // Budgets are per group — another service is unaffected.
  await createTrackedFetch('other')('label', 'u');
  assert.equal(getMetrics().sinceRestart.groups.other.label.requests, 1);
});

test('getMetrics: reports per-group budget usage', async (t) => {
  _reset();
  const restore = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200 });
  t.after(() => {
    globalThis.fetch = restore;
  });

  await createTrackedFetch('grp')('label', 'u');
  const b = getMetrics().budgets.grp;
  assert.equal(b.hourUsed, 1);
  assert.equal(b.dayUsed, 1);
  assert.equal(b.hourMax, Number(process.env.OUTBOUND_HOURLY_MAX));
});

test('getMetrics: lists a bound outbound group at 0 used before its first call', () => {
  createTrackedFetch('bound-only');
  assert.deepEqual(getMetrics().budgets['bound-only'], {
    hourUsed: 0,
    hourMax: Number(process.env.OUTBOUND_HOURLY_MAX),
    hourTopClient: 0,
    dayUsed: 0,
    dayMax: Number(process.env.OUTBOUND_DAILY_MAX),
    dayTopClient: 0,
  });
});

test('getMetrics: reading budgets does not start a group’s window', async (t) => {
  _reset();
  t.mock.timers.enable({ apis: ['Date'] });
  const restore = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200 });
  t.after(() => {
    globalThis.fetch = restore;
  });

  getMetrics();
  t.mock.timers.tick(50 * 60 * 1000);
  await createTrackedFetch('hltb')('search', 'u');
  t.mock.timers.tick(15 * 60 * 1000);
  // The hour runs from the first call, not from the earlier read.
  assert.equal(getMetrics().budgets.hltb.hourUsed, 1);
});

test('trackedFetch: refuses calls past the daily budget until the day rolls over', async (t) => {
  _reset();
  t.mock.timers.enable({ apis: ['Date'] });
  const restore = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200 });
  t.after(() => {
    globalThis.fetch = restore;
  });
  const warnMock = t.mock.method(console, 'warn', () => {});

  // Spend it one hourly budget per hour, so only the daily cap can refuse.
  const hourly = Number(process.env.OUTBOUND_HOURLY_MAX);
  const daily = Number(process.env.OUTBOUND_DAILY_MAX);
  for (let spent = 0; spent < daily; spent += hourly) {
    for (let i = 0; i < hourly; i++) await createTrackedFetch('grp')('label', 'u');
    t.mock.timers.tick(60 * 60 * 1000);
  }
  await assert.rejects(() => createTrackedFetch('grp')('label', 'u'), /budget for grp exhausted/);
  assert.ok(warnMock.mock.calls.some((c) => /daily outbound budget exhausted/.test(c.arguments[0])));
  assert.equal(getMetrics().budgets.grp.dayUsed, daily);

  // 24 h after the day's first call, the count starts over.
  t.mock.timers.setTime(24 * 60 * 60 * 1000);
  await createTrackedFetch('grp')('label', 'u');
  assert.equal(getMetrics().budgets.grp.dayUsed, 1);
});

test('getMetrics: daily counts each status, and network failures, per UTC day, group and label', async (t) => {
  let fail = false;
  t.mock.method(globalThis, 'fetch', async () => {
    if (fail) throw new TypeError('fetch failed');
    return { ok: true, status: 200 };
  });
  const call = createTrackedFetch('grp');
  await call('getA', 'https://example.com/');
  await call('getA', 'https://example.com/');
  fail = true;
  await assert.rejects(() => call('getA', 'https://example.com/'));
  const day = new Date().toISOString().slice(0, 10);
  assert.deepEqual(
    getMetrics().daily.map((r) => ({ ...r })),
    [
      { day, group: 'grp', label: 'getA', status: '200', count: 2 },
      { day, group: 'grp', label: 'getA', status: 'network', count: 1 },
    ],
  );
});

test('trackedFetch: a failed daily-count write still returns the response', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, marker: 'res' }));
  const warn = t.mock.method(console, 'warn', () => {});
  db.exec("CREATE TEMP TRIGGER fail_daily BEFORE INSERT ON metrics_daily BEGIN SELECT RAISE(FAIL, 'disk full'); END");
  t.after(() => db.exec('DROP TRIGGER fail_daily'));
  assert.equal((await createTrackedFetch('grp')('getA', 'https://example.com/')).marker, 'res');
  assert.deepEqual(
    warn.mock.calls.map((c) => c.arguments.join(' ')),
    ['[metrics] daily count not saved: disk full'],
  );
});

test('getMetrics: daily drops days older than 30 at the first call of a day', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200 }));
  const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const insert = db.prepare("INSERT INTO metrics_daily VALUES (?, 'grp', 'getA', '302', 1)");
  insert.run(daysAgo(31));
  insert.run(daysAgo(29));
  await createTrackedFetch('grp')('getA', 'https://example.com/');
  assert.deepEqual(
    getMetrics().daily.map((r) => r.day),
    [daysAgo(29), daysAgo(0)],
  );
});

test('startEventLoopSampling: records one sample per minute under eventLoop, absent before the first', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.parse('2026-11-02T10:00:30Z') });
  const stop = startEventLoopSampling();
  try {
    assert.equal(getMetrics().sinceRestart.eventLoop, undefined);
    assert.equal(getMetrics().lastHour.eventLoop, undefined);
    t.mock.timers.tick(60 * 1000);
    t.mock.timers.tick(60 * 1000);
    const { sinceRestart, lastHour } = getMetrics();
    assert.deepEqual(lastHour.eventLoop, sinceRestart.eventLoop);
    const { minutes, utilization, maxP99DelayMs, maxDelayMs } = sinceRestart.eventLoop;
    assert.equal(minutes, 2);
    assert.ok(utilization >= 0 && utilization <= 1, `utilization ${utilization}`);
    assert.ok(Number.isInteger(maxP99DelayMs) && Number.isInteger(maxDelayMs));
    assert.ok(maxP99DelayMs <= maxDelayMs);
  } finally {
    stop();
  }
});

test('getMetrics: a live process snapshot in MB, with no db file sizes for an in-memory database', () => {
  const { process: proc } = getMetrics();
  for (const key of ['rssMb', 'maxRssMb', 'heapUsedMb', 'externalMb']) assert.ok(proc[key] > 0, key);
  assert.ok(proc.maxRssMb >= proc.rssMb - 1);
  assert.equal(proc.dbMb, null);
  assert.equal(proc.dbWalMb, null);
});
