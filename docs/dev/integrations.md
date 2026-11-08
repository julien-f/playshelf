# Third-party integrations

Every upstream this app talks to, and what is undocumented about each. Cache tiers and TTLs: [data.md](data.md); request counters and budgets: [observability.md](observability.md); pacing settings: `default.env` and [configuration.md](../user/configuration.md).

**Trust tiers.**

- **Sanctioned**: Steam's keyed `api.steampowered.com` endpoints (among them `ResolveVanityURL` and `GetOwnedGames`, `lib/steam.js`), its key-less `GetAppReviews`, `GetNewsForApp` and `GetGlobalAchievementPercentagesForApp`, Steam OpenID's `check_authentication` (`lib/auth.js`) and the IsThereAnyDeal API — documented.
- **Untrusted**: everything else here — HLTB's search API, Steam's wishlist/store-search/search-results/store-browse/appdetails/packagedetails/ajaxresolvebundles/ajaxgetstoretags endpoints, ProtonDB, Fanatical's storefront feed, Microsoft's Game Pass catalog and product catalog. Undocumented, reached without a key (sometimes with spoofed browser headers), not guaranteed sanctioned by their terms, liable to break or be blocked without notice. Usage is low-volume and non-commercial; **don't scale up request volume without revisiting these notes.**
- **Other people use the live site** (steam.isonoe.net), so their Steam IDs and profiles pass through it: attribution and privacy are real requirements, not a local tool's.
- **Link previews** (`linkPreview`, `server.js`) read the cache only, so crawler traffic costs no upstream request. From a Steam profile they show `personaname` and `avatarfull` only, both public even on a private profile, never a game count; chat apps keep their own copy of a card, past a later profile change.
- **Circuit breakers** (`lib/circuitBreaker.js`) on the ones that answer a block with a 403 — Steam's store, HLTB's search, ProtonDB: 2 consecutive 403s leave that upstream alone for 5 minutes, including requests already queued when it trips.
- **Pacing**:
  - Steam's store takes 2 requests in flight, each slot pausing `STORE_MIN_INTERVAL_MS` before reuse; HLTB's search, ProtonDB, the store browse API and Steam reviews take 3 each, pausing `UPSTREAM_MIN_INTERVAL_MS` — enough to keep pace with the store on a cold load.
  - A 429 pauses every request of its call group — the store, store details, reviews, the store browse API, the other key-less `api.steampowered.com` calls (wishlist, news, achievement percentages), HLTB search, ProtonDB — for its `Retry-After` (seconds or an HTTP date), uncapped; without one, 2 s doubling per 429 up to 30 s, the requests refused together counting once (`createRetryingFetch`, `lib/upstream.js`).
  - Store details (`getAppDetails`) are capped at `STORE_DETAILS_MAX_PER_5_MIN` sends in any rolling 5 minutes, retries included, under Steam's limit ([appdetails](#store-metadata--appdetails)). The cap is taken before a store slot, so a backlog never holds the slots search and bundle lookups share (`createWindow`, `lib/upstream.js`).
  - HLTB searches are capped the same way at `HLTB_SEARCH_MAX_PER_5_MIN` ([HLTB](#hltb--no-npm-package)); a single-game lookup (`GET /api/game-details/:appid`) reserves ahead of a list's backlog, unless its game is already queued by that list.
  - A store or reviews request is retried at most twice before failing; the other groups aren't retried, and every request still queued waits out the pause.
  - Each group pauses alone: whether key-less calls share one Steam quota (store browse, reviews and the rest) is unconfirmed.

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
- [IsThereAnyDeal](#isthereanydeal)
  - [Bundles](#bundles)
  - [Resolving bundle games to Steam](#resolving-bundle-games-to-steam)
  - [Prices](#prices)
  - [Currency is passed through, not converted](#currency-is-passed-through-not-converted)
  - [Rate limiting](#rate-limiting)
- [Fanatical — pick-and-mix tier prices](#fanatical--pick-and-mix-tier-prices)
- [Xbox PC Game Pass — catalog feed](#xbox-pc-game-pass--catalog-feed)

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
- **A failed lookup** (429, block, network, malformed body) isn't cached, since it would read as no data: the game's lookups fail without a request for 10 minutes instead (`failedLookups`, `lib/hltb.js`), unless forced by ↻. A client-budget refusal doesn't count.
- **Matching**: Levenshtein similarity (`stringSimilarity`); below 0.35 is discarded.
- **What's searched**: the store metadata's `type` skips the types nobody launches (`NEVER_LAUNCHED_TYPES`, `lib/steam.js`), demos and ads (`NOT_PLAYED_TYPES`, `lib/hltb.js`), and an unreleased game by ProtonDB's rule below, which read as no data rather than failed. Tools are still searched: none of the types the app knows (`TYPE_LABELS`) marks them — an assumption from observed data, not Steam's docs.
- **Times** (`pickBestMatch`): `main` (`comp_main`), `extra` (`comp_plus`), `completionist` (`comp_100`) and `all` (`comp_all`), seconds converted to hours rounded to the half hour, as HLTB's own site shows them.
  - `all` ("All PlayStyles") is **not** the average of the other three: it pools every submission regardless of category (`comp_all_count` = the sum of the three counts), so it usually lands near Main Story.
  - Being one representative number, it's the default HLTB column (`hltbAll`, "HLTB (h)"), the ranking card's "10.5 h to beat", and the panel's HLTB glance chip ("all playstyles"); its How Long To Beat section breaks it down into Main Story, Main + Extra and Completionist.

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
  - `extractDemoAppid` reads `related_items.demo_appid` from the same item, shown as the panel's "🎮 Try the Free Demo" banner (`.panel-demo-banner`) rather than in ⋯ More, since a demo is a call to action.
  - The **whole raw item** is cached (`browse:{appid}`), so a new field from it needs only a new extractor, no new request; `fetchFastDetails` reads it once for all of them.
  - `extractBrowseBasics` reads the part of a list row's store metadata it carries, so rows fill before appdetails (under Steam's store details cap): `name`, `type`, `basic_info.short_description/developers/publishers`, `release.steam_release_date` (unix s) and `is_coming_soon`, `platforms.windows/mac/steamos_linux`, `assets` (file names under `asset_url_format`, served from `https://shared.akamai.steamstatic.com/store_item_assets/`). Confirmed 2026-11-02 on released and coming-soon games.
  - Not in it: genres, Metacritic, achievements, DLC, languages, price; categories only as ids. Those stay appdetails'.
  - The date is formatted in Pacific time, as appdetails' string (Portal 2: Apr 18, Apr 19 in UTC); a coming-soon date short of a full one (`coming_soon_display` other than `date_full`) waits for appdetails' wording.
  - An item cached before these fields were requested has none: its basics come from cached appdetails, never fetched for it, until the row's next refresh.
  - A reply without a `response` object fails, uncached. An item with `success` ≠ 1, or a `response` without `store_items` (protobuf-JSON drops an empty list), is cached as no item (`null`). **Assumption**: those are Steam's answers for an unknown or delisted app.
- `https://store.steampowered.com/actions/ajaxgetstoretags?l=english` — tagid → name, one near-static list of ~430, cached for 30 days (`tagnames:all`, about 12 calls a year); the parsed map stays in memory until that row is rewritten or expires. A reply without a non-empty `tags` array fails and isn't cached; after a failure the map isn't refetched for 30 s (`tagNameHoldOff`, `lib/steam.js`).
- A cache key whose value shape changes gets a new prefix rather than reusing the old one: a shape check can't tell an old value from a new one of the same JS type (an empty array, say). Retired keys age out with the TTL sweep.

## Store metadata — appdetails

`getAppDetails` (`lib/steam.js`) calls the undocumented `store.steampowered.com/api/appdetails?appids={id}`, on the store's limiter and breaker.

- **Rate limit (assumed, not documented)**: about 200 requests per 5 minutes per IP, then 429. Evidence: on 2026-11-02 the live server got 677 × 200 and 37 × 429 in 1059 s, against 706 predicted by a 200 / 5 min rolling cap (200 + 200 × 759/300); community reports give the same figure. Unknown whether Steam counts the store's other endpoints in it: the cap's margin under 200 leaves them room.
- **The reply can be keyed under another appid.** Since about 2026-09-24 many games come back as `{"<other id>": {"success": true, "data": {"steam_appid": <requested id>, …}}}`, the key often one of the game's DLCs (e.g. 1656930 → `"3290770"`, 39210 → `"4831120"`). The data is right, only the key is wrong: `getAppDetails` falls back to the entry whose `data.steam_appid` matches the request, so a different game's entry is still rejected. Seen elsewhere too: [romm#4774](https://github.com/rommapp/romm/pull/4774), [EnhancedGV#9](https://github.com/Featherwolf/EnhancedGV/pull/9).
- **Software is typed `game` too** (RPG Maker, a launcher; checked 2026-10-23 over 1,206 cached entries: types were only `game`, `demo`, `advertising`, `mod`). Only its genres tell it apart — Utilities, Design & Illustration, Web Publishing, Game Development seen; Animation & Modeling, Video/Audio Production, Photo Editing, Software Training assumed from the store's genre list — so `tagTaste.ts`'s `isSoftware` reads those.
- The fetch pins `cc=us`, so the launch price `computeProductionTier` reads is always USD ([decisions.md](decisions.md)).
- **Images load browser-direct from Steam's CDN**, never through the server. A game table loads one per row: `capsule_image` (231×87, ~12 KB), falling back to `capsule_imagev5` (184×69, ~8 KB): the larger one costs bytes (×1.5), not requests.
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

- **Search**: `GET /api/search-games?q=<term>` (`searchStoreGames`, `lib/steam.js`) wraps `store.steampowered.com/api/storesearch/?term=...&l=english&cc=US`, the endpoint Steam's own store search box uses — untrusted tier, no key. Debounced client-side, and each distinct term costs two upstream calls (`search:` cache): the search, then one batched store browse `GetItems` over its results to drop demos — storesearch types every item `app`, while the browse item's `type` is `1` for a demo (confirmed 2026-10-30 on several searches; `0` game, `4` DLC, `11` soundtrack). If that call fails, demos stay in and the term is cached for `MISS_CACHE_TTL_MS` only. A bare appid or a pasted store URL skips it and goes straight to `/api/game-details`.
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

## IsThereAnyDeal

Bundle browsing (`/bundles`, `/lists/bundle/:bundleId`) and every price column come from the [IsThereAnyDeal API](https://docs.isthereanydeal.com/) via `lib/itad.js` — free, key-gated, with published (if sparse) OpenAPI docs: sanctioned tier.

- **Optional**: gated on `ITAD_API_KEY`. `isItadConfigured()` (`server.js`) is checked per request; `GET /api/bundles`, `GET /api/bundles/:id`, `POST /api/bundles/resolve`, `POST /api/prices`, `GET /api/game-bundles/:appid` and `GET /api/game-pass` return 503 when unset, and the frontend hides those surfaces (`GET /api/health`'s `itadConfigured`).
- **Batches of 200 ids** (`BATCH_MAX`) for every multi-id call: documented for `/games/prices/v3` (`gids-200`); an assumption for the two `/lookup/` endpoints, whose docs list no cap. A larger set goes out in chunks, 3 at a time (`mapChunks`, `BATCH_CONCURRENCY` in `lib/upstream.js`), each cached as it returns.
- **Bundle shape checked before caching** (`repairBundle`, `lib/itad.js`): a mistyped field readers use is replaced (`null`, `[]` or removed) with an `[itad]` warning naming the bundle and field, the bundle kept: dropping it would shorten the page, which every walk reads as the last one. A bundle without an integer `id` and a string `title` fails its page as an upstream error.
- **Data errors** (a wrong date, price or listing) are corrected by editing the bundle on isthereanydeal.com, with a regular account: [IsThereAnyDeal-Issues](https://github.com/IsThereAnyDeal/IsThereAnyDeal-Issues) closes them with that answer (#3576, #3578), so there's no issue to track.
- **End-date overrides** (Fanatical's `valid_until`, Humble Choice's schedule) are permanent rules, not workarounds: ITAD's dates ran early repeatedly. `overrideExpiry` (`lib/itadDates.js`) tallies, per bundle still on sale, whether ITAD's date already matches to the minute; `GET /api/metrics` raises an `itad-dates` info alert once all do (at least 3 Fanatical bundles, 1 Humble Choice): the override may be removable.
- **Links are passed through unmodified** — ITAD's terms require prices and links as returned. An opened bundle's hero shows "View on IsThereAnyDeal ↗" (`details`) and "Get this bundle ↗" (`url`, the shop/affiliate link with its tracking params). The one addition anywhere is **Buy on Fanatical**'s `scg=…` parameter ([Fanatical](#fanatical--pick-and-mix-tier-prices)), inside that same link; every tracking parameter is left alone.

### Bundles

- **`GET /bundles/v1`** (`getBundles`, `GET /api/bundles`): current bundles, paginated (`offset`/`limit`, max 50/page), with a `country` param driving currency and (per ITAD, presumably) regional pricing.
- **`mature=true` is always sent**: it's ITAD's _include_ switch, not an "only mature" filter, and the app has no age gate. Defaulting to `false` once hid 33 of 35 active bundles, including ones with no game carrying ITAD's per-game `mature` flag.
- **No single-bundle endpoint upstream**, so `GET /api/bundles/:id` (`findBundleById`) searches: active bundles first (`expired=false`), then expired, up to `BUNDLE_SEARCH_MAX_PAGES` (6) pages of 50 each per state, then 404s. Each page reuses `getBundles`' cache. `fetchBundleById` (`public/bundleData.ts`) always calls this route, never the `/bundles` picker's possibly different list.
- **Tiers**: `tiers[]` are price-ascending, and a game can appear in several; `flattenBundleGames` (`public/bundleData.ts`) dedupes by ITAD game id, keeping the cheapest tier.
  - Confirmed on cached data (38 bundles): each tier lists only the games it adds. Some bundles list every game under the first tier and leave pricier ones empty (e.g. 16599, TrineVerse Triple Co-op Pack: €10.55 / €14.77 / €18.99, all 5 games in the first); the last tier with games then shows a range up to the priciest empty tier (`tierPriceMax`, also from `extractGameBundles`), since which tier holds which game is unknown. An empty unpriced trailing tier is ignored.
- **Add-on tiers** (`addon: true`) are bought apart from the base tiers: not cumulative, not in price order, never part of a base tier's range (e.g. 16689: $4 / $6 / $9 / $13 / $16 base, $2 and $4 add-ons). An empty unpriced add-on (e.g. 14804) prices nothing and is dropped.
- **A `null` tier price is not free.** In practice it's Fanatical's "Build Your Own ⟨N⟩ Bundle": one tier, a pool of 15–30 games, priced by quantity. A free or pay-what-you-want tier would carry `{amount: 0, …}` (never observed yet).
  - When Fanatical's feed has the bundle, its quantity tiers stand in ([Fanatical](#fanatical--pick-and-mix-tier-prices)); otherwise `/bundles` renders `cheapestTierPrice`'s (`bundleRows.ts`) null and `renderTierPrice` (`ListRoute.tsx`) a null tier as "Varies"/"Price varies", keeping "Free" for `amount === 0`.
  - The `tierPrice` column uses `compareNumMissingLast`, or `null` would sort as 0 — every Build Your Own game first under the default ascending sort.
- **`GET /games/bundles/v2`** (`getGameBundles`/`extractGameBundles`, `GET /api/game-bundles/:appid`): the bundles one game is in, for the panel's Price card.
  - Verified live: full `/bundles/v1`-shaped objects, current only unless `expired=true` (one game: 1 by default, 8 with it).
  - appid → gid reuses `resolveItadIds`; cached raw per (gid, country) as `itad-gamebundles:`.
  - Each line shows the cheapest tier holding the game; a pick-and-mix tier shows its best quantity rate ("from €1.17/game", `withPickAndMix`), "Varies" when Fanatical's feed lacks it.
  - Assumption: a game ITAD maps only via a Steam sub counts as in the bundle — ITAD matches by gid, passed through.
- **Humble Choice end date** (`lib/humbleChoice.js`): a Choice bundle (`page.name` `Humble Bundle`, `url` wrapping `humblebundle.com/membership/<month>-<year>`) gets Humble's schedule as `expiry` — the first Tuesday of the next month, 10:00 `America/Los_Angeles` — on every route and the link preview, with no upstream call.
  - Why: ITAD's ran early. October 2026's ended at `2026-11-03T17:00:00+01:00` (16:00Z) on ITAD, which then moved it to `expired=true`; humblebundle.com sold it until 18:00Z (its countdown and the end date in its /membership page's data). Regular Humble bundles' ITAD dates matched Humble's pages.
  - Schedule source: Humble's monthly reveal, first Tuesday 10 AM PT (press coverage, e.g. Gamewatcher's monthly lists). Seen on one month only; a PDT month is unconfirmed.
  - The Choice on sale now is pulled back from ITAD's expired pages like a Fanatical bundle ([Bundles ITAD expired early](#fanatical--pick-and-mix-tier-prices)), the walk reaching back to its month's start minus 7 days.

### Resolving bundle games to Steam

Bundle games carry only an ITAD id (uuid), slug and title. `resolveSteamAppIds` (`lib/itad.js`, `POST /api/bundles/resolve`):

1. Steam's ITAD shop id via `GET /service/shops/v1`, by title (`getShopId`, `itad-shop:steam`).
2. The game ids through **`POST /lookup/shop/{shopId}/id/v1`** — not the `/lookup/{shopId}/gid/v1` the sibling endpoints' naming suggests; ITAD's convention is `/lookup/{lookup-what}/{by-what}/`, confirmed against the live API. Each shop id comes back namespaced: `"app/<id>"` (a store page, used directly), `"sub/<id>"` (a package) or `"bundle/<id>"` (a Steam bundle page).
3. **`sub/` and `bundle/` are expanded, not misses** (`expandSteamShopId`), through two more untrusted, key-less Steam endpoints (`lib/steam.js`):
   - `GET /api/packagedetails?packageids=<id>` (`resolveSteamPackageAppids`): usually one title with no `app/` page of its own (confirmed live on "Garbage Dwellers Bundle") → one appid.
   - `GET /actions/ajaxresolvebundles?bundleids=<id>` (`resolveSteamBundleAppids`): usually a real multi-item package (confirmed live: Steam bundle 4995, EVERSPACE - Ultimate Edition → base game + 2 DLC) → an array.
   - `resolveSteamAppIds`/`resolveBundleAppids`/`resolveBundleGames` (`public/bundleData.ts`) carry `number | number[] | null` through; an array becomes one row per appid sharing the gid's metadata. Cached as `steampkg:`/`steambundle:`.
   - This is the one place `lib/itad.js` calls into `lib/steam.js`, since a Steam package's contents are Steam's data.
4. **`GET /games/info/v2`'s `appid` is the last resort**, only when a `sub/`/`bundle/` expansion comes up empty. Never for a gid with no shop entry at all: every live case with an `info/v2` appid also had a `sub`/`bundle` entry, and `info/v2` has no batch form, so it would spend a request per ebook or soundtrack. At most 3 at once.

- Still nothing → `null`, as for a game with no Steam listing. A lookup that _failed_ rather than came up empty is left uncached, retried on the next resolve, and listed under `failed` instead of `appids`, so the bundle page says Steam didn't answer rather than "not on Steam".
- Each gid's resolution is cached individually (`itad-appid:{gid}`), so a game seen in one bundle is never re-resolved for another.
- `/bundles` resolves every active bundle's gids on each visit with an account (its Wishlist / New to you columns): ~3 ITAD lookups and one Steam package lookup per `sub/`/`bundle/` gid (~1% of them, measured on a dev `db.sqlite`) on a cold cache, none once cached; expired bundles aren't resolved.

### Prices

**`POST /games/prices/v3`** (`getPrices`/`extractPriceInfo`, `POST /api/prices`) supplies the price columns, per ITAD game id and `country`:

- **`historyLow.{all,y1,m3}`**: the lowest price across every shop ITAD tracks, not Steam-only.
  - **It includes undiscounted prices.** The docs don't define it in prose; their sample response shows a deal with `cut` 0 and `regular` 9.99 beside `historyLow.m3` 9.99. So `dealRecordTier` (`public/utils.ts`) awards no record tier when the best deal has no discount (`bestDealCut` 0, or a price at or above Steam Full Price).
- **`deals[]`**, each shop's current `price`/`regular`/`cut`/`url`. `extractPriceInfo` reads it twice: the Steam shop's entry for its `regular` (Steam Full Price), and the lowest `price.amount` across all for `bestDeal: {price, shop, url}` — `url` lets the panel's Price card link straight to the deal. One response is all in the requested currency, so no conversion is needed.
- **Discount is computed against Steam Full Price, not ITAD's `cut`.** `cut` is each shop's discount off its own regular price, inconsistent across shops; `discountPct` (`public/utils.ts`) computes `1 − bestDeal/steamRegular` against the one stable reference. No clamping needed: Best Deal includes Steam, so it's never above Steam's price. `extractPriceInfo` doesn't surface `cut` at all. `renderCut` shows 0 as "—".
- **Cached per (gid, country)** (`itad-price:{country}:{gid}`): a price differs per region, not just its currency label.
- **One route for bundles and wishlists**, since only the identifier differs: a bundle sends `gids`; a wishlist (or a saved or shared list built from one or from a bundle, `listHasPriceSource`) sends `appids`, which the route resolves first via `resolveItadIds` — `POST /lookup/id/shop/{shopId}/v1`, confirmed live: takes `["app/<appid>", …]`, returns `{"app/<appid>": "<uuid>"|null, …}` keyed by what was sent. Each appid is cached individually (`itad-gid:{appid}`), a confirmed miss included. Exactly one of `gids`/`appids`, else 400. No route exposes appid → gid, since nothing needs the raw gid.
- **Chunks**: the server caps a call at `MAX_PRICE_LOOKUP_GAMES` (500), and `loadPrices` (`ListRoute.tsx`) chunks to match, sequentially — a wishlist can exceed it, a bundle never does.
- **A bundle's prices load concurrently with its details stream**: pricing has nothing to do with ratings/HLTB/tags.
- **A failed call** (rate limit, upstream error) sets every row's price fields to `null` ("—", not the loading "…") and says so in the list's price status line (`loadPrices`).
- **Default columns**: Best Deal and Discount visible; Steam Full Price (named so it reads as the list price), All-Time Low, Best Deal Shop, 1yr Low and 3mo Low hidden — Best Deal + Discount already answer "is this a good deal".

### Currency is passed through, not converted

- A tier or game price is in whatever currency ITAD's upstream shop charges; most shops (Humble, GreenManGaming, most Fanatical bundles) switch per region, but some only ever price in USD (verified live: a shop ITAD lists as "Digiphile", and at least one Fanatical bundle). That's upstream behavior, noted beside the region picker, not something to convert away.
- So a row keeps **two currency fields**: `tierCurrency` (from the bundle's tier data, Tier Price only) and `priceCurrency` (always set from the price response, the other five price columns). One shared field once mislabeled USD tier prices with the region's symbol, or the reverse, depending on which request answered first. `formatMoney(v, currency)` (`public/utils.ts`) is called by `renderPrice` (`gameColumns.ts`) and `renderTierPrice` (`ListRoute.tsx`) with their own field.

### Rate limiting

- `BUNDLES_RATE_LIMIT_MAX` backs six limiters — `bundlesListLimit`, `bundlesByIdLimit`, `bundlesResolveLimit`, `pricesLimit`, `gameBundlesLimit`, `gamePassLimit` — each `skip`ping a request it can answer from cache by checking the cache keys that route reads (the same pattern as `detailsLimit`); `bundlesListLimit` checks only the page it serves, not the expired pages `findEarlyExpired` may walk. Without the skip, reloading a bundle page a few times would 429 a genuinely new bundle open.
- `pricesLimit` checks `itad-price:` for whichever of `gids`/`appids` was sent, plus `itad-gid:` for `appids`.
- `bundlesByIdLimit` can't skip — `findBundleById` walks a variable number of pages — so it gets twice the budget instead; its pages are still cached underneath.

## Fanatical — pick-and-mix tier prices

- **Why**: ITAD lists a Fanatical "Build your own" bundle as one tier with `price: null`; the real pricing is by quantity ("pick 5 for €5.99, 10 for €9.99…").
- **Source**: `GET https://www.fanatical.com/api/all/en` (`lib/fanatical.js`) — the storefront's own undocumented, key-less feed: untrusted tier. Fanatical has no public API; its sanctioned product data is the CJ affiliate feed, which needs an affiliate account. The per-bundle `/api/pick-and-mix/<slug>/en` answers a scripted request with `403 Request blocked`, so it isn't used.
- **Volume**: one call serves every bundle, whichever route asks (`/api/game-bundles` included). Only the `pickandmix[]` slug → `{tiers, products, type, validFrom, validUntil}` map is kept (`products`: each pick's `name` and `slug`; `type` is `bundle` for games, else books/e-learning/software, which ITAD doesn't list; the feed is ~800 KB), cached as `fanatical-pnm:v3`. A slug missing from a map over an hour old triggers one re-fetch (a bundle that went live since). A failure serves the last map read (or an empty one) and holds off the feed for an hour (`failureHoldOff`), logged once per attempt — never an error to the client.
- **Matching**: exact, by slug. ITAD's purchase `url` for these bundles is an affiliate redirect wrapping `fanatical.com/<lang>/pick-and-mix/<slug>` (`pickAndMixSlug`). Only bundles whose `page.name` is `Fanatical` and that have a null-price tier are enriched; a bundle Fanatical has stopped selling drops out of the feed and stays "Varies".
- **End date**: an enriched bundle's `expiry` becomes the feed's `valid_until` when it has one (20 of 32 on 2026-11-01), the link preview included (`withCachedPickAndMix`, cached feed only).
  - Why: ITAD's runs early — ~16 h on 11 of 12 bundles, and Build Your Own Killer Bundle (Fall 2026) ended 2026-11-01T00:58 on ITAD while fanatical.com sold it until 2026-11-13T23:59Z (its page's countdown matched `valid_until`). The previous Killer edition also ended at `…T00:58`, maybe ITAD's placeholder when it has no date.
- **Bundles ITAD expired early** (`findEarlyExpired`, `lib/earlyExpired.js`): a games pick-and-mix (`type: 'bundle'`) live by the feed's dates, or the [Humble Choice](#bundles) on sale now, missing from ITAD's active list is looked up on ITAD's `expired=true` pages and listed with the real end date.
  - `GET /api/bundles`: only on an active first page holding the whole list (fewer than `limit`), so the client's paging, which stops there, never repeats one. An active list of 50 or more gets none.
  - The walk reads 50-bundle `-publish` pages, the same cached pages as `findBundleById` and "Include expired", and stops once all are found, at a page older than the oldest missing `validFrom` minus 7 days (ITAD may list a bundle before it goes live), or after 6 pages. `?refresh=1` forces them along with the first page.
  - `GET /api/game-bundles/:appid` adds the found ones holding the game, from cached pages only: ITAD's per-game list has current bundles only.
  - Volume: no extra ITAD call while nothing is missing; else the expired pages back to that bundle's publish date (2 for the Killer Bundle) per region per `BUNDLES_CACHE_TTL_MINUTES` (sanctioned tier), and again on each ↻. The feed is now read on every active list load, from its cache, so Fanatical's volume is unchanged.
- **Shape**: `GET /api/bundles`, `GET /api/bundles/:id` and `GET /api/game-bundles/:appid` add `pickAndMix: [{ quantity, prices: { EUR: 5.99, … } }]` (minor units converted, quantity-ascending). Every currency is passed through; the frontend picks the region's, else USD (`pickTiers`, `public/bundleRows.ts`), the same fallback as a USD-only ITAD shop.
- **Names**: `GET /api/bundles/:id` (not the list) also adds `pickAndMixNames: { <ITAD gid>: <Fanatical name> }` (`matchPickAndMix`), in order:
  1. by slug, then normalised title;
  2. a title Fanatical extends with a subtitle ("Dead Finger Dice" → "Dead Finger Dice: A Billionaire Killing Game");
  3. a shared base title before " - "/" + "/":" ("Insurmountable - Supporter Bundle" ↔ "Insurmountable + Supporter Pack");
  4. when both lists are the same length and one game and one product are left, they're paired ("The Pixel Pulps Collection" is "Classic Adventure Triple Pack").
  - Steps 2–3 apply only when exactly one unclaimed product fits. Measured on the 11 live bundles: 217 of 217 matched. Anything unmatched shows as "N to pick by hand".
- **Buying the selection** ("Buy N on Fanatical ↗", `public/fanaticalPicks.ts`):
  - **The basket can't be filled from this app**: `POST /api/basket` on fanatical.com is keyed to that site's `anonid` header (from its storage) or login token, so a cross-origin request is blocked and a server-side one fills a basket nobody sees; no deep link pre-selects.
  - **The link** (`fanaticalBuyUrl`): ITAD's link with `scg=<JSON array of names>` added to the Fanatical address inside Awin's `ued`, every other byte unchanged. Awin redirects to `ued` and appends its `utm_*`/`awc` with `&`, so both arrive. A URL cleaner that skips Awin and opens `ued` directly also keeps it (losing the referral). A fragment on the outer link survived Awin but not such a cleaner — hence inside `ued`. Fanatical keeps the unknown parameter through its own page load.
  - **The bookmarklet** (**Add to Fanatical**, `addFanaticalPicks`, self-contained in the `javascript:` URL, nothing loaded from this app) reads `scg` from the query (or a fragment) and clicks each named card's own **Add** button (`article.PickAndMixCard`, matched on its `img[alt]`; `button.select-btn` gains `btn-selected` once in the basket), so Fanatical's own client sends the request with its own attribution.
    - It waits for each add to show. A game already in the basket can render unselected while the basket loads, so a click removes it; it clicks again.
    - A **SOLD OUT** card keeps a working-looking Add button that adds nothing; the bookmarklet reports it instead of clicking (the feed carries no stock, so the app can't say so in advance).
    - It runs only because Fanatical sends no Content-Security-Policy. Verified live through ITAD's Awin link (10 adds 500 ms apart all held). Depends on that markup: a redesign breaks it until updated.
- **Frontend**: [game-table.md](game-table.md#each-list-kind-in-practice) — tier chips, the per-game Tier Price, the selection's cost (`cheapestPicks`).
- **Pricing rule** (confirmed by the maintainer): any number of games can be picked, each at the per-game rate of the largest tier reached — 6 games at "5 for €5.99" cost 6 × €5.99 / 5. `cheapestPicks` also considers rounding up to a larger tier when its price is lower.
- **Assumptions** (unconfirmed against Fanatical's checkout): below the smallest tier, that tier's price is the minimum; the total is rounded to the cent, not each game's price.

## Xbox PC Game Pass — catalog feed

`GET /api/game-pass?country=` (`lib/gamepass.js`): the Steam games in PC Game Pass, plus the ones not on Steam by name.

1. **Catalog**: `GET https://catalog.gamepass.com/sigls/v2?id=fdd9e2a7-0fee-49f6-ad69-4354098401ff&language=en-us&market=<country>` — the "All PC Games" collection xbox.com's PC Game Pass page lists. Undocumented, key-less: untrusted tier. The first entry describes the collection; the rest are `{ id }`, Microsoft Store product ids.
   - **Varies by market** (checked 2026-10-26: US 516 ids; FR identical; DE and BR 2 fewer; JP 24 fewer and 4 of its own), so it follows the app's region and is cached per market (`gamepass:pc:<country>`).
   - An empty or unparseable catalog is an upstream error, never cached as an empty Game Pass.
2. **Product ids → ITAD gids**: `POST /lookup/id/shop/{shopId}/v1`, the Microsoft Store shop looked up by title (`getShopId('Microsoft Store')`, `lookupShopGids`). The reply also keys ids lowercased (seen live), so they're matched case-insensitively. Several product ids (editions) map to one gid: each game counts once. Cached with the catalog.
3. **Gids → Steam appids**: `resolveSteamAppIds`, as for [bundles](#resolving-bundle-games-to-steam). Checked 2026-10-26 on US: 516 ids → 511 gids → 467 on Steam (482 appids: a Steam package expands to its games), 47 ids not on Steam.
4. **Names of the games not on Steam** (no gid, or a gid with no Steam listing): `GET https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=<ids>&market=<country>&languages=en-us&fieldsTemplate=browse` — Microsoft's product catalog, undocumented, key-less: untrusted tier. 100 ids per call; `browse` is the smallest template carrying `ProductTitle` (~13 KB per product). Cached per product (`msstore-title:`); a product a successful reply leaves out is cached as untitled on the miss TTL; a failure logs `[gamepass]`, degrades to the bare id and isn't cached.

- **Volume**: one catalog call and one ITAD lookup per market per `BUNDLES_CACHE_TTL_MINUTES`, plus titles for newly seen non-Steam products (1 call on a cold US cache).
- **Failure**: a gid whose Steam lookup errored is counted in `failed` (uncached, retried next time), not reported as not on Steam.
