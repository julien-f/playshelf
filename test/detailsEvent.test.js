'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerHooks } = require('node:module');

// @vates/data-table-solid touches `window` on load; the helpers gameColumns.ts uses are core's,
// re-exported. Drop once it loads in Node.
registerHooks({
  resolve(specifier, context, next) {
    return next(specifier === '@vates/data-table-solid' ? '@vates/data-table-core' : specifier, context);
  },
});

const { applyDetailsEvent } = require('../public/detailsEvent.ts');

const basics = {
  name: 'Portal 2',
  type: 'game',
  capsule: 'cap.jpg',
  thumb: 'thumb.jpg',
  banner: 'header.jpg',
  description: 'Desc',
  releaseDate: 'Apr 18, 2011',
  comingSoon: false,
  platforms: ['Windows'],
  developers: ['Valve'],
  publishers: ['Valve'],
};
const meta = {
  ...basics,
  genres: ['Puzzle'],
  categories: ['Co-op'],
  metacritic: { score: 95, url: null },
  dlc: [],
  fullgame: null,
  website: null,
  achievementCount: 51,
  languages: ['English'],
  isFree: false,
  priceInitial: 999,
};
const fast = {
  appid: 620,
  part: 'fast',
  basics,
  rating: { score: 9, desc: 'Overwhelmingly Positive', positive: 900, total: 1000 },
  hltb: { id: 1, main: 8, extra: 12, completionist: 20, all: 10 },
  tags: ['Puzzle'],
  tagWeights: { Puzzle: 1 },
  demo: null,
  protondb: { tier: 'platinum', confidence: 'strong', total: 10 },
  fetchedAts: { rating: 100, hltb: 200, tags: 300, protondb: 400 },
};
const store = { appid: 620, part: 'store', meta, fetchedAts: { meta: 50 } };
const newRow = () => ({ appid: 620, name: '', loading: true, details: null });

test('applyDetailsEvent: a fast part fills the row from basics, leaving appdetails-only columns pending', () => {
  const row = newRow();
  applyDetailsEvent(row, fast);
  assert.equal(row.name, 'Portal 2');
  assert.equal(row.loading, false);
  assert.equal(row.releaseDate, 'Apr 18, 2011');
  assert.deepEqual(row.developers, ['Valve']);
  assert.equal(row.hltbAll, 10);
  assert.deepEqual(row.genres, []);
  assert.equal(row.metacritic, null);
  assert.equal(row.productionTier, null, 'no tier from reviews alone');
  assert.deepEqual(row.pendingSources, ['meta']);
  assert.equal(row.detailsFetchedAt, 100);
});

for (const order of [
  [fast, store],
  [store, fast],
]) {
  test(`applyDetailsEvent: ${order[0].part} then ${order[1].part} parts merge to the whole details`, () => {
    const row = newRow();
    for (const event of order) applyDetailsEvent(row, event);
    assert.deepEqual(row.pendingSources, []);
    assert.deepEqual(row.genres, ['Puzzle']);
    assert.equal(row.metacritic, 95);
    assert.equal(row.hltbAll, 10);
    assert.notEqual(row.productionTier, null);
    assert.equal(row.details.meta, meta);
    assert.deepEqual(row.detailsFetchedAts, { rating: 100, hltb: 200, tags: 300, protondb: 400, meta: 50 });
    assert.equal(row.detailsFetchedAt, 50);
  });
}

test('applyDetailsEvent: a nameless row stays loading until its store part, when basics gave none', () => {
  const row = newRow();
  applyDetailsEvent(row, { ...fast, basics: null });
  assert.equal(row.loading, true);
  applyDetailsEvent(row, store);
  assert.equal(row.loading, false);
  assert.equal(row.name, 'Portal 2');
});

test('applyDetailsEvent: a part fails only its own sources, and keeps the other part', () => {
  const row = newRow();
  applyDetailsEvent(row, store);
  applyDetailsEvent(row, {
    appid: 620,
    part: 'fast',
    basics: null,
    rating: null,
    hltb: null,
    tags: null,
    demo: null,
    protondb: null,
    failed: ['rating', 'hltb', 'tags', 'protondb'],
  });
  assert.deepEqual(row.failedSources, ['rating', 'hltb', 'tags', 'protondb']);
  assert.deepEqual(row.genres, ['Puzzle']);
  assert.equal(row.releaseDate, 'Apr 18, 2011');
});

test("applyDetailsEvent: the stream's media-less store part keeps media an opened game already loaded", () => {
  const row = newRow();
  const screenshots = [{ id: 1, thumbnail: 't', full: 'f' }];
  applyDetailsEvent(row, { ...store, meta: { ...meta, screenshots, movies: [] } });
  applyDetailsEvent(row, store);
  assert.equal(row.details.meta.screenshots, screenshots);
});
