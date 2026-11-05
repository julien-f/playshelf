'use strict';

// Force the in-memory DB regardless of how this file is invoked — see steam.test.js's own
// comment on why this must be set before requiring lib/db (via lib/auth).
process.env.DB_FILE = '';
// 0 = no ceiling: the nonce-table test confirms 10,000 sign-ins, past the default hourly budget.
process.env.OUTBOUND_HOURLY_MAX = '0';
process.env.OUTBOUND_DAILY_MAX = '0';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { db } = require('../lib/db');
const { freshNonce } = require('./openidNonce');
const {
  parseCookies,
  serializeCookie,
  buildLoginUrl,
  verifySteamAssertion,
  upsertUser,
  createSession,
  destroySession,
  getSessionUser,
  touchSession,
  setUserPref,
  _resetNonces,
} = require('../lib/auth');

const VALID_CLAIMED_ID = 'https://steamcommunity.com/openid/id/76561198000000001';

// ── cookies ───────────────────────────────────────────────────────────────────

test('parseCookies: parses several name=value pairs', () => {
  assert.deepEqual(parseCookies('sid=abc; steam_login_state=xyz'), { sid: 'abc', steam_login_state: 'xyz' });
});

test('parseCookies: decodes percent-encoded values', () => {
  assert.deepEqual(parseCookies('k=a%20b'), { k: 'a b' });
});

test('parseCookies: skips a pair whose value does not decode, keeping the rest', () => {
  assert.deepEqual(parseCookies('other=100%; sid=abc'), { sid: 'abc' });
});

test('parseCookies: empty/missing header yields no cookies', () => {
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(''), {});
});

test('serializeCookie: sets Max-Age from maxAgeMs and HttpOnly/SameSite always', () => {
  const str = serializeCookie('sid', 'abc', { maxAgeMs: 5000 });
  assert.match(str, /^sid=abc; Path=\/; HttpOnly; SameSite=Lax; Max-Age=5$/);
});

test('serializeCookie: adds Secure only when asked', () => {
  assert.match(serializeCookie('sid', 'abc', { maxAgeMs: 1000, secure: true }), /; Secure/);
  assert.doesNotMatch(serializeCookie('sid', 'abc', { maxAgeMs: 1000 }), /; Secure/);
});

test('serializeCookie: an empty value clears the cookie via Max-Age=0', () => {
  assert.match(serializeCookie('sid', '', {}), /Max-Age=0$/);
});

// ── OpenID login URL ──────────────────────────────────────────────────────────

test('buildLoginUrl: points at Steam with the realm, return_to and state set', () => {
  const url = new URL(buildLoginUrl('https://example.com', 'the-state'));
  assert.equal(url.origin, 'https://steamcommunity.com');
  assert.equal(url.searchParams.get('openid.realm'), 'https://example.com');
  assert.equal(url.searchParams.get('openid.mode'), 'checkid_setup');
  const returnTo = new URL(url.searchParams.get('openid.return_to'));
  assert.equal(returnTo.pathname, '/auth/steam/callback');
  assert.equal(returnTo.searchParams.get('state'), 'the-state');
});

// ── verifySteamAssertion ──────────────────────────────────────────────────────

const ORIGIN = 'https://example.com';
const STATE = 'the-state';

// A positive assertion as Steam returns it for a login this app started with ORIGIN and STATE.
function assertion(overrides = {}) {
  return {
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'id_res',
    'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
    'openid.claimed_id': VALID_CLAIMED_ID,
    'openid.identity': VALID_CLAIMED_ID,
    'openid.return_to': `${ORIGIN}/auth/steam/callback?state=${STATE}`,
    'openid.response_nonce': freshNonce(),
    'openid.assoc_handle': '1234567890',
    'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
    'openid.sig': 'abc',
    ...overrides,
  };
}
const verify = (query) => verifySteamAssertion(query, { origin: ORIGIN, state: STATE });

beforeEach(() => _resetNonces());

test('verifySteamAssertion: returns the steamid64 when Steam confirms the assertion', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, text: async () => 'ns:...\nis_valid:true\n' }));
  assert.equal(await verify(assertion()), '76561198000000001');
});

test('verifySteamAssertion: forwards every openid.* param with mode overridden to check_authentication', async (t) => {
  let sentBody;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    sentBody = new URLSearchParams(opts.body);
    return { ok: true, text: async () => 'is_valid:true' };
  });
  await verify({ ...assertion(), unrelated: 'drop-me' });
  assert.equal(sentBody.get('openid.mode'), 'check_authentication');
  assert.equal(sentBody.get('openid.sig'), 'abc');
  assert.equal(sentBody.has('unrelated'), false);
});

test('verifySteamAssertion: null when Steam says the assertion is invalid', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, text: async () => 'is_valid:false' }));
  assert.equal(await verify(assertion()), null);
});

test('verifySteamAssertion: null when the verification request itself fails', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 500 }));
  assert.equal(await verify(assertion()), null);
});

// Steam's check_authentication only vouches for the signature, so a valid assertion minted for
// another site, or for another login on this one, must be rejected here (OpenID 2.0 §11.1).
for (const [why, overrides] of [
  ['a malformed claimed_id', { 'openid.claimed_id': 'https://evil.example/not-steam' }],
  ['a missing claimed_id', { 'openid.claimed_id': undefined }],
  ["another site's return_to", { 'openid.return_to': 'https://evil.example/auth/steam/callback?state=x' }],
  ["another login's state", { 'openid.return_to': `${ORIGIN}/auth/steam/callback?state=other` }],
  ['a foreign op_endpoint', { 'openid.op_endpoint': 'https://evil.example/openid/login' }],
  ['an unsigned return_to', { 'openid.signed': 'signed,op_endpoint,claimed_id,identity,response_nonce,assoc_handle' }],
  ['a missing signed list', { 'openid.signed': undefined }],
  ['a nonce older than 5 minutes', { 'openid.response_nonce': freshNonce(Date.now() - 6 * 60 * 1000) }],
  ['a nonce without a timestamp', { 'openid.response_nonce': 'not-a-nonce' }],
  ['a missing nonce', { 'openid.response_nonce': undefined }],
]) {
  test(`verifySteamAssertion: null for ${why}, without even calling Steam`, async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({ ok: true, text: async () => 'is_valid:true' }));
    assert.equal(await verify(assertion(overrides)), null);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
}

// OpenID 2.0 §11.3: a logged assertion replayed later must not sign anyone in again.
test('verifySteamAssertion: null for a nonce already used, without calling Steam again', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({ ok: true, text: async () => 'is_valid:true' }));
  const query = assertion();
  assert.equal(await verify(query), '76561198000000001');
  assert.equal(await verify(query), null);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('verifySteamAssertion: a nonce stays used for as long as its age lets it pass', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-10T00:00:00Z') });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({ ok: true, text: async () => 'is_valid:true' }));
  const query = assertion();
  assert.equal(await verify(query), '76561198000000001');
  t.mock.timers.tick(4 * 60 * 1000);
  assert.equal(await verify(query), null);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('verifySteamAssertion: a nonce Steam did not confirm stays usable', async (t) => {
  const query = assertion();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 500 }));
  assert.equal(await verify(query), null);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, text: async () => 'is_valid:false' }));
  assert.equal(await verify(query), null);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, text: async () => 'is_valid:true' }));
  assert.equal(await verify(query), '76561198000000001');
});

test('verifySteamAssertion: of two concurrent replays, only one signs in', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, text: async () => 'is_valid:true' }));
  const query = assertion();
  const results = await Promise.all([verify(query), verify(query)]);
  assert.deepEqual(results.sort(), ['76561198000000001', null]);
});

// A nonce is remembered for twice its window, so one dated as far ahead as allowed is still
// remembered, or already stale, at any later replay.
test('verifySteamAssertion: a nonce dated ahead of this clock is never accepted twice', async (t) => {
  const now = Math.floor(Date.now() / 1000) * 1000; // whole seconds, as nonces
  t.mock.timers.enable({ apis: ['Date'], now });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, text: async () => 'is_valid:true' }));
  assert.equal(await verify(assertion({ 'openid.response_nonce': freshNonce(now + 5 * 60 * 1000) })), null);
  const query = assertion({ 'openid.response_nonce': freshNonce(now + 5 * 60 * 1000 - 1000) });
  assert.equal(await verify(query), '76561198000000001');
  for (const step of [9 * 60 * 1000, 59 * 1000, 1000]) {
    t.mock.timers.tick(step);
    assert.equal(await verify(query), null);
  }
});

// A full table refuses new sign-ins rather than forgetting a nonce still inside its window.
test('verifySteamAssertion: a full nonce table never lets a live nonce be replayed', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, text: async () => 'is_valid:true' }));
  const warnMock = t.mock.method(console, 'warn', () => {});
  const victim = assertion();
  assert.equal(await verify(victim), '76561198000000001');
  for (let i = 1; i < 10_000; i++) await verify(assertion());
  assert.equal(await verify(assertion()), null, 'refused while full');
  assert.equal(await verify(victim), null, 'the first nonce is still remembered');
  assert.ok(warnMock.mock.calls.some((c) => String(c.arguments[0]).startsWith('[auth]')));
});

// ── users & sessions ──────────────────────────────────────────────────────────

test('createSession + getSessionUser: round-trips to the steamid and its (initially empty) prefs', () => {
  const steamid = '76561198000000101';
  upsertUser(steamid);
  const sessionId = createSession(steamid);
  assert.deepEqual(getSessionUser(sessionId), { steamid, prefs: {} });
});

test('createSession: db.sqlite holds only a SHA-256 of the session id, which does not sign anyone in', () => {
  const steamid = '76561198000000109';
  upsertUser(steamid);
  const sessionId = createSession(steamid);
  const stored = db.prepare('SELECT id FROM sessions WHERE steamid = ?').all(steamid);
  assert.deepEqual(
    stored.map((r) => r.id),
    [crypto.createHash('sha256').update(sessionId).digest('hex')],
  );
  assert.equal(getSessionUser(stored[0].id), undefined);
  destroySession(sessionId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE steamid = ?').get(steamid).n, 0);
});

test('getSessionUser: undefined for an unknown or missing session id', () => {
  assert.equal(getSessionUser('does-not-exist'), undefined);
  assert.equal(getSessionUser(undefined), undefined);
});

test('touchSession: renews a session past half its lifetime, not before', (t) => {
  const start = Date.parse('2026-10-10T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const steamid = '76561198000000110';
  upsertUser(steamid);
  const sessionId = createSession(steamid);
  const expiresAt = () => db.prepare('SELECT expires_at FROM sessions WHERE steamid = ?').get(steamid).expires_at;
  const ttl = expiresAt() - start;

  t.mock.timers.tick(ttl / 2 - 1000);
  assert.equal(touchSession(sessionId), false);
  assert.equal(expiresAt(), start + ttl);

  t.mock.timers.tick(2000);
  assert.equal(touchSession(sessionId), true);
  assert.equal(expiresAt(), Date.now() + ttl);
  // Past the original expiry, the renewed session still signs in.
  t.mock.timers.tick(ttl / 2 + 1000);
  assert.equal(getSessionUser(sessionId)?.steamid, steamid);
});

test('touchSession: never revives an expired, signed-out or unknown session', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-10T00:00:00Z') });
  const steamid = '76561198000000111';
  upsertUser(steamid);
  const expired = createSession(steamid);
  const ttl = db.prepare('SELECT expires_at FROM sessions WHERE steamid = ?').get(steamid).expires_at - Date.now();
  t.mock.timers.tick(ttl + 1000);
  assert.equal(touchSession(expired), false);
  assert.equal(getSessionUser(expired), undefined);

  const signedOut = createSession(steamid);
  destroySession(signedOut);
  assert.equal(touchSession(signedOut), false);
  assert.equal(getSessionUser(signedOut), undefined);

  assert.equal(touchSession('does-not-exist'), false);
  assert.equal(touchSession(undefined), false);
});

test('destroySession: the session stops resolving to a user afterwards', () => {
  const steamid = '76561198000000102';
  upsertUser(steamid);
  const sessionId = createSession(steamid);
  destroySession(sessionId);
  assert.equal(getSessionUser(sessionId), undefined);
});

test('setUserPref: sets one key with its updatedAt, visible through a fresh session lookup', () => {
  const steamid = '76561198000000103';
  const t1 = 1000;
  upsertUser(steamid);
  setUserPref(steamid, 'myAccount', { id: steamid }, t1);
  const sessionId = createSession(steamid);
  assert.deepEqual(getSessionUser(sessionId).prefs, { myAccount: { value: { id: steamid }, updatedAt: t1 } });
});

test('setUserPref: merges into existing prefs rather than replacing the whole set', () => {
  const steamid = '76561198000000106';
  upsertUser(steamid);
  setUserPref(steamid, 'a', 1, 1000);
  setUserPref(steamid, 'b', 2, 1000);
  const sessionId = createSession(steamid);
  assert.deepEqual(getSessionUser(sessionId).prefs, {
    a: { value: 1, updatedAt: 1000 },
    b: { value: 2, updatedAt: 1000 },
  });
});

test('setUserPref: a write always replaces whatever was there, regardless of updatedAt ordering', () => {
  const steamid = '76561198000000107';
  upsertUser(steamid);
  setUserPref(steamid, 'a', 'old', 1000);
  setUserPref(steamid, 'a', 'new', 2000);
  const sessionId = createSession(steamid);
  assert.deepEqual(getSessionUser(sessionId).prefs.a, { value: 'new', updatedAt: 2000 });
});

test('setUserPref: an "older" updatedAt still overwrites — the server no longer guards on it', () => {
  const steamid = '76561198000000108';
  upsertUser(steamid);
  setUserPref(steamid, 'a', 'new', 2000);
  setUserPref(steamid, 'a', 'later-but-lower-updatedAt', 1000);
  const sessionId = createSession(steamid);
  assert.deepEqual(getSessionUser(sessionId).prefs.a, { value: 'later-but-lower-updatedAt', updatedAt: 1000 });
});

test("upsertUser: logging in again does not reset that user's prefs", () => {
  const steamid = '76561198000000104';
  upsertUser(steamid);
  setUserPref(steamid, 'keep', 'me', 1000);
  upsertUser(steamid);
  const sessionId = createSession(steamid);
  assert.deepEqual(getSessionUser(sessionId).prefs.keep, { value: 'me', updatedAt: 1000 });
});
