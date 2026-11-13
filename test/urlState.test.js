'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseUrlState,
  reorderUrlParams,
  parseAccountParam,
  accountParamValues,
  withAccountParam,
  urlWithoutAccountParam,
  urlWithParams,
  normalizeSlots,
  compareUrl,
  COMPARE_PATH,
} = require('../public/urlState.ts');
const { encodeListFormula, shareListUrl } = require('../public/listShare.ts');

// ── parseUrlState — slots ─────────────────────────────────────────────────────

test('parseUrlState: parses two single-account slots', () => {
  const { slots } = parseUrlState('?u=alice&u=bob');
  assert.deepEqual(slots, [['alice'], ['bob']]);
});

test('parseUrlState: parses a multi-account slot (Steam Family)', () => {
  const { slots } = parseUrlState('?u=alice,bob_family');
  assert.deepEqual(slots, [['alice', 'bob_family']]);
});

test('parseUrlState: trims whitespace inside slots', () => {
  const { slots } = parseUrlState('?u=alice%2C+bob');
  assert.deepEqual(slots, [['alice', 'bob']]);
});

test('parseUrlState: slots is empty when no u= params', () => {
  const { slots } = parseUrlState('?game=12345');
  assert.deepEqual(slots, []);
});

// ── parseUrlState — game & shot ───────────────────────────────────────────────

test('parseUrlState: parses game appid', () => {
  const { game } = parseUrlState('?game=1307580');
  assert.equal(game, 1307580);
});

test('parseUrlState: game is null when absent', () => {
  const { game } = parseUrlState('?u=alice');
  assert.equal(game, null);
});

// ── reorderUrlParams ────────────────────────────────────────────────────────

test('reorderUrlParams: sorts known params into a fixed canonical order regardless of input order', () => {
  const params = new URLSearchParams('?tv=abc&game=440&u=alice&q=portal');
  assert.equal(reorderUrlParams(params).toString(), 'u=alice&q=portal&game=440&tv=abc');
});

test('reorderUrlParams: two equivalent states with fields set in different orders serialize identically', () => {
  const a = reorderUrlParams(new URLSearchParams('?u=alice&game=440&tv=abc'));
  const b = reorderUrlParams(new URLSearchParams('?tv=abc&u=alice&game=440'));
  assert.equal(a.toString(), b.toString());
});

test('reorderUrlParams: preserves repeated-key relative order (multiple u values)', () => {
  const params = new URLSearchParams('?foo=Indie&u=bob&foo=Coop&u=alice');
  assert.equal(reorderUrlParams(params).toString(), 'u=bob&u=alice&foo=Indie&foo=Coop');
});

test('reorderUrlParams: appends unknown params after every known one, preserving their order', () => {
  const params = new URLSearchParams('?foo=1&u=alice&bar=2');
  assert.equal(reorderUrlParams(params).toString(), 'u=alice&foo=1&bar=2');
});

test('reorderUrlParams: empty input yields empty output', () => {
  assert.equal(reorderUrlParams(new URLSearchParams()).toString(), '');
});

// ── urlWithParams ───────────────────────────────────────────────────────────

test('urlWithParams: appends the query in canonical order', () => {
  const params = new URLSearchParams('?game=440&u=alice');
  assert.equal(urlWithParams(params, '/lists/owned'), '/lists/owned?u=alice&game=440');
});

test('urlWithParams: yields the bare pathname rather than a lone "?" once nothing is left', () => {
  const params = new URLSearchParams('?game=440');
  params.delete('game');
  assert.equal(urlWithParams(params, '/lists/owned'), '/lists/owned');
  assert.equal(urlWithParams(new URLSearchParams(), '/'), '/');
});

test('urlWithParams: the params naming the list (f, name, view) sort ahead of game', () => {
  for (const key of ['f', 'name', 'view']) {
    const params = new URLSearchParams(`?game=440&${key}=x&u=alice`);
    assert.equal(urlWithParams(params, '/lists/p'), `/lists/p?u=alice&${key}=x&game=440`);
  }
});

test("urlWithParams: keeps a shared formula's :;(), literal, its leaves' escapes intact", () => {
  const url = '/lists/shared?f=union:(o:alice;d:Studio%2520%2528JP%2529,x)';
  const params = new URLSearchParams(url.split('?')[1]);
  params.set('game', '440');
  assert.equal(urlWithParams(params, '/lists/shared'), `${url}&game=440`);
});

// ── ?u= — the account-override param ──────────────────────────────────────────

test('parseAccountParam: a single identifier is the explored account', () => {
  assert.deepEqual(parseAccountParam('?u=alice'), { identifiers: ['alice'] });
});

test('parseAccountParam: comma-joined identifiers are one account (a Steam Family)', () => {
  assert.deepEqual(parseAccountParam('?u=alice,bob_family'), { identifiers: ['alice', 'bob_family'] });
});

test('parseAccountParam: several slots is a comparison, not an account to explore', () => {
  assert.deepEqual(parseAccountParam('?u=alice&u=bob&u=carol,dave'), { identifiers: [] });
});

test('parseAccountParam: no u= param (or an empty one) yields no identifiers', () => {
  assert.deepEqual(parseAccountParam('?game=440'), { identifiers: [] });
  assert.deepEqual(parseAccountParam('?u='), { identifiers: [] });
});

test('accountParamValues: returns the raw values, untouched, for forwarding', () => {
  assert.deepEqual(accountParamValues('?u=alice,bob&game=440&u=carol'), ['alice,bob', 'carol']);
  assert.deepEqual(accountParamValues('?game=440'), []);
});

test('withAccountParam: carries the u= value onto a bare path', () => {
  assert.equal(withAccountParam('/lists/owned', '?u=alice'), '/lists/owned?u=alice');
  assert.equal(withAccountParam('/lists/owned', '?u=alice,bob_family'), '/lists/owned?u=alice%2Cbob_family');
});

test("withAccountParam: a shared list's link reads the same with or without a u= carried along", () => {
  const sources = [
    { kind: 'developer', name: "Don't Nod (Paris)!" },
    { kind: 'publisher', name: 'a,b~c' },
  ];
  const result = encodeListFormula({ op: 'union', sources }, () => undefined);
  const url = shareListUrl(result.formula);
  assert.equal(withAccountParam(url, '?u=alice'), url.replace('?', '?u=alice&'));
});

test("withAccountParam: does not carry a comparison's several slots — they are not an override", () => {
  assert.equal(withAccountParam('/game/440', '?u=alice&u=bob'), '/game/440');
});

test('withAccountParam: merges into a path that has its own query, in canonical param order', () => {
  assert.equal(withAccountParam('/lists/owned?game=440', '?u=alice'), '/lists/owned?u=alice&game=440');
});

test("withAccountParam: a path's own u= wins over the one being carried over", () => {
  assert.equal(withAccountParam('/lists/owned?u=bob', '?u=alice'), '/lists/owned?u=bob');
});

test('withAccountParam: returns the path untouched when there is no u= to carry', () => {
  assert.equal(withAccountParam('/lists/owned', '?game=440'), '/lists/owned');
  assert.equal(withAccountParam('/lists/owned?game=440', ''), '/lists/owned?game=440');
});

test('urlWithoutAccountParam: strips u= and keeps the rest of the query in canonical order', () => {
  assert.equal(
    urlWithoutAccountParam('/lists/owned', '?u=alice&game=440&tag=Indie'),
    '/lists/owned?game=440&tag=Indie',
  );
});

test('urlWithoutAccountParam: strips every value of a repeated u=', () => {
  assert.equal(urlWithoutAccountParam('/', '?u=alice&u=bob'), '/');
});

test('urlWithoutAccountParam: yields the bare pathname rather than a lone "?" when nothing else is left', () => {
  assert.equal(urlWithoutAccountParam('/lists/owned', '?u=alice'), '/lists/owned');
});

test('urlWithoutAccountParam: a URL with no u= at all comes back unchanged', () => {
  assert.equal(urlWithoutAccountParam('/lists/owned', '?game=440'), '/lists/owned?game=440');
});

// ── /lists/compare — the comparison address ───────────────────────────────────

test('normalizeSlots: sorts members within a slot, then slots by their first member', () => {
  assert.deepEqual(normalizeSlots([['carol'], ['bob', 'alice']]), [['alice', 'bob'], ['carol']]);
});

test('normalizeSlots: two spellings of the same comparison normalize to one', () => {
  assert.deepEqual(normalizeSlots([['bob'], ['alice']]), normalizeSlots([['alice'], ['bob']]));
});

test('normalizeSlots: sorting is case-insensitive', () => {
  assert.deepEqual(normalizeSlots([['bob'], ['Alice']]), [['Alice'], ['bob']]);
});

test("compareUrl: one u= per slot, comma-joined within a slot — the old page's convention", () => {
  assert.equal(compareUrl([['alice'], ['bob', 'carol']]), '/lists/compare?u=alice&u=bob%2Ccarol');
});

test('compareUrl: omits the default op, so it matches a URL the old page would have written', () => {
  assert.equal(compareUrl([['alice'], ['bob']], 'group-by-membership'), '/lists/compare?u=alice&u=bob');
  assert.equal(compareUrl([['alice'], ['bob']]), '/lists/compare?u=alice&u=bob');
});

test('compareUrl: carries a non-default op, after the slots', () => {
  assert.equal(compareUrl([['alice'], ['bob']], 'intersect'), '/lists/compare?u=alice&u=bob&op=intersect');
});

test("compareUrl: rebuilds the players and op over the kept params, so a shared view isn't dropped", () => {
  assert.equal(
    compareUrl([['1'], ['2']], 'intersect', '?u=alice&tv=%7B%7D&op=union&game=10'),
    '/lists/compare?u=1&u=2&op=intersect&game=10&tv=%7B%7D',
  );
});

test('compareUrl: an old comparison link round-trips through parse and rebuild', () => {
  const { slots } = parseUrlState('?u=bob&u=alice');
  assert.equal(compareUrl(slots), `${COMPARE_PATH}?u=alice&u=bob`);
});
