'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { makeMemoryLocalStorage } = require('./memoryStorage.js');

// createAccountOverrideSync() is a factory precisely so each test gets a clean instance (see
// its own comment) — but the override it hands to accountsStore.ts is module-level state there,
// which persists between tests, so that half is cleared by hand.
const { createAccountOverrideSync, accountOverrideStatusText } = require('../public/accountOverride.ts');
const {
  getAccountOverride,
  setAccountOverride,
  getEffectiveCurrentAccount,
  setCurrentAccount,
} = require('../public/accountsStore.ts');

beforeEach(() => {
  global.localStorage = makeMemoryLocalStorage();
  setAccountOverride(null);
});

const { withFetch } = require('./withFetch.js');

// A /api/common-games + /api/wishlist responder resolving every requested identifier to one
// player, mirroring what resolveAccountSlot reads (accountData.ts).
function fakeResolveFetch({
  members = [
    {
      steamid: '1',
      personaname: 'Alice',
      avatarmedium: 'https://cdn/a.jpg',
      profileurl: 'https://steamcommunity.com/id/alice/',
    },
  ],
  fail = false,
} = {}) {
  const calls = [];
  const handler = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    if (url === '/api/common-games') {
      if (fail) return { ok: false, json: async () => ({ error: 'No such user' }) };
      return { ok: true, json: async () => ({ games: [{ appid: 440, name: 'TF2' }], players: members }) };
    }
    return { ok: true, json: async () => ({ items: [] }) };
  };
  handler.calls = calls;
  return handler;
}

// The resolve is fired off without being awaited (syncFromUrl is called from a Solid effect), so
// tests wait for the microtasks it chains on rather than for a returned promise.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('syncFromUrl: resolves ?u= into an override, leaving the stored account untouched', async (t) => {
  withFetch(t, fakeResolveFetch());
  setCurrentAccount({ id: 'mine', members: ['9'], rawInputs: ['me'] });
  const sync = createAccountOverrideSync();

  sync.syncFromUrl('?u=alice');
  assert.equal(sync.getState().state, 'resolving');
  assert.equal(getAccountOverride(), null, 'nothing is shown until it actually resolves');

  await settle();
  assert.equal(sync.getState().state, 'ready');
  assert.deepEqual(getAccountOverride(), {
    id: '1',
    members: ['1'],
    rawInputs: ['alice'],
    label: 'Alice',
    avatarUrl: 'https://cdn/a.jpg',
    vanities: { 1: 'alice' }, // carried onto the slot, so the copyable identifier needs no fetch
  });
  assert.equal(getEffectiveCurrentAccount().id, '1');
  assert.equal(require('../public/accountsStore.ts').getCurrentAccount().id, 'mine');
});

test('syncFromUrl: comma-joined identifiers resolve as one Family account', async (t) => {
  const fetchHandler = fakeResolveFetch({
    members: [
      { steamid: '1', personaname: 'Alice' },
      { steamid: '2', personaname: 'Bob' },
    ],
  });
  withFetch(t, fetchHandler);
  const sync = createAccountOverrideSync();

  sync.syncFromUrl('?u=alice,bob');
  await settle();

  assert.deepEqual(fetchHandler.calls[0].body, { members: ['alice', 'bob'] });
  assert.equal(getAccountOverride().id, '1+2');
  assert.equal(getAccountOverride().label, 'Alice + Bob');
});

test('syncFromUrl: a multi-slot comparison link sets no override at all', async (t) => {
  // `/lists/compare?u=alice&u=bob` names two players, not an account being explored — honoring
  // the first would have every comparison quietly declare a current account on the side.
  const fetchHandler = fakeResolveFetch();
  withFetch(t, fetchHandler);
  const sync = createAccountOverrideSync();

  sync.syncFromUrl('?u=alice&u=bob');
  await settle();

  assert.deepEqual(fetchHandler.calls, [], 'nothing is resolved');
  assert.equal(getAccountOverride(), null);
  assert.equal(sync.getState().state, 'none');
});

test('syncFromUrl: an unrelated param write does not re-resolve the same account', async (t) => {
  const fetchHandler = fakeResolveFetch();
  withFetch(t, fetchHandler);
  const sync = createAccountOverrideSync();

  sync.syncFromUrl('?u=alice');
  await settle();
  sync.syncFromUrl('?u=alice&game=440');
  sync.syncFromUrl('?u=alice&game=620&shot=s0');
  await settle();

  const resolves = fetchHandler.calls.filter((c) => c.url === '/api/common-games').length;
  assert.equal(resolves, 1);
  assert.equal(sync.getState().state, 'ready');
});

test('syncFromUrl: clears the override once u= is gone from the URL', async (t) => {
  withFetch(t, fakeResolveFetch());
  const sync = createAccountOverrideSync();

  sync.syncFromUrl('?u=alice');
  await settle();
  sync.syncFromUrl('?game=440');

  assert.equal(getAccountOverride(), null);
  assert.deepEqual(sync.getState(), { state: 'none', identifiers: [] });
});

test('syncFromUrl: a link that cannot be resolved reports the error and leaves no override', async (t) => {
  withFetch(t, fakeResolveFetch({ fail: true }));
  const sync = createAccountOverrideSync();

  sync.syncFromUrl('?u=nope');
  await settle();

  assert.equal(sync.getState().state, 'error');
  assert.equal(sync.getState().message, 'No such user');
  assert.equal(getAccountOverride(), null);
});

test('syncFromUrl: a superseded resolve never overwrites a newer one', async (t) => {
  // Two identifiers, the first resolving after the second — the stale-guard case.
  let releaseSlow;
  const slowReply = new Promise((r) => (releaseSlow = r));
  withFetch(t, async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (url !== '/api/common-games') return { ok: true, json: async () => ({ items: [] }) };
    const slow = body.members[0] === 'slow';
    if (slow) await slowReply;
    return {
      ok: true,
      json: async () => ({
        games: [],
        players: [{ steamid: slow ? '1' : '2', personaname: slow ? 'Slow' : 'Fast' }],
      }),
    };
  });
  const sync = createAccountOverrideSync();

  sync.syncFromUrl('?u=slow');
  sync.syncFromUrl('?u=fast');
  await settle(); // the fast one lands first
  releaseSlow();
  await settle();

  assert.equal(getAccountOverride().label, 'Fast');
  assert.deepEqual(sync.getState().identifiers, ['fast']);
});

test('clear: drops the override, and a later sync of the stripped URL is a no-op', async (t) => {
  const fetchHandler = fakeResolveFetch();
  withFetch(t, fetchHandler);
  const sync = createAccountOverrideSync();

  sync.syncFromUrl('?u=alice');
  await settle();
  sync.clear();
  assert.equal(getAccountOverride(), null);
  assert.equal(sync.getState().state, 'none');

  sync.syncFromUrl(''); // what HomeRoute's replaceState leaves behind after an explicit pick
  await settle();
  assert.equal(fetchHandler.calls.filter((c) => c.url === '/api/common-games').length, 1);
});

test('clear: a resolve still in flight cannot land afterward', async (t) => {
  let release;
  const reply = new Promise((r) => (release = r));
  withFetch(t, async (url) => {
    if (url !== '/api/common-games') return { ok: true, json: async () => ({ items: [] }) };
    await reply;
    return { ok: true, json: async () => ({ games: [], players: [{ steamid: '1', personaname: 'Alice' }] }) };
  });
  const sync = createAccountOverrideSync();

  sync.syncFromUrl('?u=alice');
  sync.clear();
  release();
  await settle();

  assert.equal(getAccountOverride(), null);
  assert.equal(sync.getState().state, 'none');
});

test('accountOverrideStatusText: explains a resolving/failed link, and says nothing otherwise', () => {
  assert.equal(
    accountOverrideStatusText({ state: 'resolving', identifiers: ['alice', 'bob'] }),
    'Resolving alice + bob from this link…',
  );
  assert.equal(
    accountOverrideStatusText({ state: 'error', identifiers: ['nope'], message: 'No such user' }),
    "Couldn't resolve nope from this link: No such user",
  );
  assert.equal(accountOverrideStatusText({ state: 'none', identifiers: [] }), null);
  assert.equal(accountOverrideStatusText({ state: 'ready', identifiers: ['alice'] }), null);
});
