'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

function makeMemoryLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

beforeEach(() => {
  global.localStorage = makeMemoryLocalStorage();
  // Unlike currentAccount (a pref, wiped with localStorage above), the `?u=` override is
  // module-level state in accountsStore.ts — cleared by hand so it can't leak between tests.
  setAccountOverride(null);
  clearAccountDataCache();
});

// createMyOwnershipCache() is imported fresh (not re-required) per test — it's a factory
// specifically so each test gets a clean instance without depending on this repo's usual
// "delete require.cache between tests" pattern, which only resets a *stateless* module (see
// myOwnership.ts's own comment on why that pattern doesn't reset a module-level `let` here).
const { createMyOwnershipCache } = require('../public/myOwnership.ts');
const { setCurrentAccount, setAccountOverride } = require('../public/accountsStore.ts');
const { clearAccountDataCache, fetchAccountOverview } = require('../public/accountData.ts');

function makeAccount(id, overrides = {}) {
  return { id, members: [id], rawInputs: [id], ...overrides };
}

function withFetch(t, handler) {
  const restore = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = restore;
  });
}

// A minimal /api/common-games + /api/wishlist responder for one account id ("1" by default),
// owning `ownedAppids` and wishlisting `wishlistAppids`.
function fakeAccountFetch({ ownedAppids = [], wishlistAppids = [], failWishlist = false, failOwned = false } = {}) {
  return async (url) => {
    if (url === '/api/common-games') {
      if (failOwned) return { ok: false, json: async () => ({ error: 'Steam API error 502' }) };
      return {
        ok: true,
        json: async () => ({
          games: ownedAppids.map((appid) => ({ appid, name: `Game ${appid}` })),
          players: [{ steamid: '1' }],
          playtime: {},
          lastPlayed: {},
        }),
      };
    }
    if (failWishlist) return { ok: false, json: async () => ({ error: 'private profile' }) };
    return {
      ok: true,
      json: async () => ({ items: wishlistAppids.map((appid) => ({ appid, priority: 1, dateAdded: null })) }),
    };
  };
}

test('getMyOwnershipStatus: null when no currentAccount is loaded', async () => {
  const { getMyOwnershipStatus } = createMyOwnershipCache();
  assert.equal(await getMyOwnershipStatus(440), null);
});

test('getMyOwnershipStatus: resolves inLibrary/onWishlist against currentAccount', async (t) => {
  withFetch(t, fakeAccountFetch({ ownedAppids: [440, 620], wishlistAppids: [620, 730] }));
  setCurrentAccount(makeAccount('1'));

  const { getMyOwnershipStatus } = createMyOwnershipCache();
  assert.deepEqual(await getMyOwnershipStatus(440), { inLibrary: true, onWishlist: false });
  assert.deepEqual(await getMyOwnershipStatus(620), { inLibrary: true, onWishlist: true });
  assert.deepEqual(await getMyOwnershipStatus(730), { inLibrary: false, onWishlist: true });
  assert.deepEqual(await getMyOwnershipStatus(999), { inLibrary: false, onWishlist: false });
});

test('getMyOwnershipStatus: a failed wishlist fetch still resolves inLibrary, wishlisted unknown rather than throwing', async (t) => {
  withFetch(t, fakeAccountFetch({ ownedAppids: [440], failWishlist: true }));
  setCurrentAccount(makeAccount('1'));

  const { getMyOwnershipStatus } = createMyOwnershipCache();
  assert.deepEqual(await getMyOwnershipStatus(440), { inLibrary: true, onWishlist: null });
});

test('a failed owned fetch reads as unknown, not as owning nothing', async (t) => {
  withFetch(t, fakeAccountFetch({ wishlistAppids: [620], failOwned: true }));
  setCurrentAccount(makeAccount('1'));

  const { getMyOwnershipStatus, peekMyOwnershipStatus, peekMyOwnership } = createMyOwnershipCache();
  assert.deepEqual(await getMyOwnershipStatus(440), { inLibrary: null, onWishlist: false });
  assert.deepEqual(peekMyOwnershipStatus(620), { inLibrary: null, onWishlist: true });
  assert.equal(peekMyOwnership().playtime(440), undefined);
});

test('getMyOwnershipStatus: only fetches once per loaded account — a second appid check reuses the cached sets', async (t) => {
  let commonGamesCalls = 0;
  withFetch(t, async (url, opts) => {
    if (url === '/api/common-games') {
      commonGamesCalls++;
    }
    return fakeAccountFetch({ ownedAppids: [440] })(url, opts);
  });
  setCurrentAccount(makeAccount('1'));

  const { getMyOwnershipStatus } = createMyOwnershipCache();
  await getMyOwnershipStatus(440);
  await getMyOwnershipStatus(620);
  await getMyOwnershipStatus(730);
  assert.equal(commonGamesCalls, 1);
});

test('getMyOwnershipStatus: switching currentAccount refetches against the new account', async (t) => {
  let seenMembers = [];
  withFetch(t, async (url, opts) => {
    if (url === '/api/common-games') {
      const body = JSON.parse(opts.body);
      seenMembers.push(body.members[0]);
      const appids = body.members[0] === '1' ? [440] : [620];
      return {
        ok: true,
        json: async () => ({
          games: appids.map((a) => ({ appid: a, name: `${a}` })),
          players: [{ steamid: body.members[0] }],
          playtime: {},
          lastPlayed: {},
        }),
      };
    }
    return { ok: true, json: async () => ({ items: [] }) };
  });

  const { getMyOwnershipStatus } = createMyOwnershipCache();

  setCurrentAccount(makeAccount('1'));
  assert.deepEqual(await getMyOwnershipStatus(440), { inLibrary: true, onWishlist: false });

  setCurrentAccount(makeAccount('2'));
  assert.deepEqual(await getMyOwnershipStatus(440), { inLibrary: false, onWishlist: false });
  assert.deepEqual(await getMyOwnershipStatus(620), { inLibrary: true, onWishlist: false });
  assert.deepEqual(seenMembers, ['1', '2']); // cached per account — one /api/common-games call each, not one per appid check
});

test("peekMyOwnershipStatus: a superseded account's slow response doesn't overwrite the new account's sets", async (t) => {
  let releaseFirst;
  const firstHeld = new Promise((resolve) => (releaseFirst = resolve));
  withFetch(t, async (url, opts) => {
    const id = JSON.parse(opts.body).members[0];
    if (id === '1') await firstHeld;
    const appid = id === '1' ? 440 : 620;
    if (url === '/api/common-games') {
      return {
        ok: true,
        json: async () => ({
          games: [{ appid, name: `${appid}` }],
          players: [{ steamid: id }],
          playtime: {},
          lastPlayed: {},
        }),
      };
    }
    return { ok: true, json: async () => ({ items: [{ appid, priority: 1, dateAdded: null }] }) };
  });

  const { peekMyOwnershipStatus, getMyOwnershipStatus } = createMyOwnershipCache();
  setCurrentAccount(makeAccount('1'));
  assert.equal(peekMyOwnershipStatus(440), null); // account 1's fetch starts, and hangs
  setCurrentAccount(makeAccount('2'));
  assert.deepEqual(await getMyOwnershipStatus(620), { inLibrary: true, onWishlist: true });

  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(peekMyOwnershipStatus(440), { inLibrary: false, onWishlist: false });
  assert.deepEqual(peekMyOwnershipStatus(620), { inLibrary: true, onWishlist: true });
});

test('peekMyOwnershipStatus: null (not blocking) before the fetch resolves, then real data once it lands', async (t) => {
  let resolveCommonGames;
  withFetch(t, async (url) => {
    if (url === '/api/common-games') {
      return new Promise((resolve) => {
        resolveCommonGames = () =>
          resolve({
            ok: true,
            json: async () => ({
              games: [{ appid: 440, name: 'TF2' }],
              players: [{ steamid: '1' }],
              playtime: {},
              lastPlayed: {},
            }),
          });
      });
    }
    return { ok: true, json: async () => ({ items: [] }) };
  });
  setCurrentAccount(makeAccount('1'));

  const { peekMyOwnershipStatus } = createMyOwnershipCache();
  assert.equal(peekMyOwnershipStatus(440), null); // still loading
  resolveCommonGames();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(peekMyOwnershipStatus(440), { inLibrary: true, onWishlist: false });
});

test('peekMyOwnershipStatus: null when no currentAccount is loaded, with no fetch attempted', async (t) => {
  let called = false;
  withFetch(t, async () => {
    called = true;
    return { ok: true, json: async () => ({}) };
  });

  const { peekMyOwnershipStatus } = createMyOwnershipCache();
  assert.equal(peekMyOwnershipStatus(440), null);
  assert.equal(called, false);
});

// Runs `read` in an effect and returns what it saw on each run, plus a dispose.
async function track(read) {
  const { createRoot, createEffect } = await import('solid-js');
  const seen = [];
  const dispose = createRoot((dispose) => {
    createEffect(() => seen.push(read()));
    return dispose;
  });
  return { seen, dispose };
}

test('peekMyOwnershipStatus is reactive: a tracked peek re-runs once both sets land', async (t) => {
  withFetch(t, fakeAccountFetch({ ownedAppids: [440], wishlistAppids: [620] }));
  setCurrentAccount(makeAccount('1'));
  const { getMyOwnershipStatus, peekMyOwnershipStatus } = createMyOwnershipCache();
  const { seen, dispose } = await track(() => peekMyOwnershipStatus(440));

  await getMyOwnershipStatus(440); // drives both fetches to completion
  dispose();

  assert.deepEqual(seen, [null, { inLibrary: true, onWishlist: false }]);
});

test('peekMyOwnershipStatus: a ↻ elsewhere re-derives the ✓/☆ sets, keeping the old ones until it lands', async (t) => {
  let ownedAppids = [];
  withFetch(t, async (url) => {
    if (url.startsWith('/api/common-games'))
      return {
        ok: true,
        json: async () => ({
          games: ownedAppids.map((appid) => ({ appid, name: `Game ${appid}` })),
          players: [{ steamid: '1' }],
          playtime: {},
          lastPlayed: {},
        }),
      };
    return { ok: true, json: async () => ({ items: [] }) };
  });
  setCurrentAccount(makeAccount('1'));
  const { getMyOwnershipStatus, peekMyOwnershipStatus } = createMyOwnershipCache();
  const { seen, dispose } = await track(() => peekMyOwnershipStatus(440));
  t.after(dispose);
  await getMyOwnershipStatus(440);

  ownedAppids = [440]; // bought since
  await fetchAccountOverview(['1'], { refresh: true }); // Home's or a list's ↻
  assert.deepEqual(await getMyOwnershipStatus(440), { inLibrary: true, onWishlist: false });

  assert.equal(seen[0], null);
  assert.deepEqual(seen[1], { inLibrary: false, onWishlist: false });
  assert.ok(seen.slice(1).every(Boolean), 'no blink back to "loading" while the refreshed sets land');
  assert.deepEqual(seen.at(-1), { inLibrary: true, onWishlist: false });
});

test('trackMyOwnership: re-runs on an account switch, without starting a fetch', async (t) => {
  let fetches = 0;
  withFetch(t, (...args) => {
    fetches++;
    return fakeAccountFetch()(...args);
  });
  const { trackMyOwnership } = createMyOwnershipCache();
  let runs = 0;
  const { dispose } = await track(() => {
    trackMyOwnership();
    runs++;
  });

  setCurrentAccount(makeAccount('2'));
  dispose();

  assert.equal(runs, 2);
  assert.equal(fetches, 0);
});

test('peekMyOwnership: a peek with no lookups still re-runs its tracked scope on an account switch', async (t) => {
  let fetches = 0;
  withFetch(t, (...args) => {
    fetches++;
    return fakeAccountFetch()(...args);
  });
  const { peekMyOwnership } = createMyOwnershipCache();
  let runs = 0;
  const { dispose } = await track(() => {
    peekMyOwnership();
    runs++;
  });

  setCurrentAccount(makeAccount('2'));
  dispose();

  assert.equal(runs, 2);
  assert.equal(fetches, 0);
});

test('getMyOwnershipStatus: a ?u= override is what ownership answers for, not the stored account', async (t) => {
  // Owned games differ per account, so the answer says which one was actually asked about.
  withFetch(t, async (url, opts) => {
    const body = JSON.parse(opts.body);
    const member = body.members[0];
    if (url === '/api/common-games') {
      return {
        ok: true,
        json: async () => ({
          games: (member === '1' ? [440] : [620]).map((appid) => ({ appid, name: `App ${appid}` })),
          players: [{ steamid: member }],
          playtime: {},
          lastPlayed: {},
        }),
      };
    }
    return { ok: true, json: async () => ({ items: [] }) };
  });
  setCurrentAccount(makeAccount('1'));
  setAccountOverride(makeAccount('2'));

  const { getMyOwnershipStatus } = createMyOwnershipCache();
  assert.deepEqual(await getMyOwnershipStatus(620), { inLibrary: true, onWishlist: false });
  assert.deepEqual(await getMyOwnershipStatus(440), { inLibrary: false, onWishlist: false });
});

test("peekMyOwnership: a peek first looked up after an account switch loads the current account, not its creation's", async (t) => {
  withFetch(t, async (url, opts) => {
    const member = JSON.parse(opts.body).members[0];
    if (url === '/api/common-games')
      return {
        ok: true,
        json: async () => ({
          games: [{ appid: member === '1' ? 440 : 620, name: 'App' }],
          players: [{ steamid: member }],
          playtime: {},
          lastPlayed: {},
        }),
      };
    return { ok: true, json: async () => ({ items: [] }) };
  });
  setCurrentAccount(makeAccount('1'));
  const { peekMyOwnership } = createMyOwnershipCache();
  const before = peekMyOwnership();
  setCurrentAccount(makeAccount('2'));
  const current = peekMyOwnership();
  current.status(620);
  before.status(620);

  for (let i = 0; i < 5; i++) await new Promise(setImmediate); // both fetches land
  assert.deepEqual(current.status(620), { inLibrary: true, onWishlist: false });
});

test('peekMyOwnership().playtime: undefined while loading, then summed hours / latest date for owned games, null otherwise', async (t) => {
  withFetch(t, async (url) => {
    if (url === '/api/common-games') {
      return {
        ok: true,
        json: async () => ({
          games: [
            { appid: 620, name: 'Portal 2' },
            { appid: 440, name: 'TF2' },
          ],
          players: [{ steamid: '1' }, { steamid: '2' }],
          playtime: { 620: { 1: 300, 2: 60 } },
          lastPlayed: { 620: { 1: 1700000000, 2: 1600000000 } },
        }),
      };
    }
    return { ok: true, json: async () => ({ items: [] }) };
  });
  setCurrentAccount(makeAccount('1', { members: ['1', '2'] }));

  const { peekMyOwnership, getMyOwnershipStatus } = createMyOwnershipCache();
  assert.equal(peekMyOwnership().playtime(620), undefined);
  await getMyOwnershipStatus(620);
  assert.deepEqual(peekMyOwnership().playtime(620), { playtime: 6, lastPlayed: '2023-11-14' });
  assert.deepEqual(peekMyOwnership().playtime(440), { playtime: 0, lastPlayed: '' });
  assert.equal(peekMyOwnership().playtime(999), null);
});

test('peekMyOwnership: reads the current account once for any number of rows (C204)', async (t) => {
  withFetch(t, fakeAccountFetch({ ownedAppids: [440], wishlistAppids: [620] }));
  setCurrentAccount(makeAccount('1'));
  const { peekMyOwnership, getMyOwnershipStatus } = createMyOwnershipCache();
  await getMyOwnershipStatus(440);

  const getItem = localStorage.getItem;
  let reads = 0;
  localStorage.getItem = (k) => (reads++, getItem(k));
  const readsFor = (rows) => {
    reads = 0;
    const peek = peekMyOwnership();
    for (let appid = 0; appid < rows; appid++) {
      peek.status(appid);
      peek.playtime(appid);
    }
    return reads;
  };

  assert.ok(readsFor(1) > 0);
  assert.equal(readsFor(1000), readsFor(1));
  const peek = peekMyOwnership();
  assert.deepEqual(peek.status(440), { inLibrary: true, onWishlist: false });
  assert.deepEqual(peek.status(620), { inLibrary: false, onWishlist: true });
  assert.deepEqual(peek.playtime(440), { playtime: 0, lastPlayed: '' });
});

test('peekMyOwnership: a peek with no lookups starts no fetch (an empty list or search)', async (t) => {
  let fetches = 0;
  withFetch(t, (...args) => {
    fetches++;
    return fakeAccountFetch()(...args);
  });
  setCurrentAccount(makeAccount('1'));
  const { peekMyOwnership } = createMyOwnershipCache();

  peekMyOwnership();

  assert.equal(fetches, 0);
});
