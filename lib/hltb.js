'use strict';

const { createCachedFetch, isCached, setCache } = require('./cache');
const { createTrackedFetch, recordHeldLookup } = require('./metrics');
const { MISS_CACHE_TTL_MS, UPSTREAM_MIN_INTERVAL_MS } = require('./config');
const { createCircuitBreaker } = require('./circuitBreaker');
const { createSemaphore, createRetryingFetch, createHoldOff } = require('./upstream');
const { createDedup } = require('./dedup');

const hltbFetch = createTrackedFetch('hltb');
const cachedFetch = createCachedFetch(createDedup('hltb'));

const HLTB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HLTB_BASE = 'https://howlongtobeat.com/';

// Words stripped from search terms because HLTB uses strict AND matching and
// these words appear in Steam titles but not in HLTB's shorter canonical titles.
const EDITION_WORDS = new Set([
  'edition',
  'definitive',
  'goty',
  'complete',
  'ultimate',
  'enhanced',
  'remastered',
  'remake',
  'deluxe',
  'gold',
  'premium',
  'collection',
  'bundle',
]);

function normalizeText(s) {
  return s.normalize('NFD').replace(/\p{Mn}/gu, '');
}

function buildSearchTerms(query) {
  // Split on whitespace first, then further split each token on non-alphanumeric runs
  // so that "Bang-On" → ["Bang","On"] and "BIT.TRIP" → ["BIT","TRIP"] rather than
  // being merged into a single token that HLTB's AND search can't match.
  const all = normalizeText(query)
    .split(/\s+/)
    .flatMap((t) => t.split(/[^a-z0-9]+/gi))
    .filter(Boolean);
  const filtered = all.filter((t) => !EDITION_WORDS.has(t.toLowerCase()));
  return filtered.length > 0 ? filtered : all;
}

// Short-lived in-memory token cache (not persisted — tokens are session-bound)
let _hltbAuth = null;
let _hltbAuthTs = 0;
const HLTB_AUTH_TTL_MS = 5 * 60 * 1000;
// A failed init or a search block holds off re-init this long, rather than once per game.
const authHoldOff = createHoldOff(30 * 1000);

// Throttles the "[HLTB] search failed" warning below (not the searches themselves, which still
// each attempt and still each throw as before) — without it, a systemic outage/block mid-batch
// (auth still valid, but the search endpoint itself rejecting everything) would log one
// near-identical line per game in whatever library/comparison is loading, rather than one line
// making the same point repeatedly. Tracked separately from authHoldOff above: an
// auth-init failure and a mid-search rejection are different failure classes, and conflating
// them would suppress a genuine, distinct search-endpoint problem behind an unrelated
// already-throttled init failure (or vice versa).
let _hltbSearchWarnedAt = 0;
let _hltbSearchWarnedMessage = null;
const HLTB_SEARCH_WARN_THROTTLE_MS = 30 * 1000;

const searchBreaker = createCircuitBreaker('hltb', 'HLTB');

// Concurrency cap, and UPSTREAM_MIN_INTERVAL_MS per slot — HLTB blocks aggressive scrapers
const hltbLimit = createSemaphore(3, UPSTREAM_MIN_INTERVAL_MS, 'hltb');
// A 429 holds every queued search, which waits in its slot; the refused one fails, never retried.
const searchFetch = createRetryingFetch({
  limit: hltbLimit,
  trackedFetch: hltbFetch,
  name: 'HLTB',
  breaker: searchBreaker,
  retries: 0,
});

async function _fetchHLTBAuth() {
  try {
    const res = await hltbFetch('auth', `${HLTB_BASE}api/search/site/init?t=${Date.now()}`, {
      headers: { 'User-Agent': HLTB_UA, Referer: HLTB_BASE },
    });
    if (!res.ok) {
      authHoldOff.fail();
      console.warn(`[HLTB] init failed: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (!data.token) {
      authHoldOff.fail();
      console.warn('[HLTB] init failed: no token in the reply');
      return null;
    }
    _hltbAuth = data;
    _hltbAuthTs = Date.now();
    authHoldOff.clear();
    return _hltbAuth;
  } catch (err) {
    // One client's spent share says nothing about HLTB: that client is told, others log in.
    if (err.isClientBudgetExhausted) throw err;
    authHoldOff.fail();
    console.warn('[HLTB] init failed:', err.message);
    return null;
  }
}
const withAuthDedup = createDedup();

async function getHLTBAuth() {
  if (_hltbAuth && Date.now() - _hltbAuthTs < HLTB_AUTH_TTL_MS) return _hltbAuth;
  if (authHoldOff.isHeld()) return null;
  return withAuthDedup('auth', _fetchHLTBAuth);
}

function roundToHalfHour(seconds) {
  return Math.round(seconds / 1800) / 2;
}

// `query` is getHLTB's already-stripped name.
function pickBestMatch(data, query) {
  let best = null;
  let bestSim = -1;
  for (const e of data) {
    const sim = stringSimilarity(e.game_name, query);
    if (sim > bestSim) [best, bestSim] = [e, sim];
  }
  if (bestSim < 0.35) return null;

  return {
    id: best.game_id,
    // Rounded to the nearest half hour (not a whole hour) — the same granularity
    // HLTB's own site displays (e.g. "2½ Hours"), so we don't discard precision
    // their raw seconds figures actually carry.
    main: roundToHalfHour(best.comp_main),
    extra: roundToHalfHour(best.comp_plus),
    completionist: best.comp_100 ? roundToHalfHour(best.comp_100) : null,
    // "All PlayStyles" — the average of every individual completion-time submission
    // pooled together (not an average of the three category means above), weighted by
    // how many people submitted each category. Usually lands closer to Main Story than
    // to the other two, since far more players report a main-story time than a
    // completionist one.
    all: best.comp_all ? roundToHalfHour(best.comp_all) : null,
  };
}

// Steam app types HLTB doesn't time, so searching for them would only spend requests on a miss.
// `dlc` and `mod` stay: HLTB lists some.
const NOT_PLAYED_TYPES = new Set(['music', 'video', 'series', 'episode', 'hardware', 'demo', 'advertising']);

const hltbCacheKey = (appid) => `hltb:${appid}`;

// A failed lookup isn't cached (it would read as "no data"), so this keeps every list load from re-queuing it.
const FAILED_LOOKUP_HOLD_MS = 10 * 60 * 1000;
const failedLookups = new Map(); // appid -> when its lookup last failed

// `name` and `type` come from the app's store metadata.
async function getHLTB(appid, name, { type, force = false } = {}) {
  const cacheKey = hltbCacheKey(appid);
  const query = (name ?? '').replace(/[™®©]/g, '').trim();
  if (!query || NOT_PLAYED_TYPES.has(type)) {
    // Skipped by design, cached as a miss so the source has an age and counts as cached
    if (force || !isCached(cacheKey)) setCache(cacheKey, [], { ttlMs: MISS_CACHE_TTL_MS });
    return null;
  }
  const failedAt = failedLookups.get(appid);
  if (!force && Date.now() - failedAt < FAILED_LOOKUP_HOLD_MS) {
    recordHeldLookup('hltb');
    throw Object.assign(new Error('HLTB lookup failed recently'), { isLogged: true });
  }
  failedLookups.delete(appid);
  try {
    const data = await cachedFetch(cacheKey, { force }, async () => ({ value: await searchHLTB(query) }));
    return pickBestMatch(data, query);
  } catch (err) {
    // A budget refusal is about one client, not this game.
    if (!err?.isBudgetExhausted) {
      // Insertion order is failure order (deleted above first), so expired entries are at the front.
      for (const [id, at] of failedLookups) {
        if (Date.now() - at < FAILED_LOOKUP_HOLD_MS) break;
        failedLookups.delete(id);
      }
      failedLookups.set(appid, Date.now());
    }
    throw err;
  }
}

// HLTB's raw search results for `query`, up to 5.
async function searchHLTB(query) {
  searchBreaker.assertClosed();
  const auth = await getHLTBAuth();
  // `isLogged`: the failed init, or the search block holding it off, already warned (throttled).
  if (!auth) throw Object.assign(new Error('HLTB auth unavailable'), { isLogged: true });

  let freshBlock = false;
  let data;
  // In the slot, so the next queued search sees this answer. A 401 on the current token no search accepted
  // yet is a block, not expiry; one on a token already rejected adds nothing (integrations.md).
  const record = async (res) => {
    if (res.ok) {
      // A soft block can answer 200 with another body: only a real result list is a success.
      data = (await res.json())?.data;
      if (!Array.isArray(data)) throw new Error('Unexpected HLTB search reply');
      auth.accepted = true;
    }
    const current = auth === _hltbAuth;
    freshBlock = res.status === 401 && !auth.accepted && current;
    const blocked = res.status === 403 || freshBlock;
    if (res.status !== 401 || current) searchBreaker.record(blocked ? 403 : res.status);
    // Clear the token so the next call re-fetches; a block also holds off re-init for the
    // retry window rather than once per game.
    if (res.status === 401 || res.status === 403) {
      if (current) _hltbAuth = null;
      if (blocked) authHoldOff.fail();
    }
  };

  try {
    const res = await searchFetch(
      'search',
      `${HLTB_BASE}api/search/site`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': HLTB_UA,
          Referer: HLTB_BASE,
          'X-Auth-Token': auth.token,
          'X-Hp-Key': auth.hpKey,
          'X-Hp-Val': auth.hpVal,
        },
        body: JSON.stringify({
          [auth.hpKey]: auth.hpVal,
          searchType: 'games',
          searchTerms: buildSearchTerms(query),
          searchPage: 1,
          size: 5,
          searchOptions: {
            games: {
              userId: 0,
              platform: '',
              sortCategory: 'popular',
              rangeCategory: 'main',
              rangeTime: { min: 0, max: 0 },
              gameplay: { perspective: '', flow: '', genre: '', difficulty: '' },
              rangeYear: { min: '', max: '' },
              modifier: '',
            },
            users: { sortCategory: 'postcount' },
            lists: { sortCategory: 'follows' },
            filter: '',
            sort: 0,
            randomizer: 0,
          },
        }),
      },
      { record },
    );
    if (res.status === 401 || res.status === 403)
      throw new Error(`HLTB auth rejected (${res.status}${freshBlock ? ', fresh token' : ''})`);
    if (!res.ok) throw new Error(`HLTB API error ${res.status}`);
    return data;
  } catch (err) {
    // Already warned (a trip, a spent budget); it mustn't use up the throttle either.
    if (err.isLogged) throw err;
    if (Date.now() - _hltbSearchWarnedAt >= HLTB_SEARCH_WARN_THROTTLE_MS) {
      _hltbSearchWarnedAt = Date.now();
      _hltbSearchWarnedMessage = err.message;
      console.warn(`[HLTB] search failed for "${query}":`, err.message, err.cause ?? '');
    }
    // Only a repeat of the warned failure is covered; a different one is left to the caller's log.
    if (err.message === _hltbSearchWarnedMessage) err.isLogged = true;
    throw err;
  }
}

function stringSimilarity(a, b) {
  a = normalizeText(a).toLowerCase().trim();
  b = normalizeText(b).toLowerCase().trim();
  const [longer, shorter] = a.length >= b.length ? [a, b] : [b, a];
  if (longer.length === 0) return 1;
  return (longer.length - levenshtein(longer, shorter)) / longer.length;
}

function levenshtein(a, b) {
  const m = a.length,
    n = b.length;
  const row = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = i;
    for (let j = 1; j <= n; j++) {
      const val = a[i - 1] === b[j - 1] ? row[j - 1] : 1 + Math.min(prev, row[j], row[j - 1]);
      row[j - 1] = prev;
      prev = val;
    }
    row[n] = prev;
  }
  return row[n];
}

// Games whose lookups are held now, for GET /api/metrics.
function getHeldGames() {
  const now = Date.now();
  return [...failedLookups.values()].filter((at) => now - at < FAILED_LOOKUP_HOLD_MS).length;
}

function _resetAuth() {
  _hltbAuth = null;
  _hltbAuthTs = 0;
  authHoldOff.clear();
  failedLookups.clear();
  _hltbSearchWarnedAt = 0;
  _hltbSearchWarnedMessage = null;
  searchBreaker._reset();
  searchFetch.resetPause();
}

module.exports = { hltbCacheKey, getHLTB, getHeldGames, stringSimilarity, levenshtein, buildSearchTerms, _resetAuth };
