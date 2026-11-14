import { prefersReducedMotion } from './motion.ts';
import type { Game, GameBasics, GameDetails, GameDetailsReply, GameMeta } from './types.ts';

// The custom-URL name in a Steam profile URL ('https://steamcommunity.com/id/gaben/' → 'gaben'),
// or null for anything else — a `/profiles/<steam64>` URL is Steam's own fallback form, which
// means the account never set one.
export function steamVanity(profileUrl: string | null | undefined): string | null {
  const m = (profileUrl || '').match(/steamcommunity\.com\/id\/([^/?\s]+)/);
  return m ? m[1] : null;
}

// '' for anything but a plain http(s) URL: an upstream-supplied `javascript:`/`data:` href would
// run script on click (JSX escapes text, not URL schemes).
export function safeHref(url: string | null | undefined): string {
  return url && /^https?:\/\//i.test(url) ? url : '';
}

// Extract username/ID from a pasted Steam profile URL
export function normalizeInput(raw: string): string {
  const vanity = steamVanity(raw);
  if (vanity) return vanity;
  const mNum = raw.match(/steamcommunity\.com\/profiles\/(\d+)/);
  if (mNum) return mNum[1];
  return raw;
}

// Adapted from SteamDB's current rating formula — they moved away from the Wilson score
// interval to this Bayesian shrinkage, specifically because Wilson's confidence-bound framing
// was hard to explain to users. It starts every game at a neutral 50% prior and lets the
// observed positive ratio pull it away as review volume grows. See
// https://github.com/SteamDatabase/steamdb.info-issues/issues/793.
// SHRINK_STRENGTH scales how fast that pull happens: the shrinkage weight decays as
// (total+1)^-(SHRINK_STRENGTH * log10(2)) ≈ (total+1)^-(0.301 * SHRINK_STRENGTH), so higher
// values trust smaller samples more and converge to the raw ratio sooner. SteamDB's own
// published formula is SHRINK_STRENGTH = 1 (their 90%-positive/100-review example lands at
// 80%); this app deliberately runs hotter than that — at SHRINK_STRENGTH = 2 the same example
// lands at ~87.5%, i.e. roughly the convergence SteamDB reaches only around 1,000 reviews.
// Whatever this is set to, the result is mathematically guaranteed to stay between 50 and the
// raw ratio `p`, moving monotonically closer to `p` as `total` grows — it can never overshoot
// past `p`, since the shrinkage weight is always in (0, 1].
// Returns the raw, unrounded value (0-100) — round only for display; sorting/grouping should
// use the full precision so games with the same rounded score still order deterministically.
const STEAMDB_RATING_SHRINK_STRENGTH = 2;
export function computeSteamdbRating(positive: number, total: number): number | null {
  if (!total) return null;
  const p = positive / total;
  const weight = 2 ** (-STEAMDB_RATING_SHRINK_STRENGTH * Math.log10(total + 1));
  return (p - (p - 0.5) * weight) * 100;
}

// Rough AAA/AA/Indie production-tier proxy. Steam's API has no direct budget/studio-size
// signal, so this leans on the only things that correlate with it at all: launch price
// (`priceInitial`, whole cents, USD — see isFree/priceInitial in lib/steam.js's
// extractAppDetails), review volume as a reach proxy, and Metacritic presence as a "got
// professional press coverage at all" signal. It's a heuristic, not fact — see docs/dev/decisions.md's
// AAA/AA/Indie section for the tradeoffs and known misclassifications (cheap AAA
// remasters/rereleases, prestige-priced small-studio sim games, veteran-founded small studios
// with high polish — none of these have any data-side tell). Returns null, not a tier, when
// there isn't enough signal to guess at all (DLC/non-game entries — `isDlc`/`type` — or a
// priced game with no price data).
//
// DLC/expansion appids are skipped outright rather than scored on their own price: a $10
// expansion attached to a AAA base game would otherwise read as Indie. No parent-game lookup
// is attempted (that would mean fetching the base game's own rating/meta just for this), so
// DLC rows simply render blank in this column. Same reasoning extends to Steam's other
// non-game content types (see NON_GAME_TYPES below) — a soundtrack or video has no "budget
// tier" at all, and `isDlc` (`fullgame != null`) alone doesn't catch those since they have no
// base-game back-reference. `isDlc` is still checked independently of `type` as a belt-and-
// suspenders fallback — `type` is only ever missing when Steam's response omits it entirely.
const AAA_PRICE_CENTS = 5000; // $50+ launch price
const AA_PRICE_CENTS = 2000; // $20+ launch price — the AA/premium-indie overlap zone
const AA_REVIEW_THRESHOLD = 20000; // needed (alongside AA-band price) to clear "just an expensive indie game"
const FREE_AAA_REVIEW_THRESHOLD = 200000; // the only lever available for F2P titles, which have no price signal at all
// Steam's appdetails `type` field, values other than 'game' — see the `type` comment in
// lib/steam.js's extractAppDetails. Shared with public/library.js's Type column so the two
// don't drift into disagreeing about what counts as "not really a game".
const NON_GAME_TYPES = new Set([
  'dlc',
  'demo',
  'music',
  'video',
  'series',
  'episode',
  'mod',
  'hardware',
  'advertising',
]);
export type ProductionTier = 'AAA' | 'AA' | 'Indie';
export function computeProductionTier({
  isFree,
  priceInitial,
  reviewsTotal,
  hasMetacritic,
  isDlc,
  type,
}: {
  isFree?: boolean;
  priceInitial?: number | null;
  reviewsTotal?: number | null;
  hasMetacritic?: boolean;
  isDlc?: boolean;
  type?: string | null;
} = {}): ProductionTier | null {
  if (isDlc || (type != null && NON_GAME_TYPES.has(type))) return null;
  const reviews = reviewsTotal ?? 0;
  if (isFree) return reviews >= FREE_AAA_REVIEW_THRESHOLD ? 'AAA' : 'Indie';
  if (priceInitial == null) return null;
  if (priceInitial >= AAA_PRICE_CENTS) return 'AAA';
  if (priceInitial >= AA_PRICE_CENTS) return reviews >= AA_REVIEW_THRESHOLD || hasMetacritic ? 'AA' : 'Indie';
  return 'Indie';
}

// Each ProtonDB tier's badge color — the ProtonDB column's and the side panel's.
export const PROTON_TIER_COLORS: Record<string, string> = {
  borked: 'var(--tier-borked)',
  bronze: 'var(--tier-bronze)',
  silver: 'var(--tier-silver)',
  gold: 'var(--tier-gold)',
  platinum: 'var(--tier-platinum)',
  native: 'var(--tier-native)',
};
// A tier ProtonDB adds that has no colour of its own yet.
export const PROTON_TIER_UNKNOWN = 'var(--line-strong)';

// A column `compare` ordering values by their place in `order` (a categorical column's tiers).
export function compareByOrder(
  order: readonly string[],
  toKey: (v: unknown) => string = String,
): (a: unknown, b: unknown) => number {
  return (a, b) => order.indexOf(toKey(a)) - order.indexOf(toKey(b));
}

// Smooth scrolling, unless the user asked the system for reduced motion.
export function smoothScroll(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}

// Fades an image in once loaded or failed (`.img-fade`); a cached one shows at once. Call it in the
// task that sets `src`: the load event is queued, so it can't fire before the listener.
export function fadeInOnLoad(img: HTMLImageElement): void {
  if (img.complete && img.getAttribute('src')) return;
  img.classList.add('img-fade');
  const done = () => img.classList.add('is-loaded');
  img.addEventListener('load', done, { once: true });
  img.addEventListener('error', done, { once: true });
}

export function scoreColor(n: number | null): string {
  if (n == null) return 'var(--muted)';
  if (n >= 80) return 'var(--good)';
  if (n >= 65) return 'var(--text-body)';
  if (n >= 50) return 'var(--warn)';
  return 'var(--bad)';
}

// Shared money formatter — imported by public/gameColumns.js's price-column renderers (same as
// scoreColor/dealRecordTier above) and by panel.js's Price card directly. Lives here rather than
// alongside the rest of the price-column logic in gameColumns.js specifically so panel.js can
// import it without also pulling in gameColumns.js's `@vates/data-table-core` dependency,
// meaningless for a plain side panel. `currency` falsy (not yet known/loaded) falls back
// to USD rather than throwing; an invalid/unrecognized currency code falls back to a plain
// "12.34 XYZ" string rather than letting Intl.NumberFormat's own error propagate.
export function formatMoney(v: number, currency?: string | null): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(v);
  } catch {
    return `${v.toFixed(2)} ${currency || ''}`;
  }
}

// Single source of truth for "is this price a historical record, and how should it look" —
// shared by renderBestDeal (gameColumns.ts), panel.tsx's Price card (PriceSection), and the
// Price Status column (PRICE_STATUS_TIERS/computePriceStatus, gameColumns.ts), all of
// which used to hand-roll their own copy of this exact tier logic. A 3-month-low tier was once
// added to the Price Status column before anyone remembered to add it to the other three places
// too — this function exists specifically so that can't happen again: change the tier list once,
// here, and every caller picks it up.
//
// Ordered rarest/best record first — a price only ever matches the first (rarest) tier it
// qualifies for, since an all-time low is by definition also a 1yr/3mo low (a longer lookback
// window can only find a price at or below any shorter window's minimum). Colors reuse
// scoreColor's own "excellent"/"good"/"ok" tiers rather than a new palette; the icons step down
// from a filled 🔥 to a filled ★ to an outline ☆, reading as "still a record, just a
// lesser/older one" for the shortest window.
// statusLabel/tooltipLabel spell out "Year"/"Month" in full — matching the wording of the
// lowY1/lowM3 columns themselves ("1-Year Low"/"3-Month Low", gameColumns.js) — rather than the
// abbreviated "1yr"/"3mo" this used to carry, which drifted from those column labels the moment
// they were spelled out. tooltipLabel is the same wording lowercased to read inline in a
// sentence ("Fanatical — 1-year low"); statusLabel is the title-cased standalone form shown as
// the Price Status column's own cell value.
export interface DealRecordTier {
  tier: 'all-time' | '1yr' | '3mo';
  low: 'lowAll' | 'lowY1' | 'lowM3';
  statusLabel: string;
  tooltipLabel: string;
  color: string;
  icon: string;
  bold?: boolean;
}
export const DEAL_RECORD_TIERS: DealRecordTier[] = [
  {
    tier: 'all-time',
    low: 'lowAll',
    statusLabel: 'All-Time Low',
    tooltipLabel: 'all-time low',
    color: scoreColor(90),
    icon: '🔥',
    bold: true,
  },
  {
    tier: '1yr',
    low: 'lowY1',
    statusLabel: '1-Year Low',
    tooltipLabel: '1-year low',
    color: scoreColor(70),
    icon: '★',
  },
  {
    tier: '3mo',
    low: 'lowM3',
    statusLabel: '3-Month Low',
    tooltipLabel: '3-month low',
    color: scoreColor(55),
    icon: '☆',
  },
];
// `lows` is any object carrying `lowAll`/`lowY1`/`lowM3` fields — a row/game object works as-is,
// no need to destructure at the call site. `<=`, not `<` — the current deal genuinely can BE the
// historical low itself (it's what set it), not only ever beat it. Returns `null` (not a tier)
// when `price` is missing or doesn't beat any of the three windows.
// No tier for a deal with no discount: ITAD's historyLow includes full prices (bundles-and-prices.md).
export function dealRecordTier(
  price: number | null | undefined,
  lows?: {
    lowAll?: number | null;
    lowY1?: number | null;
    lowM3?: number | null;
    bestDealCut?: number | null;
    steamRegular?: number | null;
  } | null,
): DealRecordTier | null {
  if (price == null) return null;
  // The cut is rounded, so it decides only when Steam's regular price is unknown.
  if (lows?.steamRegular != null ? price >= lows.steamRegular : lows?.bestDealCut === 0) return null;
  for (const t of DEAL_RECORD_TIERS) {
    const low = lows?.[t.low];
    if (low != null && price <= low) return t;
  }
  return null;
}

// How much cheaper the best deal is than Steam Full Price, as a whole percentage — computed by
// applyPriceInfo (priceLoading.ts, from the same response's steamRegular/
// bestDeal.price) rather than taken from ITAD's own per-deal `cut` field, deliberately: `cut` is
// that shop's own discount off *its own* regular price, which shops set independently and isn't
// consistent from row to row, whereas Steam Full Price is one stable, Valve-set anchor this app
// already treats as the reference price throughout — every row's Discount ends up answering the
// same "vs. buying it on Steam" question. Best Deal is defined as the cheapest price across
// *every* shop including Steam, so `bestDealAmt <= steamRegularAmt` always holds — this can't go
// negative in practice. Lives here (not gameColumns.js, where the rest of the price-column logic
// sits) for the same reason dealRecordTier/formatMoney do — panel.js's Price card needs it too,
// without pulling in gameColumns.js's @vates/data-table-core dependency.
export function discountPct(
  bestDealAmt: number | null | undefined,
  steamRegularAmt: number | null | undefined,
): number | null {
  if (steamRegularAmt == null || !(steamRegularAmt > 0) || bestDealAmt == null) return null;
  return Math.round((1 - bestDealAmt / steamRegularAmt) * 100);
}

export function fmtH(h: number): string {
  return h % 1 === 0 ? `${h}h` : `${h.toFixed(1)}h`;
}

// Hours played, to the hour from 10 h, to the tenth below.
export const roundHours = (h: number) => (h >= 10 ? Math.round(h) : Math.round(h * 10) / 10);
export const fmtHours = (h: number) => fmtH(roundHours(h));

// A video's position as m:ss, for the lightbox's player.
export function fmtTime(s: number) {
  if (!isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

// Format Steam playtime (minutes) as a compact string, e.g. "47m" or "12h". Returns '' for 0.
export function fmtPlaytime(mins: number | null | undefined): string {
  if (!mins) return '';
  return mins < 60 ? `${mins}m` : `${Math.round(mins / 60)}h`;
}

// Format a GetOwnedGames `rtime_last_played` Unix timestamp (seconds) as a plain ISO date
// (e.g. "2026-07-01") — same bare-date convention as the releaseDate/dateAdded table columns,
// rather than a relative "3 days ago" string. Returns '' for 0/missing (owned but never
// launched — a real, meaningful state, not absent data).
export function fmtLastPlayed(epochSec: number | null | undefined): string {
  if (!epochSec) return '';
  return new Date(epochSec * 1000).toISOString().slice(0, 10);
}

export const pad2 = (n: number) => String(n).padStart(2, '0');

// YYYY-MM-DD on the viewer's calendar.
export function fmtLocalDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// A day-precise release as YYYY-MM-DD, like every other date in the app; coarse ones ("Q4 2026") as Steam wrote them.
export function fmtReleaseDate(str: string): string {
  const d = /\b\d{1,2}\b/.test(str) ? new Date(str) : null;
  if (!d || isNaN(d.getTime())) return str;
  return fmtLocalDate(d);
}

// A Steam profile's `loccountrycode` (ISO 3166-1 alpha-2, e.g. "US") as a flag emoji — computed
// from the Unicode regional-indicator formula rather than a hand-maintained per-country lookup
// table (region.ts's own COUNTRY_OPTIONS is deliberately a curated ~15-country pricing list, not
// exhaustive, so it can't be reused here for an arbitrary account's country). Returns '' for
// anything that isn't exactly two letters, rather than rendering a broken/mismatched flag.
export function countryFlag(code: string | null | undefined): string {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return '';
  const REGIONAL_INDICATOR_A = 0x1f1e6;
  return [...code.toUpperCase()].map((c) => String.fromCodePoint(REGIONAL_INDICATOR_A + c.charCodeAt(0) - 65)).join('');
}

// Folds one more fetch's age into a readout built from several (pages, accounts): the oldest wins,
// since that's the staleness on screen, and a fresh fetch (null) counts as now rather than winning
// outright, or one fresh source would hide days-old ones behind "just now".
export function oldestFetchedAt(prev: number | null | undefined, at: number | null, now: number = Date.now()): number {
  const t = at ?? now;
  return prev == null ? t : Math.min(prev, t);
}

// "how long ago was this fetched", for the "Updated <when>" readouts next to the app's ↻ Refresh
// buttons. Deliberately coarse — the point is "is what I'm looking at from today or from last
// month", not a precise duration — and it never says "in the future" for a small clock skew
// between the server (which produces these timestamps) and the browser: anything under a minute,
// in either direction, is "just now". `null` (nothing cached — fetched fresh this request) is
// also "just now", which is exactly what it means.
export function fmtAge(fetchedAt: number | null | undefined, now: number = Date.now()): string {
  if (fetchedAt == null) return 'just now';
  const mins = Math.floor((now - fetchedAt) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

export function esc(s: unknown): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Whether focus is somewhere that genuinely swallows a plain letter or arrow key, and so must
// suppress the page's own keyboard shortcuts (see panelKeyboard.ts). Deliberately *not* "any
// <input>", which is what this replaced: the game table puts a selection checkbox on every row,
// and treating one of those as text entry silently killed every shortcut on the page — R, ↑/↓,
// `/`, `?` — for as long as focus stayed on it, with nothing on screen to say why. A checkbox,
// radio or button swallows none of those keys. A <select> does (a letter types ahead through its
// options, arrows change the value), so it stays blocked.
// Duck-typed on `tagName`/`type` rather than `instanceof HTMLInputElement`: it keeps this module
// free of a DOM dependency it otherwise has none of, and an `instanceof` check against the
// window's own constructors is wrong for an element from another realm anyway.
const TEXT_ENTRY_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
]);
export function isTextEntry(
  el: { tagName?: string; type?: string; isContentEditable?: boolean } | null | undefined,
): boolean {
  const tag = el?.tagName;
  if (!tag) return false;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return TEXT_ENTRY_INPUT_TYPES.has(el!.type ?? '');
  return el!.isContentEditable === true;
}

// Hours to one decimal, as the Played column shows them — so the filter's range bounds read
// "20", not "20.016666666666666" (the table library prints them unformatted).
export function hoursFromMinutes(minutes: number): number {
  return Math.round(minutes / 6) / 10;
}

export class ApiError extends Error {
  status: number;
  // The accounts whose games aren't public, on a private-library 400.
  accounts?: { steamid: string; name: string }[];
  constructor(message: string, status: number, accounts?: { steamid: string; name: string }[]) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.accounts = accounts;
  }
}

// The server's own words for a 429 (this client asked too much), shown instead of "didn't answer".
export const refusalMessage = (err: unknown): string | undefined =>
  err instanceof ApiError && err.status === 429 ? err.message : undefined;

// An /api call's JSON body. Throws its `error`, else `fallback` — also when the body isn't JSON
// (a proxy's HTML error page), which would otherwise surface as a parse error.
export async function fetchJson<T>(url: string, init: RequestInit | undefined, fallback: string): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => undefined);
  if (!res.ok || data === undefined) throw new ApiError(data?.error || fallback, res.status, data?.accounts);
  return data as T;
}

// How long a fetch is reused before asking the server again: accountData.ts's and panelData.ts's caches.
export const CLIENT_CACHE_MAX_AGE_MS = 10 * 60_000;
export const isClientCacheFresh = (at: number): boolean => Date.now() - at < CLIENT_CACHE_MAX_AGE_MS;

// fetchJson for a POST with a JSON body.
export function postJson<T>(url: string, body: unknown, fallback: string): Promise<T> {
  return fetchJson<T>(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    fallback,
  );
}

// `dt-tr`/`data-row-key` are @vates/data-table-solid's undocumented internals (vatesfr/data-table#24).
export const gameRowEl = (root: ParentNode | null | undefined, appid: number) =>
  root?.querySelector<HTMLElement>(`tr.dt-tr[data-row-key="${appid}"]`) ?? null;

// Focuses a game's table row without letting focus scroll it, then brings it just into view.
export function focusGameRow(root: ParentNode | null | undefined, appid: number): boolean {
  const row = gameRowEl(root, appid);
  if (!row) return false;
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: 'nearest' });
  return true;
}

// An app's art at Steam's conventional CDN path, which outlives its store page (a delisted game).
export const steamAppAsset = (appid: number | string, file: string) =>
  `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/${file}`;

// Details are in and the store answered that it has no page for this game (delisted, region-locked…).
export function noStorePage(game: Pick<Game, 'details' | 'failedSources' | 'pendingSources'>): boolean {
  return (
    !!game.details &&
    !game.details.meta &&
    !game.failedSources?.includes('meta') &&
    !game.pendingSources?.includes('meta')
  );
}

// Store metadata, or while it's still coming, the part of it the store browse item gave.
export function metaOrBasics(details: GameDetails | null | undefined): GameBasics | GameMeta | null {
  return details?.meta ?? details?.basics ?? null;
}

// One game's details; `limited` says why sources are missing when it's this client's spent share, not an upstream.
export function fetchGameDetails(appid: number, { refresh = false } = {}): Promise<GameDetailsReply> {
  return fetchJson<GameDetailsReply>(
    `/api/game-details/${appid}${refresh ? '?refresh=1' : ''}`,
    undefined,
    refresh ? 'Refresh failed' : 'Lookup failed',
  );
}

// What a /api/game-details reply sets on a game outside a list's table (ListRoute's rows: applyDetailsEvent).
export function detailsFields(
  data: GameDetailsReply,
): Pick<Game, 'details' | 'loading' | 'detailsFetchedAt' | 'detailsFetchedAts' | 'failedSources'> {
  const { limited: _limited, ...details } = data; // the reply's status, not the game's
  return {
    details,
    loading: false,
    detailsFetchedAt: data.fetchedAt, // absent when nothing was fetched: no age
    detailsFetchedAts: data.fetchedAts ?? null,
    failedSources: data.failed ?? [],
  };
}

// The detail sources a /api/game-details reply can name as `failed` (server.js's fetchGameDetails).
export const DETAIL_SOURCES = ['rating', 'hltb', 'meta', 'tags', 'protondb'] as const;
export type DetailSource = (typeof DETAIL_SOURCES)[number];
// Each stream part's sources (server.js's FAST_SOURCES and STORE_SOURCES).
export const FAST_DETAIL_SOURCES: readonly DetailSource[] = ['rating', 'hltb', 'tags', 'protondb'];
export const STORE_DETAIL_SOURCES: readonly DetailSource[] = ['meta'];
export const NO_DETAILS = { name: null, rating: null, hltb: null, meta: null, tags: null, demo: null, protondb: null };

// A lookup that didn't answer at all: every source failed, so the panel says so and offers ↻.
export function failedLookupFields(): ReturnType<typeof detailsFields> {
  return detailsFields({ ...NO_DETAILS, failed: [...DETAIL_SOURCES] });
}

type MediaState = Pick<Game, 'details' | 'failedSources' | 'pendingSources' | 'mediaFailed'>;

// Its media are loading (the details stream leaves them out); a failed load gives up until the game is opened again.
export function mediaPending(game: MediaState): boolean {
  const meta = game.details?.meta;
  return !!meta && !meta.screenshots && !game.mediaFailed;
}

// What the panel and the lightbox say for a game whose media didn't load (`mediaFailed`).
export const MEDIA_FAILED =
  "Screenshots and trailers: the Steam store didn't answer. Reopen the game or refresh details to try again.";

// No media to show yet, and some may come: details not in, the store's metadata failed (↻ retries it),
// or its media loading.
export function detailsPending(game: MediaState): boolean {
  return (
    !game.details ||
    !!game.failedSources?.includes('meta') ||
    !!game.pendingSources?.includes('meta') ||
    mediaPending(game)
  );
}
