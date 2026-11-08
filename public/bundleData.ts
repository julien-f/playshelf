// Bundle fetch/flatten/resolve pipeline — the ITAD-backed data layer behind a bundle's games
// (see docs/dev/frontend.md), extracted from
// bundles.tsx's own inline logic so it's usable both by the new BundlesBrowseRoute/ListRoute
// (bundle kind) and by listResolve.ts's `bundle` ListRef case, decoupled from bundles.tsx's
// bespoke table UI, which went away with that page.

import type { BundleListItem } from './bundleRows.ts';
import type { PriceAmount } from './types.ts';
import { ApiError, fetchJson, postJson, safeHref } from './utils.ts';

export interface FlatGame {
  gid: string;
  slug: string;
  title: string;
  type: string;
  assets: { boxart?: string } | null;
  tierPrice: number | null;
  tierCurrency: string | null;
  // Set when ITAD lists pricier tiers with no games: this game may sit in any of them, up to this price.
  tierPriceMax: number | null;
  addon: boolean;
}

// A flat game that also resolved to a Steam appid.
export type ResolvedGame = FlatGame & { appid: number };

interface BundleTier {
  price: PriceAmount | null;
  games: { id: string; slug: string; title: string; type: string; assets?: { boxart?: string } | null }[];
  addon: boolean | null;
}

// One bundle as ITAD's /bundles/v1 (via GET /api/bundles or GET /api/bundles/:id) returns it —
// only the fields read here. `publish`/`note` were passed through by the server all along but
// weren't declared, so nothing could reach them; the bundle detail card (ListRoute.tsx) shows
// both. `isMature` is deliberately still not declared: the app no longer filters on it (see
// getBundles in lib/itad.js) and doesn't label with it either — the flag proved inaccurate on the
// very bundle it was hiding, so surfacing it would spread that inaccuracy rather than inform.
export interface Bundle extends Omit<BundleListItem, 'tiers'> {
  note: string | null;
  url: string | null;
  details: string | null;
  tiers: BundleTier[];
  // GET /api/bundles/:id only: ITAD gid -> the name Fanatical's pick-and-mix page shows (matchPickAndMix).
  pickAndMixNames?: Record<string, string> | null;
}

// A game can appear in more than one tier (a cheap tier's games are still included in every
// pricier tier above it) — dedupes by ITAD game id, keeping the cheapest tier's price, since
// ITAD's tiers are observed to always be price-ascending (so "first occurrence wins" is enough,
// no explicit min() needed).
export const TIER_RANGE_TITLE =
  "IsThereAnyDeal doesn't say which tier holds this game: it lists none under the pricier ones";

export function flattenBundleGames(bundle: Bundle): FlatGame[] {
  const seen = new Map<string, FlatGame>();
  const tiers = bundle.tiers || [];
  // Add-on tiers are bought apart, so only base tiers can hide a game's real tier.
  const lastListed = tiers.findLastIndex((t) => !t.addon && (t.games || []).length > 0);
  const emptyAbove = tiers
    .slice(lastListed + 1)
    .flatMap((t) => (!t.addon && t.price && !(t.games || []).length ? [t.price.amount] : []));
  const rangeMax = emptyAbove.length ? Math.max(...emptyAbove) : null;
  tiers.forEach((tier, i) => {
    for (const g of tier.games || []) {
      if (seen.has(g.id)) continue;
      seen.set(g.id, {
        gid: g.id,
        slug: g.slug,
        title: g.title,
        type: g.type,
        assets: g.assets ?? null,
        tierPrice: tier.price ? tier.price.amount : null,
        tierCurrency: tier.price ? tier.price.currency : null,
        tierPriceMax:
          i === lastListed && tier.price && rangeMax != null && rangeMax > tier.price.amount ? rangeMax : null,
        addon: !!tier.addon,
      });
    }
  });
  return [...seen.values()];
}

// `fetchedAt` is how old the server's cached copy is (epoch ms, null if it couldn't be dated) —
// stated on the bundle's own hero card. There is no forcing it: finding one bundle means walking
// several cached list pages, so GET /api/bundles/:id deliberately has no refresh parameter (see
// server.js). What *is* refreshable on that screen is each game's own details (the panel's ↻)
// and the whole list's prices (↻ Refresh prices).
// GET /api/bundles/:id's 404: ITAD no longer lists the bundle (see findBundleById in lib/itad.js),
// as opposed to a transient failure — the one case a saved list's bundle source gets orphaned.
// A 503: the instance has no IsThereAnyDeal key — a setting, not a failure, so shown without "Error:".
class UnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnavailableError';
  }
}

export function isUnavailable(err: unknown): boolean {
  return err instanceof UnavailableError;
}

// The message to show for a failed bundle load.
export function loadErrorText(err: unknown): string {
  return err instanceof UnavailableError ? err.message : `Error: ${(err as Error).message}`;
}

export class BundleNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleNotFoundError';
  }
}

// One page of GET /api/bundles (the browse list).
export async function fetchBundlePage({
  refresh = false,
  ...params
}: {
  country: string;
  sort: string;
  expired: boolean;
  offset: number;
  limit: number;
  refresh?: boolean;
}): Promise<{ bundles: BundleListItem[]; fetchedAt: number | null }> {
  const qs = new URLSearchParams({
    country: params.country,
    sort: params.sort,
    expired: String(params.expired),
    offset: String(params.offset),
    limit: String(params.limit),
  });
  if (refresh) qs.set('refresh', '1');
  try {
    const data = await fetchJson<{ bundles: BundleListItem[]; fetchedAt?: number | null }>(
      `/api/bundles?${qs}`,
      undefined,
      'Failed to load bundles',
    );
    return { bundles: data.bundles, fetchedAt: data.fetchedAt ?? null };
  } catch (err) {
    throw err instanceof ApiError && err.status === 503 ? new UnavailableError(err.message) : err;
  }
}

export async function fetchBundleById(
  id: number,
  { country }: { country?: string } = {},
): Promise<{ bundle: Bundle; fetchedAt: number | null }> {
  const qs = country ? `?${new URLSearchParams({ country })}` : '';
  try {
    const data = await fetchJson<{ bundle: Bundle; fetchedAt?: number | null }>(
      `/api/bundles/${id}${qs}`,
      undefined,
      'Bundle lookup failed',
    );
    const { bundle } = data;
    return {
      bundle: { ...bundle, url: safeHref(bundle.url) || null, details: safeHref(bundle.details) || null },
      fetchedAt: data.fetchedAt ?? null,
    };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) throw new BundleNotFoundError(err.message);
    if (err instanceof ApiError && err.status === 503) throw new UnavailableError(err.message);
    throw err;
  }
}

// gid -> a Steam appid (the overwhelmingly common case), an array of appids (a Steam "sub"/
// "bundle" entry that expanded to more than one app — e.g. a base game plus its DLC sold as one
// SKU, such as EVERSPACE - Ultimate Edition), or null when ITAD has no Steam listing for that
// game at all. See lib/itad.js's resolveSteamAppIds. `failed`: the gids whose lookup errored.
export async function resolveBundleAppids(
  gids: string[],
): Promise<{ appids: Record<string, number | number[] | null>; failed: string[] }> {
  const data = await postJson<{ appids: Record<string, number | number[] | null>; failed?: string[] }>(
    '/api/bundles/resolve',
    { gids },
    'Resolution failed',
  );
  return { appids: data.appids, failed: data.failed ?? [] };
}

// Flattens + resolves + de-dupes-by-appid a whole bundle in one call — the same steps
// bundles.tsx's own openBundle does inline today. A second, distinct ITAD game id occasionally
// resolves to the same Steam appid (an observed ITAD data-quality case) — kept first-occurrence
// (already cheapest-tier-first, from flattenBundleGames), same rule bundles.tsx applies. A gid
// that resolved to more than one appid (a Steam "sub"/"bundle" spanning several apps) becomes
// one row per appid, sharing the rest of that gid's metadata (tier price included — the price
// buys the whole package, not just one of its rows). Each such row starts nameless in
// ListRoute.tsx so its own Steam title from game-details/stream fills in, not the package's.
export async function resolveBundleGames(
  bundle: Bundle,
): Promise<{ resolved: ResolvedGame[]; unresolved: FlatGame[]; failed: FlatGame[] }> {
  const games = flattenBundleGames(bundle);
  const { appids: appidsByGid, failed: failedList } = await resolveBundleAppids(games.map((g) => g.gid));
  const failedGids = new Set(failedList);

  const resolved: ResolvedGame[] = [];
  const unresolved: FlatGame[] = [];
  const failed: FlatGame[] = [];
  const seenAppids = new Set<number>();
  for (const g of games) {
    if (failedGids.has(g.gid)) {
      failed.push(g);
      continue;
    }
    const appid = appidsByGid[g.gid];
    if (!appid) {
      unresolved.push(g);
      continue;
    }
    for (const id of Array.isArray(appid) ? appid : [appid]) {
      if (seenAppids.has(id)) continue;
      seenAppids.add(id);
      resolved.push({ ...g, appid: id });
    }
  }
  return { resolved, unresolved, failed };
}

// listResolve.ts's bundle source — its title (for bundleSnapshots.ts), resolved appid set, and games (for their tier prices).
export async function fetchBundleContents(
  bundleId: string,
  { country }: { country?: string } = {},
): Promise<{
  title: string;
  appids: Set<number>;
  notOnSteam: number;
  failed: number;
  bundle: Bundle;
  resolved: ResolvedGame[];
}> {
  const { bundle } = await fetchBundleById(Number(bundleId), { country });
  const { resolved, unresolved, failed } = await resolveBundleGames(bundle);
  return {
    bundle,
    resolved,
    title: bundle.title,
    appids: new Set(resolved.map((g) => g.appid)),
    notOnSteam: unresolved.length,
    failed: failed.length,
  };
}
