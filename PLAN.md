# C317 — age-based cache expiry

Branch `age-expiry`. Merge waits for the user's own test and OK. This file is deleted before the merge.

## Problem

A released game's per-game rows (`rating:`, `hltb:`, `protondb:`, `appdetails:`+`meta:`, `browse:`, `achrarity:`) keep the 365-day tier from day one: a game cached at day 10 shows its day-10 reviews, ProtonDB and HLTB until next year.

## Policy

- A row's lifetime = half the game's age at its write time (`ts − releasedAt`), clamped to [1 day, tier TTL]; an age ≤ 0 (written before release, future date) gets the floor.
  - Fetched at day 10 → refetched at day 15, 22, 34… (×1.5 each time); full tier from ~2 years old. A release-day game costs ~4 calls a day for 2–3 days. Steady state simulated at ~0.44 calls a day per upstream for 1310 games: no limiter, budget or breaker change.
- Empty results of a released game (no reviews, no HLTB match, no ProtonDB report) cap at `EMPTY_CACHE_TTL_MINUTES` (new, 90 days), and at the age rule when younger.
- Unknown release date: no age cap. Unreleased games keep today's miss cap (`capComingSoon`, `fetchFastDetails`), which wins when both apply.
- Early Access counts from Steam's release date (its EA launch): no special case (decided).

## Release date

- `releasedAt(basics)`: null unless `!comingSoon` and the string round-trips through `releaseDateFormat` (Pacific, `lib/steam.js`). `Date.parse` alone accepts "2026", "Oct 2026", "Fall 2026" as days.
- Browse item: its numeric `release.steam_release_date` when not coming soon.

## Where the cap is applied

- Store page and browse item: at write, from their own date — `load()` returns the age-based `ttlMs`, and `alongside` keeps `appdetails:`/`meta:` on one expiry.
- Rating, HLTB, ProtonDB: fetched in parallel before the date is known, so capped on read in `fetchFastDetails` from its `phase`.
- Rarity: capped on read in `/api/achievements` from the cached basics (`getCached(…, { record: false })`, never fetched).
- Store rows written before the change: the same cap on read, a shim removed once they've all expired (deploy + 365 days).
- A cap on read never lands in the past: a row already past its new cap gets now + a spread of 0–7 days from a hash of the appid. That spreads the post-deploy burst, keeps `getCachedAt`'s age readout (`settleSources`, the `/api/achievements` schema re-ask) and writes once. Rows written afterwards spread by their own fetch times: no other jitter.
- Not covered: `gameschema:` (C316), `tagnames:`, packages/bundles, ITAD ids. The 2026-10-19 cohort's jitter for those stays with C311.

## Code

- `lib/cache.js`: `capExpiry(key, capOf)` takes the cap as a function of the row's write time (existing callers pass `() => Date.now() + MISS_CACHE_TTL_MS`), writing only when it lowers the expiry.
- `lib/steam.js`: `releasedAt`, `ageTtl(ts, releasedAt, maxMs)`, `capByAge(key, releasedAt, { empty })`; `getAppDetails`/`getStoreBrowseItem` return the age `ttlMs`.
- `server.js`: `fetchFastDetails` (released game), `/api/achievements` (rarity).
- `default.env` + `lib/config.js`: `EMPTY_CACHE_TTL_MINUTES=129600`.

## Steps (one commit each)

0. Confirm first — done 2026-11-08 on a copy of production's cache (schema v12), results under Step 0 below.
1. Serve an expired value when its refetch fails (decided): the per-game groups (`forceMinAge`: rating, meta, news) keep expired rows for a grace (30 days) instead of deleting them on read or in the sweep; an unforced `cachedFetch` whose load throws returns the expired value with its own (old) `fetchedAt` and logs the `[tag]` warning. A forced refresh still reports the failure. Today's 365-day tier hides the loss; steps 3–4 would make it frequent (HLTB 403/429s, breakers, budgets).
2. Empty results of a released game cap at 90 days (`capExpiry` function form, `EMPTY_CACHE_TTL_MINUTES`).
3. Age cap: store page and browse item at write, rating/HLTB/ProtonDB on read, the store-row shim, the spread.
4. Age cap on rarity in `/api/achievements`.
5. Docs: data.md ("Young games" beside "Confirmed absences", the tier table), integrations.md (volume, step-0 findings), close C317; one CHANGELOG entry (Changed) at the `--no-ff` merge.

## Tests

Fake clock (`t.mock.method(Date, 'now', …)`, seeded rows via `_reset`):

- `test/cache.test.js`: extend the `capExpiry` test — function form, lowers only, from the write time.
- `test/server.test.js:1474` ("a released game's empty sources keep the long tier") becomes "expire at 90 days".
- Rating cached at day 10 is refetched after day 15; a 3-year-old game keeps the tier; a fuzzy or unknown date keeps the tier; age ≤ 0 gets the floor; the unreleased miss cap still wins (`test/steam.test.js` coming-soon cases); store page rows share one expiry; a row past its cap gets now + spread and keeps its `fetchedAt`; the details stream path and `/api/achievements` rarity are capped.
- Step 1: a failed refetch of an expired rating row returns the old value and its `fetchedAt`; a forced one still fails; the sweep keeps it within the grace and drops it after.

## Step 0

Scripts in the session scratchpad (`step0.js`, `force.js`, `diff.js`); the copy itself stays out of the repo.

- Release dates: 6193 of 6501 store pages have a full date that round-trips through `releaseDateFormat`; the 308 others are coming soon (31 full dates among them), partial ("2026", "Q4 2026", "October 2026") or empty. 144 games have both a dated browse item and a store page (browse items only carry `release` since recently): 0 disagree on `coming_soon` or the date.
- Rows the policy lowers: ~1400–2000 per prefix of ~6600 (games under 2 years old at write). Past their new cap today: 179 games (~180 rows per prefix, 43 rarity) — over the 0–7 day spread, ~26 games a day, far under `STORE_DETAILS_MAX_PER_5_MIN` (190) and `HLTB_SEARCH_MAX_PER_5_MIN` (150).
- Do young scores move? 30 games released in the last 6 months, cached 16–61 days ago, forced once locally (30 × 200, no source failed):
  - Cached at day 0–9 (13 games): review label changed for 4 (e.g. Very Positive 84.9% → Mostly Positive 70.4%), percent moved up to 16 points, reviews ×1.1–×14; ProtonDB tier appeared or changed for 9; HLTB appeared for 5, main time 23.2 → 41.1 h for one.
  - Cached at day 11–56 (11 games): no label change, percent within 0.5 point, ProtonDB tiers unchanged; HLTB times still moved for 4 (all under ~40 submissions).
  - Cached at day 70–126 (6 games): one label change (95.4% crossing 500 reviews into Overwhelmingly Positive), the rest stable.
  - So the change sits in the first ~2 weeks and decays after: the half-age ratio and 1-day floor stand.
