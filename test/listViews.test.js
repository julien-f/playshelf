'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { registerHooks } = require('node:module');

// Same shim as gameColumns.test.js: @vates/data-table-solid touches `window` on load.
registerHooks({
  resolve(specifier, context, next) {
    return next(specifier === '@vates/data-table-solid' ? '@vates/data-table-core' : specifier, context);
  },
});

const { PRICE_COLUMNS } = require('../public/gameColumns.ts');

beforeEach(() => {
  const store = new Map();
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  delete require.cache[require.resolve('../public/prefs.ts')];
  delete require.cache[require.resolve('../public/listViews.ts')];
});

const views = () => require('../public/listViews.ts');

test('createListView: stores the view per kind, without page/searchQuery', () => {
  const { createListView, getListViews, getListView } = views();
  const v = createListView('owned', 'Short ones', {
    sorts: [{ key: 'hltbAll', dir: 'asc' }],
    page: 3,
    searchQuery: 'x',
  });
  assert.deepEqual(v.tableView, { sorts: [{ key: 'hltbAll', dir: 'asc' }] });
  assert.deepEqual(getListViews('owned'), [v]);
  assert.deepEqual(getListViews('wishlist'), []);
  assert.deepEqual(getListView('owned', v.id), v);
  assert.equal(getListView('wishlist', v.id), undefined);
});

test('rename, save and delete touch only the targeted view', () => {
  const { createListView, renameListView, saveListViewTable, deleteListView, getListViews } = views();
  const a = createListView('owned', 'A', {});
  const b = createListView('owned', 'B', {});
  renameListView('owned', a.id, 'A2');
  saveListViewTable('owned', b.id, { sorts: [{ key: 'name', dir: 'asc' }], page: 2 });
  assert.deepEqual(
    getListViews('owned').map((v) => [v.name, v.tableView]),
    [
      ['A2', {}],
      ['B', { sorts: [{ key: 'name', dir: 'asc' }] }],
    ],
  );
  deleteListView('owned', a.id);
  assert.deepEqual(
    getListViews('owned').map((v) => v.id),
    [b.id],
  );
});

test('createFromTemplate: shows the template columns, in its order', () => {
  const { VIEW_TEMPLATES, createFromTemplate } = views();
  const playNext = VIEW_TEMPLATES.find((t) => t.id === 'play-next');
  const v = createFromTemplate(playNext);
  assert.equal(v.name, 'Play next');
  assert.equal(v.template, 'play-next');
  assert.deepEqual(v.tableView.visibleCols, playNext.cols);
  assert.deepEqual(v.tableView.columnOrder, playNext.cols);
  assert.deepEqual(v.tableView.rangeFilters, { playtime: { min: '', max: '2' } });
});

test('only a template that needs prices shows price columns', () => {
  const { VIEW_TEMPLATES } = views();
  const priceKeys = new Set(PRICE_COLUMNS.map((c) => c.key));
  for (const t of VIEW_TEMPLATES) {
    if (!t.needsPrices)
      assert.deepEqual(
        t.cols.filter((k) => priceKeys.has(k)),
        [],
        t.id,
      );
  }
});

test('Bargains filters on the 1-year and all-time record tiers', () => {
  const { VIEW_TEMPLATES } = views();
  const bargains = VIEW_TEMPLATES.find((t) => t.id === 'bargains');
  assert.deepEqual(bargains.view.filters, { priceStatus: ['All-Time Low', '1-Year Low'] });
});

test('suggestedTemplates: per kind, minus created ones (even renamed), priced ones only with prices', () => {
  const { suggestedTemplates, createFromTemplate, renameListView } = views();
  const ids = (kind, priced) => suggestedTemplates(kind, priced).map((t) => t.id);
  assert.deepEqual(ids('owned', true), ['recently-played', 'play-next', 'short-games', 'runs-on-linux']);
  assert.deepEqual(ids('wishlist', true), ['bargains', 'runs-on-linux']);
  assert.deepEqual(ids('wishlist', false), ['runs-on-linux']);
  const v = createFromTemplate(suggestedTemplates('owned', true)[0]);
  renameListView('owned', v.id, 'Lately');
  assert.deepEqual(ids('owned', true), ['play-next', 'short-games', 'runs-on-linux']);
  // Each kind counts its own: Owned's Linux view created leaves Wishlist's, of the same id, suggested.
  createFromTemplate(suggestedTemplates('owned', true).find((t) => t.id === 'runs-on-linux'));
  assert.deepEqual(ids('owned', true), ['play-next', 'short-games']);
  assert.deepEqual(ids('wishlist', false), ['runs-on-linux']);
});

test('Play next and Short games leave out finished, abandoned and unreleased games', () => {
  const { VIEW_TEMPLATES, createFromTemplate } = views();
  for (const id of ['play-next', 'short-games']) {
    const v = createFromTemplate(VIEW_TEMPLATES.find((t) => t.id === id));
    assert.deepEqual(v.tableView.excludeFilters, { status: ['Finished', 'Abandoned'], availability: ['Coming soon'] });
    assert.ok(v.tableView.visibleCols.includes('status'));
  }
});

test('isPlayNextCandidate: played 2 h or less, no status, released', () => {
  const { isPlayNextCandidate } = views();
  assert.equal(isPlayNextCandidate({ playtime: 2 }, null), true);
  assert.equal(isPlayNextCandidate({}, null), true);
  assert.equal(isPlayNextCandidate({ playtime: 2.1 }, null), false);
  assert.equal(isPlayNextCandidate({ playtime: 0 }, 'finished'), false);
  assert.equal(isPlayNextCandidate({ playtime: 0 }, 'abandoned'), false);
  assert.equal(isPlayNextCandidate({ playtime: 0, comingSoon: true }, null), false);
});

// As stored by earlier versions, written out here rather than derived from the code's own list.
const PLAY_NEXT_COLS = ['capsule', 'name', 'tasteFit', 'steamdbRating', 'hltbAll', 'playtime', 'genres'];
const SHORT_COLS = ['capsule', 'name', 'hltbMain', 'steamdbRating', 'tasteFit', 'playtime', 'genres'];
const PAST = {
  'play-next': [
    {
      rangeFilters: { playtime: { min: '', max: '2' } },
      sorts: [{ key: 'tasteFit', dir: 'desc' }],
      visibleCols: PLAY_NEXT_COLS,
      columnOrder: PLAY_NEXT_COLS,
    },
    {
      rangeFilters: { playtime: { min: '', max: '2' } },
      excludeFilters: { status: ['Finished', 'Abandoned'] },
      sorts: [{ key: 'tasteFit', dir: 'desc' }],
      visibleCols: [...PLAY_NEXT_COLS, 'status'],
      columnOrder: [...PLAY_NEXT_COLS, 'status'],
    },
  ],
  'short-games': [
    {
      rangeFilters: { playtime: { min: '', max: '2' }, hltbMain: { min: '', max: '5' } },
      visibleCols: SHORT_COLS,
      columnOrder: SHORT_COLS,
    },
    {
      rangeFilters: { playtime: { min: '', max: '2' }, hltbMain: { min: '', max: '5' } },
      excludeFilters: { status: ['Finished', 'Abandoned'] },
      visibleCols: [...SHORT_COLS, 'status'],
      columnOrder: [...SHORT_COLS, 'status'],
    },
  ],
};

test("a template view stored by an earlier version reads as today's, unless it was edited", () => {
  const { getListViews, VIEW_TEMPLATES, createFromTemplate } = views();
  const stored = Object.entries(PAST).flatMap(([template, stamps]) =>
    stamps.flatMap((tableView, i) => [
      { id: `${template}-${i}`, name: 'Old', template, tableView },
      {
        id: `${template}-${i}-edited`,
        name: 'Mine',
        template,
        tableView: { ...tableView, sorts: [{ key: 'name', dir: 'asc' }] },
      },
    ]),
  );
  require('../public/prefs.ts').setPref('listViews', { owned: stored });
  const current = Object.fromEntries(
    Object.keys(PAST).map((id) => [id, createFromTemplate(VIEW_TEMPLATES.find((t) => t.id === id)).tableView]),
  );
  for (const [i, view] of getListViews('owned').slice(0, stored.length).entries()) {
    const expected = stored[i].id.endsWith('-edited') ? stored[i].tableView : current[view.template];
    assert.deepEqual(view.tableView, expected, view.id);
  }
});

test('Play next sorts by Taste fit, then rating: the order with no taste profile', () => {
  const { VIEW_TEMPLATES } = views();
  assert.deepEqual(VIEW_TEMPLATES.find((t) => t.id === 'play-next').view.sorts, [
    { key: 'tasteFit', dir: 'desc' },
    { key: 'steamdbRating', dir: 'desc' },
  ]);
});

test('Runs on Linux keeps ProtonDB Native, Platinum and Gold, as the column spells them, on Owned and Wishlist', () => {
  const { VIEW_TEMPLATES } = views();
  const { protonDbValue } = require('../public/gameColumns.ts');
  for (const kind of ['owned', 'wishlist']) {
    const linux = VIEW_TEMPLATES.find((t) => t.kind === kind && t.id === 'runs-on-linux');
    assert.equal(linux.name, 'Runs on Linux (ProtonDB)');
    assert.deepEqual(linux.view.filters, { protondb: ['native', 'platinum', 'gold'].map(protonDbValue) });
    assert.deepEqual(linux.view.filters.protondb, ['Native', 'Platinum', 'Gold']);
  }
});
