import {
  computeProductionTier,
  computeSteamdbRating,
  DETAIL_SOURCES,
  FAST_DETAIL_SOURCES,
  metaOrBasics,
  NO_DETAILS,
  STORE_DETAIL_SOURCES,
  steamAppAsset,
} from './utils.ts';
import { protonDbValue, TYPE_LABELS } from './gameColumns.ts';
import type { Game, GameDetails, GameDetailsReply } from './types.ts';

// The shape of one `data:` line in /api/game-details/stream's SSE response.
// A part carries only its own fields (PART_FIELDS).
export interface DetailsEvent extends Partial<GameDetailsReply> {
  appid: number;
  part?: 'fast' | 'store'; // absent: both parts in one event
  done?: boolean;
  limited?: string; // its own event, with no appid: see detailsLimited
}

// The fields each stream part carries (server.js's fetchFastDetails and fetchStoreDetails); an event without a part has both.
const PART_FIELDS = {
  fast: ['basics', 'rating', 'hltb', 'tags', 'tagWeights', 'demo', 'protondb'],
  store: ['meta'],
} as const;
const PART_SOURCES = { fast: FAST_DETAIL_SOURCES, store: STORE_DETAIL_SOURCES };

// The oldest of some write times, or null if any is missing: server.js's oldestOf, over a row's merged parts.
const oldestOf = (timestamps: (number | null | undefined)[]) =>
  timestamps.some((ts) => ts == null) ? null : Math.min(...(timestamps as number[]));

// Merges one stream event (a part, or both) into the row: only its own fields and sources change.
export function applyDetailsEvent(row: Game, event: DetailsEvent) {
  const parts = event.part ? [event.part] : (['fast', 'store'] as const);
  const sources: readonly string[] = parts.flatMap((part) => PART_SOURCES[part]);
  const details: GameDetails = { ...NO_DETAILS, basics: null, ...row.details };
  for (const part of parts)
    for (const field of PART_FIELDS[part]) Object.assign(details, { [field]: event[field] ?? null });
  // The stream leaves out media: keep any an opened game already loaded.
  if (event.meta && !event.meta.screenshots && row.details?.meta?.screenshots)
    details.meta = { ...event.meta, screenshots: row.details.meta.screenshots, movies: row.details.meta.movies };
  row.pendingSources = (row.details ? (row.pendingSources ?? []) : [...DETAIL_SOURCES]).filter(
    (source) => !sources.includes(source),
  );
  row.failedSources = [
    ...(row.failedSources ?? []).filter((source) => !sources.includes(source)),
    ...(event.failed ?? []),
  ];
  if (event.fetchedAts) {
    row.detailsFetchedAts = event.part ? { ...row.detailsFetchedAts, ...event.fetchedAts } : event.fetchedAts;
    row.detailsFetchedAt = oldestOf(Object.values(row.detailsFetchedAts));
  } else if (!event.part) {
    row.detailsFetchedAt = undefined; // a row the stream never answered: no age
    row.detailsFetchedAts = null;
  }
  const metaPending = row.pendingSources.includes('meta');
  const meta = details.meta;
  // While appdetails is coming, the browse item's part of it fills the row.
  const store = metaOrBasics(details);
  // No store metadata: guess the CDN art, as lib/steam.js's extractAppDetails does for a missing capsule.
  row.capsule = store?.capsule ?? steamAppAsset(row.appid, 'capsule_sm_120.jpg');
  row.thumb = store ? store.thumb : steamAppAsset(row.appid, 'capsule_231x87.jpg');
  if (!row.name) row.name = store?.name || row.bundlePackage?.title || '';
  row.score = details.rating?.score ?? null;
  row.positivePct =
    details.rating?.positive != null && details.rating?.total
      ? Math.round((details.rating.positive / details.rating.total) * 100)
      : null;
  row.steamdbRating = computeSteamdbRating(details.rating?.positive ?? 0, details.rating?.total ?? 0);
  row.reviewsTotal = details.rating?.total ?? null;
  row.hltbMain = details.hltb?.main ?? null;
  row.hltbExtra = details.hltb?.extra ?? null;
  row.hltbCompletionist = details.hltb?.completionist ?? null;
  row.hltbAll = details.hltb?.all ?? null;
  row.metacritic = meta?.metacritic?.score ?? null;
  row.releaseDate = store?.releaseDate ?? null;
  row.comingSoon = store?.comingSoon ?? false;
  row.genres = meta?.genres ?? [];
  row.developers = store?.developers ?? [];
  row.publishers = store?.publishers ?? [];
  row.categories = meta?.categories ?? [];
  row.tags = details.tags ?? [];
  row.protondb = protonDbValue(details.protondb?.tier);
  row.protondbPending = details.protondb?.pending ?? false;
  row.achievementCount = meta?.achievementCount ?? null;
  row.dlcCount = meta?.dlc?.length ?? null;
  row.platforms = store?.platforms ?? [];
  row.languages = meta?.languages ?? [];
  row.hasDemo = details.demo != null;
  row.type = (TYPE_LABELS as Record<string, string>)[store?.type ?? ''] ?? (store?.type ? store.type : null);
  // Price and Metacritic come with appdetails only: no tier from reviews alone.
  row.productionTier = metaPending
    ? null
    : computeProductionTier({
        isFree: meta?.isFree ?? false,
        priceInitial: meta?.priceInitial ?? null,
        reviewsTotal: details.rating?.total ?? null,
        hasMetacritic: meta?.metacritic != null,
        isDlc: meta?.fullgame != null,
        type: meta?.type ?? null,
      });
  // Listed once it has a name, or nothing more is coming to give it one.
  row.loading = !row.name && metaPending;
  row.details = details;
}
