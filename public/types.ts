import type { BundlePackage } from './bundleRows.ts';
import type { ProductionTier } from './utils.ts';

// Shared frontend types. A row/game object is assembled from several independent async sources
// (the game-details stream, price lookups, per-list fields), so most fields are optional — but
// every one of them is *declared*: this interface used to end in an `[key: string]: unknown`
// index signature, which made a typo'd field name compile as valid and turned every read of a
// real field into `unknown`. Optional means "not filled in yet"; unknown-to-the-type means
// "nobody checks", which is what that index signature actually bought.

export interface Rating {
  score: number;
  desc: string;
  positive: number;
  total: number;
}

export interface Hltb {
  id: number;
  main: number | null;
  extra: number | null;
  completionist: number | null;
  all: number | null;
}

export interface GameMeta {
  name: string | null;
  type: string | null;
  genres: string[];
  categories: string[];
  developers: string[];
  publishers: string[];
  description: string | null;
  releaseDate: string | null;
  comingSoon: boolean;
  metacritic: { score: number; url: string | null } | null;
  capsule: string;
  thumb: string | null; // the game tables' larger capsule; `capsule` is its fallback
  banner: string;
  // Both absent until loaded: the details stream leaves them out (an opened game fills them, ListRoute.tsx).
  // `name`: absent from details cached before it was kept.
  movies?: { id: number; name?: string | null; thumbnail: string; hls: string | null }[];
  screenshots?: { id: number; thumbnail: string; full: string }[];
  dlc: number[];
  fullgame: { appid: number; name: string | null } | null;
  website: string | null;
  achievementCount: number | null;
  platforms: string[]; // subset of ['Windows', 'Mac', 'Linux']
  languages: string[];
  isFree: boolean;
  priceInitial: number | null;
}

// The part of a game's store metadata Steam's store browse item also carries (server.js's fetchFastDetails), so a
// list row fills before its appdetails, which runs under Steam's store details cap.
export type GameBasics = Pick<
  GameMeta,
  'name' | 'type' | 'thumb' | 'description' | 'releaseDate' | 'comingSoon' | 'platforms' | 'developers' | 'publishers'
> & { capsule: string | null; banner: string | null };

export interface ProtonDb {
  // A human-readable tier word straight from ProtonDB's API ("borked"/"bronze"/.../"native"),
  // or a `provisionalTier` when `pending` is set (too few reports to be confident).
  tier: string;
  confidence: string | null;
  total: number | null;
  pending?: boolean;
}

export interface GameDetails {
  name: string | null; // the store's, else the achievement schema's (a delisted game)
  rating: Rating | null;
  hltb: Hltb | null;
  meta: GameMeta | null;
  basics?: GameBasics | null; // absent from a reply without a fast part
  tags: string[] | null;
  tagWeights?: Record<string, number | null> | null; // relative to the game's top tag, 0–1
  protondb: ProtonDb | null;
  demo: number | null; // the free demo's appid
}

// /api/game-details/:appid's reply: the details, their ages, and the sources that errored.
export interface GameDetailsReply extends GameDetails {
  fetchedAt?: number | null;
  fetchedAts?: DetailsAges | null;
  failed?: string[];
  limited?: string; // the server's message when this client's spent share left sources unfetched
}

// One game in a table/panel — the shared base every page's row extends. `appid` is a
// number on the wire (Steam's own APIs and every one of this app's server responses carry
// it as a JSON number; the server normalizes `req.params.appid` through `Number(...)`
// before it ever reaches a row), so a row's `g.appid` is a number and DOM `data-appid`
// attributes are compared against it via `Number(row.dataset.appid)`.
export interface Game extends PriceFields {
  appid: number;
  name: string;
  membership?: string; // group-by-membership lists: its group's key (membershipColumn.ts)
  loading: boolean;
  details: GameDetails | null;

  // ── The flattened projection of `details` the table reads ─────────────────────────────────
  // One field per sortable/filterable/groupable column (see gameColumns.ts's own `key`s, plus
  // each list kind's own columns in ListRoute.tsx) — `details` itself is nested, and the table
  // addresses a row by flat key. All written in one place, applyDetailsEvent (ListRoute.tsx), so
  // they're `undefined` until that row's details have streamed in; a source still in `pendingSources`
  // leaves its fields empty (or filled from `details.basics`) until its part arrives.
  // These used to be undeclared, covered by an `[key: string]: unknown` index signature on this
  // interface: that made every one of them an `unknown` read *and* made a typo'd write
  // (`row.hltbMian = …`) compile silently. Declaring them is what turns both into typecheck
  // failures — the same reason `ReadonlyGame` below exists for the read paths.
  capsule?: string | null;
  thumb?: string | null;
  score?: number | null;
  positivePct?: number | null;
  steamdbRating?: number | null;
  reviewsTotal?: number | null;
  hltbMain?: number | null;
  hltbExtra?: number | null;
  hltbCompletionist?: number | null;
  hltbAll?: number | null;
  metacritic?: number | null;
  releaseDate?: string | null;
  comingSoon?: boolean;
  genres?: string[];
  developers?: string[];
  publishers?: string[];
  categories?: string[];
  tags?: string[];
  platforms?: string[];
  languages?: string[];
  protondb?: string | null;
  protondbPending?: boolean;
  achievementCount?: number | null;
  dlcCount?: number | null;
  hasDemo?: boolean;
  type?: string | null;
  productionTier?: ProductionTier | null;

  // ── Per-list-kind fields, set when the row is built rather than by the details stream ──────
  // An owned list knows playtime, a wishlist knows rank/date-added, a bundle knows which tier
  // unlocks the game — each only exists on that kind's own rows, and only that kind inserts the
  // column that reads it (see ListRoute.tsx's OWNED_/WISHLIST_/BUNDLE_ column sets).
  playtime?: number;
  lastPlayed?: string;
  priority?: number;
  dateAdded?: string | null;
  tierPrice?: number | null;
  tierCurrency?: string | null;
  tierPriceMax?: number | null;
  bundlePackage?: BundlePackage | null;
  tierPerGame?: boolean; // tierPrice is a pick-and-mix bundle's per-game rate at the current selection
  addon?: boolean;
  rank?: number | null; // a ranked list's own rows only — null = not ranked yet / excluded
  lookedUp?: string | null; // Recently Looked Up's rows only — ISO time of the latest lookup

  // standalone-lookup flag (see gameSearch.ts) — true for a game opened from the
  // "look up any game" box that isn't one of the loaded rows
  standalone?: boolean;
  // Ownership status for whichever account is loaded, stamped onto every row by the host route
  // for the table's own ✓/☆ name-cell markers (see gameColumns.ts). `null` = "not resolved yet".
  // The side panel does NOT read these — it has its own `ownership` resource (panel.tsx), so a
  // standalone lookup that was never a row still gets a badge; both go through myOwnership.ts's
  // one cached pair of sets.
  inLibrary?: boolean | null;
  onWishlist?: boolean | null;
  // When the oldest of this game's cached details (rating/HLTB/store metadata/tags/ProtonDB) was
  // written server-side, epoch ms — null when they were fetched fresh, undefined before any
  // details have arrived. It's the figure the panel's ↻ shows.
  detailsFetchedAt?: number | null;
  // The same, per source, since they're cached separately under tiers of 90–180 days: the
  // aggregate above is only ever as new as the *oldest* of them, so on its own it says nothing
  // about a rating fetched yesterday behind a store page untouched since 2013. The panel's ↻
  // breaks it down in its tooltip (see server.js's fetchGameDetails).
  detailsFetchedAts?: DetailsAges | null;
  // Detail sources that errored on the last fetch (server.js's `failed`), as opposed to having no data.
  failedSources?: string[];
  // Detail sources whose stream part hasn't arrived yet (the store part trails the fast one).
  pendingSources?: string[];
  // Its screenshots and trailers didn't load (GET /api/game-meta failed): opening the game again retries.
  mediaFailed?: boolean;
}

// Keyed by source, epoch ms, null when that source was fetched fresh for the request that
// produced it (or has no cache entry of its own).
export interface DetailsAges {
  rating?: number | null;
  hltb?: number | null;
  meta?: number | null;
  tags?: number | null;
  protondb?: number | null;
}

// A row as everything outside its own store sees it: readable, not writable. The side panel, the
// table's column renderers and the panel-nav helpers all take this, so a `game.field = x` write
// outside the store that owns the row is a typecheck failure rather than a silent no-op — which
// is what it would be, since a row is a Solid store row (see rowStore.ts) and the whole app
// renders it per field. The only legitimate writers are `rowStore.mutateRow`'s `produce` draft
// (typed as plain `Game`) and whoever builds a row in the first place.
//
// Not deep: `Readonly` stops `g.details = …`, not `g.details.rating = …`. `details` is only ever
// replaced wholesale (see applyDetailsEvent in ListRoute.tsx), so the shallow version covers the
// writes that actually happen without a hand-rolled DeepReadonly over every nested type.
export type ReadonlyGame = Readonly<Game>;

// A single official news/announcement item (see extractNews in lib/steam.js).
export interface NewsItem {
  title: string;
  url: string;
  date: number; // unix seconds
  feedLabel: string | null;
}

// A single achievement on the server's GET /api/achievements response.
export interface Achievement {
  apiname: string;
  name: string | null;
  description: string | null;
  icon: string;
  icongray: string | null;
  achieved: number | boolean | null;
  unlocktime: number | null;
  globalPct: number | null;
  hidden: boolean | null;
}

// The full GET /api/achievements payload for one game. `_sortedAchievements` is cached
// client-side by panel.js (see achievementsHtml) on the first render after a fetch.
export interface Achievements {
  achievements: Achievement[];
  total: number;
  unlocked: number;
  private: boolean;
  playerCount: number;
  steamUrl: string | null;
  rarityFailed?: boolean; // Steam didn't answer for rarity: every globalPct is null
  _sortedAchievements?: Achievement[];
}

// One price in an IsThereAnyDeal response (a bundle tier, a deal, a historical low).
export interface PriceAmount {
  amount: number;
  currency: string;
}

// IsThereAnyDeal-backed price fields, set by priceLoading.ts's applyPriceInfo. Optional because
// `undefined` is a real, load-bearing state distinct from `null`: "nothing has looked this price
// up (yet)", which renders as a loading placeholder and is what nullMissingPriceFields keys off
// after a failed batch, versus "looked up, no data", which renders as "—".
export interface PriceFields {
  steamRegular?: number | null;
  bestDealPrice?: number | null;
  bestDealCut?: number | null;
  bestDealShop?: string | null;
  bestDealUrl?: string | null;
  lowAll?: number | null;
  lowY1?: number | null;
  lowM3?: number | null;
  priceCurrency?: string | null;
  pricesFailed?: boolean; // the last lookup errored: a missing price is "didn't answer", not "no data"
}

// ── List-centric redesign (see docs/dev/lists-and-accounts.md) ──────────────────────────────
// These back accountsStore.ts/listsStore.ts/combine.ts/listResolve.ts — see that doc for the
// full design rationale (why accounts are pinned explicitly rather than "whichever is
// current", why soft-delete/restore exists, why cycles are rejected at save time, etc.).

// A resolved account identity — "myAccount"/"currentAccount" are full objects of this shape
// (not just an id reference) so clearing recentAccounts can never orphan either of them.
export interface AccountSlot {
  id: string; // canonical: sorted-joined member steam64 ids (stable identity, incl. Family unions)
  members: string[]; // resolved steam64 ids, sorted
  rawInputs: string[]; // original typed identifiers (vanity name/URL/id), same order as entered
  label?: string; // last-known display name(s) ("PersonaName" or "A + B" for a Family) — cached
  // for instant recents rendering before a fresh fetch resolves
  avatarUrl?: string; // last-known avatar, same reason
  vanities?: Record<string, string>; // steam64 → that member's Steam custom-URL name, for the
  // members that set one — captured at resolve time so the
  // nicest copyable identifier needs no fetch of its own
  // (accountsStore.ts's accountIdentifiers)
  memberAvatars?: Record<string, string>; // a Family's steam64 → avatar, same reason as avatarUrl
  unresolved?: string[]; // members whose player summaries failed; never stored (accountsStore.ts's withStoredDisplay)
  removedAt?: number; // hidden from the recents UI (removed, or never picked), kept while a list references it
}

// A node in the user's list-organizing tree — flat arrays keyed by parentId, not a nested
// structure, so rename/move/reorder is a single-item mutation rather than a tree walk.
export interface Folder {
  id: string;
  name: string;
  parentId: string | null; // null = root
  order: number; // sibling order — shared numbering space with GameList at the same parentId
}

export type CombineOp = 'union' | 'intersect' | 'subtract' | 'group-by-membership';

// Points at any list-shaped data source a dynamic list can combine, or the tree can hold a
// shortcut to (not used for that yet — see the design doc's "tree scope" decision). Account-
// scoped refs always pin an explicit accountId, never "whichever account is current", so a
// saved "Alice ∩ Bob" comparison keeps meaning that regardless of what currentAccount becomes.
export interface ListRef {
  kind:
    'account-owned' | 'account-wishlist' | 'bundle' | 'recent-games' | 'user' | 'developer' | 'publisher' | 'game-pass';
  accountId?: string; // AccountSlot.id
  bundleId?: string;
  listId?: string; // → GameList.id
  name?: string; // kind 'developer'/'publisher': the exact name Steam's store search matches
}

// A user-created list — either a stored, directly-editable set of appids ('manual'), a
// stored formula recomputed live every time it's opened ('dynamic'), or one source ordered by
// one-vs-one answers ('ranked' — its progress lives in its own `ranking:<id>` pref key, see
// listsStore.ts's getRanking). Lives in the same
// Folder/GameList tree via parentId/order.
export interface GameList {
  id: string;
  // Optional for a dynamic/ranked list only: absent means "no name typed", and every surface labels it
  // from its own formula instead (listLabels.ts's listDisplayName), so the label follows a source
  // edit or an account rename instead of freezing at creation time.
  name?: string;
  parentId: string | null;
  order: number;
  createdAt: number;
  updatedAt: number;
  kind: 'manual' | 'dynamic' | 'ranked';
  appids?: number[]; // kind: 'manual'
  op?: CombineOp; // kind: 'dynamic'
  sources?: ListRef[]; // kind: 'dynamic'
  source?: ListRef; // kind: 'ranked'
  tableView?: object; // persisted per-list (not shared across lists), same shape tableViewPrefs.ts stores
  orphanOf?: { bundleId: string }; // listsStore.ts's orphanBundle: a bundle's last-known games
  deletedAt?: number; // soft-deleted — hidden from the tree/pickers, kept for dynamic-list
  // resolution + restore as long as something still references it
}

// A named table view of Owned or Wishlist (listViews.ts), for whichever account is current.
export interface SavedView {
  id: string;
  name: string;
  tableView: object; // tableViewPrefs.ts's shape, minus page/searchQuery
  template?: string; // the listViews.ts template it was created from
}
