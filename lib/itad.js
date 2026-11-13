'use strict';

// IsThereAnyDeal API — bundle listings, resolving a bundle's games to Steam appids (and back,
// for the Library Explorer's Wishlist price columns), and pricing.
// Sanctioned tier in docs/dev/integrations.md's trust tiers: a free, key-gated API with
// published (if sparse) OpenAPI docs at https://docs.isthereanydeal.com/. Requires ITAD_API_KEY
// (see default.env) — unlike STEAM_API_KEY this is optional; every function here is only ever
// called once server.js has confirmed the key is set (see isItadConfigured there), so no
// explicit check is duplicated in this file.

const { createCachedFetch, getCached, partitionCached, setCache } = require('./cache');
const { MISS_CACHE_TTL_MS } = require('./config');
const { createDedup } = require('./dedup');
const { createTrackedFetch } = require('./metrics');
// A deliberate, narrow exception to this file otherwise only ever talking to ITAD: expanding a
// Steam "sub"/"bundle" identifier ITAD's own shop lookup can return is inherently Steam's own
// data, not ITAD's — see resolveSteamAppIds below and lib/steam.js's resolveSteamPackageAppids/
// resolveSteamBundleAppids.
const { resolveSteamPackageAppids, resolveSteamBundleAppids } = require('./steam');
const { upstreamError, createSemaphore, mapChunks } = require('./upstream');

const ITAD_KEY = process.env.ITAD_API_KEY;
const withDedup = createDedup('itad');
const cachedFetch = createCachedFetch(withDedup);
const itadFetch = createTrackedFetch('itad');

// Ids per request: documented for /games/prices/v3 (the `gids-200` body in ITAD's OpenAPI docs),
// assumed for the lookup endpoints, whose docs list no cap.
const BATCH_MAX = 200;

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

// POSTs `body` as JSON to an ITAD endpoint; the parsed reply, which `isShape` must accept. `what` names it in errors.
async function itadPost(label, path, query, body, what, isShape) {
  const qs = new URLSearchParams({ key: ITAD_KEY, ...query });
  const res = await itadFetch(label, `https://api.isthereanydeal.com${path}?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw upstreamError(`ITAD ${what} error ${res.status}`);
  const reply = await res.json();
  if (!isShape(reply)) throw upstreamError(`Unexpected ITAD ${what} reply`);
  return reply;
}

// ITAD's numeric id for a shop (Steam, Microsoft Store) — resolved by title from GET
// /service/shops/v1 (a near-static list) rather than hardcoded, since nothing in the published
// docs pins these values and shop ids are assigned by ITAD itself. Cached
// indefinitely-in-practice under the `itad-shop:` prefix (ITAD_ID_CACHE_TTL_MINUTES in
// default.env).
async function getShopId(title) {
  return cachedFetch(`itad-shop:${title.toLowerCase()}`, {}, async () => {
    const res = await itadFetch('getShopId', `https://api.isthereanydeal.com/service/shops/v1?key=${ITAD_KEY}`);
    if (!res.ok) throw upstreamError(`ITAD shops error ${res.status}`);
    const shops = await res.json();
    const shop = Array.isArray(shops) ? shops.find((s) => s.title === title) : null;
    if (!shop) throw upstreamError(`ITAD shops response has no "${title}" entry`);
    return { value: shop.id };
  });
}

const getSteamShopId = () => getShopId('Steam');

// GET /bundles/v1 — current bundles, one page at a time. Params match the upstream API
// directly (see https://docs.isthereanydeal.com/); `sort` is passed through verbatim rather
// than validated against an enum, same trust-the-upstream-value approach as everywhere else
// this app forwards a "same as the website" sort string. The docs describe `sort` as exactly
// that ("same as on website") with no enum listed, but ITAD does validate it server-side and
// 400s ("Invalid 'sort' value") on anything it doesn't recognize — confirmed live against every
// key isthereanydeal.com/bundles/ itself offers: `-publish`/`publish`, `-expiry`/`expiry`,
// `-update`/`update`, and `-games`/`games` (bundle size — *not* `count`, despite `categories`/
// `tags`/etc.'s own `defaultValueSort: { by: 'count', ... }` in public/bundles.js using that
// name for an unrelated concept). There is no discount/cut-based sort for bundles at all — the
// website's own sort dropdown doesn't offer one either, since a bundle has per-tier prices, not
// a single discount value — `sort=-cut`/`sort=cut` (a value that *does* work on ITAD's deals-
// oriented endpoints) reliably 400s here.
// `mature=true` is sent unconditionally — it's ITAD's *include* switch, not an "only mature"
// filter, and this app never wants to hide a bundle from the person browsing. It isn't a
// parameter: it used to default to `false` with no caller anywhere ever overriding it (the route
// didn't even accept one), which read like a deliberate content policy but was just an unexercised
// default. It cost real bundles — measured live, `false` returned 33 of 35 active bundles, hiding
// a current Humble "Narrative Masterpieces Bundle" (Immortality, Eliza, Sunless Skies, The Pale
// Beyond…) not one of whose games carries ITAD's own per-game `mature` flag. There's no age gate
// anywhere in this app and mature games get no special treatment in any other list, so a
// bundle-level flag that coarse has nothing to gate here. `mature` is gone from the cache key
// along with the parameter; entries written under the old six-segment key are simply never read
// again and age out on their own via the existing TTL (they can't collide with the new shape
// either — the segment that moved into `mature`'s old position is always numeric).
// Types the fields readers use (CLAUDE.md: shape before caching). A mistyped optional one is
// replaced, not the bundle dropped: every walk reads a short page as the last one.
const isString = (v) => typeof v === 'string';
const hasIdAndTitle = (b) => isObject(b) && Number.isInteger(b.id) && isString(b.title);
function repairBundle(bundle) {
  const repaired = new Set();
  const ok = (valid, field) => valid || !repaired.add(field);
  const b = { ...bundle };
  if (!ok(b.expiry === undefined || b.expiry === null || isString(b.expiry), 'expiry')) b.expiry = null;
  if (b.page !== undefined && !ok(isObject(b.page), 'page')) delete b.page;
  if (b.page && !ok(b.page.name === undefined || isString(b.page.name), 'page.name'))
    b.page = { ...b.page, name: undefined };
  if (b.counts !== undefined && !ok(isObject(b.counts), 'counts')) delete b.counts;
  if (b.counts && !ok(b.counts.games === undefined || Number.isInteger(b.counts.games), 'counts.games')) {
    b.counts = { ...b.counts, games: undefined };
  }
  if (b.tiers !== undefined) {
    const tiers = ok(Array.isArray(b.tiers), 'tiers') ? b.tiers : [];
    b.tiers = tiers
      .filter((tier) => ok(isObject(tier), 'tiers[]'))
      .map((tier) => ({
        ...tier,
        games: (ok(Array.isArray(tier.games), 'tiers[].games') ? tier.games : [])
          .filter((game) => ok(isObject(game), 'tiers[].games[]'))
          .map((game) => {
            if (game.assets !== undefined && !ok(isObject(game.assets), 'assets'))
              return { ...game, assets: undefined };
            if (
              game.assets &&
              !ok(game.assets.banner600 === undefined || isString(game.assets.banner600), 'assets.banner600')
            ) {
              return { ...game, assets: { ...game.assets, banner600: undefined } };
            }
            return game;
          }),
      }));
  }
  if (repaired.size) console.warn(`[itad] bundle ${b.id}: replaced mistyped ${[...repaired].join(', ')}`);
  return b;
}

// The cache key for one page of the bundle list. Exported because server.js needs the same key
// twice over — once for bundlesListLimit's "a cache hit costs no upstream call" skip, once for
// the route's own `fetchedAt` — and a hand-copy of it there had already been one edit away from
// silently diverging from this function's own.
function bundlesCacheKey({ country, offset, limit, sort, expired }) {
  return `itad-bundles:${country}:${sort}:${expired}:${offset}:${limit}`;
}

async function getBundles({ country, offset, limit, sort, expired, force = false }) {
  return cachedFetch(bundlesCacheKey({ country, offset, limit, sort, expired }), { force }, async () => {
    const qs = new URLSearchParams({
      key: ITAD_KEY,
      country,
      offset: String(offset),
      limit: String(limit),
      sort,
      mature: 'true',
      expired: String(expired),
    });
    const res = await itadFetch('getBundles', `https://api.isthereanydeal.com/bundles/v1?${qs}`);
    if (!res.ok) throw upstreamError(`ITAD bundles error ${res.status}`);
    const bundles = await res.json();
    if (!Array.isArray(bundles)) throw upstreamError('Unexpected ITAD bundles reply');
    // No id or title is a changed API, not one odd bundle: fail the page.
    const broken = bundles.findIndex((bundle) => !hasIdAndTitle(bundle));
    if (broken !== -1) {
      console.warn(`[itad] /bundles/v1 entry ${broken} has no integer id or string title`);
      throw upstreamError('Unexpected ITAD bundles reply');
    }
    return { value: bundles.map(repairBundle) };
  });
}

// There is no single-bundle-fetch endpoint in ITAD's API — "viewing one bundle" (?bundle=<id>
// deep links, public/bundles.js) means paging through GET /bundles/v1 until the id turns up.
// Since getBundles now always includes mature-flagged bundles (see its own comment), so does this
// search — a deep link to one resolves instead of 404ing. It previously inherited that function's
// `mature = false` default, defended on the grounds that this app's own UI could never have
// linked to a bundle its own list was hiding; true, but circular, and it still broke a link
// pasted from ITAD itself or saved before the flag was set.
const BUNDLE_SEARCH_PAGE_SIZE = 50; // ITAD's own max per page (see getBundles' `limit`)
const BUNDLE_SEARCH_MAX_PAGES = 6; // per expired-state — 300 bundles deep is far beyond what the browse UI itself pages through
async function findBundleById(id, { country = 'US' } = {}) {
  // Through getBundles' per-page cache: a page already searched costs no extra upstream call.
  return searchBundlePages(id, country, getBundles);
}

// Walks the list pages a deep link searches; `loadPage` returns undefined for a page it skips (not cached).
async function searchBundlePages(id, country, loadPage) {
  // Active bundles first (the common case — most deep links are shared/reopened while still
  // live), only falling back to the expired list if not found there.
  for (const expired of [false, true]) {
    for (let page = 0; page < BUNDLE_SEARCH_MAX_PAGES; page++) {
      const offset = page * BUNDLE_SEARCH_PAGE_SIZE;
      const params = { country, offset, limit: BUNDLE_SEARCH_PAGE_SIZE, sort: '-publish', expired };
      const bundles = await loadPage(params);
      if (!Array.isArray(bundles)) continue;
      const found = bundles.find((b) => b.id === id);
      // `cacheKey` is the page this bundle came off, so the caller can date it (getCachedAt):
      // a deep-linked bundle is otherwise the one screen in the app that can't say how old the
      // tiers and end date it is showing are.
      if (found) return { bundle: found, cacheKey: bundlesCacheKey(params) };
      if (bundles.length < BUNDLE_SEARCH_PAGE_SIZE) break; // reached the end of this expired-state's list
    }
  }
  return null;
}

// A link preview's lookup: cache only (no upstream request), in any of `countries`, since the
// preview's request carries no region; not recorded, as it isn't a cache-tier read.
async function findCachedBundle(id, countries) {
  for (const country of countries) {
    const found = await searchBundlePages(id, country, (params) =>
      getCached(bundlesCacheKey(params), { record: false }),
    );
    if (found) return found.bundle;
  }
  return undefined;
}

// Last-resort fallback: GET /games/info/v2's own `appid` field, for a gid that had a "sub"/
// "bundle" shop entry (see resolveSteamAppIds below) whose real Steam expansion still came up
// empty — either resolveSteamPackageAppids/resolveSteamBundleAppids themselves failed
// (transient upstream error, Steam's own circuit breaker open), or Steam's own contents lookup
// genuinely has nothing (observed live: a delisted sub). Deliberately not tried for a gid the
// shop lookup returned *no* entry for at all — every case seen live where info/v2 actually
// carried an `appid` also had a sub/bundle entry; a gid with no shop entry whatsoever is
// something ITAD itself doesn't think is on Steam (an ebook, soundtrack, itch-only key, etc.),
// and this endpoint has no batch form, so trying it there would just be one wasted request per
// non-Steam bundle extra. Best-effort: a failure (timeout, budget exhaustion, a non-404 error)
// returns undefined, leaving the gid unresolved but uncached, rather than aborting the batch;
// null is a confirmed miss.
// One call per gid with no batch form: capped so a batch of them (every sub/bundle gid of a
// bundle while Steam's store breaker is open) doesn't hit ITAD all at once.
const infoLimit = createSemaphore(3, 0, 'itad-info', { group: 'itad', maxQueue: Infinity });
async function lookupAppidFromInfo(gid) {
  try {
    const res = await infoLimit(() =>
      itadFetch(
        'lookupAppidFromInfo',
        `https://api.isthereanydeal.com/games/info/v2?key=${ITAD_KEY}&id=${encodeURIComponent(gid)}`,
        { expected: [404] }, // no such game
      ),
    );
    if (res.status === 404) return null;
    if (!res.ok) return undefined;
    const info = await res.json();
    return typeof info?.appid === 'number' ? info.appid : null;
  } catch {
    return undefined;
  }
}

// Expands a "sub/<id>" or "bundle/<id>" shop entry (see resolveSteamAppIds below) to the real
// Steam appid(s) it contains, via lib/steam.js's resolveSteamPackageAppids/
// resolveSteamBundleAppids. A single appid comes back as a plain number (the common case for a
// "sub" — usually just one title with no app/ page of its own); more than one comes back as an
// array, for the rarer genuine multi-item case (a Steam "bundle" spanning a base game plus its
// DLC, sold as one SKU — confirmed live on Steam bundle 4995, EVERSPACE - Ultimate Edition).
// Falls back to lookupAppidFromInfo above when the Steam-side expansion itself comes up empty.
// Best-effort throughout: any failure just leaves the gid to that fallback (or unresolved)
// rather than aborting the batch. undefined when it errored rather than confirmed a miss (null).
async function expandSteamShopId(gid, shopId) {
  const subMatch = /^sub\/(\d+)$/.exec(shopId);
  const bundleMatch = !subMatch && /^bundle\/(\d+)$/.exec(shopId);
  let steamFailed = false;
  try {
    const appids = subMatch
      ? await resolveSteamPackageAppids(subMatch[1])
      : bundleMatch
        ? await resolveSteamBundleAppids(bundleMatch[1])
        : null;
    if (appids && appids.length > 0) return appids.length === 1 ? appids[0] : appids;
  } catch {
    steamFailed = true; // fall through to the games/info/v2 fallback below
  }
  const appid = await lookupAppidFromInfo(gid);
  // info/v2 lacks an appid Steam's own lookup would have found: not a confirmed miss.
  return appid === null && steamFailed ? undefined : appid;
}

const steamAppIdCacheKey = (gid) => `itad-appid:${gid}`;
// Resolves a batch of ITAD game ids (uuids, off a bundle's tiers[].games[].id) to their Steam
// appid(s), via POST /lookup/shop/{shopId}/id/v1 — the reverse direction of resolveItadIds'
// POST /lookup/id/shop/{shopId}/v1. Each gid resolves to a plain number (the overwhelmingly common case), an
// array of numbers (a "sub"/"bundle" entry that expanded to more than one Steam app — see
// expandSteamShopId above), or null (no Steam listing for this game, or ITAD has no mapping for
// it yet); a gid whose expansion errored is left out. Each gid is cached individually (`steamAppIdCacheKey`) so a game seen in one bundle is
// never re-resolved for another; `null` (a confirmed miss) is cached too, on the miss TTL.
async function resolveSteamAppIds(gids) {
  const { hits: result, uncached } = partitionCached(gids, steamAppIdCacheKey);
  if (uncached.length === 0) return result;

  const shopId = await getSteamShopId();
  // Per chunk, so a failed one keeps those that succeeded.
  await mapChunks(uncached, BATCH_MAX, (chunk) => resolveSteamAppIdChunk(chunk, shopId, result));
  return result;
}

// One chunk of resolveSteamAppIds: looks it up, expands, caches and sets each gid's result in `result`.
async function resolveSteamAppIdChunk(chunk, shopId, result) {
  // Deduped per exact chunk (sorted, joined) — good enough here since resolveSteamAppIds is
  // only ever called once per opened bundle with that bundle's own full uncached gid set,
  // unlike e.g. getPlayerSummaries which needs true per-id dedup across overlapping batches.
  const dedupKey = `itad-resolve:${[...chunk].sort().join(',')}`;
  // Path is /lookup/shop/{shopId}/id/v1 (ITAD's own `/lookup/{lookup-what}/{by-what}/`
  // convention), not the more RPC-sounding /lookup/{shopId}/gid/v1 the shape of the sibling
  // endpoints briefly suggested — confirmed against the live API, not just the docs.
  // { gid: ["app/<id>" | "sub/<id>", ...] | null }
  const resolved = await withDedup(dedupKey, () =>
    itadPost('resolveSteamAppIds', `/lookup/shop/${shopId}/id/v1`, {}, chunk, 'shopid lookup', isObject),
  );

  const appidByGid = new Map();
  const expandGids = []; // gid -> the specific "sub/<id>"/"bundle/<id>" entry to expand
  for (const gid of chunk) {
    const shopIds = resolved[gid];
    // Steam ids come back namespaced as "app/<id>" (a store page), "sub/<id>" (a package/
    // license), or "bundle/<id>" (an official Steam bundle) — only "app/" maps directly to
    // something GET /api/game-details/:appid can look up; the other two need expanding via
    // expandSteamShopId below. Order isn't guaranteed to put "app/" first, so find it
    // explicitly rather than assuming index 0.
    let appid = null;
    let otherShopId = null;
    if (Array.isArray(shopIds)) {
      for (const id of shopIds) {
        const m = /^app\/(\d+)$/.exec(id);
        if (m) {
          appid = Number(m[1]);
          break;
        }
        if (!otherShopId && /^(sub|bundle)\/\d+$/.test(id)) otherShopId = id;
      }
    }
    appidByGid.set(gid, appid);
    // A gid with no shop entry at all (shopIds is null/absent, not just missing "app/") is
    // something ITAD itself has no Steam mapping for — not attempted below; see
    // expandSteamShopId's own comment for why that's deliberately not the same as a "sub"/
    // "bundle" entry that just isn't "app".
    if (appid === null && otherShopId) expandGids.push([gid, otherShopId]);
  }

  const errored = new Set();
  if (expandGids.length > 0) {
    const expanded = await Promise.all(expandGids.map(([gid, shopId]) => expandSteamShopId(gid, shopId)));
    expandGids.forEach(([gid], i) => {
      if (expanded[i] === undefined) errored.add(gid);
      else if (expanded[i] !== null) appidByGid.set(gid, expanded[i]);
    });
  }

  for (const gid of chunk) {
    if (errored.has(gid)) continue; // left out of the result and uncached: retried on the next resolve
    const appid = appidByGid.get(gid);
    result.set(gid, appid);
    // A confirmed "no Steam listing" is cached like a real mapping — it saves the same upstream
    // call — but on the short miss TTL, not this tier's long one: a game with no Steam page today
    // can get one tomorrow (see setCache's `ttlMs` in lib/cache.js).
    setCache(steamAppIdCacheKey(gid), appid, appid === null ? { ttlMs: MISS_CACHE_TTL_MS } : undefined);
  }
}

const itadIdCacheKey = (appid) => `itad-gid:${appid}`;
// Resolves a batch of Steam appids to ITAD's own internal game ids — the reverse direction of
// resolveSteamAppIds above, needed for the Library Explorer's Wishlist price columns (which
// start from Steam appids the wishlist already gives us, not ITAD gids the way a bundle's own
// tiers[].games[].id does), via POST /lookup/id/shop/{shopId}/v1. Each appid is cached
// individually (`itadIdCacheKey`) so a game seen on one wishlist load is never re-resolved on
// the next. `null` (no ITAD listing for this Steam appid, a confirmed miss) is cached too, on the miss TTL.
async function resolveItadIds(appids) {
  const { hits: result, uncached } = partitionCached(appids, itadIdCacheKey);
  if (uncached.length === 0) return result;

  // Per chunk, so a failed one keeps those that succeeded. Steam ids are sent as "app/<appid>", the reply's key.
  await mapChunks(uncached, BATCH_MAX, async (chunk) => {
    const dedupKey = `itad-gidresolve:${[...chunk].sort((a, b) => a - b).join(',')}`;
    const gids = await withDedup(dedupKey, () =>
      lookupShopGids(
        'Steam',
        chunk.map((appid) => `app/${appid}`),
        'resolveItadIds',
      ),
    );
    for (const appid of chunk) {
      const gid = gids.get(`app/${appid}`);
      setCache(itadIdCacheKey(appid), gid, gid === null ? { ttlMs: MISS_CACHE_TTL_MS } : undefined);
      result.set(appid, gid);
    }
  });
  return result;
}

// A shop's own ids (Steam's "app/<appid>", Microsoft Store product ids) to ITAD gids, via
// POST /lookup/id/shop/{shopId}/v1, chunked. Returns Map<id, gid | null> keyed as passed. The
// reply can key an id in another case than sent (Microsoft Store ids also come back lowercased,
// seen live), so ids are matched case-insensitively. Not cached here: callers cache. `label`
// keeps each caller's calls apart in GET /api/metrics.
async function lookupShopGids(shopTitle, ids, label = 'lookupShopGids') {
  const shopId = await getShopId(shopTitle);
  const gidByLower = new Map();
  const replies = await mapChunks(ids, BATCH_MAX, (chunk) =>
    itadPost(label, `/lookup/id/shop/${shopId}/v1`, {}, chunk, 'gid lookup', isObject),
  );
  for (const reply of replies) {
    for (const [id, gid] of Object.entries(reply)) {
      if (typeof gid === 'string') gidByLower.set(id.toLowerCase(), gid);
    }
  }
  return new Map(ids.map((id) => [id, gidByLower.get(id.toLowerCase()) ?? null]));
}

const priceCacheKey = (gid, country) => `itad-price:${country}:${gid}`;
// Steam's own non-discounted regular price plus historical lows (all-time / 1yr / 3mo, across
// every shop ITAD tracks, not just Steam — "have I ever seen this cheaper anywhere" is the more
// useful question than a Steam-only low) for a batch of ITAD game ids, via POST
// /games/prices/v3. Both figures come back in whatever `country`'s currency, same as the
// bundle price itself, so a "bundle price vs. buying outright" comparison is apples-to-apples.
// Each gid is cached whole (raw historyLow + deals, not just the two fields extracted below) —
// same "cache raw, extract at read time" approach as getStoreBrowseItem in lib/steam.js — so a
// future need for another shop's price or the current best deal never needs a new upstream call.
// Cached per (gid, country) — unlike the appid resolution above, a price is meaningfully
// different per region, not just a currency relabeling.
//
// `force: true` (the page-level "↻ Refresh prices" button in bundles.js/library.js, via
// POST /api/prices?refresh=1) treats every gid as a cache miss for this call only — same
// `{ force }` convention as everywhere else in this app (see lib/cache.js) — so it re-fetches
// from ITAD and overwrites the cached entry, rather than needing a separate cache-clearing path.
async function getPrices(gids, { country = 'US', force = false } = {}) {
  const { hits: result, uncached } = partitionCached(gids, (gid) => priceCacheKey(gid, country), { force });
  if (uncached.length === 0) return result;

  // Chunked: resolveSteamAppIds' own MAX_BUNDLE_RESOLVE_GAMES allows up to 500 per bundle.
  await mapChunks(uncached, BATCH_MAX, async (chunk) => {
    const dedupKey = `itad-prices:${country}:${[...chunk].sort().join(',')}`;
    // [{ id, historyLow: {all, y1, m3}, deals: [{ shop: {id, name}, regular, price, ... }] }]
    const entries = await withDedup(dedupKey, () =>
      itadPost('getPrices', '/games/prices/v3', { country }, chunk, 'prices', Array.isArray),
    );
    for (const entry of entries) {
      if (typeof entry?.id !== 'string') continue; // malformed: its gid falls to the absent → null path below
      setCache(priceCacheKey(entry.id, country), entry);
      result.set(entry.id, entry);
    }
    // A gid ITAD has no price data for at all is simply absent from the response (not a null
    // entry) — cache that as null too, so it isn't re-requested on every subsequent bundle.
    for (const gid of chunk) {
      if (!result.has(gid)) {
        setCache(priceCacheKey(gid, country), null);
        result.set(gid, null);
      }
    }
  });
  return result;
}

// Extracts just what the Bundles page's table needs from one getPrices() entry — Steam's own
// regular (non-discounted) price, the three historical lows, and the single cheapest *current*
// deal across every shop `deals[]` lists (Steam included) — every entry is already in whatever
// currency `getPrices`' own `country` was requested in, so they're directly comparable without
// any conversion. `null` fields throughout mean "ITAD has no data for this", not zero.
//
// Deliberately does NOT surface each deal's own `cut` field (that shop's self-reported discount
// off *its own* "regular" price) — an earlier version did, backing the frontend's "Discount"
// column directly from it, but that number means something different per row (whatever that
// particular shop happens to list as its own regular price, which shops set independently and
// isn't always trustworthy/comparable) rather than one consistent reference. The frontend
// instead computes "% cheaper than Steam Full Price" itself from `steamRegular`/`bestDeal.price`
// — both already returned here — so every row's Discount answers the same question against the
// one stable, Valve-set anchor this app already treats as the reference price throughout.
//
// `bestDeal.url` is ITAD's own affiliate/redirect link for that specific deal (present per-deal
// in the raw response, same as `shop`/`price`) — surfaced so the side panel's price card can
// link straight to the shop (public/panel.tsx's price card), passed through unmodified same as
// every other ITAD-sourced link/price in this app (see docs/dev/integrations.md).
function extractPriceInfo(entry, steamShopId) {
  if (!entry) return { steamRegular: null, lowAll: null, lowY1: null, lowM3: null, bestDeal: null };
  const deals = entry.deals || [];
  const steamDeal = deals.find((d) => d.shop?.id === steamShopId);
  const cheapest = deals.reduce((min, d) => (d.price && (!min || d.price.amount < min.price.amount) ? d : min), null);
  return {
    steamRegular: steamDeal?.regular ?? null,
    lowAll: entry.historyLow?.all ?? null,
    lowY1: entry.historyLow?.y1 ?? null,
    lowM3: entry.historyLow?.m3 ?? null,
    bestDeal: cheapest ? { price: cheapest.price, shop: cheapest.shop?.name ?? null, url: cheapest.url ?? null } : null,
  };
}

// GET /games/bundles/v2 — the current bundles one game is in (expired ones excluded by default,
// verified live), as full /bundles/v1-shaped objects. Cached raw per (gid, country), the bundles
// tier, same as getBundles.
function gameBundlesCacheKey(gid, country) {
  return `itad-gamebundles:${country}:${gid}`;
}

async function getGameBundles(gid, { country = 'US', force = false } = {}) {
  return cachedFetch(gameBundlesCacheKey(gid, country), { force }, async () => {
    const qs = new URLSearchParams({ key: ITAD_KEY, id: gid, country });
    const res = await itadFetch('getGameBundles', `https://api.isthereanydeal.com/games/bundles/v2?${qs}`);
    if (!res.ok) throw upstreamError(`ITAD game bundles error ${res.status}`);
    const bundles = await res.json();
    if (!Array.isArray(bundles)) throw upstreamError('Unexpected ITAD game bundles reply');
    return { value: bundles };
  });
}

// What the side panel shows per bundle. `tierPrice` is the cheapest tier holding this game (tiers
// are price-ascending, see flattenBundleGames); null for a pick-and-mix tier, as on the bundle pages.
// `tierPriceMax`: flattenBundleGames' rule for priced tiers ITAD left empty (public/bundleData.ts).
function extractGameBundles(bundles, gid) {
  return (bundles || []).map((b) => {
    const tiers = b.tiers || [];
    const tier = tiers.find((t) => (t.games || []).some((g) => g.id === gid));
    const lastListed = tiers.findLastIndex((t) => !t.addon && (t.games || []).length > 0);
    const emptyAbove = tiers
      .slice(lastListed + 1)
      .flatMap((t) => (!t.addon && t.price && !(t.games || []).length ? [t.price.amount] : []));
    const rangeMax = emptyAbove.length ? Math.max(...emptyAbove) : null;
    const isLast = tier != null && tiers.indexOf(tier) === lastListed;
    return {
      id: b.id,
      title: b.title,
      shop: b.page?.name ?? null,
      url: b.url ?? null,
      expiry: b.expiry ?? null,
      tierPrice: tier?.price?.amount ?? null,
      tierCurrency: tier?.price?.currency ?? null,
      tierPriceMax: isLast && tier.price && rangeMax != null && rangeMax > tier.price.amount ? rangeMax : null,
      ...(b.pickAndMix && { pickAndMix: b.pickAndMix }),
    };
  });
}

module.exports = {
  getSteamShopId,
  getBundles,
  bundlesCacheKey,
  findBundleById,
  findCachedBundle,
  getGameBundles,
  gameBundlesCacheKey,
  extractGameBundles,
  steamAppIdCacheKey,
  resolveSteamAppIds,
  itadIdCacheKey,
  resolveItadIds,
  lookupShopGids,
  priceCacheKey,
  getPrices,
  extractPriceInfo,
};
