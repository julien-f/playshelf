'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setBaseTitle, setGameTitle } = require('../public/pageTitle.ts');

// pageTitle.js writes to the bare `document.title` global (it's loaded in a browser, not under
// jsdom here) — stub it before each test. baseTitle/gameTitle are real module-level state with
// no reset function of their own (Node's native TS stripping doesn't re-evaluate the module on a
// `delete require.cache`: the same instance comes back), so tests reset the two known setters
// back to null.
beforeEach(() => {
  global.document = { title: '' };
  setBaseTitle(null);
  setGameTitle(null);
});

test('with nothing set, the title is the bare app name', () => {
  assert.equal(global.document.title, 'Playshelf');
});

test('setBaseTitle: sets the route context, suffixed with the app name', () => {
  setBaseTitle('Library');
  assert.equal(global.document.title, 'Library — Playshelf');
});

test('setBaseTitle(null): falls back to the bare app name', () => {
  setBaseTitle('Library');
  setBaseTitle(null);
  assert.equal(global.document.title, 'Playshelf');
});

test('setGameTitle: overrides the base title entirely while a game is open', () => {
  setBaseTitle('Library');
  setGameTitle('Half-Life 2');
  assert.equal(global.document.title, 'Half-Life 2 — Playshelf');
});

test('setGameTitle(null): restores whatever the base title already was', () => {
  setBaseTitle('Library');
  setGameTitle('Half-Life 2');
  setGameTitle(null);
  assert.equal(global.document.title, 'Library — Playshelf');
});

test('setGameTitle with no base set: falls back to the bare app name once closed', () => {
  setGameTitle('Half-Life 2');
  assert.equal(global.document.title, 'Half-Life 2 — Playshelf');
  setGameTitle(null);
  assert.equal(global.document.title, 'Playshelf');
});
