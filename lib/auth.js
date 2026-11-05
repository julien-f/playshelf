'use strict';

const crypto = require('node:crypto');
const { db } = require('./db');
const { SESSION_TTL_MS, EXPIRED_SWEEP_INTERVAL_MS } = require('./config');
const { createTrackedFetch } = require('./metrics');

const openidFetch = createTrackedFetch('steam-openid');

const STEAM_OPENID_URL = 'https://steamcommunity.com/openid/login';
const CLAIMED_ID_RE = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

const SESSION_COOKIE = 'sid';
const STATE_COOKIE = 'steam_login_state';

// ── Cookies ───────────────────────────────────────────────────────────────────
// No cookie-parsing dependency — the format needed here (read a plain name=value pair, write one
// back with a handful of attributes) is small enough not to warrant one.

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const name = part.slice(0, i).trim();
    if (!name) continue;
    // Another app's cookie on the same host may not be URI-encoded (`other=100%`).
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {}
  }
  return out;
}

// `secure` is left to the caller (server.js knows the request's actual scheme) rather than
// hardcoded true — a hardcoded Secure attribute would silently drop every cookie in local dev,
// which normally runs over plain http.
function serializeCookie(name, value, { maxAgeMs, secure } = {}) {
  let str = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
  if (secure) str += '; Secure';
  str += value === '' ? '; Max-Age=0' : `; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
  return str;
}

// ── Steam OpenID 2.0 ──────────────────────────────────────────────────────────
// Steam has no OAuth2 for third parties — OpenID 2.0 against steamcommunity.com/openid is the
// sanctioned way to authenticate a user (see steamcommunity.com/dev). `state` guards against
// login CSRF (forcing a victim's session to log in as an attacker's Steam account): it's minted
// here, round-tripped through Steam untouched inside `openid.return_to`, and checked against a
// short-lived cookie on the way back — Steam's own signature (verified below) already protects
// the identity assertion itself, this only protects which browser session it lands in.

const returnToFor = (origin, state) => `${origin}/auth/steam/callback?state=${encodeURIComponent(state)}`;

// OpenID 2.0 §10.1: the fields a positive assertion must sign.
const REQUIRED_SIGNED = ['op_endpoint', 'return_to', 'response_nonce', 'assoc_handle', 'claimed_id', 'identity'];

function buildLoginUrl(origin, state) {
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnToFor(origin, state),
    'openid.realm': origin,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  return `${STEAM_OPENID_URL}?${params.toString()}`;
}

// OpenID 2.0 §11.3: an assertion counts once and only while fresh, so a logged callback URL can't
// sign anyone in later. A nonce is kept past its 5-minute window so one dated ahead of this clock
// still can't be replayed once forgotten.
const NONCE_MAX_AGE_MS = 5 * 60 * 1000;
const NONCE_KEEP_MS = 2 * NONCE_MAX_AGE_MS;
const NONCE_MAX_KEPT = 10_000;
const NONCE_TIME_RE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)/;
const usedNonces = new Map(); // nonce → when it can be forgotten, in insertion order

// Whether `nonce` is well formed, fresh and not used yet.
function nonceUsable(nonce) {
  if (typeof nonce !== 'string') return false;
  const issuedAt = Date.parse(nonce.match(NONCE_TIME_RE)?.[1]);
  return Math.abs(Date.now() - issuedAt) < NONCE_MAX_AGE_MS && !usedNonces.has(nonce);
}

// Records a nonce Steam confirmed; false when a concurrent request already claimed it, or when
// the table is full: forgetting a live nonce would let it be replayed.
function claimNonce(nonce) {
  const now = Date.now();
  for (const [used, forgetAt] of usedNonces) if (forgetAt <= now) usedNonces.delete(used);
  if (usedNonces.has(nonce)) return false;
  if (usedNonces.size >= NONCE_MAX_KEPT) {
    console.warn(
      `[auth] sign-in refused: ${NONCE_MAX_KEPT} nonces already used in the last ${NONCE_KEEP_MS / 60_000} min`,
    );
    return false;
  }
  usedNonces.set(nonce, now + NONCE_KEEP_MS);
  return true;
}

// Verifies the callback's signed assertion by echoing every openid.* param back to Steam with
// openid.mode=check_authentication (the OpenID 2.0 indirect-verification dance) — never trust
// the query params on their own, since anyone can craft a claimed_id in a plain GET request.
// Steam only vouches for the signature, so the assertion must also be for this login: signed
// return_to equal to the one buildLoginUrl sent for `origin` and `state`, or any site using Steam
// sign-in could replay its visitors' assertions here (OpenID 2.0 §11.1).
// Returns the asserted steamid64, or null if the assertion doesn't check out.
async function verifySteamAssertion(query, { origin, state }) {
  const claimedId = query['openid.claimed_id'];
  if (typeof claimedId !== 'string') return null;
  const match = claimedId.match(CLAIMED_ID_RE);
  if (!match) return null;
  if (query['openid.op_endpoint'] !== STEAM_OPENID_URL) return null;
  if (query['openid.return_to'] !== returnToFor(origin, state)) return null;
  const signed = typeof query['openid.signed'] === 'string' ? query['openid.signed'].split(',') : [];
  if (!REQUIRED_SIGNED.every((field) => signed.includes(field))) return null;
  const nonce = query['openid.response_nonce'];
  // A drifting clock refuses every sign-in this way, so say why.
  if (!nonceUsable(nonce)) {
    console.warn('[auth] sign-in refused: response_nonce missing, reused, or over 5 min from this clock');
    return null;
  }

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key.startsWith('openid.') && typeof value === 'string') params.set(key, value);
  }
  params.set('openid.mode', 'check_authentication');

  const res = await openidFetch('verify', STEAM_OPENID_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) return null;
  const body = await res.text();
  if (!/is_valid\s*:\s*true/.test(body)) return null;
  // Only once Steam confirmed it, so unverified nonces can't crowd real ones out of usedNonces.
  if (!claimNonce(nonce)) return null;

  return match[1];
}

// ── Users & sessions (db.sqlite) ─────────────────────────────────────────────

const stmts = {
  upsertUser: db.prepare(`
    INSERT INTO users (steamid, created_at, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(steamid) DO UPDATE SET updated_at = excluded.updated_at
  `),
  getUserPrefs: db.prepare('SELECT key, value, updated_at FROM user_prefs WHERE steamid = ?'),
  setUserPref: db.prepare('INSERT OR REPLACE INTO user_prefs (steamid, key, value, updated_at) VALUES (?, ?, ?, ?)'),
  otherPrefsBytes: db.prepare(
    'SELECT COALESCE(SUM(LENGTH(CAST(value AS BLOB))), 0) AS n FROM user_prefs WHERE steamid = ? AND key != ?',
  ),
  insertSession: db.prepare('INSERT INTO sessions (id, steamid, expires_at) VALUES (?, ?, ?)'),
  getSession: db.prepare('SELECT steamid, expires_at FROM sessions WHERE id = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
  // An UPDATE, never an upsert: a session signed out or expired meanwhile stays gone.
  renewSession: db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ? AND expires_at > ? AND expires_at < ?'),
  deleteExpiredSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
};

// Evict sessions that expired while the server was stopped, then hourly: getSessionUser only
// evicts the session it's asked for, so an abandoned one would otherwise stay until restart.
const sweepExpiredSessions = () => stmts.deleteExpiredSessions.run(Date.now());
sweepExpiredSessions();
setInterval(sweepExpiredSessions, EXPIRED_SWEEP_INTERVAL_MS).unref();

function upsertUser(steamid) {
  const now = Date.now();
  stmts.upsertUser.run(steamid, now, now);
}

// db.sqlite keys a session by this hash, so a copy of it holds no usable session id.
const sessionKey = (sessionId) => crypto.createHash('sha256').update(sessionId).digest('hex');

function createSession(steamid) {
  const id = crypto.randomBytes(32).toString('hex');
  stmts.insertSession.run(sessionKey(id), steamid, Date.now() + SESSION_TTL_MS);
  return id;
}

// Pushes a session's expiry back to a full SESSION_TTL_MS once less than half is left, so a
// visit at least every half-lifetime keeps it alive; returns whether it did (its cookie needs re-sending).
function touchSession(sessionId) {
  if (!sessionId) return false;
  const now = Date.now();
  return stmts.renewSession.run(now + SESSION_TTL_MS, sessionKey(sessionId), now, now + SESSION_TTL_MS / 2).changes > 0;
}

function destroySession(sessionId) {
  if (sessionId) stmts.deleteSession.run(sessionKey(sessionId));
}

// Every key/value this user has saved, each with the time it was last written — the frontend
// (authStore.ts) merges this against its own local copy by last-write-wins per key, not by
// treating the whole set as one blob (see setUserPref below).
function getUserPrefs(steamid) {
  const prefs = {};
  for (const { key, value, updated_at } of stmts.getUserPrefs.all(steamid)) {
    prefs[key] = { value: JSON.parse(value), updatedAt: updated_at };
  }
  return prefs;
}

// Undefined for a missing, expired, or otherwise unknown session — callers treat that as
// logged-out rather than an error.
function getSessionUser(sessionId) {
  if (!sessionId) return undefined;
  const key = sessionKey(sessionId);
  const session = stmts.getSession.get(key);
  if (!session) return undefined;
  if (session.expires_at < Date.now()) {
    stmts.deleteSession.run(key);
    return undefined;
  }
  return { steamid: session.steamid, prefs: getUserPrefs(session.steamid) };
}

// Sets one key unconditionally — a write always overwrites whatever's already stored. Prefs still
// carry `updatedAt` (the caller's clock), but it's no longer a write guard: every key merges
// last-write-wins client-side (authStore.ts), so by the time a PUT lands here the client has
// already decided this write should win.
function setUserPref(steamid, key, value, updatedAt) {
  stmts.setUserPref.run(steamid, key, JSON.stringify(value), updatedAt);
}

// public/syncedPrefKeys.ts's list, which the frontend filters its pushes on; test/server.test.js
// checks the two match.
const SYNCED_PREF_KEYS = new Set([
  'myAccount',
  'currentAccount',
  'recentAccounts',
  'recentGames',
  'gameStatuses',
  'bundleSnapshots',
  'region',
  'lists',
  'folders',
  'listViews',
  'ownedListView',
  'wishlistListView',
  'bundleListView',
  'pickBundleListView',
  'recentListView',
  'compareListView',
  'sharedListView',
  'creatorListView',
  'gamePassListView',
  'bundlesBrowseView',
]);
const RANKING_KEY_RE = /^ranking:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isSyncedPrefKey = (key) => SYNCED_PREF_KEYS.has(key) || RANKING_KEY_RE.test(key);

// Bounds one account's stored prefs, since ranking:<list id> keys are unbounded in number.
const PREFS_MAX_BYTES = 2 * 1024 * 1024;

// Whether storing `value` under `key` keeps the account within PREFS_MAX_BYTES, in UTF-8 bytes as the body limit counts.
function prefFits(steamid, key, value) {
  return stmts.otherPrefsBytes.get(steamid, key).n + Buffer.byteLength(JSON.stringify(value)) <= PREFS_MAX_BYTES;
}

module.exports = {
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
  getUserPrefs,
  setUserPref,
  SYNCED_PREF_KEYS,
  isSyncedPrefKey,
  PREFS_MAX_BYTES,
  prefFits,
  _resetNonces: () => usedNonces.clear(),
};
