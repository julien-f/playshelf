// What the mocked /api (mockApi.ts) serves: made-up players and a small catalog of real, public
// games. No real Steam account belongs here — steam64 ids are in the reserved-looking
// 7656119800000000x range and every persona is fictional.

export interface Player {
  steamid: string;
  vanity: string;
  personaname: string;
  owned: number[];
  playtime?: Record<number, number>; // minutes
  recent?: Record<number, number>; // minutes in Steam's last two weeks
  wishlist?: number[];
  friends?: string[]; // vanities; absent: a private friends list
  noAvatar?: boolean; // the account chip's initial instead
  private?: boolean; // Steam answers no library for a private profile
}

export const ALICE: Player = {
  steamid: '76561198000000001',
  vanity: 'alice',
  personaname: 'Alice',
  owned: [620, 105600, 413150, 1145360, 892970, 367520],
  playtime: { 620: 600, 105600: 1201, 1145360: 45 }, // 1201: hours that don't divide evenly
  // Apex Legends: Borked on ProtonDB; 3999990: no ProtonDB report at all.
  wishlist: [1426210, 728880, 1172470, 3999990],
  friends: ['bob', 'carol', 'dave'],
};

export const BOB: Player = {
  steamid: '76561198000000002',
  vanity: 'bob',
  personaname: 'Bob',
  owned: [620, 105600, 322330, 728880],
  wishlist: [413150, 1145360], // games Alice owns: B4's gift that's already in the family
  friends: ['alice', 'carol'], // Carol: a friend Alice shares, marked Mutual
};

export const CAROL: Player = {
  steamid: '76561198000000003',
  vanity: 'carol',
  personaname: 'Carol',
  noAvatar: true,
  // Never played: Quiet Little Game is short (L5's Short games), Counter-Strike 2 has no HLTB entry.
  owned: [620, 322330, 1426210, 3999990, 730],
};

// Rich libraries for the player profile (A5) and comparing two players' tastes (C7). Dave plays
// story games solo; Erin plays co-op and PvP. Both played Portal 2 and Terraria a lot, and Erin owns
// Deep Rock Galactic, Dave's co-op favourite, without ever launching it.
const h = (hours: number) => hours * 60;
export const DAVE: Player = {
  steamid: '76561198000000004',
  vanity: 'dave',
  personaname: 'Dave',
  owned: [
    292030, 1091500, 504230, 753640, 220, 814380, 391540, 1593500, 990080, 588650, 646570, 431960, 730, 3999992,
    1158310, 289070, 548430, 105600, 620,
  ],
  playtime: {
    292030: h(120),
    1091500: h(50),
    504230: h(10),
    753640: h(18),
    220: h(9),
    814380: h(12),
    391540: h(6),
    1593500: h(30),
    990080: h(5),
    588650: h(80),
    646570: h(150),
    431960: h(3000), // Wallpaper Engine, left running: software, kept out of the profile
    548430: h(120),
    105600: h(60),
    620: h(15),
  },
};

export const ERIN: Player = {
  steamid: '76561198000000005',
  vanity: 'erin',
  personaname: 'Erin',
  owned: [548430, 1966720, 550, 381210, 359550, 252950, 892970, 413150, 322330, 728880, 105600, 620, 1426210],
  playtime: {
    1966720: h(40),
    550: h(80),
    381210: h(200),
    359550: h(300),
    252950: h(150),
    892970: h(90),
    413150: h(70),
    322330: h(30),
    728880: h(10),
    105600: h(120),
    620: h(12),
    1426210: h(15),
  },
  recent: { 359550: h(6), 548430: 90 }, // back on Deep Rock Galactic, which Dave plays too
};

// A private profile: no library, an empty wishlist, no friends list (A1's edge).
export const FRANK: Player = {
  steamid: '76561198000000006',
  vanity: 'frank',
  personaname: 'Frank',
  owned: [],
  private: true,
};

export const PLAYERS = [ALICE, BOB, CAROL, DAVE, ERIN, FRANK];

export interface CatalogGame {
  appid: number;
  name: string;
  score: number; // review score, 0–100
  reviews: number;
  hltb: number; // hours, all playstyles; 0 for no HLTB entry
  genres: string[];
  categories: string[];
  release: string;
  protondb: 'platinum' | 'gold' | 'silver' | 'bronze' | 'borked' | null; // null: no report
  tags?: Record<string, number>; // Steam tag weights; otherwise derived from `categories`
  free?: boolean;
  comingSoon?: boolean;
}

const coop = ['Multi-player', 'Co-op', 'Online Co-op'];

export const CATALOG: CatalogGame[] = [
  {
    appid: 620,
    name: 'Portal 2',
    score: 98,
    reviews: 400000,
    hltb: 10.5,
    genres: ['Action', 'Adventure'],
    categories: coop,
    release: 'Apr 18, 2011',
    protondb: 'platinum',
  },
  {
    appid: 105600,
    name: 'Terraria',
    score: 97,
    reviews: 900000,
    hltb: 106,
    genres: ['Action', 'Adventure', 'Indie', 'RPG'],
    categories: coop,
    release: 'May 16, 2011',
    protondb: 'platinum',
  },
  {
    appid: 413150,
    name: 'Stardew Valley',
    score: 98,
    reviews: 600000,
    hltb: 100.5,
    genres: ['Indie', 'RPG', 'Simulation'],
    categories: coop,
    release: 'Feb 26, 2016',
    protondb: 'platinum',
  },
  {
    appid: 1145360,
    name: 'Hades',
    score: 98,
    reviews: 250000,
    hltb: 44.5,
    genres: ['Action', 'Indie', 'RPG'],
    categories: ['Single-player'],
    release: 'Sep 17, 2020',
    protondb: 'platinum',
  },
  {
    appid: 892970,
    name: 'Valheim',
    score: 94,
    reviews: 400000,
    hltb: 115,
    genres: ['Action', 'Adventure', 'Indie', 'RPG'],
    categories: coop,
    release: 'Feb 2, 2021',
    protondb: 'gold',
  },
  {
    appid: 367520,
    name: 'Hollow Knight',
    score: 97,
    reviews: 300000,
    hltb: 42,
    genres: ['Action', 'Adventure', 'Indie'],
    categories: ['Single-player'],
    release: 'Feb 24, 2017',
    protondb: 'platinum',
  },
  {
    appid: 322330,
    name: "Don't Starve Together",
    score: 95,
    reviews: 280000,
    hltb: 81.5,
    genres: ['Adventure', 'Indie', 'Simulation'],
    categories: coop,
    release: 'Apr 21, 2016',
    protondb: 'platinum',
  },
  {
    appid: 728880,
    name: 'Overcooked! 2',
    score: 90,
    reviews: 60000,
    hltb: 10.5,
    genres: ['Action', 'Casual', 'Indie'],
    categories: coop,
    release: 'Aug 7, 2018',
    protondb: 'gold',
  },
  {
    appid: 1426210,
    name: 'It Takes Two',
    score: 95,
    reviews: 200000,
    hltb: 14,
    genres: ['Action', 'Adventure'],
    categories: coop,
    release: 'Mar 25, 2021',
    protondb: 'silver',
  },
  {
    appid: 1172470,
    name: 'Apex Legends',
    score: 66,
    reviews: 900000,
    hltb: 120,
    genres: ['Action', 'Adventure', 'Free to Play'],
    categories: ['Online PvP'],
    release: 'Nov 4, 2020',
    protondb: 'borked',
  },
  {
    appid: 3999990,
    name: 'Quiet Little Game',
    score: 88,
    reviews: 40,
    hltb: 3,
    genres: ['Indie'],
    categories: ['Single-player'],
    release: 'Jun 2, 2026',
    protondb: null,
  },
  {
    appid: 292030,
    name: 'The Witcher 3: Wild Hunt',
    score: 96,
    reviews: 700000,
    hltb: 100,
    genres: ['RPG'],
    categories: ['Single-player'],
    release: 'May 18, 2015',
    protondb: 'platinum',
    tags: { 'Open World': 1, RPG: 0.9, 'Story Rich': 0.8, Fantasy: 0.6 },
  },
  {
    appid: 1091500,
    name: 'Cyberpunk 2077',
    score: 86,
    reviews: 700000,
    hltb: 60,
    genres: ['RPG'],
    categories: ['Single-player'],
    release: 'Dec 9, 2020',
    protondb: 'platinum',
    tags: { 'Open World': 1, RPG: 0.9, Cyberpunk: 0.8, 'Story Rich': 0.6 },
  },
  {
    appid: 504230,
    name: 'Celeste',
    score: 97,
    reviews: 90000,
    hltb: 12,
    genres: ['Action', 'Adventure', 'Indie'],
    categories: ['Single-player'],
    release: 'Jan 25, 2018',
    protondb: 'platinum',
    tags: { 'Precision Platformer': 1, Difficult: 0.8, 'Story Rich': 0.5 },
  },
  {
    appid: 753640,
    name: 'Outer Wilds',
    score: 95,
    reviews: 80000,
    hltb: 22,
    genres: ['Action', 'Adventure'],
    categories: ['Single-player'],
    release: 'Jun 18, 2020',
    protondb: 'platinum',
    tags: { Exploration: 1, Space: 0.8, 'Story Rich': 0.7, Puzzle: 0.5 },
  },
  {
    appid: 220,
    name: 'Half-Life 2',
    score: 97,
    reviews: 180000,
    hltb: 13,
    genres: ['Action'],
    categories: ['Single-player'],
    release: 'Nov 16, 2004',
    protondb: 'platinum',
    tags: { FPS: 1, 'Sci-fi': 0.8, 'Story Rich': 0.6 },
  },
  {
    appid: 814380,
    name: 'Sekiro: Shadows Die Twice',
    score: 95,
    reviews: 200000,
    hltb: 50,
    genres: ['Action', 'Adventure'],
    categories: ['Single-player'],
    release: 'Mar 21, 2019',
    protondb: 'platinum',
    tags: { 'Souls-like': 1, Difficult: 0.9, Action: 0.6 },
  },
  {
    appid: 391540,
    name: 'Undertale',
    score: 96,
    reviews: 200000,
    hltb: 8,
    genres: ['Indie', 'RPG'],
    categories: ['Single-player'],
    release: 'Sep 15, 2015',
    protondb: 'platinum',
    tags: { 'Story Rich': 1, 'Great Soundtrack': 0.8, RPG: 0.5 },
  },
  {
    appid: 1593500,
    name: 'God of War',
    score: 97,
    reviews: 100000,
    hltb: 40,
    genres: ['Action', 'Adventure', 'RPG'],
    categories: ['Single-player'],
    release: 'Jan 14, 2022',
    protondb: 'platinum',
    tags: { Action: 1, 'Story Rich': 0.9, Mythology: 0.7 },
  },
  {
    appid: 990080,
    name: 'Hogwarts Legacy',
    score: 91,
    reviews: 200000,
    hltb: 45,
    genres: ['Action', 'Adventure', 'RPG'],
    categories: ['Single-player'],
    release: 'Feb 10, 2023',
    protondb: 'gold',
    tags: { 'Open World': 1, Magic: 0.9, RPG: 0.7 },
  },
  {
    appid: 588650,
    name: 'Dead Cells',
    score: 95,
    reviews: 100000,
    hltb: 30,
    genres: ['Action', 'Indie'],
    categories: ['Single-player'],
    release: 'Aug 6, 2018',
    protondb: 'platinum',
    tags: { Roguelite: 1, Metroidvania: 0.8, Difficult: 0.6 },
  },
  {
    appid: 646570,
    name: 'Slay the Spire',
    score: 97,
    reviews: 120000,
    hltb: 60,
    genres: ['Indie', 'Strategy'],
    categories: ['Single-player'],
    release: 'Jan 23, 2019',
    protondb: 'platinum',
    tags: { Roguelike: 1, Deckbuilder: 0.9, Strategy: 0.5 },
  },
  {
    appid: 431960,
    name: 'Wallpaper Engine',
    score: 98,
    reviews: 500000,
    hltb: 0,
    genres: ['Casual', 'Indie', 'Simulation', 'Utilities'],
    categories: ['Single-player'],
    release: 'Nov 16, 2018',
    protondb: 'gold',
    tags: { Utilities: 1, Software: 0.9 },
  },
  {
    appid: 730,
    name: 'Counter-Strike 2',
    score: 86,
    reviews: 8000000,
    hltb: 0,
    genres: ['Action', 'Free To Play'],
    categories: ['Multi-player', 'PvP', 'Online PvP'],
    release: 'Aug 21, 2012',
    protondb: 'gold',
    tags: { FPS: 1, PvP: 0.9, Competitive: 0.8 },
    free: true,
  },
  {
    appid: 3999992,
    name: 'Someday Saga',
    score: 0,
    reviews: 0,
    hltb: 0,
    genres: ['RPG', 'Indie'],
    categories: ['Single-player'],
    release: 'Coming soon',
    protondb: null,
    tags: { RPG: 1, 'Story Rich': 0.8 },
    comingSoon: true,
  },
  {
    appid: 1158310,
    name: 'Crusader Kings III',
    score: 91,
    reviews: 90000,
    hltb: 80,
    genres: ['RPG', 'Simulation', 'Strategy'],
    categories: ['Single-player', 'Multi-player', 'Online PvP'],
    release: 'Sep 1, 2020',
    protondb: 'platinum',
    tags: { 'Grand Strategy': 1, Medieval: 0.8, Strategy: 0.7 },
  },
  {
    appid: 289070,
    name: "Sid Meier's Civilization VI",
    score: 85,
    reviews: 200000,
    hltb: 70,
    genres: ['Strategy'],
    categories: ['Single-player', 'Multi-player', 'Online PvP'],
    release: 'Oct 20, 2016',
    protondb: 'gold',
    tags: { 'Turn-Based Strategy': 1, '4X': 0.9, Strategy: 0.7 },
  },
  {
    appid: 548430,
    name: 'Deep Rock Galactic',
    score: 97,
    reviews: 250000,
    hltb: 90,
    genres: ['Action', 'Indie'],
    categories: coop,
    release: 'May 13, 2020',
    protondb: 'platinum',
    tags: { 'Co-op': 1, FPS: 0.8, Mining: 0.6 },
  },
  {
    appid: 1966720,
    name: 'Lethal Company',
    score: 97,
    reviews: 350000,
    hltb: 20,
    genres: ['Action', 'Adventure', 'Indie'],
    categories: coop,
    release: 'Oct 23, 2023',
    protondb: 'platinum',
    tags: { 'Co-op': 1, Horror: 0.9, 'Online Co-Op': 0.7 },
  },
  {
    appid: 550,
    name: 'Left 4 Dead 2',
    score: 97,
    reviews: 600000,
    hltb: 20,
    genres: ['Action'],
    categories: ['Single-player', 'Multi-player', 'Co-op', 'Online Co-op', 'PvP', 'Online PvP'],
    release: 'Nov 16, 2009',
    protondb: 'platinum',
    tags: { 'Co-op': 1, Zombies: 0.9, FPS: 0.8, PvP: 0.3 },
  },
  {
    appid: 381210,
    name: 'Dead by Daylight',
    score: 79,
    reviews: 700000,
    hltb: 150,
    genres: ['Action'],
    categories: ['Multi-player', 'Online PvP', 'Online Co-op'],
    release: 'Jun 14, 2016',
    protondb: 'gold',
    tags: { PvP: 1, Horror: 0.9, Survival: 0.7, 'Co-op': 0.4 },
  },
  {
    appid: 359550,
    name: "Tom Clancy's Rainbow Six Siege",
    score: 86,
    reviews: 1000000,
    hltb: 200,
    genres: ['Action'],
    categories: ['Multi-player', 'PvP', 'Online PvP'],
    release: 'Dec 1, 2015',
    protondb: 'borked',
    tags: { PvP: 1, FPS: 0.9, Tactical: 0.8, 'Team-Based': 0.7 },
  },
  {
    appid: 252950,
    name: 'Rocket League',
    score: 86,
    reviews: 700000,
    hltb: 100,
    genres: ['Action', 'Racing', 'Sports', 'Free To Play'],
    categories: ['Multi-player', 'PvP', 'Online PvP'],
    release: 'Jul 7, 2015',
    protondb: 'borked',
    tags: { PvP: 1, Soccer: 0.8, Competitive: 0.7, 'Team-Based': 0.6 },
    free: true,
  },
];

export const game = (appid: number): CatalogGame => {
  const found = CATALOG.find((g) => g.appid === appid);
  if (!found) throw new Error(`No fixture game ${appid}`);
  return found;
};

// One bundle; its ITAD game ids ("gids") resolve to catalog appids, one of them to nothing (a
// game with no Steam listing).
export const BUNDLE = {
  id: 90001,
  title: 'Test Co-op Pack',
  shop: 'Humble Bundle',
  games: [
    { gid: 'gid-portal-2', title: 'Portal 2', appid: 620, tier: 1 },
    { gid: 'gid-hades', title: 'Hades', appid: 1145360, tier: 1 },
    { gid: 'gid-overcooked-2', title: 'Overcooked! 2', appid: 728880, tier: 2 },
    { gid: 'gid-it-takes-two', title: 'It Takes Two', appid: 1426210, tier: 2 },
    { gid: 'gid-soundtrack', title: 'Test Soundtrack', appid: null, tier: 2 },
  ],
  tiers: [5, 12],
};

// A Fanatical "Build your own" bundle: one unpriced ITAD tier, priced by quantity instead
// (server.js adds `pickAndMix` from lib/fanatical.js). USD-only, so the region doesn't matter.
export const PICK_BUNDLE = {
  id: 90002,
  title: 'Test Build Your Own Bundle',
  shop: 'Fanatical',
  games: [
    { gid: 'pnm-portal-2', title: 'Portal 2', appid: 620, tier: 1 },
    { gid: 'pnm-hades', title: 'Hades', appid: 1145360, tier: 1 },
    { gid: 'pnm-terraria', title: 'Terraria', appid: 105600, tier: 1 },
    // One ITAD game that is a Steam package of two apps: one pick, two rows.
    { gid: 'pnm-pack', title: 'Test Survival Pack', appid: [367520, 322330], tier: 1 },
  ],
  pickAndMix: [
    { quantity: 1, prices: { USD: 2 } },
    { quantity: 3, prices: { USD: 3.5 } },
  ],
  // What lib/fanatical.js's matchPickAndMix found on Fanatical's page; Terraria went unmatched.
  pickAndMixNames: { 'pnm-portal-2': 'Portal 2', 'pnm-hades': 'Hades', 'pnm-pack': 'Test Survival Pack' },
};

// The `signed-in` state's session: Alice, with prefs saved from another device (Y1) — her account
// and one list, written a day before server start.
export const SIGNED_IN = ALICE;
export const SYNCED_LIST = 'Synced from my desktop';
export function signedInPrefs(now: number) {
  const updatedAt = now - 86400_000;
  const slot = {
    id: ALICE.steamid,
    members: [ALICE.steamid],
    rawInputs: [ALICE.vanity],
    label: ALICE.personaname,
  };
  const list = {
    id: 'synced-list',
    name: SYNCED_LIST,
    parentId: null,
    order: 0,
    createdAt: updatedAt,
    updatedAt,
    kind: 'manual',
    appids: [620, 1145360],
  };
  return {
    myAccount: { value: slot, updatedAt },
    currentAccount: { value: slot, updatedAt },
    lists: { value: [list], updatedAt },
  };
}
