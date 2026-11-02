# Observability

Outbound-request metrics, budgets, and the warnings the app logs on its own. Cache tiers: [data.md](data.md); upstream trust tiers: [integrations.md](integrations.md).

## GET /api/metrics

No auth, same trust level as `GET /api/health`. In memory, reset on restart, except `cacheEntries` and `daily`, the only history beyond the trailing hour.

```
{ since,
  sinceRestart: { groups:       { [group]: { [label]: { requests, statusCounts, networkErrors,
                                                        avgLatencyMs, p50LatencyMs, p95LatencyMs, maxLatencyMs } } },
                  routes:       { [route]: { requests, statusCounts, aborted, avgBytes,
                                             avgLatencyMs, p50LatencyMs, p95LatencyMs, maxLatencyMs } },
                  rateLimiters: { [name]: count },
                  dedupHits:    { [name]: count },
                  cacheHits:    { [group]: { hits, misses, forced } },
                  windowWaits:  { 'store-details': { waits, avgWaitMs, maxWaitMs } },
                  heldLookups:  { hltb: count },
                  streams:      { count, games, fastUncached, storeUncached, closedEarly, closedEarlyCold, limited,
                                  concurrentMax, cold, avgListedMs, maxListedMs, avgDoneMs, maxDoneMs },
                  eventLoop:    { minutes, utilization, maxP99DelayMs, maxDelayMs } },
  lastHour:     { …same shape as sinceRestart… },
  budgets:         { [group]: { hourUsed, hourMax, hourTopClient, dayUsed, dayMax, dayTopClient } },
  circuitBreakers: { 'steam-store' | hltb | protondb: { blockedUntil, tripCount, consecutive403s } },
  semaphores:      { store | tag | proton | reviews | hltb | 'itad-info': { active, queued, maxQueueSeen, rejected } },
  windows:         { 'store-details': { max, inWindow, reserved, waiting, maxQueueSeen } },
  heldGames:       { hltb: count },
  openStreams:     count,
  cacheEntries:    { [group]: count },
  daily:           [{ day, group, label, status, count }] }
```

- **Windows**: every windowed signal nests under `sinceRestart`/`lastHour`, always the outermost keys; nothing nests a window of its own. `lastHour` sums 60 per-minute buckets, so an event leaves it 59–60 minutes after it happened: bounded memory and O(1) recording whatever the traffic. Live snapshots (`budgets`, `circuitBreakers`, `semaphores`, `windows`, `heldGames`, `openStreams`, `cacheEntries`) and the persisted `daily` sit outside both. A name with no events yet is absent rather than zeroed.

### Outbound — `groups`

- Every outbound call goes through `trackedFetch` (`lib/metrics.js`), a drop-in for `fetch`. Modules reach it only through `createTrackedFetch(group)`, bound once per group at load; it returns `(label, url, opts)` and registers the group, which is how `budgets` lists it from startup.
- `group` is the service or routing boundary: `steam-store` (`fetchStoreApi`/`storeLimit`), `steam-browse` (`tagLimit`), `steam-reviews` (`GetAppReviews`), `steam-api` (the other `api.steampowered.com` calls, keyed or not, untrusted `GetWishlist` included), `steam-openid`, `protondb`, `hltb`, `itad`, `fanatical`, `gamepass`. `label` is the calling function, so one operation stalling shows apart from its siblings.
- `statusCounts` is a `{ [status]: count }` map, deliberately not one "errors" count: several non-2xx answers are expected outcomes (403 = private profile or no stats on achievements, 404 = no ProtonDB reports; see [integrations.md](integrations.md)). Read it against what's expected for that label.
- `networkErrors`: `fetch()` itself threw (timeout, DNS, abort); never an expected outcome.
- Latencies cover every outcome, so an upstream slowing down before it errors shows here first.
- `p50LatencyMs`/`p95LatencyMs` (also on `routes`): the upper bound of the fixed log-scale bucket (25 ms … 10 s) holding that quantile, capped by `maxLatencyMs`; `null` with no call. Read them over the average: hit/miss times are bimodal, and one timeout pins the max at 10 s.

### Inbound — `routes`

- Every request, recorded at `close` by a middleware in `server.js`, keyed `<METHOD> <route pattern>` (`GET /api/game/:appid`), never the filled URL; `(no route)` for static files and 404s.
- `statusCounts` by class (`2xx`, `4xx`…); `aborted`: the client left before the reply ended. The details stream counts to its end, unlike morgan's time, which stops at the headers.
- `avgBytes` over replies with a `Content-Length` only: the details stream is chunked (its size: [code-backlog.md](code-backlog.md#performance)'s baseline).

### Inbound — `rateLimiters`

- Trips (requests rejected) per `express-rate-limit` instance in `server.js`, recorded by the shared `namedRateLimit` wrapper: `search`, `friends`, `details`, `meta`, `news`, `gameSearch`, `creatorGames`, `achievements`, `bundlesList`, `bundlesById`, `bundlesResolve`, `prices`, `gameBundles`, `gamePass`, `auth`. Plus `stream`: details streams refused by `STREAM_MAX_PER_IP`. `meta` also limits an opened list row's media loads.
- Only trips count, not requests a limiter saw or skipped as cached.

### `dedupHits`, `cacheHits`, `cacheEntries`

- `dedupHits`: concurrent calls `createDedup(name)` (`lib/dedup.js`) coalesced into one in flight — `steam`, `hltb`, `itad`, `fanatical`, `gamepass`, `details` (`server.js`'s game details). A burst points at a retry loop or a polling client.
- `cacheHits`: `getCached()` outcomes per `lib/cache.js` `GROUPS` label (`library`, `resolve`, `rating`, `meta`, `search`, `news`, `bundles`, `itad-ids`). `forced` (a user's ↻) is kept apart from `misses`. A rate limiter's cache check doesn't record, so each request counts once; nor does a game's tags reusing the parsed tag-name map (`meta`), which reads no row. Tells "traffic grew" apart from "the cache stopped working" when outbound counts jump.
- `cacheEntries`: row count per group, read from `db.sqlite` (survives restarts, lists every group). With `cacheHits`: few entries plus many misses means a TTL too short; many entries plus many misses, a key space the cache can't help.

### List loading — `streams`, `windowWaits`, `heldLookups`

What tuning the details stream's pools (`STREAM_CONCURRENCY`, server.js's `STREAM_STORE_CONCURRENCY`), `STORE_DETAILS_MAX_PER_5_MIN` and HLTB's failed-lookup hold reads. Aggregates only: no client, appid or IP.

- `streams`: one record per `POST /api/game-details/stream`, at its end.
  - `fastUncached`/`storeUncached`: games each part had to fetch (each pool's own cachedness), so ms per uncached game is derivable for each pool.
  - `closedEarly`: the client left before the end; `closedEarlyCold` of those, ones with something to fetch — the slowest loads, missing from the timings.
  - `concurrentMax`: streams open (every client's) when one started, the largest; `openStreams` is the live count.
  - Timings only from `cold` streams (something to fetch, ran to the end): `listed` when every game's fast part was sent (all rows listed), `done` at the end (store parts too). Absent from `lastHour` with no stream in it.
- `windowWaits`: reservations that queued for a rolling cap's place (`createWindow`, `lib/upstream.js`), and how long. Counted per attempt: a 429's retry reserves again. Waits with no 429s on `getAppDetails` mean the cap, not Steam, is the limit; 429s with no waits, a cap too high.
- `heldLookups.hltb`: lookups HLTB's failed-lookup hold answered without a request; `heldGames.hltb`, games held now.
- Already answered elsewhere: appdetails 429s (`groups['steam-store'].getAppDetails.statusCounts`), whether `UPSTREAM_MIN_INTERVAL_MS` is the limit (`semaphores`' queues and the labels' latency).

### Event loop — `eventLoop`

- Is the server slow because of its own synchronous work (parsing cache rows, `node:sqlite`'s calls, gzip) rather than an upstream? An upstream's wait never blocks the loop.
- Sampled once a minute by `startEventLoopSampling` (`lib/metrics.js`), started once the server listens; absent before the first sample.
- `utilization`: share of the time the loop was busy (`eventLoopUtilization`), 0–1. `maxP99DelayMs`: the worst minute's p99 timer delay (`monitorEventLoopDelay`); `maxDelayMs`: the single worst delay. A high delay with high utilization = one long blocking task.

### Daily — `daily`

- Outbound status counts per UTC day, group and label, kept in `db.sqlite` (`metrics_daily`) for 30 days: dates when an upstream's answers changed (a 200 turning into 302s or 429s), across restarts. `status` is the HTTP status as text, or `network` for a `networkErrors` call.
- Written on every outbound call, as part of `trackedFetch`; a failed write warns `[metrics]` and never fails the call. Days past 30 are deleted on the first call of each day.
- Labels are published and kept for a month, so they stay function names, never built from a request.

### Live snapshots

- `circuitBreakers` (`lib/circuitBreaker.js`; Steam store, HLTB search, ProtonDB): `blockedUntil` (open while in the future; 0 = never tripped), `tripCount` (lifetime, tells "once long ago" from "every 20 minutes"), `consecutive403s` (one more trips it; HLTB also counts a 401 on a fresh token, [integrations.md](integrations.md#hltb--no-npm-package)).
- `windows` (`lib/upstream.js` `getWindowStats`, one per `createWindow`): `inWindow` sends in the trailing window, `reserved` places taken but not sent, `waiting` queued for one, `maxQueueSeen` (lifetime).
- `semaphores` (`lib/upstream.js` `getSemaphoreStats`, one per `createSemaphore`): `active`/`queued` now, `maxQueueSeen` (lifetime high-water mark), `rejected` (calls turned away by the `SEMAPHORE_MAX_QUEUE` valve; should stay 0). High latency with low `queued` = slow upstream; high `queued` = our own concurrency cap.
- `budgets`: current usage per outbound `group`, every one listed from startup (0 used) so the ceilings show before anything spends against them; see below.

## Outbound budgets

- `chargeBudget(group)` runs at the top of `trackedFetch` and caps calls per service per hour and per day (`OUTBOUND_HOURLY_MAX`/`OUTBOUND_DAILY_MAX`, see [configuration.md](../user/configuration.md); `0` disables).
- The only limit that isn't per client: it protects a key's quota from all clients together, and from the app's own retry loops.
- Past a ceiling it throws an `isUpstream` error, so routes answer 502 with no new error path. Refused calls aren't counted as requests.
- **Client share**: within each window, one client may spend `OUTBOUND_CLIENT_SHARE_PERCENT` of the ceiling (at least 1), so one IP can't spend it for everyone. Past it, the error also carries `isClientBudgetExhausted` and routes answer 429 with a message for the user. Each details part (`fetchFastDetails`, `fetchStoreDetails`) marks a result it left short as `limited`, and the details stream sends that message once as a `{ limited }` event; its workers go on, since cached games still fill in.
  - A client is `clientKey(req)` in `server.js`: the rate limiters' key (an IPv4 address or an IPv6 /56), so it needs `TRUST_PROXY` behind a proxy.
  - The request's client rides an `AsyncLocalStorage` (`runAsClient`, set by a middleware after the body parser). `createSemaphore` binds each queued job to its caller's context, since another job's release runs it. Any new queue shared across requests must do the same.
  - A call outside any request context (every call while tests bypass the limiters) counts only against the global ceiling.
  - Shared state keeps one client's refusal from reaching others: `createDedup` retries once in a waiter's own context when it rode on another client's refused call (or, for a details part, a `limited` result); an HLTB login or the Fanatical feed refused for one client isn't recorded as a failure.
  - `hourTopClient`/`dayTopClient` in `budgets`: the most one client spent in the current window.
- Fixed windows, not sliding: it runs on every call and stays O(1). A window starts at the group's first call once the previous one has ended; reading `budgets` never starts one.

## Log warnings

Logged at the moment they happen, once per event rather than once per affected request:

- **`[circuit-breaker] <name> tripped …`** — once per trip, with the time it's blocked until.
- **`[budget:<group>] hourly/daily outbound budget exhausted …`** — once per window per service, with the time the window rolls over.
- **`[budget:<group>] a client spent its hourly/daily share …`** — once per window per client and service, without the client's address.
- **`[semaphore:<name>] queue saturated …`** — every rejection, unthrottled: it should never fire, so each one matters.
- **`[HLTB] search failed …`** — throttled to one per `HLTB_SEARCH_WARN_THROTTLE_MS` (30 s); the searches themselves still run and fail normally. `[HLTB] init failed` is throttled by the auth retry backoff.

All are `console.warn`: degraded but recoverable. An error marked `isLogged` is not logged again by `routeErrorStatus` or the details parts (`logDetailsError`): it's set where the warning was printed — `assertClosed` while a breaker is open, `chargeBudget` past a budget, and HLTB's errors repeating the failure the last `[HLTB]` line warned about, or an auth hold whose cause was already logged. Without it, one open breaker or spent budget logs a line per game in a large load.

Deliberately not done:

- Log warnings for cache hit-rate collapse or latency trends: no single event to hang them on; read `GET /api/metrics` instead.
- More in-memory windows (5 min, week): one hour answers "is it happening now", `sinceRestart` and `daily` the rest.
- A per-group total under `groups`: sum the labels client-side.
