'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { makeMemoryLocalStorage } = require('./memoryStorage.js');

beforeEach(() => {
  global.localStorage = makeMemoryLocalStorage();
  require('../public/prefs.ts')._resetPrefsState();
});

const mod = () => require('../public/panelOpenCards.ts');
const stored = () => require('../public/prefs.ts').getPref('panelOpenCards');

test('panelOpenCards: Price opens by default while the pref is unset', () => {
  assert.equal(mod().isPanelCardOpen('price'), true);
  assert.equal(mod().isPanelCardOpen('rating'), false);
  assert.equal(stored(), undefined);
});

test('togglePanelCard: opens and folds one card, keeping the others', () => {
  const { isPanelCardOpen, togglePanelCard } = mod();
  togglePanelCard('rating');
  assert.equal(isPanelCardOpen('rating'), true);
  assert.equal(isPanelCardOpen('price'), true);
  assert.deepEqual(stored(), ['price', 'rating']);
  togglePanelCard('rating');
  assert.equal(isPanelCardOpen('rating'), false);
  assert.deepEqual(stored(), ['price']);
});

test('togglePanelCard: folding Price stores [], which stays [] rather than the default', () => {
  const { isPanelCardOpen, togglePanelCard } = mod();
  togglePanelCard('price');
  assert.deepEqual(stored(), []);
  assert.equal(isPanelCardOpen('price'), false);
  require('../public/prefs.ts').setPref('panelOpenCards', []);
  assert.equal(isPanelCardOpen('price'), false);
});
