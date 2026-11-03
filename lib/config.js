'use strict';

const path = require('node:path');
// Priority: shell env > .env > default.env
try {
  process.loadEnvFile();
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
process.loadEnvFile(path.join(__dirname, '..', 'default.env'));

const LIBRARY_CACHE_TTL_MS = Number(process.env.LIBRARY_CACHE_TTL_MINUTES) * 60 * 1000;
const RESOLVE_CACHE_TTL_MS = Number(process.env.RESOLVE_CACHE_TTL_MINUTES) * 60 * 1000;
const RATING_CACHE_TTL_MS = Number(process.env.RATING_CACHE_TTL_MINUTES) * 60 * 1000;
const META_CACHE_TTL_MS = Number(process.env.META_CACHE_TTL_MINUTES) * 60 * 1000;
const SEARCH_CACHE_TTL_MS = Number(process.env.SEARCH_CACHE_TTL_MINUTES) * 60 * 1000;
const NEWS_CACHE_TTL_MS = Number(process.env.NEWS_CACHE_TTL_MINUTES) * 60 * 1000;
const BUNDLES_CACHE_TTL_MS = Number(process.env.BUNDLES_CACHE_TTL_MINUTES) * 60 * 1000;
const ITAD_ID_CACHE_TTL_MS = Number(process.env.ITAD_ID_CACHE_TTL_MINUTES) * 60 * 1000;
// Global outbound budgets — see lib/metrics.js's chargeBudget and default.env. Read here, with
// every other env-backed setting, rather than in lib/metrics.js directly: this module is what
// loads .env/default.env, and metrics.js can be required before it otherwise.
const OUTBOUND_HOURLY_MAX = Number(process.env.OUTBOUND_HOURLY_MAX);
const OUTBOUND_DAILY_MAX = Number(process.env.OUTBOUND_DAILY_MAX);
const OUTBOUND_CLIENT_SHARE_PERCENT = Number(process.env.OUTBOUND_CLIENT_SHARE_PERCENT);
// Per-entry overrides for cached misses — see setCache's `ttlMs` in lib/cache.js.
const MISS_CACHE_TTL_MS = Number(process.env.MISS_CACHE_TTL_MINUTES) * 60 * 1000;
const RESOLVE_MISS_CACHE_TTL_MS = Number(process.env.RESOLVE_MISS_CACHE_TTL_MINUTES) * 60 * 1000;
const STORE_MIN_INTERVAL_MS = Number(process.env.STORE_MIN_INTERVAL_MS);
const UPSTREAM_MIN_INTERVAL_MS = Number(process.env.UPSTREAM_MIN_INTERVAL_MS);
const STORE_DETAILS_MAX_PER_5_MIN = Number(process.env.STORE_DETAILS_MAX_PER_5_MIN);
// How long a Steam login session lasts before its cookie stops being honoured (lib/auth.js).
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_DAYS) * 24 * 60 * 60 * 1000;
// The address Steam sign-in vouches for (lib/auth.js); null turns sign-in off rather than trust the Host header.
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN).origin : null;
// How long a write waits for another connection's lock (lib/db.js, scripts/cache-clear.js) before `database is locked`.
const DB_BUSY_TIMEOUT_MS = 5000;
// How often expired cache rows (lib/cache.js) and sessions (lib/auth.js) are swept from db.sqlite.
const EXPIRED_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

// Env values are strings, and Express reads any string as an address list: "1" would trust no hop.
function parseTrustProxy(raw) {
  if (raw === 'true' || raw === 'false') return raw === 'true';
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}
const TRUST_PROXY = process.env.TRUST_PROXY && parseTrustProxy(process.env.TRUST_PROXY);

// Where a client on this machine reaches the server (the Vite dev proxy): a wildcard bind isn't an address.
function backendOrigin(host = process.env.HOST, port = process.env.PORT) {
  const local = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return `http://${local.includes(':') ? `[${local}]` : local}:${port}`;
}

module.exports = {
  backendOrigin,
  parseTrustProxy,
  TRUST_PROXY,
  DB_BUSY_TIMEOUT_MS,
  EXPIRED_SWEEP_INTERVAL_MS,
  LIBRARY_CACHE_TTL_MS,
  RESOLVE_CACHE_TTL_MS,
  RATING_CACHE_TTL_MS,
  META_CACHE_TTL_MS,
  SEARCH_CACHE_TTL_MS,
  NEWS_CACHE_TTL_MS,
  BUNDLES_CACHE_TTL_MS,
  ITAD_ID_CACHE_TTL_MS,
  MISS_CACHE_TTL_MS,
  RESOLVE_MISS_CACHE_TTL_MS,
  OUTBOUND_HOURLY_MAX,
  OUTBOUND_DAILY_MAX,
  OUTBOUND_CLIENT_SHARE_PERCENT,
  SESSION_TTL_MS,
  PUBLIC_ORIGIN,
  STORE_MIN_INTERVAL_MS,
  UPSTREAM_MIN_INTERVAL_MS,
  STORE_DETAILS_MAX_PER_5_MIN,
};
