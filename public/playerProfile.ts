import type { GameStatus } from './gameStatuses.ts';
import { isSoftware, MIN_PLAYED_FOR_PROFILE } from './tagTaste.ts';

// Facts about how an account plays, beyond Plays mostly's tags: said as sentences, each silent
// below the number of games it needs to mean anything.

export interface ProfileGame {
  appid: number;
  genres?: string[];
  categories?: string[];
  hltbMain?: number | null;
  developers?: string[];
  publishers?: string[];
  details?: { tagWeights?: Record<string, number | null> | null } | null;
}

export type PlayStyle = 'solo' | 'coop' | 'pvp' | 'multiplayer';

// Below an hour, a launch says little about how the game is played.
const MIN_HOURS = 1;
// Fewer played (or story) games than this, and a share is mostly chance.
const MIN_GAMES = 8;
// Hours at or past this share of HLTB's main story count as played through it.
const STORY_SHARE = 0.8;

const MODE_CATEGORIES: Record<Exclude<PlayStyle, 'solo'>, string[]> = {
  pvp: ['PvP', 'Online PvP', 'LAN PvP', 'Shared/Split Screen PvP'],
  coop: ['Co-op', 'Online Co-op', 'LAN Co-op', 'Shared/Split Screen Co-op'],
  multiplayer: ['Multi-player', 'MMO', 'Cross-Platform Multiplayer'],
};
const MODE_TAGS: Record<PlayStyle, string[]> = {
  solo: ['Singleplayer'],
  coop: ['Co-op', 'Online Co-Op', 'Local Co-Op'],
  pvp: ['PvP', 'Online PvP'],
  multiplayer: ['Multiplayer', 'Massively Multiplayer', 'Local Multiplayer'],
};
// Played without end, so hours say nothing about reaching the end of a story.
const ENDLESS_TAGS = [
  'Roguelike',
  'Roguelite',
  'Sandbox',
  'Simulation',
  'Open World Survival Craft',
  'MMORPG',
  'Massively Multiplayer',
  'Grand Strategy',
  '4X',
  'City Builder',
  'Colony Sim',
];

const isPlayed = (g: ProfileGame, hours: number) => hours >= MIN_HOURS && !isSoftware(g);

// The modes a game's categories offer, solo included; empty when the store page didn't answer.
function modesOf(g: ProfileGame): PlayStyle[] {
  const categories = new Set(g.categories ?? []);
  const modes = (['pvp', 'coop'] as const).filter((m) =>
    MODE_CATEGORIES[m].some((c) => categories.has(c)),
  ) as PlayStyle[];
  // "Multi-player" comes with every co-op and PvP game: a mode of its own only without them.
  if (!modes.length && MODE_CATEGORIES.multiplayer.some((c) => categories.has(c))) modes.push('multiplayer');
  if (categories.has('Single-player')) modes.push('solo');
  return modes;
}

// A game offering several modes goes by its strongest mode tag (players tag what they play it
// for); with no tag to tell, it says nothing about its player.
export function playStyleOf(g: ProfileGame): PlayStyle | null {
  const modes = modesOf(g);
  if (modes.length <= 1) return modes[0] ?? null;
  const weights = g.details?.tagWeights ?? {};
  const strength = (m: PlayStyle) => Math.max(0, ...MODE_TAGS[m].map((tag) => weights[tag] ?? 0));
  const [best, next] = modes.map((m) => ({ m, w: strength(m) })).sort((a, b) => b.w - a.w);
  return best.w > next.w ? best.m : null;
}

// The play style holding at least half the played games' weight (log hours, so one 2000 h game
// can't decide alone); null below MIN_GAMES or without a majority.
export function playStyle(games: readonly ProfileGame[], hours: (g: ProfileGame) => number): PlayStyle | null {
  const weights = new Map<PlayStyle, number>();
  let total = 0;
  let counted = 0;
  for (const g of games) {
    const h = hours(g);
    const style = isPlayed(g, h) ? playStyleOf(g) : null;
    if (!style) continue;
    const w = Math.log1p(h);
    weights.set(style, (weights.get(style) ?? 0) + w);
    total += w;
    counted++;
  }
  if (counted < MIN_GAMES) return null;
  const [style, w] = [...weights].sort((a, b) => b[1] - a[1])[0];
  return w >= total / 2 ? style : null;
}

const isStoryGame = (g: ProfileGame) => {
  const modes = modesOf(g);
  const weights = g.details?.tagWeights ?? {};
  return modes.length === 1 && modes[0] === 'solo' && !!g.hltbMain && !ENDLESS_TAGS.some((tag) => weights[tag] != null);
};

export interface StoryGames {
  // Appids, most played first: played for their main story's length, and the others.
  reached: number[];
  fellShort: number[];
}

// Of the played single-player games with an end, which were played for their main story's length (hours
// can't say it was finished, only that it could have been), unless the player marked it (gameStatuses.ts).
export function storyGames(
  games: readonly ProfileGame[],
  hours: (g: ProfileGame) => number,
  status: (g: ProfileGame) => GameStatus | null = () => null,
): StoryGames | null {
  const story = games.filter((g) => (status(g) || isPlayed(g, hours(g))) && !isSoftware(g) && isStoryGame(g));
  if (story.length < MIN_GAMES) return null;
  const reached = (g: ProfileGame) => (status(g) ? status(g) === 'finished' : hours(g) >= STORY_SHARE * g.hltbMain!);
  const byHours = story.sort((a, b) => hours(b) - hours(a));
  return {
    reached: byHours.filter(reached).map((g) => g.appid),
    fellShort: byHours.filter((g) => !reached(g)).map((g) => g.appid),
  };
}

export interface Creator {
  name: string;
  appids: number[]; // its played games, most played first
}

// From this many played games, a studio is one the player comes back to, not just their most played game.
const MIN_CREATOR_GAMES = 2;
const CREATORS_SHOWN = 3;

// The developers and publishers of the most played games (log hours each, as playStyle weighs), from
// MIN_CREATOR_GAMES played games each; a developer that also publishes shows once, as a developer.
export function favouriteCreators(
  games: readonly ProfileGame[],
  hours: (g: ProfileGame) => number,
): { developers: Creator[]; publishers: Creator[] } {
  const played = games.filter((g) => isPlayed(g, hours(g))).sort((a, b) => hours(b) - hours(a));
  if (played.length < MIN_PLAYED_FOR_PROFILE) return { developers: [], publishers: [] };
  const rank = (role: 'developers' | 'publishers', skip: ReadonlySet<string>) => {
    const byName = new Map<string, { appids: number[]; weight: number }>();
    for (const g of played)
      for (const name of new Set(g[role] ?? [])) {
        if (skip.has(name)) continue;
        const entry = byName.get(name) ?? { appids: [], weight: 0 };
        entry.appids.push(g.appid);
        entry.weight += Math.log1p(hours(g));
        byName.set(name, entry);
      }
    return [...byName]
      .filter(([, e]) => e.appids.length >= MIN_CREATOR_GAMES)
      .sort(([an, a], [bn, b]) => b.weight - a.weight || b.appids.length - a.appids.length || an.localeCompare(bn));
  };
  const developers = rank('developers', new Set());
  const publishers = rank('publishers', new Set(developers.map(([name]) => name)));
  const shown = (ranked: typeof developers) =>
    ranked.slice(0, CREATORS_SHOWN).map(([name, e]) => ({ name, appids: e.appids }));
  return { developers: shown(developers), publishers: shown(publishers) };
}

export const STYLE_SENTENCES: Record<PlayStyle, string> = {
  solo: 'Mostly single-player games',
  coop: 'Mostly co-op games',
  pvp: 'Mostly PvP games',
  multiplayer: 'Mostly multiplayer games',
};

export interface Archetype {
  name: string;
  icon: 'book-open' | 'compass' | 'handshake' | 'swords' | 'users';
}

// A title for the profile's headline, from what it already says; null without a play style, and for a
// Family, whose profile mixes its members.
export function archetypeOf(
  style: PlayStyle | null,
  story: StoryGames | null,
  { family = false } = {},
): Archetype | null {
  if (!style || family) return null;
  if (style === 'solo')
    return story && story.reached.length >= story.fellShort.length
      ? { name: 'Story finisher', icon: 'book-open' }
      : { name: 'Solo explorer', icon: 'compass' };
  if (style === 'coop') return { name: 'Co-op crew', icon: 'handshake' };
  if (style === 'pvp') return { name: 'Competitor', icon: 'swords' };
  return { name: 'Squad player', icon: 'users' };
}
