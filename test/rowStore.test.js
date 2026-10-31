'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRowStore } = require('../public/rowStore.ts');

// A minimal stand-in for a Solid store: the array itself, plus a setter that applies the
// produce()-wrapped updater to the element at `idx` — the same pair `createStore<Game[]>()`
// gives createRowStore in ListRoute.tsx, without needing a real Solid root. The real thing hands
// back store proxies rather than the raw objects, which is what makes a field write reach whoever
// renders it; nothing in rowStore.ts itself depends on that, so a plain array exercises it fully.
function fakeStore(arr) {
  return [
    arr,
    (idx, updater) => {
      arr[idx] = updater(arr[idx]);
    },
  ];
}

test('createRowStore: load() populates getRow() keyed by appid', () => {
  const [arr, set] = fakeStore([
    { appid: 1, name: 'a' },
    { appid: 2, name: 'b' },
  ]);
  const store = createRowStore(arr, set);
  store.load(arr);
  assert.deepEqual(store.getRow(1), { appid: 1, name: 'a' });
  assert.deepEqual(store.getRow(2), { appid: 2, name: 'b' });
});

test('createRowStore: an igdb key indexes its row beside appids', () => {
  const [arr, set] = fakeStore([
    { appid: 1, name: 'a' },
    { appid: 'igdb:1', name: 'b' },
  ]);
  const store = createRowStore(arr, set);
  store.load(arr);
  assert.equal(store.getRow('igdb:1').name, 'b');
  assert.equal(store.getRow(1).name, 'a');
});

test("createRowStore: getRow() hands back the store's own row, not a copy of it", () => {
  const [arr, set] = fakeStore([{ appid: 1, name: 'a' }]);
  const store = createRowStore(arr, set);
  store.load(arr);
  assert.equal(store.getRow(1), arr[0]);
});

test('createRowStore: mutateRow() applies fn to the row and returns it', () => {
  const [arr, set] = fakeStore([{ appid: 1, name: 'a' }]);
  const store = createRowStore(arr, set);
  store.load(arr);
  const returned = store.mutateRow(1, (draft) => {
    draft.name = 'updated';
  });
  assert.equal(arr[0].name, 'updated');
  assert.equal(store.getRow(1).name, 'updated');
  assert.equal(returned, store.getRow(1));
});

test('createRowStore: mutateRow() on an appid not in rowIndex returns undefined and touches nothing', () => {
  const [arr, set] = fakeStore([{ appid: 1, name: 'a' }]);
  const store = createRowStore(arr, set);
  store.load(arr);
  const result = store.mutateRow(999, (draft) => {
    draft.name = 'should not happen';
  });
  assert.equal(result, undefined);
  assert.equal(arr[0].name, 'a');
});

test('createRowStore: reset() clears the index', () => {
  const [arr, set] = fakeStore([{ appid: 1, name: 'a' }]);
  const store = createRowStore(arr, set);
  store.load(arr);
  store.reset();
  assert.equal(store.getRow(1), undefined);
});

test('createRowStore: getRow() before any load() returns undefined', () => {
  const [arr, set] = fakeStore([]);
  assert.equal(createRowStore(arr, set).getRow(1), undefined);
});

test('createRowStore: load() warns once on a duplicate appid, naming it', () => {
  const [arr, set] = fakeStore([
    { appid: 1, name: 'a' },
    { appid: 1, name: 'b (dup)' },
    { appid: 2, name: 'c' },
  ]);
  const store = createRowStore(arr, set);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    store.load(arr);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /duplicate appid.*: 1/);
});

test('createRowStore: load() does not warn when every appid is unique', () => {
  const [arr, set] = fakeStore([
    { appid: 1, name: 'a' },
    { appid: 2, name: 'b' },
  ]);
  const store = createRowStore(arr, set);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    store.load(arr);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 0);
});
