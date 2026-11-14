'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encodeListFormula, decodeListFormula, shareListUrl, SHARED_LIST_PATH } = require('../public/listShare.ts');

function dynamicList(id, op, sources) {
  return { id, name: id, parentId: null, order: 0, createdAt: 0, updatedAt: 0, kind: 'dynamic', op, sources };
}

function manualList(id, appids) {
  return { id, name: id, parentId: null, order: 0, createdAt: 0, updatedAt: 0, kind: 'manual', appids };
}

function makeGetList(lists) {
  const map = new Map(lists.map((l) => [l.id, l]));
  return (id) => map.get(id);
}

// ── encodeListFormula: leaf sources ─────────────────────────────────────────────────────────

test('encodeListFormula/decodeListFormula: game-pass round-trips as `x`', () => {
  const result = encodeListFormula(
    { op: 'intersect', sources: [{ kind: 'game-pass' }, { kind: 'recent-games' }] },
    makeGetList([]),
  );
  assert.equal(result.formula, 'intersect:(x;r)');
  assert.deepEqual(decodeListFormula(result.formula).sources, [{ kind: 'game-pass' }, { kind: 'recent-games' }]);
});

test('encodeListFormula: encodes owned/wishlist/bundle/recent-games sources', () => {
  const list = {
    op: 'union',
    sources: [
      { kind: 'account-owned', accountId: 'acc1' },
      { kind: 'account-wishlist', accountId: 'acc2' },
      { kind: 'bundle', bundleId: 'b1' },
      { kind: 'recent-games' },
    ],
  };
  const result = encodeListFormula(list, makeGetList([]));
  assert.equal(result.ok, true);
  assert.equal(result.formula, 'union:(o:acc1;w:acc2;b:b1;r)');
});

test('encodeListFormula: percent-encodes a Family accountId\'s "+" join', () => {
  const list = {
    op: 'union',
    sources: [
      { kind: 'account-owned', accountId: 'idA+idB' },
      { kind: 'account-owned', accountId: 'idC' },
    ],
  };
  const result = encodeListFormula(list, makeGetList([]));
  assert.equal(result.ok, true);
  assert.equal(result.formula, 'union:(o:idA%2BidB;o:idC)');
});

test('encodeListFormula: fails on an empty sources list', () => {
  const result = encodeListFormula({ op: 'union', sources: [] }, makeGetList([]));
  assert.deepEqual(result, { ok: false, reason: 'empty' });
});

// ── encodeListFormula: `user` source inlining ───────────────────────────────────────────────

test('encodeListFormula: inlines a `user` source as a `g:` group', () => {
  const inner = dynamicList('inner', 'intersect', [
    { kind: 'account-owned', accountId: 'a1' },
    { kind: 'account-wishlist', accountId: 'a1' },
  ]);
  const outer = {
    op: 'union',
    sources: [
      { kind: 'user', listId: 'inner' },
      { kind: 'bundle', bundleId: 'b1' },
    ],
  };
  const result = encodeListFormula(outer, makeGetList([inner]));
  assert.equal(result.ok, true);
  assert.equal(result.formula, 'union:(g:intersect:(o:a1;w:a1);b:b1)');
});

test('encodeListFormula: inlines nested `user` sources arbitrarily deep', () => {
  const c = dynamicList('c', 'union', [
    { kind: 'account-owned', accountId: 'a1' },
    { kind: 'account-owned', accountId: 'a2' },
  ]);
  const b = dynamicList('b', 'intersect', [
    { kind: 'user', listId: 'c' },
    { kind: 'account-wishlist', accountId: 'a3' },
  ]);
  const a = dynamicList('a', 'subtract', [
    { kind: 'user', listId: 'b' },
    { kind: 'bundle', bundleId: 'b1' },
  ]);
  const result = encodeListFormula(a, makeGetList([a, b, c]));
  assert.equal(result.ok, true);
  assert.equal(result.formula, 'subtract:(g:intersect:(g:union:(o:a1;o:a2);w:a3);b:b1)');
});

test('encodeListFormula: rejects a `user` source pointing at a manual list', () => {
  const manual = manualList('m1', [1, 2, 3]);
  const outer = {
    op: 'union',
    sources: [
      { kind: 'user', listId: 'm1' },
      { kind: 'bundle', bundleId: 'b1' },
    ],
  };
  const result = encodeListFormula(outer, makeGetList([manual]));
  assert.deepEqual(result, { ok: false, reason: 'manual-source' });
});

test('encodeListFormula: rejects a `user` source that would cycle', () => {
  const a = dynamicList('a', 'union', [
    { kind: 'user', listId: 'b' },
    { kind: 'bundle', bundleId: 'b1' },
  ]);
  const b = dynamicList('b', 'union', [
    { kind: 'user', listId: 'a' },
    { kind: 'bundle', bundleId: 'b2' },
  ]);
  const result = encodeListFormula(a, makeGetList([a, b]));
  assert.deepEqual(result, { ok: false, reason: 'cycle-or-too-deep' });
});

test('encodeListFormula: rejects a dangling `user` source', () => {
  const outer = {
    op: 'union',
    sources: [
      { kind: 'user', listId: 'gone' },
      { kind: 'bundle', bundleId: 'b1' },
    ],
  };
  const result = encodeListFormula(outer, makeGetList([]));
  assert.deepEqual(result, { ok: false, reason: 'cycle-or-too-deep' });
});

// ── decodeListFormula ────────────────────────────────────────────────────────────────────────

test('decodeListFormula: decodes leaf sources', () => {
  const decoded = decodeListFormula('union:(o:acc1;w:acc2;b:b1;r)');
  assert.equal(decoded.op, 'union');
  assert.deepEqual(decoded.sources, [
    { kind: 'account-owned', accountId: 'acc1' },
    { kind: 'account-wishlist', accountId: 'acc2' },
    { kind: 'bundle', bundleId: 'b1' },
    { kind: 'recent-games' },
  ]);
  assert.equal(decoded.synthetic.size, 0);
});

test('decodeListFormula: decodes a percent-encoded accountId back to its raw form', () => {
  const decoded = decodeListFormula('union:(o:idA%2BidB)');
  assert.deepEqual(decoded.sources, [{ kind: 'account-owned', accountId: 'idA+idB' }]);
});

test('decodeListFormula: materializes a `g:` group as a synthetic GameList, referenced by a `user` ListRef', () => {
  const decoded = decodeListFormula('union:(g:intersect:(o:a1;w:a1);b:b1)');
  assert.equal(decoded.sources.length, 2);
  const [groupRef, bundleRef] = decoded.sources;
  assert.equal(groupRef.kind, 'user');
  assert.equal(bundleRef.kind, 'bundle');
  const synth = decoded.synthetic.get(groupRef.listId);
  assert.ok(synth);
  assert.equal(synth.kind, 'dynamic');
  assert.equal(synth.op, 'intersect');
  assert.deepEqual(synth.sources, [
    { kind: 'account-owned', accountId: 'a1' },
    { kind: 'account-wishlist', accountId: 'a1' },
  ]);
});

test('decodeListFormula: rejects malformed input instead of throwing', () => {
  assert.equal(decodeListFormula('not a formula'), null);
  assert.equal(decodeListFormula('bogus-op:(o:a1)'), null);
  assert.equal(decodeListFormula('union:(o:a1'), null); // unclosed paren
  assert.equal(decodeListFormula('union:()'), null); // no sources
});

// ── round trip ───────────────────────────────────────────────────────────────────────────────

test('round trip: encode then decode reconstructs an equivalent nested formula', () => {
  const c = dynamicList('c', 'union', [
    { kind: 'account-owned', accountId: 'a1' },
    { kind: 'account-owned', accountId: 'a2' },
  ]);
  const b = dynamicList('b', 'intersect', [
    { kind: 'user', listId: 'c' },
    { kind: 'account-wishlist', accountId: 'a3' },
  ]);
  const encoded = encodeListFormula(b, makeGetList([b, c]));
  assert.equal(encoded.ok, true);
  const decoded = decodeListFormula(encoded.formula);
  assert.equal(decoded.op, 'intersect');
  assert.equal(decoded.sources[0].kind, 'user');
  assert.equal(decoded.sources[1].kind, 'account-wishlist');
  const nestedGroup = decoded.synthetic.get(decoded.sources[0].listId);
  assert.equal(nestedGroup.op, 'union');
  assert.deepEqual(nestedGroup.sources, [
    { kind: 'account-owned', accountId: 'a1' },
    { kind: 'account-owned', accountId: 'a2' },
  ]);
});

// ── shareListUrl ─────────────────────────────────────────────────────────────────────────────

test('shareListUrl: builds a /lists/shared link carrying the formula verbatim (readable, unescaped)', () => {
  const url = shareListUrl('union:(o:acc1;w:acc2)');
  assert.equal(url, `${SHARED_LIST_PATH}?f=union:(o:acc1;w:acc2)`);
});

test("shareListUrl: writes ' as %27, as browsers and the in-page URL do", () => {
  assert.equal(shareListUrl("union:(d:Don'tNod;o:acc1)"), `${SHARED_LIST_PATH}?f=union:(d:Don%27tNod;o:acc1)`);
});

test('encodeListFormula: rejects a `user` source pointing at a ranked list', () => {
  const ranked = {
    id: 'r1',
    parentId: null,
    order: 0,
    createdAt: 0,
    updatedAt: 0,
    kind: 'ranked',
    source: { kind: 'recent-games' },
  };
  const outer = {
    op: 'union',
    sources: [
      { kind: 'user', listId: 'r1' },
      { kind: 'bundle', bundleId: 'b1' },
    ],
  };
  assert.deepEqual(encodeListFormula(outer, makeGetList([ranked])), { ok: false, reason: 'ranked-source' });
});

// ── developer / publisher sources ────────────────────────────────────────────────────────────

const { withAccountParam } = require('../public/urlState.ts');

// What ListRoute.tsx reads back: `?f=` after the one decode URLSearchParams applies.
function formulaFromUrl(url) {
  return new URLSearchParams(url.split('?')[1]).get('f');
}

const AWKWARD = 'Studio (JP); 100% + Ünï:co,de %28';

test('encodeListFormula: encodes developer/publisher sources, escaping the grammar characters in a name', () => {
  const result = encodeListFormula(
    {
      op: 'subtract',
      sources: [
        { kind: 'developer', name: 'Studio (JP)' },
        { kind: 'publisher', name: 'indie.io' },
      ],
    },
    () => undefined,
  );
  assert.deepEqual(result, { ok: true, formula: 'subtract:(d:Studio%20%28JP%29;p:indie.io)' });
});

test('round trip through the real URL: a developer name with grammar and percent characters survives', () => {
  const sources = [
    { kind: 'developer', name: AWKWARD },
    { kind: 'account-owned', accountId: 'idA+idB' },
  ];
  const { formula } = encodeListFormula({ op: 'subtract', sources }, () => undefined);
  for (const url of [shareListUrl(formula), withAccountParam(shareListUrl(formula), '?u=76561190000000001')]) {
    const decoded = decodeListFormula(formulaFromUrl(url));
    assert.equal(decoded.op, 'subtract');
    assert.deepEqual(decoded.sources, sources);
  }
});

test('round trip: a developer source nested in a `g:` group', () => {
  const inner = {
    id: 'l1',
    parentId: null,
    order: 0,
    createdAt: 0,
    updatedAt: 0,
    kind: 'dynamic',
    op: 'union',
    sources: [{ kind: 'publisher', name: AWKWARD }, { kind: 'recent-games' }],
  };
  const { formula } = encodeListFormula(
    {
      op: 'intersect',
      sources: [
        { kind: 'user', listId: 'l1' },
        { kind: 'developer', name: 'A' },
      ],
    },
    (id) => (id === 'l1' ? inner : undefined),
  );
  const decoded = decodeListFormula(formulaFromUrl(shareListUrl(formula)));
  assert.deepEqual(decoded.sources[1], { kind: 'developer', name: 'A' });
  assert.deepEqual(decoded.synthetic.get(decoded.sources[0].listId).sources, inner.sources);
});

test('decodeListFormula: a bare `d:` decodes to a nameless developer source', () => {
  assert.deepEqual(decodeListFormula('union:(d:;r)').sources[0], { kind: 'developer', name: '' });
});

test('shareListUrl: an old link with an encoded account id still decodes through the real URL', () => {
  const decoded = decodeListFormula(formulaFromUrl(`${SHARED_LIST_PATH}?f=union:(o:idA%2BidB;o:idC)`));
  assert.deepEqual(decoded.sources[0], { kind: 'account-owned', accountId: 'idA+idB' });
});
