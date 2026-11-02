// The `big-library` mock state's synthetic games: an Owned list the size of the code backlog's perf baseline,
// for scripts/perf-measure.js. Deterministic, and sized like a real stream event (raw and gzipped).
import type { CatalogGame } from './fixtures.ts';

export const BIG_LIBRARY_SIZE = 1200;
const FIRST_APPID = 9_000_000; // a range no fixture uses
export const BIG_LIBRARY_APPIDS = Array.from({ length: BIG_LIBRARY_SIZE }, (_, i) => FIRST_APPID + i);

// mulberry32: a seeded PRNG, so every run streams the same bytes.
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS =
  'ancient brave castle dungeon empire forest galaxy harbor island jungle kingdom legend machine nebula ocean planet quest river shadow tower valley wizard warrior pilot hunter thief knight robot dragon zombie farm city racing puzzle rogue tactics survival craft build explore trade fight escape defend sail fly mine cook'.split(
    ' ',
  );
const TAGS =
  'Action Adventure RPG Strategy Simulation Indie Casual Puzzle Platformer Shooter Roguelike Survival Open World Sandbox Story Rich Atmospheric Pixel Graphics Co-op Multiplayer Singleplayer Fantasy Sci-fi Horror Exploration Crafting Building Management Turn-Based Tactical Card Game Deckbuilding Metroidvania Souls-like Hack and Slash Stealth Racing Sports Physics Funny Cute Relaxing Difficult Great Soundtrack Retro 2D 3D First-Person Third Person Top-Down Isometric Base Building Resource Management Procedural Generation Permadeath Choices Matter Multiple Endings Female Protagonist Post-apocalyptic Space Medieval Cyberpunk Steampunk Military Historical Mystery Detective Comedy Dark Psychological Horror'.split(
    ' ',
  );
const GENRES = ['Action', 'Adventure', 'RPG', 'Strategy', 'Simulation', 'Indie', 'Casual', 'Sports', 'Racing'];
const CATEGORIES = [
  'Single-player',
  'Multi-player',
  'Co-op',
  'Online Co-op',
  'PvP',
  'Steam Achievements',
  'Full controller support',
  'Steam Trading Cards',
  'Steam Cloud',
  'Remote Play Together',
  'Family Sharing',
  'Steam Leaderboards',
];
const LANGUAGES =
  'English French German Spanish Italian Japanese Korean Polish Portuguese Russian Turkish Ukrainian Czech Dutch Danish Finnish Norwegian Swedish Hungarian Romanian Thai Vietnamese Arabic Greek Bulgarian Indonesian'.split(
    ' ',
  );
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
const PROTONDB = ['platinum', 'gold', 'silver', 'bronze', 'borked', null] as const;

const pick = <T>(rnd: () => number, from: readonly T[]): T => from[Math.floor(rnd() * from.length)];
const pickSome = <T>(rnd: () => number, from: readonly T[], n: number): T[] =>
  [...from].sort(() => rnd() - 0.5).slice(0, n);
const sentence = (rnd: () => number, n: number) => Array.from({ length: n }, () => pick(rnd, WORDS)).join(' ');
// Made-up words for descriptions: a small vocabulary would gzip far better than real text does.
const SYLLABLES = 'ba ke ri to nu sha vel dor mi qua zen lo tru fy gan per sol wix ar em ul ost ny bre'.split(' ');
const prose = (rnd: () => number, n: number) =>
  Array.from({ length: n }, () =>
    Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(rnd, SYLLABLES)).join(''),
  ).join(' ');

export interface BigLibraryGame extends CatalogGame {
  description: string;
  languages: string[];
}

export function bigLibraryGame(appid: number): BigLibraryGame | undefined {
  if (appid < FIRST_APPID || appid >= FIRST_APPID + BIG_LIBRARY_SIZE) return undefined;
  const rnd = random(appid);
  const tagNames = pickSome(rnd, TAGS, 8 + Math.floor(rnd() * 12));
  return {
    appid,
    name: `${sentence(rnd, 2)} ${appid - FIRST_APPID}`.replace(/^./, (c) => c.toUpperCase()),
    score: 40 + Math.floor(rnd() * 60),
    reviews: Math.floor(10 ** (1 + rnd() * 5)),
    hltb: rnd() < 0.2 ? 0 : Math.round(rnd() * 800) / 10,
    genres: pickSome(rnd, GENRES, 1 + Math.floor(rnd() * 3)),
    categories: pickSome(rnd, CATEGORIES, 3 + Math.floor(rnd() * 8)),
    release: `${pick(rnd, MONTHS)} ${1 + Math.floor(rnd() * 28)}, ${2005 + Math.floor(rnd() * 21)}`,
    protondb: pick(rnd, PROTONDB),
    tags: Object.fromEntries(tagNames.map((t, i) => [t, Math.round((1 - i / tagNames.length) * 100) / 100])),
    description: `${prose(rnd, 70)}.`,
    languages: pickSome(rnd, LANGUAGES, 3 + Math.floor(rnd() * 20)),
  };
}

interface Meta {
  name: string;
  type: string;
  description: string;
  releaseDate: string;
  comingSoon: boolean;
}

// What a real event carries beyond the fixtures' shape: `basics`, and Steam's longer art URLs.
export function withRealShape<T extends { appid: number; meta: Meta; fetchedAt: number }>(details: T) {
  const rnd = random(details.appid * 7);
  // Per game, as real rows are cached at different times.
  const stamp = () => details.fetchedAt - Math.floor(rnd() * 30 * 86400_000);
  const art = (file: string) =>
    `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${details.appid}/${file}?t=${stamp()}`;
  const studio = () => [prose(rnd, 2).replace(/^./, (c) => c.toUpperCase())];
  const developers = studio();
  const publishers = rnd() < 0.5 ? developers : studio();
  const { name, type, description, releaseDate, comingSoon } = details.meta;
  const images = {
    capsule: art('capsule_184x69.jpg'),
    thumb: art('capsule_231x87.jpg'),
    banner: art('header.jpg'),
  };
  return {
    ...details,
    fetchedAts: { rating: stamp(), hltb: stamp(), meta: stamp(), tags: stamp(), protondb: stamp() },
    basics: {
      name,
      type,
      ...images,
      description,
      releaseDate,
      comingSoon,
      platforms: ['Windows'],
      developers,
      publishers,
    },
    meta: { ...details.meta, ...images, developers, publishers, website: `https://${prose(rnd, 1)}.example/` },
  };
}
