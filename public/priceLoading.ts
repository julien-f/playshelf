// Shared "apply an ITAD /api/prices response to a row" logic — the POST /api/prices call, the
// response-to-row-fields mapping, and the "don't leave it stuck on its loading placeholder
// forever" null-out on failure (see docs/dev/integrations.md). Chunking and the
// no-ITAD-configured check stay with the caller (ListRoute.tsx's loadPrices).
import type { PriceAmount, PriceFields } from './types.ts';
import { discountPct, postJson } from './utils.ts';

// Same wording as the server's 503 for /bundles (server.js), so the two read as one cause.
// server.js's ITAD_UNAVAILABLE, for the Bundles page to say before asking.
export const BUNDLES_UNAVAILABLE =
  "Bundles and prices aren't available on this instance: it isn't connected to IsThereAnyDeal.";
export const PRICES_UNAVAILABLE = "Prices aren't available on this instance: it isn't connected to IsThereAnyDeal.";
// No closing period, like the other sources' warning shown above it.
export const PRICES_FAILED = "IsThereAnyDeal didn't answer for prices — refresh them on the Prices tile";

export const PRICE_FIELDS = [
  'steamRegular',
  'bestDealPrice',
  'bestDealShop',
  'bestDealUrl',
  'bestDealCut',
  'lowAll',
  'lowY1',
  'lowM3',
] as const;

// The shape of one game's entry in a `POST /games/prices/v3` response, as extracted server-side
// (lib/itad.js's extractPriceInfo) — only the fields read below.
interface PriceInfo {
  steamRegular?: PriceAmount | null;
  bestDeal?: { price?: PriceAmount | null; shop?: string | null; url?: string | null } | null;
  lowAll?: PriceAmount | null;
  lowY1?: PriceAmount | null;
  lowM3?: PriceAmount | null;
}

// Every figure in one /games/prices/v3 response is in the same requested-country currency, so
// any of them is an equally valid source for priceCurrency — see the matching comment on
// formatMoney (utils.ts)/renderPrice (gameColumns.ts) for why priceCurrency and a bundle's own
// tierCurrency can legitimately disagree.
export function applyPriceInfo(row: PriceFields, info: PriceInfo | null | undefined): void {
  row.steamRegular = info?.steamRegular?.amount ?? null;
  row.bestDealPrice = info?.bestDeal?.price?.amount ?? null;
  row.bestDealShop = info?.bestDeal?.shop ?? null;
  row.bestDealUrl = info?.bestDeal?.url ?? null;
  row.bestDealCut = discountPct(row.bestDealPrice, row.steamRegular);
  row.lowAll = info?.lowAll?.amount ?? null;
  row.lowY1 = info?.lowY1?.amount ?? null;
  row.lowM3 = info?.lowM3?.amount ?? null;
  row.pricesFailed = false;
  row.priceCurrency =
    info?.steamRegular?.currency ??
    info?.bestDeal?.price?.currency ??
    info?.lowAll?.currency ??
    info?.lowY1?.currency ??
    info?.lowM3?.currency ??
    null;
}

// A failed request (rate limited, transient upstream error): fills only whatever this row never
// got a value for, flagged so it renders as "didn't answer" rather than "no data" — used for a
// lookup that may have partially succeeded before failing. A row an earlier lookup answered keeps
// that answer unflagged: its nulls still mean ITAD has no data.
export function nullMissingPriceFields(row: PriceFields): void {
  for (const f of PRICE_FIELDS) {
    if (row[f] !== undefined) continue;
    row[f] = null;
    row.pricesFailed = true;
  }
}

// `fetchedAt` is when the oldest price in this batch was written to the server's cache (epoch
// ms), or null when it was fetched fresh — backs the "Updated <when>" beside a list's own
// "↻ Refresh prices", the same shape /api/common-games' own fetchedAt has.
interface PriceLookup {
  prices: Record<string, PriceInfo>;
  fetchedAt: number | null;
}

// Exactly one of gids/appids, matching POST /api/prices's own contract. Throws with the
// server's own error message on a non-2xx response, same as both callers' pre-extraction code.
export async function postPrices({
  gids,
  appids,
  country,
  refresh = false,
}: {
  gids?: string[];
  appids?: number[];
  country: string;
  refresh?: boolean;
}): Promise<PriceLookup> {
  const qs = new URLSearchParams({ country });
  if (refresh) qs.set('refresh', '1');
  const data = await postJson<{ prices?: Record<string, PriceInfo>; fetchedAt?: number | null }>(
    `/api/prices?${qs}`,
    gids ? { gids } : { appids },
    'Price lookup failed',
  );
  return { prices: data.prices ?? {}, fetchedAt: data.fetchedAt ?? null };
}
