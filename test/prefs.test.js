'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { until } = require('./until');

// prefs.js reads/writes the bare `localStorage` global (it's loaded as a plain script in the
// browser, not a module) — stub it before requiring so getPref/setPref have something to hit.
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
  delete require.cache[require.resolve('../public/prefs.ts')];
  // require.cache deletion above doesn't reach prefs.ts's module-level state — see
  // _resetPrefsState's own comment there.
  require('../public/prefs.ts')._resetPrefsState();
});

test('getPref: returns the fallback when the key was never set', () => {
  const { getPref } = require('../public/prefs.ts');
  assert.equal(getPref('region', 'fallback'), 'fallback');
});

test('setPref/getPref: round-trips a value', () => {
  const { getPref, setPref } = require('../public/prefs.ts');
  setPref('region', 'DE');
  assert.equal(getPref('region'), 'DE');
});

test('setPref: multiple keys coexist in the same blob', () => {
  const { getPref, setPref } = require('../public/prefs.ts');
  setPref('region', 'DE');
  setPref('libraryView', { sorts: [{ key: 'name', dir: 'asc' }] });
  assert.equal(getPref('region'), 'DE');
  assert.deepEqual(getPref('libraryView'), { sorts: [{ key: 'name', dir: 'asc' }] });
});

test('setPref: overwriting one key leaves other keys untouched', () => {
  const { getPref, setPref } = require('../public/prefs.ts');
  setPref('region', 'DE');
  setPref('bundlesTableView', { sorts: [] });
  setPref('region', 'US');
  assert.equal(getPref('region'), 'US');
  assert.deepEqual(getPref('bundlesTableView'), { sorts: [] });
});

test('getPref: falls back gracefully when the stored blob is corrupted JSON', () => {
  global.localStorage.setItem('steam.isonoe.net:prefs', '{not json');
  const { getPref } = require('../public/prefs.ts');
  assert.equal(getPref('region', 'fallback'), 'fallback');
});

test('getPref: falls back gracefully when the stored value is not an object', () => {
  global.localStorage.setItem('steam.isonoe.net:prefs', '"just a string"');
  const { getPref } = require('../public/prefs.ts');
  assert.equal(getPref('region', 'fallback'), 'fallback');
});

test('getPref/setPref: never throw when localStorage is unavailable', () => {
  global.localStorage = {
    getItem() {
      throw new Error('unavailable');
    },
    setItem() {
      throw new Error('unavailable');
    },
  };
  delete require.cache[require.resolve('../public/prefs.ts')];
  const { getPref, setPref } = require('../public/prefs.ts');
  assert.doesNotThrow(() => setPref('region', 'DE'));
  assert.equal(getPref('region', 'fallback'), 'fallback');
});

test('setPref: on a full storage, evicts cached tastes to make room and persists', () => {
  // Full while any taste is stored.
  const store = new Map([
    ['steam.isonoe.net:taste:a', '{"at":1}'],
    ['steam.isonoe.net:taste:b', '{"at":2}'],
  ]);
  global.localStorage = {
    get length() {
      return store.size;
    },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => store.get(k) ?? null,
    setItem(k, v) {
      if ([...store.keys()].some((key) => key.startsWith('steam.isonoe.net:taste:')))
        throw new DOMException('full', 'QuotaExceededError');
      store.set(k, v);
    },
    removeItem: (k) => store.delete(k),
  };
  const { setPref } = require('../public/prefs.ts');
  setPref('region', 'DE');
  assert.deepEqual([...store.keys()], ['steam.isonoe.net:prefs']);
  assert.equal(JSON.parse(store.get('steam.isonoe.net:prefs')).region.value, 'DE');
});

// ── v1 → v2 storage migration (raw value per key → {value, updatedAt} per key) ─────────────────

test('getPref: reads a pre-migration (v1) blob with no schemaVersion at all', () => {
  global.localStorage.setItem('steam.isonoe.net:prefs', JSON.stringify({ region: 'DE' }));
  const { getPref } = require('../public/prefs.ts');
  assert.equal(getPref('region'), 'DE');
});

test('getAllPrefEntries: a migrated v1 key gets updatedAt: 0 — older than anything with a real timestamp', () => {
  global.localStorage.setItem('steam.isonoe.net:prefs', JSON.stringify({ region: 'DE' }));
  const { getAllPrefEntries } = require('../public/prefs.ts');
  assert.deepEqual(getAllPrefEntries().region, { value: 'DE', updatedAt: 0 });
});

test('setPref: after migration, the blob is rewritten as v2 and a fresh setPref gets a real updatedAt', () => {
  global.localStorage.setItem('steam.isonoe.net:prefs', JSON.stringify({ region: 'DE' }));
  const { setPref, getAllPrefEntries } = require('../public/prefs.ts');
  const before = Date.now();
  setPref('libraryView', { sorts: [] });
  assert.ok(getAllPrefEntries().libraryView.updatedAt >= before);
  assert.equal(getAllPrefEntries().region.updatedAt, 0); // untouched key stays migrated-but-unset
});

// ── getAllPrefEntries / adoptPrefEntry ──────────────────────────────────────────────────────────

test('getAllPrefEntries: reflects every key set via setPref, each with its own updatedAt', () => {
  const { setPref, getAllPrefEntries } = require('../public/prefs.ts');
  const before = Date.now();
  setPref('region', 'DE');
  const entries = getAllPrefEntries();
  assert.equal(entries.region.value, 'DE');
  assert.ok(entries.region.updatedAt >= before);
});

test("adoptPrefEntry: sets a key's value and updatedAt directly, readable via getPref", () => {
  const { adoptPrefEntry, getPref, getAllPrefEntries } = require('../public/prefs.ts');
  adoptPrefEntry('region', 'GB', 12345);
  assert.equal(getPref('region'), 'GB');
  assert.deepEqual(getAllPrefEntries().region, { value: 'GB', updatedAt: 12345 });
});

test('adoptPrefEntry: does not push to the server, even when signed in', async (t) => {
  const restore = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return { ok: true, json: async () => ({}) };
  };
  t.after(() => {
    globalThis.fetch = restore;
  });

  const { adoptPrefEntry, setSignedInSteamid } = require('../public/prefs.ts');
  setSignedInSteamid('76561198000000001');
  adoptPrefEntry('region', 'GB', 12345);

  assert.equal(called, false);
});

// ── pushPrefToServer (via setPref once signed in) ───────────────────────────────────────────────

test('setPref: pushes { value, updatedAt } to PUT /api/me/prefs/:key once signed in', async (t) => {
  const restore = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, opts) => {
    seen = { url, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({}) };
  };
  t.after(() => {
    globalThis.fetch = restore;
  });

  const { setPref, setSignedInSteamid } = require('../public/prefs.ts');
  setSignedInSteamid('76561198000000001');
  const before = Date.now();
  setPref('region', 'DE');

  assert.equal(seen.url, '/api/me/prefs/region');
  assert.equal(seen.body.value, 'DE');
  assert.ok(seen.body.updatedAt >= before);
});

test('setPref: does not push anywhere when signed out', async (t) => {
  const restore = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return { ok: true, json: async () => ({}) };
  };
  t.after(() => {
    globalThis.fetch = restore;
  });

  const { setPref } = require('../public/prefs.ts');
  setPref('region', 'DE');

  assert.equal(called, false);
});

test('setPref: a table-view key (written only on Save) is pushed at once when signed in', async (t) => {
  const restore = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push([url, JSON.parse(opts.body).value]);
    return { ok: true, json: async () => ({}) };
  };
  t.after(() => {
    globalThis.fetch = restore;
  });

  const { setPref, setSignedInSteamid } = require('../public/prefs.ts');
  setSignedInSteamid('76561198000000001');
  setPref('ownedListView', { pageSize: 25 });

  assert.deepEqual(seen, [['/api/me/prefs/ownedListView', { pageSize: 25 }]]);
});

test("getPref: a v2 blob's table views read as older than anything, other keys keep their time", () => {
  global.localStorage.setItem(
    'steam.isonoe.net:prefs',
    JSON.stringify({
      schemaVersion: 2,
      ownedListView: { value: { pageSize: 25 }, updatedAt: 900 },
      region: { value: 'DE', updatedAt: 900 },
    }),
  );
  const { getAllPrefEntries } = require('../public/prefs.ts');
  const entries = getAllPrefEntries();
  assert.deepEqual(entries.ownedListView, { value: { pageSize: 25 }, updatedAt: 0 });
  assert.deepEqual(entries.region, { value: 'DE', updatedAt: 900 });
});

test('setPref: debounces the push of a ranking: key and sends only the latest value', async (t) => {
  const restore = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({}) };
  };
  t.after(() => {
    globalThis.fetch = restore;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const { setPref, setSignedInSteamid } = require('../public/prefs.ts');
  setSignedInSteamid('76561198000000001');
  setPref('ranking:abc', { n: 1 });
  setPref('ranking:abc', { n: 2 });
  assert.equal(seen.length, 0);

  t.mock.timers.tick(3000);
  assert.deepEqual(
    seen.map((s) => [s.url, s.body.value]),
    [['/api/me/prefs/ranking%3Aabc', { n: 2 }]],
  );
});

test('flushPendingPushes: pushes a pending ranking: key immediately', async (t) => {
  const restore = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url, keepalive: opts.keepalive });
    return { ok: true, json: async () => ({}) };
  };
  t.after(() => {
    globalThis.fetch = restore;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const { setPref, setSignedInSteamid, flushPendingPushes } = require('../public/prefs.ts');
  setSignedInSteamid('76561198000000001');
  setPref('ranking:abc', { n: 1 });
  flushPendingPushes();
  assert.deepEqual(seen, [{ url: '/api/me/prefs/ranking%3Aabc', keepalive: true }]);
  t.mock.timers.tick(3000);
  assert.equal(seen.length, 1);
});

test('setPref: debounces the push of the lists key, so repeated view changes coalesce', async (t) => {
  const restore = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({}) };
  };
  t.after(() => {
    globalThis.fetch = restore;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const { setPref, setSignedInSteamid } = require('../public/prefs.ts');
  setSignedInSteamid('76561198000000001');
  setPref('lists', [1]);
  setPref('lists', [2]);
  assert.equal(seen.length, 0);

  t.mock.timers.tick(3000);
  assert.deepEqual(
    seen.map((s) => [s.url, s.body.value]),
    [['/api/me/prefs/lists', [2]]],
  );
});

test('setSignedInSteamid: signing out first pushes what is pending, under the account it was written for', async (t) => {
  const restore = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url, value: JSON.parse(opts.body).value });
    return { ok: true, json: async () => ({}) };
  };
  t.after(() => {
    globalThis.fetch = restore;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const { setPref, setSignedInSteamid } = require('../public/prefs.ts');
  setSignedInSteamid('76561198000000001');
  setPref('lists', [{ id: 'a', name: 'renamed' }]);
  setSignedInSteamid(null);
  assert.deepEqual(seen, [{ url: '/api/me/prefs/lists', value: [{ id: 'a', name: 'renamed' }] }]);
  t.mock.timers.tick(3000);
  assert.equal(seen.length, 1);
});

test('a push answered 401 reports the session lost, stops syncing and drops pending pushes', async (t) => {
  const restore = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(url);
    return { ok: false, status: 401, json: async () => ({ error: 'Not signed in' }) };
  };
  t.after(() => {
    globalThis.fetch = restore;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const { setPref, setSignedInSteamid, setOnSessionLost } = require('../public/prefs.ts');
  let lost = 0;
  const reported = new Promise((resolve) => setOnSessionLost(() => resolve(++lost)));
  setSignedInSteamid('76561198000000001');
  setPref('lists', [{ id: 'a' }]);
  setPref('region', 'DE');
  await reported;

  t.mock.timers.tick(3000);
  setPref('region', 'FR');
  assert.deepEqual(seen, ['/api/me/prefs/region']);
  assert.equal(lost, 1);
});

test('a push refused for another reason warns and keeps syncing', async (t) => {
  const restore = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(url);
    return { ok: false, status: 429, json: async () => ({}) };
  };
  t.after(() => {
    globalThis.fetch = restore;
  });
  const warn = t.mock.method(console, 'warn', () => {});

  const { setPref, setSignedInSteamid, setOnSessionLost } = require('../public/prefs.ts');
  let lost = 0;
  setOnSessionLost(() => lost++);
  setSignedInSteamid('76561198000000001');
  setPref('region', 'DE');
  await until(() => warn.mock.callCount() === 1, 'the refusal warned');
  assert.match(String(warn.mock.calls[0].arguments[0]), /^\[prefs\] .*"region".*429/);

  setPref('region', 'FR');
  assert.equal(seen.length, 2);
  assert.equal(lost, 0);
});

test('flushPendingPushes: a body over the browser keepalive limit is sent without keepalive', async (t) => {
  const restore = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push(opts.keepalive);
    return { ok: true, json: async () => ({}) };
  };
  t.after(() => {
    globalThis.fetch = restore;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const { setPref, setSignedInSteamid, flushPendingPushes } = require('../public/prefs.ts');
  setSignedInSteamid('76561198000000001');
  setPref('lists', [{ id: 'a', appids: Array.from({ length: 20000 }, (_, i) => i) }]);
  setPref('ranking:abc', { n: 1 });
  flushPendingPushes();
  assert.deepEqual(seen.sort(), [false, true]);
});

test('getPref is reactive per key: an effect reruns on its own key only', async () => {
  const { getPref, setPref, adoptPrefEntry } = require('../public/prefs.ts');
  const { createRoot, createEffect } = await import('solid-js');
  const seen = [];
  const dispose = createRoot((dispose) => {
    createEffect(() => seen.push(getPref('region', null)));
    return dispose;
  });
  setPref('lists', []);
  setPref('region', 'GB');
  adoptPrefEntry('region', 'DE', 1); // silent: see adoptPrefEntry
  dispose();
  assert.deepEqual(seen, [null, 'GB']);
});

// ── failed writes ───────────────────────────────────────────────────────────────────────────────

function refuseWrites() {
  global.localStorage.setItem = () => {
    throw new DOMException('full', 'QuotaExceededError');
  };
}

test('setPref: a write storage refuses is flagged and warned until one succeeds', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const { setPref, prefsWriteFailed } = require('../public/prefs.ts');
  const { setItem } = global.localStorage;
  refuseWrites();
  setPref('region', 'DE');
  setPref('region', 'GB');
  assert.equal(prefsWriteFailed(), true);
  assert.match(warn.mock.calls[0].arguments[0], /^\[prefs\]/);
  global.localStorage.setItem = setItem;
  setPref('region', 'US');
  assert.equal(prefsWriteFailed(), false);
});

test('dismissPrefsWriteFailure: hides failures until a write succeeds, then the next one shows', (t) => {
  t.mock.method(console, 'warn', () => {});
  const { setPref, prefsWriteFailed, dismissPrefsWriteFailure } = require('../public/prefs.ts');
  const { setItem } = global.localStorage;
  refuseWrites();
  setPref('region', 'DE');
  assert.equal(prefsWriteFailed(), true);
  dismissPrefsWriteFailure();
  assert.equal(prefsWriteFailed(), false);
  setPref('region', 'GB');
  assert.equal(prefsWriteFailed(), false);
  global.localStorage.setItem = setItem;
  setPref('region', 'US');
  refuseWrites();
  setPref('region', 'FR');
  assert.equal(prefsWriteFailed(), true);
});

test('setPref: a write storage refuses is not pushed, debounced or not', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const restore = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(url);
    return { ok: true, json: async () => ({}) };
  };
  t.after(() => {
    globalThis.fetch = restore;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { setPref, setSignedInSteamid, adoptPrefEntry } = require('../public/prefs.ts');
  setSignedInSteamid('76561198000000001');
  adoptPrefEntry('lists', [{ id: 'a', name: 'old' }], 1);
  refuseWrites();
  setPref('region', 'DE');
  setPref('lists', [{ id: 'a', name: 'renamed' }]);
  t.mock.timers.tick(3000);
  // A debounced push re-reads storage, so it would send the old value.
  assert.deepEqual(seen, []);
});

test('adoptPrefEntry: a refused write is not flagged (authStore.ts warns)', () => {
  const { adoptPrefEntry, prefsWriteFailed } = require('../public/prefs.ts');
  refuseWrites();
  assert.equal(adoptPrefEntry('region', 'DE', 1), false);
  assert.equal(prefsWriteFailed(), false);
});

// ── read cache (C204) ───────────────────────────────────────────────────────────────────────────

test('getPref: parses the stored blob once while it stays the same', (t) => {
  const { getPref, setPref } = require('../public/prefs.ts');
  setPref('region', 'DE');
  setPref('lists', [{ id: 'a' }]);
  const blob = global.localStorage.getItem('steam.isonoe.net:prefs');
  const parse = t.mock.method(JSON, 'parse');
  getPref('region');
  getPref('lists');
  getPref('region');
  assert.ok(parse.mock.calls.filter((c) => c.arguments[0] === blob).length <= 1);
});

test('getPref: each call returns its own copy, so mutating one never reaches storage or later reads', () => {
  const { getPref, setPref } = require('../public/prefs.ts');
  setPref('lists', [{ id: 'a', name: 'old' }]);
  getPref('lists')[0].name = 'mutated';
  assert.deepEqual(getPref('lists'), [{ id: 'a', name: 'old' }]);
});

test('getPref: sees a blob written straight to storage (another tab, a seed)', () => {
  const { getPref, setPref } = require('../public/prefs.ts');
  setPref('region', 'DE');
  assert.equal(getPref('region'), 'DE');
  global.localStorage.setItem(
    'steam.isonoe.net:prefs',
    JSON.stringify({ schemaVersion: 2, region: { value: 'GB', updatedAt: 1 } }),
  );
  assert.equal(getPref('region'), 'GB');
});

test('getPref: a refused write leaves the stored value readable, not the edit', (t) => {
  t.mock.method(console, 'warn', () => {});
  const { getPref, setPref } = require('../public/prefs.ts');
  setPref('region', 'DE');
  refuseWrites();
  setPref('region', 'GB');
  assert.equal(getPref('region'), 'DE');
});

// ── unchanged writes (C223) ─────────────────────────────────────────────────────────────────────

test('setPref: an unchanged value is neither written nor pushed, and keeps a pending push on time', async (t) => {
  const restore = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push([url, JSON.parse(opts.body).value]);
    return { ok: true, json: async () => ({}) };
  };
  t.after(() => {
    globalThis.fetch = restore;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { setPref, setSignedInSteamid } = require('../public/prefs.ts');
  setSignedInSteamid('76561198000000001');
  setPref('region', 'DE');
  setPref('lists', [1]);
  const setItem = t.mock.method(global.localStorage, 'setItem');
  t.mock.timers.tick(2000);
  setPref('region', 'DE');
  setPref('lists', [1]);
  assert.equal(setItem.mock.callCount(), 0);
  t.mock.timers.tick(1000);
  assert.deepEqual(seen, [
    ['/api/me/prefs/region', 'DE'],
    ['/api/me/prefs/lists', [1]],
  ]);
});

test('setPref: a key not stored yet is written even when its value is undefined', () => {
  const { getAllPrefEntries, setPref } = require('../public/prefs.ts');
  setPref('region', undefined);
  assert.ok('region' in getAllPrefEntries());
});

test('setPref: after a refused write, going back to the stored value still writes and clears the failure', (t) => {
  t.mock.method(console, 'warn', () => {});
  const { setPref, prefsWriteFailed } = require('../public/prefs.ts');
  setPref('region', 'DE');
  const { setItem } = global.localStorage;
  refuseWrites();
  setPref('region', 'GB');
  assert.equal(prefsWriteFailed(), true);
  global.localStorage.setItem = setItem;
  setPref('region', 'DE');
  assert.equal(prefsWriteFailed(), false);
});
