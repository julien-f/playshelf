'use strict';

const { createCachedFetch } = require('./cache');
const { createCircuitBreaker } = require('./circuitBreaker');
const { MISS_CACHE_TTL_MS, UPSTREAM_MIN_INTERVAL_MS } = require('./config');
const { createDedup } = require('./dedup');
const { normalizeName, mergeSearchResults } = require('./searchMerge.mjs');
const { createTrackedFetch } = require('./metrics');
const { upstreamError, createSemaphore, createRetryingFetch } = require('./upstream');

// IGDB (games on every platform), reached with Twitch client credentials — see
// docs/dev/integrations.md#igdb--games-outside-steam.
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const GAMES_URL = 'https://api.igdb.com/v4/games';
const IMAGE_BASE = 'https://images.igdb.com/igdb/image/upload';
const STEAM_SOURCE = 1; // external_games.external_game_source
// Main games, remakes, remasters, expanded games and ports: no DLC, mods, updates or bundles.
const GAME_TYPES = '(0,8,9,10,11)';
const SEARCH_LIMIT = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

const isIgdbConfigured = () => !!(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET);

const igdbFetch = createTrackedFetch('igdb');
const cachedFetch = createCachedFetch(createDedup('igdb'));
const withTokenDedup = createDedup();
// IGDB allows 4 requests per second and 8 open at once.
const igdbLimit = createSemaphore(4, UPSTREAM_MIN_INTERVAL_MS, 'igdb');
const breaker = createCircuitBreaker('igdb', 'IGDB');
const retryingFetch = createRetryingFetch(igdbLimit, igdbFetch, 'IGDB', breaker);

let token = null; // { value, renewAt }

async function fetchToken() {
  const res = await igdbFetch('token', TOKEN_URL, {
    method: 'POST',
    // In the body, not the query string: a URL ends up in logs and error messages.
    body: new URLSearchParams({
      client_id: process.env.TWITCH_CLIENT_ID,
      client_secret: process.env.TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) throw upstreamError(`IGDB: token request failed (${res.status})`);
  const { access_token: value, expires_in: expiresIn } = await res.json();
  if (typeof value !== 'string' || !(expiresIn > 0)) throw upstreamError('IGDB: unexpected token reply');
  // A day early, so a token never expires between this check and IGDB's.
  token = { value, renewAt: Date.now() + Math.max(expiresIn * 1000 - DAY_MS, (expiresIn * 1000) / 2) };
  return value;
}

const getToken = () =>
  token && Date.now() < token.renewAt ? Promise.resolve(token.value) : withTokenDedup('token', fetchToken);

// One APIcalypse query; a 401 (token revoked early) gets one retry with a fresh token.
async function query(label, body, signal) {
  for (let attempt = 0; ; attempt++) {
    const value = await getToken();
    const res = await retryingFetch(
      GAMES_URL,
      label,
      {
        method: 'POST',
        headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${value}` },
        body,
      },
      { signal },
    );
    if (res.status === 401 && attempt === 0) {
      // Only if still current: a concurrent 401 may already have renewed it.
      if (token?.value === value) token = null;
      continue;
    }
    if (!res.ok) throw upstreamError(`IGDB error ${res.status}`);
    return res.json();
  }
}

let warnedAt = 0;
const WARN_THROTTLE_MS = 30 * 1000;

async function warnOnFailure(what, promise) {
  try {
    return await promise;
  } catch (err) {
    // An open breaker or spent budget already warned when it happened; an abort is the caller giving up.
    if (
      !err.isCircuitOpen &&
      !err.isBudgetExhausted &&
      err.name !== 'AbortError' &&
      Date.now() - warnedAt >= WARN_THROTTLE_MS
    ) {
      warnedAt = Date.now();
      console.warn(`[igdb] ${what} failed:`, err.message);
    }
    throw err;
  }
}

const STEAM_LINK_FIELDS = ['', 'remasters.', 'ports.']
  .flatMap((prefix) => ['external_game_source', 'uid'].map((f) => `${prefix}external_games.${f}`))
  .join(', ');
const SEARCH_FIELDS = `name, total_rating_count, first_release_date, platforms.abbreviation, cover.image_id, ${STEAM_LINK_FIELDS}`;
const GAME_FIELDS =
  'name, url, summary, first_release_date, platforms.abbreviation, cover.image_id, screenshots.image_id, ' +
  'artworks.image_id, artworks.width, artworks.height, videos.video_id, videos.name, genres.name, involved_companies.company.name, involved_companies.developer, ' +
  `involved_companies.publisher, total_rating, total_rating_count, ${STEAM_LINK_FIELDS}`;

const escapeQuery = (term) => term.replace(/[\\"]/g, '\\$&');

const imageUrl = (size, imageId) => (imageId ? `${IMAGE_BASE}/t_${size}/${imageId}.jpg` : null);

const ownSteamAppid = (game) => {
  const uid = game?.external_games?.find((e) => e.external_game_source === STEAM_SOURCE)?.uid;
  const appid = Number(uid);
  return Number.isSafeInteger(appid) && appid > 0 ? appid : null;
};

// The game's Steam appid, else a remaster's or port's (IGDB lists a console original apart from its PC port).
function steamAppidOf(game) {
  return (
    ownSteamAppid(game) ?? [...(game.remasters ?? []), ...(game.ports ?? [])].map(ownSteamAppid).find(Boolean) ?? null
  );
}

// The exact title first (IGDB's own order buries it under longer ones), then the most rated.
function rankIgdbResults(results, term) {
  const wanted = normalizeName(term);
  const exact = (g) => (normalizeName(g.name ?? '') === wanted ? 1 : 0);
  return results.toSorted((a, b) => exact(b) - exact(a) || (b.total_rating_count ?? 0) - (a.total_rating_count ?? 0));
}

const yearOf = (unixSeconds) => (unixSeconds ? new Date(unixSeconds * 1000).getUTCFullYear() : null);
const platformsOf = (game) => (game.platforms ?? []).map((p) => p.abbreviation).filter(Boolean);

// `signal` drops the search while it still waits for a slot (see createSemaphore).
async function searchIgdb(term, { signal } = {}) {
  const raw = await warnOnFailure(
    `search for "${term}"`,
    cachedFetch(`igdb-search:${term.toLowerCase()}`, {}, async () => ({
      value: await query(
        'search',
        `search "${escapeQuery(term)}"; fields ${SEARCH_FIELDS}; where version_parent = null & game_type = ${GAME_TYPES}; limit ${SEARCH_LIMIT};`,
        signal,
      ),
    })),
  );
  return rankIgdbResults(raw, term).map((g) => ({
    id: g.id,
    name: g.name,
    tinyImage: imageUrl('cover_small', g.cover?.image_id),
    platforms: platformsOf(g),
    year: yearOf(g.first_release_date),
    steamAppid: steamAppidOf(g),
  }));
}

// The panel's landscape hero takes artwork between 4:3-ish and 2:1: IGDB's artworks also hold square logos and ultra-wide banners.
const isLandscape = (a) => a.image_id && a.width / a.height >= 1.3 && a.width / a.height <= 2;

// The hero: key art, else the first screenshot, else the portrait cover (shown contained).
// A record cached before artworks were requested has none, so it falls back to the screenshot until refreshed.
function heroOf(raw) {
  const art = (raw.artworks ?? []).find(isLandscape);
  if (art) return { url: imageUrl('1080p', art.image_id), isCover: false };
  const shot = raw.screenshots?.find((s) => s.image_id);
  if (shot) return { url: imageUrl('1080p', shot.image_id), isCover: false, screenshotId: shot.image_id };
  const cover = imageUrl('cover_big', raw.cover?.image_id);
  return { url: cover, isCover: !!cover };
}

function extractIgdbGame(raw) {
  const hero = heroOf(raw);
  const companies = (role) =>
    (raw.involved_companies ?? []).filter((c) => c[role] && c.company?.name).map((c) => c.company.name);
  return {
    id: raw.id,
    name: raw.name,
    url: raw.url ?? null,
    summary: raw.summary ?? null,
    cover: imageUrl('cover_big', raw.cover?.image_id),
    banner: hero.url,
    bannerIsCover: hero.isCover,
    platforms: platformsOf(raw),
    releaseDate: raw.first_release_date ? new Date(raw.first_release_date * 1000).toISOString().slice(0, 10) : null,
    developers: companies('developer'),
    publishers: companies('publisher'),
    genres: (raw.genres ?? []).map((g) => g.name).filter(Boolean),
    rating: raw.total_rating_count ? { score: Math.round(raw.total_rating), count: raw.total_rating_count } : null,
    // Steam's screenshot shape, so the panel's media code takes either; not the one already the banner.
    screenshots: (raw.screenshots ?? [])
      .filter((s) => s.image_id && s.image_id !== hero.screenshotId)
      .map((s) => ({
        id: s.image_id,
        thumbnail: imageUrl('screenshot_big', s.image_id),
        full: imageUrl('1080p', s.image_id),
      })),
    videos: (raw.videos ?? [])
      .filter((v) => v.video_id)
      .map((v) => ({
        id: v.id,
        youtubeId: v.video_id,
        name: v.name ?? null,
        thumbnail: `https://i.ytimg.com/vi/${encodeURIComponent(v.video_id)}/hqdefault.jpg`,
      })),
    steamAppid: steamAppidOf(raw),
  };
}

// The game's details, or null for an id IGDB doesn't know.
async function getIgdbGame(id, { force = false } = {}) {
  const raw = await warnOnFailure(
    `game ${id}`,
    cachedFetch(`igdb:${id}`, { force }, async () => {
      const [game] = await query('game', `fields ${GAME_FIELDS}; where id = ${id};`);
      return game ? { value: game } : { value: null, ttlMs: MISS_CACHE_TTL_MS };
    }),
  );
  return raw && extractIgdbGame(raw);
}

function _resetIgdb() {
  token = null;
  warnedAt = 0;
  breaker._reset();
  retryingFetch.resetPause();
}

module.exports = {
  isIgdbConfigured,
  searchIgdb,
  getIgdbGame,
  extractIgdbGame,
  steamAppidOf,
  normalizeName,
  rankIgdbResults,
  mergeSearchResults,
  _resetIgdb,
};
