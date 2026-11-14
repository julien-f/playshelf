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
  // The override is in-memory module state, which a new localStorage doesn't clear.
  require('../public/accountsStore.ts').setAccountOverride(null);
});

const mod = () => require('../public/gameStatuses.ts');
const accounts = () => require('../public/accountsStore.ts');
const slot = (...members) => ({ id: members.slice().sort().join(','), members, rawInputs: members });

test('getStatus: null for a game never marked', () => {
  assert.equal(mod().getStatus(620), null);
});

test('setStatus: sets, replaces and clears a status, storing one letter per game', () => {
  const { getStatus, setStatus } = mod();
  setStatus(620, 'finished');
  assert.equal(getStatus(620), 'finished');
  setStatus(620, 'abandoned');
  setStatus(400, 'finished');
  assert.equal(getStatus(620), 'abandoned');
  assert.deepEqual(require('../public/prefs.ts').getPref('gameStatuses'), { 620: 'a', 400: 'f' });
  setStatus(620, null);
  assert.equal(getStatus(620), null);
  assert.deepEqual(require('../public/prefs.ts').getPref('gameStatuses'), { 400: 'f' });
});

test('showingMyAccount: with no ★ account, the stored current account but not a ?u= link', () => {
  const { setCurrentAccount, setAccountOverride } = accounts();
  assert.equal(accounts().showingMyAccount(), false);
  setCurrentAccount(slot('1'));
  assert.equal(accounts().showingMyAccount(), true);
  setAccountOverride(slot('2'));
  assert.equal(accounts().showingMyAccount(), false);
});

test('showingMyAccount: the ★ account, a Family with it, even from a link; not someone else', () => {
  const { setMyAccount, setCurrentAccount, setAccountOverride } = accounts();
  setMyAccount(slot('1'));
  setCurrentAccount(slot('2'));
  assert.equal(accounts().showingMyAccount(), false);
  setCurrentAccount(slot('1', '3'));
  assert.equal(accounts().showingMyAccount(), true);
  setAccountOverride(slot('1'));
  assert.equal(accounts().showingMyAccount(), true);
  setAccountOverride(slot('2'));
  assert.equal(accounts().showingMyAccount(), false);
});
