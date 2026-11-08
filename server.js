'use strict';

process.on('unhandledRejection', (err) => {
  console.error('[unhandled rejection]', err);
});

const express = require('express');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const zlib = require('node:zlib');
const rateLimit = require('express-rate-limit');

const {
  getCached,
  getCachedAt,
  isCached,
  isAnsweredFromCache,
  capExpiry,
  getCacheEntryCounts,
} = require('./lib/cache');
const { createDedup } = require('./lib/dedup');
const {
  getMetrics,
  recordLimiterTrip,
  recordRequest,
  recordStream,
  runAsClient,
  startEventLoopSampling,
  startedAt,
} = require('./lib/metrics');
const { getCircuitBreakers } = require('./lib/circuitBreaker');
const {
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
  searchStoreGames,
  searchCreatorGames,
  getProtonDbStatus,
  getGameSchema,
  getPlayerAchievements,
  getGlobalAchievementPercentages,
  getGameNews,
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
} = require('./lib/steam');
const { getUpstreamStats } = require('./lib/upstream');
const { getHLTB, getHeldGames, hltbCacheKey } = require('./lib/hltb');
const {
  getBundles,
  bundlesCacheKey,
  findBundleById,
  findCachedBundle,
  resolveSteamAppIds,
  steamAppIdCacheKey,
  resolveItadIds,
  itadIdCacheKey,
  getSteamShopId,
  getPrices,
  priceCacheKey,
  extractPriceInfo,
  getGameBundles,
  gameBundlesCacheKey,
  extractGameBundles,
} = require('./lib/itad');
const { withPickAndMix, withCachedPickAndMix } = require('./lib/fanatical');
const { findEarlyExpired } = require('./lib/earlyExpired');
const { withChoiceEnd } = require('./lib/humbleChoice');
const { itadDateAgreement } = require('./lib/itadDates');
const { streamEvent } = require('./lib/streamEvent.mjs');
const { catalogCacheKey, getGamePass, isGamePassCached } = require('./lib/gamepass');
const {
  SESSION_COOKIE,
  STATE_COOKIE,
  parseCookies,
  serializeCookie,
  buildLoginUrl,
  verifySteamAssertion,
  upsertUser,
  createSession,
  touchSession,
  destroySession,
  getSessionUser,
  setUserPref,
  isSyncedPrefKey,
  prefFits,
  PREFS_MAX_BYTES,
} = require('./lib/auth');
const { SESSION_TTL_MS, MISS_CACHE_TTL_MS, TRUST_PROXY, PUBLIC_ORIGIN } = require('./lib/config');

const HOST = process.env.HOST;
const PORT = process.env.PORT;
const MAX_USERS = Number(process.env.MAX_USERS);
const SEARCH_RATE_LIMIT_MAX = Number(process.env.SEARCH_RATE_LIMIT_MAX);
const DETAILS_RATE_LIMIT_MAX = Number(process.env.DETAILS_RATE_LIMIT_MAX);
const GAME_SEARCH_RATE_LIMIT_MAX = Number(process.env.GAME_SEARCH_RATE_LIMIT_MAX);
const ACHIEVEMENTS_RATE_LIMIT_MAX = Number(process.env.ACHIEVEMENTS_RATE_LIMIT_MAX);
const FRIENDS_RATE_LIMIT_MAX = Number(process.env.FRIENDS_RATE_LIMIT_MAX);
const STREAM_MAX_GAMES = Number(process.env.STREAM_MAX_GAMES);
const STREAM_CONCURRENCY = Number(process.env.STREAM_CONCURRENCY);
// A stream's appdetails in flight: enough to keep up with Steam's store details cap, little of its shared queue.
const STREAM_STORE_CONCURRENCY = 4;
const STREAM_MAX_PER_IP = Number(process.env.STREAM_MAX_PER_IP);
const BUNDLES_RATE_LIMIT_MAX = Number(process.env.BUNDLES_RATE_LIMIT_MAX);
const PREFS_RATE_LIMIT_MAX = Number(process.env.PREFS_RATE_LIMIT_MAX);
// Optional feature — see ITAD_API_KEY's comment in default.env. Checked once here rather than
// duplicated across every /api/bundles* route handler.
const isItadConfigured = () => !!process.env.ITAD_API_KEY;
// Shown to visitors; the setup hint goes to the startup log instead (see app.listen below).
const ITAD_UNAVAILABLE = "Bundles and prices aren't available on this instance: it isn't connected to IsThereAnyDeal.";
const requireItad = (_req, res, next) =>
  isItadConfigured() ? next() : res.status(503).json({ error: ITAD_UNAVAILABLE });
// Each country is its own cache key and ITAD call: only the region picker's list, else US.
const REGION_CODES = new Set(require('./public/regions.json').map((r) => r.code));
const parseCountry = (req) => {
  const code = typeof req.query.country === 'string' ? req.query.country.toUpperCase() : '';
  return REGION_CODES.has(code) ? code : 'US';
};

// Rate limiting is bypassed under NODE_ENV=test so the suite isn't throttled,
// unless a test opts in with RATE_LIMIT_ENABLED=true to exercise the limiter.
const rateLimitBypassed = () => process.env.NODE_ENV === 'test' && process.env.RATE_LIMIT_ENABLED !== 'true';
// One client as the limiters key it: an IPv4 address, or an IPv6 client's /56.
const clientKey = (req) => rateLimit.ipKeyGenerator(req.ip);

const isForceRefresh = (req) => req.query.refresh === '1' || req.query.refresh === 'true';

// /api/bundles' query, shared with bundlesListLimit's skip so both compute the same cache key.
const MAX_BUNDLES_OFFSET = 10_000; // 200 "Load more" pages: past it, an empty page ends the list
// An integer, or `fallback` when missing, zero or not finite: `?limit=0.5` still clamps to 1, not 20.
function queryInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n !== 0 ? Math.floor(n) : fallback;
}
function parseBundlesQuery(req) {
  return {
    country: parseCountry(req),
    offset: Math.max(0, queryInt(req.query.offset, 0)),
    limit: Math.min(50, Math.max(1, queryInt(req.query.limit, 20))),
    sort: '-publish', // the only order the frontend asks for (BundlesBrowseRoute's FETCH_SORT)
    expired: req.query.expired === '1' || req.query.expired === 'true',
  };
}

// A Steam64 id or custom-URL name, or a profile URL holding one (Compare and `u=` links send it raw).
const STEAM_NAME_RE = /^[A-Za-z0-9_-]{2,32}$/;
const STEAM_PROFILE_URL_RE =
  /^(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/(?:id|profiles)\/[A-Za-z0-9_-]{2,32}\/?$/i;
const isSteamIdentifier = (u) =>
  typeof u === 'string' && (STEAM_NAME_RE.test(u.trim()) || STEAM_PROFILE_URL_RE.test(u.trim()));
const isMemberList = (members) => Array.isArray(members) && members.every(isSteamIdentifier);
// The 400 message for the first entry of `members` that isn't a Steam account, or null.
function invalidMemberError(members) {
  const invalid = members.find((u) => !isSteamIdentifier(u));
  return invalid === undefined ? null : `Not a Steam account: "${String(invalid).slice(0, 40)}"`;
}

// ITAD game ids are UUIDs; anything else would only cache a miss under a junk key.
const ITAD_GID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isItadGid = (g) => typeof g === 'string' && ITAD_GID_RE.test(g);

// `members` as Steam64 ids from resolveSteamId's cache alone, or null if any would need Steam.
function cachedSteamIds(members) {
  if (!isMemberList(members)) return null;
  const ids = new Set();
  for (const raw of members) {
    const hit = peekSteamId(raw);
    if (hit === undefined) return null;
    ids.add(hit);
  }
  return ids;
}

// Wraps rateLimit() so every limiter also records when it actually rejects a request — the
// inbound counterpart to lib/metrics.js's outbound statuses. `handler` only runs once a
// request is actually over budget (not on every request, and not on a skip), so this is a
// direct trip count, not a coarser proxy. Centralized here rather than repeating a `handler`
// on each of the limiter definitions below. Mirrors express-rate-limit's own default handler
// (status + message) after recording the trip — see GET /api/metrics' limiterTrips.
// The defaults and test bypass every limiter shares; `skip` only adds the route's own rule.
function namedRateLimit(name, { skip, ...opts }) {
  return rateLimit({
    windowMs: 60 * 1000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please wait a minute and try again.' },
    ...opts,
    skip: (req, res) => rateLimitBypassed() || (skip?.(req, res) ?? false),
    handler: (req, res, _next, options) => {
      recordLimiterTrip(name);
      res.status(options.statusCode);
      if (!res.writableEnded) res.send(options.message);
    },
  });
}

// The oldest write time across a set of cache keys, or null if any of them isn't cached (a
// fresh fetch this request just made writes its own entry, so that case is rare) — what the
// `fetchedAt` field on /api/common-games and /api/wishlist reports. Oldest, not newest, so the
// UI's "Updated <when>" never claims data is fresher than its stalest part.
function oldestCachedAt(keys) {
  return oldestOf(keys.map((key) => getCachedAt(key)));
}

// The oldest of some write times, or null if any is missing (null or undefined).
function oldestOf(timestamps) {
  let oldest = null;
  for (const ts of timestamps) {
    if (ts == null) return null;
    if (oldest === null || ts < oldest) oldest = ts;
  }
  return oldest;
}

// Shared by every route's catch block below. Used to only log isUpstream/TimeoutError
// errors — anything else (including a genuine bug: a TypeError,
// etc.) fell through unlogged, because a plain, unmarked Error was indistinguishable from
// one of lib/steam.js's deliberately-thrown, expected client-facing errors (bad Steam id,
// private profile — see clientError() there). Those are still skipped here since they're
// normal and frequent, not worth a log line, but now that they're explicitly marked
// (isClientError), everything unmarked is logged too, on the assumption that an error
// nobody bothered to mark expected is probably a bug worth being able to find later. Logs
// the full stack, not just the message, since a bug needs its source line to be traceable.
function routeErrorStatus(route, err, unreadable) {
  if (err.isClientError) return 400;
  // Circuit-open errors (lib/steam.js's fetchStoreApi, while steam-store is blocked) are an
  // expected, already-logged consequence of the trip itself — see the one-time
  // [circuit-breaker] warning logged there at the moment it actually trips. Logging one more
  // near-identical [upstream:...] line per request blocked during the 5-minute window would
  // just repeat information already on record, potentially hundreds of times over.
  // Same for an exhausted outbound budget: chargeBudget warns once per window. A client past its
  // own share is told to slow down (429); the service itself is fine for everyone else.
  if (err.isClientBudgetExhausted) return 429;
  if (err.isLogged) return 502;
  if (err.isUpstream || unreadable) {
    console.error(`[upstream:${route}]`, err.stack || err.message);
    return 502;
  }
  if (err.name === 'TimeoutError') {
    console.error(`[timeout:${route}]`, err.stack || err.message);
    return 504;
  }
  console.error(`[bug:${route}]`, err.stack || err.message);
  return 500;
}

// The log keeps the detail: a bug's message shows internals, a parse error's quotes the upstream's body.
const INTERNAL_ERROR = 'Internal error';
function sendRouteError(res, route, err) {
  // Only res.json() on an upstream's reply throws one: an HTML page (an error or challenge) with a 200.
  const unreadable = err.name === 'SyntaxError';
  const status = routeErrorStatus(route, err, unreadable);
  const error = status === 500 ? INTERNAL_ERROR : unreadable ? 'Unreadable reply from upstream' : err.message;
  res.status(status).json({ error });
}

const app = express();
if (TRUST_PROXY) app.set('trust proxy', TRUST_PROXY);
// One string per param (the last), so a repeated `?q=a&q=b` can't hand a route an array.
app.set('query parser', (str) => Object.fromEntries(new URLSearchParams(str)));
// The Steam callback's query carries a signed assertion, replayable from the logs.
morgan.token('url', (req) => {
  const url = req.originalUrl || req.url;
  const [path] = url.split('?');
  return /^\/auth\/steam\/callback\/?$/i.test(path) ? path : url;
});
if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));
// A route pattern, never the URL; the app shell's is the one RegExp path, named rather than shown. `mountPath`:
// a router restores `baseUrl` when an error leaves it, before the reply closes.
function routeKey({ method, baseUrl, mountPath = baseUrl, route }, status) {
  if (!route) return status < 400 ? '(static)' : '(no route)';
  return `${method} ${typeof route.path === 'string' ? mountPath + route.path : '(app shell)'}`;
}
// At `close`, so the details stream counts to its end and a client leaving early shows as aborted.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('close', () =>
    recordRequest(routeKey(req, res.statusCode), {
      status: res.headersSent ? res.statusCode : null,
      ms: Date.now() - start,
      bytes: Number(res.getHeader('content-length')) || 0,
      aborted: !res.writableFinished,
    }),
  );
  next();
});
// Express 5 leaves req.body undefined when no JSON body was parsed.
app.use((req, _res, next) => {
  req.body ??= {};
  next();
});
// Ahead of the global parser: its routes parse their own body, past the 100 KB default and only once signed in.
const prefsRouter = express.Router();
prefsRouter.use((req, _res, next) => {
  req.mountPath = req.baseUrl; // see routeKey
  next();
});
app.use('/api/me/prefs', prefsRouter);
app.use(express.json());
// Charges a request's outbound calls to its client's share (chargeBudget); after the body parser, whose stream
// callbacks needn't keep the context. The prefs routes above make none; tests bypassing the limiters skip it.
app.use((req, _res, next) => (rateLimitBypassed() ? next() : runAsClient(clientKey(req), next)));

// Serves the real Vite production build (`npm run build`) once one exists, and falls back to
// serving public/ directly otherwise — but that fallback no longer serves a working frontend
// on its own: public/'s entry points are TypeScript (`<script type="module" src="/app.ts">`
// etc.), which a plain express.static + browser can't execute, so a fresh clone needs
// `npm run build` before `npm start` actually works (see README.md). This still exists
// so `npm start` needs no special-casing depending on whether dist/ has been built yet, and so
// the backend's own API routes work either way for direct API consumers.
const DIST_DIR = path.join(__dirname, 'dist');
const usingDist = fs.existsSync(path.join(DIST_DIR, 'index.html'));
const STATIC_DIR = usingDist ? DIST_DIR : path.join(__dirname, 'public');
if (usingDist) {
  // Vite's dist/assets/* filenames are content-hashed (e.g. panel-BSUK1-Ck.js) — genuinely
  // immutable once built, unlike public/'s own unhashed filenames (which can't get this
  // treatment: the same name there really can hold different content across a deploy). A long
  // max-age + immutable lets a repeat visitor's browser skip the conditional-GET round-trip
  // entirely instead of re-validating an ETag for a file that can never actually change under
  // that exact hashed name. Mounted ahead of the plain express.static below specifically so it
  // only applies to /assets — the dist/*.html entry files (served by that general handler,
  // with no special caching) are what reference the current hashes and must always be
  // refetched, not cached alongside them.
  app.use('/assets', express.static(path.join(DIST_DIR, 'assets'), { immutable: true, maxAge: '1y' }));
}
// `index: false`: `/` must reach the SPA fallback, which injects the link-preview tags.
app.use(express.static(STATIC_DIR, { index: false }));

// OpenSearch descriptor for /search?q=<term> (docs/user/features.md's "Search by URL") — its
// <link rel="search"> tag in index.html lets Chrome/Firefox offer "add as a search engine" for
// this instance's own address bar keyword, without whoever sets one up having to hand-type a
// keyword bookmark. Built from the request's own host rather than a fixed domain, since this is
// self-hosted and every instance lives at a different one.
const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
app.get('/opensearch.xml', (req, res) => {
  const host = escapeXml(req.get('host') || '');
  const origin = `${req.protocol}://${host}`;
  res
    .type('application/opensearchdescription+xml')
    .send(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">\n' +
        '  <ShortName>Playshelf</ShortName>\n' +
        `  <Description>Search for a game on Playshelf (${host})</Description>\n` +
        '  <InputEncoding>UTF-8</InputEncoding>\n' +
        `  <Url type="text/html" template="${origin}/search?q={searchTerms}"/>\n` +
        '</OpenSearchDescription>\n',
    );
});

// Every `:appid` route: rejected before its limiter, so handlers and skips get a valid `req.appid`.
app.param('appid', (req, res, next, raw) => {
  const appid = Number(raw);
  if (!Number.isInteger(appid) || appid <= 0) return res.status(400).json({ error: 'Invalid appid' });
  req.appid = appid;
  next();
});

// The account-list routes' (common-games, wishlist, friends) body: replies 400 and returns null
// when invalid.
function parseMembers(req, res) {
  const { members } = req.body;
  if (!Array.isArray(members) || members.length < 1) {
    res.status(400).json({ error: 'Provide at least 1 player' });
    return null;
  }
  if (members.length > MAX_USERS) {
    res.status(400).json({ error: `Too many users — maximum is ${MAX_USERS}` });
    return null;
  }
  const error = invalidMemberError(members);
  if (error) {
    res.status(400).json({ error });
    return null;
  }
  return members;
}
const isBodyRefresh = (req) => req.body.refresh === true;
const resolveSteamIds = async (raw) => [...new Set(await Promise.all(raw.map(resolveSteamId)))];

// Stricter limit for searches — each uncached user triggers Steam API calls. Shared by
// POST /api/common-games and POST /api/wishlist below, same "cache hits don't count"
// rule detailsLimit/gameSearchLimit/etc. already apply — a re-search for accounts already
// sitting fully in cache (resolve/player/games/wishlist) makes no upstream call at all, so it
// shouldn't spend this tighter budget the way a genuinely new/stale search does. Switching
// between a handful of already-loaded accounts used to burn the whole per-minute budget on
// requests that never touched Steam.
const searchLimit = namedRateLimit('search', {
  max: SEARCH_RATE_LIMIT_MAX,
  message: { error: 'Too many searches. Please wait a minute and try again.' },
  skip: (req) => {
    // A full refresh always re-fetches every account, so it must always count — same rule
    // isForceRefresh gets elsewhere in this file.
    if (isBodyRefresh(req)) return false;

    const ids = cachedSteamIds(req.body.members);
    if (!ids) return false;
    // The route's remaining upstream work is getPlayerSummaries + getOwnedGames (common-games) or
    // getWishlist (wishlist) per id.
    const listCacheKey = req.path === '/api/wishlist' ? wishlistCacheKey : ownedGamesCacheKey;
    return [...ids].every((id) => isCached(playerCacheKey(id)) && isCached(listCacheKey(id)));
  },
});

// Separate from searchLimit above rather than sharing it — that limiter's skip checks the
// games:/wishlist: prefixes, so sharing it would check the wrong cache prefix for /api/friends
// (friends:). Same "cache hits don't count" shape otherwise.
const friendsLimit = namedRateLimit('friends', {
  max: FRIENDS_RATE_LIMIT_MAX,
  message: { error: 'Too many friends lookups. Please wait a minute and try again.' },
  skip: (req) => {
    if (isBodyRefresh(req)) return false;
    const ids = cachedSteamIds(req.body.members);
    return !!ids && [...ids].every((id) => isCached(friendsCacheKey(id)));
  },
});

// Each details part's cached sources: response field -> cache key.
const FAST_SOURCES = {
  rating: ratingCacheKey,
  hltb: hltbCacheKey,
  tags: storeBrowseCacheKey,
  protondb: protonDbCacheKey,
};
const STORE_SOURCES = { meta: appDetailsCacheKey };
const DETAILS_SOURCES = { ...FAST_SOURCES, ...STORE_SOURCES };
const sourcesCached = (sources, appid, force = false) =>
  Object.values(sources).every((cacheKey) => isAnsweredFromCache(cacheKey(appid), { force }));

// The details limit exists to throttle upstream Steam/HLTB calls. Cache hits make
// no upstream calls, so they must not count — otherwise a refresh of an already
// loaded comparison (all cache hits) burns the budget and 429s itself. A forced one
// counts unless every source was fetched too recently to refetch (FORCE_MIN_AGE_MINUTES).

const allDetailsCached = (appid, force = false) => sourcesCached(DETAILS_SOURCES, appid, force);

const detailsLimit = namedRateLimit('details', {
  max: DETAILS_RATE_LIMIT_MAX,
  skip: (req) => {
    const { appid } = req;
    if (appid === undefined) return false; // POST /api/game-details/stream has no :appid
    return allDetailsCached(appid, isForceRefresh(req));
  },
});

// Store metadata alone (GET /api/game-meta/:appid): the panel's DLC card, and an opened list row's media,
// which the details stream leaves out. One store call instead of fetchGameDetails' five sources.
const metaLimit = namedRateLimit('meta', {
  max: DETAILS_RATE_LIMIT_MAX,
  skip: (req) => {
    return isCached(appDetailsCacheKey(req.appid));
  },
});

// News is deliberately NOT part of fetchGameDetails/the details limiter above — unlike
// rating/HLTB/meta/tags/ProtonDB, it's never shown anywhere but the side panel (no table
// column, nothing to sort/filter on), so fetching it for every game in a whole loaded
// library/comparison via the SSE stream would mean paying for it on games whose panel is
// never opened. It's fetched lazily instead, once per game, only when that game's panel
// actually opens (see public/panelData.ts) — same on-demand shape as achievements
// (achievementsLimit below), just without the per-account fan-out.
const newsLimit = namedRateLimit('news', {
  max: DETAILS_RATE_LIMIT_MAX,
  skip: (req) => {
    return isAnsweredFromCache(newsCacheKey(req.appid), { force: isForceRefresh(req) });
  },
});

// Shared by the /api/search-games route and its rate limiter below.
const normalizeSearchTerm = (raw) => (raw || '').trim().slice(0, 100).toLowerCase();

// Name→appid lookups for the "look up any game" search box. Debounced client-side, and each
// distinct search term only ever costs one upstream call (subsequent requests for the same
// term hit the cache), so this can be looser than searchLimit — it never fans out into the
// dozens of Steam calls a library search does.
const gameSearchLimit = namedRateLimit('gameSearch', {
  max: GAME_SEARCH_RATE_LIMIT_MAX,
  message: { error: 'Too many searches. Please wait a minute and try again.' },
  skip: (req) => {
    const term = normalizeSearchTerm(req.query.q);
    if (term.length < 2) return true; // no upstream call happens below this length
    return isCached(storeSearchCacheKey(term));
  },
});

// Shared by /api/creator-games and its limiter; case kept, since Steam matches the name exactly.
const CREATOR_ROLES = new Set(['developer', 'publisher']);
const parseCreatorQuery = (req) => ({
  role: CREATOR_ROLES.has(req.query.role) ? req.query.role : null,
  name: String(req.query.name || '')
    .trim()
    .slice(0, 200),
});

const creatorGamesLimit = namedRateLimit('creatorGames', {
  max: GAME_SEARCH_RATE_LIMIT_MAX,
  message: { error: 'Too many searches. Please wait a minute and try again.' },
  skip: (req) => {
    const { role, name } = parseCreatorQuery(req);
    if (!role || !name) return true; // rejected below without an upstream call
    if (isForceRefresh(req)) return false;
    return isCached(creatorGamesCacheKey(role, name));
  },
});

// Schema is per-appid (one call regardless of how many accounts are loaded); player progress
// is per (steamid, appid) — skip only once every one of those is already cached, same
// "cache hits don't count" rule as detailsLimit above. An id (e.g. a vanity name) whose
// resolution isn't cached always counts.
const parseSteamIdsQuery = (req) =>
  (req.query.steamids || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const achievementsLimit = namedRateLimit('achievements', {
  max: ACHIEVEMENTS_RATE_LIMIT_MAX,
  skip: (req) => {
    const { appid } = req;
    // A forced player's progress always refetches (the library tier), so it counts.
    const cached = (key) => isAnsweredFromCache(key, { force: isForceRefresh(req) });
    if (!cached(schemaCacheKey(appid))) return false;
    if (!cached(achievementRarityCacheKey(appid))) return false;
    const ids = parseSteamIdsQuery(req);
    // No steamids at all (a standalone lookup with no player loaded) only ever needed
    // schema+rarity above, both already confirmed cached — nothing left to check.
    if (!ids.length) return true;
    return ids.every((raw) => {
      const id = peekSteamId(raw);
      return id && cached(playerAchievementsCacheKey(id, appid));
    });
  },
});

const { version } = require('./package.json');
// Read once: the commit this process started from, so a production symptom can be dated against deploys.
const commit = (() => {
  try {
    const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    return out.trim();
  } catch {
    return null; // not a git checkout, or no git
  }
})();

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    version,
    commit,
    since: startedAt,
    configured: !!process.env.STEAM_API_KEY,
    itadConfigured: isItadConfigured(),
    cache: { entries: Object.values(getCacheEntryCounts()).reduce((sum, n) => sum + n, 0) },
  });
});

// Shape and reading guide: docs/dev/observability.md. No auth, like /api/health: nothing sensitive in it.
app.get('/api/metrics', (_req, res) => {
  res.json(
    getMetrics({
      version,
      commit,
      upstreamStats: getUpstreamStats(),
      breakers: getCircuitBreakers(),
      held: { hltb: getHeldGames() },
      openStreams: streamsOpen,
      cacheEntries: getCacheEntryCounts(),
      itadDates: itadDateAgreement(),
    }),
  );
});

// Browsing the bundle list, resolving games to/from Steam appids, and pricing them — each
// distinct combination of params/ids only ever costs one upstream call (repeats hit the
// cache), same reasoning as gameSearchLimit above. Unlike gameSearchLimit's single shared
// limiter, this is 5 separate rateLimit() instances (one per route below) each with a `skip`
// tailored to that route's own cache-key shape — mirroring detailsLimit/achievementsLimit's own
// "cache hits don't count" skip, not just a shared always-counts limiter. Without this, simply
// reloading the Bundles page a handful of times (every reload re-requests the list, and
// re-opens whatever bundle is deep-linked — see docs/dev/integrations.md) burns the
// whole per-minute budget on requests that never actually hit ITAD, and once burned, real
// upstream calls (a newly-opened bundle) start 429ing with no visible explanation.
const bundlesListLimit = namedRateLimit('bundlesList', {
  max: BUNDLES_RATE_LIMIT_MAX,
  skip: (req) => {
    const query = parseBundlesQuery(req);
    if (query.offset > MAX_BUNDLES_OFFSET) return true; // answered empty without calling ITAD
    if (isForceRefresh(req)) return false; // force-refresh always re-fetches, so it must always count
    return isCached(bundlesCacheKey(query));
  },
});

// GET /api/bundles/:id has no single deterministic cache key of its own — findBundleById
// (lib/itad.js) walks a variable number of already-cache-checked pages depending on where (or
// whether) the id turns up, so there's no cheap way to know in advance whether a given call
// will cost zero upstream requests. It still benefits from getBundles' own per-page cache
// underneath (a repeat deep link to an already-searched bundle makes no upstream calls even
// though it still counts here) — just given a looser budget instead of a skip, since deep
// links are a comparatively rare action (once per opened bundle) next to list browsing.
const bundlesByIdLimit = namedRateLimit('bundlesById', {
  max: BUNDLES_RATE_LIMIT_MAX * 2,
});

const gamePassLimit = namedRateLimit('gamePass', {
  max: BUNDLES_RATE_LIMIT_MAX,
  skip: (req) => !isForceRefresh(req) && isGamePassCached(parseCountry(req)),
});

const bundlesResolveLimit = namedRateLimit('bundlesResolve', {
  max: BUNDLES_RATE_LIMIT_MAX,
  skip: (req) => {
    const gids = req.body.gids;
    if (!Array.isArray(gids) || gids.length === 0) return false; // let the route's own validation reject it
    return gids.every((gid) => typeof gid === 'string' && isCached(steamAppIdCacheKey(gid)));
  },
});

// Backs the one shared /api/prices route below, so its skip has to handle both shapes a
// request can take: `gids` (Bundles, already resolved) or `appids` (Wishlist, resolved
// internally by that route via resolveItadIds first). Mirrors getPrices' own per-(gid,country)
// cache key either way; the appids branch additionally checks resolveItadIds' own
// per-appid cache key, since that resolution step is this route's own internal work too.
const pricesLimit = namedRateLimit('prices', {
  max: BUNDLES_RATE_LIMIT_MAX,
  skip: (req) => {
    if (isForceRefresh(req)) return false; // force-refresh always re-fetches, so it must always count
    const { gids, appids } = req.body;
    const country = parseCountry(req);
    if (Array.isArray(gids) && gids.length > 0) {
      return gids.every((gid) => typeof gid === 'string' && isCached(priceCacheKey(gid, country)));
    }
    if (Array.isArray(appids) && appids.length > 0) {
      return appids.every((appid) => {
        if (!Number.isInteger(appid)) return false;
        const gid = getCached(itadIdCacheKey(appid), { record: false });
        if (gid === undefined) return false; // resolution itself not cached yet
        if (gid === null) return true; // confirmed no ITAD listing — nothing left to price
        return isCached(priceCacheKey(gid, country));
      });
    }
    return false; // let the route's own validation reject it
  },
});

// The side panel's "in bundles" lines — one game at a time, so the same appid → gid → cache
// check as pricesLimit's appids branch.
const gameBundlesLimit = namedRateLimit('gameBundles', {
  max: BUNDLES_RATE_LIMIT_MAX,
  skip: (req) => {
    if (isForceRefresh(req)) return false;
    const gid = getCached(itadIdCacheKey(req.appid), { record: false });
    if (gid === undefined) return false;
    return gid === null || isCached(gameBundlesCacheKey(gid, parseCountry(req)));
  },
});

const RECENT_PLAYTIME_MS = 14 * 24 * 60 * 60 * 1000; // GetOwnedGames' playtime_2weeks

app.post('/api/common-games', searchLimit, async (req, res) => {
  const members = parseMembers(req, res);
  if (!members) return;

  // Explicit refresh (a user-clicked "↻ Refresh", not a normal search) bypasses the
  // library-tier cache (owned games + player summaries) so a just-bought game or a
  // changed display name shows up immediately, without waiting out the TTL.
  const refresh = isBodyRefresh(req);

  try {
    const ids = await resolveSteamIds(members);
    const [playerList, libraries] = await Promise.all([
      getPlayerSummaries(ids, { force: refresh }),
      Promise.all(ids.map((id) => getOwnedGames(id, { force: refresh }))),
    ]);

    // Union across accounts (a Steam Family) — first-seen wins.
    const merged = new Map();
    for (const library of libraries) {
      for (const game of library) {
        if (!merged.has(game.appid)) merged.set(game.appid, { appid: game.appid, name: game.name });
      }
    }
    const games = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));

    // `gameCount` rides along so the frontend can show it next to an account without a second request.
    const players = playerList.map((player, i) => ({
      ...player,
      gameCount: libraries[i].length,
    }));

    // Per-account playtime and last-played timestamp; an account has an entry only for games it owns.
    const playtime = {};
    const lastPlayed = {};
    ids.forEach((steamId, i) => {
      for (const game of libraries[i]) {
        if (!playtime[game.appid]) playtime[game.appid] = {};
        playtime[game.appid][steamId] = game.playtime_forever || 0;
        // Steam returns this as a Unix timestamp (seconds) directly on GetOwnedGames — no
        // extra request param needed. 0/missing means "never played" (owned but not launched).
        if (!lastPlayed[game.appid]) lastPlayed[game.appid] = {};
        lastPlayed[game.appid][steamId] = game.rtime_last_played || 0;
      }
    });

    // Steam's own two-week window, which says nothing of now once the cached library is older than that.
    const recentPlaytime = {};
    ids.forEach((steamId, i) => {
      if (Date.now() - (getCachedAt(ownedGamesCacheKey(steamId)) ?? Date.now()) > RECENT_PLAYTIME_MS) return;
      for (const game of libraries[i]) {
        if (game.playtime_2weeks) (recentPlaytime[game.appid] ??= {})[steamId] = game.playtime_2weeks;
      }
    });

    res.json({
      games,
      players,
      playtime,
      lastPlayed,
      recentPlaytime,
      fetchedAt: oldestCachedAt(ids.map(ownedGamesCacheKey)),
    });
  } catch (err) {
    sendRouteError(res, 'common-games', err);
  }
});

// Wishlist has no "family" concept in Steam itself — this just unions the
// wishlists of whichever accounts the Library Explorer page has loaded,
// same as it unions their owned-game libraries.
app.post('/api/wishlist', searchLimit, async (req, res) => {
  const members = parseMembers(req, res);
  if (!members) return;

  const refresh = isBodyRefresh(req);

  try {
    const ids = await resolveSteamIds(members);
    const [playerList, lists] = await Promise.all([
      getPlayerSummaries(ids, { force: refresh }),
      Promise.all(ids.map((id) => getWishlist(id, { force: refresh }))),
    ]);

    // Union across accounts — first-seen wins, same rule /api/common-games uses for libraries.
    const merged = new Map();
    for (const list of lists) {
      for (const item of list) {
        if (!merged.has(item.appid)) merged.set(item.appid, item);
      }
    }

    const items = [...merged.values()].map((item) => ({
      appid: item.appid,
      priority: item.priority,
      dateAdded: item.date_added ? new Date(item.date_added * 1000).toISOString().slice(0, 10) : null,
    }));

    // Player summaries + per-account wishlist size, same shape/purpose as /api/common-games'
    // `players` — lets the frontend show an accounts bar on the Wishlist tab too.
    const players = playerList.map((player, i) => ({
      ...player,
      itemCount: lists[i].length,
    }));

    res.json({ items, players, fetchedAt: oldestCachedAt(ids.map(wishlistCacheKey)) });
  } catch (err) {
    sendRouteError(res, 'wishlist', err);
  }
});

// Friends have no "family" concept in Steam either — unions each member's own friends list,
// same convention as /api/wishlist. A member whose friends list is private is silently
// excluded from the union (reported separately in `unavailable`) rather than failing the
// whole request.
app.post('/api/friends', friendsLimit, async (req, res) => {
  const members = parseMembers(req, res);
  if (!members) return;

  const refresh = isBodyRefresh(req);

  try {
    const ids = await resolveSteamIds(members);
    const lists = await Promise.all(ids.map((id) => getFriendList(id, { force: refresh })));

    const unavailable = ids.filter((id, i) => lists[i] === null);
    const friendIds = [...new Set(lists.flat().filter(Boolean))];

    const players = friendIds.length > 0 ? await getPlayerSummaries(friendIds) : [];
    const friends = players.map((p) => ({
      steamid: p.steamid,
      personaname: p.personaname,
      avatar: p.avatarfull || p.avatarmedium || p.avatar || null,
      profileurl: p.profileurl,
      timecreated: p.timecreated,
      loccountrycode: p.loccountrycode,
      realname: p.realname,
    }));

    res.json({ friends, unavailable, fetchedAt: oldestCachedAt(ids.map(friendsCacheKey)) });
  } catch (err) {
    sendRouteError(res, 'friends', err);
  }
});

// A result that one client's spent share left short (`limited`) is fetched again for another client.
const dedupDetails = createDedup('details', { isRefused: (details) => !!details.limited });

// appid is on every line: a stream fetches many games at once, so one game's failure must show apart from a whole batch's.
// `.cause` carries the real reason behind fetch's generic "fetch failed"; an `isLogged` error was already warned.
function logDetailsError(appid, label, err) {
  if (err?.isLogged) return;
  console.warn(`[game-details] ${label} (appid ${appid}):`, err?.message, err?.cause ?? '');
}

// The part's sources' `failed` names, refusal message and per-source ages, from its settled results.
function settleSources(appid, sources, results) {
  const failed = Object.keys(results).filter((source) => results[source].status === 'rejected');
  // A source refused because this client spent its share: the stream says so once, not per game.
  const refused = Object.values(results).find((r) => r.status === 'rejected' && r.reason?.isClientBudgetExhausted);
  // Each source's own age: one untouched store page mustn't date the rating fetched yesterday.
  const fetchedAts = Object.fromEntries(
    Object.entries(sources).map(([source, cacheKey]) => [source, getCachedAt(cacheKey(appid)) ?? null]),
  );
  return { fetchedAts, ...(failed.length && { failed }), ...(refused && { limited: refused.reason.message }) };
}

const value = (res) => (res.status === 'fulfilled' ? res.value : null);

// Everything but appdetails: these upstreams keep a faster pace than Steam's store details cap, so a list's rows fill ahead
// of it. Force-refresh gets its own lane, never handed a normal request's result (its own reads may still be cached: FORCE_MIN_AGE_MINUTES). `priority`: one
// game looked up, its HLTB search ahead of a list's backlog (a game already queued by a list joins its place).
function fetchFastDetails(appid, { force = false, priority = false } = {}) {
  return dedupDetails(`details:fast:${force ? 'force:' : ''}${appid}`, () => {
    const browsePromise = getStoreBrowseItem(appid, { force });
    const basicsPromise = browsePromise.then((item) => gameBasics(item, appid));
    // The game's name, which HLTB searches: always from store data resolved from the appid, never from the
    // client (no ownership check here). Without a confirmed name and type from the browse item, it waits for
    // appdetails', unforced: a forced one would refetch what the store part just refreshed, and only the name
    // is needed. A delisted game has no store page, but its achievement schema still names it.
    const namedPromise = basicsPromise
      .catch(() => null)
      .then((basics) => (basics?.name && basics.type ? basics : getAppDetails(appid)))
      .then(async (store) =>
        store ? store : { name: (await getGameSchema(appid, { force })).name ?? null, type: null },
      );
    // A meta failure fails HLTB too, so it reads as failed, not as "no data".
    const hltbPromise = namedPromise.then(({ name, type }) => getHLTB(appid, name, { type, force, priority }));
    // "Unreleased" only once appdetails agrees (fetched by this load anyway, and expiring daily for such a game):
    // the browse item can be a year old. A failed browse item still asks ProtonDB.
    const protondbPromise = basicsPromise
      .catch(() => null)
      .then(async (basics) => {
        const unreleased = !!basics?.comingSoon && !!(await getAppDetails(appid).catch(() => null))?.comingSoon;
        return getProtonDbStatus(appid, { force, type: basics?.type, unreleased });
      });
    const tagsPromise = resolveSteamTags(browsePromise);
    const demoPromise = browsePromise.then(extractDemoAppid);
    return Promise.allSettled([
      getGameRating(appid, { force }),
      hltbPromise,
      tagsPromise,
      demoPromise,
      protondbPromise,
      basicsPromise,
      namedPromise,
    ]).then(([ratingRes, hltbRes, tagsRes, demoRes, protondbRes, basicsRes, namedRes]) => {
      if (ratingRes.status === 'rejected') logDetailsError(appid, 'rating', ratingRes.reason);
      if (hltbRes.status === 'rejected') logDetailsError(appid, 'hltb', hltbRes.reason);
      if (tagsRes.status === 'rejected') logDetailsError(appid, 'tags', tagsRes.reason);
      if (demoRes.status === 'rejected' && demoRes.reason !== tagsRes.reason)
        logDetailsError(appid, 'demo', demoRes.reason);
      if (protondbRes.status === 'rejected') logDetailsError(appid, 'protondb', protondbRes.reason);
      const basics = value(basicsRes);
      // A game that isn't out yet has no reviews, ProtonDB reports or HLTB times; those misses
      // expire like any other miss, so they fill in after release instead of a year later.
      if (basics?.comingSoon) {
        for (const [cacheKey, res] of [
          [ratingCacheKey, ratingRes],
          [protonDbCacheKey, protondbRes],
          [hltbCacheKey, hltbRes],
        ]) {
          if (res.status === 'fulfilled' && res.value == null) capExpiry(cacheKey(appid), MISS_CACHE_TTL_MS);
        }
      }
      const tags = value(tagsRes);
      return {
        name: value(namedRes)?.name ?? null,
        basics,
        rating: value(ratingRes),
        hltb: value(hltbRes),
        tags: tags && tags.map((t) => t.name),
        tagWeights: tags && Object.fromEntries(tags.map((t) => [t.name, t.weight])),
        demo: value(demoRes),
        protondb: value(protondbRes),
        ...settleSources(appid, FAST_SOURCES, {
          rating: ratingRes,
          hltb: hltbRes,
          tags: tagsRes,
          protondb: protondbRes,
        }),
      };
    });
  });
}

// Appdetails alone, under Steam's store details cap (lib/steam.js).
function fetchStoreDetails(appid, { force = false } = {}) {
  return dedupDetails(`details:store:${force ? 'force:' : ''}${appid}`, () =>
    Promise.allSettled([getAppDetails(appid, { force })]).then(([metaRes]) => {
      if (metaRes.status === 'rejected') logDetailsError(appid, 'meta', metaRes.reason);
      return { meta: value(metaRes), ...settleSources(appid, STORE_SOURCES, { meta: metaRes }) };
    }),
  );
}

// Both parts as one reply: GET /api/game-details and a stream's fully cached games.
async function fetchGameDetails(appid, options) {
  const [fast, store] = await Promise.all([fetchFastDetails(appid, options), fetchStoreDetails(appid, options)]);
  const fetchedAts = { ...fast.fetchedAts, ...store.fetchedAts };
  const failed = [...(fast.failed ?? []), ...(store.failed ?? [])];
  const limited = fast.limited ?? store.limited;
  return {
    ...fast,
    meta: store.meta,
    fetchedAt: oldestOf(Object.values(fetchedAts)),
    fetchedAts,
    failed: failed.length ? failed : undefined,
    limited,
  };
}

// Backs the "look up any game" search box (both pages) — resolves a typed name to a short
// list of candidate appids, independent of anyone's library/wishlist. See lib/steam.js's
// searchStoreGames for the upstream endpoint and docs/dev/integrations.md's trust tiers.
app.get('/api/search-games', gameSearchLimit, async (req, res) => {
  const term = normalizeSearchTerm(req.query.q);
  if (term.length < 2) return res.json({ results: [] });
  try {
    const results = await searchStoreGames(term);
    res.json({ results });
  } catch (err) {
    sendRouteError(res, 'search-games', err);
  }
});

// A developer's or publisher's games, by exact name — see lib/steam.js's searchCreatorGames.
app.get('/api/creator-games', creatorGamesLimit, async (req, res) => {
  const { role, name } = parseCreatorQuery(req);
  if (!role) return res.status(400).json({ error: 'role must be developer or publisher' });
  if (!name) return res.status(400).json({ error: 'Missing name' });
  try {
    const { appids, total, capped } = await searchCreatorGames(role, name, { force: isForceRefresh(req) });
    res.json({ appids, total, capped, fetchedAt: getCachedAt(creatorGamesCacheKey(role, name)) ?? null });
  } catch (err) {
    sendRouteError(res, 'creator-games', err);
  }
});

// Backs the Bundles page's bundle list — a thin, cached proxy over ITAD's GET /bundles/v1.
// See lib/itad.js and docs/dev/integrations.md and docs/dev/data.md.
app.get('/api/bundles', bundlesListLimit, requireItad, async (req, res) => {
  const { country, offset, limit, sort, expired } = parseBundlesQuery(req);
  if (offset > MAX_BUNDLES_OFFSET) return res.json({ bundles: [], offset, limit, fetchedAt: null });
  try {
    // ?refresh=1 backs the browse page's own "↻ Refresh" — a bundle can go live or expire at any
    // time, so "the list I'm looking at is out of date" needs an answer that isn't "wait out the
    // TTL". Only this page of the list is forced; GET /api/bundles/:id deliberately has no
    // equivalent (findBundleById walks up to BUNDLE_SEARCH_MAX_PAGES pages, so forcing it would
    // cost several upstream calls to answer one deep link).
    let bundles = await getBundles({ country, offset, limit, sort, expired, force: isForceRefresh(req) });
    // Only on a first page that holds the whole active list: the client stops paging there, so no
    // later page repeats them. Its revival pages aren't forced by ?refresh=1: one call stays one call.
    if (!expired && offset === 0 && bundles.length < limit)
      bundles = [...bundles, ...(await findEarlyExpired(bundles, (params) => getBundles({ country, ...params })))];
    // Age of this page of the list, for the "Updated <when>" beside the browse page's own ↻ —
    // a bundle going live or expiring is exactly what that button is for, and that question is
    // unanswerable without knowing how old the list on screen is.
    res.json({
      bundles: await withPickAndMix(withChoiceEnd(bundles)),
      offset,
      limit,
      fetchedAt: getCachedAt(bundlesCacheKey({ country, offset, limit, sort, expired })) ?? null,
    });
  } catch (err) {
    sendRouteError(res, 'bundles', err);
  }
});

// Backs the Bundles page's `?bundle=<id>` deep link. There's no single-bundle-fetch endpoint
// upstream (see findBundleById's own comment in lib/itad.js) — this pages through the same
// GET /bundles/v1 the list above uses, active bundles first then expired, up to a bounded
// number of pages, and 404s rather than searching indefinitely if the id never turns up (very
// old/deleted bundle, or a bad id).
app.get('/api/bundles/:id', bundlesByIdLimit, requireItad, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid bundle id' });
  }
  const country = parseCountry(req);
  try {
    const found = await findBundleById(id, { country });
    if (!found) {
      return res
        .status(404)
        .json({ error: 'Bundle not found — it may be older than what we search, or already fully expired' });
    }
    // Age of the cached list page this bundle was found on — the same page cache GET /api/bundles
    // reports for the browse list. There's no forcing it (see this route's own note above), so
    // this is stated rather than actionable: it says how old the tiers/dates on screen are.
    const [bundle] = await withPickAndMix(withChoiceEnd([found.bundle]), { names: true });
    res.json({ bundle, fetchedAt: getCachedAt(found.cacheKey) ?? null });
  } catch (err) {
    sendRouteError(res, 'bundles-by-id', err);
  }
});

// Resolves a bundle's ITAD game ids (uuids, off tiers[].games[].id) to their Steam appid(s), so
// the Bundles page can feed the resolved subset into the same GET /api/game-details/:appid /
// POST /api/game-details/stream pipeline every other page already uses. A gid resolves to a
// plain number (the common case), an array of numbers (a Steam "sub"/"bundle" spanning several
// apps — see lib/itad.js's resolveSteamAppIds), or null for a gid with no Steam listing at all
// — the frontend renders those as the separate "not on Steam" list. `failed` lists the gids whose
// lookup errored, so the frontend doesn't read them as "not on Steam".
const MAX_BUNDLE_RESOLVE_GAMES = 500;
app.post('/api/bundles/resolve', bundlesResolveLimit, requireItad, async (req, res) => {
  const gids = req.body.gids;
  if (!Array.isArray(gids) || gids.length === 0) {
    return res.status(400).json({ error: 'Provide at least one game id' });
  }
  if (!gids.every(isItadGid)) return res.status(400).json({ error: 'gids must be ITAD game ids' });
  if (gids.length > MAX_BUNDLE_RESOLVE_GAMES) {
    return res.status(400).json({ error: `Too many games — maximum is ${MAX_BUNDLE_RESOLVE_GAMES}` });
  }
  try {
    const unique = [...new Set(gids)];
    const resolved = await resolveSteamAppIds(unique);
    const failed = unique.filter((gid) => !resolved.has(gid));
    res.json({ appids: Object.fromEntries(resolved), ...(failed.length && { failed }) });
  } catch (err) {
    sendRouteError(res, 'bundles-resolve', err);
  }
});

// The Steam games in PC Game Pass for `country`'s catalog — see lib/gamepass.js.
app.get('/api/game-pass', gamePassLimit, requireItad, async (req, res) => {
  const country = parseCountry(req);
  try {
    const result = await getGamePass(country, { force: isForceRefresh(req) });
    res.json({ ...result, fetchedAt: getCachedAt(catalogCacheKey(country)) ?? null });
  } catch (err) {
    sendRouteError(res, 'game-pass', err);
  }
});

// Steam's non-discounted regular price plus historical lows (all-time/1yr/3mo) and the current
// best deal across every shop ITAD tracks — one shared route for both callers that need this,
// since the actual pricing operation is identical either way and only the identifier space the
// caller already has differs:
//   - Bundles already has ITAD gids (off a bundle's own tiers[].games[].id) — pass `gids`.
//   - The Library Explorer's Wishlist tab only has Steam appids — pass `appids`; they're
//     resolved to gids internally first (resolveItadIds, the reverse of resolveSteamAppIds
//     above) before the identical price lookup runs. That reverse resolution isn't exposed as
//     its own route the way /api/bundles/resolve's gid→appid mapping is — nothing needs the raw
//     gid itself, unlike Bundles' own "which of these games have no Steam listing at all" list.
// A separate route from /api/bundles/resolve since it needs `country` (prices are region-
// specific; appid resolution isn't) and isn't always wanted (e.g. before a bundle's games have
// even resolved to Steam). See lib/itad.js's resolveItadIds/getPrices/extractPriceInfo.
const MAX_PRICE_LOOKUP_GAMES = 500;
app.post('/api/prices', pricesLimit, requireItad, async (req, res) => {
  const { gids, appids } = req.body;
  const byGid = Array.isArray(gids) && gids.length > 0;
  const byAppid = Array.isArray(appids) && appids.length > 0;
  if (byGid === byAppid) {
    // neither, or both — exactly one is required
    return res.status(400).json({ error: 'Provide exactly one of gids or appids' });
  }
  if (byGid && !gids.every(isItadGid)) return res.status(400).json({ error: 'gids must be ITAD game ids' });
  if (byAppid && !appids.every((a) => Number.isInteger(a) && a > 0)) {
    return res.status(400).json({ error: 'appids must be positive integers' });
  }
  if ((byGid ? gids : appids).length > MAX_PRICE_LOOKUP_GAMES) {
    return res.status(400).json({ error: `Too many games — maximum is ${MAX_PRICE_LOOKUP_GAMES}` });
  }
  const country = parseCountry(req);
  // ?refresh=1 backs the page-level "↻ Refresh prices" button (bundles.js/library.js) — force
  // only the price lookup itself, not the appid↔gid resolution above: that's an identity
  // mapping, not price data, and near-permanent in practice (same reasoning as the panel's own
  // ↻ Refresh never touching `resolve:` — see docs/dev/data.md), so refreshing
  // it on every price refresh would just be an extra upstream call for nothing.
  const force = isForceRefresh(req);
  try {
    // Map(requested key → gid|null) — an identity map when the caller already sent gids, so
    // the response-shaping loop below doesn't need two separate code paths.
    const gidByKey = byAppid ? await resolveItadIds([...new Set(appids)]) : new Map(gids.map((g) => [g, g]));
    const gidsToPrice = [...new Set([...gidByKey.values()].filter(Boolean))];
    const [shopId, prices] = await Promise.all([getSteamShopId(), getPrices(gidsToPrice, { country, force })]);
    const out = {};
    for (const [key, gid] of gidByKey) out[key] = extractPriceInfo(gid ? prices.get(gid) : null, shopId);
    // How old the oldest price in this batch is — the "Updated <when>" beside the caller's own
    // "↻ Refresh prices". Prices are the shortest-lived data the app shows and the most
    // consequential to act on (someone clicks through to a shop from these), so how old they are
    // is worth stating rather than implying.
    res.json({ prices: out, fetchedAt: oldestCachedAt(gidsToPrice.map((gid) => priceCacheKey(gid, country))) });
  } catch (err) {
    sendRouteError(res, 'prices', err);
  }
});

app.get('/api/game-bundles/:appid', gameBundlesLimit, requireItad, async (req, res) => {
  const { appid } = req;
  try {
    const gid = (await resolveItadIds([appid])).get(appid);
    if (!gid) return res.json({ bundles: [] });
    const country = parseCountry(req);
    const current = await getGameBundles(gid, { country, force: isForceRefresh(req) });
    // ITAD answers current bundles only; one it expired early comes from the list pages already
    // cached (/api/bundles fetched them), never an extra call.
    const cachedPage = (params) => getCached(bundlesCacheKey({ country, ...params }), { record: false });
    const active = cachedPage({ offset: 0, limit: 50, sort: '-publish', expired: false });
    const revived = Array.isArray(active)
      ? (await findEarlyExpired(active, cachedPage)).filter(
          (b) =>
            !current.some((c) => c.id === b.id) &&
            (b.tiers || []).some((t) => (t.games || []).some((g) => g.id === gid)),
        )
      : [];
    res.json({ bundles: extractGameBundles(await withPickAndMix(withChoiceEnd([...current, ...revived])), gid) });
  } catch (err) {
    sendRouteError(res, 'game-bundles', err);
  }
});

app.get('/api/game-details/:appid', detailsLimit, async (req, res) => {
  const { appid } = req;
  res.json(await fetchGameDetails(appid, { force: isForceRefresh(req), priority: true }));
});

app.get('/api/game-meta/:appid', metaLimit, async (req, res) => {
  const { appid } = req;
  try {
    res.json({ meta: await getAppDetails(appid) });
  } catch (err) {
    sendRouteError(res, 'game-meta', err);
  }
});

// Recent news/announcements for one game — see newsLimit above for why this is its own
// route rather than folded into fetchGameDetails/the SSE stream. Fetched by the side panel
// (public/panelData.ts) once per game, only when that game's panel actually opens.
app.get('/api/game-news/:appid', newsLimit, async (req, res) => {
  const { appid } = req;
  try {
    const news = await getGameNews(appid, { force: isForceRefresh(req) });
    res.json({ news });
  } catch (err) {
    sendRouteError(res, 'game-news', err);
  }
});

// Backs the Library Explorer side panel's "Achievements" section — schema (names/icons,
// shared regardless of who's asking) plus per-account unlock state for every account
// currently loaded (`steamids`, comma-separated; raw identifiers, resolved here same as
// everywhere else — never trusted as already-Steam64 even though the client always does
// send resolved ids in practice). Accounts within a slot are unioned the same way
// /api/common-games unions owned games: an achievement counts as unlocked for the group if
// any member has it, keeping the earliest unlock time among those that do.
app.get('/api/achievements/:appid', achievementsLimit, async (req, res) => {
  const { appid } = req;
  // Player progress (steamids) is optional — the achievement *list* (names, descriptions,
  // icons, community-wide rarity) is store metadata, not tied to any account, so it's still
  // useful with nobody loaded (e.g. a standalone "look up any game" lookup). Only the
  // achieved/unlocktime state per item depends on steamids being present; see `playerCount`
  // in the response below, which the frontend uses to distinguish "no player was asked about"
  // from "a player was asked about but their data is unavailable" (private:true).
  const rawIds = parseSteamIdsQuery(req);
  if (rawIds.length > MAX_USERS) {
    return res.status(400).json({ error: `Too many users — maximum is ${MAX_USERS}` });
  }
  const invalidIds = invalidMemberError(rawIds);
  if (invalidIds) return res.status(400).json({ error: invalidIds });

  const force = isForceRefresh(req);
  try {
    const steamIds = await resolveSteamIds(rawIds);
    const none = { achievements: [], total: 0, unlocked: 0, private: false, playerCount: steamIds.length };

    // Cheap short-circuit: appdetails (already fetched/cached for this game via
    // fetchGameDetails, well before any panel opens) already tells us — for free — whether
    // this game has achievements at all. Skip GetSchemaForGame/GetGlobalAchievementPercentages/
    // one GetPlayerAchievements per account entirely for a confirmed zero, since the only
    // possible result below is the same empty response. `force: false` — this is just an
    // opportunistic cache read; refreshing achievements shouldn't force a redundant appdetails
    // re-fetch. Any failure here (upstream down, never cached) is tolerated — it only costs
    // the optimization, never breaks the route — by falling through to the schema fetch below.
    const meta = await getAppDetails(appid, { force: false }).catch(() => null);
    if (meta && meta.achievementCount === 0) {
      return res.json(none);
    }

    // Sequenced rather than batched with the calls below: even when appdetails didn't confirm
    // zero (meta missing/failed, or achievementCount unknown), don't fire rarity/per-player
    // calls until schema itself confirms there's something to annotate.
    const schema = (await getGameSchema(appid, { force })).achievements;
    if (schema.length === 0) {
      return res.json(none);
    }

    let rarityFailed = false;
    const [rarity, ...perPlayer] = await Promise.all([
      // Rarity is a nice-to-have annotation, not core progress data — a transient upstream
      // failure here shouldn't take down the whole achievements panel the way a genuine
      // schema/player-achievements failure does, so it degrades (flagged as rarityFailed)
      // instead of rejecting the whole Promise.all.
      getGlobalAchievementPercentages(appid, { force }).catch((err) => {
        if (!err.isBudgetExhausted) console.warn(`[achievements] rarity (appid ${appid}):`, err.message);
        rarityFailed = true;
        return null;
      }),
      ...steamIds.map((id) => getPlayerAchievements(id, appid, { force })),
    ]);

    // null means "no data for this account" (private profile, or never touched this game's
    // stats) — distinguished here from "resolved, but genuinely 0 achieved" so the frontend
    // can tell "nobody has unlocked anything (yet)" apart from "can't tell, profile's private".
    const anyPlayerData = perPlayer.some((p) => p !== null);
    const unlockedAt = new Map(); // apiname -> earliest unlocktime across members who have it
    for (const list of perPlayer) {
      if (!list) continue;
      for (const a of list) {
        if (!a.achieved) continue;
        const prev = unlockedAt.get(a.apiname);
        // 0 is an unknown time, so any real one replaces it
        if (prev === undefined || (a.unlocktime && (!prev || a.unlocktime < prev)))
          unlockedAt.set(a.apiname, a.unlocktime || 0);
      }
    }

    const achievements = schema.map((a) => ({
      ...a,
      achieved: unlockedAt.has(a.apiname),
      unlocktime: unlockedAt.get(a.apiname) ?? null,
      // Community-wide unlock % (rarity) — absent rather than 0 when Steam has no rarity
      // data at all for this apiname, so the frontend can tell "genuinely unrated" apart
      // from "rounds to 0%".
      globalPct: rarity?.[a.apiname] ?? null,
    }));

    res.json({
      achievements,
      total: achievements.length,
      unlocked: achievements.filter((a) => a.achieved).length,
      // `private:true` when steamIds were given but yielded no usable data (private profile,
      // or nobody in the group has touched this game's stats) — never true when steamIds was
      // empty in the first place, that's what `playerCount` is for instead (see comment above).
      private: steamIds.length > 0 && !anyPlayerData,
      playerCount: steamIds.length,
      // Steam's public, non-player-specific achievements page for this game (works with no
      // login, no steamid needed) — not the same as a specific account's own achievements
      // page (which would need a steamid and, for a merged Family slot, picking one member
      // arbitrarily over the others), so this is the one link that's always correct
      // regardless of who — if anyone — is currently loaded.
      steamUrl: `https://steamcommunity.com/stats/${appid}/achievements/`,
      ...(rarityFailed && { rarityFailed }),
    });
  } catch (err) {
    sendRouteError(res, 'achievements', err);
  }
});

// This does the exact same per-appid work (rating/HLTB/meta/tags/ProtonDB) as
// GET /api/game-details/:appid above and is meant to be throttled by the same budget — it's
// just delivered as one SSE batch instead of N separate requests — so it shares detailsLimit
// rather than going unthrottled. Its skip() keys off req.appid (app.param), which isn't set on
// this array-bodied route, so every stream request counts fully against the budget (no
// cache-hit exemption here, unlike the single-appid route); that's the safe direction to be
// wrong in. STREAM_MAX_GAMES also caps how much work one request can queue up regardless of
// how many requests/minute the budget above allows.
// detailsLimit counts a stream once whatever its size, so this caps how many one client can have
// open at once: otherwise parallel streams of uncached games fill the shared store queue.
const openStreams = new Map(); // clientKey -> open stream count
let streamsOpen = 0; // every client's, for GET /api/metrics

app.post('/api/game-details/stream', detailsLimit, async (req, res) => {
  const { games: gameList } = req.body;
  if (!Array.isArray(gameList) || gameList.length === 0) {
    return res.status(400).json({ error: 'Provide at least one game' });
  }
  if (gameList.length > STREAM_MAX_GAMES) {
    return res.status(400).json({ error: `Too many games — maximum is ${STREAM_MAX_GAMES}` });
  }

  const validated = [];
  for (const g of gameList) {
    const appid = Number(g?.appid);
    if (!Number.isInteger(appid) || appid <= 0) {
      return res.status(400).json({ error: 'Invalid appid' });
    }
    validated.push(appid);
  }

  if (!rateLimitBypassed()) {
    const client = clientKey(req);
    const open = openStreams.get(client) ?? 0;
    if (open >= STREAM_MAX_PER_IP) {
      recordLimiterTrip('stream');
      return res.status(429).json({ error: 'Too many game lists loading at once. Wait for one to finish.' });
    }
    openStreams.set(client, open + 1);
    res.once('close', () => {
      const n = openStreams.get(client) - 1;
      if (n > 0) openStreams.set(client, n);
      else openStreams.delete(client);
    });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Vary', 'Accept-Encoding');
  // Gzipped (its size: docs/dev/architecture.md), as no reverse proxy is assumed to compress
  // text/event-stream (nginx doesn't by default).
  const gzip = /\bgzip\b/.test(req.get('accept-encoding') ?? '');
  let out = res;
  if (gzip) {
    res.setHeader('Content-Encoding', 'gzip');
    out = zlib.createGzip();
    out.pipe(res);
  }
  res.flushHeaders();

  let closed = false;
  res.on('close', () => {
    closed = true;
  });

  // One flush per event-loop turn: a flush per event costs bytes and CPU while cached games resolve in a burst,
  // and a row resolving alone still goes out at once.
  let flushQueued = false;
  const flush = () => {
    flushQueued = false;
    if (!closed && !out.writableEnded) out.flush(zlib.constants.Z_SYNC_FLUSH);
  };
  const send = (data) => {
    if (closed || res.writableEnded) return;
    out.write(`data: ${JSON.stringify(data)}\n\n`);
    if (gzip && !flushQueued) {
      flushQueued = true;
      setImmediate(flush);
    }
  };

  // Bounded worker pools pulling from shared cursors, not `validated.map(...)`: at most a pool's
  // size of appids is in flight for one request, so a disconnect stops the work within one appid
  // per worker, and one request can't park thousands of jobs in the semaphores' shared FIFO
  // queues that every other user's requests then wait behind.
  // A game cached throughout goes out as one event; any other as a fast part, ahead, and a store part, behind,
  // since appdetails runs under Steam's store details cap (lib/steam.js). Cached games lead each pool.
  const whole = new Set(validated.filter((appid) => allDetailsCached(appid)));
  const cachedFirst = (appids, sources) => {
    const groups = Map.groupBy(appids, (appid) => sourcesCached(sources, appid));
    return [...(groups.get(true) ?? []), ...(groups.get(false) ?? [])];
  };
  // Said once per stream; the workers go on, since cached games still fill in.
  let limitedSent = false;
  const pool = (appids, size, fetchEvent, fallback) => {
    let next = 0;
    const worker = async () => {
      while (!closed) {
        const i = next++;
        if (i >= appids.length) return;
        const appid = appids[i];
        try {
          const { limited, ...result } = await fetchEvent(appid);
          if (limited && !limitedSent) {
            limitedSent = true;
            send({ limited });
          }
          send(streamEvent({ appid, ...result }));
        } catch (err) {
          // fetchGameDetails resolves every sub-fetch via Promise.allSettled internally and should never itself
          // reject: a defensive backstop, logged so it can't vanish without a trace.
          console.error(`[bug:stream]`, `appid ${appid}:`, err.stack || err.message);
          send({ appid, ...fallback(appid) });
        }
      }
    };
    return Promise.allSettled(Array.from({ length: Math.min(size, appids.length) }, worker));
  };
  const nullFast = {
    name: null,
    basics: null,
    rating: null,
    hltb: null,
    tags: null,
    tagWeights: null,
    demo: null,
    protondb: null,
  };
  const loadStart = Date.now();
  const concurrent = ++streamsOpen;
  let listedMs;
  const fastUncached = validated.filter((appid) => !sourcesCached(FAST_SOURCES, appid)).length;
  const storeUncached = validated.filter((appid) => !sourcesCached(STORE_SOURCES, appid)).length;
  try {
    await Promise.all([
      pool(
        cachedFirst(validated, FAST_SOURCES).sort((a, b) => whole.has(b) - whole.has(a)),
        STREAM_CONCURRENCY,
        (appid) =>
          whole.has(appid)
            ? fetchGameDetails(appid)
            : fetchFastDetails(appid).then((fast) => ({ part: 'fast', ...fast })),
        (appid) =>
          whole.has(appid)
            ? { ...nullFast, meta: null }
            : { part: 'fast', ...nullFast, failed: Object.keys(FAST_SOURCES) },
      ).then(() => (listedMs = Date.now() - loadStart)),
      pool(
        cachedFirst(
          validated.filter((appid) => !whole.has(appid)),
          STORE_SOURCES,
        ),
        STREAM_STORE_CONCURRENCY,
        (appid) => fetchStoreDetails(appid).then((store) => ({ part: 'store', ...store })),
        () => ({ part: 'store', meta: null, failed: Object.keys(STORE_SOURCES) }),
      ),
    ]);
  } finally {
    streamsOpen--;
  }
  // Timings from loads that ran to the end with something to fetch; one the client left counts apart.
  const cold = fastUncached + storeUncached > 0;
  const doneMs = Date.now() - loadStart;
  recordStream({
    count: 1,
    games: validated.length,
    fastUncached,
    storeUncached,
    closedEarly: +closed,
    closedEarlyCold: +(closed && cold),
    limited: +limitedSent,
    concurrentMax: concurrent,
    ...(cold &&
      !closed && { cold: 1, listedMsSum: listedMs, listedMsMax: listedMs, doneMsSum: doneMs, doneMsMax: doneMs }),
  });

  send({ done: true });
  if (!res.writableEnded) out.end();
});

// ── Authentication (Steam OpenID) ────────────────────────────────────────────
// Entirely optional — the app works fully anonymously with localStorage-only prefs (see
// docs/dev/lists-and-accounts.md); signing in with Steam additionally syncs prefs server-side
// under the verified steamid, across browsers/devices.

const authLimit = namedRateLimit('auth', {
  max: 20,
});

function requireAuth(req, res, next) {
  const user = getSessionUser(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user;
  next();
}

// Shown to visitors; the setup hint goes to the startup log instead (see app.listen below).
const requireSignIn = (_req, res, next) =>
  PUBLIC_ORIGIN ? next() : res.status(503).send("Sign-in isn't available on this instance.");
// The scheme visitors see: req.protocol is the proxy hop's without TRUST_PROXY.
const signInCookieSecure = () => PUBLIC_ORIGIN.startsWith('https:');

app.get('/auth/steam/login', authLimit, requireSignIn, (req, res) => {
  // The state cookie must be set on the host Steam sends the visitor back to.
  if (req.get('host') !== new URL(PUBLIC_ORIGIN).host) return res.redirect(`${PUBLIC_ORIGIN}/auth/steam/login`);
  const state = crypto.randomBytes(16).toString('hex');
  res.setHeader(
    'Set-Cookie',
    serializeCookie(STATE_COOKIE, state, { maxAgeMs: 5 * 60 * 1000, secure: signInCookieSecure() }),
  );
  res.redirect(buildLoginUrl(PUBLIC_ORIGIN, state));
});

app.get('/auth/steam/callback', authLimit, requireSignIn, async (req, res) => {
  const secure = signInCookieSecure();
  const clearState = serializeCookie(STATE_COOKIE, '', {});
  const { [STATE_COOKIE]: expectedState } = parseCookies(req.headers.cookie);
  if (!expectedState || req.query.state !== expectedState) {
    res.setHeader('Set-Cookie', clearState);
    return res.status(400).send('Login request expired or invalid — please try signing in again.');
  }

  let steamid;
  try {
    steamid = await verifySteamAssertion(req.query, {
      origin: PUBLIC_ORIGIN,
      state: expectedState,
    });
  } catch (err) {
    console.error('[auth] steam assertion verification failed', err.stack || err.message);
    res.setHeader('Set-Cookie', clearState);
    return res.status(502).send('Could not verify Steam login — please try again.');
  }
  if (!steamid) {
    res.setHeader('Set-Cookie', clearState);
    return res.status(400).send('Steam login could not be verified.');
  }

  upsertUser(steamid);
  const sessionId = createSession(steamid);
  res.setHeader('Set-Cookie', [
    clearState,
    serializeCookie(SESSION_COOKIE, sessionId, { maxAgeMs: SESSION_TTL_MS, secure }),
  ]);
  res.redirect('/');
});

app.post('/auth/logout', (req, res) => {
  destroySession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', {}));
  res.json({ ok: true });
});

// Not behind requireAuth, and always 200 — this is checked unconditionally on every page load
// (see authStore.ts's initAuth) to answer "is anyone signed in", and since sign-in is optional
// most visits are anonymous, so that isn't an error condition worth a console-level 401 on
// every single one of them.
// Also where a session slides forward (touchSession): the one call every page load makes.
app.get('/api/me', (req, res) => {
  const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const user = getSessionUser(sessionId);
  if (user && touchSession(sessionId)) {
    res.setHeader(
      'Set-Cookie',
      serializeCookie(SESSION_COOKIE, sessionId, { maxAgeMs: SESSION_TTL_MS, secure: signInCookieSecure() }),
    );
  }
  res.json(user ? { steamid: user.steamid, prefs: user.prefs } : { steamid: null, prefs: null });
});

// One key per request, never a whole-blob PUT — matches prefs.ts's own per-key setPref, so
// two keys changing around the same time (different tabs/devices) can't clobber each other.
// `updatedAt` (the device's own clock) is stored with the value, never checked: the write always wins.
// The 1 KB covers the { value, updatedAt } around a value prefFits can accept.
const prefsBody = express.json({ limit: PREFS_MAX_BYTES + 1024 });
// Apart from sign-in's: a first sign-in pushes every local key at once.
const prefsLimit = namedRateLimit('prefs', { max: PREFS_RATE_LIMIT_MAX });
prefsRouter.put('/:key', prefsLimit, requireAuth, prefsBody, (req, res) => {
  const { value, updatedAt } = req.body;
  if (!('value' in req.body) || typeof updatedAt !== 'number') {
    return res.status(400).json({ error: 'body must be { value, updatedAt }' });
  }
  if (!isSyncedPrefKey(req.params.key)) return res.status(400).json({ error: 'unknown pref key' });
  if (!prefFits(req.user.steamid, req.params.key, value)) {
    return res.status(413).json({ error: 'saved settings are over their size limit' });
  }
  setUserPref(req.user.steamid, req.params.key, value, updatedAt);
  res.json({ ok: true });
});

// Chat apps' link previews read the served HTML without running the app, so their Open Graph
// tags are injected here, with the absolute image URL they require built from the request's origin.
const SITE_NAME = 'Playshelf';
const SITE_DESCRIPTION =
  'Explore Steam libraries as lists of games, with ratings, completion times and current prices in one sortable table.';
// Steam's short descriptions hold entities (only `&quot;`/`&amp;` across the cache) but no tags.
const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeEntities = (s) =>
  s.replace(/&(?:#(\d+)|#x([\da-f]+)|(\w+));/gi, (match, dec, hex, name) => {
    if (name) return XML_ENTITIES[name] ?? match;
    const codePoint = parseInt(dec ?? hex, dec ? 10 : 16);
    return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
  });
async function sendAppShell(
  req,
  res,
  { title = SITE_NAME, description = SITE_DESCRIPTION, image = '/og-image.jpg', card = 'summary_large_image' } = {},
) {
  // Read per request, as sendFile did: a rebuild replaces the hashed asset names it links.
  const shellHtml = await fs.promises.readFile(path.join(STATIC_DIR, 'index.html'), 'utf8');
  const origin = `${req.protocol}://${req.get('host')}`;
  const tags = [
    ['name', 'description', description],
    ['property', 'og:site_name', SITE_NAME],
    ['property', 'og:title', title],
    ['property', 'og:description', description],
    ['property', 'og:image', image.startsWith('/') ? origin + image : image],
    ['name', 'twitter:card', card],
  ].map(([attr, key, value]) => `<meta ${attr}="${key}" content="${escapeXml(value)}" />`);
  res.type('html').send(shellHtml.replace('</head>', `${tags.join('\n')}\n</head>`));
}

// Not recorded: a page load isn't a meta-tier lookup the cache metrics should count.
function gamePreview(appid) {
  const game = getCached(appDetailsCacheKey(appid), { record: false });
  // `||`: Steam's raw details can hold null, which defaults don't replace.
  return {
    title: game?.name || undefined,
    description: game?.short_description ? decodeEntities(game.short_description) : undefined,
    image: game?.header_image || undefined,
  };
}

// ITAD has no bundle image, so the cover is the first game banner wide enough for a card. Fields
// are typed by getBundles.
async function bundlePreview(id) {
  const cached = await findCachedBundle(id, REGION_CODES);
  if (!cached) return {};
  const [bundle] = withChoiceEnd([withCachedPickAndMix(cached)]);
  const games = bundle.counts?.games;
  const expiry = bundle.expiry && new Date(bundle.expiry);
  const ends =
    expiry &&
    !isNaN(expiry) &&
    `${expiry < Date.now() ? 'ended' : 'ends'} ${expiry.toLocaleDateString('en-US', { dateStyle: 'medium', timeZone: 'UTC' })}`;
  const description = [games && `${games} game${games === 1 ? '' : 's'}`, bundle.page?.name, ends]
    .filter(Boolean)
    .join(' · ');
  const image = bundle.tiers?.flatMap((tier) => tier.games).find((game) => game.assets?.banner600)?.assets.banner600;
  return { title: bundle.title, description: description || undefined, image };
}

// A link's player slots as public/urlState.ts's parseSlots reads them, each an array of members.
const parseSlots = (query) =>
  query
    .getAll('u')
    .map((value) =>
      value
        .split(',')
        .map((member) => member.trim())
        .filter(Boolean),
    )
    .filter((slot) => slot.length > 0);

// Bounds the cache reads a crafted link costs, and a title's length.
const PREVIEW_MAX_MEMBERS = 8;
const PREVIEW_MAX_TITLE = 100;
const capTitle = (title) => (title.length > PREVIEW_MAX_TITLE ? `${title.slice(0, PREVIEW_MAX_TITLE - 1)}…` : title);

// Each slot's members' cached Steam profiles, or null when one isn't resolved or named yet.
// Only `personaname` and `avatarfull` reach a card (integrations.md).
function cachedPlayers(slots) {
  if (slots.flat().length > PREVIEW_MAX_MEMBERS) return null;
  const players = slots.map((slot) =>
    slot.map((member) => {
      const steamId = peekSteamId(member);
      const player = steamId && getCached(playerCacheKey(steamId), { record: false });
      return typeof player?.personaname === 'string' ? player : null;
    }),
  );
  return players.flat().every(Boolean) ? players : null;
}

const slotName = (players) => players.map((player) => player.personaname).join(' + ');

// The page's own title (ListRoute.tsx) for one account's Owned or Wishlist; several slots aren't an account.
function accountListPreview(query, kind) {
  const slots = parseSlots(query);
  const players = slots.length === 1 && cachedPlayers(slots);
  if (!players) return {};
  const [members] = players;
  const name = slotName(members);
  const avatar = members.length === 1 && members[0].avatarfull;
  return {
    title: capTitle(`${name}'s ${kind === 'owned' ? 'Library' : 'Wishlist'}`),
    description: `${name}'s Steam ${kind === 'owned' ? 'games' : 'wishlist'}, with ratings, completion times and current prices.`,
    ...(typeof avatar === 'string' && { image: avatar, card: 'summary' }),
  };
}

function comparePreview(query) {
  const slots = parseSlots(query);
  const players = slots.length >= 2 && cachedPlayers(slots);
  if (!players) return {};
  const names = players.map(slotName);
  return {
    title: capTitle(names.join(' vs. ')),
    description: `The Steam games ${names.slice(0, -1).join(', ')} and ${names.at(-1)} own, together and apart.`,
  };
}

// public/creatorData.ts's creatorTitle wording.
function creatorPreview(query, role) {
  const name = query.get('name')?.trim();
  if (!name) return {};
  const by = role === 'developer' ? 'by' : 'published by';
  return {
    title: capTitle(role === 'developer' ? `Games by ${name}` : `Published by ${name}`),
    description: `Every Steam game ${by} ${capTitle(name)}, with ratings, completion times and current prices.`,
  };
}

const FIXED_PREVIEWS = {
  '/lists/game-pass': { title: 'Steam games in PC Game Pass' },
  '/bundles': { title: 'Current game bundles' },
};

// The page's card for chat apps' link previews; {} is the site's card. Cache only: a preview
// mustn't cost an upstream request (integrations.md's trust tiers).
async function linkPreview(req) {
  // Not req.query: Express 5 makes a repeated param an array.
  const query = new URL(req.url, 'http://x').searchParams;
  // A list opened on a game: that game is what the page shows first.
  // As the client router matches it: any letter case, an optional trailing slash.
  const pathname = req.path.toLowerCase().replace(/(.)\/$/, '$1');
  const openGame = Number(query.get('game'));
  if (pathname.startsWith('/lists/') && Number.isInteger(openGame) && openGame > 0) return gamePreview(openGame);
  const bundleId = /^\/lists\/bundle\/(\d+)$/.exec(pathname)?.[1];
  if (bundleId) return bundlePreview(Number(bundleId));
  const appid = /^\/game\/(\d+)$/.exec(pathname)?.[1];
  if (appid) return gamePreview(appid);
  if (pathname === '/lists/owned') return accountListPreview(query, 'owned');
  if (pathname === '/lists/wishlist') return accountListPreview(query, 'wishlist');
  if (pathname === '/lists/compare') return comparePreview(query);
  if (pathname === '/lists/developer') return creatorPreview(query, 'developer');
  if (pathname === '/lists/publisher') return creatorPreview(query, 'publisher');
  return FIXED_PREVIEWS[pathname] ?? {};
}

// SPA fallback: any GET that isn't an /api/* call and doesn't look like a static-asset request
// (no dot-extension in its path) falls through to the app shell, letting the client-side
// router (see public/App.tsx) render the right view from the URL — needed once navigation
// between what used to be separate pages (Comparison/Library Explorer/Bundles/About) became
// client-side routing instead of real page loads (see docs/dev/architecture.md). Placed
// after every route above and after the static-file middleware (`express.static` above) so real API calls
// and real asset files are still served first; a path that looks like an asset (has a file
// extension) but genuinely doesn't exist still 404s via Express's default handler instead of
// being silently rewritten into the shell.
app.get(/^\/(?!api\/)(?!.*\.[a-zA-Z0-9]+$).*/, async (req, res) => {
  await sendAppShell(req, res, await linkPreview(req));
});

// Anything a route didn't catch, body-parser's malformed or oversized JSON included: Express's own
// handler would answer with an HTML page and, outside production, the stack.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error(`[server] ${req.method} ${req.path}`, err);
  res.status(status).json({ error: status === 500 ? INTERNAL_ERROR : err.message });
});

if (require.main === module) {
  if (!process.env.STEAM_API_KEY) {
    console.error('Error: STEAM_API_KEY is not set.');
    console.error('Add it to your .env file: STEAM_API_KEY=yourkey');
    console.error('Get a key at: https://steamcommunity.com/dev/apikey');
    process.exit(1);
  }
  if (!isItadConfigured()) console.warn('ITAD_API_KEY is not set: bundles and prices are off (see default.env).');
  if (!PUBLIC_ORIGIN) console.warn('PUBLIC_ORIGIN is not set: Steam sign-in is off (see default.env).');
  app.listen(PORT, HOST, (err) => {
    if (err) {
      console.error(`Error: cannot listen on ${HOST}:${PORT}: ${err.message}`);
      process.exit(1);
    }
    console.log(`\nPlayshelf → http://${HOST}:${PORT}\n`);
    startEventLoopSampling();
  });
}

module.exports = { app };
