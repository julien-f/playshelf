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

function store() {
  return require('../public/listsStore.ts');
}

// ── Folders ──────────────────────────────────────────────────────────────────────────────────

test('createFolder: adds a root folder with order 0', () => {
  const { createFolder, getFolders } = store();
  const f = createFolder('Favorites');
  assert.equal(f.parentId, null);
  assert.equal(f.order, 0);
  assert.deepEqual(getFolders(), [f]);
});

test('createFolder: siblings get increasing order, folders and lists share the same numbering', () => {
  const { createFolder, createList } = store();
  const f1 = createFolder('A');
  const l1 = createList({ name: 'B', kind: 'manual' });
  const f2 = createFolder('C');
  assert.deepEqual([f1.order, l1.order, f2.order], [0, 1, 2]);
});

test('renameFolder: updates the name in place, leaves order/id untouched', () => {
  const { createFolder, renameFolder, getFolders } = store();
  const f = createFolder('Old name');
  renameFolder(f.id, 'New name');
  const updated = getFolders().find((f) => f.id === f.id);
  assert.equal(updated.name, 'New name');
  assert.equal(updated.order, f.order);
});

test('moveFolder: reparents and reorders to the end of the new parent', () => {
  const { createFolder, moveFolder, getFolders } = store();
  const root2 = createFolder('Root 2');
  const child = createFolder('Child');
  moveFolder(child.id, root2.id);
  assert.equal(getFolders().find((f) => f.id === child.id).parentId, root2.id);
});

test('moveFolder: refuses to move a folder into itself', () => {
  const { createFolder, moveFolder } = store();
  const f = createFolder('A');
  assert.throws(() => moveFolder(f.id, f.id), /itself/);
});

test('moveFolder: refuses to move a folder into its own descendant', () => {
  const { createFolder, moveFolder } = store();
  const grandparent = createFolder('Grandparent');
  const parent = createFolder('Parent', grandparent.id);
  const child = createFolder('Child', parent.id);
  assert.throws(() => moveFolder(grandparent.id, child.id), /descendant/);
});

test('deleteFolder("promote"): moves child folders and lists up to the deleted folder\'s parent', () => {
  const { createFolder, createList, deleteFolder, getList, getFolders } = store();
  const root = createFolder('Root');
  const mid = createFolder('Mid', root.id);
  const childFolder = createFolder('ChildFolder', mid.id);
  const childList = createList({ name: 'ChildList', kind: 'manual', parentId: mid.id });

  deleteFolder(mid.id, 'promote');

  assert.equal(
    getFolders().some((f) => f.id === mid.id),
    false,
  );
  assert.equal(getFolders().find((f) => f.id === childFolder.id).parentId, root.id);
  assert.equal(getList(childList.id).parentId, root.id);
});

test('deleteFolder("delete"): recursively deletes child folders and applies deleteList\'s soft-delete rule to child lists', () => {
  const { createFolder, createList, deleteFolder, getFolders, getList, getLists } = store();
  const mid = createFolder('Mid');
  const childFolder = createFolder('ChildFolder', mid.id);
  const plainList = createList({ name: 'PlainList', kind: 'manual', parentId: mid.id });
  // A list still referenced by a dynamic list outside the folder must survive as soft-deleted.
  const referenced = createList({ name: 'Referenced', kind: 'manual', parentId: mid.id });
  createList({
    name: 'Watcher',
    kind: 'dynamic',
    op: 'union',
    sources: [{ kind: 'user', listId: referenced.id }],
  });

  deleteFolder(mid.id, 'delete');

  assert.equal(
    getFolders().some((f) => f.id === mid.id || f.id === childFolder.id),
    false,
  );
  assert.equal(
    getLists().some((l) => l.id === plainList.id),
    false,
  );
  assert.equal(getList(referenced.id)?.deletedAt !== undefined, true);
});

// ── List CRUD ────────────────────────────────────────────────────────────────────────────────

test('createList: manual list stores appids, defaults to root/order 0', () => {
  const { createList } = store();
  const l = createList({ name: 'Backlog', kind: 'manual', appids: [10, 20] });
  assert.equal(l.kind, 'manual');
  assert.deepEqual(l.appids, [10, 20]);
  assert.equal(l.parentId, null);
});

// ── addAppidsToList / removeAppidsFromList (row-selection-based add/remove-to-list) ───────────

test('addAppidsToList: unions new appids into a manual list, deduping against what is already there', () => {
  const { createList, addAppidsToList, getList } = store();
  const l = createList({ name: 'Backlog', kind: 'manual', appids: [1, 2] });
  addAppidsToList(l.id, [2, 3]);
  const updated = getList(l.id);
  assert.deepEqual([...updated.appids].sort(), [1, 2, 3]);
  assert.ok(updated.updatedAt >= l.updatedAt);
});

test('addAppidsToList: adding to an empty manual list just sets it', () => {
  const { createList, addAppidsToList, getList } = store();
  const l = createList({ name: 'Backlog', kind: 'manual' });
  addAppidsToList(l.id, [10, 20]);
  assert.deepEqual([...getList(l.id).appids].sort(), [10, 20]);
});

test('addAppidsToList: no-ops on a dynamic list', () => {
  const { createList, addAppidsToList, getList } = store();
  const l = createList({ name: 'Combo', kind: 'dynamic', op: 'union', sources: [] });
  addAppidsToList(l.id, [1]);
  assert.equal(getList(l.id).appids, undefined);
});

test('addAppidsToList: no-ops on a missing list id', () => {
  const { addAppidsToList, getList } = store();
  addAppidsToList('does-not-exist', [1]);
  assert.equal(getList('does-not-exist'), undefined);
});

test('removeAppidsFromList: subtracts appids from a manual list', () => {
  const { createList, removeAppidsFromList, getList } = store();
  const l = createList({ name: 'Backlog', kind: 'manual', appids: [1, 2, 3] });
  removeAppidsFromList(l.id, [2]);
  assert.deepEqual([...getList(l.id).appids].sort(), [1, 3]);
});

test('removeAppidsFromList: removing an appid not in the list is a harmless no-op on the contents', () => {
  const { createList, removeAppidsFromList, getList } = store();
  const l = createList({ name: 'Backlog', kind: 'manual', appids: [1, 2] });
  removeAppidsFromList(l.id, [999]);
  assert.deepEqual([...getList(l.id).appids].sort(), [1, 2]);
});

test('removeAppidsFromList: no-ops on a dynamic list', () => {
  const { createList, removeAppidsFromList, getList } = store();
  const l = createList({ name: 'Combo', kind: 'dynamic', op: 'union', sources: [] });
  removeAppidsFromList(l.id, [1]);
  assert.equal(getList(l.id).appids, undefined);
});

test('renameList/moveList: update name/parentId independently', () => {
  const { createFolder, createList, renameList, moveList, getList } = store();
  const folder = createFolder('Folder');
  const l = createList({ name: 'Old', kind: 'manual' });
  renameList(l.id, 'New');
  moveList(l.id, folder.id);
  const updated = getList(l.id);
  assert.equal(updated.name, 'New');
  assert.equal(updated.parentId, folder.id);
});

test('createList: a dynamic list can be created with no name at all (labeled by its formula instead)', () => {
  const { createList, getList } = store();
  const l = createList({ kind: 'dynamic', op: 'union', sources: [{ kind: 'recent-games' }] });
  assert.equal('name' in getList(l.id), false);
});

test('createList: rejects an unknown op, an inherited Object key included, and stores nothing', () => {
  const { createList, getLists } = store();
  for (const op of ['constructor', 'toString', 'nope']) {
    assert.throws(() => createList({ kind: 'dynamic', op, sources: [{ kind: 'recent-games' }] }), /unknown op/);
  }
  assert.deepEqual(getLists(), []);
});

test('renameList: an undefined name clears the field, rather than storing an empty one', () => {
  const { createList, renameList, getList } = store();
  const l = createList({ name: 'Named', kind: 'dynamic', op: 'union', sources: [{ kind: 'recent-games' }] });
  renameList(l.id, undefined);
  assert.equal('name' in getList(l.id), false);
});

// ── Cycle detection ──────────────────────────────────────────────────────────────────────────

test('createList: rejects a dynamic list whose sources reference itself indirectly (would-be self-ref via a fresh id is impossible; covered by updateDynamicList below), but accepts a valid multi-source combine', () => {
  const { createList } = store();
  const a = createList({ name: 'A', kind: 'manual', appids: [1] });
  const b = createList({ name: 'B', kind: 'manual', appids: [2] });
  const combo = createList({
    name: 'Combo',
    kind: 'dynamic',
    op: 'union',
    sources: [
      { kind: 'user', listId: a.id },
      { kind: 'user', listId: b.id },
    ],
  });
  assert.equal(combo.sources.length, 2);
});

test('updateDynamicList: rejects a direct cycle (A depends on B, B depends on A)', () => {
  const { createList, updateDynamicList } = store();
  const a = createList({ name: 'A', kind: 'dynamic', op: 'union', sources: [] });
  const b = createList({
    name: 'B',
    kind: 'dynamic',
    op: 'union',
    sources: [{ kind: 'user', listId: a.id }],
  });
  assert.throws(() => updateDynamicList(a.id, 'union', [{ kind: 'user', listId: b.id }]), /cycle/i);
});

test('updateDynamicList: rejects a multi-hop cycle (A -> B -> C -> A)', () => {
  const { createList, updateDynamicList } = store();
  const a = createList({ name: 'A', kind: 'dynamic', op: 'union', sources: [] });
  const b = createList({
    name: 'B',
    kind: 'dynamic',
    op: 'union',
    sources: [{ kind: 'user', listId: a.id }],
  });
  const c = createList({
    name: 'C',
    kind: 'dynamic',
    op: 'union',
    sources: [{ kind: 'user', listId: b.id }],
  });
  assert.throws(() => updateDynamicList(a.id, 'union', [{ kind: 'user', listId: c.id }]), /cycle/i);
});

test('updateDynamicList: a non-cyclic edit (e.g. adding an unrelated list) succeeds', () => {
  const { createList, updateDynamicList, getList } = store();
  const a = createList({ name: 'A', kind: 'manual', appids: [1] });
  const b = createList({ name: 'B', kind: 'manual', appids: [2] });
  const combo = createList({
    name: 'Combo',
    kind: 'dynamic',
    op: 'union',
    sources: [{ kind: 'user', listId: a.id }],
  });
  updateDynamicList(combo.id, 'intersect', [
    { kind: 'user', listId: a.id },
    { kind: 'user', listId: b.id },
  ]);
  const updated = getList(combo.id);
  assert.equal(updated.op, 'intersect');
  assert.equal(updated.sources.length, 2);
});

test('createList/updateDynamicList: non-user source kinds (account/bundle/recent-games) never trigger cycle detection', () => {
  const { createList } = store();
  const combo = createList({
    name: 'Combo',
    kind: 'dynamic',
    op: 'union',
    sources: [
      { kind: 'account-owned', accountId: 'acc1' },
      { kind: 'bundle', bundleId: 'b1' },
      { kind: 'recent-games' },
    ],
  });
  assert.equal(combo.sources.length, 3);
});

// ── Soft-delete / restore ────────────────────────────────────────────────────────────────────

test('deleteList: hard-removes a list nothing references', () => {
  const { createList, deleteList, getList } = store();
  const l = createList({ name: 'Standalone', kind: 'manual' });
  const result = deleteList(l.id);
  assert.equal(result.softDeleted, false);
  assert.equal(getList(l.id), undefined);
});

test('deleteList: soft-deletes a list still referenced by a dynamic list, hides it from getLists() by default', () => {
  const { createList, deleteList, getList, getLists } = store();
  const source = createList({ name: 'Source', kind: 'manual', appids: [1] });
  createList({ name: 'Watcher', kind: 'dynamic', op: 'union', sources: [{ kind: 'user', listId: source.id }] });

  const result = deleteList(source.id);
  assert.equal(result.softDeleted, true);
  assert.ok(getList(source.id).deletedAt);
  assert.equal(
    getLists().some((l) => l.id === source.id),
    false,
  );
  assert.equal(getList(source.id) !== undefined, true);
});

test('dropping the last reference to a soft-deleted list purges it, and leaves a still-referenced one', () => {
  const { createList, deleteList, updateDynamicList, sweepDeletedLists, getList } = store();
  const source = createList({ name: 'Source', kind: 'manual', appids: [1] });
  const stillReferenced = createList({ name: 'StillReferenced', kind: 'manual', appids: [2] });
  const watcher = createList({
    name: 'Watcher',
    kind: 'dynamic',
    op: 'union',
    sources: [
      { kind: 'user', listId: source.id },
      { kind: 'user', listId: stillReferenced.id },
    ],
  });
  deleteList(source.id);
  deleteList(stillReferenced.id);

  // Drop the watcher's reference to `source` only — `stillReferenced` stays referenced.
  updateDynamicList(watcher.id, 'union', [{ kind: 'user', listId: stillReferenced.id }]);

  // updateDynamicList sweeps on its own; nothing is left for an explicit sweep.
  assert.equal(sweepDeletedLists(), 0);
  assert.equal(getList(source.id) !== undefined, false);
  assert.equal(getList(stillReferenced.id) !== undefined, true);
});

test('a soft-deleted list keeps its sources: deleting along a chain soft-deletes, and the sweep purges it head-first', () => {
  const { createList, deleteList, getList } = store();
  const a = createList({ name: 'A', kind: 'manual', appids: [1] });
  const b = createList({ name: 'B', kind: 'dynamic', op: 'union', sources: [{ kind: 'user', listId: a.id }] });
  const c = createList({ name: 'C', kind: 'dynamic', op: 'union', sources: [{ kind: 'user', listId: b.id }] });

  assert.equal(deleteList(b.id).softDeleted, true);
  // B still resolves for C, so A must stay too.
  assert.equal(deleteList(a.id).softDeleted, true);
  assert.ok(getList(a.id));

  // Deleting C leaves an all-deleted chain, purged entirely.
  assert.equal(deleteList(c.id).softDeleted, false);
  assert.equal(getList(b.id), undefined);
  assert.equal(getList(a.id), undefined);
});

// ── isAccountReferenced (used by accountsStore.ts)───────────────────────────────────────────

test('isAccountReferenced: true only while a dynamic list references that accountId', () => {
  const { createList, isAccountReferenced, updateDynamicList } = store();
  assert.equal(isAccountReferenced('acc1'), false);
  const watcher = createList({
    name: 'Watcher',
    kind: 'dynamic',
    op: 'union',
    sources: [{ kind: 'account-owned', accountId: 'acc1' }],
  });
  assert.equal(isAccountReferenced('acc1'), true);
  updateDynamicList(watcher.id, 'union', []);
  assert.equal(isAccountReferenced('acc1'), false);
});

// ── Ranked lists ─────────────────────────────────────────────────────────────────────────────

test('createList: a ranked list stores its one source, and counts as referencing it', () => {
  const { createList, getList, isListReferenced, isAccountReferenced } = store();
  const src = createList({ name: 'Src', kind: 'manual', appids: [1] });
  const ranked = createList({ kind: 'ranked', source: { kind: 'user', listId: src.id } });
  assert.deepEqual(getList(ranked.id).source, { kind: 'user', listId: src.id });
  assert.equal(isListReferenced(src.id), true);
  createList({ kind: 'ranked', source: { kind: 'account-owned', accountId: 'acc1' } });
  assert.equal(isAccountReferenced('acc1'), true);
});

test('updateRankedSource: rejects a cycle through a ranked list', () => {
  const { createList, updateRankedSource, CycleError } = store();
  const ranked = createList({ kind: 'ranked', source: { kind: 'recent-games' } });
  const dyn = createList({
    kind: 'dynamic',
    op: 'union',
    sources: [{ kind: 'user', listId: ranked.id }, { kind: 'recent-games' }],
  });
  assert.throws(() => updateRankedSource(ranked.id, { kind: 'user', listId: dyn.id }), CycleError);
});

test('getRanking/setRanking: empty by default, round-trips, and is dropped with the list', () => {
  const { createList, getRanking, setRanking, deleteList } = store();
  const ranked = createList({ kind: 'ranked', source: { kind: 'recent-games' } });
  assert.deepEqual(getRanking(ranked.id), { groups: [], excluded: [], skipped: [] });
  setRanking(ranked.id, { groups: [[1]], excluded: [], skipped: [] });
  assert.deepEqual(getRanking(ranked.id).groups, [[1]]);
  deleteList(ranked.id);
  assert.deepEqual(getRanking(ranked.id).groups, []);
  assert.equal(require('../public/prefs.ts').getPref(`ranking:${ranked.id}`), null);
});

test('folderPaths: every folder with its full path, in tree order', () => {
  const { createFolder, folderPaths } = store();
  const games = createFolder('Games');
  const coop = createFolder('Co-op', games.id);
  const later = createFolder('Later');
  assert.deepEqual(folderPaths(), [
    { id: games.id, path: 'Games' },
    { id: coop.id, path: 'Games / Co-op' },
    { id: later.id, path: 'Later' },
  ]);
});

test('listHasPriceSource: a wishlist or bundle source, at any depth, has prices', () => {
  const { createList, getList, listHasPriceSource } = store();
  const wish = createList({ kind: 'dynamic', op: 'union', sources: [{ kind: 'account-wishlist', accountId: 'a' }] });
  const ranked = createList({ kind: 'ranked', source: { kind: 'user', listId: wish.id } });
  const bundle = createList({ kind: 'ranked', source: { kind: 'bundle', bundleId: '1' } });
  const owned = createList({ kind: 'dynamic', op: 'union', sources: [{ kind: 'account-owned', accountId: 'a' }] });
  const manual = createList({ name: 'M', kind: 'manual', appids: [1] });
  const creator = createList({ kind: 'ranked', source: { kind: 'publisher', name: 'P' } });
  assert.equal(listHasPriceSource(creator, getList), true);
  assert.equal(listHasPriceSource(createList({ kind: 'ranked', source: { kind: 'game-pass' } }), getList), true);
  assert.equal(listHasPriceSource(wish, getList), true);
  assert.equal(listHasPriceSource(ranked, getList), true);
  assert.equal(listHasPriceSource(bundle, getList), true);
  assert.equal(listHasPriceSource(owned, getList), false);
  assert.equal(listHasPriceSource(manual, getList), false);
});

test('listHasRefreshableSource: an account library or wishlist or a store search, at any depth, through the given lookup', () => {
  const { createList, getList, listHasRefreshableSource } = store();
  const owned = createList({ kind: 'dynamic', op: 'union', sources: [{ kind: 'account-owned', accountId: 'a' }] });
  const ranked = createList({ kind: 'ranked', source: { kind: 'user', listId: owned.id } });
  const bundle = createList({ kind: 'ranked', source: { kind: 'bundle', bundleId: '1' } });
  const manual = createList({ name: 'M', kind: 'manual', appids: [1] });
  assert.equal(listHasRefreshableSource(owned, getList), true);
  assert.equal(listHasRefreshableSource(ranked, getList), true);
  assert.equal(listHasRefreshableSource(bundle, getList), false);
  assert.equal(listHasRefreshableSource(manual, getList), false);
  const creator = createList({ kind: 'ranked', source: { kind: 'developer', name: 'D' } });
  assert.equal(listHasRefreshableSource(creator, getList), true);
  const gamePass = createList({ kind: 'ranked', source: { kind: 'game-pass' } });
  assert.equal(listHasRefreshableSource(gamePass, getList), true);
  // A shared formula's inlined groups aren't stored: they're found through the caller's lookup.
  const synthetic = { id: 'g1', kind: 'dynamic', op: 'union', sources: [{ kind: 'account-wishlist', accountId: 'a' }] };
  const shared = { id: '', kind: 'dynamic', op: 'union', sources: [{ kind: 'user', listId: 'g1' }] };
  assert.equal(listHasRefreshableSource(shared, getList), false);
  assert.equal(
    listHasRefreshableSource(shared, (id) => (id === 'g1' ? synthetic : undefined)),
    true,
  );
});

test('listHasGamePassSource: PC Game Pass at any depth', () => {
  const { createList, getList, listHasGamePassSource } = store();
  const gamePass = createList({
    kind: 'dynamic',
    op: 'intersect',
    sources: [{ kind: 'game-pass' }, { kind: 'recent-games' }],
  });
  const ranked = createList({ kind: 'ranked', source: { kind: 'user', listId: gamePass.id } });
  const recent = createList({ kind: 'ranked', source: { kind: 'recent-games' } });
  assert.equal(listHasGamePassSource(ranked, getList), true);
  assert.equal(listHasGamePassSource(recent, getList), false);
});

test('rankingsOf: the ranked lists ordering the same source', () => {
  const { createList, rankingsOf } = store();
  const wish = { kind: 'account-wishlist', accountId: 'a' };
  const one = createList({ kind: 'ranked', source: wish });
  const two = createList({ name: 'Ranking (co-op)', kind: 'ranked', source: { ...wish } });
  createList({ kind: 'ranked', source: { kind: 'account-owned', accountId: 'a' } });
  createList({ kind: 'dynamic', op: 'union', sources: [wish] });
  assert.deepEqual(
    rankingsOf(wish).map((l) => l.id),
    [one.id, two.id],
  );
  const dev = createList({ kind: 'ranked', source: { kind: 'developer', name: 'A' } });
  createList({ kind: 'ranked', source: { kind: 'developer', name: 'B' } });
  assert.deepEqual(
    rankingsOf({ kind: 'developer', name: 'A' }).map((l) => l.id),
    [dev.id],
  );
});

test('setListTableView: stores the view without page/searchQuery', () => {
  const { createList, setListTableView, getList } = store();
  const list = createList({ name: 'M', kind: 'manual' });
  setListTableView(list.id, { sorts: [{ key: 'name', dir: 'asc' }], page: 3, searchQuery: 'half' });
  assert.deepEqual(getList(list.id).tableView, { sorts: [{ key: 'name', dir: 'asc' }] });
});

test('setListTableView: an unchanged view leaves the lists pref untouched', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const { createList, setListTableView } = store();
  const { getAllPrefEntries } = require('../public/prefs.ts');
  const list = createList({ name: 'M', kind: 'manual' });
  setListTableView(list.id, { sorts: [{ key: 'name', dir: 'asc' }] });
  t.mock.timers.tick(1000);
  setListTableView(list.id, { sorts: [{ key: 'name', dir: 'asc' }], page: 2, searchQuery: 'x' });
  assert.equal(getAllPrefEntries().lists.updatedAt, 1000);
});
