'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveRef,
  resolveGameList,
  resolveListWithSources,
  flattenCombineResult,
  ListCycleError,
} = require('../public/listResolve.ts');

function set(...ids) {
  return new Set(ids);
}

function makeFetchers(overrides = {}) {
  const lists = new Map(overrides.lists ?? []);
  return {
    accountOwned: overrides.accountOwned ?? (async () => set()),
    accountWishlist: overrides.accountWishlist ?? (async () => set()),
    bundle: overrides.bundle ?? (async () => set()),
    recentGames: overrides.recentGames ?? (async () => set()),
    creator: overrides.creator ?? (async () => set()),
    gamePass: overrides.gamePass ?? (async () => set()),
    getList: (id) => lists.get(id),
  };
}

function manualList(id, appids) {
  return { id, name: id, parentId: null, order: 0, createdAt: 0, updatedAt: 0, kind: 'manual', appids };
}

function dynamicList(id, op, sources) {
  return { id, name: id, parentId: null, order: 0, createdAt: 0, updatedAt: 0, kind: 'dynamic', op, sources };
}

// ── resolveRef: leaf kinds ───────────────────────────────────────────────────────────────────

test('resolveRef: account-owned/account-wishlist/bundle/recent-games/game-pass delegate to the matching fetcher', async () => {
  const fetchers = makeFetchers({
    gamePass: async () => set(7),
    accountOwned: async (id) => (id === 'acc1' ? set(1, 2) : set()),
    accountWishlist: async (id) => (id === 'acc1' ? set(3) : set()),
    bundle: async (id) => (id === 'b1' ? set(4, 5) : set()),
    recentGames: async () => set(6),
  });

  assert.deepEqual(await resolveRef({ kind: 'account-owned', accountId: 'acc1' }, fetchers), set(1, 2));
  assert.deepEqual(await resolveRef({ kind: 'account-wishlist', accountId: 'acc1' }, fetchers), set(3));
  assert.deepEqual(await resolveRef({ kind: 'bundle', bundleId: 'b1' }, fetchers), set(4, 5));
  assert.deepEqual(await resolveRef({ kind: 'recent-games' }, fetchers), set(6));
  assert.deepEqual(await resolveRef({ kind: 'game-pass' }, fetchers), set(7));
});

test('resolveRef: a leaf ref missing its id (accountId/bundleId) resolves to an empty set without calling the fetcher', async () => {
  let called = false;
  const fetchers = makeFetchers({
    accountOwned: async () => {
      called = true;
      return set(1);
    },
  });
  const result = await resolveRef({ kind: 'account-owned' }, fetchers);
  assert.deepEqual(result, set());
  assert.equal(called, false);
});

test('resolveRef: a "user" ref to a nonexistent list resolves to an empty set (dangling reference)', async () => {
  const fetchers = makeFetchers();
  const result = await resolveRef({ kind: 'user', listId: 'ghost' }, fetchers);
  assert.deepEqual(result, set());
});

// ── resolveGameList: manual / dynamic ────────────────────────────────────────────────────────

test('resolveGameList: manual list resolves to its stored appids', async () => {
  const fetchers = makeFetchers();
  const result = await resolveGameList(manualList('m1', [1, 2, 3]), fetchers);
  assert.deepEqual(result, set(1, 2, 3));
});

// A tab opened before games outside Steam could add one to a list; lists hold Steam games only.
test('resolveGameList: a manual list drops a stored igdb key, directly and nested', async () => {
  const stale = manualList('m1', [1, 'igdb:9001', 2]);
  const fetchers = makeFetchers({ lists: [['m1', stale]] });
  assert.deepEqual(await resolveGameList(stale, fetchers), set(1, 2));
  assert.deepEqual(await resolveRef({ kind: 'user', listId: 'm1' }, fetchers), set(1, 2));
});

test('resolveGameList: dynamic union/intersect/subtract combine every source, including a nested user list', async () => {
  const a = manualList('a', [1, 2]);
  const b = manualList('b', [2, 3]);
  const fetchers = makeFetchers({
    lists: [
      ['a', a],
      ['b', b],
    ],
  });
  const sources = [
    { kind: 'user', listId: 'a' },
    { kind: 'user', listId: 'b' },
  ];

  assert.deepEqual(await resolveGameList(dynamicList('u', 'union', sources), fetchers), set(1, 2, 3));
  assert.deepEqual(await resolveGameList(dynamicList('i', 'intersect', sources), fetchers), set(2));
  assert.deepEqual(await resolveGameList(dynamicList('s', 'subtract', sources), fetchers), set(1));
});

test('resolveGameList: group-by-membership returns MembershipGroup[]', async () => {
  const a = manualList('a', [1, 2]);
  const b = manualList('b', [2, 3]);
  const fetchers = makeFetchers({
    lists: [
      ['a', a],
      ['b', b],
    ],
  });
  const result = await resolveGameList(
    dynamicList('g', 'group-by-membership', [
      { kind: 'user', listId: 'a' },
      { kind: 'user', listId: 'b' },
    ]),
    fetchers,
  );
  assert.equal(Array.isArray(result), true);
  assert.equal(
    result
      .flatMap((g) => g.appids)
      .sort()
      .join(','),
    '1,2,3',
  );
});

test('resolveGameList: a nested dynamic list contributes its flattened (not grouped) member set as a source', async () => {
  const a = manualList('a', [1]);
  const b = manualList('b', [2]);
  const nested = dynamicList('nested', 'group-by-membership', [
    { kind: 'user', listId: 'a' },
    { kind: 'user', listId: 'b' },
  ]);
  const c = manualList('c', [2, 3]);
  const fetchers = makeFetchers({
    lists: [
      ['a', a],
      ['b', b],
      ['nested', nested],
      ['c', c],
    ],
  });

  const result = await resolveGameList(
    dynamicList('top', 'intersect', [
      { kind: 'user', listId: 'nested' },
      { kind: 'user', listId: 'c' },
    ]),
    fetchers,
  );
  assert.deepEqual(result, set(2));
});

// ── Cycle backstop ───────────────────────────────────────────────────────────────────────────

test("resolveRef/resolveGameList: throws ListCycleError on a cycle that bypassed listsStore's save-time rejection", async () => {
  const a = dynamicList('a', 'union', [{ kind: 'user', listId: 'b' }]);
  const b = dynamicList('b', 'union', [{ kind: 'user', listId: 'a' }]);
  const fetchers = makeFetchers({
    lists: [
      ['a', a],
      ['b', b],
    ],
  });

  await assert.rejects(() => resolveGameList(a, fetchers), ListCycleError);
});

test('resolveRef: a pathologically deep non-cyclic chain still trips the depth safety valve', async () => {
  const lists = [];
  const DEPTH = 60;
  for (let i = 0; i < DEPTH; i++) {
    lists.push([
      `l${i}`,
      i === 0 ? manualList('l0', [1]) : dynamicList(`l${i}`, 'union', [{ kind: 'user', listId: `l${i - 1}` }]),
    ]);
  }
  const fetchers = makeFetchers({ lists });
  await assert.rejects(() => resolveGameList(lists[DEPTH - 1][1], fetchers), ListCycleError);
});

// ── flattenCombineResult ─────────────────────────────────────────────────────────────────────

test('flattenCombineResult: a Set passes through unchanged', () => {
  assert.deepEqual(flattenCombineResult(set(1, 2)), set(1, 2));
});

test("flattenCombineResult: MembershipGroup[] flattens to the union of every group's appids", () => {
  const groups = [
    { keys: ['a', 'b'], appids: [1, 2] },
    { keys: ['a'], appids: [2, 3] },
  ];
  assert.deepEqual(flattenCombineResult(groups), set(1, 2, 3));
});

// ── resolveListWithSources — what each source contributed ────────────────────────────────────

test("resolveListWithSources: reports each source's combine key and appid count, in the list's own order", async () => {
  const fetchers = makeFetchers({
    accountOwned: async () => set(1, 2, 3),
    accountWishlist: async () => set(3, 4),
  });
  const list = dynamicList('d', 'intersect', [
    { kind: 'account-owned', accountId: 'acc1' },
    { kind: 'account-wishlist', accountId: 'acc1' },
  ]);

  const { result, sources } = await resolveListWithSources(list, fetchers);
  assert.deepEqual(result, set(3));
  assert.deepEqual(sources, [
    { key: 'account-owned:acc1', count: 3 },
    { key: 'account-wishlist:acc1', count: 2 },
  ]);
});

test('resolveListWithSources: the keys match the ones combine puts on a group-by-membership group', async () => {
  const fetchers = makeFetchers({
    accountOwned: async () => set(1, 2),
    recentGames: async () => set(2),
  });
  const list = dynamicList('d', 'group-by-membership', [
    { kind: 'account-owned', accountId: 'acc1' },
    { kind: 'recent-games' },
  ]);

  const { result, sources } = await resolveListWithSources(list, fetchers);
  const keys = new Set(sources.map((s) => s.key));
  for (const group of result) {
    for (const key of group.keys) assert.ok(keys.has(key), key);
  }
});

test('resolveListWithSources: a nested user list counts as the size of what it resolved to', async () => {
  const inner = dynamicList('inner', 'union', [{ kind: 'account-owned', accountId: 'acc1' }, { kind: 'recent-games' }]);
  const fetchers = makeFetchers({
    accountOwned: async () => set(1, 2),
    recentGames: async () => set(3),
    lists: [['inner', inner]],
  });
  const outer = dynamicList('outer', 'union', [
    { kind: 'user', listId: 'inner' },
    { kind: 'account-wishlist', accountId: 'acc1' },
  ]);

  const { sources } = await resolveListWithSources(outer, fetchers);
  assert.deepEqual(sources, [
    { key: 'list:inner', count: 3 },
    { key: 'account-wishlist:acc1', count: 0 },
  ]);
});

test('resolveListWithSources: a manual list has no sources, just its stored appids', async () => {
  const { result, sources } = await resolveListWithSources(manualList('m', [7, 8]), makeFetchers());
  assert.deepEqual(result, set(7, 8));
  assert.deepEqual(sources, []);
});

test('resolveListWithSources: a dangling source contributes 0 rather than failing the resolve', async () => {
  const list = dynamicList('d', 'union', [{ kind: 'user', listId: 'gone' }, { kind: 'recent-games' }]);
  const fetchers = makeFetchers({ recentGames: async () => set(5) });

  const { result, sources } = await resolveListWithSources(list, fetchers);
  assert.deepEqual(result, set(5));
  assert.deepEqual(sources, [
    { key: 'list:gone', count: 0 },
    { key: 'recent-games', count: 1 },
  ]);
});

test('resolveListWithSources: a ranked list resolves to its one source', async () => {
  const fetchers = makeFetchers({ lists: [['m1', manualList('m1', [1, 2])]] });
  const ranked = {
    id: 'r1',
    parentId: null,
    order: 0,
    createdAt: 0,
    updatedAt: 0,
    kind: 'ranked',
    source: { kind: 'user', listId: 'm1' },
  };
  const { result, sources } = await resolveListWithSources(ranked, fetchers);
  assert.deepEqual(result, set(1, 2));
  assert.deepEqual(sources, [{ key: 'list:m1', count: 2 }]);
});

// ── developer / publisher sources ────────────────────────────────────────────────────────────

test('resolveRef: a developer/publisher source asks the creator fetcher by role and name', async () => {
  const calls = [];
  const fetchers = makeFetchers({
    creator: async (role, name) => {
      calls.push([role, name]);
      return set(7);
    },
  });
  assert.deepEqual(await resolveRef({ kind: 'developer', name: 'A' }, fetchers), set(7));
  assert.deepEqual(await resolveRef({ kind: 'publisher', name: 'B' }, fetchers), set(7));
  assert.deepEqual(calls, [
    ['developer', 'A'],
    ['publisher', 'B'],
  ]);
});

test('resolveRef: a nameless developer source resolves to an empty set without calling the fetcher', async () => {
  let called = false;
  const fetchers = makeFetchers({
    creator: async () => {
      called = true;
      return set(1);
    },
  });
  assert.deepEqual(await resolveRef({ kind: 'developer', name: '' }, fetchers), set());
  assert.equal(called, false);
});

test('resolveListWithSources: a developer source is keyed by its name', async () => {
  const list = dynamicList('d', 'union', [{ kind: 'developer', name: 'A' }]);
  const { sources } = await resolveListWithSources(list, makeFetchers({ creator: async () => set(1, 2) }));
  assert.deepEqual(sources, [{ key: 'developer:A', count: 2 }]);
});

// Recently Looked Up holds games outside Steam too; a list built from it can hold only its Steam ones.
test('createDefaultFetchers: recent games leave games outside Steam out, and say how many', async () => {
  const store = new Map();
  global.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  const recentGames = [620, 'igdb:9001', 105600, 'igdb:9004'].map((appid) => ({ appid, name: '', tinyImage: null }));
  store.set('steam.isonoe.net:prefs', JSON.stringify({ recentGames }));
  for (const m of ['prefs', 'recentGames', 'listResolve']) delete require.cache[require.resolve(`../public/${m}.ts`)];
  const { createDefaultFetchers } = require('../public/listResolve.ts');
  let leftOut;
  const fetchers = createDefaultFetchers({ onRecentLeftOut: (n) => (leftOut = n) });
  assert.deepEqual(await fetchers.recentGames(), set(620, 105600));
  assert.equal(leftOut, 2);
  delete global.localStorage;
});
