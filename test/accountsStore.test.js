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
  delete require.cache[require.resolve('../public/prefs.ts')];
  delete require.cache[require.resolve('../public/listsStore.ts')];
  delete require.cache[require.resolve('../public/accountsStore.ts')];
  // The `?u=` override is module-level state, not a pref — so unlike everything else in this
  // file it survives the require.cache reset above (see myOwnership.ts's own comment on why a
  // TS-stripped ESM module's `let` isn't reachable through require.cache). Cleared by hand so
  // each test starts with no override rather than inheriting the previous one's.
  require('../public/accountsStore.ts').setAccountOverride(null);
});

function store() {
  return require('../public/accountsStore.ts');
}

function makeAccount(id, overrides = {}) {
  return { id, members: [id], rawInputs: [id], ...overrides };
}

test('accountIdFor: sorts members so the same Family always produces the same id', () => {
  const { accountIdFor } = store();
  assert.equal(accountIdFor(['b', 'a']), accountIdFor(['a', 'b']));
  assert.equal(accountIdFor(['a', 'b']), 'a+b');
});

test('getMyAccount/getCurrentAccount: null when never set', () => {
  const { getMyAccount, getCurrentAccount } = store();
  assert.equal(getMyAccount(), null);
  assert.equal(getCurrentAccount(), null);
});

test('setMyAccount/setCurrentAccount: round-trip independently, clearing recents orphans neither', () => {
  const { setMyAccount, setCurrentAccount, getMyAccount, getCurrentAccount, clearRecentAccounts, getRecentAccounts } =
    store();
  const me = makeAccount('me');
  const other = makeAccount('other');
  setMyAccount(me);
  setCurrentAccount(other);

  clearRecentAccounts();

  assert.deepEqual(getMyAccount(), me);
  assert.deepEqual(getCurrentAccount(), other);
  assert.equal(getRecentAccounts().length, 0);
});

test('setCurrentAccount: upserts into recentAccounts (dedupe by id)', () => {
  const { setCurrentAccount, getRecentAccounts } = store();
  setCurrentAccount(makeAccount('acc1'));
  setCurrentAccount(makeAccount('acc1', { label: 'Alice' }));

  const recents = getRecentAccounts();
  assert.equal(recents.length, 1);
  assert.equal(recents[0].label, 'Alice');
});

test('setMyAccount: also upserts into recentAccounts (starring is itself a use)', () => {
  const { setMyAccount, getRecentAccounts } = store();
  setMyAccount(makeAccount('me'));
  assert.equal(
    getRecentAccounts().some((a) => a.id === 'me'),
    true,
  );
});

test('setCurrentAccount: a re-pick resolved without player summaries keeps the stored display fields', () => {
  const { setCurrentAccount, getCurrentAccount, getRecentAccounts } = store();
  const known = {
    label: 'Alice',
    avatarUrl: 'https://avatars/a.jpg',
    vanities: { acc1: 'alice' },
  };
  setCurrentAccount(makeAccount('acc1', known));
  // What accountSlotFrom builds when Steam's player summaries fail: placeholders, no display fields.
  setCurrentAccount(makeAccount('acc1', { rawInputs: ['typed'], vanities: {}, unresolved: ['acc1'] }));

  for (const slot of [getCurrentAccount(), getRecentAccounts()[0]]) {
    assert.deepEqual(slot, makeAccount('acc1', { ...known, rawInputs: ['typed'] }));
  }
});

test('setCurrentAccount: a resolved re-pick drops fields the user cleared on Steam', () => {
  const { setCurrentAccount, getCurrentAccount } = store();
  setCurrentAccount(
    makeAccount('acc1', { label: 'Alice', avatarUrl: 'https://avatars/a.jpg', vanities: { acc1: 'alice' } }),
  );
  setCurrentAccount(makeAccount('acc1', { label: 'Alice', vanities: {} }));
  assert.deepEqual(getCurrentAccount(), makeAccount('acc1', { label: 'Alice', vanities: {} }));
});

test('a stored slot with keys the app no longer writes still loads, and a re-pick drops them', () => {
  const legacy = makeAccount('acc1', { label: 'Alice', memberSince: '2010-01-01', countryCode: 'FR', realName: 'A.' });
  const entry = (value) => ({ value, updatedAt: 1 });
  global.localStorage.setItem(
    'steam.isonoe.net:prefs',
    JSON.stringify({ schemaVersion: 2, currentAccount: entry(legacy), recentAccounts: entry([legacy]) }),
  );
  const { setCurrentAccount, getCurrentAccount, getRecentAccounts } = store();
  assert.equal(getCurrentAccount().label, 'Alice');
  assert.equal(getRecentAccounts()[0].label, 'Alice');

  setCurrentAccount(makeAccount('acc1', { vanities: {}, unresolved: ['acc1'] }));
  assert.deepEqual(getCurrentAccount(), makeAccount('acc1', { label: 'Alice', vanities: {} }));
});

test('setCurrentAccount: a Family keeps only its unresolved members’ stored names', () => {
  const { setCurrentAccount, getCurrentAccount } = store();
  const family = { members: ['a', 'b'], rawInputs: ['a', 'b'] };
  setCurrentAccount(makeAccount('a+b', { ...family, label: 'A + B', vanities: { a: 'old-a', b: 'bee' } }));
  setCurrentAccount(makeAccount('a+b', { ...family, vanities: {}, unresolved: ['b'] }));
  assert.deepEqual(getCurrentAccount(), makeAccount('a+b', { ...family, label: 'A + B', vanities: { b: 'bee' } }));
});

test("setCurrentAccount: a Family keeps only its unresolved members' stored faces", () => {
  const { setCurrentAccount, getCurrentAccount } = store();
  const family = { members: ['a', 'b'], rawInputs: ['a', 'b'] };
  setCurrentAccount(makeAccount('a+b', { ...family, memberAvatars: { a: 'old-a.png', b: 'b.png' } }));
  setCurrentAccount(makeAccount('a+b', { ...family, memberAvatars: { a: 'a.png' }, unresolved: ['b'] }));
  assert.deepEqual(getCurrentAccount().memberAvatars, { a: 'a.png', b: 'b.png' });
});

test('setCurrentAccount: an unresolved pick finds the stored slot in myAccount too', () => {
  const { setMyAccount, setCurrentAccount, getCurrentAccount, clearRecentAccounts } = store();
  setMyAccount(makeAccount('acc1', { label: 'Alice' }));
  clearRecentAccounts();
  setCurrentAccount(makeAccount('acc1', { vanities: {}, unresolved: ['acc1'] }));
  assert.equal(getCurrentAccount().label, 'Alice');
});

test('getRecentAccounts: my account first, then by name, case- and accent-insensitive', () => {
  const { setMyAccount, setCurrentAccount, getRecentAccounts } = store();
  setCurrentAccount(makeAccount('1', { label: 'bob' }));
  setCurrentAccount(makeAccount('2', { label: 'Zoé' }));
  setCurrentAccount(makeAccount('3', { label: 'Émile' }));
  setCurrentAccount(makeAccount('4+5', { members: ['4', '5'], label: 'Carol + Alice' })); // a Family sorts by its label
  setCurrentAccount(makeAccount('6', { label: 'alice' }));
  assert.deepEqual(
    getRecentAccounts().map((a) => a.id),
    ['6', '1', '4+5', '3', '2'],
  );

  setMyAccount(makeAccount('2', { label: 'Zoé' }));
  assert.deepEqual(
    getRecentAccounts().map((a) => a.id),
    ['2', '6', '1', '4+5', '3'],
  );
});

test('getRecentAccounts: accounts with the same name keep one order, whatever order they were added in', () => {
  const { setCurrentAccount, getRecentAccounts } = store();
  setCurrentAccount(makeAccount('2', { label: 'Alex' }));
  setCurrentAccount(makeAccount('1', { label: 'Alex' }));
  assert.deepEqual(
    getRecentAccounts().map((a) => a.id),
    ['1', '2'],
  );
});

test('removeRecentAccount: hard-removes an account nothing references', () => {
  const { setCurrentAccount, removeRecentAccount, getRecentAccounts } = store();
  setCurrentAccount(makeAccount('acc1'));
  const result = removeRecentAccount('acc1');
  assert.equal(result.softRemoved, false);
  assert.equal(getRecentAccounts().length, 0);
});

test('keepAccountForLists: stores an unpicked account hidden, without its unresolved members', () => {
  const { keepAccountForLists, getRecentAccounts } = store();
  assert.equal(keepAccountForLists(makeAccount('bob', { label: 'Bob', unresolved: [] })), true);
  assert.equal(getRecentAccounts().length, 0); // not picked: stays out of recents
  const [kept] = getRecentAccounts({ includeRemoved: true });
  assert.equal(kept.label, 'Bob');
  assert.ok(kept.removedAt);
  assert.ok(!('unresolved' in kept));
});

test('keepAccountForLists: leaves a stored account alone, and stores none without a name', () => {
  const { keepAccountForLists, setCurrentAccount, getRecentAccounts } = store();
  setCurrentAccount(makeAccount('bob', { label: 'Bob' }));
  assert.equal(keepAccountForLists(makeAccount('bob', { label: 'Robert' })), false);
  assert.equal(keepAccountForLists(makeAccount('carol')), false);
  assert.deepEqual(
    getRecentAccounts({ includeRemoved: true }).map((a) => [a.label, a.removedAt]),
    [['Bob', undefined]],
  );
});

test('keepAccountForLists: the kept account is purged once the list naming it is deleted', () => {
  const { keepAccountForLists, getRecentAccounts } = store();
  const { createList, deleteList } = require('../public/listsStore.ts');
  const list = createList({
    name: 'Alice vs. Bob',
    kind: 'dynamic',
    op: 'group-by-membership',
    sources: [{ kind: 'account-owned', accountId: 'bob' }],
  });
  keepAccountForLists(makeAccount('bob', { label: 'Bob' }));
  deleteList(list.id);
  assert.equal(getRecentAccounts({ includeRemoved: true }).length, 0);
});

test('removeRecentAccount: soft-removes an account still referenced by a dynamic list', () => {
  const { setCurrentAccount, removeRecentAccount, getRecentAccounts } = store();
  const { createList } = require('../public/listsStore.ts');
  setCurrentAccount(makeAccount('acc1'));
  createList({
    name: 'Watcher',
    kind: 'dynamic',
    op: 'union',
    sources: [{ kind: 'account-owned', accountId: 'acc1' }],
  });

  const result = removeRecentAccount('acc1');
  assert.equal(result.softRemoved, true);
  assert.equal(getRecentAccounts().length, 0); // hidden from the default view
  assert.equal(getRecentAccounts({ includeRemoved: true }).length, 1);
});

test('clearRecentAccounts: soft-removes referenced accounts, hard-removes the rest', () => {
  const { setCurrentAccount, clearRecentAccounts, getRecentAccounts } = store();
  const { createList } = require('../public/listsStore.ts');
  setCurrentAccount(makeAccount('referenced'));
  setCurrentAccount(makeAccount('unreferenced'));
  createList({
    name: 'Watcher',
    kind: 'dynamic',
    op: 'union',
    sources: [{ kind: 'account-wishlist', accountId: 'referenced' }],
  });

  clearRecentAccounts();

  assert.equal(getRecentAccounts().length, 0);
  const all = getRecentAccounts({ includeRemoved: true });
  assert.deepEqual(
    all.map((a) => a.id),
    ['referenced'],
  );
});

test('a soft-removed account is purged once a list edit drops its last reference', () => {
  const { setCurrentAccount, removeRecentAccount, getRecentAccounts } = store();
  const { createList, updateDynamicList } = require('../public/listsStore.ts');
  setCurrentAccount(makeAccount('acc1'));
  const watcher = createList({
    name: 'Watcher',
    kind: 'dynamic',
    op: 'union',
    sources: [{ kind: 'account-owned', accountId: 'acc1' }],
  });
  removeRecentAccount('acc1');

  assert.equal(getRecentAccounts({ includeRemoved: true }).length, 1); // still referenced
  updateDynamicList(watcher.id, 'union', []);
  assert.equal(getRecentAccounts({ includeRemoved: true }).length, 0);
});

test('a soft-removed account is purged once the list referencing it is deleted', () => {
  const { setCurrentAccount, removeRecentAccount, getRecentAccounts } = store();
  const { createList, deleteList } = require('../public/listsStore.ts');
  setCurrentAccount(makeAccount('acc1'));
  const watcher = createList({
    name: 'Watcher',
    kind: 'dynamic',
    op: 'union',
    sources: [{ kind: 'account-owned', accountId: 'acc1' }],
  });
  removeRecentAccount('acc1');

  deleteList(watcher.id);
  assert.equal(getRecentAccounts({ includeRemoved: true }).length, 0);
});

test('a soft-deleted list still referencing an account keeps it until that list is purged', () => {
  const { setCurrentAccount, removeRecentAccount, getRecentAccounts } = store();
  const { createList, deleteList, updateDynamicList } = require('../public/listsStore.ts');
  setCurrentAccount(makeAccount('acc1'));
  const inner = createList({
    name: 'Inner',
    kind: 'dynamic',
    op: 'union',
    sources: [{ kind: 'account-owned', accountId: 'acc1' }],
  });
  const outer = createList({
    name: 'Outer',
    kind: 'dynamic',
    op: 'union',
    sources: [{ kind: 'user', listId: inner.id }],
  });
  assert.equal(deleteList(inner.id).softDeleted, true);
  assert.equal(removeRecentAccount('acc1').softRemoved, true);

  updateDynamicList(outer.id, 'union', []);
  assert.equal(getRecentAccounts({ includeRemoved: true }).length, 0);
});

// ── The ?u= override ──────────────────────────────────────────────────────────

test('setAccountOverride/getEffectiveCurrentAccount: the override wins over the stored account', () => {
  const { setCurrentAccount, setAccountOverride, getEffectiveCurrentAccount, getCurrentAccount } = store();
  setCurrentAccount(makeAccount('mine'));
  setAccountOverride(makeAccount('theirs'));

  assert.equal(getEffectiveCurrentAccount().id, 'theirs');
  assert.equal(getCurrentAccount().id, 'mine', 'the stored preference itself is untouched');
});

test('setAccountOverride: falls back to the stored account once cleared', () => {
  const { setCurrentAccount, setAccountOverride, getEffectiveCurrentAccount } = store();
  setCurrentAccount(makeAccount('mine'));
  setAccountOverride(makeAccount('theirs'));
  setAccountOverride(null);

  assert.equal(getEffectiveCurrentAccount().id, 'mine');
});

test('setAccountOverride: is never persisted, and never lands in recentAccounts', () => {
  const { setAccountOverride, getCurrentAccount, getRecentAccounts, getEffectiveCurrentAccount } = store();
  setAccountOverride(makeAccount('theirs'));

  assert.equal(getEffectiveCurrentAccount().id, 'theirs');
  assert.equal(getCurrentAccount(), null, 'no stored currentAccount was written');
  assert.deepEqual(getRecentAccounts(), [], 'browsing a link is not the same act as picking an account');
});

test('getEffectiveCurrentAccount: null when there is neither an override nor a stored account', () => {
  assert.equal(store().getEffectiveCurrentAccount(), null);
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

test('getEffectiveCurrentAccount is reactive: follows the override and the stored account', async () => {
  const { setAccountOverride, setCurrentAccount, getEffectiveCurrentAccount } = store();
  const { seen, dispose } = await track(() => getEffectiveCurrentAccount()?.id ?? null);

  setCurrentAccount(makeAccount('mine'));
  setAccountOverride(makeAccount('theirs'));
  setAccountOverride(null);
  dispose();

  assert.deepEqual(seen, [null, 'mine', 'theirs', 'mine']);
});

test('getRecentAccounts is reactive: follows starring, removing and clearing', async () => {
  const { setMyAccount, setCurrentAccount, removeRecentAccount, clearRecentAccounts, getRecentAccounts } = store();
  setCurrentAccount(makeAccount('a'));
  setCurrentAccount(makeAccount('b'));
  const { seen, dispose } = await track(() => getRecentAccounts().length);

  setMyAccount(makeAccount('c'));
  removeRecentAccount('b');
  clearRecentAccounts();
  dispose();

  assert.deepEqual(seen, [2, 3, 2, 0]);
});

test('setAccountOverride: re-setting the same account id notifies nothing', async () => {
  const { setAccountOverride, getAccountOverride } = store();
  const { seen, dispose } = await track(() => getAccountOverride()?.id ?? null);

  setAccountOverride(makeAccount('theirs'));
  setAccountOverride(makeAccount('theirs'));
  setAccountOverride(null);
  setAccountOverride(null);
  dispose();

  assert.deepEqual(seen, [null, 'theirs', null]);
});

// ── accountIdentifiers ───────────────────────────────────────────────────────

test('accountIdentifiers: prefers the stored custom-URL name over the steam64 id', () => {
  const { accountIdentifiers } = store();
  const account = makeAccount('1', { vanities: { 1: 'gaben' } });
  assert.deepEqual(accountIdentifiers(account), [{ steamid: '1', identifier: 'gaben' }]);
});

test('accountIdentifiers: falls back to the steam64 id per member, including for accounts stored before vanities existed', () => {
  const { accountIdentifiers } = store();
  const family = { id: '1+2', members: ['1', '2'], rawInputs: [], vanities: { 2: 'bob' } };
  assert.deepEqual(accountIdentifiers(family), [
    { steamid: '1', identifier: '1' },
    { steamid: '2', identifier: 'bob' },
  ]);
  assert.deepEqual(accountIdentifiers(makeAccount('1')), [{ steamid: '1', identifier: '1' }]);
});

// ── accountDisplayLabel ──────────────────────────────────────────────────────

test('accountDisplayLabel: prefers the cached Steam label', () => {
  const { accountDisplayLabel } = store();
  assert.equal(accountDisplayLabel(makeAccount('1', { label: 'Alice', rawInputs: ['alice_url'] })), 'Alice');
});

test('accountDisplayLabel: falls back to what the user typed, joined for a Family', () => {
  const { accountDisplayLabel } = store();
  assert.equal(accountDisplayLabel({ id: 'a+b', members: ['a', 'b'], rawInputs: ['alice', 'bob'] }), 'alice + bob');
});

test('accountDisplayLabel: falls back to the member ids when nothing else is known', () => {
  // A `?u=` link's account before its resolve lands carries neither a label nor typed inputs.
  const { accountDisplayLabel } = store();
  assert.equal(accountDisplayLabel({ id: 'a+b', members: ['a', 'b'], rawInputs: [] }), 'a + b');
});

test('refreshAccountInfo: updates the account wherever it is stored, only when something changed', () => {
  const { setMyAccount, setCurrentAccount, getMyAccount, getCurrentAccount, getRecentAccounts, refreshAccountInfo } =
    store();
  const slot = { id: '1', members: ['1'], rawInputs: ['1'] };
  setMyAccount(slot);
  setCurrentAccount(slot);

  assert.equal(refreshAccountInfo('1', { label: 'Alice', avatarUrl: 'a.png', vanities: { 1: 'alice' } }), true);
  for (const acc of [getMyAccount(), getCurrentAccount(), getRecentAccounts()[0]]) {
    assert.equal(acc.label, 'Alice');
    assert.equal(acc.avatarUrl, 'a.png');
    assert.deepEqual(acc.vanities, { 1: 'alice' });
  }

  assert.equal(refreshAccountInfo('1', { label: 'Alice', avatarUrl: 'a.png' }), false, 'nothing new');
  assert.equal(refreshAccountInfo('1', { memberAvatars: { 1: 'b.png' } }), true);
  assert.deepEqual(getRecentAccounts()[0].memberAvatars, { 1: 'b.png' });
  assert.equal(refreshAccountInfo('1', { label: 'Alice', avatarUrl: '' }), false, 'blank never erases');
  assert.equal(refreshAccountInfo('2', { label: 'Bob' }), false, 'unknown account');
});
