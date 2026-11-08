'use strict';

const {
  capExpiry,
  createCachedFetch,
  getCached,
  getCachedAt,
  isCached,
  partitionCached,
  setCache,
} = require('./cache');
const { createCircuitBreaker } = require('./circuitBreaker');
const {
  MISS_CACHE_TTL_MS,
  RESOLVE_MISS_CACHE_TTL_MS,
  STORE_MIN_INTERVAL_MS,
  STORE_DETAILS_MAX_PER_5_MIN,
  UPSTREAM_MIN_INTERVAL_MS,
} = require('./config');
const { createDedup } = require('./dedup');
const { createTrackedFetch, recordWindowWait } = require('./metrics');
const {
  upstreamError,
  createSemaphore,
  createWindow,
  createRetryingFetch,
  createHoldOff,
  mapChunks,
} = require('./upstream');

const STEAM_KEY = process.env.STEAM_API_KEY;
const withDedup = createDedup('steam');
const cachedFetch = createCachedFetch(withDedup);
const storeFetch = createTrackedFetch('steam-store');
const browseFetch = createTrackedFetch('steam-browse');
const reviewsFetch = createTrackedFetch('steam-reviews');
const apiFetch = createTrackedFetch('steam-api');
const protonFetch = createTrackedFetch('protondb');

// Marks an error as an expected, user-facing outcome (bad Steam id, private profile) rather
// than a genuine bug — server.js's route handlers use this to skip logging it as a server-side
// error (it's normal and frequent, not worth a log line) while still logging anything else
// that reaches the same catch block, since an unmarked plain Error is indistinguishable from
// an actual bug otherwise.
function clientError(msg) {
  return Object.assign(new Error(msg), { isClientError: true });
}

// 2 in-flight, 500 ms cooldown per slot (STORE_MIN_INTERVAL_MS) → ≈ 4 req/s sustained to Steam's unauthenticated store.
const storeLimit = createSemaphore(2, STORE_MIN_INTERVAL_MS, 'store', { group: 'steam-store' });
// Per-game tag lookup (IStoreBrowseService/GetItems) — different host from storeLimit's
// store.steampowered.com, so kept on its own semaphore rather than sharing that one's
// circuit breaker/cooldown, which exists specifically for store.steampowered.com's bot
// detection. Same conservative shape SteamSpy's limiter used to have.
const tagLimit = createSemaphore(3, UPSTREAM_MIN_INTERVAL_MS, 'tag', { group: 'steam-browse' });
// ProtonDB had no limiter at all, unlike the two above — a library/comparison load fetching
// details for dozens of games at once fired that many concurrent unthrottled connections at
// protondb.com, which started surfacing as network-level "fetch failed" errors (connection
// resets/DNS contention) rather than HTTP-level 403s. Same conservative cap as tagLimit.
const protonLimit = createSemaphore(3, UPSTREAM_MIN_INTERVAL_MS, 'proton', { group: 'protondb' });
// GetAppReviews (api.steampowered.com, key-less): Steam's documented review summary, under a
// rate limit shared by every key-less caller, so it gets its own slots and 429 pause.
const reviewsLimit = createSemaphore(3, UPSTREAM_MIN_INTERVAL_MS, 'reviews', { group: 'steam-reviews' });

const storeBreaker = createCircuitBreaker('steam-store', 'Steam store');
const protonBreaker = createCircuitBreaker('protondb', 'ProtonDB');

const storeFetchOptions = {
  limit: storeLimit,
  // Not following redirects: a retired store endpoint redirects to the home page, which would
  // otherwise count as a 200 and fail later as a JSON parse error.
  trackedFetch: (label, url, init) => storeFetch(label, url, { redirect: 'manual', ...init }),
  name: 'Steam store',
  breaker: storeBreaker,
  retries: 2,
};
const storeRetryingFetch = createRetryingFetch(storeFetchOptions);
// Its own window and 429 pause: a large cold load's backlog mustn't stall a typed search or a bundle lookup.
const appDetailsRetryingFetch = createRetryingFetch({
  ...storeFetchOptions,
  window:
    STORE_DETAILS_MAX_PER_5_MIN > 0
      ? createWindow(STORE_DETAILS_MAX_PER_5_MIN, 5 * 60 * 1000, {
          name: 'store-details',
          group: 'steam-store',
          onWait: (ms) => recordWindowWait('store-details', ms),
        })
      : undefined,
});

// `label` is the calling function's name, so metrics can tell e.g. getAppDetails apart from searchStoreGames.
async function fetchStoreApi(url, label, retryingFetch = storeRetryingFetch) {
  const res = await retryingFetch(label, url);
  if (res.status === 403) throw upstreamError('Steam store: rate limited (403)');
  if (res.status >= 300 && res.status < 400)
    throw upstreamError(`Steam store: ${res.status} redirect to ${res.headers.get('location')}`);
  return res;
}

const reviewsRetryingFetch = createRetryingFetch({
  limit: reviewsLimit,
  trackedFetch: reviewsFetch,
  name: 'Steam reviews',
  retries: 2,
});
// The groups below aren't retried on 429: a refused call fails, later ones wait out the group's pause.
// Each group pauses alone: a quota shared between them, or with reviews, is unconfirmed (integrations.md).
const browseRetryingFetch = createRetryingFetch({
  limit: tagLimit,
  trackedFetch: browseFetch,
  name: 'Steam store browse',
  retries: 0,
});
// GetWishlist, GetNewsForApp and GetGlobalAchievementPercentagesForApp, unthrottled otherwise.
const keylessRetryingFetch = createRetryingFetch({ trackedFetch: apiFetch, name: 'Steam API', retries: 0 });
const protonRetryingFetch = createRetryingFetch({
  limit: protonLimit,
  trackedFetch: protonFetch,
  name: 'ProtonDB',
  breaker: protonBreaker,
  retries: 0,
});

const STEAM64_RE = /^7656119\d{10}$/;

const resolveCacheKey = (id) => `resolve:${id}`;

// The name in a steamcommunity.com /id/<name> URL or the id in a /profiles/<id> one, else `raw` trimmed.
function steamIdentifier(raw) {
  const id = raw.trim();
  const m = /steamcommunity\.com\/(?:id\/([^/?\s]+)|profiles\/(\d+))/i.exec(id);
  return m ? (m[1] ?? m[2]) : id;
}

// resolveSteamId's answer from cache alone: the Steam64 id, null for a cached miss, undefined if only Steam knows.
function peekSteamId(raw) {
  const id = steamIdentifier(raw);
  return STEAM64_RE.test(id) ? id : getCached(resolveCacheKey(id), { record: false });
}

async function resolveSteamId(raw) {
  const id = steamIdentifier(raw);
  if (STEAM64_RE.test(id)) return id;
  const steamId = await cachedFetch(resolveCacheKey(id), {}, async () => {
    const res = await apiFetch(
      'resolveSteamId',
      `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${STEAM_KEY}&vanityurl=${encodeURIComponent(id)}`,
    );
    if (!res.ok) throw upstreamError(`Steam API error ${res.status}`);
    const response = (await res.json())?.response;
    // Valve documents `success` 1 (found) and 42 (no match); anything else is a failure, not a miss.
    const found = response?.success === 1 && STEAM64_RE.test(response.steamid);
    if (!found && response?.success !== 42) throw upstreamError('Unexpected ResolveVanityURL reply');
    // Cache the failure too, briefly — an unresolvable identifier is otherwise an upstream call
    // every single time it's submitted, and it's exactly the kind of thing that gets retried
    // (a typo, a bad link someone keeps clicking). Short TTL because it's also the kind of
    // thing that stops being true: people do register the custom URL they were about to.
    if (!found) return { value: null, ttlMs: RESOLVE_MISS_CACHE_TTL_MS };
    return { value: response.steamid };
  });
  // `null` is a cached miss, fresh or not, never handed back as an id.
  if (steamId === null) throw clientError(`Cannot find Steam account: "${id}"`);
  return steamId;
}

const ownedGamesCacheKey = (steamId) => `games:${steamId}`;
async function getOwnedGames(steamId, { force = false } = {}) {
  return cachedFetch(ownedGamesCacheKey(steamId), { force }, async () => {
    const res = await apiFetch(
      'getOwnedGames',
      `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_KEY}&steamid=${steamId}&include_appinfo=1&include_played_free_games=1`,
    );
    if (!res.ok) throw upstreamError(`Steam API error ${res.status}`);
    const response = (await res.json())?.response;
    if (typeof response !== 'object' || response === null) throw upstreamError('Unexpected GetOwnedGames reply');
    if (!response.games) {
      throw clientError(`Cannot access library for ${steamId} — profile may be set to private`);
    }
    if (!Array.isArray(response.games)) throw upstreamError('Unexpected GetOwnedGames reply');
    return { value: response.games };
  });
}

const wishlistCacheKey = (steamId) => `wishlist:${steamId}`;
async function getWishlist(steamId, { force = false } = {}) {
  return cachedFetch(wishlistCacheKey(steamId), { force }, async () => {
    const res = await keylessRetryingFetch(
      'getWishlist',
      `https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid=${steamId}`,
    );
    if (!res.ok) throw upstreamError(`Steam API error ${res.status}`);
    const { response } = await res.json();
    // A private wishlist, a private profile, and a genuinely empty wishlist are
    // all indistinguishable — each returns `{"response":{}}` with no `items` key.
    // Treat all three as an empty wishlist rather than throwing.
    return { value: response.items || [] };
  });
}

const friendsCacheKey = (steamId) => `friends:${steamId}`;
// A documented, keyed endpoint (unlike the wishlist/tags/search endpoints elsewhere in this
// file — see docs/dev/integrations.md's trust tiers). Steam signals a private friends list with
// a 401 rather than a 200 with an empty list — same private-vs-empty ambiguity as getWishlist,
// but distinguishable here: cached as `null` (not `[]`) so callers can tell "we don't know" apart
// from "confirmed no friends".
async function getFriendList(steamId, { force = false } = {}) {
  return cachedFetch(friendsCacheKey(steamId), { force }, async () => {
    const res = await apiFetch(
      'getFriendList',
      `https://api.steampowered.com/ISteamUser/GetFriendList/v1/?key=${STEAM_KEY}&steamid=${steamId}`,
      { expected: [401] }, // a private friends list
    );
    if (res.status === 401) return { value: null };
    if (!res.ok) throw upstreamError(`Steam API error ${res.status}`);
    const { friendslist } = await res.json();
    return { value: (friendslist?.friends || []).map((f) => f.steamid) };
  });
}

// Per-id in-flight GetPlayerSummaries promises. Deliberately keyed per steamid rather than
// per-batch (the old approach was `withDedup` on the joined, sorted list of currently-
// uncached ids) — two overlapping concurrent calls whose uncached sets differ (e.g. call A
// wants [alice,bob] and is still in flight when call B arrives wanting [bob,carol], because
// they were built from different already-cached subsets) used to get different dedup keys
// and both fire a fetch covering `bob`. Keying per id means `bob` above is only ever
// in flight once, no matter which call's batch it rides in on.
// A call riding on another client's refused batch gets placeholder names rather than retrying: names are optional.
const playerFetchInFlight = new Map(); // steamid -> Promise<player object | undefined>

// GetPlayerSummaries takes at most 100 steamids per call (Valve's Web API docs).
const PLAYER_BATCH_MAX = 100;

const playerCacheKey = (steamId) => `player:${steamId}`;

async function fetchPlayerBatch(ids) {
  const byId = new Map();
  try {
    await mapChunks(ids, PLAYER_BATCH_MAX, async (chunk) => {
      // Names are optional: a failure leaves placeholders rather than failing the libraries with them.
      try {
        const res = await apiFetch(
          'fetchPlayerBatch',
          `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_KEY}&steamids=${chunk.join(',')}`,
        );
        if (!res.ok) {
          console.warn(`[steam] GetPlayerSummaries answered ${res.status} for ${chunk.length} ids`);
          return;
        }
        const { response } = await res.json();
        for (const p of response.players || []) {
          setCache(playerCacheKey(p.steamid), p);
          byId.set(p.steamid, p);
        }
      } catch (err) {
        // A spent budget refuses every chunk after this one too, and has warned once already: stop.
        if (err.isBudgetExhausted) throw err;
        console.warn(`[steam] GetPlayerSummaries failed for ${chunk.length} ids:`, err.message);
      }
    });
  } catch {
    // Only a spent budget gets here: the names fetched so far are kept.
  }
  return byId;
}

async function getPlayerSummaries(steamIds, { force = false } = {}) {
  const { hits: result, uncached } = partitionCached(steamIds, playerCacheKey, { force });
  const pending = new Map(); // id -> Promise, for every id we need but didn't get from cache
  const toFetch = [];

  for (const id of uncached) {
    // A forced id always gets its own fresh fetch — never joins an in-flight fetch that may
    // have started before the force was requested (same reasoning as fetchGameDetails's
    // separate force dedup lane in server.js).
    if (!force && playerFetchInFlight.has(id)) {
      pending.set(id, playerFetchInFlight.get(id));
      continue;
    }
    toFetch.push(id);
  }

  if (toFetch.length > 0) {
    const batch = fetchPlayerBatch(toFetch);
    for (const id of toFetch) {
      const p = batch.then((byId) => byId.get(id));
      pending.set(id, p);
      if (!force) {
        playerFetchInFlight.set(id, p);
        p.finally(() => {
          if (playerFetchInFlight.get(id) === p) playerFetchInFlight.delete(id);
        });
      }
    }
  }

  for (const [id, p] of pending) {
    const player = await p;
    if (player) result.set(id, player);
  }

  return steamIds.map(
    (id) =>
      result.get(id) ??
      // A forced refresh Steam didn't answer for this id (failed, or left it out) keeps the entry it was replacing.
      (force ? getCached(playerCacheKey(id), { record: false }) : undefined) ?? {
        steamid: id,
        personaname: id,
        profileurl: '',
        placeholder: true,
      },
  );
}

function computeRating(raw) {
  if (!raw) return null;
  const n = raw.total_reviews;
  const pos = raw.total_positive;
  const p = pos / n;
  const z = 1.96;
  const z2 = z * z;
  // Wilson score lower bound (95% confidence) — same formula as SteamDB
  const score = (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return {
    score: Math.round(score * 100),
    desc: raw.review_score_desc,
    positive: pos,
    total: n,
  };
}

const ratingCacheKey = (appid) => `rating:${appid}`;
async function getGameRating(appid, { force = false } = {}) {
  const summary = await cachedFetch(ratingCacheKey(appid), { force }, async () => {
    // purchase_type 1 counts every purchase, Steam and keys alike; num_per_page 0 is ignored.
    const inputJson = encodeURIComponent(
      JSON.stringify({ appid: Number(appid), languages: ['all'], purchase_type: 1, num_per_page: 1 }),
    );
    const res = await reviewsRetryingFetch(
      'getGameRating',
      `https://api.steampowered.com/IUserReviewsService/GetAppReviews/v1/?input_json=${inputJson}`,
    );
    if (!res.ok) throw upstreamError(`Steam reviews error ${res.status}`);
    const response = (await res.json())?.response;
    // An unknown appid answers `{"response":{}}`: a miss, not a failure.
    if (typeof response !== 'object' || response === null) throw upstreamError('Unexpected GetAppReviews reply');
    const s = response.query_summary;
    return { value: s?.total_reviews ? s : null };
  });
  return computeRating(summary);
}

// Steam's `supported_languages` field is a single HTML-ish string, not structured data —
// e.g. `"English<strong>*</strong>, French, German<br><strong>*</strong>languages with full
// audio support"`. The trailing `<br>...` legend explains what the `*` footnote marker means;
// it's not itself a language, so only the text before the first `<br>` is real content. `*` is
// only ever used as that footnote marker (never part of an actual language name), so it's
// safe to strip globally rather than trying to preserve it per-entry.
function parseSupportedLanguages(html) {
  if (!html) return [];
  const [languageList] = html.split(/<br\s*\/?>/i);
  return languageList
    .replace(/<[^>]+>/g, '')
    .replace(/\*/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function extractAppDetails(raw, appid) {
  if (!raw) return null;
  const {
    name = null,
    type = null,
    genres = [],
    categories = [],
    developers = [],
    publishers = [],
    short_description = '',
    release_date = {},
    metacritic,
    screenshots = [],
    movies = [],
    capsule_imagev5 = null,
    capsule_image = null,
    header_image = null,
    dlc = [],
    fullgame = null,
    website = null,
    achievements = null,
    platforms: platformFlags = {},
    supported_languages = '',
    is_free = false,
    price_overview = null,
  } = raw;
  return {
    name,
    // Steam's own top-level content-type enum for this appid — `game`, `dlc`, `demo`,
    // `music` (soundtracks), `video`, `series`/`episode`, `mod`, `hardware`, `advertising`,
    // among others. Previously unread entirely; the only DLC-adjacent signal in use was
    // `fullgame != null` below, which only catches entries with a back-reference to a base
    // game — a soundtrack or video appid has no `fullgame` and would silently fall through
    // as an ordinary "game" (see public/utils.js's computeProductionTier and
    // public/library.js's Type column, both of which now key off this field instead/as well).
    // `null` rather than `'game'` when Steam's response omits it, so "we don't actually know"
    // stays distinguishable from a confirmed type.
    type,
    // Steam sometimes lists two distinct category/genre ids that happen to share the exact
    // same human-readable label (e.g. app 3357650 has separate ids 55/56 both labeled
    // "DualShock Controller Support", and 57/58 both "DualSense Controller Support" — likely
    // one id per feature tier, controller-vibration vs. full haptics/adaptive-trigger
    // support, that Steam's own store page just doesn't bother distinguishing by text). We
    // only ever display the label, never the id, so showing the same pill twice is never
    // meaningful — dedupe by description, order-preserving, right here at the source rather
    // than in every place that renders this list (the side panel's tag cloud, the Library
    // Explorer's Categories/Genres columns and their grouping).
    genres: [...new Set(genres.map((g) => g.description))],
    categories: [...new Set(categories.map((c) => c.description))],
    developers,
    publishers,
    description: short_description || null,
    // `coming_soon` only tells us whether the game has shipped yet, not whether Steam gave us
    // a usable date — an unreleased game can still have a concrete announced date (e.g.
    // "Oct 14, 2026"), not just a placeholder ("Coming soon"). Always pass through whatever
    // string Steam gives; public/library.js's `endOfReleasePeriod` handles turning fuzzy forms
    // ("2026", "Fall 2026") into a sortable date and treats genuinely unparseable placeholders
    // as missing.
    releaseDate: release_date?.date || null,
    // Steam's own ground truth for release status, kept alongside the date string rather than
    // re-derived client-side from parsing it — a coarse placeholder like "Coming soon" has no
    // parseable date at all, so the flag is the only reliable signal in that case. Used by
    // public/library.js to color-flag still-unreleased games in the Released column.
    comingSoon: !!release_date?.coming_soon,
    metacritic: metacritic?.score != null ? { score: metacritic.score, url: metacritic.url || null } : null,
    capsule:
      capsule_imagev5 || capsule_image || `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/capsule_sm_120.jpg`,
    // The game tables' thumbnail: capsule_image is the 231×87 capsule (capsule_imagev5 the 184×69 one).
    thumb: capsule_image || null,
    // The side panel's hero banner (public/mediaItems.js) — Steam's own header image for
    // this specific game, rather than only ever guessing the conventional `.../header.jpg`
    // CDN path. The guess (kept as a fallback here, and again client-side for the brief
    // window before this metadata has loaded at all) doesn't exist for every appid — some
    // games only ever had newer asset sizes uploaded — and since the guessed path never
    // changes, a game whose guess 404s stays broken no matter how many times the panel is
    // reopened. `header_image` is real store metadata, so it's always the correct asset.
    banner: header_image || `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/header.jpg`,
    movies: movies
      .slice(0, 5)
      .map((m) => ({ id: m.id, name: m.name || null, thumbnail: m.thumbnail, hls: m.hls_h264 || null })),
    screenshots: screenshots.slice(0, 10).map((s) => ({ id: s.id, thumbnail: s.path_thumbnail, full: s.path_full })),
    // Bare list of DLC appids Steam's own appdetails payload already includes for the base
    // game — free (no extra upstream call) since it rides along on the same response
    // fetched for everything else here. Just the ids; resolving each one's name/capsule
    // (public/panel.js's DLC card) is one ordinary getAppDetails call per DLC, through the
    // same GET /api/game-details/:appid every other single-game lookup already uses, and
    // only happens lazily once a panel's DLC card is actually expanded.
    dlc: Array.isArray(dlc) ? dlc : [],
    // The reverse of `dlc` above — present only on a DLC app's own appdetails response,
    // pointing back at the base game it belongs to ({appid, name}, appid as a string on the
    // wire like everywhere else in this payload). Free, same response, no extra call. Lets
    // the side panel (public/panel.js) show a "Part of <Base Game>" link back up when the
    // currently open game is itself a piece of DLC, using the same in-panel navigation
    // (navigateToGame) the DLC list's own links use, just in the other direction.
    fullgame:
      fullgame && fullgame.appid != null ? { appid: Number(fullgame.appid), name: fullgame.name || null } : null,
    // Official game website, when the developer/publisher listed one — a plain field on the
    // same response, absent for plenty of (esp. smaller) games.
    website: website || null,
    // Rides on the exact same appdetails response as everything else here — Steam includes a
    // summary `{total, highlighted}` achievements object for free. Only `total` is used, and
    // only as a `GET /api/achievements/:appid` short-circuit (server.js): a confirmed 0 means
    // that route can skip GetSchemaForGame/GetGlobalAchievementPercentages/
    // GetPlayerAchievements entirely, since the only possible result is an empty list. `null`
    // (not 0) when Steam's response has no `achievements` key at all, so that short-circuit
    // can tell "confirmed zero" apart from "unknown" and fall back to asking the schema.
    achievementCount: achievements?.total ?? null,
    // Native OS support (as opposed to ProtonDB's community-reported Linux/Deck compatibility
    // *via Proton*, which is a separate compatibility layer, not native support) — same
    // appdetails response, no extra call. Returned as an array of names rather than three
    // separate boolean fields so the Library Explorer's Platforms column can reuse the exact
    // same multi-value groupable/filterable convention as Genres/Categories/Tags instead of
    // needing its own bespoke boolean-column handling.
    platforms: [platformFlags.windows && 'Windows', platformFlags.mac && 'Mac', platformFlags.linux && 'Linux'].filter(
      Boolean,
    ),
    // Same idea, for the `supported_languages` field — see parseSupportedLanguages above for
    // why it needs parsing rather than being usable as-is. Order-preserving (Steam's own
    // listing order, not re-sorted) same as genres/categories above.
    languages: parseSupportedLanguages(supported_languages),
    // Same appdetails response, no extra call — backs the client-side production-tier
    // heuristic (`computeProductionTier` in public/utils.js; see docs/dev/decisions.md
    // section). `priceInitial` is the undiscounted launch price in whole cents
    // (`price_overview.initial`), deliberately not `.final` — a sale discount must never make
    // a AAA game read as cheaper-tier than it actually launched at. `null` (not 0) when the
    // game is free or has no price data at all, so the heuristic can tell "no price signal"
    // apart from "priced at $0" (which Steam doesn't actually do outside of is_free).
    isFree: !!is_free,
    priceInitial: price_overview?.initial ?? null,
  };
}

const appDetailsCacheKey = (appid) => `meta:${appid}`;
async function getAppDetails(appid, { force = false } = {}) {
  const data = await cachedFetch(appDetailsCacheKey(appid), { force }, async () => {
    // `cc=us` pins the region so `price_overview` (see extractAppDetails' isFree/priceInitial)
    // always comes back in USD — without it Steam falls back to geolocating the server's own
    // IP, which would silently shift the currency/price the production-tier heuristic reads.
    const res = await fetchStoreApi(
      `https://store.steampowered.com/api/appdetails?appids=${appid}&l=english&cc=us`,
      'getAppDetails',
      appDetailsRetryingFetch,
    );
    if (!res.ok) throw upstreamError(`Steam Store API error ${res.status}`);
    const json = await res.json();
    // Steam sometimes keys the answer under a different appid (e.g. 1656930 → "3290770") while
    // `data.steam_appid` still matches the request.
    const entry =
      json?.[String(appid)] ?? Object.values(json ?? {}).find((e) => String(e?.data?.steam_appid) === String(appid));
    // A confirmed "no store page for this appid" — cached (it saves the same upstream call a
    // real answer does) but on the short miss TTL rather than META's, since an unreleased or
    // region-locked appid can get a page later. See setCache's `ttlMs` in lib/cache.js.
    if (!entry?.success || !entry.data) return { value: null, ttlMs: MISS_CACHE_TTL_MS };
    return { value: entry.data };
  });
  capComingSoon(appDetailsCacheKey(appid), data?.release_date?.coming_soon);
  return extractAppDetails(data, appid);
}

// An unreleased game's store data changes on release (date, price, coming soon itself): its row expires like a miss,
// capped on every read so a row written on the year-long tier before this rule follows.
function capComingSoon(key, comingSoon) {
  if (comingSoon) capExpiry(key, MISS_CACHE_TTL_MS);
}

// Appdetails as cached, never fetched.
function getCachedAppDetails(appid) {
  const data = getCached(appDetailsCacheKey(appid));
  capComingSoon(appDetailsCacheKey(appid), data?.release_date?.coming_soon);
  return extractAppDetails(data, appid);
}

// Trims to the fields the frontend actually renders (name + thumbnail). `slice(0, 10)` isn't a
// real cap in practice — the endpoint itself returns at most 10 items per call regardless of
// term (confirmed live) — it's just documenting that ceiling rather than trusting it to hold.
// Getting more than that means paginating (a `start=` offset) — a real extra upstream call per
// page against an undocumented endpoint, not something to do without revisiting the trust-tier
// note in docs/dev/integrations.md.
function extractSearchResults(raw) {
  if (!raw || !Array.isArray(raw.items)) return [];
  // The id lands in the search dropdown's HTML for everyone searching that term: integers only.
  return raw.items
    .filter((item) => Number.isSafeInteger(item.id) && item.id > 0)
    .slice(0, 10)
    .map((item) => ({
      appid: item.id,
      name: item.name,
      tinyImage: item.tiny_image || null,
    }));
}

const storeSearchCacheKey = (term) => `search:${term.toLowerCase()}`;
// Name → appid lookup for games not necessarily owned or wishlisted by anyone — backs the
// "look up any game" search box on both pages. Wraps the same undocumented storefront search
// Steam's own store search box uses (no auth, no key) — same trust tier as the HLTB/wishlist
// endpoints elsewhere in this file; see docs/dev/integrations.md's trust tiers.
async function searchStoreGames(term) {
  return cachedFetch(storeSearchCacheKey(term), {}, async () => {
    const res = await fetchStoreApi(
      `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=US`,
      'searchStoreGames',
    );
    if (!res.ok) throw upstreamError(`Steam store search error ${res.status}`);
    const results = extractSearchResults(await res.json());
    if (!results.length) return { value: results };
    try {
      return { value: await dropDemos(results) };
    } catch (err) {
      console.warn(`[search] demo filter skipped: ${err.message}`);
      return { value: results, ttlMs: MISS_CACHE_TTL_MS };
    }
  });
}

// The store search lists a demo as a plain `app`; the store browse item's `type` tells it apart.
// A game's demo stays one click away, on its panel's "Try the Free Demo" banner.
const BROWSE_TYPE_DEMO = 1;

async function dropDemos(results) {
  const items = await fetchStoreBrowseItems(
    results.map((r) => r.appid),
    'searchStoreGames',
    {},
  );
  const demos = new Set(items.filter((item) => item.type === BROWSE_TYPE_DEMO).map((item) => item.appid));
  return results.filter((r) => !demos.has(r.appid));
}

const CREATOR_GAMES_MAX = 100;

// `App_<id>` item keys only: packages (`Sub_`, base game + DLC) slip through `category1=998`.
function extractCreatorGames(raw) {
  if (typeof raw?.results_html !== 'string' || !Number.isFinite(raw.total_count)) {
    throw upstreamError('Steam store search: unexpected reply shape');
  }
  const appids = [...new Set([...raw.results_html.matchAll(/data-ds-itemkey="App_(\d+)"/g)].map((m) => Number(m[1])))];
  return { appids, total: raw.total_count, capped: raw.total_count > CREATOR_GAMES_MAX };
}

const creatorGamesCacheKey = (role, name) => `creator:${role}:${name}`;
// Every game whose developer or publisher is exactly `name` (case-sensitive, as Steam matches
// it), in Steam's relevance order, capped at one page. See docs/dev/integrations.md.
async function searchCreatorGames(role, name, { force = false } = {}) {
  return cachedFetch(creatorGamesCacheKey(role, name), { force }, async () => {
    const params = new URLSearchParams({
      [role]: name,
      category1: '998',
      infinite: '1',
      start: '0',
      count: String(CREATOR_GAMES_MAX),
      cc: 'us',
      l: 'english',
    });
    const res = await fetchStoreApi(`https://store.steampowered.com/search/results/?${params}`, 'searchCreatorGames');
    if (!res.ok) throw upstreamError(`Steam store search error ${res.status}`);
    const value = extractCreatorGames(await res.json());
    return { value, ttlMs: value.appids.length ? undefined : MISS_CACHE_TTL_MS };
  });
}

// Steam's own user tags — the same ones shown on the store page, SteamDB, and
// IsThereAnyDeal — rather than SteamSpy's separate, crowd-voted dataset (which this used to
// pull from). SteamSpy's tag votes are cast on steamspy.com itself and can be sparse or
// entirely empty for a game Steam itself has plenty of tag data for, especially anything
// niche or recent enough that SteamSpy's own community hasn't caught up on it.
//
// Two undocumented-but-official, key-less endpoints (same trust tier as the other
// undocumented endpoints covered by docs/dev/integrations.md's trust tiers) stand in for it:
//
// - `IStoreBrowseService/GetItems` (api.steampowered.com) returns a whole per-app "store
//   browse item" — `tagids` (already ordered by relevance weight descending, same order the
//   store page displays them in), plus other fields riding along on the exact same response
//   for free, e.g. `related_items.demo_appid` (see extractDemoAppid below). One call per game.
//   The raw item is cached whole (`browse:{appid}`) rather than just the extracted tagids,
//   same "cache raw, extract at read time" approach used everywhere else in this file — so
//   adding another field this call already returns (like the demo link) never needs a new
//   upstream request, just a new extractor over the same cached response.
// - `ajaxgetstoretags` (store.steampowered.com) maps every tagid to its human-readable
//   name — a single, near-static ~430-entry list, not per-game, so it's fetched once and
//   cached long-term (`tagnames:all`, in the same meta TTL group as `browse:`) rather
//   than repeated for every game.
const TAG_NAMES_CACHE_KEY = 'tagnames:all';

// A bundle's own tiers[].games[].id (an ITAD gid) sometimes maps not to a single Steam store
// page ("app/<id>") but to a Steam "sub" (package/license, "sub/<id>") or an official Steam
// "bundle" page ("bundle/<id>") — see lib/itad.js's resolveSteamAppIds. Both are purchasable
// Steam listings, just not single-app ones, and Steam has its own undocumented endpoints (same
// trust tier as ajaxgetstoretags/IStoreBrowseService above — see docs/dev/integrations.md) for what a
// given sub/bundle actually contains. A sub is most often a single title with no app/ page of
// its own (an "Anthology"/"DLC Upgrade" repackaging — confirmed live, see lib/itad.js's own
// comment), but not always; a bundle almost always spans more than one (a base game plus its
// DLC, sold as one SKU — confirmed live on Steam bundle 4995, EVERSPACE - Ultimate Edition).
// Cached like a real Steam-page mapping (near-permanent — a package's contents don't change)
// under new prefixes rather than reusing `browse:`/`schema:`'s per-appid shape.

async function resolveSteamPackageAppids(subId) {
  return cachedFetch(`steampkg:${subId}`, {}, async () => {
    const res = await fetchStoreApi(
      `https://store.steampowered.com/api/packagedetails?packageids=${subId}&cc=us&l=english`,
      'resolveSteamPackageAppids',
    );
    if (!res.ok) throw upstreamError(`Steam packagedetails error ${res.status}`);
    const data = await res.json();
    const entry = data?.[subId];
    const appids =
      entry?.success && Array.isArray(entry.data?.apps)
        ? entry.data.apps.map((a) => a.id).filter(Number.isInteger)
        : null;
    return { value: appids, ttlMs: appids === null ? MISS_CACHE_TTL_MS : undefined };
  });
}

async function resolveSteamBundleAppids(bundleId) {
  return cachedFetch(`steambundle:${bundleId}`, {}, async () => {
    const res = await fetchStoreApi(
      `https://store.steampowered.com/actions/ajaxresolvebundles?bundleids=${bundleId}&cc=us&l=english`,
      'resolveSteamBundleAppids',
    );
    if (!res.ok) throw upstreamError(`Steam bundle resolve error ${res.status}`);
    const data = await res.json();
    const entry = Array.isArray(data) ? data.find((b) => b.bundleid === Number(bundleId)) : null;
    const appids = Array.isArray(entry?.appids) ? entry.appids.filter(Number.isInteger) : null;
    return { value: appids, ttlMs: appids === null ? MISS_CACHE_TTL_MS : undefined };
  });
}

// Parsed once per row write, not once per game: a stream resolves every game against it. An
// expired or rewritten row has no or another write time, so it's read again.
let tagNameMemo; // { ts, map }
// A failed map is retried after this, not by every game of the stream that's resolving tags.
const tagNameHoldOff = createHoldOff(30 * 1000);

async function getTagNameMap() {
  const ts = getCachedAt(TAG_NAMES_CACHE_KEY);
  if (ts !== undefined && tagNameMemo?.ts === ts) return tagNameMemo.map;
  if (ts === undefined && tagNameHoldOff.isHeld()) {
    storeBreaker.assertClosed(); // an open circuit's error, unlike the remembered one, isn't logged per game
    throw tagNameHoldOff.reason;
  }
  let map;
  try {
    map = await fetchTagNameMap();
  } catch (err) {
    // One client's spent share says nothing about Steam.
    if (!err.isClientBudgetExhausted) tagNameHoldOff.fail(err);
    throw err;
  }
  tagNameHoldOff.clear();
  // A live row rewritten meanwhile may not be the one `map` came from; a missing one only this deduped fetch writes.
  const after = getCachedAt(TAG_NAMES_CACHE_KEY);
  if (ts === undefined || ts === after) tagNameMemo = { ts: after, map };
  return map;
}

function _resetPauses() {
  for (const retryingFetch of [
    storeRetryingFetch,
    appDetailsRetryingFetch,
    reviewsRetryingFetch,
    browseRetryingFetch,
    keylessRetryingFetch,
    protonRetryingFetch,
  ])
    retryingFetch.resetPause();
}

function _resetTagNameMap() {
  tagNameMemo = undefined;
  tagNameHoldOff.clear();
}

async function fetchTagNameMap() {
  return cachedFetch(TAG_NAMES_CACHE_KEY, {}, async () => {
    const res = await fetchStoreApi(
      'https://store.steampowered.com/actions/ajaxgetstoretags?l=english',
      'getTagNameMap',
    );
    if (!res.ok) throw upstreamError(`Steam store tags error ${res.status}`);
    // Observed live: a 200 with a `null` body. Any body without tags fails rather than caching an empty map.
    const tags = (await res.json())?.tags;
    const entries = Array.isArray(tags)
      ? tags.filter((t) => Number.isInteger(t?.tagid) && typeof t.name === 'string').map((t) => [t.tagid, t.name])
      : [];
    if (entries.length === 0) throw upstreamError('Steam store tags error: unexpected response body');
    return { value: Object.fromEntries(entries) };
  });
}

async function fetchStoreBrowseItems(appids, label, dataRequest) {
  const inputJson = encodeURIComponent(
    JSON.stringify({
      ids: appids.map((appid) => ({ appid: Number(appid) })),
      context: { language: 'english', country_code: 'US' },
      data_request: dataRequest,
    }),
  );
  const res = await browseRetryingFetch(
    label,
    `https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${inputJson}`,
  );
  if (!res.ok) throw upstreamError(`Steam store browse error ${res.status}`);
  const items = (await res.json())?.response?.store_items;
  if (!Array.isArray(items)) throw upstreamError('Unexpected GetItems reply');
  // An unknown or delisted app's item has `success` ≠ 1: a miss, not a failure.
  return items.filter((item) => item?.success === 1);
}

async function fetchStoreBrowseItem(appid) {
  const [item] = await fetchStoreBrowseItems([appid], 'fetchStoreBrowseItem', {
    include_tag_count: 30,
    include_basic_info: true,
    include_release: true,
    include_platforms: true,
    include_assets: true,
  });
  return item ?? null;
}

// The browse item's numeric `type` as appdetails' string; one not confirmed stays null.
const BROWSE_TYPES = { 0: 'game', 1: 'demo', 4: 'dlc', 11: 'music' };
const releaseDateFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'America/Los_Angeles', // Steam's: in UTC some dates land a day after appdetails' string
});

// The fields of a list row's store metadata that a browse item also carries, in extractAppDetails' shapes, so a
// row fills before its appdetails. Null for no item, or one cached before these fields were requested.
function extractBrowseBasics(item) {
  if (!item?.basic_info || !item.assets) return null;
  const { basic_info: info, release = {}, platforms = {}, assets } = item;
  const asset = (file) =>
    file && assets.asset_url_format
      ? `https://shared.akamai.steamstatic.com/store_item_assets/${assets.asset_url_format.replace('${FILENAME}', file)}`
      : null;
  // Only a full date matches appdetails' string; a month, quarter or "coming soon" waits for appdetails.
  const fullDate =
    release.steam_release_date && (!release.is_coming_soon || release.coming_soon_display === 'date_full');
  return {
    name: item.name || null,
    type: BROWSE_TYPES[item.type] ?? null,
    capsule: asset(assets.small_capsule),
    thumb: asset(assets.small_capsule),
    banner: asset(assets.header),
    description: info.short_description || null,
    releaseDate: fullDate ? releaseDateFormat.format(release.steam_release_date * 1000) : null,
    comingSoon: !!release.is_coming_soon,
    platforms: [platforms.windows && 'Windows', platforms.mac && 'Mac', platforms.steamos_linux && 'Linux'].filter(
      Boolean,
    ),
    developers: (info.developers ?? []).map((d) => d.name),
    publishers: (info.publishers ?? []).map((p) => p.name),
  };
}

const BASICS_KEYS = Object.keys(extractBrowseBasics({ basic_info: {}, assets: {} }));

// A game's basics: from its browse item, else from appdetails already cached (never fetched for this).
function gameBasics(item, appid) {
  const browse = extractBrowseBasics(item);
  if (browse) return browse;
  const meta = getCachedAppDetails(appid);
  return meta && Object.fromEntries(BASICS_KEYS.map((key) => [key, meta[key]]));
}

// Deliberately a new key prefix (`browse:`), not a reuse of the old SteamSpy-era `tags:` key
// (or even the short-lived `tagids:` key that replaced it): those stored a `{tagname:
// voteCount}` object and a bare `tagid[]` respectively, and a game with zero SteamSpy votes
// cached a bare `[]` that was indistinguishable, by shape alone, from a legitimate empty
// result under either later format. A fresh key sidesteps that whole class of ambiguity
// again — old entries under either previous key are simply never read and age out on their
// own after the meta TTL (META_CACHE_TTL_MINUTES in default.env).
const storeBrowseCacheKey = (appid) => `browse:${appid}`;

async function getStoreBrowseItem(appid, { force = false } = {}) {
  const item = await cachedFetch(storeBrowseCacheKey(appid), { force }, async () => ({
    value: await fetchStoreBrowseItem(appid),
  }));
  capComingSoon(storeBrowseCacheKey(appid), item?.release?.is_coming_soon);
  return item;
}

// `weight` is relative to the game's top tag (0–1): raw weights are uncomparable, capped vote counts.
// Takes the item's promise, so a cold name map is fetched alongside it rather than after it.
async function resolveSteamTags(itemPromise) {
  const [item, nameMap] = await Promise.all([itemPromise, getTagNameMap()]);
  const weights = new Map((Array.isArray(item?.tags) ? item.tags : []).map((t) => [t.tagid, t.weight]));
  const top = Math.max(0, ...weights.values());

  return (Array.isArray(item?.tagids) ? item.tagids : [])
    .filter((id) => nameMap[id])
    .map((id) => ({
      name: nameMap[id],
      weight: top > 0 && weights.has(id) ? Math.round((weights.get(id) / top) * 100) / 100 : null,
    }));
}

// The appid of this game's free demo, if it has one — `related_items.demo_appid` on the
// same store browse item the tags come from, so this never costs an extra upstream call;
// it's just a different extractor over the same cached response. Only the first listed demo
// is used — Steam allows more than one in principle (e.g. a demo per edition) but that's rare
// and the side panel only ever has room for one link.
function extractDemoAppid(item) {
  const demoAppid = item?.related_items?.demo_appid?.[0];
  return Number.isInteger(demoAppid) ? demoAppid : null;
}

// Linux/Steam Deck compatibility tier, from the community-run ProtonDB. Wraps its
// undocumented summary endpoint — same trust tier as the HLTB/wishlist endpoints
// elsewhere in this file (see docs/dev/integrations.md's trust tiers): no auth/key, low-volume,
// liable to change without notice. A 404 means "no reports for this appid yet",
// which is cached as null the same way an empty Steam review count is.
// "pending" isn't a confident compatibility outcome — it means ProtonDB has too few reports to
// assign one — but ProtonDB still publishes a `provisionalTier` (its own best-guess tier from
// those same reports) whenever there's at least one report, and showing that beats showing
// nothing (confirmed live: an appid with 3 reports and a clear provisionalTier of "platinum"
// otherwise surfaced as no data at all here despite protondb.com itself showing those 3
// reports). Passed through with `pending: true` so every client (the side panel's badge, the
// Library Explorer's column) can render it visibly lower-confidence rather than identical to a
// confirmed tier. Only falls back to null when ProtonDB has literally no provisional guess
// either (no reports at all) — raw upstream data is still what gets cached (see
// getProtonDbStatus below), so this is purely a display-transform decision and can change
// again later without needing to bust anything cached under an older rule.
function extractProtonDb(raw) {
  if (!raw) return null;
  if (raw.tier === 'pending') {
    if (!raw.provisionalTier) return null;
    return { tier: raw.provisionalTier, confidence: raw.confidence, total: raw.total, pending: true };
  }
  return { tier: raw.tier, confidence: raw.confidence, total: raw.total };
}

const protonDbCacheKey = (appid) => `protondb:${appid}`;
// Steam app types nobody launches, so no source times or reports them; each source adds its own.
const NEVER_LAUNCHED_TYPES = new Set(['music', 'video', 'series', 'episode', 'hardware']);
// A DLC isn't launched on its own either; demos and ads (old games re-listed) do get reports (integrations.md).
const PROTONDB_SKIPPED_TYPES = new Set([...NEVER_LAUNCHED_TYPES, 'dlc']);

// `type` and `unreleased` come from the game's store data: ProtonDB has no reports for those, so it isn't asked.
async function getProtonDbStatus(appid, { force = false, type, unreleased = false } = {}) {
  const cacheKey = protonDbCacheKey(appid);
  // Cached as a miss so the source has an age and counts as cached; a summary already cached is still served.
  // `unreleased` is inferred, so it only spares a lookup with nothing cached: a forced one asks, keeping what's there.
  const skip = PROTONDB_SKIPPED_TYPES.has(type)
    ? force || !isCached(cacheKey)
    : unreleased && !force && !isCached(cacheKey);
  if (skip) {
    setCache(cacheKey, null, { ttlMs: MISS_CACHE_TTL_MS });
    return null;
  }
  const raw = await cachedFetch(cacheKey, { force }, async () => {
    const res = await protonRetryingFetch(
      'getProtonDbStatus',
      `https://www.protondb.com/api/v1/reports/summaries/${appid}.json`,
      { expected: [404] }, // no reports yet
    );
    if (res.status === 404) return { value: null };
    if (!res.ok) {
      // 403 here has been observed as a blanket bot-block rather than a per-appid failure
      // (this fetch sends no headers, unlike HLTB's spoofed UA/Referer — see docs/dev/integrations.md) — a
      // body snippet distinguishes "app-specific error" from "same block page for every appid".
      const bodySnippet = await res.text().catch(() => '');
      throw upstreamError(
        `ProtonDB error ${res.status} for appid ${appid}${bodySnippet ? `: ${bodySnippet.slice(0, 200)}` : ''}`,
      );
    }
    const body = await res.json();
    if (typeof body?.tier !== 'string') throw upstreamError(`Unexpected ProtonDB reply for appid ${appid}`);
    return { value: body };
  });
  return extractProtonDb(raw);
}

// `gameschema:`, not `schema:`: those rows cached the bare achievement list, without the name.
const schemaCacheKey = (appid) => `gameschema:${appid}`;
// Achievement schema (names, descriptions, icons) for a game — store metadata, not player
// progress, so it lives in the same `cache_meta` TTL group as rating/HLTB/tags/
// ProtonDB (see the 'gameschema:' prefix in lib/cache.js). Most games have no achievements at
// all, and Steam represents that as a 200 response with no `achievements` key rather than
// an error — that's cached as an empty array, same non-error treatment as an empty wishlist.
//
// A game with no published stats schema *at all* is a third case, and Steam signals it as a
// 403 with a JSON `{"game":{}}` body rather than a 200 — observed on unreleased/pre-order
// pages (appid 4231820, releasing Oct 2026), which have no `achievements` key in appdetails
// either, so server.js's achievementCount short-circuit can't skip them. It's an expected
// per-appid answer, not a failure: throwing here turned every panel open on such a game into
// a 502 plus a fresh upstream call. A rejected `key=` also 403s, but with an HTML body — so
// the body is what tells a genuine auth failure apart from "nothing published for this appid".
// The schema's icon host lacks recent games' icons (404); this one serves them all (integrations.md).
// Remove once GetSchemaForGame returns shared.fastly.steamstatic.com URLs.
const LEGACY_ICON_BASE = 'https://steamcdn-a.akamaihd.net/steamcommunity/public/images/';
const ICON_BASE = 'https://shared.fastly.steamstatic.com/community_assets/images/';
const fixIconHost = (url) =>
  typeof url === 'string' && url.startsWith(LEGACY_ICON_BASE) ? ICON_BASE + url.slice(LEGACY_ICON_BASE.length) : url;

async function getGameSchema(appid, opts) {
  const schema = await fetchGameSchema(appid, opts);
  return {
    ...schema,
    achievements: schema.achievements.map((a) => ({
      ...a,
      ...('icon' in a && { icon: fixIconHost(a.icon) }),
      ...('icongray' in a && { icongray: fixIconHost(a.icongray) }),
    })),
  };
}

async function fetchGameSchema(appid, { force = false } = {}) {
  return cachedFetch(schemaCacheKey(appid), { force }, async () => {
    const res = await apiFetch(
      'getGameSchema',
      `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${STEAM_KEY}&appid=${appid}&l=english`,
      { expected: [403] }, // no stats; a rejected key also fails getOwnedGames, which alerts
    );
    if (res.status === 403) {
      const body = await res.text().catch(() => '');
      let json = false;
      try {
        JSON.parse(body);
        json = true;
      } catch {
        /* HTML body — see the 403 note above */
      }
      if (!json)
        throw upstreamError(
          `Steam schema error 403 for appid ${appid} — key rejected?${body ? ` ${body.slice(0, 200)}` : ''}`,
        );
      // Unreleased today, achievements at release — so this miss must not inherit the
      // tier's long TTL (see setCache's `ttlMs` in lib/cache.js).
      return { value: { name: null, achievements: [] }, ttlMs: MISS_CACHE_TTL_MS };
    }
    if (!res.ok) throw upstreamError(`Steam schema error ${res.status} for appid ${appid}`);
    const game = (await res.json())?.game;
    if (typeof game !== 'object' || game === null)
      throw upstreamError(`Unexpected GetSchemaForGame reply for appid ${appid}`);
    const list = game.availableGameStats?.achievements || [];
    return {
      value: {
        // Outlives the store page, so it names a delisted game; may lack the store title's punctuation.
        name: game.gameName || null,
        achievements: list.map((a) => ({
          apiname: a.name,
          name: a.displayName,
          description: a.description || null,
          icon: a.icon,
          icongray: a.icongray,
          hidden: !!a.hidden,
        })),
      },
    };
  });
}

const playerAchievementsCacheKey = (steamId, appid) => `playerach:${steamId}:${appid}`;
// One player's unlock state for one game's achievements — player progress, not store
// metadata, so unlike getGameSchema above this lives in the library
// TTL group: it changes as someone plays, same reasoning as owned-games/player-summary/
// wishlist data. Steam signals both "this game has no stats at all" (most games) and "this
// profile is private" as a non-2xx status (400 and 403 respectively) rather than a 200 with
// an empty body — both are common, expected outcomes rather than failures, so — same as
// getWishlist's private-vs-empty ambiguity — they're cached as null instead of thrown.
async function getPlayerAchievements(steamId, appid, { force = false } = {}) {
  return cachedFetch(playerAchievementsCacheKey(steamId, appid), { force }, async () => {
    const res = await apiFetch(
      'getPlayerAchievements',
      `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=${STEAM_KEY}&steamid=${steamId}&appid=${appid}&l=english`,
      { expected: [400, 403] }, // private profile, or no stats
    );
    if (res.status === 400 || res.status === 403) return { value: null };
    if (!res.ok) throw upstreamError(`Steam player achievements error ${res.status}`);
    const { playerstats } = await res.json();
    if (!playerstats?.success || !playerstats.achievements) return { value: null };
    return {
      value: playerstats.achievements.map((a) => ({
        apiname: a.apiname,
        achieved: !!a.achieved,
        unlocktime: a.unlocktime || 0,
      })),
    };
  });
}

const achievementRarityCacheKey = (appid) => `achrarity:${appid}`;
// Community-wide unlock percentage per achievement (e.g. "only 4.2% of players have this")
// — the same rarity stat Steam's own profile pages show next to each achievement. Public
// endpoint, no key needed. It's aggregate community data rather than per-account progress
// (unlike getPlayerAchievements above) but changes about as slowly as the schema does, so it
// shares the same `cache_meta` TTL group (see the 'achrarity:' prefix in
// lib/cache.js). A game with no achievements/stats — or an unrecognized appid — gets a 403
// with an empty body rather than a 200 with an empty list; both are cached as null the same
// non-error way getPlayerAchievements treats "no stats for this game" — at the short miss TTL,
// since an unreleased game's "no data" stops being true the day it ships.
async function getGlobalAchievementPercentages(appid, { force = false } = {}) {
  return cachedFetch(achievementRarityCacheKey(appid), { force }, async () => {
    const res = await keylessRetryingFetch(
      'getGlobalAchievementPercentages',
      `https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${appid}`,
      { expected: [403] }, // no achievements, or no such appid
    );
    // 403 is what's actually observed for both "this game has no achievements" and "this
    // appid doesn't exist" — same non-error treatment as getPlayerAchievements' 400/403.
    // Anything else (5xx, rate limiting) is a real upstream failure, not cached as null.
    if (res.status === 403) {
      // Same short miss TTL as getGameSchema's own 403 above, and for the same reason: an
      // unreleased game gets both a schema and rarity data at release, and must not be stuck
      // with "no rarity" for the rest of this tier's TTL.
      return { value: null, ttlMs: MISS_CACHE_TTL_MS };
    }
    if (!res.ok) throw upstreamError(`Steam global achievement percentages error ${res.status}`);
    const achievementpercentages = (await res.json())?.achievementpercentages;
    if (typeof achievementpercentages !== 'object' || achievementpercentages === null)
      throw upstreamError('Unexpected GetGlobalAchievementPercentagesForApp reply');
    const list = achievementpercentages.achievements || [];
    // Steam returns `percent` as a numeric string (e.g. "80.9"), not a number.
    return { value: Object.fromEntries(list.map((a) => [a.name, Number(a.percent)])) };
  });
}

// Recent news/announcements for a game — patch notes, event posts, community announcements.
// `ISteamNews/GetNewsForApp` is a documented, public, key-less endpoint (unlike the
// undocumented ones covered by docs/dev/integrations.md's trust tiers) — no auth needed, safe to call
// at the same volume as the rest of fetchGameDetails. `maxlength=1` asks Steam to truncate
// `contents` to almost nothing since the side panel only ever shows title/date/link, never
// the body — no point paying for or caching text nobody reads.
//
// `feeds=steam_community_announcements` restricts the response server-side to the developer/
// publisher's own posts — same content and language as the game's own Steam store page.
// Without it, the endpoint also aggregates syndicated third-party press (feedname varies per
// outlet, e.g. "Gamemag.ru", "Rock, Paper, Shotgun") in whatever language that outlet
// publishes in, mixed in with zero regard for the requester's locale; for some games that
// press coverage outnumbers official posts by 10:1 or more, which used to mean fetching many
// raw items client-side just to find a handful of official ones tucked in between (or missing
// them entirely on a small enough `count`). `feeds` finds every official post regardless of
// how much unrelated press surrounds it, so a modest `count` is enough again. This is an
// undocumented param (not listed on Steamworks' public GetNewsForApp page, same trust tier as
// the other undocumented endpoints covered by docs/dev/integrations.md's trust tiers) but does exactly
// what it says — verified directly against the live API. The `feedname` filter below is kept
// as a belt-and-suspenders check on top of it rather than removed — cheap insurance against
// this undocumented param being dropped or behaving inconsistently for some app, in which case
// this still keeps only official posts, just without `feeds`' efficiency benefit.
function extractNews(raw) {
  const items = raw?.newsitems || [];
  // Capped at 20 to match `count=20` on the request below — once `feeds` has already
  // restricted the raw response to official posts, keeping every one of them the fetch
  // could possibly return costs nothing extra upstream. The panel itself shows all of
  // these (see newsHtml, public/panel.js) since the section collapses by default; the
  // cap here just stops the list growing unbounded for an unusually prolific developer.
  return items
    .filter((n) => n.feedname === 'steam_community_announcements')
    .slice(0, 20)
    .map((n) => ({
      title: n.title,
      url: n.url,
      date: n.date, // unix seconds
      feedLabel: n.feedlabel || null,
    }));
}

const newsCacheKey = (appid) => `news:${appid}`;
async function getGameNews(appid, { force = false } = {}) {
  return cachedFetch(newsCacheKey(appid), { force }, async () => {
    const res = await keylessRetryingFetch(
      'getGameNews',
      `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${appid}&count=20&maxlength=1&format=json&feeds=steam_community_announcements`,
    );
    if (!res.ok) throw upstreamError(`Steam news error ${res.status}`);
    const appnews = (await res.json())?.appnews;
    // A missing `newsitems` is a game with no news; anything else of another shape is not a reply to cache.
    if (typeof appnews !== 'object' || appnews === null || !Array.isArray(appnews.newsitems ?? []))
      throw upstreamError('Unexpected GetNewsForApp reply');
    return { value: extractNews(appnews) };
  });
}

module.exports = {
  NEVER_LAUNCHED_TYPES,
  ownedGamesCacheKey,
  wishlistCacheKey,
  friendsCacheKey,
  playerCacheKey,
  ratingCacheKey,
  appDetailsCacheKey,
  storeSearchCacheKey,
  creatorGamesCacheKey,
  storeBrowseCacheKey,
  protonDbCacheKey,
  schemaCacheKey,
  playerAchievementsCacheKey,
  achievementRarityCacheKey,
  newsCacheKey,
  peekSteamId,
  resolveSteamId,
  getOwnedGames,
  getWishlist,
  getFriendList,
  getPlayerSummaries,
  getGameRating,
  getAppDetails,
  getStoreBrowseItem,
  resolveSteamTags,
  extractDemoAppid,
  gameBasics,
  resolveSteamPackageAppids,
  resolveSteamBundleAppids,
  searchStoreGames,
  searchCreatorGames,
  getProtonDbStatus,
  getGameSchema,
  getPlayerAchievements,
  getGlobalAchievementPercentages,
  getGameNews,
  _resetTagNameMap,
  _resetPauses,
};
