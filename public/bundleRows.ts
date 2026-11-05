// Shapes one raw ITAD bundle-list item (GET /bundles/v1, via this app's own GET /api/bundles)
// into the flat row BundlesBrowseRoute.tsx's table sorts/filters/groups over. Its own module
// rather than a few functions inside that route specifically so it's importable from a Node unit
// test — the route is a .tsx, and Node's type stripping doesn't transform JSX.
//
// Flattened at fetch time rather than read through per-column `value()` accessors so every column
// operates on a plain scalar (`row.shop`, not `row.page?.name`), which is also what the table's
// own filter checklists/group keys are built from.

import { compareByOrder, formatMoney } from './utils.ts';
import { parseIsoDate } from './dateTime.ts';
import { convert, formatWithEstimate } from './currency.ts';
import type { PriceAmount } from './types.ts';
import type { OwnershipStatus } from './myOwnership.ts';

// ITAD-hosted artwork for one game, as the bundle list itself returns it — `boxart` (300×450
// portrait) plus banners at 145/300/400/600 wide. Only `banner145` (145×55, ~7KB) is used: it's
// almost exactly the aspect of the game tables' own capsule thumbnails, so a strip of them reads
// as a bundle "cover" without growing the row. Every asset is optional — an entry ITAD has no
// artwork for (typically a non-game item: a course, a soundtrack) carries an empty object.
interface GameAssets {
  boxart?: string;
  banner145?: string;
  banner300?: string;
  banner400?: string;
  banner600?: string;
}

// Only the fields actually read — the real response carries more (url, details, note, isMature,
// each tier's own game list, …), none of which the *picker* needs; opening a bundle re-fetches it
// in full via /lists/bundle/:bundleId (bundleData.ts's fetchBundleById).
export interface BundleListItem {
  id: number;
  title: string;
  page: { name?: string } | null;
  counts: { games?: number } | null;
  publish: string | null;
  expiry: string | null;
  tiers: { price: PriceAmount | null; games?: { id: string; assets?: GameAssets | null }[] | null }[];
  pickAndMix?: PickAndMixTier[] | null;
}

// Fanatical's quantity tiers for a "Build your own" bundle ITAD prices as null — added by
// server.js from lib/fanatical.js: "pick any `quantity` games for `prices[currency]`".
export interface PickAndMixTier {
  quantity: number;
  prices: Record<string, number>;
}

export interface PickTier {
  quantity: number;
  price: PriceAmount;
}

// In `currency` when Fanatical prices every tier in it, else USD — the same fallback ITAD's own
// USD-only shops land on.
export function pickTiers(raw: PickAndMixTier[] | null | undefined, currency: string): PickTier[] {
  if (!raw?.length) return [];
  const cur = [currency, 'USD'].find((c) => raw.every((t) => typeof t.prices[c] === 'number'));
  return cur ? raw.map((t) => ({ quantity: t.quantity, price: { amount: t.prices[cur], currency: cur } })) : [];
}

export interface PickPlan {
  cost: number;
  currency: string;
  // The tier whose per-game rate is charged.
  tier: PickTier;
  // Picks paid for beyond the selection: rounding up to a tier can beat the rate below it.
  spare: number;
}

// Fanatical charges every pick at the per-game rate of the largest tier reached (6 games at
// "5 for €5.99" = 6 × €1.198); below the smallest tier, that tier is the minimum. The cheapest way
// to take `n` picks is that, or a larger tier's own price with its unused picks free. On a cost
// tie, more picks win.
export function cheapestPicks(tiers: PickTier[], n: number): PickPlan | null {
  if (!tiers.length || n <= 0) return null;
  const sorted = [...tiers].sort((a, b) => a.quantity - b.quantity);
  let plan: PickPlan | null = null;
  sorted.forEach((tier, i) => {
    const taken = Math.max(n, tier.quantity);
    if (sorted[i + 1]?.quantity <= taken) return; // the larger tier's rate applies at `taken`
    const cost = Math.round((taken * Math.round(tier.price.amount * 100)) / tier.quantity) / 100;
    if (!plan || cost < plan.cost || (cost === plan.cost && taken - n > plan.spare))
      plan = { cost, currency: tier.price.currency, tier, spare: taken - n };
  });
  return plan;
}

// The lowest per-game rate any quantity tier reaches.
export function bestPickRate(tiers: PickTier[]): PriceAmount | null {
  return tiers.reduce<PriceAmount | null>((best, t) => {
    const amount = t.price.amount / t.quantity;
    return best && best.amount <= amount ? best : { amount, currency: t.price.currency };
  }, null);
}

// The per-game rate `n` picks are charged at; the smallest tier's for none.
export function pickRate(tiers: PickTier[], n: number): PriceAmount | null {
  const plan = cheapestPicks(tiers, Math.max(n, 1));
  return plan && { amount: plan.tier.price.amount / plan.tier.quantity, currency: plan.currency };
}

// The line under the selection toolbar's cost: "7 picks · €1.20/game", or
// "9 picks · 10-game tier · 1 more free" when the plan fills a tier.
export function pickPlanDetail(plan: PickPlan, picks: number): string {
  const how =
    picks + plan.spare === plan.tier.quantity
      ? `${plan.tier.quantity}-game tier`
      : `${formatMoney(plan.tier.price.amount / plan.tier.quantity, plan.currency)}/game`;
  const spare = plan.spare ? ` · ${plan.spare} more free` : '';
  return `${picks} pick${picks === 1 ? '' : 's'} · ${how}${spare}`;
}

// What paying `cost` saves over the same games at their best deals (`bestDeals`, in the same
// `currency`), or `overpays` when it doesn't; with an estimate in `target` when it differs.
export function savingsText(
  cost: number,
  bestDeals: number,
  currency: string,
  target: string,
): { text: string; overpays: boolean } {
  const diff = Math.round((bestDeals - cost) * 100) / 100;
  if (diff === 0) return { text: 'same as best deals', overpays: false };
  const amount = formatWithEstimate(Math.abs(diff), currency, target);
  return diff > 0 ? { text: `saves ${amount}`, overpays: false } : { text: `${amount} more`, overpays: true };
}

// A Steam package one bundle game expands to: its rows share one ITAD gid, price and pick.
export interface BundlePackage {
  gid: string;
  title: string;
  size: number;
  lead: boolean; // the package's first row, the one that carries its pick-and-mix rate
}

// Each ITAD gid spanning several resolved rows, keyed by the rows' appids.
export function bundlePackages(games: { gid: string; title: string; appid: number }[]): Map<number, BundlePackage> {
  const byGid = new Map<string, { title: string; appid: number }[]>();
  for (const g of games) byGid.set(g.gid, [...(byGid.get(g.gid) ?? []), g]);
  const out = new Map<number, BundlePackage>();
  for (const [gid, rows] of byGid)
    if (rows.length > 1)
      rows.forEach((r, i) => out.set(r.appid, { gid, title: rows[0].title, size: rows.length, lead: i === 0 }));
  return out;
}

// Widens a selection change to whole packages: a row ticked since `prev` brings its package-mates,
// one unticked takes them along. `null` when the selection is already whole.
export function wholePackages<T>(
  prev: ReadonlySet<T>,
  next: readonly T[],
  all: readonly T[],
  gidOf: (row: T) => string | undefined,
): T[] | null {
  const nextSet = new Set(next);
  const added = new Set<string>();
  const removed = new Set<string>();
  for (const r of next) if (!prev.has(r) && gidOf(r)) added.add(gidOf(r)!);
  for (const r of prev) if (!nextSet.has(r) && gidOf(r)) removed.add(gidOf(r)!);
  if (!added.size && !removed.size) return null;
  const out = all.filter((r) => {
    const gid = gidOf(r);
    if (gid && removed.has(gid)) return false;
    return nextSet.has(r) || (!!gid && added.has(gid));
  });
  return out.length === next.length && out.every((r) => nextSet.has(r)) ? null : out;
}

export interface BundleRow {
  id: number;
  title: string;
  shop: string | null;
  games: number | null;
  tierCount: number;
  price: number | null;
  currency: string | null;
  // Set when `price` is a pick-and-mix tier's: it buys this many of the bundle's games.
  pickQuantity: number | null;
  publish: string | null;
  expiry: string | null;
  status: string;
  covers: string[];
  // ITAD game ids, once each though ITAD lists a game in every tier above its own.
  gids: string[];
}

// What `/api/bundles/resolve` maps a gid to: one appid, a Steam package's several, or null (not on Steam).
export type GidAppids = number | number[] | null;

// A bundle's Steam games against the current account; a null count is a half whose fetch failed.
export interface BundleOwnership {
  steam: number;
  owned: number | null;
  wishlist: number | null;
}

// Counted per appid, as the bundle page's New to you tile counts its rows (resolveBundleGames).
// `undefined` while a gid or the ownership is still loading; `null` when a gid's lookup failed.
export function bundleOwnership(
  gids: readonly string[],
  appidsByGid: ReadonlyMap<string, GidAppids>,
  failed: ReadonlySet<string>,
  status: (appid: number) => OwnershipStatus | null,
): BundleOwnership | null | undefined {
  const appids = new Set<number>();
  for (const gid of gids) {
    if (failed.has(gid)) return null;
    if (!appidsByGid.has(gid)) return undefined;
    const appid = appidsByGid.get(gid);
    if (appid) for (const id of Array.isArray(appid) ? appid : [appid]) appids.add(id);
  }
  let owned: number | null = 0;
  let wishlist: number | null = 0;
  for (const appid of appids) {
    const s = status(appid);
    if (!s) return undefined;
    owned = owned == null || s.inLibrary == null ? null : owned + (s.inLibrary ? 1 : 0);
    wishlist = wishlist == null || s.onWishlist == null ? null : wishlist + (s.onWishlist ? 1 : 0);
  }
  return { steam: appids.size, owned, wishlist };
}

// Cheapest tier that actually has a price — `null` means no tier had one at all (a "Build Your
// Own N Bundle" pick-and-mix format, never a free bundle: a genuinely free/$0 tier still has a
// real, truthy price object, so it groups with the priced tiers rather than with this case).
export function cheapestTierPrice(bundle: BundleListItem): PriceAmount | null {
  const priced = (bundle.tiers || []).filter((t) => t.price);
  if (!priced.length) return null;
  return priced.reduce(
    (min, t) => ((t.price as PriceAmount).amount < min.amount ? (t.price as PriceAmount) : min),
    priced[0].price as PriceAmount,
  );
}

// The first `max` distinct game banners in the bundle (four, laid out 2×2 by the cover cell), in
// tier order — cheapest tier first, which
// is also the order the shop itself advertises. There is no bundle-level image anywhere in ITAD's
// data, so a bundle's "cover" can only ever be built out of its games' own artwork. Deduped by
// URL: a game unlocked at several tiers is listed in each of them (the same reason
// bundleData.ts's flattenBundleGames dedupes), and the same banner three times would read as
// three different games.
export function bundleCovers(bundle: BundleListItem, max = 4): string[] {
  const seen = new Set<string>();
  for (const tier of bundle.tiers || []) {
    for (const game of tier.games || []) {
      const url = game?.assets?.banner145;
      if (url) seen.add(url);
      if (seen.size >= max) return [...seen];
    }
  }
  return [...seen];
}

// A stable hue (0-359) for a shop name, so each shop's chip keeps one consistent color. Hashed
// from the name rather than looked up in a hand-maintained {shop: color} map, for the same reason
// the Production Tier heuristic refuses a publisher allowlist (see docs/dev/decisions.md): ITAD lists shops
// this app has never heard of, and a map would silently fall back to one shared default color for
// every one of them. The cost is that a shop ITAD spells two ways (observed live:
// "GreenManGaming" and "GreenMan Gaming") gets two colors — but those genuinely are two distinct
// values everywhere else in this table too, including its own filter checklist and grouping.
// Only the hue is derived; saturation/lightness are fixed in CSS, so no hash can produce an
// unreadable chip.
export function shopHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

export interface BundleTierSummary {
  price: number | null;
  currency: string | null;
  gameCount: number;
  // Set on a Fanatical pick-and-mix tier: how many of the `gameCount` games this price picks.
  quantity?: number;
  // Bought on its own, beside the base tiers: not cumulative, and its games aren't in any base tier.
  addon?: boolean;
}

// One entry per tier, cheapest first (ITAD's tiers are observed to always be price-ascending), for
// the bundle detail card's "$5 · $15 · $25" line. `gameCount` is that tier's *own* game list as
// ITAD returns it — pricier tiers include everything the cheaper ones unlock, so these deliberately
// don't sum to the bundle's total; the card labels them as tiers, not as a partition. A `null`
// price is a pick-and-mix ("Build Your Own") tier, rendered "Varies" like everywhere else, never
// as free. Kept here (pure, unit-tested) rather than inline in ListRoute.tsx's JSX.
// Fanatical's quantity tiers stand in for ITAD's lone null-price tier when `currency` is given and they're known.
export function bundleTierSummary(
  bundle: {
    tiers?: { price?: PriceAmount | null; games?: unknown[] | null; addon?: boolean | null }[] | null;
    pickAndMix?: PickAndMixTier[] | null;
  },
  currency?: string,
): BundleTierSummary[] {
  // An unpriced tier with no games (seen as an empty add-on) prices nothing.
  const tiers = (bundle.tiers || []).filter((t) => t.price || (t.games || []).length);
  const picks = currency ? pickTiers(bundle.pickAndMix, currency) : [];
  if (picks.length && tiers.every((t) => !t.price)) {
    const pool = Math.max(0, ...tiers.map((t) => (t.games || []).length));
    return picks.map((t) => ({
      price: t.price.amount,
      currency: t.price.currency,
      gameCount: pool,
      quantity: t.quantity,
    }));
  }
  return tiers.map((tier) => ({
    price: tier.price ? tier.price.amount : null,
    currency: tier.price ? tier.price.currency : null,
    gameCount: (tier.games || []).length,
    ...(tier.addon && { addon: true }),
  }));
}

// From the base tiers (add-ons are bought apart): `tiered` (several, cumulative), `fixed` (one), or
// `pick` (Fanatical's pick any N by quantity, its rates unknown when Fanatical's feed lacks it).
export type BundlePricingModel = 'tiered' | 'fixed' | 'pick';

export function bundlePricingModel(tiers: readonly BundleTierSummary[]): BundlePricingModel {
  const base = tiers.filter((t) => !t.addon);
  if (base.some((t) => t.quantity)) return 'pick';
  const priced = base.filter((t) => t.price != null).length;
  if (base.length && !priced) return 'pick';
  return priced > 1 ? 'tiered' : 'fixed';
}

// The tiers that filter the table: a classic bundle's priced base tiers, when it has two or more.
export function filterTiers(tiers: readonly BundleTierSummary[]): BundleTierSummary[] {
  const base = tiers.filter((t) => !t.addon);
  const priced = base.filter((t) => t.price != null && !t.quantity);
  return priced.length > 1 && priced.length === base.length ? priced : [];
}

// The tier price a Tier Price range selects: a max alone, equal to one of `tiers`' prices.
export function activeTierPrice(
  range: { min: string; max: string } | undefined,
  tiers: readonly BundleTierSummary[],
): number | null {
  if (!range || range.min !== '' || range.max === '') return null;
  const max = Number(range.max);
  return filterTiers(tiers).some((t) => t.price === max) ? max : null;
}

// What paying `price` gets: a pricier tier includes every cheaper one's games, not an add-on's.
export function atTier(row: { tierPrice?: number | null; addon?: boolean | null }, price: number): boolean {
  return !row.addon && row.tierPrice != null && row.tierPrice <= price;
}

interface BundleUrgency {
  tier: 'ended' | 'urgent' | 'soon' | 'later';
  label: string;
}

// How much time is left on a bundle, as the Ends cell renders it: a color tier plus a short
// relative label. `later` carries no label at all — past a week out, the date itself says
// everything, and a "in 23d" on every row would be noise competing with the rows that are
// genuinely about to go. `null` (no expiry at all) is an open-ended bundle, not a missing date.
//
// Inside the last day the label counts hours rather than saying "<1d" — that's the window where
// the difference between 20 hours and 2 hours actually changes what you do about it, and it's the
// only place this granularity is worth the extra text. Past 24h it goes back to whole days: "in
// 30h" is harder to read at a glance than "in 1d" and no more actionable.
export function bundleUrgency(expiry: string | null | undefined, now: number = Date.now()): BundleUrgency | null {
  if (!expiry) return null;
  const t = new Date(expiry).getTime();
  if (isNaN(t)) return null;
  const hours = (t - now) / 3600000;
  if (hours <= 0) return { tier: 'ended', label: 'ended' };
  // Floored, so "in 1h" always means at least an hour is genuinely left; under that there's no
  // whole hour to name, hence "<1h" rather than a rounded-up "in 1h" that overstates it.
  if (hours < 1) return { tier: 'urgent', label: '<1h' };
  if (hours < 24) return { tier: 'urgent', label: `in ${Math.floor(hours)}h` };
  if (hours < 48) return { tier: 'urgent', label: 'in 1d' };
  const days = Math.floor(hours / 24);
  if (hours < 24 * 7) return { tier: 'soon', label: `in ${days}d` };
  return { tier: 'later', label: '' };
}

// The urgency tier as a plain label — what the browse table's hidden "Ends in" column filters and
// groups on, and what its hero card's "Ending soon" tile toggles. `Open-ended` is a named bucket
// rather than the table's generic "(none)": a bundle with no end date is a real case, not missing
// data.
export const ENDS_IN = {
  urgent: 'Within 48h',
  soon: 'This week',
  later: 'Later',
  open: 'Open-ended',
  ended: 'Ended',
} as const;

// Soonest-first, for the column's own comparator: alphabetically these order Ended < Later <
// Open-ended < This week < Within 48h, which says nothing about urgency.
const ENDS_IN_ORDER: string[] = [ENDS_IN.urgent, ENDS_IN.soon, ENDS_IN.later, ENDS_IN.open, ENDS_IN.ended];

export function bundleEndsIn(expiry: string | null | undefined, now: number = Date.now()): string {
  const urgency = bundleUrgency(expiry, now);
  return urgency ? ENDS_IN[urgency.tier] : ENDS_IN.open;
}

// Values only, no rows — the shape `ColumnDef.compare` takes, which also orders the column's
// filter checklist and its group headers.
export const compareEndsIn = compareByOrder(ENDS_IN_ORDER);

// The publish-side counterpart of ENDS_IN, for the browse table's hidden "Age" column and the
// "New" tile that toggles it — "what appeared since I last looked" is the other half of the
// browsing question, and the Published column can only answer it by being sorted and read.
export const BUNDLE_AGE = {
  fresh: 'Last 24h',
  week: 'This week',
  older: 'Older',
  unknown: 'Unknown',
} as const;

const BUNDLE_AGE_ORDER: string[] = [BUNDLE_AGE.fresh, BUNDLE_AGE.week, BUNDLE_AGE.older, BUNDLE_AGE.unknown];

export function bundleAge(publish: string | null | undefined, now: number = Date.now()): string {
  const d = parseIsoDate(publish);
  if (!d) return BUNDLE_AGE.unknown;
  const hours = (now - d.getTime()) / 3600000;
  if (hours < 24) return BUNDLE_AGE.fresh;
  if (hours < 24 * 7) return BUNDLE_AGE.week;
  return BUNDLE_AGE.older;
}

// Newest-first, the direction this column is actually read in — see compareEndsIn.
export const compareBundleAge = compareByOrder(BUNDLE_AGE_ORDER);

// `now` is a parameter purely so the Active/Expired split is testable without freezing the clock.
// A bundle with no expiry at all counts as Active — that's how ITAD represents an open-ended one,
// not a missing date to guess at.
// `currency` picks which of Fanatical's pick-and-mix prices stands in for a null tier price.
export function toBundleRow(bundle: BundleListItem, now: number = Date.now(), currency = 'USD'): BundleRow {
  const firstPick = cheapestTierPrice(bundle) ? null : (pickTiers(bundle.pickAndMix, currency)[0] ?? null);
  const price = firstPick ? firstPick.price : cheapestTierPrice(bundle);
  const expired = !!bundle.expiry && new Date(bundle.expiry).getTime() < now;
  return {
    id: bundle.id,
    title: bundle.title,
    shop: bundle.page?.name || null,
    games: bundle.counts?.games ?? null,
    tierCount: (bundle.tiers || []).length,
    price: price ? price.amount : null,
    currency: price ? price.currency : null,
    pickQuantity: firstPick ? firstPick.quantity : null,
    publish: bundle.publish,
    expiry: bundle.expiry,
    status: expired ? 'Expired' : 'Active',
    covers: bundleCovers(bundle),
    gids: [...new Set((bundle.tiers || []).flatMap((t) => (t.games || []).map((g) => g.id)))],
  };
}

// Numeric keys sorting base tiers by price, then add-ons, then unpriced games; the offsets sit far
// above any tier price in any currency (a ₩ tier runs to tens of thousands).
const ADDON_GROUP = 1e12;
const VARIES_GROUP = 2e12;
export function tierGroupKey(row: { tierPrice?: number | null; addon?: boolean | null }): number {
  if (row.tierPrice == null) return VARIES_GROUP;
  return row.addon ? ADDON_GROUP + row.tierPrice : row.tierPrice;
}

// A tier key's price, and whether it's an add-on's (tierGroupKey's inverse, unpriced aside).
export function tierKeyPrice(key: number): { price: number; addon: boolean } {
  return key >= ADDON_GROUP ? { price: key - ADDON_GROUP, addon: true } : { price: key, addon: false };
}

// A Tier Price group's header: the tier's price (or `rangeMax` range), its step over the tier below,
// and with `value` what that step buys the account and whether it beats those games' best deals.
export function tierGroupLabel(
  key: number,
  tiers: readonly BundleTierSummary[],
  model: BundlePricingModel,
  rangeMax: ReadonlyMap<number, number>,
  target: string,
  value?: TierValue,
): string {
  if (key >= VARIES_GROUP) return 'Varies';
  const { price, addon } = tierKeyPrice(key);
  const tier = tiers.find((t) => !!t.addon === addon && t.price === price);
  const currency = tier?.currency ?? target;
  const max = rangeMax.get(price);
  const money =
    max != null
      ? `${formatMoney(price, currency)}–${formatWithEstimate(max, currency, target)}`
      : formatWithEstimate(price, currency, target);
  const what = value && whatItBuys(value, currency, target);
  const worth = what ? ` · ${what.games}` : '';
  if (addon) return `${money} add-on${worth}`;
  if (max != null) return `${money} · which tier isn't listed${worth}`;
  const base = tiers.filter((t) => !t.addon && !t.quantity);
  const prev = base.filter((t) => t.price != null && t.price < price).at(-1);
  const head = model === 'fixed' && base.every((t) => t.price != null) ? `${money} · every game` : `${money} tier`;
  const step = prev ? price - prev.price! : price;
  const stepText = prev ? `+${formatMoney(step, currency)}` : '';
  if (!what) return prev ? `${head} · ${stepText} over ${formatMoney(prev.price!, currency)}` : head;
  // The verdict first: on a phone the header shows its first ~30 characters only.
  const verdict = what.deals == null ? null : verdictText(what.deals - step, currency, target);
  const detail = what.fresh ? [stepText && `${stepText} for`, what.games].filter(Boolean).join(' ') : stepText;
  return [head, verdict ?? (what.fresh ? null : 'nothing new'), detail].filter(Boolean).join(' · ');
}

// A tier group's games not in the account's library: how many, how many have no best deal, and their
// best deals summed in the tier's currency (null when any lacks one).
export interface TierValue {
  fresh: number;
  unpriced: number;
  deals: number | null;
}

// "2 new worth $24.38", "2 new · 1 unpriced", or "nothing new" (then no `deals` to judge).
function whatItBuys(
  value: TierValue,
  currency: string,
  target: string,
): { fresh: number; games: string; deals: number | null } {
  if (!value.fresh) return { fresh: 0, games: 'nothing new', deals: null };
  const games = `${value.fresh} new`;
  if (value.deals == null)
    return { fresh: value.fresh, games: value.unpriced ? `${games} · ${value.unpriced} unpriced` : games, deals: null };
  return {
    fresh: value.fresh,
    games: `${games} worth ${formatWithEstimate(value.deals, currency, target)}`,
    deals: value.deals,
  };
}

// What paying a step instead of buying its new games at their best deals saves (`diff` > 0) or costs.
function verdictText(diff: number, currency: string, target: string): string {
  const cents = Math.round(diff * 100) / 100;
  if (cents === 0) return 'same as apart';
  const amount = formatWithEstimate(Math.abs(cents), currency, target);
  return cents > 0 ? `saves ${amount}` : `${amount} cheaper apart`;
}

// `rows` once per ITAD game (`keyOf`): a Steam package's rows each carry the whole package's deal.
export function onePerGid<T>(rows: readonly T[], keyOf: (row: T) => string | number): T[] {
  const seen = new Set<string | number>();
  return rows.filter((r) => {
    const key = keyOf(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface DealRow {
  bestDealPrice?: number | null;
  priceCurrency?: string | null;
}

// `rows`' summed best deals in `currency`, null until every one is priced (or convertible).
export function sumBestDeals<T extends DealRow>(
  rows: readonly T[],
  currency: string,
  keyOf: (row: T) => string | number,
): number | null {
  const deals = onePerGid(rows, keyOf).map((r) =>
    r.bestDealPrice == null ? null : convert(r.bestDealPrice, r.priceCurrency ?? currency, currency),
  );
  return deals.every((d) => d != null) ? deals.reduce((sum, d) => sum! + d!, 0)! : null;
}

// Each tier group's TierValue, by tierGroupKey; a group whose tier has no currency is left out.
export function tierValues<
  T extends DealRow & { tierPrice?: number | null; addon?: boolean | null; inLibrary?: boolean | null },
>(rows: readonly T[], tiers: readonly BundleTierSummary[], keyOf: (row: T) => string | number): Map<number, TierValue> {
  const byKey = new Map<number, T[]>();
  for (const r of rows) {
    if (r.tierPrice == null) continue;
    const key = tierGroupKey(r);
    byKey.set(key, [...(byKey.get(key) ?? []), ...(r.inLibrary ? [] : [r])]);
  }
  const out = new Map<number, TierValue>();
  for (const [key, fresh] of byKey) {
    const { price, addon } = tierKeyPrice(key);
    const currency = tiers.find((t) => !!t.addon === addon && t.price === price)?.currency;
    if (!currency) continue;
    const games = onePerGid(fresh, keyOf);
    out.set(key, {
      fresh: fresh.length,
      unpriced: games.filter((r) => r.bestDealPrice == null).length,
      deals: sumBestDeals(fresh, currency, keyOf),
    });
  }
  return out;
}

// The pressed tier, else the cheapest holding every game in `fresh` (base games not owned); null when
// unknown (a range past the pressed tier, an unpriced game) or nothing is new.
export function savingTier(
  fresh: readonly { tierPrice?: number | null; tierPriceMax?: number | null }[],
  tiers: readonly BundleTierSummary[],
  pressed: number | null,
): BundleTierSummary | null {
  const base = tiers.filter((t) => !t.addon && t.price != null && !t.quantity).sort((a, b) => a.price! - b.price!);
  if (!fresh.length || fresh.some((r) => r.tierPrice == null)) return null;
  const need = Math.max(...fresh.map((r) => r.tierPriceMax ?? r.tierPrice!));
  if (pressed != null) return need <= pressed ? (base.find((t) => t.price === pressed) ?? null) : null;
  return base.find((t) => t.price! >= need) ?? null;
}
