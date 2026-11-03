'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { archetypeOf, favouriteCreators, playStyleOf, playStyle, storyGames } = require('../public/playerProfile.ts');

const SOLO = ['Single-player'];
const COOP = ['Multi-player', 'Co-op', 'Online Co-op'];
const PVP = ['Multi-player', 'PvP', 'Online PvP'];
const game = (appid, categories, extra = {}) => ({ appid, categories, ...extra });
const hoursFrom = (byAppid) => (g) => byAppid[g.appid] ?? 0;

test('playStyleOf: a single mode decides; several go by the strongest mode tag, or nothing', () => {
  assert.equal(playStyleOf(game(1, SOLO)), 'solo');
  assert.equal(playStyleOf(game(1, COOP)), 'coop');
  assert.equal(playStyleOf(game(1, [])), null);
  const both = [...COOP, 'PvP'];
  assert.equal(playStyleOf(game(1, both, { details: { tagWeights: { 'Co-op': 1, PvP: 0.3 } } })), 'coop');
  assert.equal(playStyleOf(game(1, both, { details: { tagWeights: { 'Co-op': 0.4, PvP: 0.9 } } })), 'pvp');
  assert.equal(playStyleOf(game(1, both, { details: { tagWeights: { Action: 1 } } })), null);
  assert.equal(playStyleOf(game(1, [...SOLO, ...COOP], { details: { tagWeights: { Singleplayer: 1 } } })), 'solo');
});

test('playStyle: the style holding half the log-hours weight, from 8 played games', () => {
  const games = [1, 2, 3, 4, 5].map((id) => game(id, COOP)).concat([6, 7, 8].map((id) => game(id, PVP)));
  const hours = hoursFrom({ 1: 10, 2: 10, 3: 10, 4: 10, 5: 10, 6: 10, 7: 10, 8: 10 });
  assert.equal(playStyle(games, hours), 'coop');
  assert.equal(playStyle(games.slice(1), hours), null, 'below 8 played games');
});

test("playStyle: one huge game can't outweigh many, and no majority says nothing", () => {
  const games = [1, 2, 3, 4].map((id) => game(id, SOLO)).concat([5, 6, 7, 8].map((id) => game(id, PVP)));
  assert.equal(playStyle(games, hoursFrom({ 1: 2000, 2: 10, 3: 10, 4: 10, 5: 10, 6: 10, 7: 10, 8: 10 })), 'solo');
  const three = [1, 2, 3]
    .map((id) => game(id, SOLO))
    .concat(
      [4, 5, 6].map((id) => game(id, PVP)),
      [7, 8, 9].map((id) => game(id, COOP)),
    );
  assert.equal(
    playStyle(three, () => 10),
    null,
  );
});

test('playStyle: software, games under an hour and games without categories count for nothing', () => {
  const games = [1, 2, 3, 4, 5, 6, 7].map((id) => game(id, COOP));
  const extra = [game(8, SOLO, { genres: ['Utilities'] }), game(9, SOLO), game(10, [])];
  assert.equal(
    playStyle([...games, ...extra], hoursFrom({ 1: 5, 2: 5, 3: 5, 4: 5, 5: 5, 6: 5, 7: 5, 8: 3000, 9: 0.5, 10: 50 })),
    null,
  );
});

const story = (appid, main, tagWeights = { 'Story Rich': 1 }) =>
  game(appid, SOLO, { hltbMain: main, details: { tagWeights } });

test('storyGames: single-player games with an end, played for 80% of their main story', () => {
  const games = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => story(id, 10));
  const hours = hoursFrom({ 1: 8, 2: 9, 3: 20, 4: 2, 5: 7.9, 6: 30, 7: 10, 8: 1 });
  // Most played first in both.
  assert.deepEqual(storyGames(games, hours), { reached: [6, 3, 7, 2, 1], fellShort: [5, 4, 8] });
});

test('storyGames: endless, multiplayer, unknown-length and unplayed games are not story games', () => {
  const games = [1, 2, 3, 4, 5, 6, 7].map((id) => story(id, 10));
  const others = [
    story(8, 10, { Roguelike: 0.2 }),
    game(9, [...SOLO, ...COOP], { hltbMain: 10 }),
    story(10, null),
    story(11, 10),
  ];
  const hours = hoursFrom({ 1: 10, 2: 10, 3: 10, 4: 10, 5: 10, 6: 10, 7: 10, 8: 10, 9: 10, 10: 10, 11: 0 });
  assert.equal(storyGames([...games, ...others], hours), null);
});

test('storyGames: a status the player set wins over hours, even under an hour', () => {
  const games = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => story(id, 10));
  const hours = hoursFrom({ 1: 10, 2: 10, 3: 10, 4: 10, 5: 10, 6: 10, 7: 2, 8: 0 });
  const status = (g) => ({ 7: 'finished', 8: 'finished', 1: 'abandoned' })[g.appid] ?? null;
  assert.deepEqual(storyGames(games, hours, status), { reached: [2, 3, 4, 5, 6, 7, 8], fellShort: [1] });
  assert.equal(storyGames(games, hours), null, 'game 8, unplayed, counts only once marked');
});

test('archetypeOf: a title from the play style, story finishers among single-player profiles', () => {
  const story = (reached, of) => ({ reached: Array(reached).fill(0), fellShort: Array(of - reached).fill(0) });
  assert.equal(archetypeOf('solo', story(4, 8)).name, 'Story finisher');
  assert.equal(archetypeOf('solo', story(3, 8)).name, 'Solo explorer');
  assert.equal(archetypeOf('solo', null).name, 'Solo explorer');
  assert.equal(archetypeOf('coop', story(8, 8)).name, 'Co-op crew');
  assert.equal(archetypeOf('pvp', null).name, 'Competitor');
  assert.equal(archetypeOf('multiplayer', null).name, 'Squad player');
  assert.equal(archetypeOf(null, story(8, 8)), null);
  assert.equal(archetypeOf('solo', story(8, 8), { family: true }), null, "a Family's profile mixes its members");
});

const made = (appid, developers, publishers = developers, extra = {}) => ({ appid, developers, publishers, ...extra });
const filler = [91, 92, 93, 94, 95].map((id) => made(id, [`Solo ${id}`], [`Label ${id}`]));
const names = (creators) => creators.map((c) => c.name);

test('favouriteCreators: from 2 played games each, by log hours, ties by game count then name', () => {
  const games = [
    made(1, ['Marathon'], ['P']),
    made(2, ['Marathon'], ['P']),
    made(3, ['Variety'], ['P']),
    made(4, ['Variety'], ['P']),
    made(5, ['Variety'], ['P']),
    made(6, ['One Hit'], ['P']),
    made(7, ['Beta', 'Beta'], ['P']),
    made(8, ['Beta'], ['P']),
    made(9, ['Alpha'], ['P']),
    made(10, ['Alpha'], ['P']),
    ...filler,
  ];
  const hours = hoursFrom({
    1: 1000,
    2: 1,
    3: 30,
    4: 30,
    5: 30,
    6: 5000,
    7: 3,
    8: 3,
    9: 3,
    10: 3,
    91: 2,
    92: 2,
    93: 2,
    94: 2,
    95: 2,
  });
  const { developers } = favouriteCreators(games, hours);
  // Variety's 3×log(31) outweighs Marathon's log(1001)+log(2); One Hit has a single game.
  assert.deepEqual(names(developers), ['Variety', 'Marathon', 'Alpha']);
  assert.deepEqual(developers[1].appids, [1, 2], 'most played first');
});

test('favouriteCreators: a developer that also publishes shows once, as a developer, even outside the top 3', () => {
  const games = [
    ...[1, 2].map((id) => made(id, ['A'], ['Pub'])),
    ...[3, 4].map((id) => made(id, ['B'], ['Pub'])),
    ...[5, 6].map((id) => made(id, ['C'], ['C'])),
    ...[7, 8].map((id) => made(id, ['Self'], ['Self'])),
    ...[9, 10].map((id) => made(id, ['Only Dev 1'], ['Only Pub'])),
    ...filler,
  ];
  const hours = hoursFrom({ 1: 50, 2: 50, 3: 40, 4: 40, 5: 30, 6: 30, 7: 2, 8: 2, 9: 1, 10: 1 });
  const { developers, publishers } = favouriteCreators(games, hours);
  assert.deepEqual(names(developers), ['A', 'B', 'C']);
  assert.deepEqual(names(publishers), ['Pub', 'Only Pub'], 'Self and C publish only themselves');
});

test('favouriteCreators: software, under an hour and too thin a profile count for nothing', () => {
  const hours = hoursFrom({ 1: 10, 2: 10, 3: 0.5, 4: 10, 91: 2, 92: 2, 93: 2, 94: 2, 95: 2 });
  const games = [
    made(1, ['Tools'], ['Tools'], { genres: ['Utilities'] }),
    made(2, ['Tools'], ['Tools'], { genres: ['Utilities'] }),
    made(3, ['Brief']),
    made(4, ['Brief']),
    ...filler,
  ];
  assert.deepEqual(favouriteCreators(games, hours), { developers: [], publishers: [] });
  const thin = [made(1, ['Duo']), made(2, ['Duo']), made(3, ['X']), made(4, ['Y'])];
  assert.deepEqual(
    favouriteCreators(thin, () => 10),
    { developers: [], publishers: [] },
    'below 5 played games',
  );
});
