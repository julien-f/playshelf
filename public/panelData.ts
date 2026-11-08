// The side panel's own per-game async data — news, achievements, price, DLC — as plain
// fetch-and-cache functions with no reactivity of their own. panel.tsx wraps each of these in a
// `createResource` keyed on whichever game is open (see its own "Reactivity model" comment), so
// nothing here needs a notion of "the open game".
//
// This replaced panel.tsx's own loadNews/loadAchievements/loadPrice/loadDlc, which each wrote
// their result onto the `Game` object the panel had been handed (`game.news = data.news`,
// `game.priceLoading = true`, …). That single habit is what forced everything else about the
// panel's old reactivity model: a Solid store proxy rejects a direct property write, so the
// panel could only ever be given a deliberately plain *copy* of a store-backed row
// (rowStore.ts's old `panelRows` map), and since a plain object's field writes are invisible to
// Solid, showing anything they fetched needed an explicit `renderPanelBody()` bump — which
// re-rendered the entire panel body, not the one field that changed. Keeping this data off the
// row entirely is what let all of that go; see docs/dev/frontend.md's Reactivity section.
//
// Each result is cached for CLIENT_CACHE_MAX_AGE_MS, keyed by appid (plus the account, where the result is
// account-specific), so reopening a game already seen doesn't refetch — the same guarantee the
// old `game.news !== undefined` row-field guards gave, just held here instead of on the row.
// A cached value is returned *synchronously* (see sessionCached): createResource resolves a
// non-promise return with no pending state at all, so a reopen paints the real card immediately
// instead of flashing its loading skeleton again.
//
// The cache is written as soon as a fetch resolves, even for a game the panel has since moved on
// from — a createResource discards a superseded result, but the request was already paid for, so
// the next open of that game should still be instant. This is also what replaces the old
// `if (panelGame() === game)` staleness guards: nothing here can render anything, so a late
// resolve has nothing to race with.
//
// A factory plus a default instance, same shape (and same testability reasoning) as
// myOwnership.ts's createMyOwnershipCache.
import { applyPriceInfo, postPrices } from './priceLoading.ts';
import { CLIENT_CACHE_MAX_AGE_MS, fetchJson, refusalMessage } from './utils.ts';
import type { Achievements, NewsItem, PriceFields } from './types.ts';
import type { PickAndMixTier } from './bundleRows.ts';

// Achievement *progress* is per Steam account: the helpers below take the members of the account
// being browsed (`getEffectiveCurrentAccount()`, so a `?u=` link wins over the stored account).
// With no account the list is still fetched — names, icons and rarity are store metadata.

// Identifies which account a cached result belongs to, so a result fetched for one account is
// re-fetched rather than shown for another (switching accounts, or following a `?u=` link).
// Sorted, so member order can't produce two keys for the same slot. '' means "no account".
export function achievementsAccountKey(memberIds: string[]): string {
  return memberIds.slice().sort().join(',');
}

export function achievementsRequestUrl(appid: number, memberIds: string[], { refresh = false } = {}): string {
  const qs = new URLSearchParams();
  if (memberIds.length) qs.set('steamids', memberIds.join(','));
  if (refresh) qs.set('refresh', '1');
  const query = qs.toString();
  return `/api/achievements/${appid}${query ? `?${query}` : ''}`;
}

// Links out to one specific account's own Steam achievements page for this game. A slot can
// merge a whole Steam Family, and Steam has no "these accounts together" page, so this picks
// whichever member comes first — the same "first-seen wins" convention the owned-games union
// uses — rather than trying to represent every member at once. null with no account loaded:
// there's no progress being claimed, so there's nothing to link to.
export function achievementsSteamUrl(appid: number, memberIds: string[]): string | null {
  if (!memberIds.length) return null;
  return `https://steamcommunity.com/profiles/${memberIds[0]}/stats/${appid}/achievements/`;
}

// `null` throughout means "asked, and there's nothing to show" — a failed fetch (news,
// achievements, DLC) or no ITAD key configured (price). Every section renders that as its own
// explicit "couldn't load"/"no pricing data" state, distinct from `undefined` ("not asked yet").
export type PanelNews = NewsItem[] | null;
export type PanelAchievements = Achievements | null;
export type PanelPrice = PriceFields | null;
export type PanelDlc = DlcEntry[] | null;
export type PanelBundles = GameBundle[] | null;

// One current bundle the game is in — GET /api/game-bundles/:appid (lib/itad.js's extractGameBundles).
export interface GameBundle {
  id: number;
  title: string;
  shop: string | null;
  url: string | null;
  expiry: string | null;
  tierPrice: number | null;
  tierCurrency: string | null;
  tierPriceMax?: number | null;
  pickAndMix?: PickAndMixTier[];
}

export interface DlcEntry {
  appid: number;
  name: string;
  capsule: string;
  releaseDate: string;
  comingSoon: boolean;
}

const DLC_CONCURRENCY = 4;
// Holding ↓ passes a game every few dozen ms: an uncached unforced load waits this long first.
export const PANEL_SETTLE_MS = 250;

// A value and when it was loaded.
type Cached<V> = { value: V | null; at: number };

// `settled`: whether the game a load was asked for is still the one open, once PANEL_SETTLE_MS has passed.
type LoadOptions = { refresh?: boolean; settled?: () => boolean };

// Each cache's latest load per key, until it settles: a paused call joins it, any other replaces it.
const pendingLoads = new WeakMap<Map<unknown, unknown>, Map<unknown, Promise<unknown>>>();

// The cached value when there is one and `refresh` is unset, else a load that caches its result. A
// failed load keeps whatever was last loaded rather than wiping it on a failed forced refresh;
// `null` ("couldn't load") only the first time, when there's no fallback. `refusals` keeps the
// server's message for the key's last load when it was a 429 (refusalMessage), left uncached. With
// `settled`, a load the panel moved on from is never sent; its caller discards the uncached null.
// A superseded load isn't sent, or doesn't write if already sent; a paused one answers with what replaced it.
function sessionCached<K, V>(
  cache: Map<K, Cached<V>>,
  key: K,
  load: () => Promise<V | null>,
  { refresh = false, settled }: LoadOptions,
  refusals?: Map<K, string>,
): V | null | Promise<V | null> {
  // Past the max age an entry is gone: neither an answer nor a failed load's fallback.
  const entry = cache.get(key);
  if (entry && Date.now() - entry.at >= CLIENT_CACHE_MAX_AGE_MS) cache.delete(key);
  const cachedValue = () => cache.get(key)?.value;
  const cached = cachedValue();
  if (!refresh && cached !== undefined) return cached;
  let pending = pendingLoads.get(cache) as Map<K, Promise<V | null>> | undefined;
  if (!pending) pendingLoads.set(cache, (pending = new Map()));
  const joined = pending.get(key);
  if (!refresh && settled && joined) return joined;
  const latest = () => pending.get(key) === call;
  const run = () =>
    load().then(
      (value) => {
        if (!latest()) return value;
        refusals?.delete(key);
        cache.set(key, { value, at: Date.now() });
        return value;
      },
      (err: unknown) => {
        const value = cachedValue() ?? null;
        if (!latest()) return value;
        const refusal = refusalMessage(err);
        if (refusal) refusals?.set(key, refusal);
        else refusals?.delete(key);
        // A refusal passes with its window: the next open asks again.
        if (!refusal && !cache.has(key)) cache.set(key, { value, at: Date.now() });
        return value;
      },
    );
  const call: Promise<V | null> =
    !refresh && settled
      ? new Promise((resolve) => setTimeout(resolve, PANEL_SETTLE_MS)).then(() =>
          !settled() ? null : latest() ? run() : (pending.get(key) ?? cachedValue() ?? null),
        )
      : run();
  pending.set(key, call);
  void call.then(() => latest() && pending.delete(key));
  return call;
}

export function createPanelDataCache() {
  const news = new Map<number, Cached<NewsItem[]>>();
  const achievements = new Map<string, Cached<Achievements>>();
  const price = new Map<string, Cached<PriceFields>>(); // keyed `region:appid`, like bundles
  // Why a key's last achievements, price or bundles lookup was refused, keyed like its cache.
  const achievementsRefused = new Map<string, string>();
  const priceRefused = new Map<string, string>();
  const bundlesRefused = new Map<string, string>();
  const dlcEntries = new Map<number, DlcEntry | null>(); // null: the store has no entry for it
  const bundles = new Map<string, Cached<GameBundle[]>>();

  // Lazily resolved once per session rather than per-call — a plain GET /api/health, cheap to
  // over-share across every game a price is fetched for and every list mounted (ListRoute.tsx).
  let itadConfiguredPromise: Promise<boolean> | null = null;
  let itadOff = false; // known not configured, as opposed to not yet asked or a failed /api/health
  function isItadConfigured(): Promise<boolean> {
    if (!itadConfiguredPromise) {
      itadConfiguredPromise = fetch('/api/health')
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((d) => {
          itadOff = !d.itadConfigured;
          return !!d.itadConfigured;
        })
        .catch(() => {
          itadConfiguredPromise = null; // asked again next time, rather than "off" for the session
          return false;
        });
    }
    return itadConfiguredPromise;
  }
  // Read once a price has settled to null, by then the check has resolved.
  const isItadOff = (): boolean => itadOff;

  // News is deliberately NOT part of the host route's rating/HLTB/meta/tags stream (see
  // server.js's newsLimit comment for why) — it's fetched per game, on demand, the first time
  // that game's panel opens.
  function fetchNews(appid: number, { refresh = false, settled }: LoadOptions = {}): PanelNews | Promise<PanelNews> {
    return sessionCached(
      news,
      appid,
      async () =>
        (
          await fetchJson<{ news: PanelNews }>(
            `/api/game-news/${appid}${refresh ? '?refresh=1' : ''}`,
            undefined,
            'News lookup failed',
          )
        ).news,
      { refresh, settled },
    );
  }

  // Achievements — per *account*, not just per appid: `achievements[].achieved` is one specific
  // slot's progress, so the account's members are part of the cache key and a switch re-fetches
  // rather than showing the previous account's progress as if it were this one's. With no account
  // at all the list itself is still fetched and shown (names, descriptions, icons and community
  // rarity are store metadata); only the progress half is withheld, via `playerCount: 0`.
  function achievementsKey(appid: number, memberIds: string[]): string {
    return `${appid}:${achievementsAccountKey(memberIds)}`;
  }

  // `achievementCount` (from the game's own store metadata, already streamed in for a loaded row)
  // short-circuits a game with no achievements at all: the route would answer the same thing from
  // its own check, but only after a round trip, and "no achievements" is a large share of any real
  // library.
  function fetchAchievements(
    appid: number,
    memberIds: string[],
    { refresh = false, settled, achievementCount }: LoadOptions & { achievementCount?: number | null } = {},
  ): PanelAchievements | Promise<PanelAchievements> {
    return sessionCached(
      achievements,
      achievementsKey(appid, memberIds),
      async () => {
        // The same empty payload the route itself would return — NOT `null`, which renders as
        // "Steam didn't answer." rather than "This game has no achievements."
        if (achievementCount === 0)
          return {
            achievements: [],
            total: 0,
            unlocked: 0,
            private: false,
            playerCount: memberIds.length,
            steamUrl: null,
          };
        const data = await fetchJson<Achievements>(
          achievementsRequestUrl(appid, memberIds, { refresh }),
          undefined,
          'Achievements lookup failed',
        );
        data.steamUrl = achievementsSteamUrl(appid, memberIds);
        return data;
      },
      { refresh, settled: achievementCount === 0 ? undefined : settled },
      achievementsRefused,
    );
  }

  // A single game's price via the shared POST /api/prices route (the same route a whole list
  // batches through) — only ever called for a game whose price nothing else already loaded; see
  // panel.tsx's own price source for that check.
  // A failure reads as "IsThereAnyDeal didn't answer" rather than a stuck loading skeleton; the
  // panel's ↻ retries.
  function fetchPrice(
    appid: number,
    region: string,
    { refresh = false, settled }: LoadOptions = {},
  ): PanelPrice | Promise<PanelPrice> {
    return sessionCached(
      price,
      `${region}:${appid}`,
      async () => {
        if (!(await isItadConfigured())) return null;
        const { prices } = await postPrices({ appids: [appid], country: region, refresh });
        const fields = {} as PriceFields;
        applyPriceInfo(fields, prices[appid]);
        return fields;
      },
      { refresh, settled: itadOff ? undefined : settled },
      priceRefused,
    );
  }

  // Unlike price, fetched even when the row is already priced: no list loads this.
  function fetchBundles(
    appid: number,
    region: string,
    { refresh = false, settled }: LoadOptions = {},
  ): PanelBundles | Promise<PanelBundles> {
    return sessionCached(
      bundles,
      `${region}:${appid}`,
      async () => {
        if (!(await isItadConfigured())) return null;
        const qs = new URLSearchParams({ country: region });
        if (refresh) qs.set('refresh', '1');
        const data = await fetchJson<{ bundles: PanelBundles }>(
          `/api/game-bundles/${appid}?${qs}`,
          undefined,
          'Bundles lookup failed',
        );
        return data.bundles;
      },
      { refresh, settled: itadOff ? undefined : settled },
      bundlesRefused,
    );
  }

  // DLC — unlike the three above, not fetched when the panel opens: the collapsed card's header
  // only needs `details.meta.dlc`'s bare appid *count* (already present for free, see
  // extractAppDetails in lib/steam.js), so the name/capsule-resolving fetch is deferred until the
  // card is actually expanded, and then covers only the entries it shows (DLC_PAGE at a time, see
  // panel.tsx). Each DLC costs one store-metadata lookup (GET /api/game-meta), at most
  // DLC_CONCURRENCY at once, kept for the session: a game can have hundreds of DLC, and resolving
  // full game details for each used to send hundreds of rating/HLTB/tags/ProtonDB lookups too.
  // A DLC the store has no entry for is left out; one that failed (rate-limited, offline) is
  // tried again on the next call rather than remembered.
  //
  // `onPartial` is called with a snapshot of the in-progress list (one slot per requested appid,
  // filled in as each resolves) so the card can stream entries in as they land instead of sitting
  // on its skeleton for however long the slowest one takes.
  async function fetchDlc(
    dlcIds: readonly number[],
    { onPartial }: { onPartial?: (entries: (DlcEntry | undefined)[]) => void } = {},
  ): Promise<PanelDlc> {
    const known = () => dlcIds.map((id) => dlcEntries.get(id) ?? undefined);
    onPartial?.(known());
    const missing = dlcIds.filter((id) => !dlcEntries.has(id));
    let failed = false;
    let next = 0;
    const worker = async () => {
      while (next < missing.length) {
        const id = missing[next++];
        try {
          const res = await fetch(`/api/game-meta/${id}`);
          const data = await res.json();
          if (!res.ok) failed = true;
          else
            dlcEntries.set(
              id,
              data.meta
                ? {
                    appid: id,
                    name: data.meta.name,
                    capsule: data.meta.capsule,
                    releaseDate: data.meta.releaseDate,
                    comingSoon: data.meta.comingSoon,
                  }
                : null,
            );
        } catch {
          failed = true;
        }
        onPartial?.(known()); // stream this entry in as soon as it resolves
      }
    };
    await Promise.all(Array.from({ length: Math.min(DLC_CONCURRENCY, missing.length) }, worker));
    const entries = dlcIds.map((id) => dlcEntries.get(id)).filter((d): d is DlcEntry => d != null);
    return entries.length || !failed ? entries : null;
  }

  return {
    fetchNews,
    fetchAchievements,
    achievementsRefusal: (appid: number, memberIds: string[]) =>
      achievementsRefused.get(achievementsKey(appid, memberIds)),
    fetchPrice,
    priceRefusal: (appid: number, region: string) => priceRefused.get(`${region}:${appid}`),
    fetchBundles,
    bundlesRefusal: (appid: number, region: string) => bundlesRefused.get(`${region}:${appid}`),
    fetchDlc,
    isItadConfigured,
    isItadOff,
  };
}

const defaultCache = createPanelDataCache();
export const fetchNews = defaultCache.fetchNews;
export const fetchAchievements = defaultCache.fetchAchievements;
export const achievementsRefusal = defaultCache.achievementsRefusal;
export const fetchPrice = defaultCache.fetchPrice;
export const priceRefusal = defaultCache.priceRefusal;
export const fetchBundles = defaultCache.fetchBundles;
export const bundlesRefusal = defaultCache.bundlesRefusal;
export const fetchDlc = defaultCache.fetchDlc;
export const isItadConfigured = defaultCache.isItadConfigured;
export const isItadOff = defaultCache.isItadOff;
