'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  describeListRef,
  describeSources,
  formatFormula,
  listDisplayName,
  opLabel,
  OP_SYMBOLS,
  OP_DESCRIPTIONS,
} = require('../public/listLabels.ts');
const { makeMemoryLocalStorage } = require('./memoryStorage.js');
const { OP_LABELS } = require('../public/combine.ts');

// The injected half of ListNaming (see listLabels.ts) — the real one reads accountsStore.ts/
// listsStore.ts, which is exactly what these tests don't want to need.
function makeNaming({ accounts = {}, lists = {} } = {}) {
  return {
    account: (id) => accounts[id] ?? null,
    list: (id) => lists[id] ?? null,
  };
}

const NAMING = makeNaming({
  accounts: {
    acc1: { label: 'Alice', identifiers: ['76561190000000001'] },
    fam: { label: 'Alice + Bob', identifiers: ['76561190000000001', '76561190000000002'] },
  },
  lists: {
    l1: { name: 'Co-op night', deleted: false },
    gone: { name: 'Old comparison', deleted: true },
  },
});

function dynamicList(op, sources) {
  return { id: 'd', name: 'd', parentId: null, order: 0, createdAt: 0, updatedAt: 0, kind: 'dynamic', op, sources };
}

// ── describeListRef ──────────────────────────────────────────────────────────────────────────

test('describeListRef: an account source names the account and links to that account, not the current one', () => {
  assert.deepEqual(describeListRef({ kind: 'account-owned', accountId: 'acc1' }, NAMING), {
    label: 'Alice — Owned',
    href: '/lists/owned?u=76561190000000001',
  });
  assert.deepEqual(describeListRef({ kind: 'account-wishlist', accountId: 'acc1' }, NAMING), {
    label: 'Alice — Wishlist',
    href: '/lists/wishlist?u=76561190000000001',
  });
});

test('describeListRef: a Family comma-joins its identifiers into the one ?u= value', () => {
  const desc = describeListRef({ kind: 'account-owned', accountId: 'fam' }, NAMING);
  assert.equal(desc.label, 'Alice + Bob — Owned');
  assert.equal(desc.href, '/lists/owned?u=76561190000000001%2C76561190000000002');
});

test('describeListRef: an account the naming has never heard of is reported, not linked', () => {
  const desc = describeListRef({ kind: 'account-owned', accountId: 'nope' }, NAMING);
  assert.equal(desc.label, 'nope — Owned');
  assert.equal(desc.href, null);
  assert.match(desc.problem, /no longer one of your accounts/);
});

test('describeListRef: a bundle with no known title is named by id, but still links', () => {
  assert.deepEqual(describeListRef({ kind: 'bundle', bundleId: '16538' }, NAMING), {
    label: 'Bundle 16538',
    href: '/lists/bundle/16538',
  });
});

test('describeListRef: a bundle is named by its last-known title when the naming has one', () => {
  const naming = { ...NAMING, bundle: (id) => (id === '16538' ? { title: 'Trine Pack' } : null) };
  assert.deepEqual(describeListRef({ kind: 'bundle', bundleId: '16538' }, naming), {
    label: 'Trine Pack',
    href: '/lists/bundle/16538',
  });
  assert.equal(describeListRef({ kind: 'bundle', bundleId: '1' }, naming).label, 'Bundle 1');
});

test('describeListRef: recent-games points at the Recently Looked Up route', () => {
  assert.deepEqual(describeListRef({ kind: 'recent-games' }, NAMING), {
    label: 'Recently Looked Up',
    href: '/game',
  });
});

test('describeListRef: game-pass points at the PC Game Pass route', () => {
  assert.deepEqual(describeListRef({ kind: 'game-pass' }, NAMING), { label: 'PC Game Pass', href: '/lists/game-pass' });
});

test('describeListRef: a user-list source takes its own name and address', () => {
  assert.deepEqual(describeListRef({ kind: 'user', listId: 'l1' }, NAMING), {
    label: 'Co-op night',
    href: '/lists/l1',
    problem: undefined,
  });
});

test('describeListRef: a soft-deleted source list still resolves, and says why it is still here', () => {
  const desc = describeListRef({ kind: 'user', listId: 'gone' }, NAMING);
  assert.equal(desc.label, 'Old comparison');
  assert.equal(desc.href, '/lists/gone');
  assert.match(desc.problem, /deleted, and kept only because this formula uses it/);
  assert.ok(!desc.countsAsEmpty, 'it still contributes its games');
});

test('describeListRef: an orphaned bundle list says where its games come from', () => {
  const naming = { ...NAMING, list: () => ({ name: 'Pack (no longer listed)', deleted: true, orphaned: true }) };
  const desc = describeListRef({ kind: 'user', listId: 'o' }, naming);
  assert.match(desc.problem, /no longer lists this bundle; these are its last-known games/);
  assert.ok(!desc.countsAsEmpty);
});

test('describeListRef: a hard-deleted source list is a named hole, not a silent omission', () => {
  const desc = describeListRef({ kind: 'user', listId: 'never-existed' }, NAMING);
  assert.equal(desc.label, 'A list that no longer exists');
  assert.equal(desc.href, null);
  assert.match(desc.problem, /deleted/);
  assert.equal(desc.countsAsEmpty, true);
});

test('describeListRef: a ref saved without its id is reported rather than rendered as a real source', () => {
  for (const ref of [{ kind: 'account-owned' }, { kind: 'bundle' }, { kind: 'user' }]) {
    const desc = describeListRef(ref, NAMING);
    assert.equal(desc.href, null, ref.kind);
    assert.match(desc.problem, /names no /, ref.kind);
    assert.equal(desc.countsAsEmpty, true, ref.kind);
  }
});

test('describeListRef: a developer/publisher source is named like its own list and links to it', () => {
  assert.deepEqual(describeListRef({ kind: 'developer', name: 'Studio (JP)' }, NAMING), {
    label: 'Games by Studio (JP)',
    href: '/lists/developer?name=Studio+%28JP%29',
  });
  assert.deepEqual(describeListRef({ kind: 'publisher', name: 'indie.io' }, NAMING), {
    label: 'Published by indie.io',
    href: '/lists/publisher?name=indie.io',
  });
});

test('describeListRef: a developer/publisher source with no name is reported, not linked', () => {
  for (const kind of ['developer', 'publisher']) {
    const desc = describeListRef({ kind, name: '' }, NAMING);
    assert.equal(desc.href, null, kind);
    assert.match(desc.problem, /names no /, kind);
    assert.equal(desc.countsAsEmpty, true, kind);
  }
});

// ── describeSources / formatFormula ──────────────────────────────────────────────────────────

test("describeSources: one description per source, in the list's own order", () => {
  const list = dynamicList('intersect', [
    { kind: 'account-owned', accountId: 'acc1' },
    { kind: 'user', listId: 'l1' },
  ]);
  assert.deepEqual(
    describeSources(list, NAMING).map((d) => d.label),
    ['Alice — Owned', 'Co-op night'],
  );
});

test('describeSources: a manual list has no sources to describe', () => {
  const manual = {
    id: 'm',
    name: 'm',
    parentId: null,
    order: 0,
    createdAt: 0,
    updatedAt: 0,
    kind: 'manual',
    appids: [1, 2],
  };
  assert.deepEqual(describeSources(manual, NAMING), []);
});

test('formatFormula: joins sources with the op symbol', () => {
  assert.equal(
    formatFormula(
      dynamicList('intersect', [
        { kind: 'account-owned', accountId: 'acc1' },
        { kind: 'account-owned', accountId: 'fam' },
      ]),
      NAMING,
    ),
    'Alice — Owned ∩ Alice + Bob — Owned',
  );
  assert.equal(
    formatFormula(
      dynamicList('subtract', [
        { kind: 'account-wishlist', accountId: 'acc1' },
        { kind: 'user', listId: 'l1' },
      ]),
      NAMING,
    ),
    'Alice — Wishlist − Co-op night',
  );
});

test('formatFormula: group-by-membership joins with ∪ (its result is the union), never a + a family name uses', () => {
  assert.equal(
    formatFormula(
      dynamicList('group-by-membership', [{ kind: 'account-owned', accountId: 'acc1' }, { kind: 'recent-games' }]),
      NAMING,
    ),
    'Alice — Owned ∪ Recently Looked Up — grouped by membership',
  );
});

test('formatFormula: defaults a missing op to union, same as resolveGameList does', () => {
  const list = dynamicList(undefined, [{ kind: 'recent-games' }, { kind: 'user', listId: 'l1' }]);
  assert.equal(formatFormula(list, NAMING), 'Recently Looked Up ∪ Co-op night');
});

test('formatFormula: nothing to show for a manual list, or a dynamic one with no sources saved', () => {
  const manual = {
    id: 'm',
    name: 'm',
    parentId: null,
    order: 0,
    createdAt: 0,
    updatedAt: 0,
    kind: 'manual',
    appids: [1],
  };
  assert.equal(formatFormula(manual, NAMING), null);
  assert.equal(formatFormula(dynamicList('union', []), NAMING), null);
});

// ── listDisplayName ──────────────────────────────────────────────────────────────────────────

test('listDisplayName: a list with a name is called by it, formula or not', () => {
  const named = {
    ...dynamicList('union', [{ kind: 'recent-games' }, { kind: 'user', listId: 'l1' }]),
    name: 'Friday shortlist',
  };
  assert.equal(listDisplayName(named, NAMING), 'Friday shortlist');
});

test('listDisplayName: an unnamed dynamic list is called by its formula', () => {
  const unnamed = {
    ...dynamicList('intersect', [
      { kind: 'account-owned', accountId: 'acc1' },
      { kind: 'account-owned', accountId: 'fam' },
    ]),
    name: undefined,
  };
  assert.equal(listDisplayName(unnamed, NAMING), 'Alice — Owned ∩ Alice + Bob — Owned');
});

test('listDisplayName: nothing to derive from (no sources, or a manual list) falls back to a placeholder', () => {
  assert.equal(listDisplayName({ ...dynamicList('union', []), name: undefined }, NAMING), 'Untitled list');
  const manual = { id: 'm', parentId: null, order: 0, createdAt: 0, updatedAt: 0, kind: 'manual', appids: [1] };
  assert.equal(listDisplayName(manual, NAMING), 'Untitled list');
});

// ── createDefaultNaming (the store-backed half) ──────────────────────────────────────────────

// Same memory-localStorage harness listsStore.test.js uses — this is the one part of this module
// that does read the real stores, so it's the one part that needs them.
function freshStores() {
  global.localStorage = makeMemoryLocalStorage();
  return { ...require('../public/listsStore.ts'), ...require('../public/listLabels.ts') };
}

test('createDefaultNaming: an unnamed dynamic list used as a source reads as its own formula, parenthesized', () => {
  const { createList, createDefaultNaming, formatFormula } = freshStores();
  const inner = createList({
    kind: 'dynamic',
    op: 'union',
    sources: [{ kind: 'recent-games' }, { kind: 'recent-games' }],
  });
  const outer = createList({
    name: 'Outer',
    kind: 'dynamic',
    op: 'intersect',
    sources: [{ kind: 'user', listId: inner.id }, { kind: 'recent-games' }],
  });
  assert.equal(
    formatFormula(outer, createDefaultNaming()),
    '(Recently Looked Up ∪ Recently Looked Up) ∩ Recently Looked Up',
  );
});

test('createDefaultNaming: nesting is capped — an unnamed list two levels down is named by its kind, not spelled out', () => {
  const { createList, createDefaultNaming, formatFormula } = freshStores();
  const deep = createList({
    kind: 'dynamic',
    op: 'union',
    sources: [{ kind: 'recent-games' }, { kind: 'recent-games' }],
  });
  const middle = createList({
    kind: 'dynamic',
    op: 'union',
    sources: [{ kind: 'user', listId: deep.id }, { kind: 'recent-games' }],
  });
  const outer = createList({
    name: 'Outer',
    kind: 'dynamic',
    op: 'union',
    sources: [{ kind: 'user', listId: middle.id }],
  });
  assert.equal(formatFormula(outer, createDefaultNaming()), '(Untitled combined list ∪ Recently Looked Up)');
});

// ── op wording ───────────────────────────────────────────────────────────────────────────────

test('opLabel: every op is named, and an absent one reads as union', () => {
  assert.equal(opLabel('group-by-membership'), 'Grouped by membership');
  assert.equal(opLabel(undefined), 'Union');
});

test('every op has a label, a description and a join symbol', () => {
  const ops = ['union', 'intersect', 'subtract', 'group-by-membership'];
  assert.deepEqual(Object.keys(OP_LABELS), ops);
  assert.deepEqual(Object.keys(OP_DESCRIPTIONS), ops);
  assert.deepEqual(Object.keys(OP_SYMBOLS), ops);
});

test('a ranked list is described by its one source, and named "Ranking of <source>" when unnamed', () => {
  const ranked = {
    id: 'r',
    parentId: null,
    order: 0,
    createdAt: 0,
    updatedAt: 0,
    kind: 'ranked',
    source: { kind: 'account-owned', accountId: 'acc1' },
  };
  assert.deepEqual(
    describeSources(ranked, NAMING).map((s) => s.label),
    ['Alice — Owned'],
  );
  assert.equal(listDisplayName(ranked, NAMING), 'Ranking of Alice — Owned');
});
