'use strict';

// In-memory counters for outbound requests to third-party services (Steam, HLTB, ITAD,
// ProtonDB), grouped by trust-tier/routing boundary — the same boundaries lib/steam.js's own
// semaphores (storeLimit/tagLimit/protonLimit) and the lib/hltb.js/lib/itad.js module split
// already draw — and then by the specific function making the call, so a stall in one
// specific operation (e.g. resolveItadIds succeeding while getPrices doesn't) is visible
// rather than folded into one flat per-service count. See docs/dev/observability.md.
//
// In memory, reset on restart, except the per-day status counts (`daily`), which db.sqlite keeps
// so a change in an upstream's answers can be dated after the fact.
const startedAt = Date.now();
const groups = Object.create(null);

// The last hour answers "is this happening now", which lifetime totals can't; kept as one bucket
// per minute, so recording is O(1) and memory bounded (resolution: docs/dev/observability.md).
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const WINDOW_MINUTES = HOUR_MS / MINUTE_MS;

// Adds every number of `bucket` into `total`, nested maps included; a `…Max` field keeps the largest.
// A `…Max` field keeps the largest, and its optional `…MaxAt` sibling keeps when that largest happened;
// a `…Min` field keeps the smallest.
function addInto(total, bucket) {
  for (const [k, v] of Object.entries(bucket)) {
    if (typeof v === 'object') addInto((total[k] ??= {}), v);
    else if (k.endsWith('Min')) {
      if (!(k in total) || v < total[k]) total[k] = v;
    } else if (k.endsWith('Max')) {
      if (!(k in total) || v > total[k]) {
        total[k] = v;
        if (`${k}At` in bucket) total[`${k}At`] = bucket[`${k}At`];
      }
    } else if (!k.endsWith('MaxAt')) total[k] = (total[k] ?? 0) + v;
  }
  return total;
}

function createWindow(empty) {
  const slots = new Array(WINDOW_MINUTES);
  return {
    current() {
      const minute = Math.floor(Date.now() / MINUTE_MS);
      const i = minute % WINDOW_MINUTES;
      if (slots[i]?.minute !== minute) slots[i] = { minute, bucket: empty() };
      return slots[i].bucket;
    },
    // Filtered at read time: a quiet name's slots go stale, and a clock stepped back leaves some ahead.
    sum() {
      const now = Math.floor(Date.now() / MINUTE_MS);
      return slots
        .filter((s) => s.minute > now - WINDOW_MINUTES && s.minute <= now)
        .reduce((total, s) => addInto(total, s.bucket), empty());
    },
  };
}

// ── Outbound budgets ─────────────────────────────────────────────────────────
//
// A hard ceiling on how many calls this process will make to one third-party service per hour
// and per day, enforced right here because this is the single point every outbound call in the
// app already passes through. It is a backstop, not a throttle: the numbers are meant to sit
// well above normal traffic (read GET /api/metrics' own `sinceRestart` to size them), so
// nothing legitimate ever reaches them.
//
// It's the only measure that protects the app's *keys* rather than any one client. Every rate
// limiter in server.js is per-IP, so a handful of clients — or one bug in this app's own code
// retrying in a loop — can multiply upstream volume without any single one of them tripping a
// limit; a Steam or ITAD key has a quota that doesn't care how many IPs spent it. Failing here
// degrades the app for an hour; exhausting the key takes it down until someone intervenes.
//
// Fixed windows, not sliding ones: a window's count resets when the window rolls over. That's
// cruder than the per-minute `lastHour` window above, but this runs on every single outbound call
// and only needs to answer "have we spent too much", so it stays a single count rather than
// summing a window's buckets each time.
const DAY_MS = 24 * HOUR_MS;
const { AsyncLocalStorage } = require('node:async_hooks');
const { OUTBOUND_HOURLY_MAX, OUTBOUND_DAILY_MAX, OUTBOUND_CLIENT_SHARE_PERCENT } = require('./config');
const { upstreamError } = require('./upstream');
const { db, DB_PATH } = require('./db');
const fs = require('node:fs');
const budgets = Object.create(null);
// Filled by createTrackedFetch at module load, so GET /api/metrics shows each ceiling before the first call.
const budgetGroups = new Set();

// One client's ceiling within a window: OUTBOUND_CLIENT_SHARE_PERCENT of it, at least 1; 0 = no share.
const clientMaxOf = (max) =>
  max > 0 && OUTBOUND_CLIENT_SHARE_PERCENT > 0
    ? Math.max(1, Math.floor((max * OUTBOUND_CLIENT_SHARE_PERCENT) / 100))
    : 0;

const WINDOWS = [
  { key: 'hour', name: 'hourly', ms: HOUR_MS, max: OUTBOUND_HOURLY_MAX },
  { key: 'day', name: 'daily', ms: DAY_MS, max: OUTBOUND_DAILY_MAX },
].map((w) => ({ ...w, clientMax: clientMaxOf(w.max) }));

// The client (server.js's rate-limit key) a request's outbound calls are charged to; unset outside a request.
const clientContext = new AsyncLocalStorage();
const runAsClient = (client, fn) => clientContext.run(client, fn);
const currentClient = () => clientContext.getStore();

function budgetFor(group) {
  const now = Date.now();
  const b = (budgets[group] ??= {});
  for (const { key, ms } of WINDOWS) {
    if (!b[key] || now - b[key].start >= ms)
      b[key] = { start: now, count: 0, warned: false, clients: new Map(), topClient: 0 };
  }
  return b;
}

// Throws (rather than returning false) so a caller needs no new error path of its own — the
// thrown error is marked isUpstream, exactly like an upstream failure, which every route's
// catch block already maps to a 502 with the message shown to the user. Warns once per window
// per group: past the ceiling every subsequent call would log the same line, which is the
// per-request spam the circuit-breaker warning was deliberately shaped to avoid (see docs/dev/observability.md's
// server-logs section). A client past its share gets isClientBudgetExhausted too, which routes answer 429.
function chargeBudget(group) {
  const b = budgetFor(group);
  for (const { key, name, ms, max } of WINDOWS) {
    const w = b[key];
    if (!(max > 0 && w.count >= max)) continue;
    if (!w.warned) {
      w.warned = true;
      console.warn(
        `[budget:${group}] ${name} outbound budget exhausted (${w.count}/${max}) — refusing further calls until ${new Date(w.start + ms).toISOString()}`,
      );
    }
    throw Object.assign(upstreamError(`Upstream budget for ${group} exhausted — try again later`), {
      isBudgetExhausted: true,
      isLogged: true,
    });
  }
  // One client may spend only its share, so it can't run the service dry for everyone else.
  const client = currentClient();
  const shares = client === undefined ? [] : WINDOWS.filter((w) => w.clientMax > 0).map((w) => [w, b[w.key]]);
  for (const [{ name, ms, clientMax }, w] of shares) {
    const c = w.clients.get(client);
    if (!(c && c.count >= clientMax)) continue;
    if (!c.warned) {
      c.warned = true;
      // No IP: the log line names the event, not who caused it.
      console.warn(
        `[budget:${group}] a client spent its ${name} share (${clientMax}) — refusing its further calls until ${new Date(w.start + ms).toISOString()}`,
      );
    }
    const when = name === 'hourly' ? 'this hour' : 'today';
    throw Object.assign(
      upstreamError(
        `Too many new lookups from your network ${when}. What's already loaded still works; try again later.`,
      ),
      { isBudgetExhausted: true, isClientBudgetExhausted: true, isLogged: true },
    );
  }
  b.hour.count++;
  b.day.count++;
  for (const [, w] of shares) {
    let c = w.clients.get(client);
    if (!c) w.clients.set(client, (c = { count: 0, warned: false }));
    c.count++;
    // Kept as it grows: a read never scans a window's clients.
    w.topClient = Math.max(w.topClient, c.count);
  }
}

// Live per-group usage of the budget windows; the ceilings, the same for every group, are in budgetCeilings.
function getBudgets() {
  const now = Date.now();
  // Read-only: a window starts at its group's first charge, never at a read.
  const live = (group, key, ms) => {
    const w = budgets[group]?.[key];
    return w && now - w.start < ms ? w : undefined;
  };
  const out = {};
  for (const group of new Set([...budgetGroups, ...Object.keys(budgets)])) {
    const hour = live(group, 'hour', HOUR_MS);
    const day = live(group, 'day', DAY_MS);
    out[group] = {
      hourUsed: hour?.count ?? 0,
      hourTopClient: hour?.topClient ?? 0,
      dayUsed: day?.count ?? 0,
      dayTopClient: day?.topClient ?? 0,
    };
  }
  return out;
}

// Fixed log-scale latency buckets (upper bounds, ms): O(1) to record, summed by addInto, read as p50/p95.
const LATENCY_EDGES = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const latencyBucket = (ms) => {
  const edge = LATENCY_EDGES.find((e) => ms <= e);
  return edge ? `le${edge}` : 'over';
};
// The upper bound of the bucket holding the `p` quantile, capped by the largest latency seen.
function percentile(buckets, p, max) {
  const count = Object.values(buckets).reduce((a, b) => a + b, 0);
  if (!count) return null;
  let seen = 0;
  for (const edge of LATENCY_EDGES) {
    seen += buckets[`le${edge}`] ?? 0;
    if (seen >= count * p) return Math.min(edge, max);
  }
  return max;
}

// Lifetime-since-restart totals plus the same totals per minute in `window`, for `lastHour`; a call counts when it ends.
function counterFor(group, label) {
  if (!groups[group]) groups[group] = Object.create(null);
  if (!groups[group][label]) groups[group][label] = { total: {}, window: createWindow(() => ({})) };
  return groups[group][label];
}

// One call's outcome (`status`, or 'network', as recordDaily takes it). Latency covers every outcome — a
// timeout's duration is itself a signal. Unexpected: a network error, or a 4xx/5xx the caller didn't declare.
function recordOutcome(counter, status, durationMs, expected) {
  const now = Date.now();
  const network = status === 'network';
  const bucket = {
    requests: 1,
    statuses: network ? {} : { [status]: 1 },
    networkErrors: +network,
    latencySum: durationMs,
    latencyMax: durationMs,
    latencyBuckets: { [latencyBucket(durationMs)]: 1 },
    ...((network || (status >= 400 && !expected.includes(status))) && {
      unexpected: 1,
      unexpectedFirstMin: now,
      unexpectedLastMax: now,
    }),
  };
  addInto(counter.total, bucket);
  addInto(counter.window.current(), bucket);
}

const TIMEOUT_MS = 10000;

// ── Daily status counts ──────────────────────────────────────────────────────
//
// One row per UTC day, group, label and status (or `network`), bumped on every outbound call and
// dropped after DAILY_RETENTION_DAYS. Public via GET /api/metrics, so labels must stay function
// names, never built from a request (a Steam ID would be published and kept for a month).
const DAILY_RETENTION_DAYS = 30;
const dailyStmts = {
  bump: db.prepare(
    `INSERT INTO metrics_daily (day, grp, label, status, count) VALUES (?, ?, ?, ?, 1)
     ON CONFLICT (day, grp, label, status) DO UPDATE SET count = count + 1`,
  ),
  prune: db.prepare('DELETE FROM metrics_daily WHERE day < ?'),
  list: db.prepare('SELECT day, grp, label, status, count FROM metrics_daily ORDER BY day DESC, grp, label, status'),
};
let dailyDay;

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

function recordDaily(group, label, status) {
  const now = Date.now();
  const day = utcDay(now);
  try {
    if (day !== dailyDay) {
      dailyDay = day;
      dailyStmts.prune.run(utcDay(now - DAILY_RETENTION_DAYS * DAY_MS));
    }
    dailyStmts.bump.run(day, group, label, String(status));
  } catch (err) {
    // A metrics write must never fail the request it counts.
    console.warn('[metrics] daily count not saved:', err.message);
  }
}

// Drop-in replacement for a bare `fetch(url, opts)` call — same signature/return value (a
// Response, or a rethrown error), just counted first. `group`/`label` are metrics-only, never
// sent upstream. Times out after TIMEOUT_MS unless `opts.signal` says otherwise.
//
// Outcomes are bucketed by raw HTTP status code (`statuses`), not collapsed into a single
// "errors" count — plenty of non-2xx responses in this app are expected business outcomes for
// one specific label (e.g. a 403 from getPlayerAchievements means "private profile", not a
// failure), so a blanket error count would conflate those with a genuine problem like a
// 429/403 storm on steam-store. `networkErrors` (fetch() itself throwing — timeout, DNS,
// abort) is unambiguous everywhere, so it does get its own counter. See docs/dev/observability.md
// for how to read a given label's status codes.
// `opts.expected`: the 4xx/5xx statuses this call treats as an answer (403 = private profile…), never sent.
async function trackedFetch(group, label, url, { expected = [], ...opts } = {}) {
  // Before the counter, and before fetch(): a refused call is one this process never makes, so
  // it must not show up as an outbound request in the numbers below.
  chargeBudget(group);
  const counter = counterFor(group, label);
  const start = Date.now();
  try {
    const res = await fetch(url, opts.signal ? opts : { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
    recordOutcome(counter, res.status, Date.now() - start, expected);
    recordDaily(group, label, res.status);
    return res;
  } catch (err) {
    recordOutcome(counter, 'network', Date.now() - start, expected);
    recordDaily(group, label, 'network');
    // DNS, ECONNRESET… (`TypeError: fetch failed`) is the upstream's failure; a timeout stays a 504.
    if (err.name !== 'TimeoutError') err.isUpstream = true;
    throw err;
  }
}

// The only way modules reach trackedFetch: binding a group once registers its budget.
function createTrackedFetch(group) {
  budgetGroups.add(group);
  return (label, url, opts) => trackedFetch(group, label, url, opts);
}

// Fewer calls than this make a bucketed quantile misleading: it reads null rather than one call's bucket bound.
const QUANTILE_MIN_SAMPLES = 10;
// Latency fields shared by outbound labels and inbound routes.
const latencyFields = ({ requests = 0, latencySum = 0, latencyMax = 0, latencyBuckets = {} }) => {
  const quantile = (p) => (requests < QUANTILE_MIN_SAMPLES ? null : percentile(latencyBuckets, p, latencyMax));
  return {
    avgMs: requests ? Math.round(latencySum / requests) : null,
    p50Ms: quantile(0.5),
    p95Ms: quantile(0.95),
    maxMs: requests ? latencyMax : null,
  };
};

const isoOrNull = (ms) => (ms === undefined ? null : new Date(ms).toISOString());

// One label's entry, from its lifetime totals or a window's sum.
function labelEntry(totals) {
  const { requests = 0, statuses = {}, networkErrors = 0, unexpected = 0 } = totals;
  return {
    requests,
    statuses: { ...statuses },
    networkErrors,
    unexpected,
    ...(unexpected && {
      firstUnexpectedAt: isoOrNull(totals.unexpectedFirstMin),
      lastUnexpectedAt: isoOrNull(totals.unexpectedLastMax),
    }),
    ...latencyFields(totals),
  };
}

// One window's `outbound` (`sinceRestart` or `lastHour`): label entries under their group, no group total
// (sum the labels if needed); a label or group with no call in the window is left out.
function buildOutbound(toLabelEntry) {
  const out = {};
  for (const group of Object.keys(groups)) {
    for (const label of Object.keys(groups[group])) {
      const entry = toLabelEntry(groups[group][label]);
      if (entry.requests) (out[group] ??= {})[label] = entry;
    }
  }
  return out;
}

// A count per name, windowed like everything else here: limiter trips, dedup hits, held lookups.
function createNamedCounter() {
  const totals = createTotals();
  return {
    record: (name) => name && totals.record(name, { count: 1 }), // an unnamed createDedup() opts out
    summarize: () => totals.summarize(({ count = 0 }) => count),
    reset: totals.reset,
  };
}

// Windowed totals of a bucket of numbers per name, summed with addInto (a `…Max` field keeps the largest).
function createTotals() {
  const entries = Object.create(null);
  return {
    record(name, bucket) {
      const entry = (entries[name] ??= { total: {}, window: createWindow(() => ({})) });
      addInto(entry.total, bucket);
      addInto(entry.window.current(), bucket);
    },
    summarize(toEntry) {
      const map = (read) =>
        Object.fromEntries(Object.keys(entries).map((name) => [name, toEntry(read(entries[name]))]));
      return { sinceRestart: map((e) => e.total), lastHour: map((e) => e.window.sum()) };
    },
    reset() {
      for (const key of Object.keys(entries)) delete entries[key];
    },
  };
}
const average = (sum, count) => (count ? Math.round(sum / count) : null);

// Time a call waited for a rolling cap's place (lib/upstream.js's createWindow), per cap; a 429's retry waits again.
const windowWaits = createTotals();
const recordWindowWait = (name, ms) => windowWaits.record(name, { waits: 1, waitMsSum: ms, waitMsMax: ms });
const windowWaitEntry = ({ waits = 0, waitMsSum = 0, waitMsMax = 0 }) => ({
  waits,
  avgWaitMs: average(waitMsSum, waits),
  maxWaitMs: waitMsMax,
});

// One bucket per details stream, at its end (server.js): how lists load, to tune its pools and the store details cap.
const streamTotals = createTotals();
const recordStream = (bucket) => streamTotals.record('all', bucket);
const streamEntry = ({ cold = 0, listedMsSum = 0, listedMsMax = 0, doneMsSum = 0, doneMsMax = 0, ...counts }) => ({
  ...counts,
  cold,
  avgListedMs: average(listedMsSum, cold),
  maxListedMs: cold ? listedMsMax : null,
  avgDoneMs: average(doneMsSum, cold),
  maxDoneMs: cold ? doneMsMax : null,
});

// Inbound requests per route pattern (server.js), at `close`: which endpoint is slow, and since when.
const routeTotals = createTotals();
// `route` is a pattern (`GET /api/x/:id`), never a filled URL: no appid or Steam ID is published.
function recordRequest(route, { status, ms, bytes, aborted }) {
  routeTotals.record(route, {
    requests: 1,
    statusClasses: status === null ? {} : { [`${Math.floor(status / 100)}xx`]: 1 }, // null: left before any reply
    aborted: aborted ? 1 : 0,
    bytes,
    sized: bytes ? 1 : 0, // a chunked reply (the details stream) has no Content-Length
    latencySum: ms,
    latencyMax: ms,
    latencyBuckets: { [latencyBucket(ms)]: 1 },
    ...(status >= 500 && { serverErrorFirstMin: Date.now(), serverErrorLastMax: Date.now() }),
  });
}
const routeEntry = ({ statusClasses = {}, aborted = 0, bytes = 0, sized = 0, serverErrorFirstMin, ...latency }) => ({
  requests: latency.requests ?? 0,
  statusClasses,
  ...(serverErrorFirstMin !== undefined && {
    firstServerErrorAt: isoOrNull(serverErrorFirstMin),
    lastServerErrorAt: isoOrNull(latency.serverErrorLastMax),
  }),
  aborted,
  avgBytes: average(bytes, sized),
  ...latencyFields(latency),
});

// The event loop, sampled once a minute while the server runs: tells the server's own synchronous work
// (cache rows parsed, node:sqlite's calls) apart from a slow upstream, whose wait never blocks it.
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const loopTotals = createTotals();
const loopEntry = ({ minutes = 0, activeMs = 0, idleMs = 0, p99DelayMsMax = 0, delayMsMax = 0, delayMsMaxAt }) => ({
  minutes,
  busyPercent: activeMs + idleMs ? Math.round((activeMs / (activeMs + idleMs)) * 1000) / 10 : null,
  maxP99DelayMs: p99DelayMsMax,
  maxDelayMs: delayMsMax,
  maxDelayAt: isoOrNull(delayMsMaxAt), // end of the minute that held it
});

// Returns a stop function (tests).
function startEventLoopSampling() {
  const delay = monitorEventLoopDelay();
  delay.enable();
  let last = performance.eventLoopUtilization();
  const timer = setInterval(() => {
    const now = performance.eventLoopUtilization();
    const { active, idle } = performance.eventLoopUtilization(now, last);
    last = now;
    loopTotals.record('all', {
      minutes: 1,
      activeMs: active,
      idleMs: idle,
      p99DelayMsMax: Math.round(delay.percentile(99) / 1e6),
      delayMsMax: Math.round(delay.max / 1e6),
      delayMsMaxAt: Date.now(),
    });
    delay.reset();
  }, MINUTE_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    delay.disable();
  };
}

// Lookups a hold-off answered without a request (lib/hltb.js's failed-lookup hold), per upstream.
const heldCounter = createNamedCounter();
const recordHeldLookup = (name) => heldCounter.record(name);

// Our own express-rate-limit rejections (server.js's namedRateLimit), per limiter: inbound, apart from `outbound`.
const limiterCounter = createNamedCounter();
const recordLimiterTrip = (name) => limiterCounter.record(name);

// Concurrent calls lib/dedup.js's createDedup() coalesced, per named instance: a burst points at a retry loop.
const dedupCounter = createNamedCounter();
const recordDedupHit = (name) => dedupCounter.record(name);

// lib/cache.js's getCached() outcomes per group: windowed, so a hit-rate collapse shows within the hour.
const cacheTotals = createTotals();

// `outcome` is one of 'hits'/'misses'/'forced' — see lib/cache.js's getCached().
const recordCacheEvent = (group, outcome) => cacheTotals.record(group, { [outcome]: 1 });
const cacheEntry = ({ hits = 0, misses = 0, forced = 0 }) => ({ hits, misses, forced });

// Live snapshot: a memory leak, or db.sqlite and its WAL growing.
const toMb = (bytes) => Math.round((bytes / 2 ** 20) * 10) / 10;
function fileMb(file) {
  if (DB_PATH === ':memory:') return null;
  try {
    return toMb(fs.statSync(file).size);
  } catch {
    return null; // no WAL right after a checkpoint
  }
}
function getProcessStats() {
  const { rss, heapUsed, external } = process.memoryUsage();
  return {
    rssMb: toMb(rss),
    maxRssMb: toMb(process.resourceUsage().maxRSS * 1024),
    heapUsedMb: toMb(heapUsed),
    externalMb: toMb(external),
    dbMb: fileMb(DB_PATH),
    dbWalMb: fileMb(`${DB_PATH}-wal`),
  };
}

// `{ [day]: { [group]: { [label]: { [status]: count } } } }`, newest day first.
function getDaily() {
  const out = {};
  for (const { day, grp, label, status, count } of dailyStmts.list.all())
    (((out[day] ??= {})[grp] ??= {})[label] ??= {})[status] = count;
  return out;
}

// Every live state per outbound group, so one object answers "is this upstream OK": its budget, and its
// circuit breaker, semaphores, rolling caps and held lookups when it has them.
function buildUpstreams({ upstreamStats = {}, breakers = {}, held = {} }) {
  const budgetsNow = getBudgets();
  const names = new Set([...Object.keys(budgetsNow), ...Object.keys(upstreamStats), ...Object.keys(breakers)]);
  const out = {};
  for (const group of [...names].sort()) {
    out[group] = {
      budget: budgetsNow[group],
      ...(breakers[group] && { breaker: breakers[group] }),
      ...upstreamStats[group],
      ...(held[group] !== undefined && { held: held[group] }),
    };
  }
  return out;
}

// One window's signals (`key`: 'sinceRestart' or 'lastHour'), each `{ sinceRestart, lastHour }` in `parts`.
// A name with no event in the window is left out, so the first hour after a start reads the same in both.
function buildWindow(key, parts) {
  const busy = (map, isBusy) => Object.fromEntries(Object.entries(map[key]).filter(([, v]) => isBusy(v)));
  const { streams, eventLoop } = parts;
  return {
    outbound: parts.outbound[key],
    inbound: busy(parts.routes, (r) => r.requests),
    limiterTrips: busy(parts.limiterTrips, Boolean),
    dedupHits: busy(parts.dedupHits, Boolean),
    cache: busy(parts.cache, (c) => c.hits + c.misses + c.forced),
    windowWaits: busy(parts.waits, (w) => w.waits),
    heldAnswers: busy(parts.heldAnswers, Boolean),
    ...(streams[key].all?.count && { streams: streams[key].all }),
    ...(eventLoop[key].all?.minutes && { eventLoop: eventLoop[key].all }),
  };
}

// What `getAlerts` reads as wrong; each threshold sits above one blip so the list stays short when all is well.
const ALERT = {
  unexpectedPerLabel: 3, // a network blip or one 429 stays quiet; a storm shows
  budgetShare: 0.8,
  loopDelayMs: 1000,
  startupMs: 2 * MINUTE_MS, // loading the cache blocks the loop at start
  // Live bundles whose ITAD end date must all match an override's before it's called removable; one
  // Fanatical match proves nothing (ITAD had 1 of 12 right), and there's one Humble Choice a month.
  itadAgreeMin: { Fanatical: 3, 'Humble Choice': 1 },
};

// What's wrong now, from a composed metrics body: warnings first, then information. Pure, for its tests.
function getAlerts(m, now = Date.now()) {
  const warn = [];
  const info = [];
  const hour = m.lastHour;
  for (const [group, labels] of Object.entries(hour.outbound)) {
    for (const [label, e] of Object.entries(labels)) {
      if (e.unexpected < ALERT.unexpectedPerLabel) continue;
      const codes = Object.entries(e.statuses)
        .filter(([code]) => code >= 400)
        .map(([code, n]) => `${code} × ${n}`);
      if (e.networkErrors) codes.push(`network × ${e.networkErrors}`);
      warn.push({
        level: 'warn',
        where: `${group}.${label}`,
        message: `${e.unexpected} unexpected answers in the last hour (${codes.join(', ')})`,
        firstAt: e.firstUnexpectedAt,
        lastAt: e.lastUnexpectedAt,
      });
    }
  }
  for (const [route, r] of Object.entries(hour.inbound)) {
    const n = r.statusClasses['5xx'];
    if (n)
      warn.push({
        level: 'warn',
        where: route,
        message: `${n} server error${n > 1 ? 's' : ''} in the last hour`,
        firstAt: r.firstServerErrorAt,
        lastAt: r.lastServerErrorAt,
      });
  }
  const ceilings = { hour: m.budgetCeilings.hour, day: m.budgetCeilings.day };
  for (const [group, u] of Object.entries(m.upstreams)) {
    const until = u.breaker?.blockedUntil ?? 0;
    if (until > now)
      warn.push({ level: 'warn', where: `${group}.breaker`, message: `open until ${new Date(until).toISOString()}` });
    else if (until > now - HOUR_MS)
      info.push({ level: 'info', where: `${group}.breaker`, message: `tripped in the last hour, closed again` });
    const spent = Object.entries(ceilings)
      .filter(([key, max]) => max && u.budget[`${key}Used`] >= max * ALERT.budgetShare)
      .map(([key, max]) => `${u.budget[`${key}Used`]}/${max} this ${key}`);
    if (spent.length) warn.push({ level: 'warn', where: `${group}.budget`, message: spent.join(', ') });
    for (const [name, sem] of Object.entries(u.semaphores ?? {})) {
      if (sem.rejected)
        info.push({
          level: 'info',
          where: `${group}.semaphores.${name}`,
          message: `${sem.rejected} calls rejected since restart`,
        });
    }
  }
  const loop = hour.eventLoop;
  if (loop?.maxDelayMs >= ALERT.loopDelayMs && Date.parse(loop.maxDelayAt) - m.since > ALERT.startupMs)
    warn.push({
      level: 'warn',
      where: 'eventLoop',
      message: `blocked ${loop.maxDelayMs} ms in the last hour`,
      lastAt: loop.maxDelayAt,
    });
  for (const [name, n] of Object.entries(hour.limiterTrips))
    info.push({ level: 'info', where: `limiter ${name}`, message: `${n} requests refused in the last hour` });
  if (hour.streams?.limited)
    info.push({
      level: 'info',
      where: 'streams',
      message: `${hour.streams.limited} loads hit a client's budget share`,
    });
  for (const { source, agree, seen } of m.itadDates ?? [])
    if (agree === seen && seen >= (ALERT.itadAgreeMin[source] ?? Infinity))
      info.push({
        level: 'info',
        where: 'itad-dates',
        message: `ITAD's end dates match ${source}'s on ${agree}/${seen} live bundles: the override may be removable`,
      });
  if (now - m.since < HOUR_MS)
    info.push({ level: 'info', where: 'server', message: 'started less than an hour ago: lastHour is partial' });
  return [...warn, ...info];
}

// The whole GET /api/metrics body. `live` carries what other modules own (server.js composes it): the build,
// lib/upstream.js's semaphores and caps, the circuit breakers, HLTB's held games, open streams, cache rows,
// ITAD end dates against their overrides.
// Key order is reading order: what's live per upstream, the server, then the windows, then history.
function getMetrics({ version, commit, upstreamStats, breakers, held, openStreams, cacheEntries, itadDates } = {}) {
  const parts = {
    outbound: {
      sinceRestart: buildOutbound((c) => labelEntry(c.total)),
      lastHour: buildOutbound((c) => labelEntry(c.window.sum())),
    },
    routes: routeTotals.summarize(routeEntry),
    limiterTrips: limiterCounter.summarize(),
    dedupHits: dedupCounter.summarize(),
    cache: cacheTotals.summarize(cacheEntry),
    waits: windowWaits.summarize(windowWaitEntry),
    heldAnswers: heldCounter.summarize(),
    streams: streamTotals.summarize(streamEntry),
    eventLoop: loopTotals.summarize(loopEntry),
  };
  const body = {
    since: startedAt,
    version,
    commit,
    upstreams: buildUpstreams({ upstreamStats, breakers, held }),
    budgetCeilings: {
      hour: OUTBOUND_HOURLY_MAX || null,
      day: OUTBOUND_DAILY_MAX || null,
      clientSharePercent: OUTBOUND_CLIENT_SHARE_PERCENT || null,
    },
    server: { openStreams, process: getProcessStats(), cacheEntries },
    lastHour: buildWindow('lastHour', parts),
    sinceRestart: buildWindow('sinceRestart', parts),
    daily: getDaily(),
    itadDates,
  };
  const { since, ...rest } = body;
  return { since, version, commit, alerts: getAlerts(body), ...rest };
}

// Test-only: clears all counters so test files don't see counts left over from an earlier
// test in the same process (this module is a singleton, same "why _reset exists" reasoning
// as lib/cache.js's own `_reset`).
function _reset() {
  for (const key of Object.keys(groups)) delete groups[key];
  for (const key of Object.keys(budgets)) delete budgets[key];
  limiterCounter.reset();
  dedupCounter.reset();
  cacheTotals.reset();
  windowWaits.reset();
  streamTotals.reset();
  heldCounter.reset();
  loopTotals.reset();
  routeTotals.reset();
  db.exec('DELETE FROM metrics_daily');
  dailyDay = undefined;
}

module.exports = {
  createTrackedFetch,
  runAsClient,
  currentClient,
  recordLimiterTrip,
  recordDedupHit,
  recordCacheEvent,
  recordWindowWait,
  recordStream,
  recordRequest,
  recordHeldLookup,
  startEventLoopSampling,
  getMetrics,
  getAlerts,
  startedAt,
  _reset,
};
