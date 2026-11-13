# Third-party integrations

Every upstream this app talks to, and what is undocumented about each; bundles, prices, Fanatical, Humble Choice and PC Game Pass are in [bundles-and-prices.md](bundles-and-prices.md). Cache tiers and TTLs: [data.md](data.md); request counters and budgets: [observability.md](observability.md); pacing settings: `default.env` and [configuration.md](../user/configuration.md).

- [Trust tiers](#trust-tiers)
- [Request volume and pacing](#request-volume-and-pacing)
- [HLTB — no npm package](#hltb--no-npm-package)
- [Owned games — `GetOwnedGames`' playtime fields](#owned-games--getownedgames-playtime-fields)
- [Wishlist — undocumented endpoint](#wishlist--undocumented-endpoint)
- [Friends — documented, keyed endpoint](#friends--documented-keyed-endpoint)
- [Tags & demo link — store browse data](#tags--demo-link--store-browse-data)
- [Store metadata — appdetails](#store-metadata--appdetails)
- [Reviews — `GetAppReviews`](#reviews--getappreviews)
- [ProtonDB — undocumented summary endpoint](#protondb--undocumented-summary-endpoint)
- [Achievements — keyed `ISteamUserStats`](#achievements--keyed-isteamuserstats)
- [News — `GetNewsForApp`](#news--getnewsforapp)
- [Looking up an arbitrary game](#looking-up-an-arbitrary-game)
- [A developer's or publisher's games — store search results](#a-developers-or-publishers-games--store-search-results)

## Trust tiers

- **Sanctioned**: Steam's keyed `api.steampowered.com` endpoints (among them `ResolveVanityURL` and `GetOwnedGames`, `lib/steam.js`), its key-less `GetAppReviews`, `GetNewsForApp` and `GetGlobalAchievementPercentagesForApp`, Steam OpenID's `check_authentication` (`lib/auth.js`) and the IsThereAnyDeal API — documented.
- **Untrusted**: everything else here — HLTB's search API, Steam's wishlist/store-search/search-results/store-browse/appdetails/packagedetails/ajaxresolvebundles/ajaxgetstoretags endpoints, ProtonDB, Fanatical's storefront feed, Microsoft's Game Pass catalog and product catalog. Undocumented, reached without a key (sometimes with spoofed browser headers), not guaranteed sanctioned by their terms, liable to break or be blocked without notice. Usage is low-volume and non-commercial; **don't scale up request volume without revisiting these notes.**
- **Other people use the live site** (steam.isonoe.net), so their Steam IDs and profiles pass through it: attribution and privacy are real requirements, not a local tool's.

## Request volume and pacing

- **A young game is refetched as it ages** ([data.md](data.md#cache-tiers)'s half-age rule): ~16 refetches of its reviews, HLTB, ProtonDB, store page and browse item over its first two years, simulated at ~0.44 calls a day per upstream for a 1310-game library. Confirmed worth it on production's cache (2026-11-08): of 30 games released in the last 6 months and refetched, those cached in their first ~9 days changed review label (4 of 13), ProtonDB tier (9 of 13) or gained HLTB times (5 of 13); those cached later barely moved, except HLTB times resting on few submissions. The first deploy left 179 games past their new cap, spread over a week.
- **Link previews** (`linkPreview`, `server.js`) read the cache only, so crawler traffic costs no upstream request. From a Steam profile they show `personaname` and `avatarfull` only, both public even on a private profile, never a game count; chat apps keep their own copy of a card, past a later profile change.
- **Circuit breakers** (`lib/circuitBreaker.js`) on the ones that answer a block with a 403 — Steam's store, HLTB's search, ProtonDB: 2 consecutive 403s leave that upstream alone for 5 minutes, including requests already queued when it trips.
- **Pacing**:
  - Steam's store takes 2 requests in flight, each slot pausing `STORE_MIN_INTERVAL_MS` before reuse; HLTB's search, ProtonDB, the store browse API and Steam reviews take 3 each, pausing `UPSTREAM_MIN_INTERVAL_MS` — enough to keep pace with the store on a cold load.
  - A 429 pauses every request of its call group — the store, store details, reviews, the store browse API, the other key-less `api.steampowered.com` calls (wishlist, news, achievement percentages), HLTB search, ProtonDB — for its `Retry-After` (seconds or an HTTP date), uncapped; without one, 2 s doubling per 429 up to 30 s, the requests refused together counting once (`createRetryingFetch`, `lib/upstream.js`).
  - Store details (`getAppDetails`) are capped at `STORE_DETAILS_MAX_PER_5_MIN` sends in any rolling 5 minutes, retries included, under Steam's limit ([appdetails](#store-metadata--appdetails)). The cap is taken before a store slot, so a backlog never holds the slots search and bundle lookups share (`createWindow`, `lib/upstream.js`).
  - HLTB searches are capped the same way at `HLTB_SEARCH_MAX_PER_5_MIN` ([HLTB](#hltb--no-npm-package)); a single-game lookup (`GET /api/game-details/:appid`) reserves ahead of a list's backlog, unless its game is already queued by that list.
  - A store or reviews request is retried at most twice before failing; the other groups aren't retried, and every request still queued waits out the pause.
  - Each group pauses alone: whether key-less calls share one Steam quota (store browse, reviews and the rest) is unconfirmed.

## HLTB — no npm package

The `howlongtobeat` npm package was removed (it pulled in a vulnerable `axios`); HLTB is called directly, untrusted tier, with spoofed browser `User-Agent`/`Referer` headers:

1. `GET https://howlongtobeat.com/api/search/site/init?t={ms}` → `{ token, hpKey, hpVal }`
2. `POST https://howlongtobeat.com/api/search/site` with `X-Auth-Token`, `X-Hp-Key`, `X-Hp-Val` headers and `{ [hpKey]: hpVal, ...payload }` in the body

- **When it breaks**: HLTB renames these endpoints from time to time (they were `api/bleed/*`); recent npm packages such as `howlongtobeat-ts` reverse-engineer the new flow quickly and are the first place to look.
- **Rate limit (assumed, not documented)**: on the three days a large cold load ran at ≈ 3 searches/s (2026-10-23, 10-26, 11-02), HLTB answered 25–95 × 429, then 2–13 × 403 (a block); quiet days (≤ 103 searches) never erred. `daily` has no timing, so the limit is unknown: `HLTB_SEARCH_MAX_PER_5_MIN` is a conservative guess. Confirmed when a large cold load shows `windowWaits['hltb-search']` with 0 × 429.
- **Token**: cached in memory for 5 minutes (session-bound, not on disk), read when a search gets its slot, not when it queues: a search that waited in the window would otherwise send an expired one. A 401/403 from search clears it.
  - A 403, or a 401 on the current fresh token (one no search has accepted yet), is a block: it holds off re-init for 30 s, and two in a row trip the breaker. 401s on searches queued behind a token already rejected count once, not each; every 403 counts.
  - A 401 on a token searches already accepted is expiry: re-init at once. Assumed, not documented: HLTB's real token lifetime is unknown, so a fresh token idle long enough to expire reads as a block: a 30 s hold.
  - A 200 counts as a success only with a `data` array: any other body fails that search uncached, without accepting the token or resetting the breaker's streak.
- **A failed lookup** (429, block, network, malformed body) isn't cached, since it would read as no data: the game's lookups fail without a request for 10 minutes instead (`failedLookups`, `lib/hltb.js`), unless forced by ↻; an expired match is served meanwhile ([data.md](data.md#cache-tiers)). A client-budget refusal doesn't count.
- **Matching**: Levenshtein similarity (`stringSimilarity`); below 0.35 is discarded.
- **What's searched**: the store metadata's `type` skips the types nobody launches (`NEVER_LAUNCHED_TYPES`, `lib/steam.js`), demos and ads (`NOT_PLAYED_TYPES`, `lib/hltb.js`), and an unreleased game by ProtonDB's rule below, which read as no data rather than failed. Tools are still searched: none of the types the app knows (`TYPE_LABELS`) marks them — an assumption from observed data, not Steam's docs.
- **Times** (`pickBestMatch`): `main` (`comp_main`), `extra` (`comp_plus`), `completionist` (`comp_100`) and `all` (`comp_all`), seconds converted to hours rounded to the half hour, as HLTB's own site shows them.
  - `all` ("All PlayStyles") is **not** the average of the other three: it pools every submission regardless of category (`comp_all_count` = the sum of the three counts), so it usually lands near Main Story.
  - Being one representative number, it's what the table, the ranking card and the panel show first ([game-table.md](game-table.md#the-game-table), [panel-and-lightbox.md](panel-and-lightbox.md#the-side-panel)).

## Owned games — `GetOwnedGames`' playtime fields

- `playtime_forever` and `rtime_last_played` feed Played and Last Played; `playtime_2weeks` (minutes, sent only when above 0) feeds Compare's **Playing lately** and its **Last 2 weeks** columns. Valve's wiki lists `playtime_2weeks` as minutes played in the last two weeks, from memory: the page answered 403 when checked (2026-10-30), so this is unconfirmed.
- The window is Steam's two weeks before the library's cached copy, which lives up to `LIBRARY_CACHE_TTL_MINUTES`. `/api/common-games` leaves an account out of `recentPlaytime` once its copy is over 14 days old: its two weeks then say nothing about now.

## Wishlist — undocumented endpoint

- `getWishlist` calls `https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid={id}` — absent from Valve's published docs, untrusted tier. Works with a plain request and no key (checked 2026-10-10: same answer with or without one).
- A private wishlist, a private profile and an empty wishlist all return `200` with `{"response":{}}` (no `items`), so a missing `items` is treated as an empty wishlist — the cases can't be told apart.

## Friends — documented, keyed endpoint

- `getFriendList` calls `https://api.steampowered.com/ISteamUser/GetFriendList/v1/?key={key}&steamid={id}` — sanctioned tier. It returns only `steamid`s; names and avatars come from the batched `GetPlayerSummaries` (at most 100 ids per call, Valve's documented limit; larger sets go out in chunks, 3 at a time: `mapChunks`, `lib/upstream.js`, which ITAD's batch lookups and prices use too).
- A private friends list gets a `401`, so unlike the wishlist it's distinguishable: cached as `null` (not `[]`), and `POST /api/friends` reports those steamids as `unavailable`.

## Tags & demo link — store browse data

`resolveSteamTags` (`lib/steam.js`) reads the user tags shown on the game's own store page (and so on SteamDB and ITAD), not SteamSpy's separate dataset, which is sparse for niche or recent games. Two undocumented, key-less endpoints:

- `https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json={"ids":[{"appid":N}],"context":{"language":"english","country_code":"US"},"data_request":{"include_tag_count":30,"include_basic_info":true,"include_release":true,"include_platforms":true,"include_assets":true}}` — the app's whole store browse item.
  - `tagids` are already ordered by relevance, as the store page shows them; all are shown (20 at most, whatever `include_tag_count` asks).
  - `tags: [{tagid, weight}]` gives the votes behind that order, in the same order. `resolveSteamTags` sends each weight relative to the game's top tag (raw counts don't compare across games, and some top tags are capped at 10000), as `tagWeights` on `/api/game-details`.
  - `extractDemoAppid` reads `related_items.demo_appid` from the same item, for the panel's demo banner ([panel-and-lightbox.md](panel-and-lightbox.md#the-side-panel)).
  - The **whole raw item** is cached (`browse:{appid}`), so a new field from it needs only a new extractor, no new request; `fetchFastDetails` reads it once for all of them.
  - `extractBrowseBasics` reads the part of a list row's store metadata it carries, so rows fill before appdetails (under Steam's store details cap): `name`, `type`, `basic_info.short_description/developers/publishers`, `release.steam_release_date` (unix s) and `is_coming_soon`, `platforms.windows/mac/steamos_linux`, `assets` (file names under `asset_url_format`, served from `https://shared.akamai.steamstatic.com/store_item_assets/`). Confirmed 2026-11-02 on released and coming-soon games.
  - Not in it: genres, Metacritic, achievements, DLC, languages, price; categories only as ids. Those stay appdetails'.
  - The date is formatted in Pacific time, as appdetails' string (Portal 2: Apr 18, Apr 19 in UTC); a coming-soon date short of a full one (`coming_soon_display` other than `date_full`) waits for appdetails' wording.
  - An item cached before these fields were requested has none: its basics come from cached appdetails, never fetched for it, until the row's next refresh.
  - A reply without a `response` object fails, uncached. An item with `success` ≠ 1, or a single-id `response` without `store_items` (protobuf-JSON drops an empty list), is cached as no item (`null`). Confirmed 2026-11-08: an unknown or delisted app comes back as `{"id":N,"appid":0,"success":15,"visible":false}`, so a reply's items are matched by `id`, not `appid`.
  - **Batched**: `ids` takes many apps. Confirmed 2026-11-08: 50, 100 and 120 ids all answered in full (one item per id, in request order, a duplicate id answered twice), 120 ids = a 3.9 KB URL, a 319 KB reply in 0.6 s; an item is the same as from a single-id call. No cap found; not probed past 120.
  - A details stream prefetches its uncached games' items 50 per call, 2 calls at a time (`prefetchStoreBrowseItems`, `lib/steam.js`), so a cold list costs ~1/50 of the calls, each heavier. An id missing from a batch reply stays uncached (a cut-short reply mustn't cache a false miss) and its game fetches it alone; so does every id of a failed chunk, which starts no further chunk.
- `https://store.steampowered.com/actions/ajaxgetstoretags?l=english` — tagid → name, one near-static list of ~430, cached for 30 days (`tagnames:all`, about 12 calls a year); the parsed map stays in memory until that row is rewritten or expires. A reply without a non-empty `tags` array fails and isn't cached; after a failure the map isn't refetched for 30 s (`tagNameHoldOff`, `lib/steam.js`).
- A cache key whose value shape changes gets a new prefix rather than reusing the old one: a shape check can't tell an old value from a new one of the same JS type (an empty array, say). Retired keys age out with the TTL sweep.

## Store metadata — appdetails

`getAppDetails` (`lib/steam.js`) calls the undocumented `store.steampowered.com/api/appdetails?appids={id}`, on the store's limiter and breaker.

- **Rate limit (assumed, not documented)**: about 200 requests per 5 minutes per IP, then 429. Evidence: on 2026-11-02 the live server got 677 × 200 and 37 × 429 in 1059 s, against 706 predicted by a 200 / 5 min rolling cap (200 + 200 × 759/300); community reports give the same figure. Unknown whether Steam counts the store's other endpoints in it: the cap's margin under 200 leaves them room.
- **The reply can be keyed under another appid.** Since about 2026-09-24 many games come back as `{"<other id>": {"success": true, "data": {"steam_appid": <requested id>, …}}}`, the key often one of the game's DLCs (e.g. 1656930 → `"3290770"`, 39210 → `"4831120"`). The data is right, only the key is wrong: `getAppDetails` falls back to the entry whose `data.steam_appid` matches the request, so a different game's entry is still rejected. Seen elsewhere too: [romm#4774](https://github.com/rommapp/romm/pull/4774), [EnhancedGV#9](https://github.com/Featherwolf/EnhancedGV/pull/9).
- **Software is typed `game` too** (RPG Maker, a launcher; checked 2026-10-23 over 1,206 cached entries: types were only `game`, `demo`, `advertising`, `mod`). Only its genres tell it apart — Utilities, Design & Illustration, Web Publishing, Game Development seen; Animation & Modeling, Video/Audio Production, Photo Editing, Software Training assumed from the store's genre list — so `tagTaste.ts`'s `isSoftware` reads those.
- The fetch pins `cc=us`, so the launch price `computeProductionTier` reads is always USD ([decisions.md](decisions.md)).
- **Images load browser-direct from Steam's CDN**, never through the server (a table's capsule sizes: [game-table.md](game-table.md#the-game-table)).
  - The panel reads the open game's capsule once more, in CORS mode, to tint its ground (`artTint.ts`): the CDN answers `Access-Control-Allow-Origin: *` (checked 2026-10-19), so the browser cache usually serves it; without that header the canvas would be tainted and the ground stays neutral.

## Reviews — `GetAppReviews`

- `getGameRating` (`lib/steam.js`) calls the documented, key-less [`IUserReviewsService/GetAppReviews`](https://partner.steamgames.com/doc/webapi/IUserReviewsService) with `input_json` `{appid, languages: ['all'], purchase_type: 1, num_per_page: 1}` and reads only `response.query_summary` (`total_reviews`, `total_positive`, `review_score_desc`).
- It replaced `store.steampowered.com/appreviews/{appid}?json=1`, which Steam switched off on 2026-10-22: it now redirects every app to the store's home page.
- **Assumption**: `purchase_type: 1` counts every purchase (Steam and keys), like the old `purchase_type=all`. The enum's values aren't in the docs; Portal 2's totals for 1 equal 0 (Steam) plus 2 (non-Steam), and match the old endpoint's cached counts.
- `num_per_page: 0` is ignored (20 reviews, ~16 KB); 1 keeps a response under 1 KB.
- Key-less calls share Steam's lower rate limit and answer 429 past it; only a key tied to the app raises it, so none is sent. Own limiter, no circuit breaker (it doesn't answer 403).
- No reviews (`total_reviews` 0 or absent — an unknown appid answers `{"response":{}}`) is cached as `null`: no data, not a failure. A reply without a `response` object fails, uncached.

## ProtonDB — undocumented summary endpoint

`getProtonDbStatus` (`lib/steam.js`) calls `https://www.protondb.com/api/v1/reports/summaries/{appid}.json`: untrusted tier, no key, no headers at all, its own limiter and breaker.

- **404**: no reports yet, cached as `null`. A 200 without a string `tier` fails, uncached.
- **Not asked** (cached as a `null` miss, `MISS_CACHE_TTL_MINUTES`) for a DLC, a type nobody launches (`NEVER_LAUNCHED_TYPES`, `lib/steam.js`) or an unreleased game — `comingSoon` on the browse item _and_ no Steam reviews yet (the rating call each game makes anyway), since the browse item can be a year old; a failed reviews call asks as usual. Being inferred, it only spares a lookup with nothing cached: a summary already cached is served, and a forced refresh asks. Sampled 2026-11-08: 10/10 upcoming games and 15/15 DLC answered 404, as did every cached soundtrack; demos and `advertising` apps (old games re-listed) do have reports, so they're asked.
- **403**: seen as a blanket bot-block (the same page for every appid); the error message carries a body snippet to tell it from a per-game error, and two in a row open the breaker.
- **`tier: "pending"`**: too few reports for a tier, but ProtonDB still publishes a `provisionalTier`; that one is shown, marked `pending: true` so the UI renders it lower-confidence. Only no provisional tier either reads as no data. The raw reply is cached, so this rule can change without busting anything.

## Achievements — keyed `ISteamUserStats`

Documented endpoints whose "no data" answers are error statuses, treated as answers rather than failures:

- **`GetSchemaForGame/v2`** (key): a 403 with a **JSON** body means no achievements (cached as none, on the short miss TTL since a game gets them at release); a 403 with an **HTML** body is a rejected key, a real failure. A released game without achievements answers 200 `{"game":{}}`, read as none (observed: 70, 10). A 200 without a `game` object fails, uncached. `game.gameName` survives a delisting, so it names a game appdetails has no page for (observed: 28050 → `Deus Ex Human Revolution`, the store title without its colon).
  - Its `icon`/`icongray` URLs point at `steamcdn-a.akamaihd.net/steamcommunity/public/images/`, which 404s on recent games' icons (observed: 1215940, 0/58). `getGameSchema` rewrites them on read to `shared.fastly.steamstatic.com/community_assets/images/`, the host Steam's own stats pages use. **Assumption**: that host serves every icon; it served 1192/1192 across 13 games from 2004 to 2026. Drop the rewrite once the API returns that host.
- **`GetPlayerAchievements/v1`** (key): **400** means no stats, **403** a private profile; both cached as `null`, like a reply without `playerstats.success`.
- **`GetGlobalAchievementPercentagesForApp/v2`**: **no key** needed. A 403 with a `{}` body answers both "no achievements" (observed: 70, 10) and "unknown appid", cached as `null` on the short miss TTL; a 200 without an `achievementpercentages` object fails, uncached. `percent` is a numeric string.

## News — `GetNewsForApp`

- `getGameNews` (`lib/steam.js`) calls the documented, key-less `ISteamNews/GetNewsForApp/v2` with `count=20&maxlength=1` and **`feeds=steam_community_announcements`, a parameter Valve's docs don't list**: it keeps only the developer's own posts, the ones the store page shows.
- Without it the reply mixes in third-party press in any language, which can outnumber official posts ten to one — so if Steam drops the parameter, the panel's news fills with that press.

## Looking up an arbitrary game

- **Search**: `GET /api/search-games?q=<term>` (`searchStoreGames`, `lib/steam.js`) wraps `store.steampowered.com/api/storesearch/?term=...&l=english&cc=US`, the endpoint Steam's own store search box uses — untrusted tier, no key. Debounced client-side, and each distinct term costs two upstream calls (`search:` cache): the search, then one batched store browse `GetItems` over its results to drop demos — storesearch types every item `app`, while the browse item's `type` is `1` for a demo (confirmed 2026-10-30 on several searches; `0` game, `4` DLC, `11` soundtrack). If that call fails, demos stay in and the term is cached for `MISS_CACHE_TTL_MINUTES` only. A bare appid or a pasted store URL skips it and goes straight to `/api/game-details`.
- **No ownership check**: `GET /api/game-details/:appid` already serves wishlist games, so any appid works.
- **Never trusts a client-supplied name**: the route resolves the name itself from `getAppDetails(appid)` and searches HLTB with it. A name from the dropdown only avoids a title flash in the panel and is never sent. Cost: HLTB waits for store metadata instead of starting in parallel — a deliberate trade on a public, key-less endpoint.
- Links and the Recently Looked Up list: [frontend.md](frontend.md).

## A developer's or publisher's games — store search results

`searchCreatorGames` (`lib/steam.js`) wraps the store search page's own results feed: `store.steampowered.com/search/results/?{developer|publisher}=<name>&category1=998&infinite=1&count=100` — untrusted tier, no key, not disallowed by `robots.txt`. Nothing sanctioned covers it: `GetItems` only names a game's creators, `IStoreQueryService/Query` silently ignores an unknown filter (returning the whole catalog), ITAD has no creator lookup.

- **Reply**: `{ total_count, start, results_html }`; no match is `total_count: 0, start: -1`. Appids come from each row's `data-ds-itemkey="App_<id>"` — `category1=998` still lets packages through (`Sub_<id>`, base game plus DLC appids), so those are skipped and `total` overcounts slightly.
- **Exact, case-sensitive name**: "Supergiant" or "supergiant games" match nothing. The name `appdetails` gives works as-is (23 checked, including "FromSoftware, Inc.", "ZA/UM", "indie.io"). A publisher spelled differently across its games only matches the games with that spelling.
- **One page, 100 games** in Steam's relevance order: a cold list then costs 1 search call plus one call per game to each details service (`steam-store`, `steam-reviews`…), bounded per client by `STREAM_MAX_PER_IP`. Discovery lists are mostly cold, which is why the cap is one page.
- **In a combined list** (a `developer`/`publisher` source, [lists-and-accounts.md](lists-and-accounts.md#kinds)): at most one search per distinct name, deduplicated and cached like opening that list; details only for the combined result, never more than opening each list. Updated forces every such source, each counted by the `creatorGames` limiter, and a failure fails the whole list, naming the source. A capped source counts its first page only, which the formula line says for a top-level source.
- Rows also carry `data-ds-crtrids` (creator clan ids, as `GetItems`' `creator_clan_account_id`): a name-independent key, unused.
