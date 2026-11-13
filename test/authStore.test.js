'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { until } = require('./until');

function makeMemoryLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

function withFetch(t, handler) {
  const restore = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = restore;
  });
}

beforeEach(() => {
  global.localStorage = makeMemoryLocalStorage();
  delete require.cache[require.resolve('../public/prefs.ts')];
  delete require.cache[require.resolve('../public/listsStore.ts')];
  delete require.cache[require.resolve('../public/accountsStore.ts')];
  delete require.cache[require.resolve('../public/accountData.ts')];
  delete require.cache[require.resolve('../public/authStore.ts')];
  require('../public/accountsStore.ts').setAccountOverride(null);
  // require.cache deletion above doesn't reach signedInSteamid (module-level state) — see
  // _resetPrefsState's own comment in prefs.ts.
  require('../public/prefs.ts')._resetPrefsState();
});

function auth() {
  return require('../public/authStore.ts');
}
function accounts() {
  return require('../public/accountsStore.ts');
}
function prefs() {
  return require('../public/prefs.ts');
}

function makeAccount(id) {
  return { id, members: [id], rawInputs: [id] };
}

// Same shape resolveAccountSlot's own tests use (test/accountData.test.js) — a single member
// resolving through /api/common-games (owned) and /api/wishlist.
function mockResolveFetch(steamid = '76561198000000201') {
  return async (url) => {
    if (url === '/api/common-games') {
      return {
        ok: true,
        json: async () => ({
          games: [],
          players: [
            {
              steamid,
              personaname: 'Alice',
              avatarmedium: 'https://x/a.jpg',
              profileurl: 'https://steamcommunity.com/id/alice/',
            },
          ],
          playtime: {},
          lastPlayed: {},
        }),
      };
    }
    return { ok: true, json: async () => ({ items: [] }) };
  };
}

// ── syncPrefsWithServer ───────────────────────────────────────────────────────

const STEAMID = '76561198000000301';

// Matches authStore.ts's own SYNCED_FLAG_PREFIX format — sets up the "this device has already
// synced with this account before" state so a test can exercise ongoing (not first-sync) merges.
function markAlreadySynced(steamid = STEAMID) {
  global.localStorage.setItem(`steam.isonoe.net:prefs-synced:${steamid}`, '1');
}

// -- first sync (never synced with this account on this browser before) --

test('syncPrefsWithServer (first sync): a local-only key is pushed to the server, nothing adopted', async (t) => {
  prefs().setPref('region', 'DE');
  let sent;
  withFetch(t, async (url, opts) => {
    sent = { url, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ ok: true }) };
  });

  const adopted = await auth().syncPrefsWithServer(STEAMID, {});

  assert.equal(adopted, false);
  assert.equal(sent.url, '/api/me/prefs/region');
  assert.equal(sent.body.value, 'DE');
});

test("syncPrefsWithServer: a local key the server never syncs isn't pushed", async (t) => {
  prefs().setPref('someOldKey', 1);
  const urls = [];
  withFetch(t, async (url) => {
    urls.push(url);
    return { ok: true, json: async () => ({ ok: true }) };
  });

  await auth().syncPrefsWithServer(STEAMID, {});

  assert.deepEqual(urls, []);
});

test('syncPrefsWithServer (first sync): a server-only key is adopted locally', async (t) => {
  withFetch(t, async () => {
    throw new Error('should not push anything');
  });

  const adopted = await auth().syncPrefsWithServer(STEAMID, { region: { value: 'GB', updatedAt: 500 } });

  assert.equal(adopted, true);
  assert.deepEqual(prefs().getAllPrefEntries().region, { value: 'GB', updatedAt: 500 });
});

test('syncPrefsWithServer (first sync): server always wins a key both sides have, even if local is newer', async (t) => {
  prefs().setPref('region', 'DE'); // updatedAt = Date.now(), well after 500 — must not matter here
  let pushed = false;
  withFetch(t, async () => {
    pushed = true;
    return { ok: true, json: async () => ({ ok: true }) };
  });

  const adopted = await auth().syncPrefsWithServer(STEAMID, { region: { value: 'GB', updatedAt: 500 } });

  assert.equal(adopted, true, "server's value must be adopted, not the newer-but-untrusted local one");
  assert.equal(pushed, false, 'local must never push over an existing server key on first sync');
  assert.equal(prefs().getPref('region'), 'GB');
});

test('syncPrefsWithServer (first sync): marks this device as synced, so a later call uses ongoing rules', async (t) => {
  withFetch(t, async () => ({ ok: true, json: async () => ({ ok: true }) }));
  await auth().syncPrefsWithServer(STEAMID, {});
  assert.equal(global.localStorage.getItem(`steam.isonoe.net:prefs-synced:${STEAMID}`), '1');
});

test("syncPrefsWithServer (first sync): an adoption storage can't keep leaves the device unsynced, so its stale value can't later win", async (t) => {
  withFetch(t, async () => ({ ok: true, json: async () => ({ ok: true }) }));
  t.mock.method(console, 'warn', () => {});
  const setItem = global.localStorage.setItem;
  global.localStorage.setItem = (k, v) => {
    if (k.includes('prefs-synced')) setItem(k, v);
    else throw new Error('QuotaExceededError');
  };
  await auth().syncPrefsWithServer(STEAMID, { region: { value: 'GB', updatedAt: 500 } });
  assert.equal(global.localStorage.getItem(`steam.isonoe.net:prefs-synced:${STEAMID}`), null);
});

test("syncPrefsWithServer (first sync): one adoption kept and another not doesn't ask for a reload", async (t) => {
  withFetch(t, async () => ({ ok: true, json: async () => ({ ok: true }) }));
  t.mock.method(console, 'warn', () => {});
  const setItem = global.localStorage.setItem;
  global.localStorage.setItem = (k, v) => {
    if (String(v).includes('"lists"')) throw new Error('QuotaExceededError');
    setItem(k, v);
  };
  const adopted = await auth().syncPrefsWithServer(STEAMID, {
    region: { value: 'GB', updatedAt: 500 },
    lists: { value: [], updatedAt: 500 },
  });
  assert.equal(prefs().getPref('region'), 'GB');
  assert.equal(adopted, false);
});

// -- ongoing sync (this device has already synced with this account before) --

test('syncPrefsWithServer (ongoing): local newer than server for the same key pushes, does not adopt', async (t) => {
  markAlreadySynced();
  prefs().setPref('region', 'DE'); // updatedAt = Date.now(), well after 500
  let pushed = false;
  withFetch(t, async () => {
    pushed = true;
    return { ok: true, json: async () => ({ ok: true }) };
  });

  const adopted = await auth().syncPrefsWithServer(STEAMID, { region: { value: 'GB', updatedAt: 500 } });

  assert.equal(adopted, false);
  assert.equal(pushed, true);
  assert.equal(prefs().getPref('region'), 'DE');
});

test('syncPrefsWithServer (ongoing): server newer than local for the same key adopts, does not push', async (t) => {
  markAlreadySynced();
  const entries = { schemaVersion: 2, region: { value: 'DE', updatedAt: 500 } };
  global.localStorage.setItem('steam.isonoe.net:prefs', JSON.stringify(entries));
  let pushed = false;
  withFetch(t, async () => {
    pushed = true;
    return { ok: true, json: async () => ({ ok: true }) };
  });

  const adopted = await auth().syncPrefsWithServer(STEAMID, { region: { value: 'GB', updatedAt: 999999999999 } });

  assert.equal(adopted, true);
  assert.equal(pushed, false);
  assert.equal(prefs().getPref('region'), 'GB');
});

test('syncPrefsWithServer (ongoing): equal timestamps on both sides are left alone', async (t) => {
  markAlreadySynced();
  const entries = { schemaVersion: 2, region: { value: 'DE', updatedAt: 500 } };
  global.localStorage.setItem('steam.isonoe.net:prefs', JSON.stringify(entries));
  let called = false;
  withFetch(t, async () => {
    called = true;
    return { ok: true, json: async () => ({ ok: true }) };
  });

  const adopted = await auth().syncPrefsWithServer(STEAMID, { region: { value: 'DE', updatedAt: 500 } });

  assert.equal(adopted, false);
  assert.equal(called, false);
});

test('syncPrefsWithServer (ongoing): a newer server entry with the same value takes its time without a reload', async (t) => {
  markAlreadySynced();
  const entries = { schemaVersion: 2, region: { value: 'DE', updatedAt: 500 } };
  global.localStorage.setItem('steam.isonoe.net:prefs', JSON.stringify(entries));
  withFetch(t, async () => ({ ok: true, json: async () => ({ ok: true }) }));

  const adopted = await auth().syncPrefsWithServer(STEAMID, { region: { value: 'DE', updatedAt: 900 } });

  assert.equal(adopted, false);
  assert.deepEqual(prefs().getAllPrefEntries().region, { value: 'DE', updatedAt: 900 });
});

test("syncPrefsWithServer (ongoing): a same-value adoption storage can't keep is warned, like any other", async (t) => {
  markAlreadySynced();
  const entries = { schemaVersion: 3, region: { value: 'DE', updatedAt: 500 } };
  global.localStorage.setItem('steam.isonoe.net:prefs', JSON.stringify(entries));
  global.localStorage.setItem = () => {
    throw new DOMException('full', 'QuotaExceededError');
  };
  const warn = t.mock.method(console, 'warn', () => {});
  withFetch(t, async () => ({ ok: true, json: async () => ({ ok: true }) }));

  const adopted = await auth().syncPrefsWithServer(STEAMID, { region: { value: 'DE', updatedAt: 900 } });

  assert.equal(adopted, false);
  assert.match(warn.mock.calls[0]?.arguments[0] ?? '', /^\[auth\]/);
});

// ── syncPrefsWithServer: table-view keys ─────────────────────────────────────────

test('syncPrefsWithServer (ongoing): a table-view key merges like any other: a newer server view is adopted', async (t) => {
  markAlreadySynced();
  const entries = {
    schemaVersion: 2,
    ownedListView: { value: { sorts: [{ key: 'name', dir: 'asc' }] }, updatedAt: 500 },
  };
  global.localStorage.setItem('steam.isonoe.net:prefs', JSON.stringify(entries));
  withFetch(t, async () => {
    throw new Error('should not push');
  });

  const adopted = await auth().syncPrefsWithServer(STEAMID, {
    ownedListView: { value: { sorts: [{ key: 'rating', dir: 'desc' }] }, updatedAt: 900 },
  });

  assert.equal(adopted, true);
  assert.deepEqual(prefs().getPref('ownedListView'), { sorts: [{ key: 'rating', dir: 'desc' }] });
});

test('syncPrefsWithServer (ongoing): a newer local table view is pushed', async (t) => {
  markAlreadySynced();
  const entries = { schemaVersion: 3, ownedListView: { value: { pageSize: 25 }, updatedAt: 900 } };
  global.localStorage.setItem('steam.isonoe.net:prefs', JSON.stringify(entries));
  const urls = [];
  withFetch(t, async (url) => {
    urls.push(url);
    return { ok: true, json: async () => ({ ok: true }) };
  });

  const adopted = await auth().syncPrefsWithServer(STEAMID, { ownedListView: { value: {}, updatedAt: 500 } });

  assert.equal(adopted, false);
  assert.deepEqual(urls, ['/api/me/prefs/ownedListView']);
});

test("syncPrefsWithServer: a table view stored before Save existed (v2) loses to the account's Saved one", async (t) => {
  markAlreadySynced();
  const entries = { schemaVersion: 2, ownedListView: { value: { pageSize: 25 }, updatedAt: 900 } };
  global.localStorage.setItem('steam.isonoe.net:prefs', JSON.stringify(entries));
  withFetch(t, async () => {
    throw new Error('should not push');
  });

  const adopted = await auth().syncPrefsWithServer(STEAMID, {
    ownedListView: { value: { pageSize: 100 }, updatedAt: 500 },
  });

  assert.equal(adopted, true);
  assert.deepEqual(prefs().getPref('ownedListView'), { pageSize: 100 });
});

// ── autoPopulateAccountFromLogin ─────────────────────────────────────────────

test('autoPopulateAccountFromLogin: sets both myAccount and currentAccount when neither is set', async (t) => {
  withFetch(t, mockResolveFetch());
  await auth().autoPopulateAccountFromLogin('76561198000000201');

  const { getMyAccount, getCurrentAccount } = accounts();
  assert.deepEqual(getMyAccount()?.members, ['76561198000000201']);
  assert.deepEqual(getCurrentAccount()?.members, ['76561198000000201']);
  assert.equal(getMyAccount()?.label, 'Alice');
});

test('autoPopulateAccountFromLogin: never overwrites an already-set myAccount', async (t) => {
  const existing = makeAccount('existing');
  accounts().setMyAccount(existing);
  withFetch(t, mockResolveFetch());

  await auth().autoPopulateAccountFromLogin('76561198000000201');

  assert.deepEqual(accounts().getMyAccount(), existing);
  assert.deepEqual(accounts().getCurrentAccount()?.members, ['76561198000000201']);
});

test('autoPopulateAccountFromLogin: never overwrites an already-set currentAccount', async (t) => {
  const existing = makeAccount('existing');
  accounts().setCurrentAccount(existing);
  withFetch(t, mockResolveFetch());

  await auth().autoPopulateAccountFromLogin('76561198000000201');

  assert.deepEqual(accounts().getCurrentAccount(), existing);
  assert.deepEqual(accounts().getMyAccount()?.members, ['76561198000000201']);
});

test('autoPopulateAccountFromLogin: makes no request once both are already set', async (t) => {
  const existing = makeAccount('existing');
  accounts().setMyAccount(existing);
  accounts().setCurrentAccount(existing);
  let called = false;
  withFetch(t, async () => {
    called = true;
    return { ok: true, json: async () => ({}) };
  });

  await auth().autoPopulateAccountFromLogin('76561198000000201');

  assert.equal(called, false);
});

test('autoPopulateAccountFromLogin: a failed resolve leaves both unset instead of throwing', async (t) => {
  t.mock.method(console, 'error', () => {});
  withFetch(t, async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }));

  await assert.doesNotReject(auth().autoPopulateAccountFromLogin('76561198000000201'));

  assert.equal(accounts().getMyAccount(), null);
  assert.equal(accounts().getCurrentAccount(), null);
});

// ── initAuth / signOut ───────────────────────────────────────────────────────

// window/location stand-ins: records whether the page reloaded.
function withBrowser(t) {
  const seen = { reloads: 0 };
  global.window = { dispatchEvent: () => {} };
  global.location = { reload: () => seen.reloads++ };
  // Enough for announce.ts's live region.
  global.document = { createElement: () => ({ setAttribute() {}, style: {} }), body: { append() {} } };
  t.after(() => {
    delete global.window;
    delete global.location;
    delete global.document;
  });
  return seen;
}

// Answers /api/me with `me`, prefs pushes and logout with ok, the rest as mockResolveFetch; records
// every request.
function mockMeFetch(t, me) {
  const calls = [];
  const resolve = mockResolveFetch(STEAMID);
  withFetch(t, async (url, opts = {}) => {
    calls.push({ url, method: opts.method ?? 'GET' });
    if (url === '/api/me') return { ok: true, json: async () => me };
    if (url.startsWith('/api/me/prefs/') || url === '/auth/logout')
      return { ok: true, json: async () => ({ ok: true }) };
    return resolve(url);
  });
  return calls;
}

const pushes = (calls) => calls.filter((c) => c.method === 'PUT');

// authStore.ts's module state survives the require.cache reset (see beforeEach), so a test needing
// a signed-out start after a signed-in one says so explicitly.
async function signIn(t) {
  mockMeFetch(t, { steamid: STEAMID, prefs: null });
  await auth().initAuth();
  assert.deepEqual(auth().getAuthUser(), { steamid: STEAMID });
}

test('initAuth (signed in): adopting server prefs reloads the page, and leaves the account to the reload', async (t) => {
  const seen = withBrowser(t);
  const calls = mockMeFetch(t, { steamid: STEAMID, prefs: { region: { value: 'GB', updatedAt: 500 } } });

  await auth().initAuth();

  assert.equal(seen.reloads, 1);
  assert.equal(prefs().getPref('region'), 'GB');
  assert.deepEqual(auth().getAuthUser(), { steamid: STEAMID });
  assert.ok(!calls.some((c) => c.url === '/api/common-games'), 'no account resolve before the reload');
});

test("initAuth (signed in): an adoption storage can't keep doesn't reload, so a full storage can't reload forever", async (t) => {
  const seen = withBrowser(t);
  global.localStorage.setItem = () => {
    throw new Error('QuotaExceededError');
  };
  const warn = t.mock.method(console, 'warn', () => {});
  mockMeFetch(t, { steamid: STEAMID, prefs: { region: { value: 'GB', updatedAt: 500 } } });

  await auth().initAuth();

  assert.equal(seen.reloads, 0);
  assert.ok(warn.mock.calls.some((c) => String(c.arguments[0]).startsWith('[auth]')));
});

test('initAuth (signed in): with nothing to adopt, fills in the account from the login and syncs later edits', async (t) => {
  const seen = withBrowser(t);
  const calls = mockMeFetch(t, { steamid: STEAMID, prefs: null });

  await auth().initAuth();

  assert.equal(seen.reloads, 0);
  assert.deepEqual(auth().getAuthUser(), { steamid: STEAMID });
  assert.deepEqual(accounts().getMyAccount()?.members, [STEAMID]);
  assert.deepEqual(accounts().getCurrentAccount()?.members, [STEAMID]);

  calls.length = 0;
  prefs().setPref('region', 'DE');
  assert.deepEqual(
    pushes(calls).map((c) => c.url),
    ['/api/me/prefs/region'],
  );
});

test('initAuth (signed in): a sign-in stars the signed-in account, replacing the ★ already set', async (t) => {
  withBrowser(t);
  const friend = makeAccount('friend');
  accounts().setMyAccount(friend);
  accounts().setCurrentAccount(friend);
  markAlreadySynced();
  mockMeFetch(t, { steamid: STEAMID, prefs: null });

  await auth().initAuth();

  assert.deepEqual(accounts().getMyAccount()?.members, [STEAMID]);
  assert.deepEqual(accounts().getCurrentAccount(), friend);
});

test('initAuth (signed in): a later load of the same sign-in keeps the ★ picked since', async (t) => {
  withBrowser(t);
  await signIn(t);
  const friend = makeAccount('friend');
  accounts().setMyAccount(friend);

  await auth().initAuth();

  assert.deepEqual(accounts().getMyAccount(), friend);
});

test('initAuth (signed out): no user, no reload, and edits stay local', async (t) => {
  const seen = withBrowser(t);
  await signIn(t);
  const calls = mockMeFetch(t, { steamid: null, prefs: null });

  await auth().initAuth();

  assert.equal(auth().getAuthUser(), null);
  assert.equal(seen.reloads, 0);
  prefs().setPref('region', 'DE');
  assert.deepEqual(pushes(calls), []);
});

test('initAuth: /api/me failing reads as signed out, without throwing', async (t) => {
  const seen = withBrowser(t);
  await signIn(t);
  const error = t.mock.method(console, 'error', () => {});
  withFetch(t, async () => {
    throw new Error('network down');
  });

  await assert.doesNotReject(auth().initAuth());

  assert.equal(auth().getAuthUser(), null);
  assert.equal(seen.reloads, 0);
  assert.equal(error.mock.callCount(), 1);
});

test('signOut: logs out, clears the user and stops syncing edits', async (t) => {
  const seen = withBrowser(t);
  const calls = mockMeFetch(t, { steamid: STEAMID, prefs: {} });
  await auth().initAuth();
  calls.length = 0;

  await auth().signOut();

  assert.deepEqual(calls, [{ url: '/auth/logout', method: 'POST' }]);
  assert.equal(auth().getAuthUser(), null);
  prefs().setPref('region', 'DE');
  assert.deepEqual(pushes(calls), []);
});

test('signOut: a failed logout request still signs out locally', async (t) => {
  const seen = withBrowser(t);
  await signIn(t);
  t.mock.method(console, 'error', () => {});
  const calls = [];
  withFetch(t, async (url, opts = {}) => {
    calls.push({ url, method: opts.method ?? 'GET' });
    if (url === '/auth/logout') throw new Error('network down');
    return { ok: true, json: async () => ({ ok: true }) };
  });

  await assert.doesNotReject(auth().signOut());

  assert.equal(auth().getAuthUser(), null);
  prefs().setPref('region', 'DE');
  assert.deepEqual(pushes(calls), []);
});

test('a push answered 401 signs out: the session ended while the page was open', async (t) => {
  withBrowser(t);
  await signIn(t);
  const calls = [];
  withFetch(t, async (url, opts = {}) => {
    calls.push({ url, method: opts.method ?? 'GET' });
    return { ok: false, status: 401, json: async () => ({ error: 'Not signed in' }) };
  });

  prefs().setPref('region', 'DE');
  await until(() => auth().getAuthUser() === null, 'signed out');

  prefs().setPref('region', 'FR');
  assert.equal(pushes(calls).length, 1);
});

test('initAuth: a session lost during the sign-in merge stays signed out', async (t) => {
  withBrowser(t);
  markAlreadySynced();
  prefs().setPref('region', 'DE');
  withFetch(t, async (url) => {
    if (url === '/api/me') return { ok: true, json: async () => ({ steamid: STEAMID, prefs: {} }) };
    return { ok: false, status: 401, json: async () => ({ error: 'Not signed in' }) };
  });

  await auth().initAuth();

  assert.equal(auth().getAuthUser(), null);
});

test('signOut: sends pending pushes before logging out, so they still reach the account', async (t) => {
  withBrowser(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = mockMeFetch(t, { steamid: STEAMID, prefs: {} });
  await auth().initAuth();
  prefs().setPref('lists', [{ id: 'a' }]);
  calls.length = 0;

  await auth().signOut();

  assert.deepEqual(calls, [
    { url: '/api/me/prefs/lists', method: 'PUT' },
    { url: '/auth/logout', method: 'POST' },
  ]);
});

test('isSessionExpired: signed out on a load after signing in on this browser, until signing in again', async (t) => {
  withBrowser(t);
  await signIn(t);
  assert.equal(auth().isSessionExpired(), false);

  mockMeFetch(t, { steamid: null, prefs: null });
  await auth().initAuth();
  assert.equal(auth().isSessionExpired(), true);

  await signIn(t);
  assert.equal(auth().isSessionExpired(), false);
});

test('isSessionExpired: never for a browser that never signed in, nor after Sign out', async (t) => {
  withBrowser(t);
  mockMeFetch(t, { steamid: null, prefs: null });
  await auth().initAuth();
  assert.equal(auth().isSessionExpired(), false);

  await signIn(t);
  await auth().signOut();
  mockMeFetch(t, { steamid: null, prefs: null });
  await auth().initAuth();
  assert.equal(auth().isSessionExpired(), false);
});

test('dismissSessionExpired: "Stay signed out" hides it, and a later load keeps it hidden', async (t) => {
  withBrowser(t);
  await signIn(t);
  mockMeFetch(t, { steamid: null, prefs: null });
  await auth().initAuth();

  auth().dismissSessionExpired();
  assert.equal(auth().isSessionExpired(), false);
  await auth().initAuth();
  assert.equal(auth().isSessionExpired(), false);
});

test("isSessionExpired: set by a push's 401, not by a sign-in check that failed", async (t) => {
  withBrowser(t);
  await signIn(t);
  t.mock.method(console, 'error', () => {});
  withFetch(t, async () => {
    throw new Error('network down');
  });
  await auth().initAuth();
  assert.equal(auth().isSessionExpired(), false);

  await signIn(t);
  withFetch(t, async () => ({ ok: false, status: 401, json: async () => ({ error: 'Not signed in' }) }));
  prefs().setPref('region', 'DE');
  await until(() => auth().isSessionExpired(), 'expired');
});

test('getAuthUser is reactive: an effect follows sign-in and sign-out', async (t) => {
  withBrowser(t);
  mockMeFetch(t, { steamid: STEAMID, prefs: null });
  const { createRoot, createEffect } = await import('solid-js');
  const users = [];
  const dispose = createRoot((dispose) => {
    createEffect(() => users.push(auth().getAuthUser()?.steamid ?? null));
    return dispose;
  });
  t.after(dispose);

  await auth().initAuth();
  await auth().signOut();

  assert.deepEqual(users, [null, STEAMID, null]);
});
