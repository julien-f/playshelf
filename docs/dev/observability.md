# Observability

Outbound-request metrics, budgets, and the warnings the app logs on its own. Cache tiers: [data.md](data.md); upstream trust tiers: [integrations.md](integrations.md).

## GET /api/metrics

No auth, same trust level as `GET /api/health`. In memory, reset on restart, except `cacheEntries` and `daily`, the only history beyond the trailing hour. Keys in reading order: what's wrong now, what's live per upstream, the server, the two windows, history. Is all quiet: `curl -s <host>/api/metrics | jq .alerts` (empty).

- Locally, `dev:mock` answers `e2e mock: no fixture for GET /api/metrics`: it mocks every `/api` route. Run the real server on a scratch database instead: `PORT=<free> DB_FILE=<scratch>.sqlite STEAM_API_KEY=x node server.js` (no upstream call is made until a route needs one).

```
{ since, version, commit,
  alerts:    [{ level: 'warn' | 'info', where, message, firstAt?, lastAt? }],
  upstreams: { [group]: { budget:      { hourUsed, hourTopClient, dayUsed, dayTopClient },
                          breaker?:    { blockedUntil, tripCount, consecutive403s },
                          semaphores?: { [name]: { active, queued, maxQueueSeen, rejected } },
                          windows?:    { [name]: { max, inWindow, reserved, waiting, maxQueueSeen } },
                          held?:       count } },
  budgetCeilings: { hour, day, clientSharePercent },
  server:         { openStreams, process: { rssMb, maxRssMb, heapUsedMb, externalMb, dbMb, dbWalMb },
                    cacheEntries: { [group]: count } },
  lastHour: { outbound:     { [group]: { [label]: { requests, statuses, networkErrors, unexpected,
                                                    firstUnexpectedAt?, lastUnexpectedAt?, avgMs, p50Ms, p95Ms, maxMs } } },
              inbound:      { [route]: { requests, statusClasses, firstServerErrorAt?, lastServerErrorAt?, aborted, avgBytes,
                                         avgMs, p50Ms, p95Ms, maxMs } },
              limiterTrips: { [name]: count },
              dedupHits:    { [name]: count },
              cache:        { [group]: { hits, misses, forced } },
              windowWaits:  { 'store-details': { waits, avgWaitMs, maxWaitMs } },
              heldAnswers:  { hltb: count },
              streams:      { count, games, fastUncached, storeUncached, closedEarly, closedEarlyCold, limited,
                              concurrentMax, cold, avgListedMs, maxListedMs, avgDoneMs, maxDoneMs },
              eventLoop:    { minutes, busyPercent, maxP99DelayMs, maxDelayMs, maxDelayAt } },
  sinceRestart: { …same shape as lastHour… },
  daily: { [day]: { [group]: { [label]: { [status]: count } } } } }
```

- **Windows**: every windowed signal nests under `lastHour`/`sinceRestart`; nothing nests a window of its own. `lastHour` sums 60 per-minute buckets, so an event leaves it 59–60 minutes after it happened: bounded memory and O(1) recording whatever the traffic. A name with no event in a window is absent rather than zeroed, so the first hour after a start reads the same in both.
- **`upstreams`**: every live state per outbound group, so one object answers "is this upstream OK". Every group that `createTrackedFetch` bound is listed from startup; `semaphores`/`windows` gain their group at creation (`createSemaphore`/`createWindow`'s `group`, `lib/upstream.js` `getUpstreamStats`).

### Alerts — `alerts`

- `getAlerts` (`lib/metrics.js`, thresholds in its `ALERT`), computed at each read from the same body: warnings first, then information. `firstAt`/`lastAt` date a windowed one.
- **warn**: ≥ 3 unexpected answers on one label in the last hour (`hltb.search`); a 5xx on an inbound route; a breaker open now; a budget at ≥ 80 % of a ceiling; an event-loop delay ≥ 1 s outside the first 2 minutes after start (loading the cache blocks it then).
- **info**: a breaker that tripped in the last hour and closed again; rate-limiter trips; loads that hit a client's budget share (`streams.limited`); a semaphore's `rejected` (lifetime, so not a warning); a start less than an hour ago (`lastHour` partial, a crash loop shows).
- Not from `daily`: history, not "now"; read it by day.

### Outbound — `outbound`

- Every outbound call goes through `trackedFetch` (`lib/metrics.js`), a drop-in for `fetch`. Modules reach it only through `createTrackedFetch(group)`, bound once per group at load; it returns `(label, url, opts)` and registers the group, which is how `upstreams` lists it from startup.
- `group` is the service or routing boundary: `steam-store` (`fetchStoreApi`/`storeLimit`), `steam-browse` (`tagLimit`), `steam-reviews` (`GetAppReviews`), `steam-api` (the other `api.steampowered.com` calls, keyed or not, untrusted `GetWishlist` included), `steam-openid`, `protondb`, `hltb`, `itad`, `fanatical`, `gamepass`. `label` is the calling function, so one operation stalling shows apart from its siblings.
- `statuses` is a `{ [status]: count }` map, deliberately not one "errors" count: several non-2xx answers are expected outcomes (403 = private profile or no stats on achievements, 404 = no ProtonDB reports).
- `unexpected`: network errors plus 4xx/5xx the call didn't declare as an answer. Each call declares its own (`apiFetch(label, url, { expected: [401] })`, stripped before `fetch`), next to the code that reads them: grep `expected: [` in `lib/`. Status alone can't always decide: getGameSchema's 403 is "no stats" with a JSON body but a rejected key with HTML; it's declared, since a rejected key also fails getOwnedGames, which isn't. `firstUnexpectedAt`/`lastUnexpectedAt` date them.
- `networkErrors`: `fetch()` itself threw (timeout, DNS, abort); never an expected outcome.
- A call counts when it ends, in both windows: one in flight is in neither.
- Latencies cover every outcome, so an upstream slowing down before it errors shows here first.
- `p50Ms`/`p95Ms` (also on `inbound`): the upper bound of the fixed log-scale bucket (5 ms … 10 s) holding that quantile, capped by `maxMs`; `null` under 10 calls, where one call decides it (`QUANTILE_MIN_SAMPLES`). Read them over the average: hit/miss times are bimodal, and one timeout pins the max at 10 s.

### Inbound — `inbound`

- Every request, recorded at `close` by a middleware in `server.js`, keyed `<METHOD> <route pattern>` (`GET /api/game/:appid`), never the filled URL; `(static)` for static files, `(no route)` for 404s, `GET (app shell)` for the page every client route serves.
- `statusClasses` (`2xx`, `4xx`…), `firstServerErrorAt`/`lastServerErrorAt` dating any `5xx`; `aborted`: the client left before the reply ended; one that left before any reply is in no status class. The details stream counts to its end, unlike morgan's time, which stops at the headers.
- `avgBytes` over replies with a `Content-Length` only: the details stream is chunked (its size: [code-backlog.md](code-backlog.md#performance)'s baseline).

### Inbound — `limiterTrips`

- Trips (requests rejected) per `express-rate-limit` instance in `server.js`, recorded by the shared `namedRateLimit` wrapper: `search`, `friends`, `details`, `meta`, `news`, `gameSearch`, `creatorGames`, `achievements`, `bundlesList`, `bundlesById`, `bundlesResolve`, `prices`, `gameBundles`, `gamePass`, `auth`, `prefs`. Plus `stream`: details streams refused by `STREAM_MAX_PER_IP`. `meta` also limits an opened list row's media loads.
- Only trips count, not requests a limiter saw or skipped as cached.

### `dedupHits`, `cache`, `cacheEntries`

- `dedupHits`: concurrent calls `createDedup(name)` (`lib/dedup.js`) coalesced into one in flight — `steam`, `hltb`, `itad`, `fanatical`, `gamepass`, `details` (`server.js`'s game details). A burst points at a retry loop or a polling client.
- `cache`: `getCached()` outcomes per `lib/cache.js` `GROUPS` label (`library`, `resolve`, `rating`, `meta`, `search`, `news`, `bundles`, `itad-ids`). `forced` (a user's ↻) is kept apart from `misses`. A rate limiter's cache check doesn't record, so each request counts once; nor does a game's tags reusing the parsed tag-name map (`meta`), which reads no row. Tells "traffic grew" apart from "the cache stopped working" when outbound counts jump.
- `cacheEntries`: row count per group, read from `db.sqlite` (survives restarts, lists every group). With `cache`: few entries plus many misses means a TTL too short; many entries plus many misses, a key space the cache can't help.

### List loading — `streams`, `windowWaits`, `heldAnswers`

What tuning the details stream's pools (`STREAM_CONCURRENCY`, server.js's `STREAM_STORE_CONCURRENCY`), `STORE_DETAILS_MAX_PER_5_MIN` and HLTB's failed-lookup hold reads. Aggregates only: no client, appid or IP.

- `streams`: one record per `POST /api/game-details/stream`, at its end.
  - `fastUncached`/`storeUncached`: games each part had to fetch (each pool's own cachedness), so ms per uncached game is derivable for each pool.
  - `closedEarly`: the client left before the end; `closedEarlyCold` of those, ones with something to fetch — the slowest loads, missing from the timings.
  - `concurrentMax`: streams open (every client's) when one started, the largest; `server.openStreams` is the live count.
  - Timings only from `cold` streams (something to fetch, ran to the end): `listed` when every game's fast part was sent (all rows listed), `done` at the end (store parts too). `null` with no cold stream. Absent from `lastHour` with no stream in it.
- `windowWaits`: reservations that queued for a rolling cap's place (`createWindow`, `lib/upstream.js`), and how long. Counted per attempt: a 429's retry reserves again. Waits with no 429s on `getAppDetails` mean the cap, not Steam, is the limit; 429s with no waits, a cap too high.
- `heldAnswers.hltb`: lookups HLTB's failed-lookup hold answered without a request; `upstreams.hltb.held`, games held now.
- Already answered elsewhere: appdetails 429s (`outbound['steam-store'].getAppDetails.statuses`), whether `UPSTREAM_MIN_INTERVAL_MS` is the limit (`upstreams[group].semaphores`' queues and the labels' latency).

### Event loop — `eventLoop`

- Is the server slow because of its own synchronous work (parsing cache rows, `node:sqlite`'s calls, gzip) rather than an upstream? An upstream's wait never blocks the loop.
- Sampled once a minute by `startEventLoopSampling` (`lib/metrics.js`), started once the server listens; absent before the first sample.
- `busyPercent`: share of the time the loop was busy (`eventLoopUtilization`), 0–100, one decimal. `maxP99DelayMs`: the worst minute's p99 timer delay (`monitorEventLoopDelay`); `maxDelayMs`: the single worst delay, `maxDelayAt` the end of the minute that held it (one near `since` is startup). A high delay with a high `busyPercent` = one long blocking task.

### Daily — `daily`

- Outbound status counts per UTC day (newest first), group and label, kept in `db.sqlite` (`metrics_daily`) for 30 days: dates when an upstream's answers changed (a 200 turning into 302s or 429s), across restarts. `status` is the HTTP status as text, or `network` for a `networkErrors` call.
- Written on every outbound call, as part of `trackedFetch`; a failed write warns `[metrics]` and never fails the call. Days past 30 are deleted on the first call of each day.
- Labels are published and kept for a month, so they stay function names, never built from a request.

### Live snapshots — `upstreams`, `server`

- `breaker` (`lib/circuitBreaker.js`; Steam store, HLTB search, ProtonDB): `blockedUntil` (open while in the future; 0 = never tripped), `tripCount` (lifetime, tells "once long ago" from "every 20 minutes"), `consecutive403s` (one more trips it; HLTB also counts a 401 on a fresh token, [integrations.md](integrations.md#hltb--no-npm-package)).
- `windows` (one per named `createWindow`): `inWindow` sends in the trailing window, `reserved` places taken but not sent, `waiting` queued for one, `maxQueueSeen` (lifetime).
- `semaphores` (one per `createSemaphore`): `active`/`queued` now, `maxQueueSeen` (lifetime high-water mark), `rejected` (calls turned away by the `SEMAPHORE_MAX_QUEUE` valve; should stay 0). High latency with low `queued` = slow upstream; high `queued` = our own concurrency cap.
- `server.process` (`getProcessStats`, `lib/metrics.js`): memory now (`rssMb`, `heapUsedMb`, `externalMb`), the largest RSS since start (`maxRssMb`), and the size of `db.sqlite` and its WAL (`null` for an in-memory database, or no WAL right after a checkpoint). A heap that only grows across reads is a leak; a WAL that keeps growing, a checkpoint that can't run.
- `budget`: current usage per outbound group, listed from startup (0 used); `budgetCeilings` holds the ceilings, the same for every group (`null` = disabled). See below.

## Outbound budgets

- `chargeBudget(group)` runs at the top of `trackedFetch` and caps calls per service per hour and per day (`OUTBOUND_HOURLY_MAX`/`OUTBOUND_DAILY_MAX`, see [configuration.md](../user/configuration.md); `0` disables).
- The only limit that isn't per client: it protects a key's quota from all clients together, and from the app's own retry loops.
- Past a ceiling it throws an `isUpstream` error, so routes answer 502 with no new error path. Refused calls aren't counted as requests.
- **Client share**: within each window, one client may spend `OUTBOUND_CLIENT_SHARE_PERCENT` of the ceiling (at least 1), so one IP can't spend it for everyone. Past it, the error also carries `isClientBudgetExhausted` and routes answer 429 with a message for the user. Each details part (`fetchFastDetails`, `fetchStoreDetails`) marks a result it left short as `limited`, and the details stream sends that message once as a `{ limited }` event; its workers go on, since cached games still fill in.
  - A client is `clientKey(req)` in `server.js`: the rate limiters' key (an IPv4 address or an IPv6 /56), so it needs `TRUST_PROXY` behind a proxy.
  - The request's client rides an `AsyncLocalStorage` (`runAsClient`, set by a middleware after the body parser). `createSemaphore` binds each queued job to its caller's context, since another job's release runs it. Any new queue shared across requests must do the same.
  - A call outside any request context (every call while tests bypass the limiters) counts only against the global ceiling.
  - Shared state keeps one client's refusal from reaching others: `createDedup` retries once in a waiter's own context when it rode on another client's refused call (or, for a details part, a `limited` result); an HLTB login or the Fanatical feed refused for one client isn't recorded as a failure.
  - `hourTopClient`/`dayTopClient` in each `budget`: the most one client spent in the current window.
- Fixed windows, not sliding: it runs on every call and stays O(1). A window starts at the group's first call once the previous one has ended; reading `GET /api/metrics` never starts one.

## Log warnings

Logged at the moment they happen, once per event rather than once per affected request:

- **`[circuit-breaker] <name> tripped …`** — once per trip, with the time it's blocked until.
- **`[budget:<group>] hourly/daily outbound budget exhausted …`** — once per window per service, with the time the window rolls over.
- **`[budget:<group>] a client spent its hourly/daily share …`** — once per window per client and service, without the client's address.
- **`[semaphore:<name>] queue saturated …`** — every rejection, unthrottled: it should never fire, so each one matters.
- **`[itad-dates] ITAD's end date for bundle … may be removable`** — `console.log`, once per bundle per process: information, not a fault ([integrations.md](integrations.md#bundles)).
- **`[HLTB] search failed …`** — throttled to one per `HLTB_SEARCH_WARN_THROTTLE_MS` (30 s); the searches themselves still run and fail normally. `[HLTB] init failed` is throttled by the auth retry backoff.

All are `console.warn`: degraded but recoverable. An error marked `isLogged` is not logged again by `routeErrorStatus` or the details parts (`logDetailsError`): it's set where the warning was printed — `assertClosed` while a breaker is open, `chargeBudget` past a budget, and HLTB's errors repeating the failure the last `[HLTB]` line warned about, or an auth hold whose cause was already logged. Without it, one open breaker or spent budget logs a line per game in a large load.

Deliberately not done:

- Log warnings for cache hit-rate collapse or latency trends: no single event to hang them on; read `GET /api/metrics` instead.
- More in-memory windows (5 min, week): one hour answers "is it happening now", `sinceRestart` and `daily` the rest.
- A per-group total under `groups`: sum the labels client-side.
