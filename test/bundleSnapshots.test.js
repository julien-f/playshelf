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
});

const snapshots = () => require('../public/bundleSnapshots.ts');

test('rememberBundle: stores the title and a sorted, deduplicated appid list', () => {
  const { rememberBundle, getBundleSnapshot } = snapshots();
  rememberBundle('7', 'Pack', [30, 10, 30, 20]);
  const snap = getBundleSnapshot('7');
  assert.equal(snap.title, 'Pack');
  assert.deepEqual(snap.appids, [10, 20, 30]);
  assert.equal(typeof snap.seenAt, 'number');
});

test('rememberBundle: an unchanged bundle writes nothing', () => {
  const { rememberBundle } = snapshots();
  rememberBundle('7', 'Pack', [1, 2]);
  const before = localStorage.getItem('steam.isonoe.net:prefs');
  rememberBundle('7', 'Pack', new Set([2, 1]));
  assert.equal(localStorage.getItem('steam.isonoe.net:prefs'), before);
});

test('rememberBundle: a changed bundle replaces its snapshot', () => {
  const { rememberBundle, getBundleSnapshot } = snapshots();
  rememberBundle('7', 'Pack', [1]);
  rememberBundle('7', 'Pack (updated)', [1, 2]);
  assert.deepEqual(getBundleSnapshot('7'), { ...getBundleSnapshot('7'), title: 'Pack (updated)', appids: [1, 2] });
});

test('pruneBundleSnapshots: keeps only the bundles asked for', () => {
  const { rememberBundle, pruneBundleSnapshots, getBundleSnapshot } = snapshots();
  rememberBundle('1', 'A', [1]);
  rememberBundle('2', 'B', [2]);
  assert.equal(pruneBundleSnapshots(new Set(['2'])), 1);
  assert.equal(getBundleSnapshot('1'), undefined);
  assert.equal(getBundleSnapshot('2').title, 'B');
  assert.equal(pruneBundleSnapshots(new Set(['2'])), 0);
});
