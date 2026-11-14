'use strict';

// The lifecycle of a bundle used as a saved list's source: snapshot, orphan list, sweep.
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

function load() {
  return {
    ...require('../public/listsStore.ts'),
    ...require('../public/bundleSnapshots.ts'),
    ...require('../public/listResolve.ts'),
    BundleNotFoundError: require('../public/bundleData.ts').BundleNotFoundError,
  };
}

const BUNDLE = { kind: 'bundle', bundleId: '7' };
const OWNED = { kind: 'account-owned', accountId: '1' };

test('orphanBundle: re-points every source at a hidden list of the last-known games', () => {
  const m = load();
  const dynamic = m.createList({ kind: 'dynamic', op: 'subtract', sources: [BUNDLE, OWNED] });
  const ranked = m.createList({ kind: 'ranked', source: BUNDLE });
  m.rememberBundle('7', 'Pack', [3, 1]);

  const orphan = m.orphanBundle('7');
  assert.equal(orphan.name, 'Pack (no longer listed)');
  assert.equal(orphan.kind, 'manual');
  assert.deepEqual(orphan.appids, [1, 3]);
  assert.ok(orphan.deletedAt, 'hidden from the tree');
  assert.deepEqual(orphan.orphanOf, { bundleId: '7' });
  const ref = { kind: 'user', listId: orphan.id };
  assert.deepEqual(m.getList(dynamic.id).sources, [ref, OWNED]);
  assert.deepEqual(m.getList(ranked.id).source, ref);
  assert.equal(m.getBundleSnapshot('7'), undefined, 'no list uses the bundle any more');
});

test('orphanBundle: nothing to keep without a snapshot, or without a list using the bundle', () => {
  const m = load();
  m.createList({ kind: 'dynamic', op: 'union', sources: [BUNDLE, OWNED] });
  assert.equal(m.orphanBundle('7'), undefined);
  m.rememberBundle('8', 'Other', [1]);
  assert.equal(m.orphanBundle('8'), undefined);
});

test('the orphan is purged once the last list using it goes', () => {
  const m = load();
  const a = m.createList({ kind: 'dynamic', op: 'union', sources: [BUNDLE, OWNED] });
  const b = m.createList({ kind: 'dynamic', op: 'union', sources: [BUNDLE, OWNED] });
  m.rememberBundle('7', 'Pack', [1]);
  const orphan = m.orphanBundle('7');

  m.deleteList(a.id);
  assert.ok(m.getList(orphan.id), 'still used by b');
  m.updateDynamicList(b.id, 'union', [OWNED]);
  assert.equal(m.getList(orphan.id), undefined);
});

test('sweepDeletedLists: runs until stable and prunes unused bundle snapshots', () => {
  const m = load();
  const inner = m.createList({ kind: 'manual', appids: [1] });
  const middle = m.createList({ kind: 'dynamic', op: 'union', sources: [{ kind: 'user', listId: inner.id }, BUNDLE] });
  const outer = m.createList({ kind: 'dynamic', op: 'union', sources: [{ kind: 'user', listId: middle.id }, OWNED] });
  m.rememberBundle('7', 'Pack', [1]);
  m.deleteList(inner.id);
  m.deleteList(middle.id);
  assert.ok(m.getList(inner.id) && m.getList(middle.id), 'both kept while outer uses middle');

  m.deleteList(outer.id);
  assert.equal(m.getList(middle.id), undefined);
  assert.equal(m.getList(inner.id), undefined, 'purged in the same sweep');
  assert.equal(m.getBundleSnapshot('7'), undefined);
});

test('resolveBundleSource: a successful fetch refreshes the snapshot of a bundle in use', async () => {
  const m = load();
  m.createList({ kind: 'dynamic', op: 'union', sources: [BUNDLE, OWNED] });
  const appids = await m.resolveBundleSource('7', async () => ({ title: 'Pack', appids: new Set([2, 1]) }));
  assert.deepEqual(appids, new Set([1, 2]));
  assert.deepEqual(m.getBundleSnapshot('7').appids, [1, 2]);
  await m.resolveBundleSource('9', async () => ({ title: 'Unused', appids: new Set([5]) }));
  assert.equal(m.getBundleSnapshot('9'), undefined, 'not stored for a bundle no list uses');
});

test("resolveBundleSource: games that failed to resolve stand in from the snapshot, which isn't overwritten", async () => {
  const m = load();
  m.createList({ kind: 'dynamic', op: 'union', sources: [BUNDLE, OWNED] });
  m.rememberBundle('7', 'Pack', [1, 2]);
  const appids = await m.resolveBundleSource('7', async () => ({ title: 'Pack', appids: new Set([1]), failed: 1 }));
  assert.deepEqual(appids, new Set([1, 2]));
  assert.deepEqual(m.getBundleSnapshot('7').appids, [1, 2]);
});

test('resolveBundleSource: a 404 orphans the bundle and still returns its last-known games', async () => {
  const m = load();
  const list = m.createList({ kind: 'dynamic', op: 'union', sources: [BUNDLE, OWNED] });
  m.rememberBundle('7', 'Pack', [4]);
  const appids = await m.resolveBundleSource('7', async () => {
    throw new m.BundleNotFoundError('gone');
  });
  assert.deepEqual(appids, new Set([4]));
  assert.equal(m.getList(list.id).sources[0].kind, 'user');
});

test('resolveBundleSource: any other failure falls back to the snapshot, or rethrows without one', async () => {
  const m = load();
  m.createList({ kind: 'dynamic', op: 'union', sources: [BUNDLE, OWNED] });
  const failing = async () => {
    throw new Error('502');
  };
  await assert.rejects(m.resolveBundleSource('7', failing), /502/);
  m.rememberBundle('7', 'Pack', [4]);
  assert.deepEqual(await m.resolveBundleSource('7', failing), new Set([4]));
  assert.equal(m.getList(m.getLists()[0].id).sources[0].kind, 'bundle', 'not orphaned');
});

test("resolveBundleSource: reports how many of the bundle's games have no Steam listing", async () => {
  const m = load();
  const reported = [];
  await m.resolveBundleSource(
    '7',
    async () => ({ title: 'Pack', appids: new Set([1]), notOnSteam: 3 }),
    (id, n) => reported.push([id, n]),
  );
  await m.resolveBundleSource(
    '8',
    async () => ({ title: 'All on Steam', appids: new Set([2]), notOnSteam: 0 }),
    (id, n) => reported.push([id, n]),
  );
  assert.deepEqual(reported, [['7', 3]]);
});
