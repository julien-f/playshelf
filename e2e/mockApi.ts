// Serves every /api call from fixtures.ts inside the browser (page.route), and blocks anything
// off localhost — so an e2e run needs no backend, touches no database, and sends nothing to
// Steam, HLTB, IsThereAnyDeal or ProtonDB. Response shapes follow server.js's routes.
//
// States reproduce what the fixtures alone can't (the `mock` cookie under `npm run dev:mock`,
// `mockApi(page, { states })` in a test):
//   no-itad        no ITAD_API_KEY: health says so, every ITAD route answers 503 as server.js does
//   upstream-down  HLTB, ProtonDB, Steam reviews and achievement rarity return nothing; ITAD routes answer 502
//   slow           game details stream in one at a time (dev:mock only — page.route can't stream)
//   store-down     Steam store pages return nothing (genres, release date, platforms…)
//   stale          libraries and wishlists read as fetched 12 days ago, until a refresh (D1)
//   untiered       the Co-op Pack lists every game in its first tier, the pricier one empty (as ITAD sends some)
//   resolve-failed the Co-op Pack's Portal 2 fails to resolve to Steam (its package lookup errored)
//   slow-media     every banner, screenshot and trailer poster takes 1.5 s to load (Hades, Terraria and Hollow Knight have media)
//   broken-trailer trailers point at a manifest that answers 501, so playback fails
//   playable-trailers Hades' and Terraria's trailers have a stream (a stubbed browser plays anything)
//   many-shots     Hades has 24 screenshots, a counter as long as a real game's
//   slow-meta      a game's store metadata (GET /api/game-meta) takes 1.5 s to answer
//   signed-in      signed in with Steam as Alice, whose account already has prefs (fixtures.ts's signedInPrefs)
//   creator-capped a developer's/publisher's list is Steam's first page of 523 games
//   tagless        no game has Steam tags
//   no-igdb        no Twitch credentials: health says so, GET /api/igdb-game answers 503 as server.js does
//   client-limited this client spent its share of the outbound budgets: details say so once, achievements and prices 429
import type { Page } from '@playwright/test';
import { PLAYERS, CATALOG, BUNDLE, PICK_BUNDLE, SIGNED_IN, signedInPrefs, game, type Player } from './fixtures.ts';
import { flattenBundleGames, type Bundle } from '../public/bundleData.ts';
import { streamEvent } from '../lib/streamEvent.mjs';

// Fixed per worker, for dates that need no freshness; a "fetched" stamp takes the answer's own time: a worker outlives a minute.
const NOW = Date.now();
// server.js's message for a client past its share of the outbound budgets (lib/metrics.js).
export const LIMITED =
  "Too many new lookups from your network this hour. What's already loaded still works; try again later.";

function findPlayer(identifier: string): Player | undefined {
  const id = identifier
    .trim()
    .replace(/\/+$/, '')
    .replace(/^.*\/(id|profiles)\//, '');
  return PLAYERS.find((p) => p.steamid === id || p.vanity === id.toLowerCase());
}

function playerJson(p: Player) {
  return {
    steamid: p.steamid,
    communityvisibilitystate: 3,
    personaname: p.personaname,
    profileurl: `https://steamcommunity.com/id/${p.vanity}/`,
    avatar: '',
    avatarmedium: '',
    avatarfull: '',
    timecreated: 1300000000,
    loccountrycode: 'FR',
    gameCount: p.owned.length,
  };
}

// Drawn inline rather than fetched, so the lightbox has media to page through under both a test
// and dev:mock. Hades is the media game (trailer, 3 screenshots); its neighbours in the library's
// default order differ, so stepping games in the lightbox lands on each kind: Terraria has a
// trailer too, Hollow Knight screenshots only. The rest keep just their banner.
const MEDIA_APPID = 1145360;
// Trailers and screenshots per game, and the prefix that tells its images apart from Hades'.
const MEDIA: Record<number, { movies: number; screenshots: number; label: string }> = {
  [MEDIA_APPID]: { movies: 1, screenshots: 3, label: '' },
  105600: { movies: 1, screenshots: 2, label: 'Terraria ' },
  367520: { movies: 0, screenshots: 2, label: 'Hollow Knight ' },
};
const UNSAFE_LINK_APPID = 892970;
const SLOW_MEDIA_MS = 1500;
// It Takes Two's made-up free demo: the panel's demo button and the wishlist's Demo pill.
export const DEMO_OF: Record<number, number> = { 1426210: 3999991 };
// The media game's DLC: more than the card's first page, so "Show more" appears.
const DLC_APPIDS = Array.from({ length: 25 }, (_, i) => 900001 + i);
const dlcMeta = (appid: number) => ({
  name: `Expansion ${appid - 900000}`,
  capsule: `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/capsule_231x87.jpg`,
  releaseDate: `${(appid % 28) + 1} Jan, 2024`,
  comingSoon: false,
});
const svg = (label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="100%" height="100%" fill="hsl(${[...label].reduce((h, c) => h + c.charCodeAt(0) * 7, 0) % 360} 45% 35%)"/><text x="50%" y="50%" fill="#fff" font-family="sans-serif" font-size="64" text-anchor="middle">${label}</text></svg>`;
// `slow-media` serves each image from /api/mock-media after SLOW_MEDIA_MS instead; `variant` keeps a
// screenshot's thumbnail and full image apart, as Steam's are.
const mediaUrl = (label: string, slow: boolean, variant = '') =>
  slow
    ? `/api/mock-media/${encodeURIComponent(label)}.svg${variant && `?${variant}`}`
    : `data:image/svg+xml,${encodeURIComponent(svg(label))}`;
// `hls: null`, as Steam sends for a trailer with no H.264 stream: the player and its controls
// show, nothing plays (Playwright's Chromium has no H.264 decoder anyway).
const media = (appid: number, states: ReadonlySet<string>) => {
  const m = MEDIA[appid];
  if (!m) return { movies: [], screenshots: [] };
  const slow = states.has('slow-media');
  const range = (length: number) => Array.from({ length }, (_, i) => i + 1);
  const shots = appid === MEDIA_APPID && states.has('many-shots') ? 24 : m.screenshots;
  return {
    movies: range(m.movies).map((id) => ({
      id,
      thumbnail: mediaUrl(`${m.label}Trailer`, slow),
      hls: states.has('broken-trailer')
        ? '/api/mock-media/missing.m3u8'
        : states.has('playable-trailers')
          ? `/trailer-${appid}.m3u8`
          : null,
    })),
    screenshots: range(shots).map((id) => ({
      id,
      thumbnail: mediaUrl(`${m.label}Screenshot ${id}`, slow, 'thumb'),
      full: mediaUrl(`${m.label}Screenshot ${id}`, slow, 'full'),
    })),
  };
};

// Developers and publishers, as appdetails names them; one ends in ".io" and one holds a "/", which
// a path segment couldn't carry. The rest are Test Studio / Test Publisher.
const CREATORS: Record<number, { developers: string[]; publishers: string[] }> = {
  [MEDIA_APPID]: { developers: ['Supergiant Games'], publishers: ['Supergiant Games'] },
  105600: { developers: ['Re-Logic'], publishers: ['indie.io'] },
  367520: { developers: ['Team Cherry', 'Supergiant Games'], publishers: ['Feral Interactive (Mac/Linux)'] },
  1426210: { developers: ['Hazelight Studios'], publishers: ['indie.io'] },
  728880: { developers: ['Ghost Town Games'], publishers: ['indie.io'] },
};
const creators = (appid: number) => CREATORS[appid] ?? { developers: ['Test Studio'], publishers: ['Test Publisher'] };

// Out of rating order, so sorting by Tag match visibly reorders a co-op filter.
const COOP_WEIGHT: Record<number, number> = { 620: 0.3, 105600: 0.9, 413150: 0.6, 892970: 1 };

function details(appid: number, states: ReadonlySet<string>) {
  const now = Date.now();
  const fetched = {
    appid,
    fetchedAt: now,
    fetchedAts: { rating: now, hltb: now, meta: now, tags: now, protondb: now },
  };
  // As server.js answers an appid with no store page: 200, every source empty rather than failed.
  if (!CATALOG.some((g) => g.appid === appid))
    return { ...fetched, rating: null, hltb: null, meta: null, tags: [], tagWeights: {}, demo: null, protondb: null };
  const g = game(appid);
  return {
    ...fetched,
    rating: {
      score: g.score,
      desc: 'Very Positive',
      positive: Math.round((g.reviews * g.score) / 100),
      total: g.reviews,
    },
    // 0: no HLTB entry (software, endless multiplayer, unreleased).
    hltb: g.hltb
      ? { id: appid, main: g.hltb * 0.6, extra: g.hltb * 0.9, completionist: g.hltb * 1.5, all: g.hltb }
      : null,
    meta: {
      name: g.name,
      type: 'game',
      genres: g.genres,
      categories: g.categories,
      ...creators(appid),
      description: `${g.name}, a fixture game.`,
      releaseDate: g.release,
      comingSoon: g.comingSoon ?? false,
      // An unfiltered Steam field: the panel must not link a javascript: URL.
      metacritic: appid === UNSAFE_LINK_APPID ? { score: 85, url: 'javascript:alert(1)' } : null,
      // Public store art; a test's browser blocks it (off localhost), dev:mock shows it.
      capsule: `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/capsule_184x69.jpg`,
      thumb: `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/capsule_231x87.jpg`,
      banner: states.has('slow-media') ? mediaUrl(`Banner ${appid}`, true) : null,
      ...media(appid, states),
      dlc: appid === MEDIA_APPID ? DLC_APPIDS : [],
      fullgame: null,
      // So the panel's More links menu has an entry.
      website: appid === MEDIA_APPID ? 'https://example.com/' : null,
      achievementCount: appid === MEDIA_APPID ? ACHIEVEMENTS.length : 0,
      platforms: { windows: true, mac: false, linux: false },
      languages: [],
      isFree: g.free ?? false,
      priceInitial: null,
    },
    ...(g.tags
      ? { tags: Object.keys(g.tags), tagWeights: g.tags }
      : g.categories.includes('Co-op')
        ? { tags: ['Action', 'Co-op'], tagWeights: { Action: 1, 'Co-op': COOP_WEIGHT[appid] ?? 0.5 } }
        : { tags: ['Singleplayer'], tagWeights: { Singleplayer: 1 } }),
    demo: DEMO_OF[appid] ?? null,
    protondb: g.protondb ? { tier: g.protondb, confidence: 'strong', total: 100 } : null,
  };
}

// A game outside Steam (igdb:9001), as GET /api/igdb-game answers it.
const IGDB_GAME = {
  id: 9001,
  name: 'Console Quest',
  url: 'https://www.igdb.com/games/console-quest',
  summary: 'Console Quest, a fixture game on consoles only.',
  cover: mediaUrl('Console Quest Cover', false),
  platforms: ['PS5', 'Switch'],
  releaseDate: '2024-09-06',
  developers: ['Console Studio'],
  publishers: ['Console Publisher'],
  genres: ['Platform'],
  rating: { score: 88, count: 120 },
  screenshots: [1, 2].map((id) => ({
    id: `cq${id}`,
    thumbnail: mediaUrl(`Console Quest Screenshot ${id}`, false, 'thumb'),
    full: mediaUrl(`Console Quest Screenshot ${id}`, false, 'full'),
  })),
  videos: [],
  steamAppid: null as number | null,
};
// A game IGDB links to Steam (Portal 2): the panel opens the Steam game instead.
const IGDB_STEAM_LINKED = { ...IGDB_GAME, id: 9002, name: 'Portal 2', steamAppid: 620, platforms: ['PC'] };
const igdbGame = (game: typeof IGDB_GAME) => {
  const now = Date.now();
  return {
    game,
    hltb: { id: 77, main: 9, extra: 13.5, completionist: 20, all: 12 },
    fetchedAt: now,
    fetchedAts: { igdb: now, hltb: now },
  };
};

const ACHIEVEMENTS = [
  { apiname: 'ACH_1', name: 'First steps', description: 'Finish the first chapter.', achieved: true, globalPct: 71.5 },
  { apiname: 'ACH_2', name: 'Completionist', description: 'Finish everything.', achieved: false, globalPct: 4.2 },
];

function achievements(steamids: string | null, rarityDown: boolean) {
  const list = ACHIEVEMENTS.map((a) => ({
    ...a,
    achieved: steamids ? a.achieved : false,
    unlocktime: steamids && a.achieved ? Math.floor(NOW / 1000) : null,
    globalPct: rarityDown ? null : a.globalPct,
    icon: mediaUrl(a.name, false),
    icongray: null,
    hidden: false,
  }));
  return {
    achievements: list,
    total: list.length,
    unlocked: list.filter((a) => a.achieved).length,
    private: false,
    playerCount: steamids ? steamids.split(',').length : 0,
    steamUrl: `https://steamcommunity.com/stats/${MEDIA_APPID}/achievements/`,
    ...(rarityDown && { rarityFailed: true }),
  };
}

const money = (amount: number) => ({ amount, amountInt: Math.round(amount * 100), currency: 'EUR' });

function priceInfo(appid: number) {
  const regular = 20;
  const best = 5 + (appid % 7);
  return {
    steamRegular: money(regular),
    lowAll: money(best - 1),
    lowY1: money(best),
    lowM3: money(best),
    bestDeal: { price: money(best), shop: 'Test Shop', url: 'https://example.invalid/deal' },
  };
}

function pickBundleJson() {
  return {
    ...bundleJson(PICK_BUNDLE),
    tiers: [
      {
        price: null,
        addon: false,
        games: PICK_BUNDLE.games.map((g) => ({ id: g.gid, slug: g.gid, title: g.title, type: 'game', assets: {} })),
      },
    ],
    pickAndMix: PICK_BUNDLE.pickAndMix,
    pickAndMixNames: PICK_BUNDLE.pickAndMixNames,
  };
}

function bundleJson(b: typeof BUNDLE | typeof PICK_BUNDLE = BUNDLE) {
  return {
    id: b.id,
    title: b.title,
    page: { id: 1, name: b.shop, shopId: 1 },
    url: 'https://example.invalid/bundle',
    details: 'https://example.invalid/itad-bundle',
    isMature: false,
    publish: new Date(NOW - 2 * 86400_000).toISOString(),
    // The pick-and-mix one ends within 48 h, for the Bundles page's "Ending soon".
    expiry: new Date(NOW + (b === PICK_BUNDLE ? 20 * 3600_000 : 10 * 86400_000)).toISOString(),
    note: null,
    counts: { games: b.games.length, media: 0 },
    tiers: BUNDLE.tiers.map((price, i) => ({
      price: money(price),
      addon: false,
      games: BUNDLE.games
        .filter((g) => g.tier === i + 1)
        .map((g) => ({ id: g.gid, slug: g.gid, title: g.title, type: 'game', mature: false, assets: {} })),
    })),
  };
}

export interface MockResponse {
  status: number;
  contentType: string;
  body: string;
  delayMs?: number;
}

const json = (body: unknown, status = 200): MockResponse => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

const ITAD_ROUTE = /^\/api\/(bundles|game-bundles|prices|game-pass)(\/|$)/;

// Plain request in, response out: shared by mockApi() below and `npm run dev:mock` (vite.config.js).
export function respond(
  method: string,
  url: URL,
  rawBody: string | null,
  states: ReadonlySet<string> = new Set(),
): MockResponse {
  const path = url.pathname;
  const body = rawBody ? JSON.parse(rawBody) : {};

  if (states.has('no-itad') && ITAD_ROUTE.test(path))
    return json(
      { error: "Bundles and prices aren't available on this instance: it isn't connected to IsThereAnyDeal." },
      503,
    );
  if (states.has('upstream-down') && ITAD_ROUTE.test(path))
    return json({ error: 'IsThereAnyDeal request failed (mock: upstream-down)' }, 502);
  const limited = states.has('client-limited');
  if (limited && (path === '/api/prices' || path.startsWith('/api/achievements/')))
    return json({ error: LIMITED }, 429);
  const detailsFor = (appid: number) =>
    limited
      ? { ...details(appid, states), rating: null, hltb: null, failed: ['rating', 'hltb'] }
      : states.has('upstream-down')
        ? {
            ...details(appid, states),
            rating: null,
            hltb: null,
            protondb: null,
            failed: ['rating', 'hltb', 'protondb'],
          }
        : states.has('store-down')
          ? { ...details(appid, states), meta: null, failed: ['meta'] }
          : states.has('tagless')
            ? { ...details(appid, states), tags: [], tagWeights: {} }
            : details(appid, states);
  const mediaPath = path.match(/^\/api\/mock-media\/(.+)\.svg$/);
  if (mediaPath)
    return {
      status: 200,
      contentType: 'image/svg+xml',
      body: svg(decodeURIComponent(mediaPath[1])),
      delayMs: SLOW_MEDIA_MS,
    };

  if (path === '/api/health')
    return json({
      ok: true,
      configured: true,
      itadConfigured: !states.has('no-itad'),
      igdbConfigured: !states.has('no-igdb'),
      cache: { entries: 0 },
    });
  if (path === '/api/me')
    return json(
      states.has('signed-in')
        ? { steamid: SIGNED_IN.steamid, prefs: signedInPrefs(NOW) }
        : { steamid: null, prefs: null },
    );
  // Accepted, not stored: the next /api/me still answers the fixture prefs.
  if (states.has('signed-in') && method === 'PUT' && path.startsWith('/api/me/prefs/')) return json({ ok: true });

  // A refresh is fetched now; otherwise as of server start, or 12 days before it under `stale`.
  const accountFetchedAt = () =>
    body.refresh ? Date.now() : states.has('stale') ? Date.now() - 12 * 86400_000 : Date.now();

  if (path === '/api/common-games') {
    const identifiers: string[] = body.members ?? [];
    const players = identifiers.map(findPlayer);
    const missing = identifiers.find((_, i) => !players[i]);
    if (missing) return json({ error: `Cannot find Steam account: "${missing}"` }, 400);
    const members = players as Player[];
    const appids = [...new Set(members.flatMap((p) => p.owned))];
    const playtime = Object.fromEntries(
      appids.map((a) => [a, Object.fromEntries(members.map((p) => [p.steamid, p.playtime?.[a] ?? 0]))]),
    );
    return json({
      games: appids.map((a) => ({ appid: a, name: game(a).name })),
      players: members.map(playerJson),
      playtime,
      lastPlayed: {},
      recentPlaytime: Object.fromEntries(
        appids.flatMap((a) => {
          const byPlayer = members.filter((p) => p.recent?.[a]).map((p) => [p.steamid, p.recent![a]]);
          return byPlayer.length ? [[a, Object.fromEntries(byPlayer)]] : [];
        }),
      ),
      fetchedAt: accountFetchedAt(),
    });
  }
  if (path === '/api/wishlist') {
    const members = (body.members ?? []).map(findPlayer).filter(Boolean) as Player[];
    const items = members.flatMap((p) =>
      (p.wishlist ?? []).map((appid) => ({ appid, priority: 0, dateAdded: '2026-01-01' })),
    );
    return json({ items, players: members.map(playerJson), fetchedAt: accountFetchedAt() });
  }
  if (path === '/api/friends') return json({ friends: [], unavailable: body.members ?? [], fetchedAt: Date.now() });

  if (path === '/api/game-details/stream') {
    const lines = (body.games ?? []).map(
      (g: { appid: number }) => `data: ${JSON.stringify(streamEvent(detailsFor(g.appid)))}\n\n`,
    );
    if (limited) lines.unshift(`data: ${JSON.stringify({ limited: LIMITED })}\n\n`);
    return {
      status: 200,
      contentType: 'text/event-stream',
      body: `${lines.join('')}data: {"done":true}\n\n`,
    };
  }
  const one = path.match(/^\/api\/game-details\/(\d+)$/);
  if (one) return json(detailsFor(Number(one[1])));
  const metaOnly = path.match(/^\/api\/game-meta\/(\d+)$/);
  if (metaOnly) {
    const appid = Number(metaOnly[1]);
    const answer = json({ meta: DLC_APPIDS.includes(appid) ? dlcMeta(appid) : detailsFor(appid).meta });
    return states.has('slow-meta') ? { ...answer, delayMs: SLOW_MEDIA_MS } : answer;
  }
  const igdbId = path.match(/^\/api\/igdb-game\/(\d+)$/)?.[1];
  if (igdbId && states.has('no-igdb')) return json({ error: 'Games outside Steam are not configured' }, 503);
  if (igdbId && states.has('upstream-down'))
    return json({
      game: null,
      hltb: null,
      fetchedAt: null,
      fetchedAts: { igdb: null, hltb: null },
      failed: ['igdb', 'hltb'],
    });
  const igdbFixture = [IGDB_GAME, IGDB_STEAM_LINKED].find((g) => String(g.id) === igdbId);
  if (igdbId) return igdbFixture ? json(igdbGame(igdbFixture)) : json({ error: 'No such IGDB game' }, 404);
  if (path.startsWith('/api/achievements/'))
    return json(achievements(url.searchParams.get('steamids'), states.has('upstream-down')));
  if (path.startsWith('/api/game-news/')) return json({ items: [], news: [] });

  if (path === '/api/search-games') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const results = CATALOG.filter((g) => g.name.toLowerCase().includes(q)).map((g) => ({
      appid: g.appid,
      name: g.name,
      tinyImage: '',
    }));
    return json({ results });
  }

  if (path === '/api/creator-games') {
    if (states.has('store-down')) return json({ error: 'Steam store search error 500 (mock: store-down)' }, 502);
    const role = url.searchParams.get('role') as 'developer' | 'publisher';
    const name = url.searchParams.get('name');
    const appids = CATALOG.filter((g) => creators(g.appid)[`${role}s`].includes(name!)).map((g) => g.appid);
    const capped = states.has('creator-capped');
    return json({ appids, total: capped ? 523 : appids.length, capped, fetchedAt: Date.now() });
  }

  // Two of Alice's wishlist games among them; one game off Steam that Microsoft's catalog didn't name.
  if (path === '/api/game-pass') {
    return json({
      appids: [620, 1426210, 728880, 367520],
      notOnSteam: [
        { id: '9NXBOXONLY01', title: 'Xbox Exclusive Quest' },
        { id: '9NUNNAMED002', title: null },
      ],
      failed: 0,
      fetchedAt: Date.now(),
    });
  }

  const bundleGames = [...BUNDLE.games, ...PICK_BUNDLE.games];
  const coopBundleJson = () => {
    const b = bundleJson();
    if (!states.has('untiered')) return b;
    const [first, ...rest] = b.tiers;
    return {
      ...b,
      tiers: [{ ...first, games: b.tiers.flatMap((t) => t.games) }, ...rest.map((t) => ({ ...t, games: [] }))],
    };
  };
  if (path === '/api/bundles') {
    return json({ bundles: [coopBundleJson(), pickBundleJson()], offset: 0, limit: 50, fetchedAt: Date.now() });
  }
  if (path === '/api/bundles/resolve') {
    const failed = states.has('resolve-failed') ? [BUNDLE.games[0].gid] : [];
    const resolved = bundleGames.filter((g) => !failed.includes(g.gid));
    return json({
      appids: Object.fromEntries(resolved.map((g) => [g.gid, g.appid])),
      ...(failed.length && { failed }),
    });
  }
  const bundle = path.match(/^\/api\/bundles\/(\d+)$/);
  if (bundle) {
    const found = { [BUNDLE.id]: coopBundleJson, [PICK_BUNDLE.id]: pickBundleJson }[Number(bundle[1])];
    return found ? json({ bundle: found(), fetchedAt: Date.now() }) : json({ error: 'Bundle not found' }, 404);
  }
  const inBundles = path.match(/^\/api\/game-bundles\/(\d+)$/);
  if (inBundles) {
    const appid = Number(inBundles[1]);
    const bundles = [coopBundleJson(), pickBundleJson()].flatMap((b) => {
      const tier = b.tiers.find((t) =>
        t.games.some((g) => [bundleGames.find((x) => x.gid === g.id)?.appid].flat().includes(appid)),
      );
      if (!tier) return [];
      const { id, title, page, url, expiry } = b;
      return [
        {
          id,
          title,
          shop: page.name,
          url,
          expiry,
          tierPrice: tier.price?.amount ?? null,
          tierCurrency: tier.price?.currency ?? null,
          tierPriceMax:
            flattenBundleGames(b as unknown as Bundle).find((g) => tier.games.some((t) => t.id === g.gid))
              ?.tierPriceMax ?? null,
          ...('pickAndMix' in b && { pickAndMix: b.pickAndMix }),
        },
      ];
    });
    return json({ bundles });
  }
  if (path === '/api/prices') {
    const keys: (string | number)[] = body.gids ?? body.appids ?? [];
    const appidOf = (key: string | number) =>
      typeof key === 'number' ? key : [bundleGames.find((g) => g.gid === key)?.appid].flat()[0];
    const prices = Object.fromEntries(keys.flatMap((key) => (appidOf(key) ? [[key, priceInfo(appidOf(key)!)]] : [])));
    return json({ prices, fetchedAt: Date.now() });
  }

  return json({ error: `e2e mock: no fixture for ${method} ${path}` }, 501);
}

export async function mockApi(page: Page, { states = [] as string[] } = {}): Promise<void> {
  await page.context().route(
    (url) => url.hostname !== 'localhost' && url.hostname !== '127.0.0.1',
    (route) => route.abort(),
  );
  await page.context().route('**/api/**', async (route) => {
    const req = route.request();
    const { delayMs, ...response } = respond(req.method(), new URL(req.url()), req.postData(), new Set(states));
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return route.fulfill(response);
  });
}
