'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { storageGet, storageSet } = require('../public/safeStorage.ts');

function withStorage(t, storage) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: storage });
  t.after(() => (had ? Object.defineProperty(globalThis, 'sessionStorage', had) : delete globalThis.sessionStorage));
}

test('storageGet/storageSet: read, write and remove through the storage', (t) => {
  const items = new Map();
  const store = {
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => items.set(k, v),
    removeItem: (k) => items.delete(k),
  };
  withStorage(t, () => store);
  assert.equal(storageGet('sessionStorage', 'k'), null);
  assert.equal(storageSet('sessionStorage', 'k', 'v'), true);
  assert.equal(storageGet('sessionStorage', 'k'), 'v');
  assert.equal(storageSet('sessionStorage', 'k', null), true);
  assert.equal(items.has('k'), false);
});

test('storageGet/storageSet: storage that throws on access reads as unset and refuses writes', (t) => {
  withStorage(t, () => {
    throw new Error('SecurityError');
  });
  assert.equal(storageGet('sessionStorage', 'k'), null);
  assert.equal(storageSet('sessionStorage', 'k', 'v'), false);
  assert.equal(storageSet('sessionStorage', 'k', null), false);
});
