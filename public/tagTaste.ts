type Weights = Record<string, number | null> | null | undefined;
type TagWeights = Record<string, number | null>;
type Vector = Map<string, number>;
type Tagged = {
  appid: number;
  productionTier?: string | null;
  genres?: string[];
  details?: { tagWeights?: Weights } | null;
};

// Steam store genres only software carries; appdetails types it "game" all the same (integrations.md).
const SOFTWARE_GENRES = new Set([
  'Utilities',
  'Animation & Modeling',
  'Design & Illustration',
  'Video Production',
  'Audio Production',
  'Photo Editing',
  'Software Training',
  'Web Publishing',
  'Game Development',
]);
// Wallpaper Engine left running for 3000 h says nothing about what its owner plays.
export const isSoftware = (g: { genres?: string[] }) => !!g.genres?.some((genre) => SOFTWARE_GENRES.has(genre));

// Production Tier as one more dimension: budget is something Steam tags don't say (no "AAA" tag).
const TIER_PREFIX = 'tier:';
function featuresOf(g: Omit<Tagged, 'appid'>): TagWeights {
  const tags = g.details!.tagWeights!;
  return g.productionTier ? { ...tags, [TIER_PREFIX + g.productionTier]: 1 } : tags;
}

// 0 for a tag every game carries, higher the rarer it is.
function inverseFrequency(corpus: readonly TagWeights[]): (tag: string) => number {
  const df = new Map<string, number>();
  for (const w of corpus) for (const tag of Object.keys(w)) df.set(tag, (df.get(tag) ?? 0) + 1);
  return (tag) => Math.log((1 + corpus.length) / (1 + (df.get(tag) ?? 0)));
}

function vectorOf(weights: TagWeights, idf: (tag: string) => number, scale = 1): Vector {
  const v: Vector = new Map();
  for (const [tag, w] of Object.entries(weights)) if (w) v.set(tag, w * scale * idf(tag));
  return v;
}

function cosine(a: Vector, b: Vector): number {
  let dot = 0;
  for (const [tag, x] of a) dot += x * (b.get(tag) ?? 0);
  const norms = Math.hypot(...a.values()) * Math.hypot(...b.values());
  return norms ? dot / norms : 0;
}

export interface Similar<T> {
  game: T;
  score: number; // 0–100
}

// Cosine over tag weights scaled by rarity (IDF), so tags nearly all `games` carry don't make all alike.
export function similarGames<T extends Tagged>(target: T, games: readonly T[], limit: number): Similar<T>[] {
  const weighted = games.filter((g) => g.appid !== target.appid && g.details?.tagWeights);
  if (!target.details?.tagWeights) return [];
  const idf = inverseFrequency([featuresOf(target), ...weighted.map(featuresOf)]);
  const t = vectorOf(featuresOf(target), idf);
  return weighted
    .map((game) => ({ game, score: Math.round(cosine(vectorOf(featuresOf(game), idf), t) * 100) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// Below this many played games, a profile says more about chance than taste.
export const MIN_PLAYED_FOR_PROFILE = 5;

type Hours<T> = (g: T) => number | undefined;
const ownPlaytime = (g: { playtime?: number }) => g.playtime;

function playedOf<T extends Omit<Tagged, 'appid'>>(weighted: readonly T[], hours: Hours<T>) {
  return weighted
    .filter((g) => hours(g) && !isSoftware(g))
    .map((game) => ({ game, hours: hours(game)!, weights: featuresOf(game) }));
}

// Tag weights × log playtime (one 2000 h game can't drown the rest) × rarity; null if too few played.
function playProfile(played: readonly { hours: number; weights: TagWeights }[], idf: (tag: string) => number) {
  if (played.length < MIN_PLAYED_FOR_PROFILE) return null;
  const profile: Vector = new Map();
  for (const { hours, weights } of played)
    for (const [tag, x] of vectorOf(weights, idf, Math.log1p(hours))) profile.set(tag, (profile.get(tag) ?? 0) + x);
  return profile;
}

export interface PlayedTag {
  tag: string;
  weight: number; // relative to the top shown tag's score, 0–1
  games: { appid: number; name: string; hours: number }[]; // the played games counting most toward it
}

const GAMES_PER_TAG = 3;

// `played`: how many games the profile is built from. `hours`: a comparison player's, not the row's own.
export function topPlayedTags<T extends Tagged & { name: string; playtime?: number }>(
  games: readonly T[],
  limit: number,
  hours: Hours<T> = ownPlaytime,
): { tags: PlayedTag[]; played: number } {
  const weighted = games.filter((g) => g.details?.tagWeights);
  const idf = inverseFrequency(weighted.map(featuresOf));
  const played = playedOf(weighted, hours);
  const top = [...(playProfile(played, idf) ?? [])]
    .filter(([tag, score]) => score > 0 && !tag.startsWith(TIER_PREFIX))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  const tags = top.map(([tag, score]) => ({
    tag,
    weight: score / top[0][1],
    // A tag's idf is the same for every game, so this orders them by their share of its score.
    games: played
      .map(({ game, hours, weights }) => ({
        appid: game.appid,
        name: game.name,
        hours,
        share: (weights[tag] ?? 0) * Math.log1p(hours),
      }))
      .filter((g) => g.share > 0)
      .sort((a, b) => b.share - a.share)
      .slice(0, GAMES_PER_TAG)
      .map(({ appid, name, hours }) => ({ appid, name, hours })),
  }));
  return { tags, played: played.length };
}

export interface PlayerFits {
  byGame: Map<number, (number | null)[]>; // per player, 0–100; null for one without a profile
  profiled: boolean[];
}

// Per game, how close it is to each player's play profile; null when no player has one.
export function playerFits(
  games: readonly Tagged[],
  hoursPlayed: readonly ((appid: number) => number | undefined)[],
): PlayerFits | null {
  const weighted = games.filter((g) => g.details?.tagWeights);
  const idf = inverseFrequency(weighted.map(featuresOf));
  const profiles = hoursPlayed.map((hours) =>
    playProfile(
      weighted
        .filter((g) => hours(g.appid) && !isSoftware(g))
        .map((g) => ({ hours: hours(g.appid)!, weights: featuresOf(g) })),
      idf,
    ),
  );
  if (!profiles.some(Boolean)) return null;
  const byGame = new Map(
    weighted.map((g) => {
      const v = vectorOf(featuresOf(g), idf);
      return [g.appid, profiles.map((p) => (p ? Math.round(cosine(p, v) * 100) : null))];
    }),
  );
  return { byGame, profiled: profiles.map(Boolean) };
}

export interface LibraryGame {
  appid: number;
  name: string;
  tags: Record<string, number>; // its top LIBRARY_TAGS features
}

// An account's play profile and library, kept to score games outside it (a wishlist, a bundle, a lookup).
export interface Taste {
  at: number;
  profile: Record<string, number> | null; // null: too few games played
  idf: Record<string, number>; // across the library; a tag it lacks gets `unseenIdf`
  unseenIdf: number;
  games: LibraryGame[];
}

// Keeps a large library's entry small; the weakest tags barely move a cosine.
const LIBRARY_TAGS = 10;

const round2 = (x: number) => Math.round(x * 100) / 100;

function topFeatures(g: Omit<Tagged, 'appid'>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(featuresOf(g))
      .filter((e): e is [string, number] => !!e[1])
      .sort((a, b) => b[1] - a[1])
      .slice(0, LIBRARY_TAGS)
      .map(([tag, w]) => [tag, round2(w)]),
  );
}

export function tasteOf(games: readonly (Tagged & { name: string; playtime?: number })[], at: number): Taste | null {
  const weighted = games.filter((g) => g.details?.tagWeights);
  if (!weighted.length) return null;
  const corpus = weighted.map(featuresOf);
  const idf = inverseFrequency(corpus);
  const profile = playProfile(playedOf(weighted, ownPlaytime), idf);
  const tags = new Set(corpus.flatMap(Object.keys));
  return {
    at,
    profile: profile && Object.fromEntries([...profile].map(([tag, x]) => [tag, round2(x)])),
    idf: Object.fromEntries([...tags].map((tag) => [tag, round2(idf(tag))])),
    unseenIdf: round2(Math.log(1 + corpus.length)),
    games: weighted.map((g) => ({ appid: g.appid, name: g.name, tags: topFeatures(g) })),
  };
}

const idfOf = (taste: Taste) => (tag: string) => taste.idf[tag] ?? taste.unseenIdf;

// The library's games closest to `game`, by the same measure as similarGames.
export function similarInLibrary(taste: Taste, game: Tagged, limit: number): Similar<LibraryGame>[] {
  if (!game.details?.tagWeights) return [];
  const t = vectorOf(topFeatures(game), idfOf(taste));
  return taste.games
    .filter((g) => g.appid !== game.appid)
    .map((g) => ({ game: g, score: Math.round(cosine(vectorOf(g.tags, idfOf(taste)), t) * 100) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// Built once per stored taste, not once per scored row.
const profileVectors = new WeakMap<Taste, Vector>();

// 0–100; null for a game without tag weights, or a library with too few games played.
export function fitTo(taste: Taste, game: Omit<Tagged, 'appid'>): number | null {
  if (!taste.profile || !game.details?.tagWeights) return null;
  let profile = profileVectors.get(taste);
  if (!profile) profileVectors.set(taste, (profile = new Map(Object.entries(taste.profile))));
  const v = vectorOf(featuresOf(game), idfOf(taste));
  return Math.round(cosine(profile, v) * 100);
}

export interface ComparedPlayer {
  owns: (appid: number) => boolean;
  hours: (appid: number) => number;
}

export interface CommonGround {
  sharedTags: string[]; // in every profiled player's top tags, strongest for the least keen first
  sharedCount: number; // how many tags are in every profiled player's top tags, beyond the few shown
  ownTags: string[][]; // per player, top tags they play more than any other player
  pairs: { a: number; b: number; shared: number | null }[]; // top tags in common; null: a player without a profile
  closest: { a: number; b: number; shared: number } | null; // 3+ players, when one pair shares the most
  oddOneOut: number | null; // 3+ players, when one shares fewer with each than any other pair does
  favourites: number[]; // appids every player has at least their median (and 5 h) in
}

// How many of each player's top tags are compared: a count of them is how alike a pair is, a fact
// that needs no calibration, unlike a similarity score with no population to say what's typical.
export const TOP_TAGS = 10;
const TAGS_SHOWN = 3;
const FAVOURITES_SHOWN = 5;
const MIN_FAVOURITE_HOURS = 5;

const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : 0;
};

// The hours past which a game counts as one a player played a lot: their median, and 5 h at least.
function playedALot(games: readonly Tagged[], player: ComparedPlayer): number {
  const hours = games
    .filter((g) => !isSoftware(g))
    .map((g) => player.hours(g.appid))
    .filter((h) => h > 0);
  return hours.length ? Math.max(MIN_FAVOURITE_HOURS, median(hours)) : Infinity;
}

export function commonGround(games: readonly Tagged[], players: readonly ComparedPlayer[]): CommonGround {
  const weighted = games.filter((g) => g.details?.tagWeights);
  const idf = inverseFrequency(weighted.map(featuresOf));
  const shares = players.map((p) => {
    const profile = playProfile(
      weighted
        .filter((g) => p.hours(g.appid) && !isSoftware(g))
        .map((g) => ({ hours: p.hours(g.appid), weights: featuresOf(g) })),
      idf,
    );
    if (!profile) return null;
    const shown = [...profile].filter(([tag, x]) => x > 0 && !tag.startsWith(TIER_PREFIX));
    const total = shown.reduce((sum, [, x]) => sum + x, 0);
    return new Map(shown.map(([tag, x]) => [tag, x / total]));
  });
  const tops = shares.map(
    (s) =>
      s &&
      new Set(
        [...s]
          .sort((a, b) => b[1] - a[1])
          .slice(0, TOP_TAGS)
          .map(([tag]) => tag),
      ),
  );
  const profiled = players.map((_, i) => i).filter((i) => tops[i]);
  const compared = profiled.length >= 2;
  const ranked = (scores: [string, number][]) =>
    scores
      .filter(([, x]) => x > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, TAGS_SHOWN)
      .map(([tag]) => tag);
  const inEveryTop = compared ? [...tops[profiled[0]]!].filter((tag) => profiled.every((i) => tops[i]!.has(tag))) : [];
  const sharedTags = ranked(inEveryTop.map((tag) => [tag, Math.min(...profiled.map((i) => shares[i]!.get(tag)!))]));
  const ownTags = players.map((_, i) =>
    compared && shares[i]
      ? ranked(
          [...tops[i]!]
            .filter((tag) => !inEveryTop.includes(tag))
            .map((tag) => [
              tag,
              shares[i]!.get(tag)! - Math.max(...profiled.filter((j) => j !== i).map((j) => shares[j]!.get(tag) ?? 0)),
            ]),
        )
      : [],
  );

  const pairs = players.flatMap((_, a) =>
    players.slice(a + 1).map((__, k) => {
      const b = a + 1 + k;
      const [ta, tb] = [tops[a], tops[b]];
      return { a, b, shared: ta && tb ? [...ta].filter((tag) => tb.has(tag)).length : null };
    }),
  );
  let closest: CommonGround['closest'] = null;
  let oddOneOut: number | null = null;
  const counted = pairs.filter((p): p is typeof p & { shared: number } => p.shared != null);
  if (players.length >= 3 && counted.length === pairs.length) {
    const [best, next] = [...counted].sort((x, y) => y.shared - x.shared);
    if (best.shared > next.shared) closest = best;
    const involving = (i: number, inPair: boolean) =>
      counted.filter((p) => (p.a === i || p.b === i) === inPair).map((p) => p.shared);
    oddOneOut =
      players.map((_, i) => i).find((i) => Math.max(...involving(i, true)) < Math.min(...involving(i, false))) ?? null;
  }

  const thresholds = players.map((p) => playedALot(games, p));
  const favourites = games
    .filter((g) => !isSoftware(g) && players.every((p, i) => p.hours(g.appid) >= thresholds[i]))
    .map((g) => ({ appid: g.appid, weight: players.reduce((sum, p) => sum + Math.log1p(p.hours(g.appid)), 0) }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, FAVOURITES_SHOWN)
    .map((f) => f.appid);

  return { sharedTags, sharedCount: inEveryTop.length, ownTags, pairs, closest, oddOneOut, favourites };
}

export interface Suggestion {
  appid: number;
  from: number; // the player who played it most
  hours: number; // theirs
  owns: boolean; // whether the suggested-to player owns it
}

const SUGGESTIONS_SHOWN = 5;

// Games other players played a lot that `target` never has, among the third of those unplayed
// games closest to `target`'s taste, closest first; null when `target` has no profile.
export function suggestionsFor(
  games: readonly Tagged[],
  players: readonly ComparedPlayer[],
  target: number,
): Suggestion[] | null {
  const tagged = games.filter((g) => g.details?.tagWeights);
  const idf = inverseFrequency(tagged.map(featuresOf));
  const candidates = tagged.filter((g) => !isSoftware(g));
  const me = players[target];
  const profile = playProfile(
    candidates.filter((g) => me.hours(g.appid)).map((g) => ({ hours: me.hours(g.appid), weights: featuresOf(g) })),
    idf,
  );
  if (!profile) return null;
  // Ranked among the games `target` hasn't played: the ones they have are what the profile is made of.
  const unplayed = candidates.filter((g) => !me.hours(g.appid));
  const fits = new Map(unplayed.map((g) => [g.appid, cosine(profile, vectorOf(featuresOf(g), idf))]));
  const sorted = [...fits.values()].sort((a, b) => b - a);
  const topThird = sorted[Math.ceil(sorted.length / 3) - 1];
  const bars = players.map((p) => playedALot(games, p));
  return unplayed
    .filter((g) => fits.get(g.appid)! >= topThird && fits.get(g.appid)! > 0)
    .flatMap((g) => {
      const from = players
        .map((p, i) => ({ i, hours: p.hours(g.appid) }))
        .filter(({ i, hours }) => i !== target && hours >= bars[i])
        .sort((a, b) => b.hours - a.hours)[0];
      return from
        ? [{ appid: g.appid, from: from.i, hours: from.hours, owns: me.owns(g.appid), fit: fits.get(g.appid)! }]
        : [];
    })
    .sort((a, b) => b.fit - a.fit || b.hours - a.hours)
    .slice(0, SUGGESTIONS_SHOWN)
    .map(({ appid, from, hours, owns }) => ({ appid, from, hours, owns }));
}
