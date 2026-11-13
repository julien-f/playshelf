# Bundles and prices

Everything behind `ITAD_API_KEY`: IsThereAnyDeal's bundles and prices, Fanatical's Pick & mix tiers, Humble Choice's end date and the PC Game Pass catalog. Trust tiers and request volume: [integrations.md](integrations.md#trust-tiers); the inbound rate limiters: [architecture.md](architecture.md#api-routes); the price columns and the bundle page: [game-table.md](game-table.md).

## IsThereAnyDeal

Bundle browsing (`/bundles`, `/lists/bundle/:bundleId`) and every price column come from the [IsThereAnyDeal API](https://docs.isthereanydeal.com/) via `lib/itad.js` — free, key-gated, with published (if sparse) OpenAPI docs: sanctioned tier.

- **Optional**: gated on `ITAD_API_KEY`. `isItadConfigured()` (`server.js`) is checked per request; `GET /api/bundles`, `GET /api/bundles/:id`, `POST /api/bundles/resolve`, `POST /api/prices`, `GET /api/game-bundles/:appid` and `GET /api/game-pass` return 503 when unset, and the frontend hides those surfaces (`GET /api/health`'s `itadConfigured`).
- **Batches of 200 ids** (`BATCH_MAX`) for every multi-id call: documented for `/games/prices/v3` (`gids-200`); an assumption for the two `/lookup/` endpoints, whose docs list no cap. A larger set goes out in chunks, 3 at a time (`mapChunks`, `BATCH_CONCURRENCY` in `lib/upstream.js`), each cached as it returns.
- **Bundle shape checked before caching** (`repairBundle`, `lib/itad.js`): a mistyped field readers use is replaced (`null`, `[]` or removed) with an `[itad]` warning naming the bundle and field, the bundle kept: dropping it would shorten the page, which every walk reads as the last one. A bundle without an integer `id` and a string `title` fails its page as an upstream error.
- **Data errors** (a wrong date, price or listing) are corrected by editing the bundle on isthereanydeal.com, with a regular account: [IsThereAnyDeal-Issues](https://github.com/IsThereAnyDeal/IsThereAnyDeal-Issues) closes them with that answer (#3576, #3578), so there's no issue to track.
- **End-date overrides** (Fanatical's `valid_until`, Humble Choice's schedule) are permanent rules, not workarounds: ITAD's dates ran early repeatedly. `overrideExpiry` (`lib/itadDates.js`) tallies, per bundle still on sale, whether ITAD's date already matches to the minute; `GET /api/metrics` raises an `itad-dates` info alert once all do (at least 3 Fanatical bundles, 1 Humble Choice): the override may be removable.
- **Links are passed through unmodified** — ITAD's terms require prices and links as returned. An opened bundle's hero shows "View on IsThereAnyDeal ↗" (`details`) and "Get this bundle ↗" (`url`, the shop/affiliate link with its tracking params). The one addition anywhere is **Buy on Fanatical**'s `scg=…` parameter ([Fanatical](#fanatical--pick--mix-tier-prices)), inside that same link; every tracking parameter is left alone.

### Bundles

- **`GET /bundles/v1`** (`getBundles`, `GET /api/bundles`): current bundles, paginated (`offset`/`limit`, max 50/page), with a `country` param driving currency and (per ITAD, presumably) regional pricing.
- **`mature=true` is always sent**: it's ITAD's _include_ switch, not an "only mature" filter, and the app has no age gate. Defaulting to `false` once hid 33 of 35 active bundles, including ones with no game carrying ITAD's per-game `mature` flag.
- **No single-bundle endpoint upstream**, so `GET /api/bundles/:id` (`findBundleById`) searches: active bundles first (`expired=false`), then expired, up to `BUNDLE_SEARCH_MAX_PAGES` (6) pages of 50 each per state, then 404s. Each page reuses `getBundles`' cache. `fetchBundleById` (`public/bundleData.ts`) always calls this route, never the `/bundles` picker's possibly different list.
- **Tiers**: `tiers[]` are price-ascending, and a game can appear in several (the bundle page keeps its cheapest: [game-table.md](game-table.md#bundle-page)).
  - Confirmed on cached data (38 bundles): each tier lists only the games it adds. Some bundles list every game under the first tier and leave pricier ones empty (e.g. 16599, TrineVerse Triple Co-op Pack: €10.55 / €14.77 / €18.99, all 5 games in the first); the last tier with games then shows a range up to the priciest empty tier (`tierPriceMax`, also from `extractGameBundles`), since which tier holds which game is unknown. An empty unpriced trailing tier is ignored.
- **Add-on tiers** (`addon: true`) are bought apart from the base tiers: not cumulative, not in price order, never part of a base tier's range (e.g. 16689: $4 / $6 / $9 / $13 / $16 base, $2 and $4 add-ons). An empty unpriced add-on (e.g. 14804) prices nothing and is dropped.
- **A `null` tier price is not free.** In practice it's Fanatical's "Build Your Own ⟨N⟩ Bundle": one tier, a pool of 15–30 games, priced by quantity. A free or pay-what-you-want tier would carry `{amount: 0, …}` (never observed yet).
  - When Fanatical's feed has the bundle, its quantity tiers stand in ([Fanatical](#fanatical--pick--mix-tier-prices)); otherwise `/bundles` renders `cheapestTierPrice`'s (`bundleRows.ts`) null and `renderTierPrice` (`ListRoute.tsx`) a null tier as "Varies"/"Price varies", keeping "Free" for `amount === 0`.
  - The `tierPrice` column uses `compareNumMissingLast`, or `null` would sort as 0 — every Build Your Own game first under the default ascending sort.
- **`GET /games/bundles/v2`** (`getGameBundles`/`extractGameBundles`, `GET /api/game-bundles/:appid`): the bundles one game is in, for the panel's Price card.
  - Verified live: full `/bundles/v1`-shaped objects, current only unless `expired=true` (one game: 1 by default, 8 with it).
  - appid → gid reuses `resolveItadIds`; cached raw per (gid, country) as `itad-gamebundles:`.
  - Each line shows the cheapest tier holding the game; a pick-and-mix tier shows its best quantity rate ("from €1.17/game", `withPickAndMix`), "Varies" when Fanatical's feed lacks it.
  - Assumption: a game ITAD maps only via a Steam sub counts as in the bundle — ITAD matches by gid, passed through.

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
- **Chunks**: the server caps a call at `MAX_PRICE_LOOKUP_GAMES` (500); the client chunks to match ([game-table.md](game-table.md#prices)).

### Currency is passed through, not converted

- A tier or game price is in whatever currency ITAD's upstream shop charges; most shops (Humble, GreenManGaming, most Fanatical bundles) switch per region, but some only ever price in USD (verified live: a shop ITAD lists as "Digiphile", and at least one Fanatical bundle). That's upstream behavior, noted beside the region picker, not something to convert away.
- So a row keeps two currency fields ([game-table.md](game-table.md#prices)).

## Humble Choice — end date

`lib/humbleChoice.js`: a Choice bundle (`page.name` `Humble Bundle`, `url` wrapping `humblebundle.com/membership/<month>-<year>`) gets Humble's schedule as `expiry` — the first Tuesday of the next month, 10:00 `America/Los_Angeles` — on every route and the link preview, with no upstream call.

- Why: ITAD's ran early. October 2026's ended at `2026-11-03T17:00:00+01:00` (16:00Z) on ITAD, which then moved it to `expired=true`; humblebundle.com sold it until 18:00Z (its countdown and the end date in its /membership page's data). Regular Humble bundles' ITAD dates matched Humble's pages.
- Schedule source: Humble's monthly reveal, first Tuesday 10 AM PT (press coverage, e.g. Gamewatcher's monthly lists). Seen on one month only; a PDT month is unconfirmed.
- The Choice on sale now is pulled back from ITAD's expired pages like a Fanatical bundle ([Bundles ITAD expired early](#fanatical--pick--mix-tier-prices)), the walk reaching back to its month's start minus 7 days.

## Fanatical — Pick & mix tier prices

- **Why**: ITAD lists a Fanatical "Build your own" bundle as one tier with `price: null`; the real pricing is by quantity ("pick 5 for €5.99, 10 for €9.99…").
- **Source**: `GET https://www.fanatical.com/api/all/en` (`lib/fanatical.js`) — the storefront's own undocumented, key-less feed: untrusted tier. Fanatical has no public API; its sanctioned product data is the CJ affiliate feed, which needs an affiliate account. The per-bundle `/api/pick-and-mix/<slug>/en` answers a scripted request with `403 Request blocked`, so it isn't used.
- **Volume**: one call serves every bundle, whichever route asks (`/api/game-bundles` included). Only the `pickandmix[]` slug → `{tiers, products, type, validFrom, validUntil}` map is kept (`products`: each pick's `name` and `slug`; `type` is `bundle` for games, else books/e-learning/software, which ITAD doesn't list; the feed is ~800 KB), cached as `fanatical-pnm:v3`. A slug missing from a map over an hour old triggers one re-fetch (a bundle that went live since). A failure serves the last map read (or an empty one) and holds off the feed for an hour (`failureHoldOff`), logged once per attempt — never an error to the client.
- **Matching**: exact, by slug. ITAD's purchase `url` for these bundles is an affiliate redirect wrapping `fanatical.com/<lang>/pick-and-mix/<slug>` (`pickAndMixSlug`). Only bundles whose `page.name` is `Fanatical` and that have a null-price tier are enriched; a bundle Fanatical has stopped selling drops out of the feed and stays "Varies".
- **End date**: an enriched bundle's `expiry` becomes the feed's `valid_until` when it has one (20 of 32 on 2026-11-01), the link preview included (`withCachedPickAndMix`, cached feed only).
  - Why: ITAD's runs early — ~16 h on 11 of 12 bundles, and Build Your Own Killer Bundle (Fall 2026) ended 2026-11-01T00:58 on ITAD while fanatical.com sold it until 2026-11-13T23:59Z (its page's countdown matched `valid_until`). The previous Killer edition also ended at `…T00:58`, maybe ITAD's placeholder when it has no date.
- **Bundles ITAD expired early** (`findEarlyExpired`, `lib/earlyExpired.js`): a games pick-and-mix (`type: 'bundle'`) live by the feed's dates, or the [Humble Choice](#humble-choice--end-date) on sale now, missing from ITAD's active list is looked up on ITAD's `expired=true` pages and listed with the real end date.
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
- **Frontend**: [game-table.md](game-table.md#bundle-page) — tier chips, the per-game Tier Price, the selection's cost (`cheapestPicks`).
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
