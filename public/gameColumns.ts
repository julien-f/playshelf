// Shared game-table building blocks for the Library Explorer (public/library.js) and Bundles
// (public/bundles.js) pages — both build a `@vates/data-table-solid` table over a list of
// games, and the overwhelming majority of what a "game" column even means (score, HLTB,
// release date, genres/tags, platform/ProtonDB compatibility, and — for Wishlist/Bundles —
// price) is identical between them. This used to be two separate, hand-maintained copies (see
// CLAUDE.md's git history) — that's exactly what let a 3-month-low tier get added to the Price
// Status column without anyone remembering to add it to the other three places that needed it
// too (see `dealRecordTier` in `public/utils.js`, which fixed *that* specific duplication).
// This file fixes the column-*list* duplication the same way: one shared source, each page
// layering its own page-specific columns on top via `insertColumnsAfter`.
//
// An ES module — imported directly by `bundles.js`/`library.js` (`import { CORE_COLUMNS, ... }
// from '/gameColumns.js'`), not loaded via its own `<script>` tag on either page's HTML. Now
// that `utils.js`/`urlState.js`/`region.js`/`panel.js`/etc. are all real ES modules too (see
// CLAUDE.md's git history — they used to be plain global scripts), this file imports
// `scoreColor`/`dealRecordTier`/`DEAL_RECORD_TIERS`/`formatMoney` from `utils.js` directly
// rather than reading them off the global scope. `formatMoney` specifically lives in
// `utils.js`, not here, precisely so `panel.js`'s own Price card can import it too — see its
// own comment there.
//
// What's NOT here, and stays page-specific: `tierPrice`/`addon` (bundles.js — no Library/
// Wishlist equivalent, a bundle-tier concept), `priority`/`dateAdded` (library.js's Wishlist
// tab — Steam wishlist rank/added-date, meaningless for an owned game or a bundle's game),
// `playtime`/`lastPlayed` (library.js's Library tab only — wishlist games aren't owned and
// bundle games aren't necessarily owned either, so neither has playtime data). Each page's own
// file still owns the render/format helpers backing *those* columns (`renderTierPrice`/
// `renderAddonBadge` in bundles.js) plus its own `DEFAULT_VISIBLE`/`DEFAULT_SORT` — which
// columns a given page shows by default and how it sorts on first load are page-specific
// decisions, not something to centralize just because the column *definitions* are shared.

// The bucket/compare helpers are `@vates/data-table-core` primitives, but `@vates/data-table-solid`
// re-exports them (since before this app's 0.13.0 pin) — importing from there instead avoids a
// second, otherwise-unnecessary direct dependency on core.
import {
  compareMissingLast,
  numericRangeGroup,
  datePartGroup,
  bucketLogRange,
  formatLogRange,
} from '@vates/data-table-solid';
import type { ColumnDef } from '@vates/data-table-solid';
import {
  scoreColor,
  dealRecordTier,
  DEAL_RECORD_TIERS,
  formatMoney,
  compareByOrder,
  PROTON_TIER_COLORS,
  PROTON_TIER_UNKNOWN,
  fadeInOnLoad,
  fmtReleaseDate,
  type DetailSource,
} from './utils.ts';
import { convert } from './currency.ts';
import { isIgdbKey, NOT_ON_STEAM } from './gameKey.ts';
import { platformLine } from './gameSearch.ts';

// Rows are assembled in the still-untyped library.js/bundles.js from several independent async
// sources (the game-details stream, price lookups, ...), so `any`-valued access is the honest
// shape here; strictness is enforced on the pure logic below, not by pretending rows are fully
// typed at this layer.
type Row = Record<string, any>;

export const fmt = {
  num: (v: unknown): string => (v === undefined ? '…' : v === null ? '—' : String(v)),
  numRound: (v: unknown): string => (v === undefined ? '…' : v === null ? '—' : String(Math.round(Number(v)))),
  dec1: (v: unknown): string => (v === undefined ? '…' : v === null ? '—' : Number(v).toFixed(1)),
  str: (v: unknown): string => (v === undefined ? '…' : String(v || '—')),
  ct: (v: unknown): string => (v === undefined ? '…' : v === null ? '—' : Number(v).toLocaleString()),
  arr: (v: unknown): string =>
    v === undefined ? '…' : Array.isArray(v) ? (v.length ? v.join(', ') : '—') : String(v || '—'),
};

// Bare colored number rather than a progress bar — a bar's fill color carries the same
// good/bad signal the number's color already does, and with up to four score-ish columns
// (Weighted Rating, Wilson Score, Steam %, Metacritic Score) visible at once, bars add visual
// weight without adding information. Uses the global `scoreColor()` from utils.js so the
// color scale matches the side panel's score display exactly, instead of a second copy of
// the same thresholds.
// `computeSteamdbRating` returns unrounded precision (0-100) so sort/group operate on the full
// number rather than the display-rounded integer — round only where displayed (here, and in
// `fmt.numRound`/`applyDetailsEvent` below).
function renderScoreNum(v: unknown): Node {
  if (v === undefined) return document.createTextNode('…');
  if (v === null) return document.createTextNode('—');
  const rounded = Math.round(Number(v));
  const span = document.createElement('span');
  span.style.color = scoreColor(rounded);
  span.textContent = String(rounded);
  return span;
}

// ProtonDB's Linux/Steam Deck compatibility tiers, worst to best (see the matching color map
// in public/panel.js, which renders the same badge in the side panel — kept as a separate copy
// there rather than imported, even though both are ES modules now, since importing from here
// would also pull in this file's `@vates/data-table-core` dependency, meaningless for a plain
// side panel). "Native" (an actual Linux port, no Proton needed) ranks above "Platinum" (flawless
// *through* Proton). No "pending" entry — extractProtonDb (lib/steam.js) maps a "pending"
// (too-few-reports) result to its own provisionalTier before it ever reaches the client, so
// what arrives here is always one of the real tiers above, just possibly flagged `pending`
// (see row.protondbPending / renderProtonBadge below) to mark it as low-confidence.
const PROTON_TIER_ORDER: string[] = ['borked', 'bronze', 'silver', 'gold', 'platinum', 'native'];

// Backing value is the plain capitalized tier name ("Gold", "Platinum") — @vates/data-table-core
// 0.7.0 added a per-column `compare` option (see the ProtonDB column below) precisely so a
// categorical column can sort by real quality order without needing display text to double as
// a sort key; see https://github.com/vatesfr/data-table/issues/15 for the request behind it (an
// earlier version of this column baked a rank digit into the value itself — "3 Gold" — to work
// around not having this, which leaked into the filter checklist/search text; not needed anymore).
export function protonDbValue(tier: string | null | undefined): string | null {
  if (tier == null || PROTON_TIER_ORDER.indexOf(tier) === -1) return null;
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

// Ordering used by the ProtonDB column's `compare` below — same tier list as protonDbValue.
// `compareMissingLast` (new in 0.7.0 alongside `compare` itself) pins a missing rating to the
// end of the sort regardless of ascending/descending, rather than an empty value sorting first
// under plain ascending lexicographic comparison — games with no ProtonDB data yet shouldn't
// float to the top just because "" sorts before every real tier name.
const PROTON_NO_REPORT = 'No report';
const PROTON_DIDNT_ANSWER = "Didn't answer";
const isProtonMissing = (v: unknown): boolean =>
  v == null || v === '' || v === PROTON_NO_REPORT || v === PROTON_DIDNT_ANSWER;
const compareProtonTier = compareMissingLast(
  compareByOrder(PROTON_TIER_ORDER, (v) => String(v).toLowerCase()),
  isProtonMissing,
);

// The generic colored-pill treatment (`.status-badge`, styles/components.css) — shared with
// renderDemoBadge below rather than each column inventing its own pill styling. `row.protondbPending`
// (set from extractProtonDb's own `pending` flag — see PROTON_TIER_ORDER's comment above) marks a
// provisional tier assigned from too few reports for ProtonDB itself to be confident in — faded and
// suffixed with "?" rather than rendered identically to a confirmed tier of the same name.
function renderProtonBadge(v: unknown, row: Row): Node {
  if (v === undefined) return document.createTextNode('…');
  if (isProtonMissing(v)) return document.createTextNode('—');
  const span = document.createElement('span');
  span.className = 'status-badge';
  span.style.background = PROTON_TIER_COLORS[String(v).toLowerCase()] || PROTON_TIER_UNKNOWN;
  span.textContent = String(v);
  if (row?.protondbPending) {
    span.textContent += ' ?';
    span.style.opacity = '0.6';
    span.title = 'Provisional — too few ProtonDB reports yet for a confident rating';
  }
  return span;
}

// Neutral, not the accent: a fact about the game, neither state nor an action.
function renderDemoBadge(v: unknown): Node {
  if (v === undefined) return document.createTextNode('…');
  if (!v) return document.createTextNode('—');
  const span = document.createElement('span');
  span.className = 'status-badge status-badge-neutral';
  span.textContent = 'Demo';
  return span;
}

// Appends bare ✓/☆ markers after the name text when `row.inLibrary`/`row.onWishlist` are set,
// and colors (+ bolds, for Wishlisted) the whole cell — name text included, not just the badge —
// using the *exact same* `OWNERSHIP_STATUS_TIERS` (below) `OWNERSHIP_STATUS_COLUMN`'s own cell
// derives its color/bold from, rather than a second, separately-maintained copy of "yellow+bold
// for wishlisted, green for owned" (a first draft of this function did exactly that, as a CSS
// class, and the bold weight quietly went missing from it — the tier list didn't exist yet for
// this function to share). Just inline rather than a labeled pill, unlike the panel's own
// `.panel-ownership-badge`/gameSearch.ts's `.game-search-badge` — a table row has even less room
// than a dropdown row. Wishlisted wins over Owned when both are true (only one color/weight can
// apply to the cell, unlike the two badges below, which both still show) — matching
// `OWNERSHIP_STATUS_TIERS`'s own "Owned & Wishlisted" tier already being bold, not some third
// mixed treatment. Wishlisted outranks Owned here deliberately: on a browse page ("should I buy
// this") a wishlisted game is the actionable signal worth the stronger highlight, while owning it
// already is just a heads-up. A no-op everywhere `inLibrary`/`onWishlist` are never populated — the Library/
// Wishlist tabs' own rows, where "do I own this" is trivially always true/false and not worth
// flagging — since this only renders whatever's already on the row (ListRoute.tsx's
// stampMyOwnership is what actually populates them, for the bundle/recent/user lists where the
// question is a genuine one). Uncoloured when neither applies (`computeOwnershipStatus` returns
// `null`/`'Not Owned'`, neither of which has a tier `color`).
export function renderNameCell(v: unknown, row: Row): Node {
  if (isIgdbKey(row.appid)) return renderNotOnSteamName(v, row);
  const nameText = fmt.str(v);
  const status = computeOwnershipStatus(row);
  const tier = status ? OWNERSHIP_STATUS_TIERS.find((t) => t.label === status) : null;
  // Always wrapped: the class is also what pins the Name column on a phone (vendor-data-table.css).
  const wrap = document.createElement('span');
  wrap.className = 'game-name-cell';
  if (tier?.color) wrap.style.color = tier.color;
  if (tier?.bold) wrap.style.fontWeight = '600';
  wrap.appendChild(document.createTextNode(nameText));
  if (row.inLibrary) {
    const b = document.createElement('span');
    b.className = 'name-status-badge owned';
    b.title = 'In library'; // not "In your library" — see panel.tsx's own ownership badge/git history for why
    b.textContent = '✓';
    wrap.appendChild(b);
  }
  if (row.onWishlist) {
    const b = document.createElement('span');
    b.className = 'name-status-badge wishlisted';
    b.title = 'On wishlist'; // not "On your wishlist" — ditto
    b.textContent = '☆';
    wrap.appendChild(b);
  }
  return wrap;
}

// A game outside Steam: its name over "Not on Steam · PS5 · Switch +4", as in the search dropdown.
function renderNotOnSteamName(v: unknown, row: Row): Node {
  const wrap = document.createElement('span');
  wrap.className = 'game-name-cell';
  const name = document.createElement('span');
  name.textContent = fmt.str(v);
  const line = document.createElement('span');
  line.className = 'game-name-platforms';
  line.textContent = [
    NOT_ON_STEAM,
    platformLine({ appid: row.appid, name: '', tinyImage: null, platforms: row.platforms }),
  ]
    .filter(Boolean)
    .join(' · ');
  wrap.append(name, line);
  return wrap;
}

// Ignores `value` and reads `row.thumb`/`row.capsule` directly — `value` is forced to null on this column
// (see CORE_COLUMNS below) so the raw image URL never surfaces in full-text search matches.
export function renderThumb(_value: unknown, row: Row): Node {
  const img = document.createElement('img');
  img.className = 'game-thumb';
  img.alt = '';
  img.loading = 'lazy';
  img.width = 160;
  img.height = 60;
  const fallback = row.thumb && row.capsule !== row.thumb ? row.capsule : null;
  const src = row.thumb || row.capsule;
  if (src) img.src = src;
  fadeInOnLoad(img);
  img.addEventListener('error', () => {
    if (fallback && img.src !== fallback) img.src = fallback;
    else img.style.visibility = 'hidden';
  });
  return img;
}

// Friendly labels for Steam's raw appdetails `type` enum (see the `type` comment in
// lib/steam.js's extractAppDetails) — backs the Type column below. `game` isn't listed:
// applyDetailsEvent falls back to the raw string itself for any value not in this map, and
// 'game' reads fine as-is capitalized... except it isn't capitalized raw, so it's listed too
// for consistent casing. Values Steam is known to actually use for entries that can end up
// owned/wishlisted (a soundtrack or artbook DLC, not just base games); `demo`/`advertising`
// are here mostly for completeness — a free demo/ad appid isn't normally something a person
// owns or wishlists in its own right.
export const TYPE_LABELS = {
  game: 'Game',
  dlc: 'DLC',
  music: 'Soundtrack',
  video: 'Video',
  series: 'Series',
  episode: 'Episode',
  mod: 'Mod',
  hardware: 'Hardware',
  demo: 'Demo',
  advertising: 'Advertising',
};

// Worst-to-best ordering for the Production Tier column's `compare` below. `computeProductionTier`
// (public/utils.js) already returns null for "not enough signal to guess" (DLC, or a priced game
// with no price data) — `compareMissingLast` handles that the same way every other heuristic/
// possibly-absent column here does, pinning it last regardless of sort direction.
const PRODUCTION_TIER_ORDER: string[] = ['Indie', 'AA', 'AAA'];
const compareProductionTier = compareMissingLast(compareByOrder(PRODUCTION_TIER_ORDER));

// Plain numeric comparator, wrapped so a `null` ("no data" — no reviews, no Metacritic score,
// no HLTB match) always sorts last regardless of direction. Without this, a `type: 'number'`
// column's own coercion (`Number(null) === 0`) makes "no data" indistinguishable from an actual
// zero score/duration — most visibly on `steamdbRating`, the default sort column: a game with
// zero reviews currently ties with one confirmed 0% positive instead of being set apart from it.
export const compareNumMissingLast = compareMissingLast((a, b) => Number(a) - Number(b));

// Steam's release_date.date only gets this coarse ("2026", "Fall 2026", "2026 or later") while
// a game is still unreleased — once it ships, Steam always returns a specific day. JS's own Date
// parser anchors whatever it can partially recognize at the START of that period ("2026" -> Jan 1,
// "October 2026" -> Oct 1), which would sort a still-unreleased game BEFORE games that already
// shipped earlier that same year/month — backwards, since the real date can only land later.
// Anchor coarse dates at the END of their stated period instead (the latest point consistent with
// what Steam told us); a fully-specified date (or wishlist's `dateAdded`, always a precise
// timestamp) matches none of these patterns and falls through to plain `new Date()` unchanged.
//
// A bare year and Q4 of that same year both anchor at Dec 31 — same timestamp, so without a
// tie-break they wouldn't sort in any defined order relative to each other. "2026" carries less
// information than "Q4 2026" (it could still land in Q1-Q3), so nudge it 1ms later: a vaguer claim
// for the same end-of-period ranks just after a more specific one, without disturbing its order
// against any other, actually-different, day.
//
// Steam also uses two placeholders with no date in them at all: "Coming soon" and "To be
// announced"/"TBA". Deliberately NOT handled here — this function is also the column's
// `parseDate`, which the table framework reuses for the range-filter bounds and the date-tree
// filter dropdown, not just sorting. If a placeholder produced a real (if huge) timestamp, one
// "Coming soon" wishlist row would drag the whole column's computed max to that fake date,
// squashing every real release date into a sliver of the range slider, and a "released after X"
// filter would wrongly match games we have no actual date for. Letting them fall through to plain
// `new Date(s).getTime()` (NaN, same as any other unrecognized string) makes every one of those
// consumers correctly treat "unreleased" as "no known date" instead of "year 9999". Sort order is
// handled separately below, by `releaseSortTimestamp`, the only consumer that actually wants a
// deterministic placeholder position.
const SEASON_END = { spring: [5, 20], summer: [8, 21], fall: [11, 20], autumn: [11, 20], winter: [2, 19] } as const;
export function endOfReleasePeriod(str: string): number {
  const s = String(str).trim();
  let m: RegExpExecArray | null;
  if ((m = /^(spring|summer|fall|autumn|winter)\s+(\d{4})$/i.exec(s))) {
    const [month, day] = SEASON_END[m[1].toLowerCase() as keyof typeof SEASON_END];
    const year = m[1].toLowerCase() === 'winter' ? Number(m[2]) + 1 : Number(m[2]); // winter spills into next year
    return new Date(year, month, day).getTime();
  }
  if ((m = /^Q([1-4])\s+(\d{4})$/i.exec(s))) {
    return new Date(Number(m[2]), Number(m[1]) * 3, 0).getTime(); // last day of the quarter's final month
  }
  if ((m = /^(\d{4})(?:\s+or\s+later)?$/i.exec(s))) {
    return new Date(Number(m[1]), 11, 31).getTime() + 1; // bare year, or open-ended "2026 or later" — end of that year, nudged 1ms past a same-year Q4 tie
  }
  if (/^[A-Za-z]+\s+\d{4}$/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return new Date(d.getFullYear(), d.getMonth() + 1, 0).getTime(); // month name + year, no day — last day of that month
  }
  return new Date(s).getTime();
}

// Sort-only view of the Released column. "Coming soon" (some info — it's presumably nearer than a
// distant bare year) and "To be announced"/"TBA" (no info whatsoever) both need to sort after
// every real or coarse date — including a far-future bare year like "2028" — while still
// preserving Coming soon < TBA between themselves. Sentinel timestamps anchored past any realistic
// release year do that; they're deliberately not NaN (unlike a genuinely unrecognized string) so
// they get a real, deterministic position instead of falling into the null/empty "missing" bucket
// handled by compareDateMissingLast below. Kept local to the sort comparator (not folded back into
// endOfReleasePeriod/parseDate) so the range-filter bounds and date-tree — which also read
// `parseDate` — never see these fake dates; see the comment on endOfReleasePeriod above.
const COMING_SOON_SENTINEL = new Date(9999, 0, 1).getTime();
const TBA_SENTINEL = new Date(9999, 0, 2).getTime();
export function releaseSortTimestamp(str: string): number {
  const s = String(str).trim();
  if (/^coming soon$/i.test(s)) return COMING_SOON_SENTINEL;
  if (/^(to be announced|tba)$/i.test(s)) return TBA_SENTINEL;
  return endOfReleasePeriod(s);
}

// A sort parses each value ~4 times per comparison; capped as Bundles' publish/expiry datetimes are near-unique.
const SORT_TIMESTAMPS_MAX = 10_000;
const sortTimestamps = new Map<string, number>();
function cachedSortTimestamp(v: unknown): number {
  const s = String(v);
  let t = sortTimestamps.get(s);
  if (t === undefined) {
    if (sortTimestamps.size >= SORT_TIMESTAMPS_MAX) sortTimestamps.clear();
    sortTimestamps.set(s, (t = releaseSortTimestamp(s)));
  }
  return t;
}

// Same idea for `type: 'date'` columns (`releaseDate`, wishlist's `dateAdded`) — setting
// `compare` bypasses the column's own `parseDate`/type coercion too, so a `null` date would
// otherwise become epoch 1970 via `new Date(null).getTime()` and sort as impossibly old, and a
// string neither `releaseSortTimestamp` nor plain `new Date()` can make sense of (not one of the
// recognized coarse forms, and not a valid date either) would sort at a nondeterministic spot via
// NaN comparisons — both need to be pinned last instead. "Coming soon" and "To be announced" are
// NOT examples of that — `releaseSortTimestamp` gives them real sentinel positions (see above) so
// they sort deterministically after every dated/coarse entry instead of landing in this bucket.
export const compareDateMissingLast = compareMissingLast(
  (a, b) => cachedSortTimestamp(a) - cachedSortTimestamp(b),
  (v) => v == null || v === '' || isNaN(cachedSortTimestamp(v)),
);

// A still-unreleased game in `--warn`, like a middling score: notable, not final. By Steam's
// `comingSoon` flag (lib/steam.js), since a coarse "Coming soon" has no date to compare to today.
function renderReleaseDate(v: unknown, row: Row): Node {
  if (v === undefined) return document.createTextNode('…');
  if (!v) return document.createTextNode('—');
  const span = document.createElement('span');
  if (row.comingSoon) span.style.color = 'var(--warn)';
  span.textContent = fmtReleaseDate(String(v));
  return span;
}

// ── Group-by bucketing for continuous/high-cardinality columns ─────────────────────────────
// @vates/data-table-core's `groupValue`/`groupFormat` exist precisely so a `type: 'number'`/
// `type: 'date'` column with a near-unique value per row (an exact review count, an hours-played
// figure, an exact release date) can still group into a handful of useful buckets instead of one
// row-sized group per game.

// reviewsTotal spans several orders of magnitude — a handful of games with millions of reviews
// sitting next to dozens with single digits — so a fixed linear step (`bucketNumericRange`) is
// the wrong tool: too small a step and the long tail collapses into one dominant bucket, too
// large and the 0-100 range where most of the actual variety lives gets flattened into one or
// two. Half-decade ("1-3-10") log buckets fix both ends — twice the resolution of plain base-10
// decades, which checked against real data put an entire 1-10 range (where a lot of the actual
// variety lives) into a single indistinguishable bucket.
//
// The staircase/formatting itself is `bucketLogRange`/`formatLogRange` (`@vates/data-table-core`)
// with a `[1, 3]` division — this app used to hand-roll the same {1, 3, 10, 30, 100, ...} math
// (and its "30–100" range formatting) before core provided it. The one piece core's `min` option
// can't express is kept as a thin wrapper below: `min` alone folds a real zero (never played, 0
// reviews) into the exact same "<1" bucket as a game briefly played for a few minutes/barely
// reviewed at all, which reads as the same thing when it isn't. `LogRangeOptions.min` also has no
// notion of a value being exactly the floor rather than merely below it, so there's no option that
// gets this split for free.
const LOG_BUCKET_OPTS = { divisions: [1, 3] }; // base 10 (default), halved via a 1-3-10 grid
const logBucketValue = bucketLogRange(LOG_BUCKET_OPTS);
export function halfDecadeBucket(value: unknown): number | null {
  const n = Number(value);
  if (n <= 0) return 0; // covers a real 0 and (via withMissingGroup below) never sees a missing value
  const bucket = logBucketValue(value);
  // core's own "below min" sentinel is -Infinity — sorts before the real-zero bucket above, the
  // opposite of what "some activity" vs. "none at all" should mean. Remapped to 0.5 (strictly
  // between the "none" bucket's `0` and the first real decade bucket's `1`) so
  // `0 < 0.5 < 1 < 3 < ...` stays correct in both sort directions.
  return bucket === -Infinity ? 0.5 : bucket;
}
export function formatHalfDecadeBucket(unit?: string, zeroLabel?: string): (keyPart: string) => string {
  const formatBucket = formatLogRange(LOG_BUCKET_OPTS, unit);
  return (keyPart: string) => {
    const n = Number(keyPart);
    if (n === 0) return zeroLabel ?? '';
    if (n === 0.5) return formatBucket(-Infinity as unknown as string); // core's own "<1{unit}" label for the sentinel (number sentinel, d.ts types keyPart as string)
    return formatBucket(keyPart);
  };
}

// The four "how good is this game" score columns (Weighted Rating, Wilson Score, Steam %,
// Metacritic) are all bounded 0-100 but, for any library skewed toward games people actually
// chose to own, cluster tightly near the top — verified live against a 1,131-game collector
// library, where a plain 25-point step (bucketNumericRange(25), fine for Discount below, also
// bounded 0-100 but genuinely spread out) put 75-86% of games into a single 75-100 bucket.
// Fixed 5-point steps read the top of the range at real resolution instead; everything below
// SCORE_BUCKET_FLOOR collapses into one "< 60" bucket rather than several sparse near-empty
// ones nobody's low-rated tail actually needs distinguished — the same "coarse tail, fine head"
// shape halfDecadeBucket/PRICE_TIERS already use above, just linear instead of log/staircase
// since the whole range is only 0-100 to begin with. `positivePct` is the one of the four that
// can hit a real 100 (a game with zero negative reviews) — `Math.min(..., 100 - STEP)` folds it
// into the same 95-100 bucket as everything else in that range rather than spawning its own
// single-value "100-105" bucket the way a bare `Math.floor(v/step)*step` would.
const SCORE_BUCKET_STEP = 5;
const SCORE_BUCKET_FLOOR = 60;
export function scoreBucket(value: unknown): number {
  const n = Number(value);
  if (!(n >= SCORE_BUCKET_FLOOR)) return -1; // below the floor (or NaN) — the single "< 60" bucket
  return Math.min(Math.floor(n / SCORE_BUCKET_STEP) * SCORE_BUCKET_STEP, 100 - SCORE_BUCKET_STEP);
}
function formatScoreBucket(keyPart: string): string {
  const n = Number(keyPart);
  if (n === -1) return `< ${SCORE_BUCKET_FLOOR}`;
  return `${n}–${n + SCORE_BUCKET_STEP}`;
}

// For the hand-rolled bucketers here (scores, review counts, price tiers), which coerce a missing
// value to 0 (`Number(null)`) and would fold it into a real group. A `null` group value is keyed by
// the empty string, which formatMissingGroup below labels. (The library's own numericRangeGroup/
// datePartGroup already handle missing values.)
export function withMissingGroup(bucketFn: (v: unknown, row: Row) => unknown) {
  return (value: unknown, row: Row) => (value == null ? null : bucketFn(value, row));
}
// Pairs with withMissingGroup above: labels its empty-string group key.
export function formatMissingGroup(
  formatFn: (keyPart: string) => string,
  missingLabel = '—',
): (keyPart: string) => string {
  return (keyPart) => (keyPart === '' ? missingLabel : formatFn(keyPart));
}

// Price columns (Tier Price, Best Deal, Steam Full Price, the three historical lows) bucket
// against Steam's own common price tiers ($4.99/$14.99/$29.99/$49.99/$74.99) rather than an
// evenly-spaced or geometric step — the breakpoints where a player actually thinks "under $5" vs
// "a $50 game" vs "$75+ premium" don't sit on a fixed multiplier, so neither a plain
// bucketNumericRange step nor halfDecadeBucket's log grid above reproduces them. Hand-rolled the
// same "real zero gets its own bucket, distinct from a merely-cheap game" shape halfDecadeBucket
// already uses (there: 0 reviews vs. the log grid; here: Free vs. $0.01-$4.99). No currency
// symbol in the bucket boundaries themselves (unlike renderPrice's per-row formatMoney) — the
// selected region's currency isn't fixed to USD, and a hardcoded "$" would mislabel every other
// currency's amounts the same way the tierCurrency/priceCurrency split below exists to avoid.
export const PRICE_TIERS = [0, 5, 15, 30, 50, 75, 100]; // bucket lower bounds; 100 is the open-ended "100+" tier
// Converting a near-dollar currency would push its .99 prices (€4.99) across the bounds.
function tierAmount(n: number, currency?: string | null): number {
  const usd = currency ? convert(n, currency, 'USD') : null;
  return usd != null && (usd / n < 0.5 || usd / n > 2) ? usd : n;
}
// A converted amount's bucket is keyed "$<bound>", so its label says it's in dollars.
export function priceTierBucket(value: unknown, currency?: string | null): number | string | null {
  const own = Number(value);
  const n = tierAmount(own, currency);
  if (n === 0) return -1; // Free — its own bucket, strictly below the "0–5" range of priced games
  if (!(n > 0)) return null; // missing/NaN/negative
  let bound = PRICE_TIERS[0];
  for (let i = PRICE_TIERS.length - 1; i >= 0; i--)
    if (n >= PRICE_TIERS[i]) {
      bound = PRICE_TIERS[i];
      break;
    }
  return n === own ? bound : `$${bound}`;
}
export function formatPriceTier(keyPart: string): string {
  const unit = keyPart.startsWith('$') ? '$' : '';
  const n = Number(keyPart.slice(unit.length));
  if (n === -1) return 'Free';
  const top = PRICE_TIERS[PRICE_TIERS.length - 1];
  if (n === top) return `${unit}${top}+`;
  return `${unit}${n}–${unit}${PRICE_TIERS[PRICE_TIERS.indexOf(n) + 1]}`;
}
// Spread into a column like the library's numericRangeGroup, bucketing in `currency(row)`'s tiers.
export function priceTierGroup(currency: (row: Row) => string | null | undefined, missingLabel?: string) {
  return {
    groupValue: withMissingGroup((v, row) => priceTierBucket(v, currency(row))),
    groupFormat: formatMissingGroup(formatPriceTier, missingLabel),
  };
}

// Every price-ish column is shown in the region currently selected (see COUNTRY_OPTIONS/
// detectCountry in public/region.js) — but NOT necessarily all in the *same* currency as each
// other, which is why there are two separate currency fields on a row rather than one shared
// `row.currency` (an earlier version of bundles.js had exactly that single shared field, and it
// was a real bug: confirmed live, a bundle's own tier price can come back from ITAD in USD only
// — same "this shop just doesn't offer this country's currency" situation documented elsewhere
// for bundle prices — while that SAME bundle's games' Steam/other-shop prices, a separate
// upstream call, correctly come back in the requested EUR. A single shared field meant whichever
// request finished first "won" and silently mislabeled the other's amounts with the wrong
// currency symbol — right number, wrong currency, easy to miss since only the symbol was wrong).
// `tierCurrency` (a bundle's own tier data, bundles.js only) backs only the Tier Price column;
// `priceCurrency` (`/games/prices/v3` data, set by ListRoute.tsx's `loadPrices`) backs every other price column here. `null` means "free"/"no data"
// throughout, never rendered as $0 or blank. `formatMoney` itself lives in utils.js, not here —
// see this file's own header comment for why.
export function renderPrice(v: unknown, row: Row): Node {
  if (v === undefined) return document.createTextNode('…');
  if (v == null) return document.createTextNode('—');
  return document.createTextNode(formatMoney(Number(v), row.priceCurrency));
}

// Bare price only — no shop name in the cell itself (see the bestDealShop column below for
// that, kept separate/hidden for anyone who wants to group/filter by it). Colored, with a small
// icon suffix, when the current best deal is at or below a historical low — reusing
// scoreColor's own "excellent"/"good"/"ok" tier colors (see the side panel/table score columns)
// rather than inventing a new palette just for this.
export function renderBestDeal(v: unknown, row: Row): Node {
  if (v === undefined) return document.createTextNode('…');
  if (v == null) return document.createTextNode('—');
  // dealRecordTier (public/utils.js) is the single shared source of this tier/color/icon logic
  // — see its own comment for why: this column's own Price Status (below) and panel.js's Price
  // card need the exact same answer, and hand-duplicating it per file is exactly what let a
  // 3-month-low tier go missing from some of them before this file and dealRecordTier existed.
  const rec = dealRecordTier(Number(v), row);
  const span = document.createElement('span');
  if (rec) {
    span.style.color = rec.color;
    if (rec.bold) span.style.fontWeight = '600';
  }
  span.append(renderPrice(v, row));
  if (rec) span.append(' ' + rec.icon);
  // Native `title` tooltip — the shop name was deliberately dropped from the cell's own text
  // (see above) but is still worth surfacing on hover rather than losing entirely. No "cheapest
  // current price" restatement — that's already what the Best Deal column itself means, so the
  // tooltip is just the shop, plus a short dash-separated record note when it's also a low — one
  // consistent shape rather than a different sentence per case, so the 🔥/★/☆ badges have a
  // plain-language explanation right there for anyone who hasn't already puzzled them out from
  // color alone.
  if (row.bestDealShop) {
    span.title = `${row.bestDealShop}${rec ? ` — ${rec.tooltipLabel}` : ''}`;
  }
  return span;
}

// `0` (the best deal genuinely isn't any cheaper than Steam Full Price — distinct from
// `null`/`undefined`, which mean "no data"/"still loading") renders the same as missing data: a
// flat "0%" reads as noise next to every other row's real discount, and nothing else in this
// column set treats a confirmed zero differently from "nothing to show" either.
function renderCut(v: unknown): Node {
  if (v === undefined) return document.createTextNode('…');
  if (v == null || v === 0) return document.createTextNode('—');
  return document.createTextNode(`-${v}%`);
}

// Categorizes a row's current best deal so it can be filtered/grouped on directly, rather than
// only eyeballed off the Best Deal cell's badge. Delegates the "is this a historical record"
// question to the shared `dealRecordTier` (public/utils.js) — see its own comment for why this
// needs to be one shared function. 'On Sale' is the catch-all for a real discount that isn't
// (yet) any kind of historical low; 'Not Discounted' is a confirmed bestDealCut === 0, kept
// distinct from missing price data entirely (no ITAD data yet / still loading), which falls
// through to null/undefined same as every other price column here — see PRICE_STATUS_COLUMN's
// own format below.
export function computePriceStatus(row: Row): string | null | undefined {
  if (row.bestDealPrice === undefined) return undefined;
  if (row.bestDealPrice == null) return null;
  const rec = dealRecordTier(row.bestDealPrice, row);
  if (rec) return rec.statusLabel;
  if (row.bestDealCut == null) return null;
  return row.bestDealCut > 0 ? 'On Sale' : 'Not Discounted';
}
// Single source of truth for Price Status's sort order and visual styling — the three record
// tiers' color/icon/bold are pulled straight from DEAL_RECORD_TIERS (public/utils.js, the same
// list computePriceStatus/renderBestDeal read) rather than restated here, reversed to worst-
// to-best order and prefixed with the two non-record labels. `PRICE_STATUS_ORDER` (feeding
// `comparePriceStatus`, compareByOrder like PRODUCTION_TIER_ORDER/PROTON_TIER_ORDER above) and
// renderPriceStatus's badge/color below both derive from this one
// list, so the sort order, the visual ramp, and the Best Deal cell's own badge can't drift out
// of sync with each other. `defaultSortDir: 'desc'` on the column then shows the best deals
// (All-Time Low) first on a fresh click. On Sale/Not Discounted stay plain, uncolored, no icon
// — not being a record isn't a bad thing worth flagging, so nothing here draws the eye away
// from the three real record tiers.
interface StatusTier {
  label: string;
  color?: string;
  icon?: string;
  bold?: boolean;
}

// A categorical column's cell: its tier's color, weight and icon, or plain text for a tier with no
// color; "—" for no value.
function renderTierLabel(tiers: readonly StatusTier[]): (v: unknown) => Node {
  return (v) => {
    if (v == null) return document.createTextNode('—');
    const sv = String(v);
    const tier = tiers.find((t) => t.label === sv);
    if (!tier?.color) return document.createTextNode(sv);
    const span = document.createElement('span');
    span.style.color = tier.color;
    if (tier.bold) span.style.fontWeight = '600';
    span.textContent = sv + tier.icon!;
    return span;
  };
}
export const PRICE_STATUS_TIERS: StatusTier[] = [
  { label: 'Not Discounted' },
  { label: 'On Sale' },
  ...DEAL_RECORD_TIERS.slice()
    .reverse()
    .map((t) => ({ label: t.statusLabel, color: t.color, icon: ' ' + t.icon, bold: t.bold })),
];
const PRICE_STATUS_ORDER = PRICE_STATUS_TIERS.map((t) => t.label);
const comparePriceStatus = compareMissingLast(compareByOrder(PRICE_STATUS_ORDER));
const renderPriceTier = renderTierLabel(PRICE_STATUS_TIERS);
function renderPriceStatus(v: unknown): Node {
  return v === undefined ? document.createTextNode('…') : renderPriceTier(v);
}
const PRICE_STATUS_COLUMN: ColumnDef<Row> = {
  key: 'priceStatus',
  label: 'Price Status',
  groupable: true,
  value: (row: Row) => computePriceStatus(row),
  format: (v) => (v === undefined ? '…' : v == null ? '—' : String(v)),
  render: renderPriceStatus,
  compare: comparePriceStatus,
  defaultSortDir: 'desc',
  category: 'Pricing',
};

// "Is this appid owned/wishlisted by currentAccount" (whichever account's list is actually on
// screen — see myOwnership.ts's own comment) — turns its `inLibrary`/`onWishlist` fields
// (stamped onto a row by ListRoute.tsx's own stampMyOwnership, from the sets myOwnership.ts
// already loads once per loaded account — no per-row fetch of its own) into one categorical
// column, same shape as PRICE_STATUS_COLUMN above. Labeled "Ownership Status", not "My Status"
// — this app has no real login, so `currentAccount` isn't a verified "this is you" identity,
// just whichever account happens to be loaded (a friend's, just as easily as your own); claiming
// it's personally "mine" in a column header overstates that relationship the same way an earlier
// version of the *other* ownership badge in this app (panel.tsx's, plain "In library"/"On
// wishlist") was deliberately kept free of "your"/"my" wording for. `null` (rendered "—") covers
// both "no account loaded" and "still loading" — same ambiguity myOwnership.ts's own
// MyOwnershipPeek.status already accepts, for the same reason: a synchronous cell render can't
// await, and stampMyOwnership re-stamps every row once the real sets land. Not part of
// CORE_COLUMNS — an Owned/Wishlist list's own rows are always trivially 'Owned'/'Wishlisted', so
// this only earns a place on ListRoute.tsx's BUNDLE_COLUMNS/RECENT_COLUMNS (which 'user' also
// uses), where it's a genuine question — and even there it's hidden by default (not part of
// either kind's own *_DEFAULT_VISIBLE list): renderNameCell below already surfaces the same
// information (color + a ✓/☆ badge) right on the Name column everyone already looks at, so this
// dedicated column is a secondary, sort/group/filter-only view onto the same fact rather than
// something worth defaulting to visible.
export function computeOwnershipStatus(row: Row): string | null {
  if (row.inLibrary && row.onWishlist) return 'Owned & Wishlisted';
  if (row.inLibrary) return 'Owned';
  if (row.onWishlist) return 'Wishlisted';
  if (row.inLibrary == null) return null; // not loaded yet, or the owned fetch failed
  return 'Not Owned';
}
// Single source of truth for both this column's sort order/visual styling AND renderNameCell's
// own name-cell coloring below — same "one tier list, multiple renderers pull from it" shape as
// DEAL_RECORD_TIERS/PRICE_STATUS_TIERS above, for the same reason: a color/bold fact restated in
// two places is a color/bold fact that can silently drift apart between them (confirmed live:
// renderNameCell's own first draft colored the name text but left off the bold weight
// OWNERSHIP_STATUS_COLUMN's cell already had for the exact same "Owned" status).
// Wishlisted is green and bold, Owned is plain yellow — on a page about buying things, "this is
// something I actually want" is the positive, actionable signal (green, the stronger highlight);
// "I already own this" is a caution against a duplicate purchase, not a call to action, so it
// gets the warning color (yellow) instead — a deliberate swap from the green=owned/yellow=
// wishlisted pairing this app used everywhere before (checkmark reading as green/affirmative,
// star reading as yellow/aspirational is the more natural pairing in isolation, e.g. a profile
// summary), which stopped fitting once the context became specifically "should I buy this".
// `.game-search-badge`/`.name-status-badge`/`.panel-ownership-badge` (the --owned/--wishlisted tokens) and
// gameSearch.ts's dropdown all follow this same swapped pairing now too, rather than leaving
// those standalone badges on the old colors — the checkmark right next to this tier's own
// yellow-highlighted name text is the same fact and needs to read the same color, and the other
// two badges are the same icons in different places elsewhere in the app; one meaning per color
// throughout, not a second, place-specific convention. "Owned & Wishlisted" uses Owned's warning
// color, not Wishlisted's green — already owning it is what actually matters for a buy decision
// regardless of wishlist status — but keeps the bold weight, since it's still the most
// information any one status carries.
const OWNERSHIP_STATUS_TIERS: StatusTier[] = [
  { label: 'Not Owned' },
  { label: 'Wishlisted', color: 'var(--wishlisted)', icon: ' ☆', bold: true },
  { label: 'Owned', color: 'var(--owned)', icon: ' ✓' },
  { label: 'Owned & Wishlisted', color: 'var(--owned)', icon: ' ✓', bold: true },
];
const OWNERSHIP_STATUS_ORDER = OWNERSHIP_STATUS_TIERS.map((t) => t.label);
const compareOwnershipStatus = compareMissingLast(compareByOrder(OWNERSHIP_STATUS_ORDER));
export const OWNERSHIP_STATUS_COLUMN: ColumnDef<Row> = {
  key: 'ownershipStatus',
  label: 'Ownership Status',
  groupable: true,
  value: computeOwnershipStatus,
  format: (v) => (v == null ? '—' : String(v)),
  render: renderTierLabel(OWNERSHIP_STATUS_TIERS),
  compare: compareOwnershipStatus,
  defaultSortDir: 'desc',
};

// Inserts `newColumns` right after the column keyed `afterKey`, rather than always appending at
// the very end — used by every page below to layer its own page-specific columns onto
// CORE_COLUMNS/PRICE_COLUMNS in the section they actually belong to (e.g. Wishlist Rank right
// after Name, an identity attribute, rather than trailing after Extras where nobody would think
// to look for it).
export function insertColumnsAfter(
  columns: ColumnDef<Row>[],
  afterKey: string,
  ...newColumns: ColumnDef<Row>[]
): ColumnDef<Row>[] {
  const idx = columns.findIndex((c) => c.key === afterKey);
  return [...columns.slice(0, idx + 1), ...newColumns, ...columns.slice(idx + 1)];
}

// Filtered tags' weights (relative to the top tag, absent: 0) in %: mean, or minimum on All mode.
export function tagMatchScore(
  weights: Record<string, number | null> | null | undefined,
  selected: ReadonlySet<string> | undefined,
  all = false,
): number | null {
  if (!weights || !selected?.size) return null;
  const each = [...selected].map((tag) => weights[tag] ?? 0);
  return Math.round((all ? Math.min(...each) : each.reduce((a, b) => a + b) / each.length) * 100);
}

export const SIMILARITY_KEY = 'similarity';
// Ranks the list by closeness to one game, from the panel's Sort list by similarity.
export function similarityColumn(scores: () => ReadonlyMap<number, number> | null): ColumnDef<Row> {
  return {
    key: SIMILARITY_KEY,
    label: 'Similarity',
    type: 'number',
    value: (row) => scores()?.get(row.appid) ?? null,
    format: (v) => (v == null ? '—' : `${v}%`),
    compare: compareNumMissingLast,
    defaultSortDir: 'desc',
    searchable: false,
    category: 'Classification',
  };
}

export const TAG_MATCH_KEY = 'tagMatch';
// Ranks a tag filter's matches by how strongly each game carries the filtered tags.
export function tagMatchColumn(selected: () => ReadonlySet<string> | undefined, all: () => boolean): ColumnDef<Row> {
  return {
    key: TAG_MATCH_KEY,
    label: 'Tag match',
    type: 'number',
    value: (row) => tagMatchScore(row.details?.tagWeights, selected(), all()),
    format: (v) => (v == null ? '—' : `${v}%`),
    compare: compareNumMissingLast,
    defaultSortDir: 'desc',
    searchable: false,
    category: 'Classification',
  };
}

// ── Core columns — shared by every page's game table: the Library Explorer's Library tab,
// its Wishlist tab, and Bundles. Grouped into sections (identity → scores → HLTB → dates →
// classification → compatibility → extras) rather than roughly the order each was added to the
// codebase — with 20+ columns, an alphabetical or add-order list makes both the column picker
// and this source file hard to scan. Within a section, the most commonly-useful/default-visible
// column leads.
//
// Most of these sections also carry a matching `category` (`@vates/data-table-core` >= 0.13 —
// see vatesfr/data-table's "Column categories" feature) — with 25+ core columns plus PRICE_COLUMNS
// and each page's own extras, the Columns/Sort/Group dropdowns' flat lists (and the Filter
// dropdown's left pane) get long enough that a category submenu genuinely helps scanning, the
// exact problem the feature exists for. Identity (capsule/name) stays uncategorized — only two
// columns, both default-visible, not worth a submenu; same for page-specific columns that are the
// only thing of their kind on a given page (Wishlist Rank). `category` values match this file's
// own section headers verbatim so the two can't drift apart — except Dates, folded into a wider
// "Play Time & Dates" category alongside library.js's own Played/Last Played/Added columns (see
// their own comments), since all four answer the same "when" question a reader would look for
// together, and Released alone wouldn't be worth its own category on the Bundles/Library-tab
// pages that don't have the other three.
//
// Deliberately does NOT include price columns (see PRICE_COLUMNS below) or anything page-
// specific (Tier Price/Add-on, Wishlist Rank/Added, Played/Last Played) — an owned game in the
// Library tab has no price data at all (nothing to buy), so price columns would be dead weight
// there, not just hidden by default the way they are on Wishlist/Bundles.
// What the user knows each detail source as, for "didn't answer" notes.
export const SOURCE_NAMES: Record<string, string> = {
  ...({
    rating: 'Steam reviews',
    hltb: 'HowLongToBeat',
    protondb: 'ProtonDB',
    meta: 'Steam store',
    tags: 'Steam tags',
  } satisfies Record<DetailSource, string>),
  igdb: 'IGDB', // a game outside Steam's store-page fields
};
const COLUMN_SOURCE: Record<string, string> = {
  steamdbRating: 'rating',
  score: 'rating',
  positivePct: 'rating',
  reviewsTotal: 'rating',
  hltbAll: 'hltb',
  hltbMain: 'hltb',
  hltbExtra: 'hltb',
  hltbCompletionist: 'hltb',
  protondb: 'protondb',
  metacritic: 'meta',
  releaseDate: 'meta',
  genres: 'meta',
  categories: 'meta',
  developers: 'meta',
  publishers: 'meta',
  languages: 'meta',
  type: 'meta',
  platforms: 'meta',
  achievementCount: 'meta',
  dlcCount: 'meta',
  tags: 'tags',
  igdbRating: 'igdb',
  steamRegular: 'prices',
  bestDealPrice: 'prices',
  bestDealCut: 'prices',
  bestDealShop: 'prices',
  lowAll: 'prices',
  lowY1: 'prices',
  lowM3: 'prices',
};
// Prices come from the list's own batch, which the panel's ↻ doesn't re-fetch.
const sourceFailed = (row: Row, source: string) =>
  source === 'prices' ? !!row.pricesFailed : !!row.failedSources?.includes(rowSource(row, source));
// A game outside Steam's store-page fields come from IGDB.
const rowSource = (row: Row, source: string) => (source === 'meta' && isIgdbKey(row.appid) ? 'igdb' : source);

// A source that errored shows ⚠ rather than "—", which means it has no data for the game.
function markFailedSources(columns: ColumnDef<Row>[]): ColumnDef<Row>[] {
  return columns.map((col) => {
    const source = COLUMN_SOURCE[col.key];
    if (!source) return col;
    const render = (v: unknown, row: Row): Node => {
      // The row's own field, not `v`: a column may name a missing value (ProtonDB's "No report").
      // Store-page lists are [] when missing, not null.
      const raw = (row as Record<string, unknown>)[col.key];
      const missing = raw == null || (Array.isArray(raw) && raw.length === 0);
      if (missing && sourceFailed(row, source)) {
        const mark = document.createElement('span');
        mark.className = 'cell-failed';
        mark.textContent = '⚠';
        mark.title =
          source === 'prices'
            ? "IsThereAnyDeal didn't answer — refresh prices on the list's Prices tile"
            : `${SOURCE_NAMES[rowSource(row, source)]} didn't answer — Refresh details in the game's panel retries`;
        return mark;
      }
      return col.render ? col.render(v, row) : document.createTextNode(col.format ? col.format(v, row) : String(v));
    };
    return { ...col, render };
  });
}

const STEAM_ONLY_TITLE = "Steam only — this game isn't on Steam";
// The columns a game outside Steam has no value for: Steam's own data, or scored from Steam tags.
export const STEAM_ONLY_KEYS: ReadonlySet<string> = new Set([
  'steamdbRating',
  'score',
  'positivePct',
  'metacritic',
  'reviewsTotal',
  'genres', // IGDB's vocabulary differs; its genres show in the panel
  'categories',
  'tags',
  'languages',
  'type',
  'productionTier',
  'protondb',
  'hasDemo',
  'achievementCount',
  'dlcCount',
  'ownershipStatus',
  'tasteFit',
  SIMILARITY_KEY,
  TAG_MATCH_KEY,
]);

function renderNotApplicable(): Node {
  const mark = document.createElement('span');
  mark.className = 'cell-na';
  mark.textContent = 'n/a';
  mark.title = STEAM_ONLY_TITLE;
  return mark;
}

// Pins NOT_ON_STEAM after everything, missing values included, in either direction.
function notOnSteamLast(col: ColumnDef<Row>): NonNullable<ColumnDef<Row>['compare']> {
  const compare =
    col.compare ??
    ((a: unknown, b: unknown) => {
      const [x, y] = col.type === 'number' ? [Number(a), Number(b)] : [a, b];
      return typeof x === 'number' && typeof y === 'number' && !isNaN(x) && !isNaN(y)
        ? x - y
        : String(x ?? '').localeCompare(String(y ?? ''));
    });
  return (a, b, dir) => {
    const na = a === NOT_ON_STEAM;
    const nb = b === NOT_ON_STEAM;
    if (na || nb) return na === nb ? 0 : (na ? 1 : -1) * (dir === 'desc' ? -1 : 1);
    return compare(a, b, dir);
  };
}

// A game outside Steam reads NOT_ON_STEAM in Steam-only columns, shown as a muted "n/a" ("—" is no data, ⚠ failed):
// sorted and grouped last, its own checklist entry, and out of any range a filter sets.
export function markSteamOnly(columns: ColumnDef<Row>[]): ColumnDef<Row>[] {
  return columns.map((col) => {
    if (!STEAM_ONLY_KEYS.has(col.key)) return col;
    const value = col.value ?? ((row: Row) => row[col.key]);
    const { groupValue, groupFormat } = col;
    return {
      ...col,
      value: (row) => (isIgdbKey(row.appid) ? NOT_ON_STEAM : value(row)),
      format: (v, row) => (v === NOT_ON_STEAM ? NOT_ON_STEAM : col.format ? col.format(v, row) : String(v ?? '')),
      render: (v, row) =>
        v === NOT_ON_STEAM
          ? renderNotApplicable()
          : col.render
            ? col.render(v, row)
            : document.createTextNode(col.format ? col.format(v, row) : String(v)),
      compare: notOnSteamLast(col),
      ...(groupValue && {
        groupValue: (v: unknown, row: Row) => (v === NOT_ON_STEAM ? NOT_ON_STEAM : groupValue(v, row)),
        groupFormat: (key: string) => (key === NOT_ON_STEAM ? key : groupFormat ? groupFormat(key) : key),
      }),
    };
  });
}

// IGDB's platform names, as Steam's Platforms column spells them.
const STEAM_PLATFORM_NAMES: Record<string, string> = { PC: 'Windows' };
export const steamPlatformNames = (platforms: readonly string[]): string[] =>
  platforms.map((p) => STEAM_PLATFORM_NAMES[p] ?? p);

// The four "how good is this game" scores share one bucket scheme and sort best first.
function scoreColumn(key: string, label: string, format: (v: unknown) => string): ColumnDef<Row> {
  return {
    key,
    label,
    type: 'number',
    groupable: true,
    format,
    render: renderScoreNum,
    compare: compareNumMissingLast,
    defaultSortDir: 'desc',
    groupValue: withMissingGroup(scoreBucket),
    groupFormat: formatMissingGroup(formatScoreBucket),
    keepVisibleWhenGrouped: true,
    category: 'Scores & Reviews',
  };
}

// A game outside Steam's critics-and-users score, as the panel's IGDB chip reads it; a Steam game has none.
export const [IGDB_RATING_COLUMN] = markFailedSources([
  {
    ...scoreColumn('igdbRating', 'IGDB Rating', (v) => (v == null ? '—' : `${v}/100`)),
    value: (row) => row.igdbRating?.score ?? null,
    render: (v) => {
      if (v == null) return document.createTextNode('—');
      const span = document.createElement('span');
      span.style.color = scoreColor(Number(v));
      span.textContent = `${v}/100`;
      return span;
    },
  },
]);

function hltbColumn(key: string, label: string): ColumnDef<Row> {
  return {
    key,
    label,
    type: 'number',
    groupable: true,
    format: fmt.dec1,
    compare: compareNumMissingLast,
    ...numericRangeGroup(10, 'h', '—'),
    keepVisibleWhenGrouped: true,
    category: 'How Long To Beat',
  };
}

// A price in the row's own `priceCurrency`, cheapest first.
function priceColumn(key: string, label: string, render = renderPrice): ColumnDef<Row> {
  return {
    key,
    label,
    type: 'number',
    groupable: true,
    format: fmt.num,
    render,
    compare: compareNumMissingLast,
    defaultSortDir: 'asc',
    ...priceTierGroup((row) => row.priceCurrency),
    keepVisibleWhenGrouped: true,
    category: 'Pricing',
  };
}

export const CORE_COLUMNS: ColumnDef<Row>[] = markFailedSources([
  // ── Identity ────────────────────────────────────────────────────────────────
  {
    key: 'capsule',
    label: 'Image',
    sortable: false,
    filterable: false,
    groupable: false,
    value: () => null,
    render: renderThumb,
  },
  // Not groupable — a game's name is (almost always) unique per row, so grouping by it would
  // produce close to one row-sized group per game.
  // `format: fmt.str` handles a still-streaming-in name (Wishlist/Bundles rows only know a
  // placeholder name until store metadata resolves) the same way every other loading cell does;
  // harmless for the Library tab, whose owned-game names are always known upfront.
  {
    key: 'name',
    label: 'Name',
    filterable: false,
    groupable: false,
    pinned: true,
    format: fmt.str,
    render: renderNameCell,
  },

  // ── Scores & reviews ────────────────────────────────────────────────────────
  // The default-visible score: a Bayesian-shrinkage formula adapted from SteamDB's own (see
  // computeSteamdbRating in utils.js, tuned to converge to the raw ratio faster than SteamDB's
  // published version does) — shown first as the app's primary rating. Stored unrounded so
  // sort/default-sort operate on full precision (two games both displaying "97" still order
  // deterministically) — `scoreBucket` (see its own comment above) buckets by the same floored
  // value regardless, so that precision isn't lost for grouping either. `defaultSortDir: 'desc'`
  // (new in @vates/data-table-core 0.8.0) on this and the other three score-ish columns below —
  // a fresh click on any of them should show the best-rated games first, not the worst; without
  // it a first click started every numeric column ascending (worst-first) regardless of what the
  // number actually means.
  scoreColumn('steamdbRating', 'Weighted Rating', fmt.numRound),
  // Wilson score lower bound — statistically rigorous but harder to explain than SteamDB's
  // current formula (which is why it isn't the default-visible score anymore); kept available
  // for anyone who wants the more conservative, confidence-bound number instead.
  scoreColumn('score', 'Wilson Score', fmt.num),
  // Raw positive/total ratio — the plain percentage Steam's own store page shows, as opposed to
  // the two adjusted scores above. No "%" in the cell (the column header already says so) —
  // same bare colored number treatment as the other three score columns for consistency.
  scoreColumn('positivePct', 'Steam %', fmt.num),
  // Grouped with the other user-review scores above rather than off near HLTB — it's a critic
  // (not player) score, but it's still one of the four "how good is this game" numbers, and
  // keeping all of them contiguous makes them easier to compare at a glance. Shares the exact
  // same scoreBucket scheme as the other three rather than its own — Metacritic reads less
  // skewed in isolation (no games above 96 in the same sample), but a shared scheme is what lets
  // all four columns' group breakdowns be compared at a glance against each other, which is the
  // more useful property here than each column individually having the tightest-fitting buckets.
  scoreColumn('metacritic', 'Metacritic Score', fmt.num),
  // No compare override here — 0 reviews is a real, meaningful value (not "no data" standing in
  // for one), so the default numeric sort already treats it correctly, unlike the score/HLTB
  // columns above and below. `defaultSortDir: 'desc'` still applies though — the most-reviewed
  // (most talked-about) games are the more useful thing to see on a first click, same reasoning
  // as the score columns just without the missing-data wrinkle. `null` (a failed rating fetch,
  // not a confirmed 0) is still possible though, hence `withMissingGroup` on the grouping side —
  // see its own comment above for why that needs to be checked explicitly rather than left to
  // halfDecadeBucket's own `Number(null) === 0` coercion, which would otherwise silently fold a
  // failed fetch into the same group as a genuinely zero-review game.
  {
    key: 'reviewsTotal',
    label: 'Review Count',
    type: 'number',
    groupable: true,
    format: fmt.ct,
    defaultSortDir: 'desc',
    groupValue: withMissingGroup(halfDecadeBucket),
    groupFormat: formatMissingGroup(formatHalfDecadeBucket('', '0')),
    keepVisibleWhenGrouped: true,
    category: 'Scores & Reviews',
  },

  // ── How Long To Beat ────────────────────────────────────────────────────────
  // "All PlayStyles" listed first among the HLTB columns — same convention as the side panel,
  // which shows it leftmost precisely because it's a single representative number rather than
  // one specific playstyle (see the comment on `all` in lib/hltb.js). Keeping it first here too
  // means toggling on Main/+Extra/100% doesn't push it out of its default-visible position.
  // HLTB times are bounded to roughly 0-150h for the overwhelming majority (a handful of
  // open-world completionist runs into the 300-500h range, nothing like reviewsTotal's spread
  // into the millions) — a plain linear step stays meaningful across that whole range, unlike
  // that one, so a 10h `bucketNumericRange` is the right tool here rather than the log buckets
  // above. `null` (no HLTB match found) groups as "—".
  hltbColumn('hltbAll', 'HLTB (h)'),
  hltbColumn('hltbMain', 'Main (h)'),
  hltbColumn('hltbExtra', '+Extra (h)'),
  hltbColumn('hltbCompletionist', '100% (h)'),

  // ── Dates ───────────────────────────────────────────────────────────────────
  // Same year-bucketed grouping, using this column's own `parseDate` (endOfReleasePeriod) so a
  // fuzzy "Fall 2026"/bare-year release groups under the year it actually resolves to instead of
  // bucketDatePart's own default `new Date(value).getTime()`, which can't make sense of those
  // forms at all. `null` (no metadata) is the only missing case here: "Coming soon"/"TBA" parse to
  // NaN, which bucketDatePart keys by the string itself, so each keeps a group named after it.
  {
    key: 'releaseDate',
    label: 'Released',
    type: 'date',
    groupable: true,
    format: (v) => (typeof v === 'string' ? fmtReleaseDate(v) : fmt.str(v)),
    parseDate: endOfReleasePeriod,
    compare: compareDateMissingLast,
    render: renderReleaseDate,
    defaultSortDir: 'desc',
    defaultValueSort: { by: 'alpha', dir: 'desc' },
    ...datePartGroup('year', endOfReleasePeriod, '—'),
    keepVisibleWhenGrouped: true,
    category: 'Play Time & Dates',
  },

  // ── Classification ──────────────────────────────────────────────────────────
  {
    key: 'genres',
    label: 'Genres',
    groupable: true,
    format: fmt.arr,
    keepVisibleWhenGrouped: true,
    category: 'Classification',
  },
  // `defaultValueSort: { by: 'count', dir: 'desc' }` (new in 0.8.0) — Developer/Publisher/Tags/
  // Categories are all higher-cardinality than Genres (a small, well-known fixed list that reads
  // fine alphabetically), so their filter checklists open "most common first" instead of A→Z;
  // still just the starting point — `cycleValueSort`'s toggle still cycles through all 4 states
  // the same as before.
  {
    key: 'categories',
    label: 'Categories',
    groupable: true,
    format: fmt.arr,
    defaultValueSort: { by: 'count', dir: 'desc' },
    keepVisibleWhenGrouped: true,
    category: 'Classification',
  },
  {
    key: 'tags',
    label: 'Tags',
    groupable: true,
    format: fmt.arr,
    defaultValueSort: { by: 'count', dir: 'desc' },
    keepVisibleWhenGrouped: true,
    category: 'Classification',
  },
  {
    key: 'developers',
    label: 'Developers',
    groupable: true,
    format: fmt.arr,
    defaultValueSort: { by: 'count', dir: 'desc' },
    keepVisibleWhenGrouped: true,
    category: 'Classification',
  },
  {
    key: 'publishers',
    label: 'Publishers',
    groupable: true,
    format: fmt.arr,
    defaultValueSort: { by: 'count', dir: 'desc' },
    keepVisibleWhenGrouped: true,
    category: 'Classification',
  },
  // Parsed from Steam's `supported_languages` HTML string (see parseSupportedLanguages in
  // lib/steam.js) — same high-cardinality multi-value treatment as Tags/Developers/Publisher.
  {
    key: 'languages',
    label: 'Languages',
    groupable: true,
    format: fmt.arr,
    defaultValueSort: { by: 'count', dir: 'desc' },
    keepVisibleWhenGrouped: true,
    category: 'Classification',
  },
  // Steam's own content-type for this appid (see TYPE_LABELS above and the `type` comment in
  // lib/steam.js's extractAppDetails) — the overwhelming majority of rows are 'Game', but a
  // library/wishlist/bundle can genuinely contain soundtrack ('Soundtrack'), video, or DLC
  // entries too. Hidden by default for exactly that reason (almost every row would show the
  // same value), but groupable/filterable so a search can be narrowed to just base games, or
  // audited for stray non-game entries. `null` ("Unknown") only when store metadata itself
  // failed to load or Steam's response omitted the field.
  {
    key: 'type',
    label: 'Type',
    groupable: true,
    format: (v) => (v ? String(v) : 'Unknown'),
    category: 'Classification',
  },
  // Estimated, not authoritative — see computeProductionTier's doc comment (public/utils.js)
  // and docs/dev/decisions.md. The label spells out "(est.)" rather than relying on
  // a hover tooltip, since @vates/data-table-solid has no per-column header-tooltip option to
  // hang a caveat on. Hidden by default — a secondary number, not the primary thing most
  // searches here care about, and one that's explicitly a best-effort guess on top of that.
  {
    key: 'productionTier',
    label: 'Production Tier (est.)',
    groupable: true,
    format: fmt.str,
    compare: compareProductionTier,
    defaultSortDir: 'desc',
    category: 'Classification',
  },

  // ── Compatibility ───────────────────────────────────────────────────────────
  // Native OS support (`platforms` in lib/steam.js's extractAppDetails) — distinct from the
  // ProtonDB column right below, which is Linux/Deck compatibility *through Proton*, a
  // compatibility layer, not native support. Same multi-value groupable/filterable treatment as
  // Genres/Categories rather than three separate boolean columns.
  {
    key: 'platforms',
    label: 'Platforms',
    groupable: true,
    format: fmt.arr,
    keepVisibleWhenGrouped: true,
    category: 'Compatibility',
  },
  // Linux/Steam Deck compatibility tier from ProtonDB — sorted/grouped by actual compatibility
  // quality (see compareProtonTier above), not alphabetically; public/panel.js shows the same
  // data as a colored badge in the side panel. `defaultSortDir: 'desc'` shows the best-
  // compatibility games first on a fresh click, matching compareProtonTier's worst-to-best order.
  {
    key: 'protondb',
    label: 'ProtonDB',
    groupable: true,
    // A missing tier is named, so the filter and grouping tell no report from no answer instead of
    // listing one blank entry for both (the table library labels a missing scalar '').
    value: (row) =>
      row.protondb !== null
        ? row.protondb
        : row.failedSources?.includes('protondb')
          ? PROTON_DIDNT_ANSWER
          : PROTON_NO_REPORT,
    format: fmt.str,
    render: renderProtonBadge,
    compare: compareProtonTier,
    defaultSortDir: 'desc',
    category: 'Compatibility',
  },

  // ── Extras ──────────────────────────────────────────────────────────────────
  // Leads the section — "can I try this first" is relevant to any prospective player, unlike
  // Achievements/DLC Count right below, which only matter to completionists. `event.demo`
  // (top-level on the SSE/game-details response, not nested under `meta`) — the free demo's
  // appid if this game has one, from the same IStoreBrowseService item tags/demo share (see
  // extractDemoAppid in lib/steam.js); the side panel's own "🎮 Try the Free Demo" banner
  // (public/panel.js) reads the exact same field. Only a plain has-a-demo boolean here — the
  // demo's own appid isn't useful in a cell with nowhere to link it — outbound links stay in the
  // panel, not the table. Rendered as a badge (renderDemoBadge above) rather than plain
  // text/an emoji glyph, so it reads as a quick status chip at a glance, same treatment as
  // ProtonDB right above. `format` still returns plain text for non-visual consumers (filter
  // checklist labels, CSV export) that don't go through `render`. True/false is real data either
  // way (no separate "unknown" state), so no `compare`/missing-last handling is needed — plain
  // boolean comparison already puts demo games first with `defaultSortDir: 'desc'`.
  {
    key: 'hasDemo',
    label: 'Demo',
    groupable: true,
    format: (v) => (v === undefined ? '…' : v ? 'Demo' : '—'),
    render: renderDemoBadge,
    defaultSortDir: 'desc',
    category: 'Extras',
  },
  // Steam's own achievement count for the game (`achievements.total` on the appdetails
  // response — see `achievementCount` in lib/steam.js's extractAppDetails), not this
  // player's unlock progress — that's the side panel's own Achievements section
  // (public/panel.js), which needs a per-account fetch this column doesn't. 0 is real data
  // (the game genuinely has none); `null` (missing, sorted last by compareNumMissingLast)
  // only when store metadata itself failed to load. Hidden by default — a fairly niche
  // completionist-facing number compared to the rest of each page's own DEFAULT_VISIBLE.
  {
    key: 'achievementCount',
    label: 'Achievement Count',
    type: 'number',
    groupable: true,
    format: fmt.num,
    compare: compareNumMissingLast,
    defaultSortDir: 'desc',
    category: 'Extras',
  },
  // Length of `meta.dlc` (the bare DLC appid list every appdetails response already carries —
  // see the `dlc` comment in lib/steam.js's extractAppDetails) — computed server-side, already
  // on the row's `details.meta`. 0 is real data (base game has no DLC); `null` only when store
  // metadata itself failed to load.
  {
    key: 'dlcCount',
    label: 'DLC Count',
    type: 'number',
    groupable: true,
    format: fmt.num,
    compare: compareNumMissingLast,
    defaultSortDir: 'desc',
    category: 'Extras',
  },
]);

// ── Price columns (IsThereAnyDeal) — shared by Wishlist and Bundles only, not the Library tab
// (an owned game has nothing to buy). Each page inserts this cluster into CORE_COLUMNS right
// after its own identity/page-specific columns via `insertColumnsAfter`, and populates the
// fields these columns read (`bestDealPrice`/`bestDealCut`/`bestDealShop`/`lowAll`/`lowY1`/
// `lowM3`/`priceCurrency`) itself, via its own `loadPrices` — this file only
// defines how those fields render/sort/group, not how they're fetched. `panel.js`'s Price card
// reads the exact same fields, off whichever page put them on the row.
export const PRICE_COLUMNS: ColumnDef<Row>[] = markFailedSources([
  // Hidden by default on both pages — Best Deal and Discount already answer "is this worth
  // buying" without it; kept as its own column for anyone who wants the exact number, or to
  // sort/group by it. Named "Steam Full Price" rather than the shorter "Steam Price" specifically
  // to make clear it's the non-discounted list price, not whatever Steam happens to charge today.
  priceColumn('steamRegular', 'Steam Full Price'),
  // The cheapest *current* price across every shop ITAD tracks for this game (Steam included) —
  // the "where do I actually buy this for less, right now" answer, as opposed to Steam Full
  // Price (Steam's own non-discounted list price) or the historical lows below (what something
  // has sold for at some point, not necessarily today). `renderBestDeal` colors/badges the price
  // itself when it's at or below a historical low rather than showing the shop name in the cell
  // — the shop is still available as its own column (`bestDealShop`, hidden by default) for
  // anyone who wants to group/filter by "which shop currently has the best price".
  priceColumn('bestDealPrice', 'Best Deal', renderBestDeal),
  // How much cheaper the best deal is than Steam Full Price (`discountPct`, computed by each
  // ListRoute.tsx's loadPrices — see its own comment above for why this is
  // computed against Steam's price rather than taken from ITAD's own per-deal "cut" field).
  // Rendered with a leading "-" (`renderCut`) and "—" for a deal that isn't actually any cheaper
  // than Steam (`0`) — real data, not a missing value, but not worth a "-0%" reading either.
  // Bucketed in fixed 25-point steps (0-25%/25-50%/50-75%/75-100%) rather than PRICE_TIERS'
  // hand-picked breakpoints above — a percentage is already bounded 0-100 with no long tail to
  // worry about, so there's no reason to reach for anything fancier than an even step.
  {
    key: 'bestDealCut',
    label: 'Discount',
    type: 'number',
    groupable: true,
    format: fmt.num,
    render: renderCut,
    compare: compareNumMissingLast,
    defaultSortDir: 'desc',
    ...numericRangeGroup(25, '%', '—'),
    keepVisibleWhenGrouped: true,
    category: 'Pricing',
  },
  PRICE_STATUS_COLUMN,
  { key: 'bestDealShop', label: 'Best Deal Shop', groupable: true, format: fmt.str, category: 'Pricing' },
  // Hidden by default now that Best Deal's own color/badge already answers "is this a record
  // low" without a separate column for each of the three windows — kept, not removed outright,
  // since the exact number is still sometimes worth seeing (e.g. how far above the record low
  // the current deal actually is).
  priceColumn('lowAll', 'All-Time Low'),
  priceColumn('lowY1', '1-Year Low'),
  priceColumn('lowM3', '3-Month Low'),
]);
