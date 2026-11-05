'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Same localStorage-stub convention as prefs.test.js — recentGames.ts is now backed by
// prefs.ts's shared blob rather than its own standalone localStorage key (see
// docs/dev/lists-and-accounts.md), so clear both modules' require caches per test.
function makeMemoryLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

const NOW = Date.UTC(2026, 10, 5, 12);

// Every test runs on a frozen clock, so stored stamps are known.
beforeEach((t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  global.localStorage = makeMemoryLocalStorage();
  delete require.cache[require.resolve('../public/prefs.ts')];
  delete require.cache[require.resolve('../public/recentGames.ts')];
});

function mod() {
  return require('../public/recentGames.ts');
}

// ── Recent games list ────────────────────────────────────────────────────────

test('loadRecentGames: returns [] when nothing was ever stored', () => {
  assert.deepEqual(mod().loadRecentGames(), []);
});

test('loadRecentGames: returns [] when the stored prefs blob is corrupt (same fallback prefs.ts already gives)', () => {
  global.localStorage.setItem('steam.isonoe.net:prefs', '{not json');
  assert.deepEqual(mod().loadRecentGames(), []);
});

test('addRecentGame/loadRecentGames: round-trips an entry, defaulting a missing thumbnail to null', () => {
  const { addRecentGame, loadRecentGames } = mod();
  addRecentGame(620, 'Portal 2', null);
  assert.deepEqual(loadRecentGames(), [{ appid: 620, name: 'Portal 2', tinyImage: null, lookedUpAt: NOW }]);
});

test('addRecentGame: re-adding an existing appid moves it to the front instead of duplicating it', () => {
  const { addRecentGame, loadRecentGames } = mod();
  addRecentGame(620, 'Portal 2', 'x');
  addRecentGame(400, 'Portal', 'y');
  addRecentGame(620, 'Portal 2', 'z'); // refreshed thumbnail
  const recents = loadRecentGames();
  assert.equal(recents.length, 2);
  assert.equal(recents[0].appid, 620);
  assert.equal(recents[0].tinyImage, 'z');
  assert.equal(recents[1].appid, 400);
});

test('addRecentGame: caps the list at MAX_RECENT_GAMES, dropping the oldest', () => {
  const { addRecentGame, loadRecentGames, MAX_RECENT_GAMES } = mod();
  for (let i = 0; i < MAX_RECENT_GAMES + 3; i++) addRecentGame(i, `Game ${i}`, null);
  const recents = loadRecentGames();
  assert.equal(recents.length, MAX_RECENT_GAMES);
  assert.equal(recents[0].appid, MAX_RECENT_GAMES + 2); // most recent first
  assert.equal(recents.at(-1).appid, 3); // games 0-2 were dropped
});

test('addRecentGame: coexists with other prefs keys in the same blob', () => {
  const { setPref, getPref } = require('../public/prefs.ts');
  const { addRecentGame } = mod();
  setPref('region', 'DE');
  addRecentGame(620, 'Portal 2', null);
  assert.equal(getPref('region'), 'DE');
});

// ── Empty name/thumbnail never clobbers a resolved one ───────────────────────

test('addRecentGame: an empty name keeps the name already stored (bare-appid lookup of a known game)', () => {
  const { addRecentGame, loadRecentGames } = mod();
  addRecentGame(440, 'Team Fortress 2', 'https://cdn/tf2.jpg');
  addRecentGame(440, '', null);
  assert.deepEqual(loadRecentGames(), [
    { appid: 440, name: 'Team Fortress 2', tinyImage: 'https://cdn/tf2.jpg', lookedUpAt: NOW },
  ]);
});

test('addRecentGame: a real name still overwrites an older one, and still moves the entry to the front', () => {
  const { addRecentGame, loadRecentGames } = mod();
  addRecentGame(440, 'Old Name', null);
  addRecentGame(620, 'Portal 2', null);
  addRecentGame(440, 'Team Fortress 2', 'https://cdn/tf2.jpg');
  assert.deepEqual(
    loadRecentGames().map((g) => [g.appid, g.name]),
    [
      [440, 'Team Fortress 2'],
      [620, 'Portal 2'],
    ],
  );
});

test('addRecentGame: an entry recorded with no name at all stores an empty one rather than a placeholder', () => {
  const { addRecentGame, loadRecentGames } = mod();
  addRecentGame(108600, '', null);
  assert.deepEqual(loadRecentGames(), [{ appid: 108600, name: '', tinyImage: null, lookedUpAt: NOW }]);
});

test('renameRecentGame: fills in a name without moving the entry to the front', () => {
  const { addRecentGame, renameRecentGame, loadRecentGames } = mod();
  addRecentGame(108600, '', null);
  addRecentGame(620, 'Portal 2', null);
  renameRecentGame(108600, 'Project Zomboid', 'https://cdn/pz.jpg');
  assert.deepEqual(loadRecentGames(), [
    { appid: 620, name: 'Portal 2', tinyImage: null, lookedUpAt: NOW },
    { appid: 108600, name: 'Project Zomboid', tinyImage: 'https://cdn/pz.jpg', lookedUpAt: NOW },
  ]);
});

test('renameRecentGame: an empty name/thumbnail leaves what is already stored alone', () => {
  const { addRecentGame, renameRecentGame, loadRecentGames } = mod();
  addRecentGame(440, 'Team Fortress 2', 'https://cdn/tf2.jpg');
  renameRecentGame(440, '', null);
  assert.deepEqual(loadRecentGames(), [
    { appid: 440, name: 'Team Fortress 2', tinyImage: 'https://cdn/tf2.jpg', lookedUpAt: NOW },
  ]);
});

test('renameRecentGame: a game that is not in the list is left out of it, not added', () => {
  const { renameRecentGame, loadRecentGames } = mod();
  renameRecentGame(440, 'Team Fortress 2', null);
  assert.deepEqual(loadRecentGames(), []);
});

// ── Look-up time ─────────────────────────────────────────────────────────────

test('addRecentGame: a later lookup of the same game restamps it', (t) => {
  const { addRecentGame, loadRecentGames } = mod();
  addRecentGame(620, 'Portal 2', null);
  t.mock.timers.tick(3_600_000);
  addRecentGame(620, 'Portal 2', null);
  assert.equal(loadRecentGames()[0].lookedUpAt, NOW + 3_600_000);
});

test("addRecentGame: the second write of one pick keeps the first's stamp", (t) => {
  const { addRecentGame, loadRecentGames } = mod();
  addRecentGame(620, '', null);
  t.mock.timers.tick(5000); // details land
  addRecentGame(620, 'Portal 2', 'x');
  assert.equal(loadRecentGames()[0].lookedUpAt, NOW);
});

test('addRecentGame: a game moved back to the front is restamped even within the same minute', (t) => {
  const { addRecentGame, loadRecentGames } = mod();
  addRecentGame(620, 'Portal 2', null);
  addRecentGame(400, 'Portal', null);
  t.mock.timers.tick(5000);
  addRecentGame(620, 'Portal 2', null);
  assert.equal(loadRecentGames()[0].lookedUpAt, NOW + 5000);
});

test('addRecentGame: stamps an entry recorded before stamps were kept', () => {
  const { setPref } = require('../public/prefs.ts');
  const { addRecentGame, loadRecentGames } = mod();
  setPref('recentGames', [{ appid: 620, name: 'Portal 2', tinyImage: null }]);
  addRecentGame(620, 'Portal 2', null);
  assert.equal(loadRecentGames()[0].lookedUpAt, NOW);
});

test('renameRecentGame: keeps the stamp, and an unstamped entry stays unstamped', (t) => {
  const { setPref } = require('../public/prefs.ts');
  const { renameRecentGame, loadRecentGames } = mod();
  setPref('recentGames', [
    { appid: 620, name: '', tinyImage: null, lookedUpAt: NOW - 1000 },
    { appid: 440, name: '', tinyImage: null },
  ]);
  t.mock.timers.tick(5000);
  renameRecentGame(620, 'Portal 2', null);
  renameRecentGame(440, 'Team Fortress 2', null);
  assert.deepEqual(loadRecentGames(), [
    { appid: 620, name: 'Portal 2', tinyImage: null, lookedUpAt: NOW - 1000 },
    { appid: 440, name: 'Team Fortress 2', tinyImage: null },
  ]);
});

test('lookedUpValue: an ISO timestamp, or null for an unstamped entry', () => {
  const { lookedUpValue } = mod();
  assert.equal(lookedUpValue({ appid: 620, name: '', tinyImage: null, lookedUpAt: NOW }), '2026-11-05T12:00:00.000Z');
  assert.equal(lookedUpValue({ appid: 620, name: '', tinyImage: null }), null);
});

// ── Server push ──────────────────────────────────────────────────────────────

// A search-box pick writes the entry, then again once its details land (AppShell.tsx, SearchRoute.tsx).
test('addRecentGame: lookups in a row push recentGames once after a pause, and an unchanged write not at all', async (t) => {
  const restore = globalThis.fetch;
  const puts = [];
  globalThis.fetch = async (url, opts) => {
    puts.push({ url, value: JSON.parse(opts.body).value });
    return { ok: true, json: async () => ({}) };
  };
  const prefs = require('../public/prefs.ts');
  t.after(() => {
    globalThis.fetch = restore;
    prefs._resetPrefsState();
  });
  prefs._resetPrefsState();
  prefs.setSignedInSteamid('76561198000000001');
  const { addRecentGame } = mod();

  for (let i = 0; i < 5; i++) {
    addRecentGame(i, `Game ${i}`, null);
    addRecentGame(i, `Game ${i}`, null);
  }
  t.mock.timers.tick(3000);
  assert.deepEqual(
    puts.map((p) => [p.url, p.value.length]),
    [['/api/me/prefs/recentGames', 5]],
  );

  addRecentGame(4, 'Game 4', null); // already first, nothing changed
  t.mock.timers.tick(3000);
  assert.equal(puts.length, 1);
});
