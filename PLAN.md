# Plan: cut upstream load (C288, C297, C221)

Branch `upstream-load` (worktree `.claude/worktrees/upstream-load`), merged `--no-ff` with one CHANGELOG entry, after the user's own test and OK.

## Evidence (production `daily`, read 2026-11-08)

- Storms only on the three large cold-load days: HLTB search 10-23 (295 × 200, 95 × 429, 2 × 403), 10-26 (243 / 85 / 2, plus appdetails 86 × 429), 11-02 (680 / 25 / **13 × 403: a block**, appdetails 47 × 429). Every other day: ≤ 103 searches, ≤ 72 appdetails, zero errors.
- So the driver is one large cold load, not several clients or retries (HLTB `retries: 0`; one client tops the hour budget).
- 11-02's 403s may not be rate-driven alone: searches queued behind a slow drain carry a token fetched before they queued (step 1).
- appdetails: the 190 / 5 min cap shipped 2026-11-02, after that day's storm; no cold load since, so unexercised. Out of scope.
- ProtonDB: ~130–150 × 404 on most quiet days (10-24/25/27/28/30/31, 11-01/04/07; 10–22 on the others) even when nothing else is busy (11-04: 132 × 404, 0 × 200, 13 appdetails) — fits a wishlist of unreleased games reloaded every day or two, whose 1-day miss TTL (`capExpiry`, `server.js` `fetchFastDetails`) re-queries them.
- `refresh=1` (C297): no evidence it drove any storm; kept as cheap hardening.

## Steps (one commit each)

### 1. C288 — cap HLTB search under a rolling window

- Cause: HLTB is paced at 3 slots × `UPSTREAM_MIN_INTERVAL_MS` (1 s) ≈ 3 req/s; the 429 pause (`createPause`, `lib/upstream.js`) resets its strikes on the first success, so a long cold load oscillates at the limit (95 × 429 on 10-23) until HLTB blocks (11-02).
- Fix: `HLTB_SEARCH_MAX_PER_5_MIN` in `default.env`, applied through `createRetryingFetch`'s `window` (`createWindow`), as appdetails does, named `hltb-search` with `onWait: recordWindowWait` so `windowWaits` shows the cap at work. Proposed **150** (0.5 req/s; a 1196-game cold load's HLTB column fills in ~40 min instead of ~7).
- **Token read in the slot**: `searchHLTB` reads the token and builds its headers before queueing (`lib/hltb.js`), so a long drain sends an expired token and every queued search fails into `failedLookups`. Build `init` (token headers and body) once the window place and slot are taken: `createRetryingFetch` accepts `init` as a function, called inside `limit`. Fixes a bug that today's ~7-min drain already risks.
- **Interactive lookups jump the queue**: a single-game lookup (panel open, Look up, ↻) mustn't wait behind a cold load's 40-min backlog. `createWindow.reserve({ priority })` puts it at the front of the waiters; it still counts, so the cap holds. The game-details route passes it; the list stream doesn't.
- **Assumption, unconfirmed**: HLTB's limit sits above 150 / 5 min (conservative: 200s ran at ~3 req/s). Confirmed by the next large cold load showing window waits and 0 × 429 in `daily`; recorded as an assumption in integrations.md's HLTB section.
- Tests, new `test/hltbWindow.test.js` (window is module state; `upstreamPacing.test.js` already sends 12 searches): cap 2, `UPSTREAM_MIN_INTERVAL_MS=0`, `t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })`:
  - 3 searches → 2 sent, 3 after `tick(5 min)`; fails before the change.
  - `search/site/init` takes no window place.
  - a token rotated while a search waits: the queued search sends the new token.
  - a priority reservation queued after a backlog is sent first.
  - a 429-refused search still holds its place.
- `test:one` in package.json and the suite's env set `HLTB_SEARCH_MAX_PER_5_MIN=0`.

### 2. C221 — skip ProtonDB for games it can't have reports for

- Chain `getProtonDbStatus` off `basicsPromise.catch(() => null)` in `fetchFastDetails`: skip only on a positive `basics.comingSoon` or a not-played type; a failed or null basics still queries ProtonDB, so a store-browse outage doesn't hide it.
- A skip caches a miss like `getHLTB` does (`if (force || !isCached(key)) setCache(key, null, { ttlMs: MISS_CACHE_TTL_MS })`), so the source has an age; the `comingSoon` `capExpiry` loop becomes a no-op for ProtonDB.
- Move `NOT_PLAYED_TYPES` to `lib/steam.js` (app types are Steam's notion), imported by `lib/hltb.js`; ProtonDB also skips `dlc` (no separate launch), HLTB keeps it.
- **Assumptions, to confirm before building**: ProtonDB has no reports for an unreleased appid or a DLC. The local cache has one unreleased game, so it can't tell. Confirm with the user's choice of source; record in integrations.md.
- Cost: ProtonDB now waits for the browse item (usually cached, one store browse call otherwise).
- Tests (the loop at `test/server.test.js:1435`): record URLs; no `protondb.com` call when `comingSoon` true, one when false; `dlc` and `music` skip; appdetails/browse failing still queries ProtonDB and `failed` doesn't list it; the skipped miss has a `getCachedAt`.

### 3. C297 — a forced refresh of a just-fetched source is answered from cache

- `GROUPS` (`lib/cache.js`) gets `forceMinAgeMs` (`FORCE_MIN_AGE_MINUTES`, default 10) on `cache_meta`, `cache_rating` and `cache_news`; `cache_library` (owned games, wishlist, player achievements) stays always forceable: a user who just bought or unlocked something must see it.
- One exported predicate `answersForce(key)` (live row, group has a minimum age, younger than it), used by `getCached`'s force branch, which records it as a `hits` event, not `forced`.
- Limiters: a `sourcesFresh(sources, appid)` helper beside `sourcesCached` (`server.js`), reusing `DETAILS_SOURCES` and the existing key lists; skips read `isForceRefresh(req) ? sourcesFresh(...) : sourcesCached(...)`. Game details and news; achievements only without steamids (its `playerach:` keys stay forceable). A failed source has no fresh row, so its ↻ still counts and refetches.
- UI: the panel's "Updated <when>" already shows the oldest age; its tooltip "Click to re-fetch these" gets "(not within 10 min of the last fetch)".
- Tests: existing ones forcing right after a fetch (`server.test.js:1129`, `:1419`, `server-ratelimit.test.js:93`, `server-ratelimit-skips.test.js:138`, `:166`) seed rows older than the minimum (`_reset([[key, { value, ts: Date.now() - 11 * 60_000 }]])`), assertions unchanged. New: a force on a 5-min-old meta row makes no call and records `hits`; 11 min refetches; a `games:` row 1 min old still refetches; with the budget spent, `refresh=1` on 5-min-old keys answers 200 with no call, on 11-min-old keys 429 (details, news, achievements without steamids).
- Comment on the `details:fast:force:` lane updated (it can now be handed a cached value).

## Docs

- integrations.md: HLTB cap, token-in-slot, priority, assumption; ProtonDB skip and its confirmation.
- observability.md: `hltb-search` in `windowWaits` (`:29`, `:86`); `forced` vs `hits` (`:74`).
- data.md: force minimum age per group, and `:38` ("a forced request always counts") corrected; a game released within 10 min of its browse fetch keeps `comingSoon` that long.
- default.env: `HLTB_SEARCH_MAX_PER_5_MIN`, `FORCE_MIN_AGE_MINUTES`. code-backlog.md: close C288, C297, C221.

## Out of scope

- appdetails cap tuning (unexercised since it shipped).
- HLTB skipping `comingSoon` (same re-query pattern, ~50 searches a day): its own item once ProtonDB's rule is confirmed.
- C249 (batched tag lookups), C287 (daily latency), C284 (semaphore waits).
- Keeping 429 strikes across a success (`createPause`): the window should make 429s rare; revisit if `daily` still shows them.
