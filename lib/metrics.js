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
function addInto(total, bucket) {
  for (const [k, v] of Object.entries(bucket)) {
    if (typeof v === 'object') addInto((total[k] ??= {}), v);
    else total[k] = k.endsWith('Max') ? Math.max(total[k] ?? 0, v) : (total[k] ?? 0) + v;
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

// Live snapshot for GET /api/metrics — outside sinceRestart/lastHour like circuitBreakers and
// semaphores, since a fixed window's current usage isn't a windowed counter of the same shape.
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
      hourMax: OUTBOUND_HOURLY_MAX || null,
      hourTopClient: hour?.topClient ?? 0,
      dayUsed: day?.count ?? 0,
      dayMax: OUTBOUND_DAILY_MAX || null,
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

const emptyOutcomes = () => ({
  requests: 0,
  statusCounts: {},
  networkErrors: 0,
  latencySum: 0,
  latencyMax: 0,
  latencyBuckets: {},
});

// Lifetime-since-restart totals plus the same totals per minute in `window`, for `lastHour`. The
// lifetime `requests` counts a call when it starts, a bucket's when it ends.
function counterFor(group, label) {
  if (!groups[group]) groups[group] = Object.create(null);
  if (!groups[group][label]) groups[group][label] = { ...emptyOutcomes(), window: createWindow(emptyOutcomes) };
  return groups[group][label];
}

// One call's outcome (`status`, or 'network', as recordDaily takes it) into a totals object. Latency
// covers every outcome — a timeout's duration is itself a signal, not just a successful response's.
function tally(totals, status, durationMs) {
  if (status === 'network') totals.networkErrors++;
  else totals.statusCounts[status] = (totals.statusCounts[status] || 0) + 1;
  totals.latencySum += durationMs;
  const bucket = latencyBucket(durationMs);
  totals.latencyBuckets[bucket] = (totals.latencyBuckets[bucket] || 0) + 1;
  if (durationMs > totals.latencyMax) totals.latencyMax = durationMs;
}

function recordOutcome(counter, status, durationMs) {
  const bucket = counter.window.current();
  bucket.requests++;
  tally(bucket, status, durationMs);
  tally(counter, status, durationMs);
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
  list: db.prepare(
    'SELECT day, grp AS "group", label, status, count FROM metrics_daily ORDER BY day, grp, label, status',
  ),
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
// Outcomes are bucketed by raw HTTP status code (`statusCounts`), not collapsed into a single
// "errors" count — plenty of non-2xx responses in this app are expected business outcomes for
// one specific label (e.g. a 403 from getPlayerAchievements means "private profile", not a
// failure), so a blanket error count would conflate those with a genuine problem like a
// 429/403 storm on steam-store. `networkErrors` (fetch() itself throwing — timeout, DNS,
// abort) is unambiguous everywhere, so it does get its own counter. See docs/dev/observability.md
// for how to read a given label's status codes.
async function trackedFetch(group, label, url, opts) {
  // Before the counter, and before fetch(): a refused call is one this process never makes, so
  // it must not show up as an outbound request in the numbers below.
  chargeBudget(group);
  const counter = counterFor(group, label);
  counter.requests++;
  const start = Date.now();
  try {
    const res = await fetch(url, opts?.signal ? opts : { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
    recordOutcome(counter, res.status, Date.now() - start);
    recordDaily(group, label, res.status);
    return res;
  } catch (err) {
    recordOutcome(counter, 'network', Date.now() - start);
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

// One label's entry in GET /api/metrics, from its counter or a window's summary of the same shape.
// Latency fields shared by outbound labels and inbound routes; defaults for a window with no event.
const latencyFields = ({ requests = 0, latencySum = 0, latencyMax = 0, latencyBuckets = {} }) => ({
  avgLatencyMs: requests ? Math.round(latencySum / requests) : 0,
  p50LatencyMs: percentile(latencyBuckets, 0.5, latencyMax),
  p95LatencyMs: percentile(latencyBuckets, 0.95, latencyMax),
  maxLatencyMs: latencyMax,
});

function labelEntry(counter) {
  const { requests, statusCounts, networkErrors } = counter;
  return { requests, statusCounts: { ...statusCounts }, networkErrors, ...latencyFields(counter) };
}

// Builds one bucket's `groups` (`sinceRestart` or `lastHour`), each label sitting directly under its group (no intermediate wrapper — a group-
// level total was tried and dropped as too verbose for what it added; sum a group's labels
// client-side if that's needed). `toLabelEntry` picks which granularity a given counter
// contributes (the lifetime totals, or its window's sum).
function buildGroups(toLabelEntry) {
  const out = {};
  for (const group of Object.keys(groups)) {
    out[group] = {};
    for (const label of Object.keys(groups[group])) {
      out[group][label] = toLabelEntry(groups[group][label]);
    }
  }
  return out;
}

// Shared shape for a simple "count events per name, windowed the same sinceRestart/lastHour
// way as everything else here" counter — backs both rateLimiters and dedupHits below, which
// are otherwise identical bookkeeping (a lifetime count + a per-minute window)
// over two different event types. A third near-identical copy for either would just be
// duplication; a genuinely different shape (cacheEvents' multi-outcome hits/misses/forced
// below) still doesn't fit this and stays separate rather than being forced in.
//
// `summarizeSinceRestart`/`summarizeLastHour` are two separate flat `{name: count}` maps
// (not one `{name: {sinceRestart, lastHour}}` map) so getMetrics() can slot each straight
// into the top-level sinceRestart/lastHour bucket alongside `groups` — see getMetrics()'s
// own comment for why every windowed signal in this response lives under those two root
// buckets rather than each metric family nesting its own sinceRestart/lastHour internally.
function createNamedCounter() {
  const counters = Object.create(null);
  function record(name) {
    if (!name) return; // an unnamed instance (e.g. createDedup() with no name) opts out
    if (!counters[name]) counters[name] = { count: 0, window: createWindow(() => ({ count: 0 })) };
    const c = counters[name];
    c.count++;
    c.window.current().count++;
  }
  function summarizeSinceRestart() {
    return Object.fromEntries(Object.keys(counters).map((name) => [name, counters[name].count]));
  }
  function summarizeLastHour() {
    return Object.fromEntries(Object.keys(counters).map((name) => [name, counters[name].window.sum().count]));
  }
  function reset() {
    for (const key of Object.keys(counters)) delete counters[key];
  }
  return { record, summarizeSinceRestart, summarizeLastHour, reset };
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
const streamEntry = ({ listedMsSum = 0, listedMsMax = 0, doneMsSum = 0, doneMsMax = 0, ...counts }) => ({
  ...counts,
  avgListedMs: average(listedMsSum, counts.cold),
  maxListedMs: listedMsMax,
  avgDoneMs: average(doneMsSum, counts.cold),
  maxDoneMs: doneMsMax,
});

// Inbound requests per route pattern (server.js), at `close`: which endpoint is slow, and since when.
const routeTotals = createTotals();
// `route` is a pattern (`GET /api/x/:id`), never a filled URL: no appid or Steam ID is published.
function recordRequest(route, { status, ms, bytes, aborted }) {
  routeTotals.record(route, {
    requests: 1,
    statusCounts: status === null ? {} : { [`${Math.floor(status / 100)}xx`]: 1 }, // null: left before any reply
    aborted: aborted ? 1 : 0,
    bytes,
    sized: bytes ? 1 : 0, // a chunked reply (the details stream) has no Content-Length
    latencySum: ms,
    latencyMax: ms,
    latencyBuckets: { [latencyBucket(ms)]: 1 },
  });
}
const routeEntry = ({ statusCounts = {}, aborted = 0, bytes = 0, sized = 0, ...latency }) => ({
  requests: latency.requests ?? 0,
  statusCounts,
  aborted,
  avgBytes: average(bytes, sized),
  ...latencyFields(latency),
});

// The event loop, sampled once a minute while the server runs: tells the server's own synchronous work
// (cache rows parsed, node:sqlite's calls) apart from a slow upstream, whose wait never blocks it.
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const loopTotals = createTotals();
const loopEntry = ({ minutes = 0, activeMs = 0, idleMs = 0, p99DelayMsMax = 0, delayMsMax = 0 }) => ({
  minutes,
  utilization: activeMs + idleMs ? Math.round((activeMs / (activeMs + idleMs)) * 100) / 100 : null,
  maxP99DelayMs: p99DelayMsMax,
  maxDelayMs: delayMsMax,
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

// Inbound counterpart to trackedFetch's outbound statusCounts — how often our OWN
// express-rate-limit instances (server.js) actually rejected a client request, not how often
// a third party rejected us. Kept separate from `groups`/`counterFor`: this is a different axis
// (self-imposed inbound limits vs. outbound calls to a specific service), so mixing it into the
// group/label tree would make e.g. "steam-store" ambiguous between "calls we made to Steam"
// and "requests we rejected". `name` is the limiter's own name (server.js's namedRateLimit),
// one entry per distinct limiter instance.
const limiterCounter = createNamedCounter();
const recordLimiterTrip = (name) => limiterCounter.record(name);

// How often lib/dedup.js's createDedup() actually coalesced a concurrent call into an
// already-in-flight one, per named dedup instance (lib/steam.js's 'steam', lib/itad.js's
// 'itad'). Windowed the same sinceRestart/lastHour way as rateLimiters above: an unusual burst
// of coalescing (many concurrent duplicate calls for the same key — a retry loop or a buggy
// polling client) is itself a "is this happening right now" signal, not just background
// context a lifetime total would still convey just as well.
const dedupCounter = createNamedCounter();
const recordDedupHit = (name) => dedupCounter.record(name);

// lib/cache.js's getCached() hit/miss/forced outcomes — kept here rather than tracked locally
// in lib/cache.js, so every append-only "counter, windowed via this same createWindow
// machinery" lives in one place (outbound requests, rate-limiter trips, dedup hits, and this).
// A cache hit-rate collapse IS a "detect it while it's happening" signal on the same footing
// as rateLimiters/outbound statusCounts: without a window, a regression that started an hour
// ago stays invisible under a lifetime average diluted by however long (up to the `resolve:`
// TTL, RESOLVE_CACHE_TTL_MINUTES in default.env) the process has been running — the exact problem sinceRestart/lastHour
// exists to solve everywhere else in this file. Doesn't reuse createNamedCounter above since
// it needs three sub-outcomes (hits/misses/forced) per group, not one bare count per name.
const cacheEvents = Object.create(null);

// `outcome` is one of 'hits'/'misses'/'forced' — see lib/cache.js's getCached().
const emptyCacheOutcomes = () => ({ hits: 0, misses: 0, forced: 0 });

function recordCacheEvent(group, outcome) {
  if (!cacheEvents[group]) cacheEvents[group] = { ...emptyCacheOutcomes(), window: createWindow(emptyCacheOutcomes) };
  const c = cacheEvents[group];
  c[outcome]++;
  c.window.current()[outcome]++;
}

function cacheHitsSinceRestart() {
  return Object.fromEntries(
    Object.keys(cacheEvents).map((group) => {
      const c = cacheEvents[group];
      return [group, { hits: c.hits, misses: c.misses, forced: c.forced }];
    }),
  );
}

function cacheHitsLastHour() {
  return Object.fromEntries(Object.keys(cacheEvents).map((group) => [group, cacheEvents[group].window.sum()]));
}

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

// Time buckets live at the root (sinceRestart/lastHour) and ONLY at the root — every windowed
// signal this endpoint exposes (outbound requests, rate-limiter trips, dedup hits, cache
// hit/miss/forced) nests under one or the other, rather than some signals putting the window
// at the root (groups) and others nesting sinceRestart/lastHour inside each named entry
// (rateLimiters/dedupHits/cacheHits used to). One convention throughout makes "what happened
// in the last hour" a single object to read for any of these, not a digging pattern that
// differs per metric family. `cacheEntries`/`circuitBreakers`/`semaphores`, composed in by
// server.js, are live snapshots rather than windowed counters and so deliberately sit outside
// both buckets — there's no "since restart" vs. "last hour" version of a current queue depth.
function getMetrics() {
  const waits = windowWaits.summarize(windowWaitEntry);
  const streams = streamTotals.summarize(streamEntry);
  const loop = loopTotals.summarize(loopEntry);
  const routes = routeTotals.summarize(routeEntry);
  return {
    since: startedAt,
    sinceRestart: {
      groups: buildGroups(labelEntry),
      routes: routes.sinceRestart,
      rateLimiters: limiterCounter.summarizeSinceRestart(),
      dedupHits: dedupCounter.summarizeSinceRestart(),
      cacheHits: cacheHitsSinceRestart(),
      windowWaits: waits.sinceRestart,
      heldLookups: heldCounter.summarizeSinceRestart(),
      ...(streams.sinceRestart.all && { streams: streams.sinceRestart.all }),
      ...(loop.sinceRestart.all && { eventLoop: loop.sinceRestart.all }),
    },
    lastHour: {
      groups: buildGroups((c) => labelEntry(c.window.sum())),
      routes: Object.fromEntries(Object.entries(routes.lastHour).filter(([, r]) => r.requests)),
      rateLimiters: limiterCounter.summarizeLastHour(),
      dedupHits: dedupCounter.summarizeLastHour(),
      cacheHits: cacheHitsLastHour(),
      windowWaits: waits.lastHour,
      heldLookups: heldCounter.summarizeLastHour(),
      ...(streams.lastHour.all?.count && { streams: streams.lastHour.all }),
      ...(loop.lastHour.all?.minutes && { eventLoop: loop.lastHour.all }),
    },
    budgets: getBudgets(),
    process: getProcessStats(),
    daily: dailyStmts.list.all(),
  };
}

// Test-only: clears all counters so test files don't see counts left over from an earlier
// test in the same process (this module is a singleton, same "why _reset exists" reasoning
// as lib/cache.js's own `_reset`).
function _reset() {
  for (const key of Object.keys(groups)) delete groups[key];
  for (const key of Object.keys(budgets)) delete budgets[key];
  limiterCounter.reset();
  dedupCounter.reset();
  for (const key of Object.keys(cacheEvents)) delete cacheEvents[key];
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
  startedAt,
  _reset,
};
