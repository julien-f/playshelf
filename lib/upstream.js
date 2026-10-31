'use strict';

const { AsyncResource } = require('node:async_hooks');

// Shared by every upstream client (lib/steam.js, lib/hltb.js, lib/itad.js).

function upstreamError(msg) {
  return Object.assign(new Error(msg), { isUpstream: true });
}

// Generous relative to any single request's realistic fan-out (server.js's STREAM_MAX_GAMES
// caps that directly) — this only guards against queue depth growing genuinely unbounded, see
// createSemaphore's comment below.
const SEMAPHORE_MAX_QUEUE = 20000;

const semaphores = new Map(); // name -> semaphore, for GET /api/metrics

// Limit concurrent requests and enforce a minimum interval between them.
// minIntervalMs delays slot release after each request so throughput stays under the rate limit
// even when many requests are queued (concurrency alone isn't enough — Steam limits by req/s).
// maxQueue is a coarse safety valve, not a normal operating limit — this queue is shared
// process-wide across every caller/client, and a single legitimate large-library first load
// can easily enqueue thousands of jobs on its own (fetchGameDetails fans out per appid, and
// server.js's STREAM_MAX_GAMES/detailsLimit already bound how much any one request/IP can
// enqueue per minute — see server.js). This just stops queue depth from growing without
// bound if those upstream bounds are ever misconfigured, rather than rejecting realistic use.
// `name` keys it in getSemaphoreStats() and labels its log lines.
function createSemaphore(limit, minIntervalMs, name, maxQueue = SEMAPHORE_MAX_QUEUE) {
  let active = 0;
  const queue = [];
  // Lifetime high-water mark on queue depth — see getSemaphoreStats() below. Distinct from
  // `active`/`queue.length`, which are live snapshots: this is the one number that shows
  // whether contention has ever gotten bad, even if the queue happens to be empty right now
  // when /api/metrics is read.
  let maxQueueSeen = 0;
  // Lifetime count of calls actually turned away by the `maxQueue` safety valve below — as
  // opposed to `queued`/`maxQueueSeen`, which describe healthy-but-busy contention, this is
  // the queue having been completely saturated and a caller getting a hard rejection instead
  // of just waiting its turn. `maxQueue` is deliberately generous (SEMAPHORE_MAX_QUEUE by
  // default) precisely so this should stay at 0 in practice — a nonzero value here means
  // that safety valve actually fired, which had no visibility in GET /api/metrics at all
  // before this counter existed.
  let rejected = 0;
  function release() {
    active--;
    next();
  }
  function next() {
    if (active < limit && queue.length > 0) {
      active++;
      const { fn, resolve, reject } = queue.shift();
      fn().then(
        (val) => {
          resolve(val);
          minIntervalMs > 0 ? setTimeout(release, minIntervalMs) : release();
        },
        (err) => {
          reject(err);
          // A call a budget refused never reached the upstream, so there's no pace to keep.
          minIntervalMs > 0 && !err?.isBudgetExhausted ? setTimeout(release, minIntervalMs) : release();
        },
      );
    }
  }
  const semaphore = (fn) =>
    new Promise((resolve, reject) => {
      if (queue.length >= maxQueue) {
        rejected++;
        // Not throttled/deduped like the circuit-breaker trip warning — maxQueue is generous
        // enough (SEMAPHORE_MAX_QUEUE) that this is expected to fire essentially never, so
        // unlike a genuine outage's worth of near-identical per-request errors, each
        // occurrence here is itself individually noteworthy rather than repetitive noise.
        console.warn(`[semaphore:${name}] queue saturated (${queue.length}/${maxQueue}) — rejecting request`);
        reject(upstreamError('Too many queued upstream requests — try again shortly'));
        return;
      }
      // Bound to the caller's async context: another job's release runs it, and its calls are charged to the caller's client.
      queue.push({ fn: AsyncResource.bind(fn), resolve, reject });
      if (queue.length > maxQueueSeen) maxQueueSeen = queue.length;
      next();
    });
  semaphore.getStats = () => ({ active, queued: queue.length, maxQueueSeen, rejected });
  semaphores.set(name, semaphore);
  return semaphore;
}

// Every semaphore's live + lifetime-high-water-mark stats for GET /api/metrics. Lets a
// slow-upstream problem be told apart from a self-inflicted concurrency-cap bottleneck: high
// latency (lib/metrics.js) with a consistently near-zero queue means the upstream itself is just
// slow; a queue that's regularly deep means requests are piling up behind these limits instead.
function getSemaphoreStats() {
  return Object.fromEntries([...semaphores].map(([name, semaphore]) => [name, semaphore.getStats()]));
}

// After a 429, every request to that upstream waits its Retry-After (seconds or a date), else 2 s doubling up to
// 30 s; an answer to a request sent (`sentAt`) by the last 429 belongs to that burst, so it can't escalate or reset.
function createPause() {
  let until = 0;
  let strikes = 0;
  let lastHitAt = -Infinity;
  return {
    async wait() {
      // Again after each sleep: a later 429 may have pushed it further.
      for (let ms; (ms = until - Date.now()) > 0;) await new Promise((resolve) => setTimeout(resolve, ms));
    },
    hit(res, sentAt) {
      const retryAfter = res.headers?.get('retry-after');
      const seconds = Number(retryAfter);
      const askedMs = retryAfter && (Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000);
      const newBurst = sentAt > lastHitAt;
      const delay = askedMs > 0 ? askedMs : Math.min(30000, 2000 * 2 ** (newBurst ? strikes : strikes - 1));
      if (newBurst) {
        strikes++;
        lastHitAt = Date.now();
      }
      until = Math.max(until, Date.now() + delay);
    },
    ok(sentAt) {
      if (sentAt > lastHitAt) strikes = 0;
    },
    reset() {
      until = 0;
      strikes = 0;
      lastHitAt = -Infinity;
    },
  };
}

// Runs requests through `limit`, retrying each up to twice on 429. A 429 pauses every request
// of this fetcher, not just the one that got it: each one waits, holding its slot, so the whole
// queue backs off until Retry-After has passed. `label` is the calling function's name, so
// metrics can tell e.g. getGameRating apart from searchStoreGames — see lib/metrics.js.
function createRetryingFetch(limit, trackedFetch, name, breaker) {
  const pause = createPause();
  const retryingFetch = async (url, label, opts) => {
    breaker?.assertClosed();
    for (let attempt = 0; attempt <= 2; attempt++) {
      const res = await limit(async () => {
        await pause.wait();
        // Again here: the breaker may have tripped while this request (or its retry) was queued.
        breaker?.assertClosed();
        const sentAt = Date.now();
        const res = await trackedFetch(label, url, opts);
        // Before the slot frees, so the next queued request already sees a trip, or the pause.
        if (res.status === 429) pause.hit(res, sentAt);
        else {
          pause.ok(sentAt);
          breaker?.record(res.status);
        }
        return res;
      });
      if (res.status !== 429) return res;
    }
    throw upstreamError(`${name}: rate limited after retries`);
  };
  retryingFetch.resetPause = pause.reset; // test-only
  return retryingFetch;
}

module.exports = { upstreamError, createSemaphore, getSemaphoreStats, createPause, createRetryingFetch };
