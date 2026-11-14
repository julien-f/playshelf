'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { layoutDraft, resetTableView, prefViewStore, shareTableView } = require('../public/tableViewPrefs.ts');

// Just enough DOM for clipboard.ts's copy announcement.
globalThis.document = { createElement: () => ({ setAttribute() {}, style: {} }), body: { append() {} } };

// tableViewPrefs.js reads/writes `location`/`history` and prefs.js's own localStorage-backed
// store directly — stub the minimal browser globals it touches, same idea prefs.test.js/
// region.test.js already use for their own localStorage stubbing.
function fakeTable(initial = {}) {
  let state = initial;
  return {
    setViewState: (v) => {
      state = v;
    },
    getViewState: () => state,
  };
}

function withLocation(search, fn) {
  const store = {};
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = v;
    },
    removeItem: (k) => {
      delete store[k];
    },
  };
  const session = {};
  globalThis.sessionStorage = {
    getItem: (k) => (k in session ? session[k] : null),
    setItem: (k, v) => {
      session[k] = v;
    },
    removeItem: (k) => {
      delete session[k];
    },
  };
  let currentSearch = search;
  globalThis.location = { search: currentSearch, origin: 'https://example.test', pathname: '/library.html' };
  globalThis.history = {
    replaceState: (_s, _t, url) => {
      currentSearch = url.split('?')[1] ? `?${url.split('?')[1]}` : '';
      globalThis.location.search = currentSearch;
    },
  };
  try {
    const result = fn();
    return result && typeof result.finally === 'function' ? result.finally(cleanup) : (cleanup(), result);
  } catch (err) {
    cleanup();
    throw err;
  }
  function cleanup() {
    delete globalThis.localStorage;
    delete globalThis.sessionStorage;
    delete globalThis.location;
    delete globalThis.history;
  }
}

test('layoutDraft restore: an incoming param wins for this visit only — applied, not stored, stripped from the URL', () => {
  withLocation('?tv=%7B%22pageSize%22%3A25%7D', () => {
    const { getPref, setPref } = require('../public/prefs.ts');
    setPref('libraryView', { pageSize: 10 });
    const table = fakeTable();
    assert.equal(restoreFor(table), true, 'reports a shared view');
    assert.deepEqual(table.getViewState(), { pageSize: 25 });
    assert.deepEqual(getPref('libraryView'), { pageSize: 10 }, "the viewer's own view is untouched");
    assert.equal(new URLSearchParams(location.search).has('tv'), false, 'param consumed');
  });
});

test('layoutDraft restore: a malformed param falls through to the stored default', () => {
  withLocation('?tv=not-json', () => {
    const table = fakeTable();
    assert.equal(restoreFor(table), false);
    assert.deepEqual(table.getViewState(), {}, 'no stored pref yet either');
    assert.equal(new URLSearchParams(location.search).has('tv'), false, 'param consumed anyway');
  });
});

test('layoutDraft restore: valid JSON that is no view object falls through to the stored default', () => {
  const bad = ['[]', '5', 'null', '"view"'];
  for (const raw of bad) {
    withLocation(`?tv=${encodeURIComponent(raw)}`, () => {
      const { setPref } = require('../public/prefs.ts');
      setPref('libraryView', { pageSize: 10 });
      const table = fakeTable();
      assert.equal(restoreFor(table), false, raw);
      assert.deepEqual(table.getViewState(), { pageSize: 10 }, raw);
    });
  }
});

test('layoutDraft restore: a full well-formed view is applied', () => {
  const view = {
    visibleCols: ['name'],
    columnOrder: ['name', 'price'],
    sorts: [{ key: 'name', dir: 'asc' }],
    filters: { tags: ['RPG'] },
    excludeFilters: { tags: ['Horror'] },
    filterModes: { tags: 'and' },
    rangeFilters: { price: { min: '1', max: '' } },
    groupBy: ['tags'],
    collapsedGroups: ['RPG'],
    page: 2,
    pageSize: 25,
    searchQuery: 'portal',
  };
  withLocation(`?tv=${encodeURIComponent(JSON.stringify(view))}`, () => {
    const table = fakeTable();
    assert.equal(restoreFor(table), true);
    assert.deepEqual(table.getViewState(), view);
  });
});

test('layoutDraft restore: no param at all falls back to whatever is already stored', () => {
  withLocation('', () => {
    const { setPref } = require('../public/prefs.ts');
    setPref('libraryView', { pageSize: 10 });
    const table = fakeTable();
    restoreFor(table);
    assert.deepEqual(table.getViewState(), { pageSize: 10 });
  });
});

test('resetTableView: blanks the view and the stored default', () => {
  withLocation('', () => {
    const { getPref, setPref } = require('../public/prefs.ts');
    setPref('libraryView', { pageSize: 25 });
    const table = fakeTable({ pageSize: 25 });
    resetTableView(table, prefViewStore('libraryView'));
    assert.deepEqual(table.getViewState(), {});
    assert.deepEqual(getPref('libraryView'), {});
  });
});

// ── layoutDraft: a change stays a draft until Save or Discard ───────────────────────────────

const restoreFor = (table) => layoutDraft(table, 'libraryView', prefViewStore('libraryView')).restore();

test('layoutDraft: a change goes to the draft, not the stored layout, and says what differs', () => {
  withLocation('', () => {
    const { getPref, setPref } = require('../public/prefs.ts');
    setPref('libraryView', { pageSize: 10 });
    const table = fakeTable();
    const layout = layoutDraft(table, 'libraryView', prefViewStore('libraryView'));
    layout.restore();
    assert.deepEqual(layout.changes(), []);
    table.setViewState({ pageSize: 25, sorts: [{ key: 'name', dir: 'asc' }] });
    layout.store.save(table.getViewState());
    assert.deepEqual(layout.changes(), ['Sort', 'Page size']);
    assert.deepEqual(getPref('libraryView'), { pageSize: 10 });
    // A reload in the same tab finds the draft.
    const again = fakeTable();
    layoutDraft(again, 'libraryView', prefViewStore('libraryView')).restore();
    assert.deepEqual(again.getViewState(), { pageSize: 25, sorts: [{ key: 'name', dir: 'asc' }] });
  });
});

test('layoutDraft: Save stores the layout without page or search; Discard goes back to it', () => {
  withLocation('', () => {
    const { getPref } = require('../public/prefs.ts');
    const table = fakeTable();
    const layout = layoutDraft(table, 'libraryView', prefViewStore('libraryView'));
    layout.restore();
    table.setViewState({ pageSize: 25, page: 3, searchQuery: 'hades' });
    layout.store.save(table.getViewState());
    layout.save();
    assert.deepEqual(getPref('libraryView'), { pageSize: 25 });
    assert.deepEqual(layout.changes(), []);
    table.setViewState({ pageSize: 100 });
    layout.store.save(table.getViewState());
    layout.discard();
    assert.deepEqual(table.getViewState(), { pageSize: 25 });
    assert.deepEqual(layout.changes(), []);
  });
});

test('layoutDraft: compares against the stored layout as the table applies it, temporary columns aside', () => {
  withLocation('', () => {
    const { setPref } = require('../public/prefs.ts');
    setPref('libraryView', { pageSize: 25, visibleCols: ['name', 'gone'] });
    // A table that resolves away a column it doesn't have.
    let state = {};
    const table = {
      setViewState: (v) => {
        state = { ...v, ...(v.visibleCols && { visibleCols: v.visibleCols.filter((c) => c !== 'gone') }) };
      },
      getViewState: () => state,
    };
    const layout = layoutDraft(table, 'libraryView', prefViewStore('libraryView'), { cols: ['similarity'] });
    layout.restore();
    assert.deepEqual(layout.changes(), []);
    table.setViewState({ ...state, sorts: [{ key: 'similarity', dir: 'desc' }], visibleCols: ['similarity', 'name'] });
    assert.deepEqual(layout.changes(), []);
  });
});

test('layoutDraft: Discard keeps the search and page, which were never part of the change', () => {
  withLocation('', () => {
    const table = fakeTable();
    const layout = layoutDraft(table, 'libraryView', prefViewStore('libraryView'));
    layout.restore();
    table.setViewState({ pageSize: 25, page: 2, searchQuery: 'portal' });
    layout.discard();
    assert.deepEqual(table.getViewState(), { page: 2, searchQuery: 'portal' });
  });
});

test('layoutDraft: a sort holding only a temporary column is the default sort, not a change', () => {
  withLocation('', () => {
    const table = fakeTable();
    const layout = layoutDraft(
      table,
      'libraryView',
      prefViewStore('libraryView'),
      { cols: ['similarity'] },
      {
        sorts: [{ key: 'rating', dir: 'desc' }],
      },
    );
    layout.restore();
    table.setViewState({ sorts: [{ key: 'similarity', dir: 'desc' }] });
    assert.deepEqual(layout.changes(), []);
  });
});

test('layoutDraft: a temporary range is no change, never saved, and dropped from a stored layout', () => {
  withLocation('', () => {
    const { setPref, getPref } = require('../public/prefs.ts');
    // Saved before the range was temporary: it isn't restored.
    setPref('libraryView', { pageSize: 25, rangeFilters: { tierPrice: { min: '', max: '12' } } });
    const table = fakeTable();
    const layout = layoutDraft(table, 'libraryView', prefViewStore('libraryView'), { ranges: ['tierPrice'] });
    layout.restore();
    assert.deepEqual(table.getViewState().rangeFilters ?? {}, {});
    table.setViewState({ ...table.getViewState(), rangeFilters: { tierPrice: { min: '', max: '5' } } });
    assert.deepEqual(layout.changes(), []);
    // Sorting on the same column is still layout.
    table.setViewState({ ...table.getViewState(), sorts: [{ key: 'tierPrice', dir: 'asc' }] });
    assert.notDeepEqual(layout.changes(), []);
    // The tab's draft, which every bundle shares, doesn't carry it either.
    layout.store.save(table.getViewState());
    assert.deepEqual(layout.store.load().rangeFilters ?? {}, {});
    layout.save();
    assert.deepEqual(getPref('libraryView').rangeFilters ?? {}, {});
    assert.deepEqual(getPref('libraryView').sorts, [{ key: 'tierPrice', dir: 'asc' }]);
  });
});

test('shareTableView: copies a link with the view snapshotted into the param, without touching the live URL', async () => {
  const originalNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    await withLocation('', async () => {
      const table = fakeTable({ pageSize: 25 });
      let copied = null;
      const stubNav = {
        clipboard: {
          writeText: async (text) => {
            copied = text;
          },
        },
      };
      Object.defineProperty(globalThis, 'navigator', { value: stubNav, configurable: true });
      const btn = { textContent: 'Share layout', childNodes: [], replaceChildren() {} };
      shareTableView(table, btn);
      await Promise.resolve();
      await Promise.resolve(); // let writeText()'s .then() microtask run
      assert.match(copied, /\?tv=%7B%22pageSize%22%3A25%7D/);
      assert.equal(location.search, '', 'live URL left untouched');
    });
  } finally {
    if (originalNavDesc) Object.defineProperty(globalThis, 'navigator', originalNavDesc);
  }
});

test('shareTableView: an unchanged view sends no param, so the link opens on the defaults', async () => {
  const originalNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    await withLocation('?q=x', async () => {
      let copied = null;
      const stubNav = { clipboard: { writeText: async (text) => (copied = text) } };
      Object.defineProperty(globalThis, 'navigator', { value: stubNav, configurable: true });
      shareTableView(fakeTable({}), { textContent: 'Share layout', childNodes: [], replaceChildren() {} });
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(new URL(copied).searchParams.has('tv'), false);
      assert.equal(new URL(copied).searchParams.get('q'), 'x');
    });
  } finally {
    if (originalNavDesc) Object.defineProperty(globalThis, 'navigator', originalNavDesc);
  }
});

test('shareTableView: adds extra params, but never over one the URL already sets', async () => {
  const originalNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    let copied = null;
    const stubNav = {
      clipboard: {
        writeText: async (text) => {
          copied = text;
        },
      },
    };
    Object.defineProperty(globalThis, 'navigator', { value: stubNav, configurable: true });
    const share = async (search) => {
      await withLocation(search, async () => {
        shareTableView(
          fakeTable({}),
          { textContent: 'Share layout', childNodes: [], replaceChildren() {} },
          { u: 'alice' },
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      return new URL(copied).searchParams.getAll('u');
    };
    assert.deepEqual(await share(''), ['alice']);
    assert.deepEqual(await share('?u=bob'), ['bob'], 'a shared link keeps the account it names');
  } finally {
    if (originalNavDesc) Object.defineProperty(globalThis, 'navigator', originalNavDesc);
  }
});

test('shareTableView: drops the params the recipient has no use for', async () => {
  const originalNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    await withLocation('?u=alice&view=abc', async () => {
      let copied = null;
      const stubNav = { clipboard: { writeText: async (text) => (copied = text) } };
      Object.defineProperty(globalThis, 'navigator', { value: stubNav, configurable: true });
      shareTableView(fakeTable({}), { textContent: 'Share layout', childNodes: [], replaceChildren() {} }, {}, [
        'view',
      ]);
      await Promise.resolve();
      await Promise.resolve();
      const params = new URL(copied).searchParams;
      assert.equal(params.has('view'), false);
      assert.equal(params.get('u'), 'alice');
      assert.equal(location.search, '?u=alice&view=abc', 'live URL left untouched');
    });
  } finally {
    if (originalNavDesc) Object.defineProperty(globalThis, 'navigator', originalNavDesc);
  }
});
