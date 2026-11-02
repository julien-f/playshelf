// The generic list viewer — table + docked panel for a list, per docs/dev/frontend.md.
// Registered for /lists/owned, /lists/wishlist,
// /lists/bundle/:bundleId, the generic /lists/:listId, and /game/:appid? (see AppRoot.tsx) — the
// last of these is the "Recently Looked Up" system list's own address (kind 'recent' below),
// folding in what used to be a separate, mostly-empty GameRoute.tsx: `params.appid`, when given,
// is opened the same way a live in-route lookup is (see handleOpenGameRequest/
// openOrAddRecentGame below), not treated as a special standalone-only view.
//
// 'compare' (/lists/compare?u=alice&u=bob) is the odd one out: its list isn't stored anywhere,
// it's built in memory from the URL's own player slots — one `account-owned` source per slot, fed
// to the very same resolve/combine/label path a saved dynamic list uses. That's what makes the
// pre-redesign Comparison page's URLs keep working and its group-per-owner-set table come back
// (see docs/dev/lists-and-accounts.md's Combine section, and ComparePlayersForm.tsx for the entry
// point). "Save as a list" is then just createList() with the same formula.
//
// **Current scope**: every kind ('owned', 'wishlist', 'bundle', 'recent', 'user', 'compare') is
// wired up for real. It stays narrower than the design on a few axes though: ownership cross-referencing (in-library/on-wishlist badges — done
// in the side panel/gameSearch.ts's dropdown via myOwnership.ts, but not surfaced as its own
// table column here) and achievements are not ported yet (both need a second background fetch
// this first pass omits); 'recent'/'user' have no dedicated extra columns — plain CORE_COLUMNS,
// no owned/wishlist/bundle extras. A 'user' list resolves via listResolve.ts's
// resolveGameList/createDefaultFetchers; a manual list, or a dynamic one using any op other than
// group-by-membership, renders as one flat table (flattened via flattenCombineResult when
// needed, same as when it's resolved as someone *else's* combine source) — but
// group-by-membership is one table too, grouped by an "Owned by"/"In" column (membershipColumn.ts)
// — generalizing the old Comparison page's "one table per owner set, most owners to fewest"
// layout, with one view (sort, filters, columns, saved like any other) and row selection. A bundle's detail card (shop/dates/counts/tiers/note/outbound
// links) and its unresolved ("not on Steam") games — both listed here as unported for a while —
// are rendered now; the games table is still the point of this generic viewer, but a table holding
// only the games that resolved to a Steam listing was quietly passing itself off as the whole
// bundle.
//
// Row-selection-based add/remove-to-list: any kind's table can select rows (`selectable: true`
// on the single-table path) and add them to an existing manual list, or a brand-new one created
// on the spot — the one piece of `listsStore.ts`'s already-built manual-list CRUD
// (`addAppidsToList`/`removeAppidsFromList`, both thin wrappers over `setListAppids` built on
// `combine.ts`'s own `union`/`subtract`) that had no UI calling it until now. "Remove from this
// list" only shows when the list actually being viewed is itself a manual one (`kind === 'user'
// && userList.kind === 'manual'`) — removing from a dynamic list makes no sense, its contents
// are a computed formula, not a stored array.
//
// Ported from library.tsx's loadLibrary/loadWishlist/streamGameDetails/buildTable et al., but
// NOT a copy-paste: every mutable variable that used to be module-level there (table, rowsStore,
// loadGuard, total/loaded, …) is now local to this component's own closure, created fresh on
// each mount and torn down on unmount via onCleanup — library.tsx's page loads exactly once, but
// a router-driven route mounts/unmounts every time its path is navigated to/away from.
import {
  onMount,
  onCleanup,
  createSignal,
  createRoot,
  createEffect,
  createMemo,
  on,
  batch,
  untrack,
  For,
  Show,
  type JSX,
} from 'solid-js';
import { createStore, produce, unwrap } from 'solid-js/store';
import { render } from 'solid-js/web';
import { A, useParams, useLocation, useNavigate } from '@solidjs/router';
import { createTableState, DataTableView, datePartGroup } from '@vates/data-table-solid';
import { cascadeFirstRows, slideRowsOnViewChange } from './motion.ts';
import type { ColumnDef, SortEntry, TableState, TableViewState } from '@vates/data-table-solid';
import {
  commonGround,
  fitTo,
  suggestionsFor,
  type ComparedPlayer,
  playerFits,
  similarGames,
  tasteOf,
  topPlayedTags,
  TOP_TAGS,
  type PlayerFits,
  type Taste,
} from './tagTaste.ts';
import { loadTaste, saveTaste } from './tasteCache.ts';
import { archetypeOf, playStyle, storyGames, STYLE_SENTENCES, type ProfileGame } from './playerProfile.ts';
import { GameArt, OwnedProfile, PlayerAvatar, ProfileBadge } from './PlayerProfile.tsx';
import Gift from 'lucide-solid/icons/gift';
import Heart from 'lucide-solid/icons/heart';
import Users from 'lucide-solid/icons/users';
import {
  fmt,
  insertColumnsAfter,
  similarityColumn,
  tagMatchColumn,
  SIMILARITY_KEY,
  TAG_MATCH_KEY,
  CORE_COLUMNS,
  PRICE_COLUMNS,
  compareDateMissingLast,
  halfDecadeBucket,
  formatHalfDecadeBucket,
  priceTierGroup,
  compareNumMissingLast,
  OWNERSHIP_STATUS_COLUMN,
  PICK_OWNERSHIP_COLUMN,
  SOURCE_NAMES,
} from './gameColumns.ts';
import {
  ApiError,
  detailsFields,
  detailsPending,
  failedLookupFields,
  NO_DETAILS,
  FAST_DETAIL_SOURCES,
  STORE_DETAIL_SOURCES,
  fetchJson,
  fmtAge,
  fmtLastPlayed,
  focusGameRow,
  gameRowEl,
  formatMoney,
  hoursFromMinutes,
  oldestFetchedAt,
  scoreColor,
  fmtHours,
  fmtLocalDate,
  smoothScroll,
  refusalMessage,
} from './utils.ts';
import {
  shareTableView,
  resetTableView,
  bindViewPersistence,
  prefViewStore,
  layoutDraft,
  type LayoutDraft,
  type ViewStore,
} from './tableViewPrefs.ts';
import { renderPanelNav as renderPanelNavShared, stepGameList } from './panelNav.ts';
import { createRowStore } from './rowStore.ts';
import { createStaleGuard } from './staleGuard.ts';
import { createStreamBatcher } from './streamBatcher.ts';
import { bindNavPopover } from './navPopover.ts';
import { openLightbox, isLightboxOpen } from './lightbox.tsx';
import {
  panelOpen,
  panelClose,
  isPanelOpen,
  getPanelGame,
  pickRandomFrom,
  clearRandomQueue,
  clearAllRandomQueues,
  notifyOwnersChanged,
  openPanelFromRow,
} from './panel.tsx';
import {
  setPanelParam,
  withAccountParam,
  parseUrlState,
  normalizeSlots,
  compareUrl,
  DEFAULT_COMPARE_OP,
} from './urlState.ts';
import { SharedViewBanner } from './SharedViewBanner.tsx';
import { UnsavedChangesBanner, ViewActions } from './TableViewControls.tsx';
import {
  PLAY_NEXT_MAX_HOURS,
  VIEW_TEMPLATES,
  createFromTemplate,
  getListView,
  saveListViewTable,
  templateView,
} from './listViews.ts';
import { STATUS_LABELS, getStatus } from './gameStatuses.ts';
import { NewViewMenu, ViewTabs, viewHref } from './ViewTabs.tsx';
import { etaSeconds, formatEta, type LoadSample } from './loadProgress.ts';
import { convert, formatWithEstimate } from './currency.ts';
import {
  membershipColumn,
  membershipKey,
  withMembershipGrouping,
  withoutMembershipGrouping,
  MEMBERSHIP_KEY,
} from './membershipColumn.ts';
import {
  getEffectiveCurrentAccount,
  accountIdentifiers,
  accountDisplayLabel,
  getMyAccount,
  getAccountOverride,
  showingMyAccount,
  getCurrentAccount,
} from './accountsStore.ts';
import { getAccountOverrideState, accountOverrideStatusText } from './accountOverride.ts';
import { fetchAccountOverview, fetchAccountWishlist, resolveAccountSlot, type GameOwner } from './accountData.ts';
import { loadRecentGames, addRecentGame, renameRecentGame, MAX_RECENT_GAMES } from './recentGames.ts';
import {
  fetchBundleById,
  loadErrorText,
  resolveBundleGames,
  TIER_RANGE_TITLE,
  type ResolvedGame,
  type FlatGame,
} from './bundleData.ts';
import {
  activeTierPrice,
  atTier,
  bundlePricingModel,
  bundleTierSummary,
  bundleUrgency,
  filterTiers,
  fmtBundleDatePart,
  fmtBundleDateTime,
  shopHue,
  pickTiers,
  pickRate,
  cheapestPicks,
  pickPlanDetail,
  bundlePackages,
  wholePackages,
  savingsText,
  savingTier,
  tierGroupKey,
  tierGroupLabel,
  tierKeyPrice,
  type BundlePackage,
  type BundlePricingModel,
  type BundleTierSummary,
  type PickPlan,
  type PickTier,
} from './bundleRows.ts';
import { getBrowsedBundles } from './bundleBrowseStore.ts';
import { rememberBundle } from './bundleSnapshots.ts';
import { fanaticalBuyUrl, FANATICAL_BOOKMARKLET } from './fanaticalPicks.ts';
import {
  postPrices,
  applyPriceInfo,
  nullMissingPriceFields,
  PRICES_UNAVAILABLE,
  PRICES_FAILED,
} from './priceLoading.ts';
import { isItadConfigured, isItadOff } from './panelData.ts';
import { currentRegion, regionCurrency, regionLabel } from './region.ts';
import { openPrefsPopover } from './prefsPopover.tsx';
import { registerRouteHandlers } from './AppShell.tsx';
import { ListHero, refreshTileValue, type HeroTile } from './ListHero.tsx';
import { ComparePlayersForm } from './ComparePlayersForm.tsx';
import {
  describeSources,
  describeListRef,
  createDefaultNaming,
  listDisplayName,
  opLabel,
  OP_LABELS,
  OP_SYMBOLS,
  type RefDescription,
  type ListNaming,
} from './listLabels.ts';
import { encodeListFormula, decodeListFormula, shareListUrl, inMemoryDynamicList } from './listShare.ts';
import { copyWithFeedback } from './clipboard.ts';
import { setBaseTitle } from './pageTitle.ts';
import type { AccountSlot, GameDetailsReply, Game, GameList, GameMeta, CombineOp, ListRef } from './types.ts';
import { applyDetailsEvent, type DetailsEvent } from './detailsEvent.ts';
import {
  getList,
  getLists,
  getFolders,
  createList,
  updateDynamicList,
  updateRankedSource,
  addAppidsToList,
  removeAppidsFromList,
  setListTableView,
  getRanking,
  setRanking,
  listHasPriceSource,
  listHasRefreshableSource,
  listHasBundleSource,
  listHasGamePassSource,
  rankingsOf,
  isCombineOp,
  listDeps,
} from './listsStore.ts';
import { ranks, progress, pendingFocus, rerank, exclude, type RankingState, type RankingProgress } from './ranking.ts';
import {
  resolveListWithSources,
  flattenCombineResult,
  createDefaultFetchers,
  type ListResolveFetchers,
  type ResolvedSource,
} from './listResolve.ts';
import { CombineForm, sourceOptions, refKey, type SourceOption } from './CombineForm.tsx';
import type { MembershipGroup } from './combine.ts';
import { peekMyOwnership, trackMyOwnership } from './myOwnership.ts';
import { creatorTitle, fetchCreatorGames, steamSearchUrl, type CreatorRole } from './creatorData.ts';
import { fetchGamePass, GAME_PASS_PATH, GAME_PASS_TITLE, xboxStoreUrl, type GamePassData } from './gamePassData.ts';
import ArrowLeft from 'lucide-solid/icons/arrow-left';
import Check from 'lucide-solid/icons/check';
import ChevronDown from 'lucide-solid/icons/chevron-down';
import ChevronLeft from 'lucide-solid/icons/chevron-left';
import ChevronRight from 'lucide-solid/icons/chevron-right';
import Dices from 'lucide-solid/icons/dices';
import Folder from 'lucide-solid/icons/folder';
import Link from 'lucide-solid/icons/link';
import Plus from 'lucide-solid/icons/plus';
import TriangleAlert from 'lucide-solid/icons/triangle-alert';
import Trophy from 'lucide-solid/icons/trophy';

type ListKind = 'owned' | 'wishlist' | 'bundle' | 'recent' | 'user' | 'compare' | 'shared' | 'creator' | 'game-pass';

// /game (bare) and /game/:appid both live here, kind 'recent' either way — see this file's own
// header comment and AppRoot.tsx.
function kindFromPath(pathname: string, params: { bundleId?: string; listId?: string; appid?: string }): ListKind {
  if (pathname === '/lists/owned') return 'owned';
  if (pathname === '/lists/wishlist') return 'wishlist';
  if (pathname === '/lists/compare') return 'compare';
  if (pathname === '/lists/shared') return 'shared';
  if (pathname === '/lists/developer' || pathname === '/lists/publisher') return 'creator';
  if (pathname === GAME_PASS_PATH) return 'game-pass';
  if (params.bundleId) return 'bundle';
  if (pathname === '/game' || pathname.startsWith('/game/')) return 'recent';
  return 'user';
}

// ── Columns — ported verbatim from library.tsx's own (see its comments for the full reasoning
// behind each column's grouping/format/category choices) ──────────────────────────────────────

const PLAYTIME_COLUMN: ColumnDef<Record<string, any>> = {
  key: 'playtime',
  label: 'Played (h)',
  type: 'number',
  groupable: true,
  format: (v) => ((v as number) > 0 ? Number(v).toFixed(1) : '—'),
  rangePresets: [{ label: 'never played', max: 0 }],
  defaultSortDir: 'desc',
  groupValue: halfDecadeBucket,
  groupFormat: formatHalfDecadeBucket('h', 'Not played'),
  keepVisibleWhenGrouped: true,
  category: 'Play Time & Dates',
};

// A comparison's per-player Played columns. Keyed by position, not account, so a comparison's
// saved layout fits the next one compared.
const playedByKey = (i: number) => `playtime:${i}`;
function playedByColumn(
  player: { label: string; owners: Map<number, GameOwner[]> },
  i: number,
): ColumnDef<Record<string, any>> {
  return {
    ...PLAYTIME_COLUMN,
    key: playedByKey(i),
    label: `Played (h) · ${player.label}`,
    // Summed over a Family's members, like myOwnership.ts's own Played; null: this player doesn't own it.
    value: (row) => {
      const owners = player.owners.get(row.appid);
      return owners ? hoursFromMinutes(owners.reduce((sum, o) => sum + o.minutes, 0)) : null;
    },
  };
}

// A player's hours in Steam's last two weeks, as of their library's copy (none once that's older too).
const recentPlayedByKey = (i: number) => `recentPlaytime:${i}`;
const recentMinutes = (owners: GameOwner[] | undefined) => owners?.reduce((sum, o) => sum + o.recentMinutes, 0);
function recentPlayedByColumn(
  player: { label: string; owners: Map<number, GameOwner[]> },
  i: number,
): ColumnDef<Record<string, any>> {
  return {
    key: recentPlayedByKey(i),
    label: `Last 2 weeks (h) · ${player.label}`,
    type: 'number',
    value: (row) => {
      const minutes = recentMinutes(player.owners.get(row.appid));
      return minutes == null ? null : hoursFromMinutes(minutes);
    },
    format: (v) => ((v as number) > 0 ? Number(v).toFixed(1) : '—'),
    compare: compareNumMissingLast,
    defaultSortDir: 'desc',
    category: 'Play Time & Dates',
  };
}

const fmtPercent = (v: unknown) => (v == null ? '—' : `${v}%`);

const TASTE_FIT_KEY = 'tasteFit';
const PLAY_NEXT = 'play-next'; // listViews.ts's template id
// What Taste fit is scored against; said in the list status (tasteFitNote), not only on hover.
interface TasteSource {
  label: string | null; // null: no current account
  taste: Taste | null; // null: its Owned list not opened on this device yet
  linked: boolean; // someone else's account from a `?u=` link, whose Owned the viewer has no reason to open
}

function tasteFitNote({ label, taste, linked }: TasteSource): string | null {
  if (!label) return 'Taste fit needs an account: pick one on Home';
  if (!taste) return linked ? null : `Taste fit needs ${label}'s Owned list opened on this device`;
  if (!taste.profile) return `Taste fit: ${label} has too few games played`;
  return `Taste fit: ${label}'s taste as of ${fmtLocalDate(new Date(taste.at))}`;
}

// How close a game is to the current account's taste.
function tasteFitColumn(source: () => TasteSource | null): ColumnDef<Record<string, any>> {
  const taste = () => source()?.taste;
  return {
    key: TASTE_FIT_KEY,
    label: 'Taste fit',
    type: 'number',
    value: (row) => {
      const t = taste();
      return t ? fitTo(t, row) : null;
    },
    format: fmtPercent,
    compare: compareNumMissingLast,
    defaultSortDir: 'desc',
    searchable: false,
    category: 'Classification',
  };
}

const GROUP_FIT_KEY = 'groupFit';
// How well a game suits the comparison's least suited player, by each one's play profile.
function groupFitColumn(fits: () => PlayerFits | null, labels: string[]): ColumnDef<Record<string, any>> {
  const scores = (appid: number) => fits()?.byGame.get(appid) ?? null;
  const least = (appid: number) => {
    let found: { score: number; label: string } | null = null;
    for (const [i, score] of (scores(appid) ?? []).entries())
      if (score != null && (!found || score < found.score)) found = { score, label: labels[i] };
    return found;
  };
  return {
    key: GROUP_FIT_KEY,
    label: 'Group fit',
    type: 'number',
    align: 'start', // its cells read as text
    value: (row) => least(row.appid)?.score ?? null,
    format: fmtPercent,
    // Names the least suited player; the title has everyone's score.
    render: (_v, row) => {
      const cell = document.createElement('span');
      const l = least(row.appid);
      cell.textContent = l ? `${l.score}% · ${l.label}` : '—';
      const s = scores(row.appid);
      if (s)
        cell.title = s
          .map((x, i) => (x == null ? `${labels[i]}: too few games played to tell` : `${labels[i]} ${x}%`))
          .join(' · ');
      return cell;
    },
    compare: compareNumMissingLast,
    defaultSortDir: 'desc',
    searchable: false,
    category: 'Classification',
  };
}

const LAST_PLAYED_COLUMN: ColumnDef<Record<string, any>> = {
  key: 'lastPlayed',
  label: 'Last Played',
  type: 'date',
  groupable: true,
  format: fmt.str,
  compare: compareDateMissingLast,
  defaultSortDir: 'desc',
  defaultValueSort: { by: 'alpha', dir: 'desc' },
  ...datePartGroup('year', undefined, '—'),
  keepVisibleWhenGrouped: true,
  category: 'Play Time & Dates',
};

// The viewer's own status (gameStatuses.ts), on their own account's games only; its label is the
// value, which Play next's exclusion filter matches.
const STATUS_COLUMN: ColumnDef<Record<string, any>> = {
  key: 'status',
  label: 'Status',
  groupable: true,
  value: (row) => {
    const status = showingMyAccount() ? getStatus(row.appid) : null;
    return status && STATUS_LABELS[status];
  },
  format: fmt.str,
  keepVisibleWhenGrouped: true,
  category: 'Play Time & Dates',
};

const WISHLIST_RANK_COLUMN: ColumnDef<Record<string, any>> = {
  key: 'priority',
  label: 'Wishlist Rank',
  type: 'number',
  groupable: false,
  format: fmt.num,
};

const WISHLIST_DATE_ADDED_COLUMN: ColumnDef<Record<string, any>> = {
  key: 'dateAdded',
  label: 'Added',
  type: 'date',
  groupable: true,
  format: fmt.str,
  compare: compareDateMissingLast,
  defaultSortDir: 'desc',
  defaultValueSort: { by: 'alpha', dir: 'desc' },
  ...datePartGroup('year', undefined, '—'),
  keepVisibleWhenGrouped: true,
  category: 'Play Time & Dates',
};

const OWNED_COLUMNS = insertColumnsAfter(
  CORE_COLUMNS,
  'hltbCompletionist',
  PLAYTIME_COLUMN,
  LAST_PLAYED_COLUMN,
  STATUS_COLUMN,
);
const OWNED_DEFAULT_VISIBLE = ['capsule', 'name', 'steamdbRating', 'hltbAll', 'releaseDate', 'genres', 'playtime'];

// 'recent' (the "Recently Looked Up" system list) is CORE_COLUMNS plus OWNERSHIP_STATUS_COLUMN
// (gameColumns.ts) — a recent lookup isn't necessarily owned or wishlisted (that's exactly the
// point of the column), so none of owned's Played/Last Played or wishlist's price cluster apply
// here. Hidden by default (not in RECENT_DEFAULT_VISIBLE below) — CORE_COLUMNS' own Name column
// already renders the same status inline (color + a ✓/☆ badge, see gameColumns.ts's
// renderNameCell), so this dedicated column is there for sort/group/filter, not a default-visible
// restatement of what the Name column right next to it already shows.
const RECENT_COLUMNS = insertColumnsAfter(CORE_COLUMNS, 'name', OWNERSHIP_STATUS_COLUMN);
const RECENT_DEFAULT_VISIBLE = ['capsule', 'name', 'steamdbRating', 'hltbAll', 'releaseDate', 'genres'];
// Recently Looked Up's own order: stored newest first (recentGames.ts), with no timestamps.
const LOOKED_UP_COLUMN: ColumnDef<Record<string, any>> = {
  key: 'lookedUp',
  label: 'Looked up',
  type: 'number',
  align: 'start', // its cells read as text
  groupable: false,
  filterable: false,
  format: (v) => (v == null ? '—' : v === 1 ? 'Latest' : `#${v}`),
  compare: compareNumMissingLast,
  defaultSortDir: 'asc',
};
const LOOKED_UP_COLUMNS = insertColumnsAfter(RECENT_COLUMNS, 'capsule', LOOKED_UP_COLUMN);
const LOOKED_UP_DEFAULT_VISIBLE = ['lookedUp', ...RECENT_DEFAULT_VISIBLE];
const LOOKED_UP_DEFAULT_SORT: SortEntry[] = [{ key: 'lookedUp', dir: 'asc' }];
// A user list also gets the current account's Played/Last Played (stamped from myOwnership.ts,
// the same fetch as the ✓/☆ markers) — hidden by default, there to filter/sort on.
const USER_COLUMNS = insertColumnsAfter(
  RECENT_COLUMNS,
  'hltbCompletionist',
  PLAYTIME_COLUMN,
  LAST_PLAYED_COLUMN,
  STATUS_COLUMN,
);

const WISHLIST_COLUMNS = insertColumnsAfter(
  insertColumnsAfter(insertColumnsAfter(CORE_COLUMNS, 'name', WISHLIST_RANK_COLUMN), 'priority', ...PRICE_COLUMNS),
  'releaseDate',
  WISHLIST_DATE_ADDED_COLUMN,
);
const WISHLIST_DEFAULT_VISIBLE = [
  'capsule',
  'name',
  'dateAdded',
  'steamdbRating',
  TASTE_FIT_KEY,
  'hltbAll',
  'releaseDate',
  'genres',
  'hasDemo',
  'bestDealPrice',
  'bestDealCut',
];

function renderAddonBadge(v: unknown): Node {
  if (v === undefined) return document.createTextNode('…');
  const span = document.createElement('span');
  span.className = 'status-badge status-badge-neutral';
  span.textContent = v ? 'Add-on' : 'Base';
  return span;
}

// A `null` tier price means "no single fixed price" (in practice, a pick-and-mix "Build Your
// Own" tier), not free — an actual free/pay-what-you-want tier is a real `{amount: 0}`.
function renderTierPrice(v: unknown, row: Record<string, any>): Node {
  const price =
    v === undefined
      ? '…'
      : v == null
        ? 'Varies'
        : v === 0
          ? 'Free'
          : row.tierPriceMax != null
            ? `${formatMoney(Number(v), row.tierCurrency)}–${formatWithEstimate(row.tierPriceMax, row.tierCurrency, regionCurrency())}`
            : formatWithEstimate(Number(v), row.tierCurrency, regionCurrency(), row.tierPerGame ? '/game' : '');
  const pkg: BundlePackage | null | undefined = row.bundlePackage;
  // A package-mate's pick is its lead row's, so only the lead carries the per-game rate.
  const included = pkg && row.tierPerGame && !pkg.lead;
  const title = [included && `Included in the ${pkg.title} pick`, row.tierPriceMax != null && TIER_RANGE_TITLE].filter(
    Boolean,
  );
  if (!title.length) return document.createTextNode(price);
  const span = document.createElement('span');
  span.title = title.join('. ');
  span.textContent = included ? 'included' : price;
  return span;
}

const TIER_PRICE_COLUMN: ColumnDef<Record<string, any>> = {
  key: 'tierPrice',
  label: 'Tier Price',
  type: 'number',
  groupable: true,
  format: (v) => (v == null ? 'Varies' : v === 0 ? 'Free' : Number(v).toFixed(2)),
  render: renderTierPrice,
  compare: compareNumMissingLast,
  defaultSortDir: 'asc',
  ...priceTierGroup((row) => row.tierCurrency, 'Varies'),
  keepVisibleWhenGrouped: true,
  category: 'Pricing',
};
// The hero tile naming how a bundle prices its games.
const BUNDLE_MODEL_LABELS: Record<BundlePricingModel, string> = {
  tiered: 'Tiers',
  fixed: 'Price',
  pick: 'Pick & mix',
};
// A bundle's games' Tier Price fields by appid; with `picks`, pick-and-mix starts at the entry rate (see the effect by pickPlan).
function bundleTierFields(
  resolved: ResolvedGame[],
  picks: PickTier[],
): Map<number, Pick<Game, 'tierPrice' | 'tierCurrency' | 'tierPerGame' | 'tierPriceMax' | 'bundlePackage' | 'addon'>> {
  const entryRate = pickRate(picks, 0);
  const packages = bundlePackages(resolved);
  return new Map(
    resolved.map((g) => [
      g.appid,
      {
        tierPrice: g.tierPrice ?? (entryRate ? entryRate.amount : null),
        tierCurrency: g.tierPrice == null && entryRate ? entryRate.currency : g.tierCurrency,
        tierPerGame: g.tierPrice == null && !!entryRate,
        tierPriceMax: g.tierPriceMax,
        bundlePackage: packages.get(g.appid) ?? null,
        addon: g.addon,
      },
    ]),
  );
}
const ADDON_COLUMN: ColumnDef<Record<string, any>> = {
  key: 'addon',
  label: 'Add-on',
  groupable: true,
  format: (v) => (v ? 'Add-on' : 'Base'),
  render: renderAddonBadge,
  category: 'Classification',
};

// OWNERSHIP_STATUS_COLUMN hidden by default here too, same reasoning as RECENT_DEFAULT_VISIBLE
// above — the Name column right next to it already shows the same status inline.
const BUNDLE_COLUMNS = insertColumnsAfter(
  insertColumnsAfter(CORE_COLUMNS, 'name', OWNERSHIP_STATUS_COLUMN, TIER_PRICE_COLUMN, ADDON_COLUMN),
  'addon',
  ...PRICE_COLUMNS,
);
const BUNDLE_DEFAULT_VISIBLE = [
  'capsule',
  'name',
  'tierPrice',
  'bestDealPrice',
  'bestDealCut',
  'steamdbRating',
  TASTE_FIT_KEY,
  'hltbAll',
  'releaseDate',
  'genres',
];
const BUNDLE_DEFAULT_SORT: SortEntry[] = [
  { key: 'tierPrice', dir: 'asc' },
  { key: 'steamdbRating', dir: 'desc' },
];
// A pick-and-mix bundle: one rate for every game (in the hero and the selection bar), so no Per pick
// column; grouped by what to pick first.
const PICK_BUNDLE_COLUMNS = BUNDLE_COLUMNS.map((c) =>
  c.key === 'ownershipStatus' ? PICK_OWNERSHIP_COLUMN : c.key === 'tierPrice' ? { ...c, label: 'Per pick' } : c,
);
// A tiered or fixed-price bundle: grouped by its exact tiers, each header saying what the tier costs over
// the one below (static, from the bundle), its price then left out of the rows.
function bundleColumns(
  meta: { tiers: BundleTierSummary[]; model: BundlePricingModel },
  games: readonly ResolvedGame[],
): ColumnDef<Record<string, any>>[] {
  const rangeMax = new Map(
    games.flatMap((g) =>
      !g.addon && g.tierPrice != null && g.tierPriceMax != null ? [[g.tierPrice, g.tierPriceMax]] : [],
    ),
  );
  const target = regionCurrency();
  // Keyed so an add-on sorts after the base tiers and a pressed tier's `<= price` range leaves it out.
  const column: ColumnDef<Record<string, any>> = {
    ...TIER_PRICE_COLUMN,
    value: (row) => (row.tierPrice == null ? null : tierGroupKey(row)),
    format: (v) => TIER_PRICE_COLUMN.format!(v == null ? v : tierKeyPrice(Number(v)).price),
    render: (_v, row) => renderTierPrice(row.tierPrice, row),
    groupValue: (_v, row) => tierGroupKey(row),
    groupFormat: (key) => tierGroupLabel(Number(key), meta.tiers, meta.model, rangeMax, target),
    keepVisibleWhenGrouped: false,
  };
  return BUNDLE_COLUMNS.map((c) => (c.key === 'tierPrice' ? column : c));
}
const PICK_BUNDLE_DEFAULT_VISIBLE = BUNDLE_DEFAULT_VISIBLE.filter((key) => key !== 'tierPrice');
const PICK_BUNDLE_DEFAULT_SORT: SortEntry[] = [
  { key: 'ownershipStatus', dir: 'asc' },
  { key: 'steamdbRating', dir: 'desc' },
];

// A ranked list's own order (ranking.ts) — unranked/excluded games have no rank and sort last.
const RANK_COLUMN: ColumnDef<Record<string, any>> = {
  key: 'rank',
  label: 'Rank',
  type: 'number',
  groupable: false,
  format: fmt.num,
  compare: compareNumMissingLast,
  defaultSortDir: 'asc',
};
const RANKED_COLUMNS = insertColumnsAfter(USER_COLUMNS, 'capsule', RANK_COLUMN);
const RANKED_DEFAULT_VISIBLE = ['rank', ...RECENT_DEFAULT_VISIBLE];
// A user list built from a wishlist or a bundle keeps the price columns of its source.
const USER_PRICED_COLUMNS = insertColumnsAfter(USER_COLUMNS, 'ownershipStatus', ...PRICE_COLUMNS);
const USER_TIERED_COLUMNS = insertColumnsAfter(USER_COLUMNS, 'ownershipStatus', TIER_PRICE_COLUMN, ...PRICE_COLUMNS);
const RANKED_PRICED_COLUMNS = insertColumnsAfter(RANKED_COLUMNS, 'ownershipStatus', ...PRICE_COLUMNS);
const PRICED_DEFAULT_VISIBLE = ['bestDealPrice', 'bestDealCut'];
// A shared formula with a bundle source ("What does this add?") keeps that bundle's Tier Price too.
const SHARED_PRICED_COLUMNS = insertColumnsAfter(RECENT_COLUMNS, 'ownershipStatus', ...PRICE_COLUMNS);
const SHARED_TIERED_COLUMNS = insertColumnsAfter(
  RECENT_COLUMNS,
  'ownershipStatus',
  TIER_PRICE_COLUMN,
  ...PRICE_COLUMNS,
);
const PRICE_KEYS = new Set(PRICE_COLUMNS.map((c) => c.key));
const WISHLIST_NOPRICE_COLUMNS = WISHLIST_COLUMNS.filter((c) => !PRICE_KEYS.has(c.key));
const RANKED_DEFAULT_SORT: SortEntry[] = [{ key: 'rank', dir: 'asc' }];

const DEFAULT_SORT: SortEntry[] = [{ key: 'steamdbRating', dir: 'desc' }];
const MAX_PRICE_LOOKUP_GAMES = 500; // mirrors the server's own cap — see loadPrices below

const PLAYS_MOSTLY_SHOWN = 6;
const PLAYER_TAGS_SHOWN = 3;
const LATELY_SHOWN = 3; // a Players card's Playing lately games

// A score column leads the sort while its source is set; unset, it goes, with its row-hiding range.
function syncLeadColumn(t: TableState<Game>, key: string, active: boolean): void {
  const sorted = t.sort.entries().some((e) => e.key === key);
  const shown = t.columns.visible().has(key);
  if (active) {
    if (!sorted) {
      const first = t.sort.entries()[0]?.key;
      t.sort.appendOrToggle(key);
      if (first) t.sort.move(key, first);
    }
    if (!shown) t.columns.toggleVisibility(key);
  } else {
    if (sorted) t.sort.remove(key);
    if (shown) t.columns.toggleVisibility(key);
    if (t.filter.ranges()[key]) t.filter.clearColumn(key, 'range');
  }
}

export default function ListRoute() {
  const params = useParams();
  const routerLocation = useLocation();
  const navigate = useNavigate();
  const kind = kindFromPath(routerLocation.pathname, params);

  let tableContainer!: HTMLDivElement;
  // Each compared player's label and owned games, in `compareAccounts` order (also the panel's Owned by, see getOwners).
  let comparePlayers: {
    id: string;
    label: string;
    avatarUrl?: string; // a Family's: its first member's
    family: boolean;
    owners: Map<number, GameOwner[]>;
  }[] = [];
  const [statusText, setStatusText] = createSignal('');
  const [priceStatusText, setPriceStatusText] = createSignal('');
  // The details stream's `{ limited }` message: this client spent its share, said once for the load.
  const [detailsLimited, setDetailsLimited] = createSignal('');
  // kind === 'bundle' only: the currently open bundle's Steam-resolved games, kept at component
  // scope (not load()-local) so the Prices tile's own refresh can re-price exactly what's loaded without
  // re-resolving the bundle. Reset by load() itself on every (re)load.
  let resolvedBundleGames: ResolvedGame[] | null = null;
  let tieredLoaded: boolean | undefined; // the last finished load's rows carry a Tier Price; undefined mid-load
  // Owned/wishlist kinds only: how old the server's cached copy of this account's list is (epoch
  // ms, null = fetched fresh), and whether a forced re-fetch is in flight — the hero's Updated
  // tile, which is also the control that forces one (see heroTiles). Steam data is cached server-side for weeks (default.env's
  // LIBRARY_CACHE_TTL_MINUTES), so the age of what's on screen is stated rather than guessed at,
  // and forcing past it is one click from the list itself instead of only from Home.
  // `undefined` = this list has no server-cached data age to state at all (nothing loaded yet,
  // a manual list, the recent list) — which is not the same as `null`, "fetched fresh just now".
  const [fetchedAt, setFetchedAt] = createSignal<number | null | undefined>(undefined);
  // A comparison/dynamic list is built from several account fetches, each with its own age.
  // A refresh keeps the previous age on screen until its first fetch replaces it.
  let replaceFetchedAt = false;
  function noteFetchedAt(at: number | null): void {
    const replace = replaceFetchedAt;
    replaceFetchedAt = false;
    setFetchedAt((prev) => oldestFetchedAt(replace ? undefined : prev, at));
  }
  const [refreshing, setRefreshing] = createSignal(false);
  // The Prices tile's own refresh (wishlist/bundle kinds). Deliberately one control
  // for the whole list rather than per-game: pricing is fetched as a single batched ITAD call
  // anyway, so per-row refreshing would add friction with no matching benefit. Re-prices whatever
  // is currently loaded — no re-resolution and no re-streaming of ratings/HLTB/tags.
  const [refreshingPrices, setRefreshingPrices] = createSignal(false);
  // Which region's prices are on screen. Read-only here on purpose — the ⚙ Preferences popover
  // is the one place it's changed (a second control would be a second thing to keep in sync);
  // this just says which one is in effect, since the currency alone doesn't identify it.
  const regionCode = createMemo(currentRegion);
  // Oldest price write time seen across this load's price calls (a wishlist chunks into several).
  // `undefined` = nothing loaded yet, which renders no readout at all rather than a premature "just now".
  const [priceFetchedAt, setPriceFetchedAt] = createSignal<number | undefined>(undefined);
  function notePriceFetchedAt(at: number | null): void {
    setPriceFetchedAt((prev) => oldestFetchedAt(prev, at));
  }
  async function handleRefreshPrices(): Promise<void> {
    setRefreshingPrices(true);
    setPriceFetchedAt(undefined);
    try {
      const targets = priceTargets();
      if (targets) await loadPrices(targets, loadGuard.current(), true);
    } finally {
      setRefreshingPrices(false);
    }
  }
  // A bundle's games are priced by their resolved ITAD gid, a priced list's rows by appid.
  function priceTargets(): readonly { appid: number; gid?: string }[] | null {
    return resolvedBundleGames ?? (hasPrices() ? rowsStore : null);
  }

  async function handleRefreshList(): Promise<void> {
    setRefreshing(true);
    try {
      await load({ refresh: true });
    } finally {
      setRefreshing(false);
    }
  }
  // The list's own name — the hero card's <h1> (see ListHero.tsx) *and* the document title, set
  // through one function since they were always the same string; before the card existed, only
  // <title> ever received it, so a loaded list said its own name nowhere on screen. Empty means
  // nothing has been named yet (a load that failed before resolving one — a deleted user list,
  // an account-less Owned route), which renders no card at all rather than an unnamed one.
  const [heroTitle, setHeroTitle] = createSignal('');
  function setListTitle(title: string): void {
    setHeroTitle(title);
    setBaseTitle(title);
  }
  // Owned/wishlist kinds only — whose account is on screen, for the hero's account chip. Read off
  // the AccountSlot's own cached label/avatar (accountsStore.ts) rather than the fetch: a wishlist
  // response carries no player data at all, so anything richer (presence, the 🔒 Private badge
  // Home's account card shows) would be available on one of these two kinds and not the other.
  const [heroAccount, setHeroAccount] = createSignal<AccountSlot | null>(null);
  // Said where the table would be, for a list that loaded and has no games.
  const [emptyText, setEmptyText] = createSignal('');
  // kind === 'bundle' only, alongside bundleTitle above — ITAD's own page for this bundle
  // (`details`) and the real shop/affiliate purchase link exactly as ITAD returned it (`url`,
  // never rewritten or stripped of tracking params — see docs/dev/integrations.md on why), and the
  // gid -> Fanatical name map "Buy on Fanatical" needs (pick-and-mix bundles only).
  const [bundleLinks, setBundleLinks] = createSignal<{
    details: string | null;
    url: string | null;
    fanaticalNames: Record<string, string> | null;
  }>({
    details: null,
    url: null,
    fanaticalNames: null,
  });
  // kind === 'bundle' only — everything else the bundle response already carries, for the detail
  // card below the header. All of it rides on the one fetch the route already makes; none of it
  // costs a request. `itadCount` is ITAD's own game count for the bundle, which is NOT the same as
  // the table's row count (see unresolvedGames below), so the card shows both rather than letting
  // the smaller number pass itself off as the whole bundle.
  const [bundleMeta, setBundleMeta] = createSignal<{
    shop: string | null;
    publish: string | null;
    expiry: string | null;
    note: string | null;
    itadCount: number | null;
    tiers: BundleTierSummary[];
    model: BundlePricingModel;
    picks: PickTier[]; // Fanatical pick-and-mix tiers, when known
  } | null>(null);
  // The bundle's games that have no Steam listing at all (a course, an asset pack, a shop-exclusive
  // key). resolveBundleGames has always returned these; this route used to drop them on the floor,
  // so a 13-game bundle could render as a 3-row table with nothing saying where the rest went.
  const [unresolvedGames, setUnresolvedGames] = createSignal<FlatGame[]>([]);
  const [unresolvedOpen, setUnresolvedOpen] = createSignal(false);
  // The "not on Steam" list under the table: a bundle's, or PC Game Pass's (titled when Microsoft's catalog answered).
  const offSteamGames = (): { title: string; href: string; type?: string | null }[] =>
    kind === 'game-pass'
      ? (gamePass()?.notOnSteam ?? []).map((g) => ({ title: g.title ?? g.id, href: xboxStoreUrl(g.id) }))
      : kind === 'bundle'
        ? unresolvedGames().map((g) => ({
            title: g.title,
            href: `https://isthereanydeal.com/game/${g.slug}/info/`,
            type: g.type,
          }))
        : [];
  // How many of the bundle's games made it into the table. `total` (the plain counter updateStatus
  // reads) is the same number, but it isn't reactive — the hero card's Games tile needs a signal.
  const [bundleResolvedCount, setBundleResolvedCount] = createSignal(0);
  // The bundle's games whose Steam lookup errored: neither in the table nor "not on Steam".
  const [bundleFailedCount, setBundleFailedCount] = createSignal(0);

  const [rowsStore, setRowsStore] = createStore<Game[]>([]);
  // The rows once every one's details are in, unwrapped (updateStatus): what's computed from them reads
  // ~10× faster than through store proxies, and later row writes (prices, a panel ↻) don't redo it.
  const [loadedRows, setLoadedRows] = createSignal<Game[] | null>(null);
  // "HowLongToBeat didn't answer for 6 games", per source: a hidden column's failure still shows.
  const failedSummary = createMemo(() => {
    // Refused for this client, not unanswered: one message, not a count per source.
    if (detailsLimited()) return detailsLimited();
    const counts = new Map<string, number>();
    for (const row of rowsStore) for (const s of row.failedSources ?? []) counts.set(s, (counts.get(s) ?? 0) + 1);
    // Sources that failed for the same number of games share one phrase.
    const byCount = new Map<number, string[]>();
    for (const s of Object.keys(SOURCE_NAMES)) {
      const n = counts.get(s);
      if (n) byCount.set(n, [...(byCount.get(n) ?? []), SOURCE_NAMES[s]]);
    }
    const parts = [...byCount].map(([n, names]) => {
      const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
      return `${who} didn't answer for ${n} game${n === 1 ? '' : 's'}`;
    });
    return parts.length ? `${parts.join(' · ')} — Refresh details in a game's panel retries` : '';
  });
  const rowStore = createRowStore<Game>(rowsStore, (idx, updater) => setRowsStore(idx, updater));
  // Games opened as a standalone aside rather than as one of this list's own rows (a nav-bar
  // lookup, or a DLC/base-game hop out of the open panel — see openStandaloneInPlace). Their data
  // arrives asynchronously and the panel renders it per field, so they need to live in a store
  // just as much as a table row does: a plain `game.details = data` write would reach nothing.
  // Keyed by appid rather than an array — nothing lists or orders these, they're only ever looked
  // up by the one appid being opened.
  const [standaloneRows, setStandaloneRows] = createStore<Record<number, Game>>({});
  const loadGuard = createStaleGuard();
  let table: TableState<Game> | null = null;
  let disposeTable: (() => void) | null = null;
  let unsyncView: (() => void) | null = null;
  let tableGrouped = false;
  // Every view applied goes through this, so a grouped table stays grouped and a flat one flat.
  function applyView(view: object): void {
    if (!table) return;
    table.setViewState(view);
    const applied = table.getViewState();
    const adjusted = tableGrouped ? withMembershipGrouping(applied) : withoutMembershipGrouping(applied);
    if (adjusted !== applied) table.setViewState(adjusted);
  }
  const viewTable = { setViewState: applyView, getViewState: () => table?.getViewState() ?? {} };
  // The table whose tag filter the Tag match column scores against; a signal so it re-sorts.
  const [filterTable, setFilterTable] = createSignal<TableState<Game> | null>(null);
  // The game the Similarity column ranks the list against (the panel's Sort list by similarity).
  const [similarTo, setSimilarTo] = createSignal<number | null>(null);
  const similarityScores = createMemo(() => {
    const appid = similarTo();
    if (appid == null) return null;
    const rows = loadedRows() ?? tableData();
    const target = rows.find((r) => r.appid === appid);
    if (!target) return null;
    const scores = new Map(similarGames(target, rows, Infinity).map((s) => [s.game.appid, s.score]));
    scores.set(target.appid, 100);
    for (const r of rows) if (!scores.has(r.appid) && r.details?.tagWeights) scores.set(r.appid, 0);
    return scores;
  });
  // Set only for kind === 'user' — its own per-list tableView, not a shared pref key. A signal
  // (not a plain variable, unlike most of this component's other imperative state) specifically
  // because the selection toolbar's JSX reads it reactively: /lists/:listId is one route
  // *definition* shared across every list id (see the createEffect at the bottom of this file),
  // so navigating between two user lists reuses this component instance without a remount —
  // a plain `let` wouldn't tell the already-mounted JSX that "the list being viewed" changed.
  const [userList, setUserList] = createSignal<GameList | null>(null);
  // kind === 'user', dynamic lists only — one entry per source in the list's own `sources[]`
  // order: how it reads (describeSources), how many appids it contributed, and its combine.ts key
  // (which is how a group-by-membership group's own keys map back to a readable name). Backs the
  // hero's formula line and the per-group table headings; empty until the resolve lands, which is
  // what keeps a half-built "A ∪ = 0" off the screen in the meantime.
  // `leftOut`: a bundle source's games with no Steam listing, which no list can hold.
  // `capped`: a developer/publisher source holding only Steam's first page of results.
  const [listSources, setListSources] = createSignal<
    { key: string; count: number; desc: RefDescription; leftOut?: number; capped?: number }[]
  >([]);
  // kind === 'user', ranked lists only — its resolved source and stored ranking, backing the Rank
  // column, the Ranked tile and the Re-rank/Exclude row actions.
  const [rankedSource, setRankedSource] = createSignal<Set<number> | null>(null);
  const [ranking, setRankingState] = createSignal<RankingState | null>(null);
  function rankingProgress(): RankingProgress | null {
    const source = rankedSource();
    const state = ranking();
    return source && state ? progress(state, source) : null;
  }
  // The games last chosen for comparing, while some are still to be placed — what Compare resumes.
  function chosenProgress(): RankingProgress | null {
    const source = rankedSource();
    const state = ranking();
    const focus = source && state ? pendingFocus(state, source) : undefined;
    return focus ? progress(state!, source!, { focus }) : null;
  }
  // Rewrites the Rank column in place rather than reloading — nothing else about the rows changed.
  function applyRanking(state: RankingState): void {
    const list = userList();
    const source = rankedSource();
    if (!list || !source) return;
    setRanking(list.id, state);
    setRankingState(state);
    const rankOf = ranks(state, source);
    batch(() => {
      for (const row of rowsStore)
        rowStore.mutateRow(row.appid, (draft) => {
          draft.rank = rankOf.get(row.appid) ?? null;
        });
    });
  }
  const [editingRankedSource, setEditingRankedSource] = createSignal(false);
  function rankedSourceOptions(): SourceOption[] {
    const list = userList();
    return sourceOptions(list?.id, list?.source ? [list.source] : []);
  }
  function handleChangeRankedSource(key: string): void {
    const list = userList();
    const option = rankedSourceOptions().find((o) => o.key === key);
    if (!list || !option) return;
    try {
      updateRankedSource(list.id, option.ref);
    } catch (err) {
      setStatusText((err as Error).message);
      return;
    }
    void load();
  }
  // What "Rank this list" ranks — null where there's nothing stable to point at (an unsaved
  // comparison/shared link, or a ranked list itself).
  function rankSourceRef(): ListRef | null {
    if (kind === 'owned' || kind === 'wishlist') {
      const account = heroAccount();
      return account ? { kind: kind === 'owned' ? 'account-owned' : 'account-wishlist', accountId: account.id } : null;
    }
    if (kind === 'bundle') return params.bundleId ? { kind: 'bundle', bundleId: params.bundleId } : null;
    if (kind === 'game-pass') return { kind: 'game-pass' };
    const list = userList();
    return list && list.kind !== 'ranked' ? { kind: 'user', listId: list.id } : null;
  }
  // The rows a filter left visible; null when no filter hides any.
  function filteredRows(): Game[] | null {
    if (!tableReady() || !table) return null; // `table` isn't a signal; tableReady() is
    const visible = table.processedData();
    return visible.length < table.data().length ? visible : null;
  }
  // What "Rank this list" asks about first: the selection, else the filtered rows (null = all, [] = the filter hides every row).
  function rankThisListFocus(): number[] | null {
    const selected = selectedRows();
    if (selected.length) return selected.map((r) => r.appid);
    return filteredRows()?.map((r) => r.appid) ?? null;
  }
  function rankThisListLabel(): string {
    const focus = rankThisListFocus();
    if (!focus) return 'Rank this list';
    if (!focus.length) return 'Rank (none shown)';
    return `Rank ${focus.length} game${focus.length === 1 ? '' : 's'}`;
  }
  // Ranking compares games two at a time, so what it ranks needs 2 of them; none shown is disabled outright.
  function rankTooFew(): boolean {
    const focus = rankThisListFocus();
    if (focus) return focus.length === 1;
    return tableReady() && !!table && table.data().length < 2;
  }
  // `criterion` names a further ranking of the same list ("best JRPG"); the first one keeps the default name.
  function handleRankThisList(criterion = ''): void {
    const source = rankSourceRef();
    if (!source || rankTooFew() || rankThisListFocus()?.length === 0) return;
    const name = criterion.trim()
      ? `Ranking of ${describeListRef(source, createDefaultNaming()).label} (${criterion.trim()})`
      : undefined;
    openRanking(createList({ kind: 'ranked', source, name }).id);
  }
  function openRanking(listId: string): void {
    const rankOrder = (table?.processedData() ?? []).map((r) => r.appid);
    navigate(`/lists/${listId}/rank`, { state: { rankFocus: rankThisListFocus() ?? undefined, rankOrder } });
  }
  // Read when the menu renders; a ranking made here navigates away, so nothing goes stale on screen.
  function existingRankings(): GameList[] {
    const source = rankSourceRef();
    return source ? rankingsOf(source) : [];
  }
  function rankingProgressText(list: GameList): JSX.Element {
    const p = progress(getRanking(list.id), new Set(rowsStore.map((r) => r.appid)));
    const total = p.ranked + p.excluded + p.pending;
    return p.pending ? (
      `${p.ranked} of ${total} ranked`
    ) : (
      <>
        {p.ranked} ranked <Check />
      </>
    );
  }
  function RankMenu(): JSX.Element {
    let trigger!: HTMLButtonElement;
    let panel!: HTMLDivElement;
    let criterion!: HTMLInputElement;
    onMount(() => onCleanup(bindNavPopover(trigger, panel)));
    return (
      <div class={`rank-menu${kind === 'bundle' ? ' hero-secondary' : ''}`}>
        <button ref={trigger} type="button" class="btn" popovertarget="rank-menu-panel">
          <Trophy /> {rankThisListLabel()} <ChevronDown />
        </button>
        <div ref={panel} id="rank-menu-panel" class="site-nav-popover-panel rank-menu-panel" popover>
          <h2 class="rank-menu-heading">Continue</h2>
          <For each={existingRankings()}>
            {(list) => (
              <button
                type="button"
                class="rank-menu-item"
                disabled={rankThisListFocus()?.length === 0}
                onClick={() => openRanking(list.id)}
              >
                <span>{listDisplayName(list, createDefaultNaming())}</span>
                <small>{rankingProgressText(list)}</small>
              </button>
            )}
          </For>
          <form
            class="rank-menu-new"
            onSubmit={(e) => {
              e.preventDefault();
              handleRankThisList(criterion.value);
            }}
          >
            <input
              ref={criterion}
              type="text"
              aria-label="What are you ranking by?"
              placeholder="Ranked by… (optional)"
            />
            <button
              type="submit"
              class="btn btn-primary"
              disabled={rankThisListFocus()?.length === 0}
              aria-disabled={rankTooFew() ? 'true' : undefined}
              aria-describedby={rankTooFew() ? 'rank-reason' : undefined}
            >
              <Plus /> New ranking
            </button>
            <Show when={rankTooFew()}>
              <span id="rank-reason" class="rank-reason">
                Ranking needs at least 2 games
              </span>
            </Show>
          </form>
        </div>
      </div>
    );
  }
  function handleRerankSelected(): void {
    const list = userList();
    const state = ranking();
    if (!list || !state) return;
    const focus = selectedRows().map((r) => r.appid);
    applyRanking(focus.reduce((s, appid) => rerank(s, appid), state));
    table?.selection.clear();
    navigate(`/lists/${list.id}/rank`, { state: { rankFocus: focus, rankOrder: focus } });
  }
  // Those of `rows` neither ranked nor excluded yet.
  function unrankedOf(rows: readonly Game[]): number[] {
    const excluded = new Set(ranking()?.excluded ?? []);
    return rows.filter((r) => r.rank == null && !excluded.has(r.appid)).map((r) => r.appid);
  }
  // The selected games still to be ranked — what "Compare selected" asks about.
  function selectedUnranked(): number[] {
    return unrankedOf(selectedRows());
  }
  // The unranked games in the table's current sort (filters included — what's left out is asked
  // after, in source order), so whatever the user sorted first gets ranked first.
  function unrankedInTableOrder(): number[] {
    return (table?.processedData() ?? []).filter((r) => r.rank == null).map((r) => r.appid);
  }
  // Handed over as history state rather than in the URL, which a few hundred appids would bloat;
  // it survives a reload of the compare screen and is gone once it's navigated away from.
  // The shown games still to be ranked when a filter hides some — what "Compare" then asks about.
  function filteredUnranked(): number[] | null {
    const visible = filteredRows();
    return visible && unrankedOf(visible);
  }
  function compareLabel(): string {
    const focus = filteredUnranked();
    if (focus) return focus.length ? `Rank ${focus.length} shown` : 'All shown ranked';
    const chosen = chosenProgress();
    if (chosen) return `Continue: ${chosen.pending} chosen left`;
    // Not "Compare": the nav's Compare means comparing libraries.
    return rankingProgress()?.pending === 0 ? 'All ranked' : 'Continue ranking';
  }
  function handleCompare(): void {
    const list = userList();
    const focus = filteredUnranked();
    if (!list || focus?.length === 0) return;
    navigate(`/lists/${list.id}/rank`, { state: { rankFocus: focus ?? undefined, rankOrder: unrankedInTableOrder() } });
  }
  function handleCompareSelected(): void {
    const list = userList();
    const focus = selectedUnranked();
    if (!list || !focus.length) return;
    navigate(`/lists/${list.id}/rank`, { state: { rankFocus: focus, rankOrder: unrankedInTableOrder() } });
  }
  function handleExcludeSelected(): void {
    const state = ranking();
    if (!state) return;
    const rows = selectedRows();
    applyRanking(rows.reduce((s, row) => exclude(s, row.appid), state));
    showSelectionStatus(`Excluded ${rows.length} game${rows.length === 1 ? '' : 's'} from the ranking.`);
    table?.selection.clear();
  }
  // ── kind === 'shared' ─────────────────────────────────────────────────────────────────────
  // /lists/shared?f=<formula> — another dynamic list's formula, decoded straight from the URL
  // (listShare.ts), same "unsaved dynamic list, built in memory" idea `compare` below already
  // uses. It's parked in the same `compareList` signal (below) rather than a sibling one: both
  // are "the unsaved dynamic list currently on screen", and everything reading combineList()
  // already treats them identically. What listShare.ts's decode step inlined as synthetic
  // GameLists (any `user` source in the shared formula) is kept only long enough to resolve/name
  // them and to reconstruct real saved lists on "Save as a list" — see sharedFetchers/
  // sharedNaming/handleSaveShared below.
  const [sharedSynthetic, setSharedSynthetic] = createSignal<Map<string, GameList>>(new Map());
  // The formula's bundle sources as last fetched, for a link back to each.
  const [sharedBundles, setSharedBundles] = createSignal<{ id: string; title: string }[]>([]);
  // A memo, so the load effect re-runs on a new formula only — not on Back dropping `?game=`
  // (overlayHistory.ts), which changes the rest of the query string.
  const sharedFormulaParam = createMemo(() => new URLSearchParams(routerLocation.search).get('f'));

  // ── kind === 'creator' ────────────────────────────────────────────────────────────────────
  // The name rides in ?name=, not the path: the SPA fallback 404s on a path like "indie.io".
  const creatorRole = (): CreatorRole => (routerLocation.pathname === '/lists/publisher' ? 'publisher' : 'developer');
  const creatorName = createMemo(() => (new URLSearchParams(routerLocation.search).get('name') ?? '').trim());
  const [creatorResult, setCreatorResult] = createSignal<{ total: number; capped: boolean } | null>(null);
  // kind === 'game-pass': the last catalog read, for its note, its games not on Steam and its failures.
  const [gamePass, setGamePass] = createSignal<GamePassData | null>(null);
  const sharedGetList = (id: string): GameList | undefined => sharedSynthetic().get(id) ?? getList(id);
  function sharedFetchers(base: ListResolveFetchers): ListResolveFetchers {
    return { ...base, getList: sharedGetList };
  }
  function sharedNaming(): ListNaming {
    const base = createDefaultNaming();
    return {
      ...base,
      list: (id) => {
        const synth = sharedSynthetic().get(id);
        // Same "(unnamed nested formula)" parenthesizing createDefaultNaming applies to a real
        // stored list nested one level deep — a synthetic group is always unnamed, so it always
        // takes this form rather than ever reading as a plain name.
        return synth ? { name: `(${listDisplayName(synth, sharedNaming())})`, deleted: false } : base.list(id);
      },
    };
  }
  // Turns a decoded formula's synthetic GameLists into real saved ones, bottom-up: each `g:`
  // group has to become a real listId before the list depending on it can be saved with a
  // `{ kind: 'user', listId }` source pointing at it — same reason handleSaveComparison saves in
  // one call, just generalized from one flat op to a tree.
  function handleSaveShared(): void {
    const list = compareList();
    if (!list) return;
    const synthetic = sharedSynthetic();
    const resolved = new Map<string, string>(); // synthetic id → real saved id
    function saveRef(ref: ListRef): ListRef {
      if (ref.kind !== 'user' || !ref.listId) return ref;
      const already = resolved.get(ref.listId);
      if (already) return { kind: 'user', listId: already };
      const group = synthetic.get(ref.listId);
      if (!group) return ref; // not one of ours to reconstruct — leave as-is
      const saved = createList({ kind: 'dynamic', op: group.op, sources: (group.sources ?? []).map(saveRef) });
      resolved.set(ref.listId, saved.id);
      return { kind: 'user', listId: saved.id };
    }
    const saved = createList({ kind: 'dynamic', op: list.op, sources: (list.sources ?? []).map(saveRef) });
    openSavedList(saved.id);
  }
  // ── kind === 'compare' ────────────────────────────────────────────────────────────────────
  // A comparison is a dynamic list that was never saved: the `?u=` slots ARE its formula (one
  // `account-owned` source per player), so it resolves, groups and explains itself through the
  // very same listResolve.ts/combine.ts/listLabels.ts path a stored dynamic list does — this
  // route just builds the GameList in memory instead of reading it from listsStore.ts. Kept in
  // its own signal rather than in `userList` above, which every store-backed behavior keys off
  // (per-list view persistence, "remove from this list", the Folder/Edited tiles): a list with no
  // id has no business reaching any of them.
  const [compareList, setCompareList] = createSignal<GameList | null>(null);
  let editSourcesBtn: HTMLButtonElement | undefined;
  const [compareAccounts, setCompareAccounts] = createSignal<AccountSlot[]>([]);
  const [editingPlayers, setEditingPlayers] = createSignal(false);
  // Players the last comparison couldn't resolve, with why — the rest still compare (U14).
  const [compareFailures, setCompareFailures] = createSignal<{ identifiers: string[]; message: string }[]>([]);
  function compareOthers(): void {
    const failed = new Set(compareFailures().map((f) => f.identifiers.join(',')));
    navigate(
      compareUrl(
        compareSlots().filter((slot) => !failed.has(slot.join(','))),
        compareOp(),
      ),
    );
  }
  // kind === 'user', dynamic lists only — the hero's "Edit sources" action reopens the same
  // combine form used at creation, pre-filled from the list's own op/sources.
  const [editingSources, setEditingSources] = createSignal(false);
  function handleUpdateDynamicList(input: { op: CombineOp; sources: ListRef[] }): void {
    const list = userList();
    if (!list) return;
    updateDynamicList(list.id, input.op, input.sources);
    void load();
  }
  // kind === 'user', dynamic lists only — "Share list" encodes this list's own formula (inlining
  // any `user` source, recursively — see listShare.ts) into a /lists/shared link and copies it.
  // `null` while sharing would work (mirrors encodeListFormula's own ok/fail result, computed live
  // off userList() rather than cached) so the button can disable itself with a reason instead of
  // failing silently on click — the same "why this source can't be shown as an ordinary one"
  // spirit describeListRef's own `problem` field already follows.
  function shareFailure(): string | null {
    const list = userList();
    if (!list || list.kind !== 'dynamic') return 'not a dynamic list';
    const result = encodeListFormula(list, getList);
    if (result.ok) return null;
    if (result.reason === 'manual-source') return "can't share — includes a manual list as one of its sources";
    if (result.reason === 'ranked-source') return "can't share — includes a ranked list as one of its sources";
    if (result.reason === 'empty') return "can't share — this list has no sources";
    return "can't share — its sources are too deeply/cyclically nested";
  }
  function handleShareList(btn: HTMLElement): void {
    const list = userList();
    if (!list) return;
    const result = encodeListFormula(list, getList);
    if (!result.ok) return; // heroActions disables the button in this case — see shareFailure
    copyWithFeedback(btn, `${window.location.origin}${shareListUrl(result.formula)}`);
  }
  // Whichever of the two is on screen — everything that reads a *formula* (the op chip, the
  // sources/groups tiles, the hero's formula line) applies identically to both.
  const combineList = (): GameList | null => userList() ?? compareList();
  // The comparison currently in the URL. Read reactively (not captured), so editing the players
  // re-runs the load effect below without a remount.
  const compareSlots = (): string[][] => normalizeSlots(parseUrlState(routerLocation.search).slots);
  // Gates the hero's Edit players, and with it whether a comparison has anything for its ⋯ to fold.
  const canEditPlayers = (): boolean => compareSlots().length >= 2;
  function compareOp(): CombineOp {
    const raw = new URLSearchParams(routerLocation.search).get('op');
    return raw && isCombineOp(raw) ? raw : DEFAULT_COMPARE_OP;
  }
  // The comparison a load has already done, in both spellings of it — see load()'s own guard.
  let loadedCompareKeys = new Set<string>();
  function compareKey(op = compareOp(), slots = compareSlots()): string {
    return `${op}|${slots.map((slot) => slot.join(',')).join('|')}`;
  }
  // Names this comparison's own accounts in the formula/group headings. They're resolved from the
  // URL, so they're typically in no store at all — createDefaultNaming would fall back to naming
  // them by raw steam64 id.
  // Named as its page was ("Alice vs. Bob"): the formula's own label reads differently.
  function handleSaveComparison(): void {
    const list = compareList();
    if (!list) return;
    const saved = createList({ kind: 'dynamic', name: heroTitle() || undefined, op: list.op, sources: list.sources });
    openSavedList(saved.id);
  }
  // The Save button is gone on the saved list's page: focus would otherwise drop to <body>.
  function openSavedList(id: string): void {
    navigate(`/lists/${id}`);
    document.querySelector<HTMLElement>('main')?.focus();
  }

  function compareNaming(): ListNaming {
    const base = createDefaultNaming();
    return {
      ...base,
      account: (id) => {
        const match = compareAccounts().find((a) => a.id === id);
        return match ? { label: accountDisplayLabel(match), identifiers: match.members } : base.account(id);
      },
    };
  }
  // True once load() has built the table, false while loading. Gates the "🔗 Share view"/"Default
  // view" toolbar's own <Show> rather than leaving it visible-but-broken against a `table` that
  // doesn't exist yet.
  const [tableReady, setTableReady] = createSignal(false);
  // How many membership groups a group-by-membership list has (0 for every other kind/op).
  const [groupCount, setGroupCount] = createSignal(0);

  // ── Row-selection-based add/remove-to-list (see this file's own header comment) ────────────
  const [selectedRows, setSelectedRows] = createSignal<Game[]>([]);
  const [manualLists, setManualLists] = createSignal<GameList[]>(getLists().filter((l) => l.kind === 'manual'));
  const NEW_LIST_OPTION = '__new__';
  const [addTarget, setAddTarget] = createSignal('');
  const [newListName, setNewListName] = createSignal('');
  const [selectionActionStatus, setSelectionActionStatus] = createSignal<{ text: string; listId?: string } | null>(
    null,
  );
  let selectionStatusTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(selectionStatusTimer));
  // A floating toast rather than a line in the page: the rows acted on are often scrolled far below it.
  function showSelectionStatus(text: string, listId?: string): void {
    setSelectionActionStatus({ text, listId });
    resumeSelectionStatus();
  }
  // Held while pointed at or focused, so its Open list link can't vanish mid-reach.
  function holdSelectionStatus(): void {
    clearTimeout(selectionStatusTimer);
  }
  function resumeSelectionStatus(): void {
    clearTimeout(selectionStatusTimer);
    selectionStatusTimer = setTimeout(() => setSelectionActionStatus(null), 6000);
  }

  function refreshManualLists(): void {
    setManualLists(getLists().filter((l) => l.kind === 'manual'));
  }

  async function handleAddSelectedToList(): Promise<void> {
    const target = addTarget();
    const rows = selectedRows();
    if (!target || rows.length === 0) return;
    const appids = rows.map((r) => r.appid);
    if (target === NEW_LIST_OPTION) {
      const name = newListName().trim();
      if (!name) return;
      const list = createList({ name, kind: 'manual', appids });
      refreshManualLists();
      showSelectionStatus(
        `Added ${appids.length} game${appids.length === 1 ? '' : 's'} to new list "${list.name}".`,
        list.id,
      );
    } else {
      const list = getList(target);
      addAppidsToList(target, appids);
      showSelectionStatus(
        `Added ${appids.length} game${appids.length === 1 ? '' : 's'} to "${list?.name ?? 'list'}".`,
        target,
      );
    }
    setAddTarget('');
    setNewListName('');
    const main = document.querySelector<HTMLElement>('main');
    // One the user can see, so focusing it doesn't scroll back to the first one added.
    const focusTo =
      appids.find((appid) => {
        const rect = gameRowEl(main, appid)?.getBoundingClientRect();
        return rect && rect.bottom > 0 && rect.top < window.innerHeight;
      }) ?? appids[0];
    table?.selection.clear();
    // Clearing the selection unmounts the bar that held focus: back to a row it added, not the
    // toast's Open list, which would hold the toast up for as long as it kept focus.
    if (!focusGameRow(main, focusTo)) main?.focus();
  }

  // Only ever called while viewing a manual list (`kind === 'user' && userList().kind ===
  // 'manual'` — see the JSX below), so `userList()` is always set here. Re-resolves the whole
  // route afterward (`load()`) rather than just splicing the removed rows out of `rowsStore`
  // directly — this is a genuine re-fetch-worthy state change (the list's own stored contents
  // changed), and `load()` already correctly handles every other piece of teardown/rebuild this
  // needs (table/rowsStore/stream), so re-deriving it by hand here would just be a second,
  // easier-to-drift-out-of-sync copy of that same logic. The status message is set *after*
  // `load()` resolves, not before — `load()`'s own reset (`setSelectionActionStatus(null)`, same
  // as `setSelectedRows([])`, right at its top) runs synchronously the moment it's called and
  // would otherwise wipe out this exact message in the same tick it was set, before Solid ever
  // gets a chance to render it (confirmed live: the message never appeared until this was fixed).
  async function handleRemoveSelectedFromList(): Promise<void> {
    const list = userList();
    const rows = selectedRows();
    if (!list || rows.length === 0) return;
    const appids = rows.map((r) => r.appid);
    removeAppidsFromList(list.id, appids);
    await load();
    showSelectionStatus(`Removed ${appids.length} game${appids.length === 1 ? '' : 's'} from "${list.name}".`);
  }
  let total = 0;
  let loaded = 0; // games with both stream parts in
  // Games with each part in: the store part trails, under Steam's store details cap.
  const answered = { fast: 0, store: 0 };
  let loadSamples: LoadSample[] = [];
  let samplePart: 'fast' | 'store' = 'fast';
  // Owned/Wishlist with no account at all: the status links to Home, and there's no "Games 0".
  const [needsAccount, setNeedsAccount] = createSignal(false);
  let slowLoad = false;
  // 0–1 while a list's game details stream in, null otherwise — the status line's progress bar.
  const [loadFraction, setLoadFraction] = createSignal<number | null>(null);
  // Set by a load or a stream; cleared once loadedRows is scheduled, so a later empty flush retakes nothing.
  let loadedRowsDue = false;
  let loadedRowsTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(loadedRowsTimer));
  // kind === 'recent' only: the one row addRecentGame should persist once its data streams in —
  // set by openOrAddRecentGame right before kicking off that row's own stream call, cleared once
  // the matching event lands (see the detailBatcher below). Every *other* 'recent' row (already
  // in the persisted list before this mount) deliberately does NOT get re-persisted just because
  // its rating/HLTB/etc. happened to stream in again — that would bump its recency/order on
  // every visit to /game, not only when it's the one actually just looked up.
  let pendingRecentFocus: number | null = null;
  // kind === 'recent' only: whether load()'s full rebuild (below) has already run once for this
  // mount. /game/:appid? is one route *definition* shared across every appid (see the
  // createEffect at the bottom of this file), so navigating from /game/440 to /game/620 re-runs
  // load() without remounting the component — without this flag, that would re-fetch and
  // re-stream the *entire* recents list from scratch just to focus one more game already sitting
  // right there in rowsStore. Only 'recent' needs this: every other kind's own path/query
  // segment that can change without a remount (bundleId, listId) genuinely does warrant a full
  // reload (a different bundle/list is different data), unlike a same-list appid focus change.
  let hasLoadedOnce = false;
  // Guards a standalone-in-place lookup (openStandaloneInPlace) the same way GameRoute.tsx's own
  // `currentToken` used to — a slower earlier lookup resolving after a faster later one started
  // must not clobber it.
  let standaloneLookupToken = 0;

  const isListed = (r: Game): boolean => !r.loading;
  function tableData(): Game[] {
    return rowsStore.filter(isListed);
  }

  // Reads tableReady so a caller tracking this list (the panel's nav bar) follows a table rebuild.
  function getGameList(): Game[] {
    const t = table;
    return tableReady() && t ? t.processedData() : [];
  }

  // Scoped by specific id — kind/listId alone would collide between two different bundles/user
  // lists navigated between without a remount (see the createEffect below).
  function randomQueueKey(): string {
    if (kind === 'bundle') return `list-route:bundle:${params.bundleId}`;
    if (kind === 'user') return `list-route:user:${params.listId}`;
    if (kind === 'compare') return `list-route:compare:${compareKey()}`;
    if (kind === 'shared') return `list-route:shared:${sharedFormulaParam() ?? ''}`;
    if (kind === 'creator') return `list-route:creator:${creatorRole()}:${creatorName()}`;
    return `list-route:${kind}`;
  }

  // ‹/› bundle-to-bundle nav (kind === 'bundle' only) — steps through whatever's currently in
  // bundleBrowseStore.ts (the last-loaded /bundles list), same "no auto-load-more, no wraparound,
  // disable at either end or when the open bundle isn't part of that list at all (e.g. a fresh
  // deep link)" behavior bundles.tsx's own renderBundleNav had. Re-reads the store fresh on every
  // call rather than caching the index, so it stays correct as the store itself changes (a
  // "Load more" on /bundles while this route is open elsewhere) — cheap, a bundle list is never
  // more than a few hundred entries.
  function bundleNavIndex(): number {
    return getBrowsedBundles().findIndex((b) => b.id === Number(params.bundleId));
  }
  function prevBundleId(): number | null {
    const idx = bundleNavIndex();
    return idx > 0 ? getBrowsedBundles()[idx - 1].id : null;
  }
  function nextBundleId(): number | null {
    const list = getBrowsedBundles();
    const idx = bundleNavIndex();
    return idx !== -1 && idx < list.length - 1 ? list[idx + 1].id : null;
  }

  // Progress only. A finished list says nothing here: its hero card's Games tile carries the
  // count (and, for a bundle, the "N of M on Steam" split — a bundle's table only holds the games
  // that resolved to a Steam listing). Two lines of gray text one under the other, saying the same
  // thing about the same subject, was most of why the old flat facts line read as noise; that
  // reasoning was already applied to bundles when they got a hero card, and now applies to every
  // kind for the same reason. `.list-status:empty` is display:none, so this collapses rather than
  // leaving a gap.
  function clearTable(): void {
    setTableReady(false);
    if (disposeTable) {
      disposeTable();
      disposeTable = null;
    }
    unsyncView?.();
    unsyncView = null;
    table = null;
    setGroupCount(0);
    setRowsStore([]);
    rowStore.reset();
    tableContainer.innerHTML = '';
  }

  // A refreshed row: the new list's own fields, over the details the kept one already had — not
  // its placeholder `loading`/`details`/empty name, since a kept row isn't streamed again.
  function withKept(row: Game, old: Game | undefined): Game {
    if (!old) return row;
    const fresh = Object.entries(row).filter(
      ([key, v]) => v !== undefined && key !== 'loading' && key !== 'details' && !(key === 'name' && !v),
    );
    return { ...old, ...Object.fromEntries(fresh) } as Game;
  }

  function updateStatus(): void {
    if (total > 0 && loaded < total) {
      const now = Date.now();
      // Rows fill with the fast part; once all are in, what's left is the store part's columns.
      const part = answered.fast < total ? 'fast' : 'store';
      if (part !== samplePart) [samplePart, loadSamples] = [part, []];
      const done = answered[part];
      loadSamples = [...loadSamples.filter((s) => s.t >= now - 30_000), { t: now, loaded: done }];
      const eta = etaSeconds(loadSamples, total);
      const etaText = eta != null ? ` · ${formatEta(eta)}` : '…';
      if (part === 'fast') {
        // Past a minute, say why — and keep saying it for this load, rather than flicker at 60 s.
        if (eta != null && eta >= 60) slowLoad = true;
        const why = slowLoad ? ' — details for games not seen before are fetched a few at a time' : '';
        setStatusText(`${done} / ${total} games loaded${etaText}${why}`);
      } else
        setStatusText(
          `All ${total} games listed · genres, Metacritic, achievements still coming: ${done} / ${total}${etaText} — Steam limits these lookups`,
        );
      setLoadFraction(done / total);
      loadedRowsDue = true;
      return;
    }
    setStatusText('');
    setLoadFraction(null);
    if (!loadedRowsDue) return;
    loadedRowsDue = false;
    clearTimeout(loadedRowsTimer);
    // A task of its own, so the stream's last flush paints first; a load started since retakes it.
    loadedRowsTimer = setTimeout(() => {
      if (!loadedRowsDue) setLoadedRows(unwrap(rowsStore).filter(isListed));
    });
  }

  function renderPanelNav(game: Game): void {
    renderPanelNavShared({ hasList: !!table, game, getGameList, onStep: stepGame, onReroll: pickRandomGame });
  }

  function openGame(game: Game, { isRandom = false }: { isRandom?: boolean } = {}): void {
    if (!isRandom) clearRandomQueue(randomQueueKey());
    const resolved = rowStore.getRow(game.appid) ?? standaloneRows[game.appid] ?? game;
    // No "keep the panel's DLC trail" flag to pass: panel.tsx tracks its own hops now (see
    // `pendingHopAppid` there), which is the only way the `/game/:appid` path — where the open
    // happens a whole route navigation later, from load() — could preserve one at all.
    panelOpen(resolved);
    renderPanelNav(resolved);
    // Reveals the newly-open game in the table (expands its group, jumps to its page, scrolls it
    // into view) without stealing real DOM focus from the panel — `@vates/data-table-solid`'s
    // external focus API (>= 0.14), built for exactly this "external nav just changed the current
    // row" case. No-ops harmlessly for a standalone lookup not in `table`'s own data.
    table?.focus.moveTo(resolved);
    // 'recent' is the one kind whose address IS the focused game (see this file's own header
    // comment) — a row click/prev-next/random pick here updates the path, not a `?game=` query
    // param, so the address bar always matches whatever the panel is actually showing. This
    // re-triggers load()'s own createEffect, but harmlessly: the panel is already open by the
    // time this runs (right above), and load()'s fast path (see its own comment) checks the
    // panel's current game before doing anything, so the re-entry is a no-op rather than a
    // second open. Every other kind keeps the existing `?game=` contextual param instead.
    if (kind === 'recent') {
      // The router writes its target over the address only once it settles, so carry the shot of a
      // lightbox open over the panel — deferred past this step, which re-points it at this game.
      // Not `routerLocation`: it lags behind that lightbox's replaceState.
      queueMicrotask(() => {
        const shot = isLightboxOpen() && new URLSearchParams(window.location.search).get('shot');
        navigate(withAccountParam(`/game/${resolved.appid}${shot ? `?shot=${shot}` : ''}`), { replace: true });
      });
    } else setPanelParam(resolved.appid);
    // A `&shot=` deep link into a row whose details are already loaded (a revisit, or this
    // route's own fast path for an appid-only navigation) never reaches the post-stream replay
    // below, so try here too — restorePendingShot is a no-op when there's nothing pending or no
    // media yet.
    restorePendingShot();
  }

  // Returns whether it actually picked, the same way `stepGame` does — the lightbox re-points
  // itself at the new game only if there was one (see AppShell's `onGameRandom`).
  function pickRandomGame(): boolean {
    if (!table || getPanelGame()?.standalone) return false;
    const pick = pickRandomFrom(getGameList(), randomQueueKey(), getPanelGame()?.appid ?? 0);
    if (!pick) return false;
    openGame(pick as Game, { isRandom: true });
    return true;
  }

  // Where the open game sits in this route's own processed row order, for the lightbox caption.
  // Null for a standalone lookup or a game that isn't one of these rows — the same "nothing to
  // page through here" cases `stepGameList` returns null for.
  function gamePosition(): { index: number; total: number } | null {
    const game = getPanelGame();
    if (!table || !game || game.standalone) return null;
    const list = getGameList();
    const index = list.findIndex((g) => g.appid === game.appid);
    return index === -1 ? null : { index, total: list.length };
  }

  function stepGame(dir: 1 | -1): boolean {
    if (!table) return false;
    const next = stepGameList(getGameList(), getPanelGame(), dir);
    if (!next) return false;
    openGame(next);
    return true;
  }

  // Panel tag/genre/category/developer/publisher pills (panel.tsx's TagCloud) — click adds that
  // value to the table's own include filter for the matching column, re-clicking removes it.
  // `setValues` rather than `cycleValue` so a pill click only ever adds/removes from the include
  // set and never reaches the table filter dropdown's separate exclude state.
  function onTagClick(dim: string, value: string): void {
    const t = table;
    if (!t) return;
    t.filter.setValues(dim, [value], !t.filter.include()[dim]?.has(value));
  }
  function isTagActive(dim: string, value: string): boolean {
    return table?.filter.include()[dim]?.has(value) ?? false;
  }

  // Opens `appid` as a standalone panel docked to *this* route, without adding it to the route's
  // own table — used when a game looked up from here (nav search, a DLC/base-game link inside
  // the open panel) isn't one of this list's own rows. Ported from GameRoute.tsx's own
  // single-game fetch (this route is its only remaining caller now that a lookup with no route
  // of its own falls through to /game instead — see AppShell.tsx's openGameGlobally); `openGame`
  // already resolves `rowStore.getRow(appid) ?? game` and no-ops the nav bar for
  // `game.standalone` (panelNav.ts), so there's no extra plumbing needed here beyond that.
  // A `&shot=<id>` deep link, captured at load time and applied once the open game actually has
  // media to index into. Two steps, because opening the panel is what *clears* `shot` from the
  // live URL (setPanelParam) and because a row's screenshots only exist once its media have
  // loaded — so the value is read up front and replayed afterwards, the same shape the
  // deleted pages' own restorePanelFromUrl used.
  let pendingShot: { appid: number; shot: string } | null = null;
  function restorePendingShot(): void {
    if (!pendingShot) return;
    const game = getPanelGame();
    // Only on the link's own game, once its media can show — a later call (a ↻ too) replays it.
    if (!game || game.appid !== pendingShot.appid || detailsPending(game)) return;
    const { shot } = pendingShot;
    pendingShot = null;
    openLightbox(game, shot);
  }

  // The details stream leaves out each game's screenshots and trailers: a row loads them from the cached
  // GET /api/game-meta once opened. A failure only marks it; opening it again (`retry`) tries again.
  const mediaLoading = new Set<number>();
  function loadMedia(appid: number, retry: boolean): void {
    const row = rowStore.getRow(appid);
    const meta = row?.details?.meta;
    // Its store part still coming: the same answer fills it now, ahead of the stream's queue.
    const metaPending = !!row?.pendingSources?.includes('meta');
    if (!row || (!meta && !metaPending) || meta?.screenshots || mediaLoading.has(appid)) return; // no meta: none, or failed (↻ retries)
    if (row.mediaFailed && !retry) return;
    mediaLoading.add(appid);
    if (row.mediaFailed) rowStore.mutateRow(appid, (draft) => void (draft.mediaFailed = false));
    // Only onto this row: a reload of the list may have replaced it by the time the answer lands.
    const ours = (write: (draft: Game) => void) => rowStore.getRow(appid) === row && rowStore.mutateRow(appid, write);
    fetchJson<{ meta: GameMeta | null }>(`/api/game-meta/${appid}`, undefined, "Steam store didn't answer")
      .then(({ meta: loaded }) => {
        ours((draft) => {
          if (draft.pendingSources?.includes('meta')) {
            applyDetailsEvent(draft, { appid, part: 'store', meta: loaded });
            return;
          }
          const details = draft.details;
          if (!details?.meta || details.meta.screenshots) return; // a ↻ landed first
          const media = { screenshots: loaded?.screenshots ?? [], movies: loaded?.movies ?? [] };
          draft.details = { ...details, meta: { ...details.meta, ...media } };
        });
      })
      .catch((err) => {
        console.warn('[media]', appid, err);
        ours((draft) => void (draft.mediaFailed = true));
      })
      .finally(() => {
        mediaLoading.delete(appid);
        restorePendingShot(); // on the media, or the Cover if they failed
      });
  }
  // The open game's, then its neighbours' in list order, so ↑/↓ land on their media at once.
  function loadOpenGameMedia(opened = false): void {
    const game = getPanelGame();
    if (!game) return;
    loadMedia(game.appid, opened);
    for (const dir of [-1, 1] as const) {
      const near = stepGameList(getGameList(), game, dir);
      if (near) loadMedia(near.appid, false);
    }
  }
  // Keyed on the open game alone (`on` runs the load untracked), so a failed load can't loop.
  createEffect(
    on(
      () => getPanelGame()?.appid,
      () => loadOpenGameMedia(true),
    ),
  );

  // Says so in the status line when it isn't.
  function isValidAppid(appid: number): boolean {
    if (Number.isInteger(appid) && appid > 0) return true;
    setStatusText('Invalid game id.');
    return false;
  }

  async function openStandaloneInPlace(appid: number): Promise<void> {
    const token = ++standaloneLookupToken;
    if (!isValidAppid(appid)) return;
    // No `App <appid>` placeholder in the data — panel.tsx's own title renders that fallback, so
    // the empty name here stays honest ("not resolved yet") for everything else that reads it.
    setStandaloneRows(appid, { appid, name: '', loading: true, details: null, standalone: true } as Game);
    const game = standaloneRows[appid];
    openGame(game);
    try {
      const data = await fetchJson<GameDetailsReply>(`/api/game-details/${appid}`, undefined, 'Lookup failed');
      if (token !== standaloneLookupToken) return; // a newer lookup has since taken over
      setStandaloneRows(
        appid,
        produce((draft) => {
          Object.assign(draft, detailsFields(data));
          if (data.meta?.name) draft.name = data.meta.name;
        }),
      );
      // `data.meta?.name`, not `game.name` — the latter falls back to panel.tsx's own
      // `App <appid>` placeholder, which must never reach the stored recents list as if it were
      // a real title (see load()'s recents mapping below).
      addRecentGame(appid, data.meta?.name || '', data.meta?.capsule || null);
      restorePendingShot();
    } catch (err) {
      if (token !== standaloneLookupToken) return;
      setStandaloneRows(appid, failedLookupFields());
      if (getPanelGame() === game) setStatusText(`Lookup failed: ${(err as Error).message}`);
    }
  }

  // kind === 'recent' only: opens `appid` within the recent-games list itself — an existing row
  // (full prev/next/random, same as clicking it) or, for a lookup not seen before, a freshly
  // prepended row that streams in alongside the rest of the list via the same batched
  // /api/game-details/stream every other row here uses (rather than the one-off single-game
  // fetch openStandaloneInPlace uses for every other kind) — since here the lookup IS meant to
  // become a real row, not a standalone aside. Used both by load()'s own params.appid handling
  // (a fresh /game/:appid navigation) and by handleOpenGameRequest (a lookup made while already
  // sitting on this route) — same behavior either way, since /game/:appid *is* this route now.
  // Renumbers the Looked up column after a lookup moved a game to the front of the stored list.
  function restampLookedUp(): void {
    const order = new Map(loadRecentGames().map((g, i) => [g.appid, i + 1]));
    batch(() => {
      for (const { appid } of rowsStore) {
        rowStore.mutateRow(appid, (draft) => {
          draft.lookedUp = order.get(appid) ?? null;
        });
      }
    });
  }
  function openOrAddRecentGame(appid: number): void {
    const existing = rowStore.getRow(appid);
    if (existing) {
      restampLookedUp();
      openGame(existing);
      return;
    }
    if (!isValidAppid(appid)) return;
    const placeholder: Game = { appid, name: '', loading: true, details: null };
    const rows = [placeholder, ...rowsStore];
    setRowsStore(rows);
    rowStore.load(rows);
    restampLookedUp();
    total++;
    updateStatus();
    pendingRecentFocus = appid;
    openGame(rowStore.getRow(appid)!);
    // No ownership stamping call here — the row this just added is picked up by the rowsStore
    // effect above, which is the whole point of driving it off the row list rather than the
    // call sites that build one.
    streamGameDetails([{ appid }], loadGuard.current());
  }

  // Registered with the shell (see onMount below) so a game looked up from the nav-bar search
  // box, or a DLC/base-game link inside an already-open panel, opens right here instead of
  // navigating away — every kind can place it somewhere sensible, so this always returns true;
  // the shell's own fallback (navigating to /game/:appid) is only ever reached from a route with
  // no game/list context at all (Home, Bundles browse, About — see AppShell.tsx's own comment).
  function handleOpenGameRequest(appid: number): boolean {
    // 'recent' is the one kind whose address IS the focused game (/game/:appid, not a query
    // param — see this file's own header comment) — navigating (rather than calling
    // openOrAddRecentGame directly) is what keeps the URL correct; load()'s own fast path below
    // (hasLoadedOnce) is what keeps that navigation cheap; it re-runs load() but, once already
    // mounted on this kind, that just calls straight back into openOrAddRecentGame instead of
    // refetching the whole recents list.
    if (kind === 'recent') {
      navigate(withAccountParam(`/game/${appid}`), { replace: true });
      return true;
    }
    const existing = rowStore.getRow(appid);
    if (existing) openGame(existing);
    else openStandaloneInPlace(appid);
    return true;
  }

  // Registered with the shell too (see onMount below), called from `initPanel`'s own `onClose` —
  // the direct counterpart to handleOpenGameRequest's own navigate() above, so closing the panel
  // strips `:appid` back off the address the same way opening one put it there. kind === 'recent'
  // only; every other kind's `?game=` clearing is handled generically by the shell itself
  // (setPanelParam(null), called unconditionally alongside this).
  function handleGameClose(): void {
    if (kind === 'recent' && params.appid) navigate(withAccountParam('/game'), { replace: true });
  }

  const detailBatcher = createStreamBatcher<DetailsEvent>({
    apply: (event) => {
      const hadName = !!rowStore.getRow(event.appid)?.name;
      const row = rowStore.mutateRow(event.appid, (draft) => applyDetailsEvent(draft, event));
      if (!row) return;
      const capsule = (row as { capsule?: string | null }).capsule ?? null;
      // Recorded once it has a name, or nothing more is coming to give it one.
      if (pendingRecentFocus === event.appid && (row.name || !row.pendingSources?.includes('meta'))) {
        addRecentGame(row.appid, row.name, capsule);
        pendingRecentFocus = null;
        if (kind === 'recent') restampLookedUp();
      } else if (kind === 'recent' && !hadName && row.name) {
        // This row was already in the stored recents list, but recorded without a name (a bare
        // appid/store-URL lookup — see load()'s own comment above). Now that store metadata has
        // resolved one, write it back so the next visit doesn't start out nameless again.
        // renameRecentGame, not addRecentGame: nothing was looked up here, so the entry must keep
        // its place in the list rather than jumping to the front on every visit.
        renameRecentGame(row.appid, row.name, capsule);
      }
      // The open panel reads this row straight off the store, and panelNav tracks the list itself.
      if (isPanelOpen() && getPanelGame()?.appid === row.appid) {
        // A `&shot=` deep link waits on *this* row's media, not the whole stream: replaying it
        // only once every game in the list had finished meant a 115-game wishlist sat for ~20
        // seconds with the panel open and the screenshot the link pointed at still closed
        // (measured live before this call existed).
        restorePendingShot();
      }
    },
    isStale: (gen) => loadGuard.isStale(gen),
    onFlush: () => {
      updateStatus();
      loadOpenGameMedia(); // the open game or a neighbour may have landed
    },
  });

  async function streamGameDetails(games: { appid: number }[], gen: number): Promise<void> {
    // Per part: a game counts as loaded once neither is missing.
    const unanswered = {
      fast: new Set(games.map((g) => g.appid)),
      store: new Set(games.map((g) => g.appid)),
    };
    let failure: string | null = null;
    try {
      const resp = await fetch('/api/game-details/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ games: games.map((g) => ({ appid: g.appid })) }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => null);
        throw new Error(data?.error || `HTTP ${resp.status}`);
      }
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        if (loadGuard.isStale(gen)) {
          reader.cancel();
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data: ')) continue;
          let event: DetailsEvent;
          try {
            event = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          if (event.done) continue;
          if (event.limited) {
            if (!loadGuard.isStale(gen)) setDetailsLimited(event.limited);
            continue;
          }
          const parts = event.part ? [event.part] : (['fast', 'store'] as const);
          const wasLoading = unanswered.fast.has(event.appid) || unanswered.store.has(event.appid);
          for (const part of parts) if (unanswered[part].delete(event.appid)) answered[part]++;
          detailBatcher.push(event, gen);
          if (wasLoading && !unanswered.fast.has(event.appid) && !unanswered.store.has(event.appid)) loaded++;
        }
      }
    } catch (err) {
      failure = (err as Error).message;
    }
    if (loadGuard.isStale(gen)) return;
    // Rows the stream never answered (refused, dropped, cut short) would otherwise stay loading: only the
    // missing part's sources fail.
    for (const appid of new Set([...unanswered.fast, ...unanswered.store])) {
      const fast = unanswered.fast.has(appid);
      const store = unanswered.store.has(appid);
      const failed = [...(fast ? FAST_DETAIL_SOURCES : []), ...(store ? STORE_DETAIL_SOURCES : [])];
      const part = fast && store ? undefined : fast ? 'fast' : 'store';
      if (fast) answered.fast++;
      if (store) answered.store++;
      detailBatcher.push({ appid, ...NO_DETAILS, basics: null, part, failed }, gen);
      loaded++;
    }
    detailBatcher.flushNow();
    if (failure) setStatusText(`Details stream failed: ${failure}`);
  }

  // A health check that didn't answer isn't "off": the price lookup itself says if ITAD is down.
  const itadConfiguredPromise = isItadConfigured().then(() => !isItadOff());
  const [itadOff, setItadOff] = createSignal(false);
  void itadConfiguredPromise.then((ok) => setItadOff(!ok));

  // Looked up by appid, or by ITAD gid for a bundle's games (already known from its resolve). Chunked:
  // a wishlist can run past the server's own cap.
  async function loadPrices(
    games: readonly { appid: number; gid?: string }[],
    gen: number,
    force = false,
  ): Promise<void> {
    setPriceStatusText('');
    const configured = await itadConfiguredPromise;
    if (loadGuard.isStale(gen)) return;
    if (!configured) {
      setPriceStatusText(PRICES_UNAVAILABLE); // its columns are hidden, see load()
      return;
    }

    const country = currentRegion();
    for (let i = 0; i < games.length; i += MAX_PRICE_LOOKUP_GAMES) {
      if (loadGuard.isStale(gen)) return;
      const chunk = games.slice(i, i + MAX_PRICE_LOOKUP_GAMES);
      const byGid = chunk[0].gid != null;
      try {
        const { prices, fetchedAt: at } = await postPrices(
          byGid
            ? { gids: chunk.map((g) => g.gid!), country, force }
            : { appids: chunk.map((g) => g.appid), country, force },
        );
        // A wishlist is chunked across several calls, so the readout takes the oldest of them —
        // same "never claim data is fresher than its stalest part" rule as the account routes'.
        notePriceFetchedAt(at);
        if (loadGuard.isStale(gen)) return;
        batch(() => {
          for (const g of chunk) {
            const info = prices[byGid ? g.gid! : g.appid];
            rowStore.mutateRow(g.appid, (draft) => {
              applyPriceInfo(draft, info);
            });
          }
        });
      } catch (err) {
        if (loadGuard.isStale(gen)) return;
        console.warn('[prices]', err);
        batch(() => {
          for (const g of chunk) rowStore.mutateRow(g.appid, (draft) => nullMissingPriceFields(draft));
        });
        setPriceStatusText(refusalMessage(err) ?? PRICES_FAILED);
      }
    }
  }

  // Backs the side panel's own "↻ Refresh" button, registered with the shell (see AppShell.tsx's
  // `refreshGame`) — force-refetches this one game's rating/HLTB/store metadata/tags and writes
  // them onto its store-backed row. Not every open game is one of this route's rows (a standalone
  // lookup isn't), so `mutateRow` returning undefined means it's a standalone one instead, which
  // has its own store (see standaloneRows).
  async function refreshGame(game: Game): Promise<void> {
    const unresolved = !game.details?.meta;
    try {
      const data = await fetchJson<DetailsEvent>(
        `/api/game-details/${game.appid}?refresh=1`,
        undefined,
        'Refresh failed',
      );
      const updated = rowStore.mutateRow(game.appid, (draft) => applyDetailsEvent(draft, data));
      if (!updated && standaloneRows[game.appid]) {
        setStandaloneRows(
          game.appid,
          produce((draft) => applyDetailsEvent(draft, data)),
        );
        // A lookup that failed lands only now.
        if (unresolved && data.meta) addRecentGame(game.appid, data.meta.name || '', data.meta.capsule || null);
      }
      restorePendingShot();
    } catch (err) {
      setStatusText(`Refresh failed: ${(err as Error).message}`);
    }
  }

  // Stamps ✓/☆ (and a user list's playtime) onto every row in `rowsStore` from myOwnership.ts's cached sets; a still-loading peek is skipped.
  function stampMyOwnership(): void {
    const peek = peekMyOwnership();
    batch(() => {
      for (const item of rowsStore) {
        const status = peek.status(item.appid);
        if (status) {
          rowStore.mutateRow(item.appid, (draft) => {
            draft.inLibrary = status.inLibrary;
            draft.onWishlist = status.onWishlist;
          });
        }
        if (kind !== 'user') continue;
        const played = peek.playtime(item.appid);
        if (played === undefined) continue;
        rowStore.mutateRow(item.appid, (draft) => {
          draft.playtime = played?.playtime;
          draft.lastPlayed = played?.lastPlayed;
        });
      }
    });
  }

  // Whether "do I own this" is a genuine question for this kind at all — an Owned/Wishlist list's
  // own rows are trivially owned/wishlisted, the same reason OWNERSHIP_STATUS_COLUMN is only part
  // of BUNDLE_COLUMNS/RECENT_COLUMNS.
  const stampsOwnership =
    kind === 'bundle' ||
    kind === 'recent' ||
    kind === 'user' ||
    kind === 'compare' ||
    kind === 'shared' ||
    kind === 'creator' ||
    kind === 'game-pass';

  // Re-stamps when a row appears after the load (openOrAddRecentGame), the sets land, or the account changes.
  createEffect(
    on([() => rowsStore.length, trackMyOwnership], () => {
      if (stampsOwnership) stampMyOwnership();
    }),
  );

  // Unused for kind === 'user' (its view lives on the list itself, see storedLayout below) —
  // kept total anyway so a stray call never returns undefined.
  function viewPrefKey(): string {
    if (kind === 'wishlist') return 'wishlistListView';
    // Shared across every comparison, like the bundle key above: a comparison has no stored list
    // of its own to hang a view on.
    if (kind === 'compare') return 'compareListView';
    // Shared across every /lists/shared link, not per-link — the "kind has no stored list of its
    // own to hang a view on" reasoning above applies just as much here, and a link is one-off by
    // nature (a bookmark of *this* view specifically is what "🔗 Share view" is already for).
    if (kind === 'shared') return 'sharedListView';
    // Pick-and-mix bundles share their own layout: grouped and sorted for picking, not by tier.
    if (kind === 'bundle') return untrack(bundleMeta)?.model === 'pick' ? 'pickBundleListView' : 'bundleListView';
    if (kind === 'recent') return 'recentListView';
    if (kind === 'creator') return 'creatorListView';
    if (kind === 'game-pass') return 'gamePassListView';
    return 'ownedListView';
  }
  // Owned/Wishlist's saved view (listViews.ts) in `?view=`, for whichever account is current.
  const viewKind = kind === 'owned' || kind === 'wishlist' ? kind : null;
  const viewId = createMemo(() => (viewKind ? new URLSearchParams(routerLocation.search).get('view') : null));
  const activeView = createMemo(() => {
    const id = viewId();
    return viewKind && id ? (getListView(viewKind, id) ?? null) : null;
  });
  // Where the layout on screen is stored: a saved view, a user list's own tableView, or the kind's
  // pref key. Owned/Wishlist drafts are per account shown, so a friend's stays with the friend.
  function storedLayout(): { id: string; store: ViewStore } {
    const saved = untrack(activeView);
    const account = viewKind ? `:${untrack(getEffectiveCurrentAccount)?.id ?? ''}` : '';
    if (saved && viewKind) {
      const store: ViewStore = {
        load: () => (untrack(activeView)?.tableView ?? {}) as TableViewState,
        save: (view) => saveListViewTable(viewKind, saved.id, view),
      };
      return { id: `view:${saved.id}${account}`, store };
    }
    const id = untrack(userList)?.id;
    if (id)
      return {
        id: `list:${id}`,
        store: { load: () => getList(id)?.tableView ?? {}, save: (view) => setListTableView(id, view) },
      };
    const key = viewPrefKey();
    return { id: key + account, store: prefViewStore(key) };
  }
  // The layout on screen as a draft over its stored one, rebound on each table build and view switch.
  let tableDefaults: TableViewState = {};
  const [layout, setLayout] = createSignal<LayoutDraft | null>(null);
  function bindLayout(): void {
    unsyncView?.();
    const { id, store } = storedLayout();
    const l = layoutDraft(
      viewTable,
      id,
      store,
      { cols: [SIMILARITY_KEY, TAG_MATCH_KEY], ranges: kind === 'bundle' ? ['tierPrice'] : [] },
      tableDefaults,
    );
    setLayout(l);
    setSharedViewEdited(false);
    setViewingShared(l.restore());
    unsyncView = bindViewPersistence(viewTable, l.store, viewingShared, setSharedViewEdited);
  }
  // Another tab of the same list: no reload, only its view (and where it's kept) changes.
  createEffect(on(viewId, () => table && bindLayout(), { defer: true }));
  // What the unsaved-changes banner names, and what Save does.
  const LAYOUT_NAMES: Record<string, string> = {
    owned: 'Owned',
    wishlist: 'Wishlist',
    bundle: 'bundle',
    recent: 'Recently Looked Up',
    compare: 'comparison',
    shared: 'shared list',
    creator: 'developer and publisher list',
    'game-pass': 'Game Pass',
  };
  const exploringSomeoneElse = () => !!viewKind && !showingMyAccount() && !activeView();
  function layoutName(): string {
    const saved = activeView();
    if (saved) return saved.name;
    const list = userList();
    if (list) return `the layout of “${list.name}”`;
    const name = kind === 'bundle' && bundleMeta()?.model === 'pick' ? 'pick & mix bundle' : LAYOUT_NAMES[kind];
    return exploringSomeoneElse() ? 'this table' : `your ${name ?? 'list'} layout`;
  }
  function layoutNote(): string {
    return exploringSomeoneElse()
      ? `Save makes it your ${LAYOUT_NAMES[kind]} layout.`
      : 'kept in this tab until you save or discard.';
  }
  // A view filtering on prices (Bargains) matches nothing until they arrive: say so, not "no match".
  const viewAwaitsPrices = createMemo(() => {
    if (!tableReady() || !activeView() || itadOff()) return false;
    const view = viewTable.getViewState();
    const keys = [...Object.keys(view.filters ?? {}), ...Object.keys(view.rangeFilters ?? {})];
    return keys.some((k) => PRICE_KEYS.has(k)) && tableData().some((row) => row.bestDealPrice === undefined);
  });
  // "🔗 Share view"/"Default view" — see tableViewPrefs.ts for the share-on-demand-only reasoning
  // (a link written to the live URL goes stale the moment the table changes again).
  // A 🔗 Share view link's layout, on screen but not saved (see layoutDraft's restore).
  const [viewingShared, setViewingShared] = createSignal(false);
  const [sharedViewEdited, setSharedViewEdited] = createSignal(false);
  function handleDiscardSharedView(): void {
    const l = layout();
    if (l) applyView(l.store.load());
    setViewingShared(false);
  }

  // The saved or shared list on screen, with the lookup its sources resolve through.
  function definedList(): { list: GameList; get: (id: string) => GameList | undefined } | null {
    const list = kind === 'shared' ? compareList() : kind === 'user' ? userList() : null;
    return list ? { list, get: kind === 'shared' ? sharedGetList : getList } : null;
  }
  // Wishlist prices, by appid: the Wishlist itself, and a saved or shared list built from one, a bundle or a developer/publisher.
  function hasPrices(): boolean {
    const defined = definedList();
    return (
      kind === 'wishlist' ||
      kind === 'creator' ||
      kind === 'game-pass' ||
      (!!defined && listHasPriceSource(defined.list, defined.get))
    );
  }
  // Mid-load, from the definition alone: a region change then must still reload the Tier Price.
  function showsTierPrice(): boolean {
    if (kind === 'bundle') return true;
    const defined = definedList();
    return (
      tieredLoaded !== false &&
      !!defined &&
      defined.list.kind !== 'ranked' &&
      listHasBundleSource(defined.list, defined.get)
    );
  }
  // The PC Game Pass catalog differs per region, so a list built from it reloads on a region change.
  function showsGamePass(): boolean {
    const defined = definedList();
    return kind === 'game-pass' || (!!defined && listHasGamePassSource(defined.list, defined.get));
  }
  // A /lists/<id> link only opens here; a dynamic list's 🔗 Share list replaces Share view outright.
  function isDynamicList(): boolean {
    return kind === 'user' && userList()?.kind === 'dynamic';
  }
  function shareViewFailure(): string | null {
    const list = userList();
    if (kind !== 'user' || !list || list.kind === 'dynamic') return null;
    return `${list.kind === 'ranked' ? 'Ranked' : 'Manual'} lists can't be shared yet: their link only opens in this browser`;
  }
  function handleShareView(btn: HTMLElement): void {
    if (!table) return;
    // Owned/Wishlist are whoever is current — without `u=` the recipient would get their own.
    const account = kind === 'owned' || kind === 'wishlist' ? getEffectiveCurrentAccount() : null;
    const u = account && accountIdentifiers(account).map((m) => m.identifier);
    shareTableView(table, btn, u ? { u: u.join(',') } : {}, ['view']);
  }
  function handleResetView(): void {
    const l = layout();
    if (table && l) resetTableView(viewTable, l.store);
  }

  function viewActions() {
    return (
      <>
        <button
          type="button"
          class="btn"
          aria-label="Pick a random game"
          title="Pick a random game (R)"
          onClick={() => pickRandomGame()}
        >
          <Dices />
        </button>
        <ViewActions
          onShare={handleShareView}
          onReset={handleResetView}
          shareDisabledReason={shareViewFailure()}
          hideShare={isDynamicList()}
          hideReset={!!activeView()}
        />
      </>
    );
  }

  // Disarms the ‹/› focus hand-back for a load stepBundle didn't start, and for one ending with no
  // title, else a later load (Back) would pull focus to the button.
  async function load(opts: { refresh?: boolean } = {}): Promise<void> {
    if (opts.refresh || bundleStepFocus?.id !== Number(params.bundleId)) bundleStepFocus = undefined;
    const step = bundleStepFocus;
    const run = loadList(opts);
    const gen = loadGuard.current(); // loadList takes its generation before its first await
    try {
      await run;
    } finally {
      if (bundleStepFocus === step && !heroTitle() && !loadGuard.isStale(gen)) bundleStepFocus = undefined;
    }
  }

  async function loadList({ refresh = false }: { refresh?: boolean } = {}): Promise<void> {
    if (kind === 'recent' && hasLoadedOnce) {
      // Guarded by "is this appid already the open panel's game" — openGame() above navigates
      // here too (to keep the address bar in sync with a row click/prev-next/random pick made
      // *within* this already-loaded list), which re-runs this same effect right after the panel
      // was already opened; without this check that re-entry would call openOrAddRecentGame a
      // second time for a game that's already showing.
      const focusAppid = params.appid ? Number(params.appid) : null;
      if (focusAppid != null && getPanelGame()?.appid !== focusAppid) openOrAddRecentGame(focusAppid);
      else if (focusAppid == null && isPanelOpen()) panelClose();
      return;
    }
    // A comparison rewrites its own URL to server-resolved steam64 ids once it has them (below),
    // which re-runs the load effect; both spellings name the same comparison, so without this the
    // rewrite would resolve every account and re-stream every game a second time. Explicitly
    // *not* a general "already loaded this" cache — the set is rebuilt by each real load, so
    // editing the players back to a previous pair still reloads.
    if (kind === 'compare' && !refresh && loadedCompareKeys.has(compareKey())) return;

    const gen = loadGuard.next();
    const onFetchedAt = (at: number | null) => loadGuard.isStale(gen) || noteFetchedAt(at);

    // A ↻ refresh keeps the table, its rows' details and the selection on screen until the new
    // list is in, then only streams the games new to it.
    const kept = refresh ? new Map(rowsStore.map((r) => [r.appid, r])) : null;
    const keptSelection = refresh ? new Set(selectedRows().map((r) => r.appid)) : null;
    if (!kept) {
      clearTable();
      // A refresh keeps the previous load's until its own, so the profile doesn't blink.
      setLoadedRows(null);
    }
    setEmptyText('');
    total = 0;
    loaded = 0;
    answered.fast = answered.store = 0;
    loadedRowsDue = true;
    loadSamples = [];
    slowLoad = false;
    setDetailsLimited('');
    setLoadFraction(null);
    // Prices are re-fetched for whatever this load lists; the previous list's age and error don't apply.
    setPriceFetchedAt(undefined);
    setPriceStatusText('');
    // Bundle-detail state belongs to the bundle being left — stepping ‹/› to the next one reuses
    // this component instance, so a stale card/"not on Steam" list would otherwise sit there
    // describing the previous bundle until the new fetch resolved.
    setBundleMeta(null);
    setUnresolvedGames([]);
    setUnresolvedOpen(false);
    setBundleResolvedCount(0);
    setBundleFailedCount(0);
    // Same reasoning one kind over: the hero describes the list being left until the new one has
    // resolved its own name/account, so it's cleared rather than left standing (setBaseTitle is
    // deliberately untouched — <title> keeps naming the last real list until the next one loads,
    // rather than flashing back to the bare app name on every ‹/› step).
    // …but not on a ↻ Refresh of the list already on screen: it re-resolves to the very same
    // name, and blanking it tears the whole card down (`<Show when={heroTitle()}>`) — taking with
    // it the Updated tile that is itself one of the ways to ask for this refresh, mid-click.
    if (!refresh) {
      setHeroTitle('');
      setHeroAccount(null);
    }
    bundleLeftOut = new Map();
    gamePassLeftOut = undefined;
    creatorCapped = new Map();
    // Every kind that has one re-reports it during this load; a kind that doesn't (manual list,
    // recents) must not keep showing the previous list's. A refresh keeps both until replaced, so
    // a failed one leaves the Updated tile and the formula line to try again from.
    replaceFetchedAt = refresh;
    if (!refresh) {
      setListSources([]);
      setFetchedAt(undefined);
    }

    let initialRows: Game[];
    let tiered = false; // rows carry a bundle source's Tier Price
    const tiers: ReturnType<typeof bundleTierFields> = new Map();
    const collectTiers = (games: ResolvedGame[]) => {
      // No picks: a pick-and-mix rate hangs on a pick count only the bundle page's selection gives.
      for (const [appid, f] of bundleTierFields(games, [])) if (!tiers.has(appid)) tiers.set(appid, f);
    };
    resolvedBundleGames = null;
    tieredLoaded = undefined;
    // Cast, not annotated: resolveRows sets it, which flow narrowing from `= null` would miss.
    let pendingGroups = null as MembershipGroup[] | null;
    // Not cleared on a ↻ Refresh of the list already on screen, for the same reason heroTitle
    // isn't (above): these back the hero's own tiles, and emptying them mid-refresh unmounts the
    // tile strip — including the Updated tile the refresh was just clicked on.
    if (!refresh) {
      setUserList(null);
      setCompareList(null);
      setRankedSource(null);
      setRankingState(null);
      setEditingSources(false);
      setEditingRankedSource(false);
    }
    if (!kept) setSelectedRows([]); // a fresh load means a fresh table — nothing carries a prior selection over
    setSelectionActionStatus(null);

    // null once stale, or failed (the status line says so); a group-by-membership result keeps its groups.
    const resolveRows = async (
      list: GameList,
      fetchers: ListResolveFetchers,
      toSources: (sources: ResolvedSource[]) => ReturnType<typeof listSources>,
    ): Promise<{ appids: Set<number>; rows: Game[] } | null> => {
      try {
        const { result, sources } = await resolveListWithSources(list, fetchers);
        if (loadGuard.isStale(gen)) return null;
        setListSources(toSources(sources));
        pendingGroups = Array.isArray(result) ? result : null;
        const appids = Array.isArray(result) ? new Set(result.flatMap((g) => g.appids)) : flattenCombineResult(result);
        return { appids, rows: [...appids].map((appid) => ({ appid, name: '', loading: true, details: null })) };
      } catch (err) {
        if (!loadGuard.isStale(gen)) setStatusText(`Error: ${(err as Error).message}`);
        return null;
      }
    };
    const describeWithLeftOut =
      (list: GameList, naming: ListNaming) =>
      (sources: ResolvedSource[]): ReturnType<typeof listSources> => {
        const described = describeSources(list, naming);
        return sources.map((source, i) => ({
          ...source,
          desc: described[i],
          leftOut: leftOutOf(list, i),
          capped: cappedOf(list, i),
        }));
      };

    if (kind === 'compare') {
      const slots = compareSlots();
      loadedCompareKeys = new Set([compareKey()]);
      setCompareFailures([]);
      if (!refresh) setEditingPlayers(false);
      // Under two players there's nothing to compare — the players form renders in place of the
      // table (see the JSX below), so this is an empty state, not an error.
      if (slots.length < 2) {
        setListTitle('Compare libraries');
        return;
      }

      setListTitle(slots.map((slot) => slot.join(' + ')).join(' vs. '));
      setStatusText('Resolving accounts…');
      const settled = await Promise.allSettled(slots.map((identifiers) => resolveAccountSlot(identifiers)));
      if (loadGuard.isStale(gen)) return;
      const failures = settled.flatMap((r, i) =>
        r.status === 'rejected' ? [{ identifiers: slots[i], message: (r.reason as Error).message }] : [],
      );
      if (failures.length) {
        // Named as far as known: a resolved player by name, a failed one as typed.
        setListTitle(
          settled
            .map((r, i) => (r.status === 'fulfilled' ? accountDisplayLabel(r.value) : slots[i].join(' + ')))
            .join(' vs. '),
        );
        setCompareFailures(failures);
        setStatusText('');
        return;
      }
      const accounts = settled.map((r) => (r as PromiseFulfilledResult<AccountSlot>).value);
      // Ordered by the same rule the canonical URL below sorts on (an accountId *is* its members'
      // sorted steam64 ids), so the title, the formula line and the group headings read in the
      // order the address bar names the players in — not in whatever order they were typed. Those
      // two orders disagreeing would make one URL render two ways: as typed on the way in, and
      // re-sorted for anyone opening the link afterwards.
      accounts.sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: 'base' }));
      // The same player twice compares nothing; said rather than shown as a one-player "comparison".
      const twice = accounts.find((a, i) => accounts.findIndex((b) => b.id === a.id) !== i);
      if (twice) {
        setListTitle('Compare libraries');
        setStatusText(`${accountDisplayLabel(twice)} is in two player boxes — compare two different players.`);
        setEditingPlayers(true);
        return;
      }
      // The URL stays sorted (one address per comparison), but the viewer's own ★ account reads first.
      const myId = getMyAccount()?.id;
      const shown = [...accounts].sort((a, b) => Number(b.id === myId) - Number(a.id === myId));
      setCompareAccounts(shown);
      setListTitle(shown.map(accountDisplayLabel).join(' vs. '));
      // Canonicalize the address to the resolved ids, exactly as the old Comparison page did: a
      // link built from vanity names would otherwise point somewhere else the day one of them is
      // changed, and two spellings of one comparison would be two history entries. Never stored
      // in `recentAccounts` — comparing someone isn't picking them as your account, the same rule
      // a `?u=` override follows (see docs/dev/lists-and-accounts.md).
      const canonicalSlots = normalizeSlots(accounts.map((a) => a.members));
      // Live `location`, not `routerLocation`: that lags the panel's and a shared view's replaceState.
      const canonical = compareUrl(canonicalSlots, compareOp(), location.search);
      loadedCompareKeys.add(compareKey(compareOp(), canonicalSlots));
      if (canonical !== location.pathname + location.search) navigate(canonical, { replace: true });

      const list = inMemoryDynamicList(
        compareOp(),
        shown.map((account) => ({ kind: 'account-owned' as const, accountId: account.id })),
      );
      setCompareList(list);
      setStatusText('Comparing libraries…');
      const ownersByAccount = new Map<string, Map<number, GameOwner[]>>();
      const fetchers = createDefaultFetchers({
        refresh,
        onFetchedAt,
        onOwners: (byAppid, accountId) => ownersByAccount.set(accountId, byAppid),
      });
      const resolved = await resolveRows(list, fetchers, (sources) => {
        comparePlayers = shown.map((account) => ({
          id: account.id,
          label: accountDisplayLabel(account),
          avatarUrl: account.avatarUrl ?? account.members.map((id) => account.memberAvatars?.[id]).find(Boolean),
          family: account.members.length > 1,
          owners: ownersByAccount.get(account.id) ?? new Map(),
        }));
        notifyOwnersChanged();
        const described = describeSources(list, compareNaming());
        return sources.map((source, i) => ({
          ...source,
          // Every source in a comparison is the same thing — a player's Owned list — so the
          // shared label's "— Owned" half is pure noise once it's repeated across every group
          // heading. "Alice + Bob", not "Alice — Owned + Bob — Owned"; the link still points at
          // that player's own library.
          desc: { ...described[i], label: accountDisplayLabel(shown[i]) },
        }));
      });
      if (!resolved) return;
      initialRows = resolved.rows;
    } else if (kind === 'user') {
      // A manual list, or a dynamic one using any op other than group-by-membership, renders as
      // one flat table (flattened via flattenCombineResult, same as when it's resolved as
      // someone *else's* combine source). group-by-membership instead keeps its raw
      // MembershipGroup[] result (stashed in pendingGroups): each row gets its group's key, and
      // the one table is grouped by it (membershipColumn.ts).
      const list = getList(params.listId!);
      if (!list) {
        // Also what a /lists/<id> link from someone else's browser lands on.
        setStatusText(
          "This list isn't in this browser: it was deleted, or it was made in another one — lists live in the browser that created them. Ask for its Share list link instead (combined lists only, for now).",
        );
        return;
      }
      setUserList(list);
      setListTitle(listDisplayName(list, createDefaultNaming()));
      setStatusText('Resolving list…');
      const resolved = await resolveRows(
        list,
        createDefaultFetchers({
          refresh,
          onFetchedAt,
          onBundleLeftOut: noteLeftOut,
          onGamePassLeftOut: (n) => (gamePassLeftOut = n),
          onCreatorCapped: noteCapped,
          onBundleGames: (_bundleId, _bundle, games) => {
            if (!loadGuard.isStale(gen)) collectTiers(games);
          },
        }),
        describeWithLeftOut(list, createDefaultNaming()),
      );
      if (!resolved) return;
      const { appids, rows } = resolved;
      tiered = list.kind !== 'ranked' && rows.some((row) => tiers.has(row.appid));
      initialRows = rows.map((row) => ({ ...row, ...tiers.get(row.appid) }));
      if (list.kind === 'ranked') {
        const state = getRanking(list.id);
        setRankedSource(appids);
        setRankingState(state);
        const rankOf = ranks(state, appids);
        initialRows = rows.map((row) => ({ ...row, rank: rankOf.get(row.appid) ?? null }));
      }
    } else if (kind === 'shared') {
      // Another dynamic list's formula, decoded straight from ?f= (listShare.ts) — same "resolve
      // an in-memory dynamic list through the normal listResolve.ts/listLabels.ts path" idea
      // `compare` above uses, just built from a URL-encoded formula instead of account slots. See
      // this file's own header comment on the sharedSynthetic/sharedFetchers/sharedNaming trio.
      const decoded = decodeListFormula(sharedFormulaParam() ?? '');
      if (!decoded) {
        setStatusText("This link isn't a valid shared list.");
        return;
      }
      setSharedSynthetic(decoded.synthetic);
      if (!refresh) setSharedBundles([]);
      const list = inMemoryDynamicList(decoded.op, decoded.sources);
      setCompareList(list);
      setListTitle(listDisplayName(list, sharedNaming()));
      setStatusText('Resolving shared list…');
      const resolved = await resolveRows(
        list,
        sharedFetchers(
          createDefaultFetchers({
            refresh,
            onFetchedAt,
            onBundleLeftOut: noteLeftOut,
            onGamePassLeftOut: (n) => (gamePassLeftOut = n),
            onCreatorCapped: noteCapped,
            onBundleGames: (bundleId, bundle, games) => {
              if (loadGuard.isStale(gen)) return;
              setSharedBundles((prev) =>
                prev.some((b) => b.id === bundleId) ? prev : [...prev, { id: bundleId, title: bundle.title }],
              );
              collectTiers(games);
            },
          }),
        ),
        describeWithLeftOut(list, sharedNaming()),
      );
      if (!resolved) return;
      tiered = resolved.rows.some((row) => tiers.has(row.appid));
      initialRows = resolved.rows.map((row) => ({ ...row, ...tiers.get(row.appid) }));
    } else if (kind === 'recent') {
      setListTitle('Recently Looked Up');
      const recents = loadRecentGames();
      // `g.name` verbatim, *not* `g.name || \`App ${g.appid}\``: a game looked up by bare appid or
      // store URL is recorded with no name at all (nothing client-side knows one yet), and baking
      // the placeholder in here made it look like a real name to applyDetailsEvent's own
      // `if (!row.name)` guard — so the row kept reading "App 108600" forever, even once store
      // metadata had streamed in with the real title. The placeholder is presentational only now
      // (panel.tsx's title falls back to it); a still-nameless row is `loading` and filtered out
      // of the table anyway until its details event lands.
      initialRows = recents.map((g, i) => ({
        appid: g.appid,
        lookedUp: i + 1,
        name: g.name,
        capsule: g.tinyImage || undefined,
        loading: true,
        details: null,
      }));
    } else if (kind === 'creator') {
      const name = creatorName();
      setCreatorResult(null);
      setListTitle(creatorTitle(creatorRole(), name));
      if (!name) {
        setStatusText('This link names no developer or publisher.');
        return;
      }
      setStatusText(`Searching Steam for games by ${name}…`);
      try {
        const data = await fetchCreatorGames(creatorRole(), name, { refresh });
        if (loadGuard.isStale(gen)) return;
        noteFetchedAt(data.fetchedAt);
        setCreatorResult({ total: data.total, capped: data.capped });
        initialRows = data.appids.map((appid) => ({ appid, name: '', loading: true, details: null }));
      } catch (err) {
        if (loadGuard.isStale(gen)) return;
        setStatusText(`Steam's store search didn't answer (${(err as Error).message}). Click Updated to retry.`);
        return;
      }
    } else if (kind === 'game-pass') {
      setGamePass(null);
      setListTitle(GAME_PASS_TITLE);
      setStatusText('Reading the PC Game Pass catalog…');
      try {
        const data = await fetchGamePass(currentRegion(), { refresh });
        if (loadGuard.isStale(gen)) return;
        noteFetchedAt(data.fetchedAt);
        setGamePass(data);
        initialRows = data.appids.map((appid) => ({ appid, name: '', loading: true, details: null }));
      } catch (err) {
        if (loadGuard.isStale(gen)) return;
        setStatusText(
          err instanceof ApiError && err.status === 503
            ? "PC Game Pass isn't available on this instance: it isn't connected to IsThereAnyDeal."
            : `The PC Game Pass catalog didn't answer (${(err as Error).message}). Click Updated to retry.`,
        );
        return;
      }
    } else if (kind === 'bundle') {
      setStatusText('Resolving games to Steam…');
      try {
        const { bundle, fetchedAt: bundleFetchedAt } = await fetchBundleById(Number(params.bundleId), {
          country: currentRegion(),
        });
        if (loadGuard.isStale(gen)) return;
        // Stated, not actionable — the single-bundle endpoint has no force path (see
        // fetchBundleById). Still worth saying: a bundle's tiers and end date are read here.
        noteFetchedAt(bundleFetchedAt);
        setListTitle(bundle.title);
        setBundleLinks({ details: bundle.details, url: bundle.url, fanaticalNames: bundle.pickAndMixNames ?? null });
        const regionCur = regionCurrency();
        const picks = pickTiers(bundle.pickAndMix, regionCur);
        const tierSummary = bundleTierSummary(bundle, regionCur);
        setBundleMeta({
          shop: bundle.page?.name || null,
          publish: bundle.publish,
          expiry: bundle.expiry,
          note: bundle.note,
          itadCount: bundle.counts?.games ?? null,
          tiers: tierSummary,
          model: bundlePricingModel(tierSummary),
          picks,
        });
        const { resolved, unresolved, failed } = await resolveBundleGames(bundle);
        if (loadGuard.isStale(gen)) return;
        setUnresolvedGames(unresolved);
        setBundleResolvedCount(resolved.length);
        setBundleFailedCount(failed.length);
        if (resolved.length === 0) {
          setStatusText(failed.length ? '' : 'No games in this bundle could be matched to a Steam listing.');
          return;
        }
        resolvedBundleGames = resolved;
        const tiers = bundleTierFields(resolved, picks);
        initialRows = resolved.map((g) => {
          const fields = tiers.get(g.appid)!;
          return {
            appid: g.appid,
            // A package's rows share ITAD's package title; each takes its own Steam name instead.
            name: fields.bundlePackage ? '' : g.title,
            ...fields,
            loading: true,
            details: null,
          };
        });
      } catch (err) {
        if (loadGuard.isStale(gen)) return;
        setStatusText(loadErrorText(err));
        return;
      }
    } else {
      // The *effective* account — a `?u=` link's override when one is being explored, the
      // stored currentAccount otherwise (see accountsStore.ts's own `?u=` section).
      //
      // A `?u=` link is authoritative for these two lists, so while it's still resolving — and
      // if it fails outright — the stored account is deliberately NOT loaded in its place. That
      // matters both ways: a cold visit to /lists/owned?u=alice would otherwise fetch and stream
      // the *stored* account's whole library first (this route's own load effect runs right
      // after AppShell.tsx's has only just started the resolve) and throw it away moments later
      // when the override landed and reloaded; and on a failure — a private or unknown profile,
      // confirmed live — it would quietly show someone else's library under a URL that names a
      // specific account. Either way there's nothing here yet, and the override's own status
      // text says which of the two it is; only a genuinely account-less app points at Home.
      const overrideState = getAccountOverrideState();
      const linkPending = overrideState.state === 'resolving' || overrideState.state === 'error';
      const account = linkPending ? null : getEffectiveCurrentAccount();
      // Named before the account is known, so an account-less (or still-resolving-a-`?u=`-link)
      // route still says which list you're on rather than rendering no hero at all; refined to
      // "<account>'s Library" just below once there is one.
      const listLabel = kind === 'wishlist' ? 'Wishlist' : 'Library';
      setListTitle(listLabel);
      const overrideText = accountOverrideStatusText(overrideState);
      setNeedsAccount(!account && !overrideText);
      if (!account) {
        setStatusText(overrideText ?? '');
        return;
      }
      setHeroAccount(account);
      setListTitle(`${accountDisplayLabel(account)}'s ${listLabel}`);
      setStatusText(kind === 'wishlist' ? 'Fetching wishlist…' : 'Fetching library…');
      try {
        if (kind === 'owned') {
          const { games, fetchedAt: at } = await fetchAccountOverview(account.members, { refresh });
          if (loadGuard.isStale(gen)) return;
          setFetchedAt(at);
          initialRows = games.map((g) => ({
            appid: g.appid,
            name: g.name,
            playtime: hoursFromMinutes(g.playtimeMinutes),
            lastPlayed: fmtLastPlayed(g.lastPlayedUnix),
            loading: true,
            details: null,
          }));
        } else {
          const { items, fetchedAt: at } = await fetchAccountWishlist(account.members, { refresh });
          if (loadGuard.isStale(gen)) return;
          setFetchedAt(at);
          initialRows = items.map((item) => ({
            appid: item.appid,
            name: '',
            priority: item.priority,
            dateAdded: item.dateAdded,
            loading: true,
            details: null,
          }));
        }
      } catch (err) {
        if (loadGuard.isStale(gen)) return;
        setStatusText(`Error: ${(err as Error).message}`);
        return;
      }
    }

    if (pendingGroups) {
      const byAppid = new Map(
        pendingGroups.flatMap((g) => g.appids.map((appid) => [appid, membershipKey(g)] as const)),
      );
      initialRows = initialRows.map((row) => ({ ...row, membership: byAppid.get(row.appid) }));
      setGroupCount(pendingGroups.length);
    }
    if (kept) {
      clearTable();
      initialRows = initialRows.map((row) => withKept(row, kept.get(row.appid)));
      loaded = answered.fast = answered.store = initialRows.filter((row) => kept.has(row.appid)).length;
    }
    setRowsStore(initialRows);
    rowStore.load(initialRows);
    total = initialRows.length;

    // Without IsThereAnyDeal, no price columns at all rather than a column of "—" (the status line says why).
    const pricesShown = hasPrices() && (await itadConfiguredPromise);
    if (loadGuard.isStale(gen)) return;
    tieredLoaded = tiered;
    {
      const isRanked = userList()?.kind === 'ranked';
      const tasteAccount = getEffectiveCurrentAccount();
      const tasteSource: TasteSource = {
        label: tasteAccount && accountDisplayLabel(tasteAccount),
        taste: tasteAccount && loadTaste(tasteAccount.id),
        linked:
          !!getAccountOverride() &&
          tasteAccount?.id !== getCurrentAccount()?.id &&
          tasteAccount?.id !== getMyAccount()?.id,
      };
      setTasteFitSource(tasteSource);
      const priced = kind === 'user' && pricesShown;
      const sharedPriced = (kind === 'shared' || kind === 'creator' || kind === 'game-pass') && pricesShown;
      const pickBundle = kind === 'bundle' && untrack(bundleMeta)?.model === 'pick';
      const columns = insertColumnsAfter(
        isRanked
          ? priced
            ? RANKED_PRICED_COLUMNS
            : RANKED_COLUMNS
          : kind === 'wishlist'
            ? pricesShown
              ? WISHLIST_COLUMNS
              : WISHLIST_NOPRICE_COLUMNS
            : kind === 'bundle'
              ? pickBundle
                ? PICK_BUNDLE_COLUMNS
                : bundleColumns(untrack(bundleMeta)!, resolvedBundleGames ?? [])
              : kind === 'user'
                ? priced
                  ? tiered
                    ? USER_TIERED_COLUMNS
                    : USER_PRICED_COLUMNS
                  : USER_COLUMNS
                : kind === 'recent'
                  ? LOOKED_UP_COLUMNS
                  : kind === 'compare'
                    ? insertColumnsAfter(
                        RECENT_COLUMNS,
                        'hltbCompletionist',
                        ...comparePlayers.map(playedByColumn),
                        ...comparePlayers.map(recentPlayedByColumn),
                        groupFitColumn(
                          groupFits,
                          comparePlayers.map((p) => p.label),
                        ),
                      )
                    : kind === 'shared' || kind === 'creator' || kind === 'game-pass'
                      ? sharedPriced
                        ? tiered
                          ? SHARED_TIERED_COLUMNS
                          : SHARED_PRICED_COLUMNS
                        : RECENT_COLUMNS
                      : OWNED_COLUMNS,
        'tags',
        tagMatchColumn(
          // eslint-disable-next-line solid/reactivity -- read inside the table's own processData memo
          () => filterTable()?.filter.include().tags,
          // eslint-disable-next-line solid/reactivity -- same
          () => filterTable()?.filter.modes().tags === 'and',
        ),
        similarityColumn(similarityScores),
        tasteFitColumn(tasteFitSource),
      ) as unknown as ColumnDef<Game>[];
      const kindDefaultVisible = isRanked
        ? [...RANKED_DEFAULT_VISIBLE, ...(priced ? PRICED_DEFAULT_VISIBLE : [])]
        : kind === 'wishlist'
          ? WISHLIST_DEFAULT_VISIBLE.filter((key) => pricesShown || !PRICE_KEYS.has(key))
          : kind === 'bundle'
            ? pickBundle
              ? PICK_BUNDLE_DEFAULT_VISIBLE
              : BUNDLE_DEFAULT_VISIBLE
            : (kind === 'user' && priced) || sharedPriced
              ? [...RECENT_DEFAULT_VISIBLE, ...(tiered ? ['tierPrice'] : []), ...PRICED_DEFAULT_VISIBLE]
              : kind === 'recent'
                ? LOOKED_UP_DEFAULT_VISIBLE
                : kind === 'compare'
                  ? [...RECENT_DEFAULT_VISIBLE, ...comparePlayers.map((_, i) => playedByKey(i)), GROUP_FIT_KEY]
                  : kind === 'user' || kind === 'shared'
                    ? RECENT_DEFAULT_VISIBLE
                    : kind === 'creator' || kind === 'game-pass'
                      ? [...RECENT_DEFAULT_VISIBLE, TASTE_FIT_KEY]
                      : OWNED_DEFAULT_VISIBLE;
      // A Taste fit with no taste on this device would be a column of "—": hidden until there is one.
      const defaultVisible = kindDefaultVisible.filter((key) => key !== TASTE_FIT_KEY || !!tasteSource.taste);
      const sort = isRanked
        ? RANKED_DEFAULT_SORT
        : kind === 'bundle'
          ? pickBundle
            ? PICK_BUNDLE_DEFAULT_SORT
            : BUNDLE_DEFAULT_SORT
          : kind === 'recent'
            ? LOOKED_UP_DEFAULT_SORT
            : DEFAULT_SORT;
      const groups = pendingGroups;
      const names = new Map(listSources().map((source) => [source.key, source.desc.label]));
      const allColumns = groups
        ? [...columns, membershipColumn(groups, [...names.keys()], names, kind === 'compare')]
        : columns;
      // Set once the stored view is restored, so restoring a tag filter keeps its saved sort.
      let leadSortArmed = false;

      let disposeTableState!: () => void;
      const ts = createRoot((dispose) => {
        disposeTableState = dispose;
        tableDefaults = {
          pageSize: 50,
          visibleCols: defaultVisible,
          sorts: sort,
          ...(groups
            ? { groupBy: [MEMBERSHIP_KEY] }
            : kind === 'bundle'
              ? { groupBy: [pickBundle ? 'ownershipStatus' : 'tierPrice'] }
              : {}),
        };
        const state = createTableState<Game>(tableData, allColumns, {
          initialViewState: tableDefaults,
          // The old per-group tables showed every game; a collapsed group would hide them.
          defaultGroupsCollapsed: false,
        });
        createEffect(
          on(
            () => !!state.filter.include().tags?.size,
            (active) => leadSortArmed && syncLeadColumn(state, TAG_MATCH_KEY, active),
            { defer: true },
          ),
        );
        createEffect(
          on(similarTo, (appid) => leadSortArmed && syncLeadColumn(state, SIMILARITY_KEY, appid != null), {
            defer: true,
          }),
        );
        // Mirrors this table's own selection into a component-level signal so the JSX selection
        // toolbar below stays correct regardless of which load() constructed the table it's
        // currently reading from — disposed alongside the table itself (same createRoot), so a
        // later reload's own fresh table doesn't fight this effect over who last wrote the signal.
        // A bundle's package rows are bought together, so they're selected together too.
        let prevSelection = new Set<Game>();
        createEffect(
          on(state.selection.rows, (rows) => {
            const whole = wholePackages(prevSelection, rows, tableData(), (r) => r.bundlePackage?.gid);
            if (whole) return state.selection.setAll(whole);
            prevSelection = new Set(rows);
            setSelectedRows(rows);
          }),
        );
        if (!kept)
          cascadeFirstRows(
            () => state.processedData().length,
            () => tableContainer,
          );
        slideRowsOnViewChange(state, () => tableContainer);
        return state;
      });
      table = ts;
      setFilterTable(ts);
      tableGrouped = !!groups;
      const disposeView = render(
        () =>
          DataTableView<Game>({
            table: ts,
            rowKey: 'appid',
            selectable: true,
            // eslint-disable-next-line solid/reactivity -- runs once per click, inside the view transition's update
            onRowClick: (row, event) => openPanelFromRow(event, () => openGame(rowStore.getRow(row.appid) ?? row)),
            get currentRow() {
              const appid = getPanelGame()?.appid;
              return appid == null ? null : (rowStore.getRow(appid) ?? null);
            },
            // In the toolbar's own line rather than a row above it, so a phone's table starts higher.
            toolbarEnd: viewActions(),
          }),
        tableContainer,
      );
      disposeTable = () => {
        disposeView();
        disposeTableState();
      };
      bindLayout();
      // A tier filter (a max alone) restored from another bundle's draft or view, matching none of this one's tiers, goes.
      const tierRange = table.filter.ranges().tierPrice;
      if (
        kind === 'bundle' &&
        tierRange?.min === '' &&
        tierRange.max !== '' &&
        activeTierPrice(tierRange, untrack(bundleMeta)?.tiers ?? []) == null
      )
        table.filter.clearColumn('tierPrice', 'range');
      // A similarity sort isn't kept: its target was this table's predecessor's.
      setSimilarTo(null);
      syncLeadColumn(table, SIMILARITY_KEY, false);
      leadSortArmed = true;
      if (keptSelection?.size) table.selection.setAll(tableData().filter((row) => keptSelection.has(row.appid)));
      setTableReady(true);
    }

    updateStatus();
    hasLoadedOnce = true;

    // Opens whatever this load's own URL says should be open — params.appid (a /game/:appid
    // navigation) for 'recent', or a route-local ?game= query param for every other kind (see
    // handleOpenGameRequest's own comment for why these are two different mechanisms: 'recent'
    // rows come from the same path the game itself lives at, everything else is contextual state
    // layered on top of a route that already has its own identity). Placed after the table/rows
    // are built (openGame/openOrAddRecentGame both need rowStore/table to already exist) and
    // before the empty-list early return below, since a first-ever /game/:appid lookup
    // can arrive with an otherwise-empty recents list. Only the *first* load needs to do this
    // here — a later appid-only change is handled by load()'s own fast path above instead.
    // This list is being rebuilt, so its own random-pick history no longer describes its
    // contents — a re-roll should be able to land on anything in the new list again.
    clearRandomQueue(randomQueueKey());
    // Only ever *set* by a load, never cleared: opening the panel strips `shot` from the live
    // URL (setPanelParam), and this route re-runs load() for reasons of its own (an appid-only
    // navigation, an account change) — a later pass reading the by-then-stripped URL would
    // otherwise wipe a value the first pass hasn't replayed yet. Cleared only by the replay.
    const search = new URLSearchParams(routerLocation.search);
    const shotParam = search.get('shot');
    if (shotParam) pendingShot = { appid: Number(search.get('game') ?? params.appid), shot: shotParam };
    if (kind === 'recent') {
      if (params.appid) openOrAddRecentGame(Number(params.appid));
    } else {
      const gameParam = new URLSearchParams(routerLocation.search).get('game');
      if (gameParam) handleOpenGameRequest(Number(gameParam));
    }

    // An empty result set was practically unreachable before row-selection-based remove-from-
    // list existed (a bundle already early-returns its own "no games matched" message above;
    // every other kind just happened to always have at least one row) — now that "Remove from
    // this list" can genuinely empty a manual list out from under the route currently viewing
    // it, streamGameDetails needs its own guard too: the server 400s a `games: []` stream
    // request outright ("Provide at least one game"), confirmed live the first time this path
    // was actually reachable through the UI.
    // rowsStore, not initialRows: a first /game/:appid lookup just added its row above.
    if (rowsStore.length === 0) {
      setStatusText('');
      const account = heroAccount();
      const whose = account ? `${accountDisplayLabel(account)}'s` : "This account's";
      // Steam answers a private wishlist or library with an empty one, so the two read the same here.
      setEmptyText(
        kind === 'wishlist'
          ? `${whose} wishlist is empty, or private on Steam.`
          : kind === 'owned'
            ? `${whose} library is empty, or private on Steam.`
            : kind === 'creator'
              ? `Steam's store has no games under the exact ${creatorRole()} name "${creatorName()}".`
              : kind === 'game-pass'
                ? 'None of the games in this PC Game Pass catalog are on Steam.'
                : 'No games in this list.',
      );
      return;
    }

    const targets = priceTargets();
    if (targets) loadPrices(targets, gen); // runs concurrently, not awaited
    if (stampsOwnership) stampMyOwnership(); // a reload can keep the row count
    const toStream = kept ? initialRows.filter((row) => !kept.has(row.appid)) : initialRows;
    if (toStream.length) await streamGameDetails(toStream, gen);
    if (loadGuard.isStale(gen)) return;
    restorePendingShot(); // now that the open game's details have arrived (its media, if any, replay it too)
  }

  // ── The hero card's content (see ListHero.tsx) ────────────────────────────────────────────
  // One accessor per piece rather than one big model object: `kind` is fixed for the whole mount,
  // so each is a straight switch on it, and every reactive read (the row count, the cache ages,
  // the resolved list/bundle) stays inside the accessor that actually needs it — the card is
  // rebuilt per piece as those land, not wholesale.

  // "Folder A / Folder B" for a user list that lives in one, null at the tree root. Walked here
  // rather than stored on the list: parentId is the only structural link listsStore.ts keeps (see
  // its own module comment on why the tree is flat arrays, not a nested structure).
  function folderPathLabel(list: GameList): string | null {
    const folders = getFolders();
    const names: string[] = [];
    let parentId = list.parentId;
    while (parentId) {
      const folder = folders.find((f) => f.id === parentId);
      if (!folder) break;
      names.unshift(folder.name);
      parentId = folder.parentId;
    }
    return names.length ? names.join(' / ') : null;
  }

  // Which region's prices are on screen and how stale they are (wishlist/bundle kinds) — the one
  // tile carrying two separate actions, one per fact. The region is still not *edited* here (the
  // ⚙ Preferences popover owns the setting, and a second control would be one more thing to keep
  // in sync); clicking the value just opens that popover rather than leaving its tooltip to send
  // the reader looking for it.
  function priceTile(): HeroTile {
    return {
      label: 'Prices',
      value: regionLabel(regionCode()),
      title: 'Prices are shown for this region — click to change it in Preferences',
      onClick: openPrefsPopover,
      // The tile's second control, and what replaced the actions row's own "↻ Refresh prices":
      // prices are a different fetch from the list itself, so they keep their own age and their
      // own refresh — but here, next to the age, rather than as a button at the other end of the
      // card. Offered even before anything has priced, so a failed first price load has a retry.
      sub: refreshingPrices()
        ? refreshTileValue('Refreshing prices…')
        : priceFetchedAt() === undefined
          ? refreshTileValue('Refresh prices')
          : refreshTileValue(`Updated ${fmtAge(priceFetchedAt())}`),
      subTitle: 'Re-fetch current prices and historical lows for every game in this list',
      subOnClick: handleRefreshPrices,
      subDisabled: refreshingPrices(),
    };
  }

  // The open bundle's appid -> ITAD gid, rebuilt only when load() replaces its games.
  let gidMapFor: ResolvedGame[] | null | undefined;
  let gidMap = new Map<number, string>();
  function gidOf(appid: number): string | undefined {
    if (gidMapFor !== resolvedBundleGames) {
      gidMapFor = resolvedBundleGames;
      gidMap = new Map((resolvedBundleGames ?? []).map((g) => [g.appid, g.gid]));
    }
    return gidMap.get(appid);
  }
  // How many picks the selection takes in a pick-and-mix bundle — one per ITAD game, so a Steam
  // package spanning several rows counts once — and the cheapest way to buy them.
  function onePerGid(rows: readonly Game[]): Game[] {
    const seen = new Set<string | number>();
    return rows.filter((r) => {
      const key = gidOf(r.appid) ?? r.appid;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  function selectedPickCount(): number {
    return onePerGid(selectedRows()).length;
  }
  function pickPlan(): PickPlan | null {
    const picks = bundleMeta()?.picks;
    return kind === 'bundle' && picks?.length ? cheapestPicks(picks, selectedPickCount()) : null;
  }
  createEffect(
    on(
      () => {
        const picks = bundleMeta()?.picks;
        return kind === 'bundle' && picks?.length ? pickRate(picks, selectedPickCount())?.amount : undefined;
      },
      (rate) => {
        if (rate == null) return;
        for (const r of rowsStore)
          if (r.tierPerGame && r.tierPrice !== rate)
            rowStore.mutateRow(r.appid, (draft) => {
              draft.tierPrice = rate;
            });
      },
    ),
  );
  // "What does this add?" / "What don't I own?": `ref` minus the current account's Owned, as an unsaved shared list.
  function notOwnedHref(ref: ListRef): string | null {
    const account = getEffectiveCurrentAccount();
    if (!account) return null;
    const sources: ListRef[] = [ref, { kind: 'account-owned', accountId: account.id }];
    const result = encodeListFormula({ op: 'subtract', sources }, () => undefined);
    return result.ok ? withAccountParam(shareListUrl(result.formula), routerLocation.search) : null;
  }
  // The selection under the names Fanatical's page shows, for "Buy on Fanatical"; `byHand` are the
  // picks matchPickAndMix couldn't name.
  function fanaticalPicks(): { url: string; names: string[]; byHand: string[] } | null {
    const { url, fanaticalNames } = bundleLinks();
    if (!url || !fanaticalNames || !pickPlan()) return null;
    const names: string[] = [];
    const byHand: string[] = [];
    for (const r of onePerGid(selectedRows())) {
      const name = fanaticalNames[gidOf(r.appid) ?? ''];
      if (name) names.push(name);
      else byHand.push(r.bundlePackage?.title || r.name);
    }
    return names.length ? { url: fanaticalBuyUrl(url, names), names, byHand } : null;
  }
  // `rows`' summed best deals in `currency`, null until every one is priced — once per gid, since a
  // package's rows each carry the whole package's deal.
  function sumBestDeals(rows: readonly Game[], currency: string): number | null {
    const deals = onePerGid(rows).map((r) =>
      r.bestDealPrice == null ? null : convert(r.bestDealPrice, r.priceCurrency ?? currency, currency),
    );
    return deals.every((d) => d != null) ? deals.reduce((sum, d) => sum! + d!, 0)! : null;
  }
  // The selected picks already owned (a package only when every row of it is): they cost a pick but
  // add nothing, so the saving leaves them out.
  const selectedOwnedGids = createMemo(() => {
    const owned = new Map<string | number, boolean>();
    for (const r of selectedRows()) {
      const key = gidOf(r.appid) ?? r.appid;
      owned.set(key, (owned.get(key) ?? true) && !!r.inLibrary);
    }
    return new Set([...owned].filter(([, all]) => all).map(([key]) => key));
  });
  // What the plan saves over the picks not owned at their best deals; an object, so a 0 sum still shows.
  function pickSaving(plan: PickPlan): { amount: number; text: string; overpays: boolean } | null {
    const owned = selectedOwnedGids();
    const amount = sumBestDeals(
      selectedRows().filter((r) => !owned.has(gidOf(r.appid) ?? r.appid)),
      plan.currency,
    );
    return amount == null ? null : { amount, ...savingsText(plan.cost, amount, plan.currency, regionCurrency()) };
  }

  // The pressed tier, read back from the filter so the table's own Clear filters unpresses it; a
  // memo, so another column's range doesn't rebuild the hero.
  const activeTier = createMemo(() => {
    const meta = bundleMeta();
    const t = tableReady() ? filterTable() : null;
    return meta && t ? activeTierPrice(t.filter.ranges().tierPrice, meta.tiers) : null;
  });
  function bundleHeroTiles(): HeroTile[] {
    const meta = bundleMeta();
    if (!meta) return [];
    const tiles: HeroTile[] = [];
    // Until this bundle's table is ready, a chip would act on the previous one's (or none).
    const t = tableReady() ? filterTable() : null;
    const toggles = t ? filterTiers(meta.tiers) : [];
    const tierPrice = activeTier();
    const tierText = (tier: BundleTierSummary) =>
      tier.price == null
        ? 'Varies'
        : `${tier.quantity ? `${tier.quantity} for ` : ''}${formatWithEstimate(tier.price, tier.currency ?? regionCurrency(), regionCurrency())}`;
    // Price first, then what it adds, then the deadline: a phone's swipeable row shows only the first few.
    if (meta.tiers.length > 0) {
      const ratesUnknown = meta.model === 'pick' && !meta.picks.length;
      tiles.push({
        label: BUNDLE_MODEL_LABELS[meta.model],
        sub:
          meta.model === 'tiered'
            ? 'each includes the cheaper ones'
            : ratesUnknown
              ? 'priced by how many you pick, on the shop'
              : meta.model === 'pick'
                ? 'the more you pick, the less each'
                : undefined,
        chips: meta.tiers.map((tier) => {
          const text = tier.addon ? `${tierText(tier)} add-on` : tierText(tier);
          if (tier.addon || !toggles.length)
            return {
              text,
              title: tier.addon
                ? `${tier.gameCount} game${tier.gameCount === 1 ? '' : 's'} bought on their own, apart from any tier`
                : tier.quantity
                  ? `Pick any ${tier.quantity} of the ${tier.gameCount} games`
                  : `${tier.gameCount} game${tier.gameCount === 1 ? '' : 's'} at this price`,
              active: !!tier.quantity && pickPlan()?.tier.quantity === tier.quantity,
            };
          const price = tier.price!;
          return {
            text,
            title: `Show only what the ${text} tier gets: its games and every cheaper tier's`,
            ariaLabel: `${text} tier`,
            active: tierPrice === price,
            onClick: () =>
              batch(() => {
                t?.filter.clearColumn('tierPrice', 'range');
                if (tierPrice !== price) t?.filter.setRange('tierPrice', 'max', String(price));
              }),
          };
        }),
      });
    }
    // What the bundle adds for the current account: its Steam games not in the library, and what
    // those cost at their best deal right now (summed in the region's currency, currency.ts) —
    // the "is it worth it" sum the table otherwise leaves to the reader. Once ownership is known.
    const account = getEffectiveCurrentAccount();
    if (account && rowsStore.length > 0 && rowsStore.every((r) => r.inLibrary != null)) {
      // Scoped to the pressed tier, so it answers "is this tier worth it" too.
      const rows = tierPrice == null ? rowsStore : rowsStore.filter((r) => atTier(r, tierPrice));
      const fresh = rows.filter((r) => !r.inLibrary);
      const target = regionCurrency();
      const total = sumBestDeals(fresh, target);
      const tier = tierPrice == null ? null : (filterTiers(meta.tiers).find((x) => x.price === tierPrice) ?? null);
      // What the tier that gets every new base game saves over buying them apart (pick & mix: the selection does).
      const freshBase = fresh.filter((r) => !r.addon);
      const payTier = meta.model === 'pick' ? null : savingTier(freshBase, meta.tiers, tierPrice);
      const payDeals = payTier?.currency ? sumBestDeals(freshBase, payTier.currency) : null;
      const saving =
        payTier && payDeals != null ? savingsText(payTier.price!, payDeals, payTier.currency!, target) : null;
      tiles.push({
        label: tier ? `New at ${tierText(tier)}` : 'New to you',
        value: `${fresh.length} of ${rows.length}`,
        sub:
          fresh.length && total != null ? (
            <>
              ≈ {formatMoney(total, target)} at best deals
              <Show when={saving}>
                {(s) => (
                  <>
                    <span
                      class="bundle-tier-saving"
                      style={{ color: s().overpays ? 'var(--bad)' : 'var(--good)' }}
                      title="Against the Steam games' best deals; games not on Steam aren't counted"
                    >
                      {s().text}
                      {meta.model === 'tiered' && tierPrice == null ? ` at ${tierText(payTier!)}` : ''}
                    </span>
                  </>
                )}
              </Show>
            </>
          ) : undefined,
        title: `Games here that aren't in ${accountDisplayLabel(account)}'s library — the ones that are carry a ✓ in the table`,
      });
    }
    if (meta.expiry) {
      const urgency = bundleUrgency(meta.expiry);
      const ended = urgency?.tier === 'ended';
      tiles.push({
        label: 'Ends',
        value: `${ended ? 'Ended ' : ''}${fmtBundleDateTime(meta.expiry)}`,
        sub:
          urgency && urgency.label && !ended ? (
            <span
              class="bundle-ends-rel"
              style={{
                color:
                  urgency.tier === 'urgent'
                    ? scoreColor(20)
                    : urgency.tier === 'soon'
                      ? scoreColor(55)
                      : 'var(--muted)',
              }}
            >
              ⏳ {urgency.label}
            </span>
          ) : undefined,
      });
    }
    // "N of M" whenever some of the bundle's games have no Steam listing at all — the table only
    // holds the ones that do. M is what this route can actually enumerate (rows + the "not on
    // Steam" list below), which isn't necessarily ITAD's own counts.games: flattenBundleGames
    // dedupes a game listed in several tiers, and resolveBundleGames drops a second game mapping
    // to an appid already seen. ITAD's own number is the tile's tooltip rather than a second
    // visible count competing with this one.
    if (bundleResolvedCount() > 0) {
      const unresolved = unresolvedGames().length;
      tiles.push({
        label: 'Games',
        value:
          unresolved > 0 ? `${bundleResolvedCount()} of ${bundleResolvedCount() + unresolved}` : bundleResolvedCount(),
        sub: unresolved > 0 ? 'on Steam' : undefined,
        title: meta.itadCount != null ? `IsThereAnyDeal lists ${meta.itadCount} in this bundle` : undefined,
      });
    }
    // Date only — the hour matters for a deadline, not for when a bundle went live, and the
    // browse table's own Published column still carries it.
    if (meta.publish) tiles.push({ label: 'Published', value: fmtBundleDatePart(meta.publish) });
    // The one Updated tile in the app that isn't also its own refresh control: a bundle is found
    // by walking several cached list pages, so there is no force path to hang on it (see
    // bundleData.ts's fetchBundleById). Stated anyway — the tiers and the end date above are
    // read off this copy — with the tooltip naming what *can* be re-fetched here.
    if (fetchedAt() !== undefined) {
      tiles.push({
        label: 'Updated',
        value: fmtAge(fetchedAt()),
        title:
          "How old the server's cached copy of this bundle is. It can't be forced from here — but each game's own details can (the panel's Refresh details), and so can the prices",
      });
    }
    tiles.push(priceTile());
    return tiles;
  }

  function heroTiles(): HeroTile[] {
    if (kind === 'bundle') return bundleHeroTiles();
    // A comparison that hasn't resolved yet (its empty state, or a player who couldn't be
    // resolved) has no facts to state — a lone "Games 0" tile reads as a result, not as a
    // form waiting to be filled in.
    if (kind === 'compare' && !compareList()) return [];
    if (needsAccount()) return [];
    const tiles: HeroTile[] = [{ label: 'Games', value: rowsStore.length }];
    // Owned/wishlist state their own fetch's age; a comparison or a dynamic list states the
    // oldest of the account fetches it was built from (noteFetchedAt), which is why this is
    // gated on there *being* an age rather than on the kind — a manual list is assembled from
    // stored appids and has none, and neither does the recent list. A list built from account
    // fetches keeps it without one too: a first load that failed is when a retry is wanted.
    const list = combineList();
    if (
      fetchedAt() !== undefined ||
      refreshing() ||
      kind === 'owned' ||
      kind === 'wishlist' ||
      kind === 'creator' ||
      kind === 'game-pass' ||
      (!!list && listHasRefreshableSource(list, sharedGetList))
    ) {
      tiles.push({
        label: 'Updated',
        value: refreshTileValue(refreshing() ? 'Refreshing…' : fetchedAt() === undefined ? '—' : fmtAge(fetchedAt())),
        title:
          kind === 'owned' || kind === 'wishlist'
            ? "How old the server's cached copy of this account's list is — click to force a fresh fetch"
            : kind === 'creator'
              ? "How old the server's copy of Steam's search is — click to search again"
              : kind === 'game-pass'
                ? "How old the server's copy of the PC Game Pass catalog is — click to fetch it again"
                : 'How old the oldest source this list was built from is — click to re-fetch them all',
        // This tile *is* the ↻ Refresh the actions row used to carry: the staleness is stated
        // here, so this is where the reader already is when they decide to do something about it.
        // Prices keep their own age and refresh (a different fetch) on the Prices tile's own
        // sub-line, not here.
        onClick: handleRefreshList,
        disabled: refreshing(),
      });
    }
    if (hasPrices() && !itadOff()) tiles.push(priceTile());
    if (list) {
      if (list.kind === 'dynamic') {
        // A comparison names its sources "Players" — they're people, and calling them sources
        // would be the data model talking rather than the screen.
        tiles.push({ label: kind === 'compare' ? 'Players' : 'Sources', value: (list.sources ?? []).length });
        if (groupCount() > 0) tiles.push({ label: 'Groups', value: groupCount() });
      }
      const p = list.kind === 'ranked' ? rankingProgress() : null;
      if (p) {
        // Measured against the chosen games while some are left: the whole source's estimate
        // (thousands of comparisons) says nothing about a session meant to rank five.
        const chosen = chosenProgress();
        const excluded = p.excluded ? `${p.excluded} excluded` : '';
        tiles.push({
          label: 'Ranked',
          value: `${p.ranked} / ${p.ranked + p.pending}`,
          sub: chosen
            ? `${chosen.pending} chosen left · ≈ ${chosen.remaining} comparison${chosen.remaining === 1 ? '' : 's'}`
            : p.pending
              ? `≈ ${p.remaining} comparison${p.remaining === 1 ? '' : 's'} left`
              : 'Complete',
          title:
            [chosen && p.pending ? `≈ ${p.remaining} comparison${p.remaining === 1 ? '' : 's'} for all` : '', excluded]
              .filter(Boolean)
              .join(' · ') || undefined,
        });
      }
    }
    // Folder/Edited are facts about a *stored* list — a comparison has neither.
    const stored = userList();
    if (stored) {
      const folder = folderPathLabel(stored);
      if (folder)
        tiles.push({
          label: 'Folder',
          value: (
            <>
              <Folder /> {folder}
            </>
          ),
        });
      // "Edited", not "Updated": this is when the list's own definition last changed, which for a
      // dynamic list says nothing about how fresh its resolved contents are (those are recomputed
      // on every open) — unlike the owned/wishlist tile above, which is exactly a data age.
      tiles.push({ label: 'Edited', value: fmtAge(stored.updatedAt), title: `Created ${fmtAge(stored.createdAt)}` });
    }
    return tiles;
  }

  // What sort of list this is, when the name/route doesn't already say — a user list's manual/
  // dynamic nature and, for a dynamic one, which combine op produced what's on screen. A bundle
  // shows its shop chip instead; owned/wishlist show whose account it is.
  function heroKindLabel(): string | null {
    const list = combineList();
    // A comparison's mode select, right beside the title, already says it.
    if (!list || kind === 'compare') return null;
    if (list.kind === 'ranked') return 'Ranked list';
    return list.kind === 'manual' ? 'Manual list' : opLabel(list.op);
  }

  // A dynamic list's formula, as the sources that built it — each linked to its own address, each
  // carrying what it contributed ("Alice — Owned 343 ∪ Alice — Wishlist 115 = 458"). Nothing else
  // in the app says what a dynamic list is made of: its contents are recomputed on every open, so
  // a page showing 458 rows under a name someone chose months ago was otherwise unexplainable
  // without going back to Home and reading the combine form.
  // Per load: each bundle source's games with no Steam listing (createDefaultFetchers' onBundleLeftOut).
  let bundleLeftOut = new Map<string, number>();
  function noteLeftOut(bundleId: string, notOnSteam: number): void {
    bundleLeftOut.set(bundleId, notOnSteam);
  }
  // Per load: PC Game Pass's games with no Steam listing (createDefaultFetchers' onGamePassLeftOut).
  let gamePassLeftOut: number | undefined;
  function leftOutOf(list: GameList, i: number): number | undefined {
    const ref = listDeps(list)[i];
    if (ref?.kind === 'game-pass') return gamePassLeftOut;
    return ref?.kind === 'bundle' && ref.bundleId ? bundleLeftOut.get(ref.bundleId) : undefined;
  }
  // Per load: each capped developer/publisher source's total on Steam (createDefaultFetchers' onCreatorCapped).
  let creatorCapped = new Map<string, number>();
  function noteCapped(role: CreatorRole, name: string, total: number): void {
    creatorCapped.set(`${role}:${name}`, total);
  }
  function cappedOf(list: GameList, i: number): number | undefined {
    const ref = listDeps(list)[i];
    return ref?.kind === 'developer' || ref?.kind === 'publisher'
      ? creatorCapped.get(`${ref.kind}:${ref.name}`)
      : undefined;
  }
  function formulaNote(list: GameList): JSX.Element | undefined {
    const sources = listSources();
    if (!sources.length) return undefined;
    const symbol = OP_SYMBOLS[list.op ?? 'union'];
    const problems = sources.filter((source) => source.desc.problem);
    const ranked = list.kind === 'ranked';
    return (
      <>
        <div class="list-formula">
          {ranked && <span class="list-formula-op">Ranking of</span>}
          <For each={sources}>
            {(source, i) => (
              <>
                {i() > 0 && <span class="list-formula-op">{symbol}</span>}
                <span class="list-formula-source" classList={{ 'has-problem': source.desc.problem != null }}>
                  <Show when={source.desc.href} fallback={<span>{source.desc.label}</span>}>
                    {(href) => <A href={withAccountParam(href())}>{source.desc.label}</A>}
                  </Show>
                  <span class="list-formula-count">{source.count}</span>
                  <Show when={source.leftOut}>
                    {(n) => (
                      <span class="list-formula-leftout" title="Games in this bundle with no Steam listing">
                        ({n()} not on Steam, left out)
                      </span>
                    )}
                  </Show>
                  <Show when={source.capped}>
                    {(total) => (
                      <span
                        class="list-formula-leftout"
                        title="Steam's search returns its most relevant games first; only these count here"
                      >
                        (first {source.count} of about {total()})
                      </span>
                    )}
                  </Show>
                </span>
              </>
            )}
          </For>
          {/* The result is this list's own row count — for group-by-membership that's the union
              across its groups, which is exactly what the ∪ join above claims. */}
          <Show when={!ranked}>
            <span class="list-formula-op">=</span>
            <span class="list-formula-result">{rowsStore.length}</span>
          </Show>
        </div>
        <Show when={problems.length > 0}>
          <ul class="list-formula-problems">
            <For each={problems}>
              {(problem) => (
                <li>
                  <TriangleAlert /> {problem.desc.label} — {problem.desc.problem}.
                  {problem.desc.countsAsEmpty && ' It counts as no games; the rest of the formula still applies.'}
                </li>
              )}
            </For>
          </ul>
        </Show>
      </>
    );
  }

  function heroNote(): JSX.Element | undefined {
    // ITAD's own editorial note ("Keys expire. Please redeem before …") — often the most human
    // thing on the page.
    if (kind === 'bundle') return bundleMeta()?.note || undefined;
    // Recently Looked Up is pure local search history (recentGames.ts) — worth saying outright,
    // since every other list here is either someone's Steam data or a list they built on purpose.
    if (kind === 'recent')
      return `The last ${MAX_RECENT_GAMES} games you looked up in this browser — local search history, never sent anywhere.`;
    const list = combineList();
    if (list?.kind === 'dynamic' || list?.kind === 'ranked') return formulaNote(list);
    if (kind === 'owned')
      return playtimeHidden() ? "No playtime to profile: it's private, or nothing was played yet." : undefined;
    if (kind === 'creator') return creatorNote();
    if (kind === 'game-pass') return gamePassNote();
    return undefined;
  }

  function gamePassNote(): JSX.Element | undefined {
    if (!gamePass()) return undefined;
    return (
      <>
        The Steam games in PC Game Pass's catalog for {regionLabel(regionCode())}. Game Pass plays them through the Xbox
        app, not Steam.{' '}
        <a href="https://www.xbox.com/xbox-game-pass/pc-game-pass" target="_blank" rel="noopener">
          PC Game Pass on Xbox ↗
        </a>
      </>
    );
  }

  function creatorNote(): JSX.Element | undefined {
    const result = creatorResult();
    if (!result) return undefined;
    const name = creatorName();
    if (!result.total) {
      return (
        <a href={steamSearchUrl({ term: name })} target="_blank" rel="noopener">
          Search the Steam store for "{name}" ↗
        </a>
      );
    }
    const all = (
      <a href={steamSearchUrl({ [creatorRole()]: name })} target="_blank" rel="noopener">
        All on Steam ↗
      </a>
    );
    return result.capped ? (
      <>
        Steam's {rowsStore.length} most relevant of about {result.total} — sorting ranks only these. {all}
      </>
    ) : (
      <>
        Every game on Steam whose {creatorRole()} is exactly "{name}". {all}
      </>
    );
  }

  // A comparison player's hours on a game, summed over a Family's members.
  const playerHours = (player: (typeof comparePlayers)[number]) => (appid: number) => {
    const minutes = player.owners.get(appid)?.reduce((sum, o) => sum + o.minutes, 0);
    return minutes ? minutes / 60 : 0;
  };
  // Once every row's details are in, like Plays mostly.
  const groupFits = createMemo(() => {
    const rows = kind === 'compare' && loadedRows();
    return rows ? playerFits(rows, comparePlayers.map(playerHours)) : null;
  });
  // Profiles need every player's whole library among the rows: Intersect and Subtract drop some.
  const profilesShown = () => compareOp() === 'group-by-membership' || compareOp() === 'union';
  const playerProfiles = createMemo(() => {
    const rows = kind === 'compare' && profilesShown() && loadedRows();
    if (!rows) return null;
    const players = comparePlayers.map((player) => {
      const hours = playerHours(player);
      const ofRow = (g: { appid: number }) => hours(g.appid);
      const style = playStyle(rows, ofRow);
      return {
        label: player.label,
        avatarUrl: player.avatarUrl,
        tags: topPlayedTags(rows, PLAYER_TAGS_SHOWN, ofRow).tags.map((t) => t.tag),
        style,
        archetype: archetypeOf(style, storyGames(rows, ofRow), { family: player.family }),
        lately: [...player.owners]
          .map(([appid, owners]) => ({ appid, minutes: recentMinutes(owners)! }))
          .filter((g) => g.minutes > 0 && rowStore.getRow(g.appid))
          .sort((a, b) => b.minutes - a.minutes)
          .slice(0, LATELY_SHOWN),
      };
    });
    const compared = comparePlayers.map((player): ComparedPlayer => ({
      owns: (appid) => player.owners.has(appid),
      hours: playerHours(player),
    }));
    return { players, ground: commonGround(rows, compared), compared, rows };
  });
  // Defaults to the first player with a profile who isn't me (my ★ or current account): suggesting
  // to myself is what Taste fit does.
  const [suggestTarget, setSuggestTarget] = createSignal<number | null>(null);
  const suggestTo = () => {
    const chosen = suggestTarget();
    if (chosen != null) return chosen;
    const me = [getMyAccount()?.id, getCurrentAccount()?.id];
    const profiled = (i: number) => !!playerProfiles()?.players[i].tags.length;
    const first = (ok: (i: number) => boolean) => comparePlayers.findIndex((p, i) => ok(i) && !me.includes(p.id));
    return [first(profiled), first(() => true)].find((i) => i >= 0) ?? 0;
  };
  const suggestions = createMemo(() => {
    const profiles = playerProfiles();
    const target = suggestTo();
    return profiles && suggestionsFor(profiles.rows, profiles.compared, target);
  });
  // At least two players with a profile: each line then says what sets that player apart.
  const compared = (profiles: NonNullable<ReturnType<typeof playerProfiles>>) =>
    profiles.players.filter((p) => p.tags.length).length >= 2;
  const sharedNote = (shared: number) => `share ${shared} of their top ${TOP_TAGS} tags`;
  function playersSummary(profiles: NonNullable<ReturnType<typeof playerProfiles>>): string {
    const { players, ground } = profiles;
    const shared = players.length === 2 && ground.pairs[0].shared;
    return shared === false || shared == null
      ? `Players (${players.length})`
      : `Players · ${players[0].label} & ${players[1].label} ${sharedNote(shared)}`;
  }
  function similarityNote(profiles: NonNullable<ReturnType<typeof playerProfiles>>): string | null {
    const { players, ground } = profiles;
    const parts = [
      ground.closest &&
        `Closest: ${players[ground.closest.a].label} & ${players[ground.closest.b].label} ${sharedNote(ground.closest.shared)}`,
      ground.oddOneOut != null && `Odd one out: ${players[ground.oddOneOut].label}`,
    ].filter((part) => !!part);
    return parts.length ? parts.join(' · ') : null;
  }
  // A game as its store art, name and caption, opening its panel.
  const gameArt = (appid: number, caption: string) => (
    <button type="button" class="players-game" onClick={() => openGame(rowStore.getRow(appid)!)}>
      <GameArt art={artOf(appid)} large />
      <span class="players-game-name">{rowStore.getRow(appid)?.name}</span>
      <span class="players-game-caption">{caption}</span>
    </button>
  );
  // The table's larger capsule, else the smaller one.
  const artOf = (appid: number) => {
    const row = rowStore.getRow(appid);
    return row?.thumb ?? row?.capsule ?? null;
  };
  const tagButton = (tag: string) => (
    <button
      type="button"
      class="list-plays-mostly-tag"
      aria-pressed={tableReady() && isTagActive('tags', tag)}
      title={`Filter by ${tag}`}
      onClick={() => {
        onTagClick('tags', tag);
        // An open Players can push the table off a phone's screen: show what the tag did.
        const toolbar = document.querySelector('.dt-toolbar');
        if (toolbar && toolbar.getBoundingClientRect().top > innerHeight / 2)
          toolbar.scrollIntoView({ block: 'start', behavior: smoothScroll() });
      }}
    >
      {tag}
    </button>
  );
  const [playersOpen, setPlayersOpen] = createSignal(window.matchMedia('(min-width: 768px)').matches);
  function playersSection(): JSX.Element | undefined {
    if (kind !== 'compare') return undefined;
    return (
      <Show when={compareList()}>
        <Show
          when={profilesShown()}
          fallback={
            <p class="list-players-switch">
              Comparing the players' tastes needs their whole libraries.{' '}
              <button
                type="button"
                class="btn"
                onClick={() => navigate(compareUrl(compareSlots(), DEFAULT_COMPARE_OP))}
              >
                Switch to {OP_LABELS[DEFAULT_COMPARE_OP]}
              </button>
            </p>
          }
        >
          <Show when={playerProfiles()}>
            {(profiles) => (
              <details class="list-players" open={playersOpen()} onToggle={(e) => setPlayersOpen(e.currentTarget.open)}>
                <summary>{playersSummary(profiles())}</summary>
                <ul class="players-cards">
                  <For each={profiles().players}>
                    {(p, i) => (
                      <li class="players-card">
                        <div class="players-card-head">
                          <PlayerAvatar url={p.avatarUrl} label={p.label} index={i()} />
                          <div>
                            <span class="list-players-name">{p.label}</span>
                            <Show
                              when={p.archetype}
                              fallback={
                                <span class="players-card-style">
                                  {p.style
                                    ? STYLE_SENTENCES[p.style]
                                    : p.tags.length
                                      ? ''
                                      : 'too few games played here for a profile'}
                                </span>
                              }
                            >
                              {(archetype) => (
                                <span class="players-card-style">
                                  <ProfileBadge archetype={archetype()} small />
                                  {archetype().name}
                                </span>
                              )}
                            </Show>
                          </div>
                        </div>
                        <Show when={p.lately.length}>
                          <div class="players-card-lately">
                            <span class="profile-label">Playing lately</span>
                            <For each={p.lately}>
                              {(g) => (
                                <button type="button" onClick={() => openGame(rowStore.getRow(g.appid)!)}>
                                  {rowStore.getRow(g.appid)?.name} <span>{fmtHours(hoursFromMinutes(g.minutes))}</span>
                                </button>
                              )}
                            </For>
                          </div>
                        </Show>
                        <Show when={p.tags.length}>
                          <div class="players-card-tags">
                            {/* Once compared, what sets them apart: what they share is under In common. */}
                            <Show when={compared(profiles())} fallback={<For each={p.tags}>{tagButton}</For>}>
                              <For
                                each={profiles().ground.ownTags[i()]}
                                fallback={<span class="list-players-none">no tags of their own</span>}
                              >
                                {tagButton}
                              </For>
                            </Show>
                          </div>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
                <div class="players-ground">
                  <span class="profile-label">
                    <Users /> In common
                  </span>
                  <div class="players-ground-body">
                    <Show
                      when={compared(profiles())}
                      fallback={<span class="list-players-none">needs two players with a profile</span>}
                    >
                      <span class="players-meter">
                        <span class="players-dots" aria-hidden="true">
                          <For each={Array.from({ length: TOP_TAGS }, (_, k) => k < profiles().ground.sharedCount)}>
                            {(on) => <i classList={{ on }} />}
                          </For>
                        </span>
                        {profiles().players.length === 2
                          ? `${profiles().ground.sharedCount} of their top ${TOP_TAGS} tags`
                          : `${profiles().ground.sharedCount} ${profiles().ground.sharedCount === 1 ? 'tag' : 'tags'} in everyone's top ${TOP_TAGS}`}
                      </span>
                      <span class="players-card-tags">
                        <For each={profiles().ground.sharedTags}>{tagButton}</For>
                      </span>
                    </Show>
                    <Show when={similarityNote(profiles())}>{(note) => <p class="players-note">{note()}</p>}</Show>
                  </div>
                  <span class="profile-label">
                    <Heart /> {profiles().players.length === 2 ? 'Both loved' : 'All loved'}
                  </span>
                  <div class="players-games">
                    <For each={profiles().ground.favourites} fallback={<span class="list-players-none">none yet</span>}>
                      {(appid) =>
                        gameArt(
                          appid,
                          profiles()
                            .players.map((p, k) => `${p.label} ${fmtHours(profiles().compared[k].hours(appid))}`)
                            .join(' · '),
                        )
                      }
                    </For>
                  </div>
                  <span class="profile-label">
                    <Gift /> Suggest
                  </span>
                  <div class="players-ground-body">
                    <label class="players-suggest-to">
                      Suggest to{' '}
                      <select value={suggestTo()} onChange={(e) => setSuggestTarget(Number(e.currentTarget.value))}>
                        <For each={profiles().players}>{(p, k) => <option value={k()}>{p.label}</option>}</For>
                      </select>
                    </label>
                    <div class="players-games list-players-suggestions">
                      <For
                        each={suggestions() ?? []}
                        fallback={
                          <span class="list-players-none">
                            {suggestions()
                              ? 'nothing the others played a lot fits yet'
                              : 'too few games played here for a profile'}
                          </span>
                        }
                      >
                        {(s) =>
                          gameArt(
                            s.appid,
                            `${profiles().players[s.from].label} ${fmtHours(s.hours)} · ${s.owns ? 'owns it' : "doesn't own it"}`,
                          )
                        }
                      </For>
                    </div>
                  </div>
                </div>
              </details>
            )}
          </Show>
        </Show>
      </Show>
    );
  }
  // The table's score columns explained in the status line, since a cell's title is hover-only.
  const [tasteFitSource, setTasteFitSource] = createSignal<TasteSource | null>(null);
  const scoreNotes = createMemo(() => {
    const visible = filterTable()?.columns.visible();
    const notes: string[] = [];
    const source = tasteFitSource();
    const tasteNote = source && visible?.has(TASTE_FIT_KEY) && tasteFitNote(source);
    if (tasteNote) notes.push(tasteNote);
    // An open Players says who has no profile; folded (a phone's default), nothing would.
    if (kind === 'compare' && visible?.has(GROUP_FIT_KEY) && loadedRows() && !(playerProfiles() && playersOpen())) {
      const fits = groupFits();
      const left = comparePlayers.filter((_, i) => !fits?.profiled[i]).map((p) => p.label);
      if (left.length) notes.push(`Group fit leaves out ${left.join(', ')}: too few games played here`);
    }
    return notes;
  });
  // Owned's profile alone (no other list renders it), once every row's details are in, so it doesn't reshuffle as they stream.
  const profileRows = () => (kind === 'owned' ? loadedRows() : null);
  // Owned learns its account's taste for Taste fit elsewhere.
  createEffect(() => {
    const rows = profileRows();
    if (!rows) return;
    // Untracked: on an account switch the rows are still the previous account's until the reload.
    const account = untrack(getEffectiveCurrentAccount);
    const taste = account && tasteOf(rows, Date.now());
    const keep = untrack(() => [getMyAccount()?.id, getCurrentAccount()?.id]).filter((id) => id != null);
    if (!taste) return;
    saveTaste(account.id, taste, keep);
    // So Owned's own Taste fit scores on a first visit, and not from a taste stored before a change.
    setTasteFitSource((source) => source && { ...source, taste });
  });
  const playsMostlyProfile = createMemo(() => {
    const rows = profileRows();
    return rows ? topPlayedTags(rows, PLAYS_MOSTLY_SHOWN) : { tags: [], played: 0 };
  });
  const playsMostly = () => playsMostlyProfile().tags;
  const ownStatus = (g: { appid: number }) => (showingMyAccount() ? getStatus(g.appid) : null);
  // Steam's "keep my playtime private" lists every game at 0 h, which reads like an unplayed library.
  const playtimeHidden = createMemo(() => {
    const rows = profileRows();
    return !!rows?.length && !rows.some((g) => g.playtime);
  });
  const profileFacts = createMemo(() => {
    const rows = profileRows();
    if (!rows) return { style: null, story: null };
    const hours = (g: ProfileGame) => (g as Game).playtime ?? 0;
    return { style: playStyle(rows, hours), story: storyGames(rows, hours, ownStatus) };
  });
  // The games Play next lists (listViews.ts), counted the same way so the two agree.
  const unplayed = createMemo(() => {
    const rows = profileRows();
    return rows && !playtimeHidden()
      ? rows.filter((g) => (g.playtime ?? 0) <= PLAY_NEXT_MAX_HOURS && !ownStatus(g)).length
      : 0;
  });
  const backlogShown = () => activeView()?.template === PLAY_NEXT;
  // Opens the Play next view (created the first time), or back to All games when it's open.
  function showBacklog(): void {
    if (backlogShown()) return navigate(viewHref(routerLocation, null));
    let view = templateView('owned', PLAY_NEXT);
    if (!view) {
      view = createFromTemplate(VIEW_TEMPLATES.find((t) => t.id === PLAY_NEXT)!);
      showSelectionStatus(`Saved view ${view.name}`);
    }
    navigate(viewHref(routerLocation, view.id));
  }
  // Out here: the hero note re-renders, which would close the breakdown.
  const [playsMostlyWhy, setPlaysMostlyWhy] = createSignal(false);
  // A Family's profile mixes its members: no archetype titles it.
  const archetype = createMemo(() =>
    archetypeOf(profileFacts().style, profileFacts().story, {
      family: (untrack(getEffectiveCurrentAccount)?.members.length ?? 0) > 1,
    }),
  );
  function ownedProfileSection(): JSX.Element {
    return (
      <OwnedProfile
        archetype={archetype()}
        tags={playsMostly()}
        played={playsMostlyProfile().played}
        styleSentence={profileFacts().style ? STYLE_SENTENCES[profileFacts().style!] : null}
        story={profileFacts().story}
        unplayed={unplayed()}
        playNextHours={PLAY_NEXT_MAX_HOURS}
        backlogShown={backlogShown()}
        whyOpen={playsMostlyWhy()}
        isTagActive={(tag) => tableReady() && isTagActive('tags', tag)}
        onTag={(tag) => onTagClick('tags', tag)}
        onBacklog={showBacklog}
        onWhy={() => setPlaysMostlyWhy((open) => !open)}
        game={(appid) => {
          const row = rowStore.getRow(appid);
          return (
            row && {
              name: row.name,
              art: artOf(appid),
              hours: row.playtime ?? 0,
              main: row.hltbMain ?? null,
              status: ownStatus(row),
            }
          );
        }}
        onGame={(appid) => openGame(rowStore.getRow(appid)!)}
      />
    );
  }

  // A step reloads the hero (load() clears heroTitle), so the pressed ‹/› gets focus back once it's
  // back on screen, unless focus went elsewhere in the meantime.
  let bundleStepFocus: { btn: HTMLElement; id: number } | undefined;
  function stepBundle(id: number | null, btn: HTMLElement): void {
    if (id == null) return;
    bundleStepFocus = { btn, id };
    navigate(withAccountParam(`/lists/bundle/${id}`));
  }
  createEffect(() => {
    if (!heroTitle() || !bundleStepFocus) return;
    if (document.activeElement === document.body) bundleStepFocus.btn.focus();
    bundleStepFocus = undefined;
  });

  // Built once per mount, not per render: `kind` never changes under a mounted route, and every
  // button/link inside reads its own signals, so nothing here needs rebuilding when they change.
  // `undefined` (rather than an empty fragment) for the kinds with no actions at all, so
  // ListHero renders no action row for them instead of an empty one.
  const heroLead: JSX.Element | undefined =
    kind !== 'bundle' ? undefined : (
      <div class="list-hero-nav">
        {/* aria-disabled at the list's ends: a disabled button can't take focus back on the last bundle.
            Plainly disabled off the list (a deep link), where no step could have led. */}
        <button
          type="button"
          class="btn"
          aria-label="Previous bundle"
          title="Previous bundle"
          disabled={bundleNavIndex() === -1}
          aria-disabled={bundleNavIndex() !== -1 && prevBundleId() == null ? 'true' : undefined}
          onClick={(e) => stepBundle(prevBundleId(), e.currentTarget)}
        >
          <ChevronLeft />
        </button>
        <button
          type="button"
          class="btn"
          aria-label="Next bundle"
          title="Next bundle"
          disabled={bundleNavIndex() === -1}
          aria-disabled={bundleNavIndex() !== -1 && nextBundleId() == null ? 'true' : undefined}
          onClick={(e) => stepBundle(nextBundleId(), e.currentTarget)}
        >
          <ChevronRight />
        </button>
        <A class="btn" href={withAccountParam('/bundles', routerLocation.search)}>
          <ArrowLeft /> All bundles
        </A>
      </div>
    );

  const heroActions: JSX.Element | undefined =
    kind === 'recent' ? undefined : (
      <>
        {/* userList() is still null at mount (set once load() resolves it below), so this has to be
          a reactive Show rather than a plain `kind === 'user' && ...` check — the latter would
          freeze at "no list yet" forever, since heroActions itself is only built once. */}
        <Show when={kind === 'user' && userList()?.kind === 'dynamic'}>
          {/* Stays "Edit sources" while open: the form's own Cancel is the one way out it names. */}
          <button
            type="button"
            class="btn"
            ref={editSourcesBtn}
            aria-expanded={editingSources()}
            onClick={() => setEditingSources((v) => !v)}
          >
            Edit sources
          </button>
          {/* Not offered on a `compare`/`shared` list — a comparison is already shareable via its
            own URL, and a shared link re-shared would just point back at the same page. */}
          <button
            type="button"
            class="btn"
            disabled={shareFailure() != null}
            title={shareFailure() ?? 'Copy a link anyone can open, live and without saving it themselves'}
            onClick={(e) => handleShareList(e.currentTarget)}
          >
            <Link /> Share list
          </button>
        </Show>
        <Show when={kind === 'user' && userList()?.kind === 'ranked'}>
          <button
            type="button"
            class="btn btn-primary"
            title="Asks about unranked games in the table's current sort order (only the shown ones, when filtered)"
            disabled={filteredUnranked()?.length === 0}
            onClick={handleCompare}
          >
            {compareLabel()}
          </button>
          <button type="button" class="btn" onClick={() => setEditingRankedSource((v) => !v)}>
            {editingRankedSource() ? 'Cancel' : 'Change source'}
          </button>
        </Show>
        <Show when={viewKind}>
          {(k) => (
            <NewViewMenu
              kind={k()}
              pricesShown={!itadOff()}
              currentView={viewTable.getViewState}
              onCreated={(view) => {
                navigate(viewHref(routerLocation, view.id));
                showSelectionStatus(`Saved view ${view.name}`);
              }}
            />
          )}
        </Show>
        <Show when={rankSourceRef()}>
          <Show
            when={tableReady() && existingRankings().length > 0}
            fallback={
              <>
                {/* aria-disabled, not disabled: a press has to reach the button for its reason to be read. */}
                <button
                  type="button"
                  class={`btn${kind === 'bundle' ? ' hero-secondary' : ''}`}
                  title="Create a list ranking these games by comparing them two at a time, in the table's current order (only the selected or filtered games, if any)"
                  disabled={rankThisListFocus()?.length === 0}
                  aria-disabled={rankTooFew() ? 'true' : undefined}
                  aria-describedby={rankTooFew() ? 'rank-reason' : undefined}
                  onClick={() => handleRankThisList()}
                >
                  <Trophy /> {rankThisListLabel()}
                </button>
                <Show when={rankTooFew()}>
                  <span id="rank-reason" class="rank-reason">
                    Ranking needs at least 2 games
                  </span>
                </Show>
              </>
            }
          >
            <RankMenu />
          </Show>
        </Show>
        {kind === 'shared' && (
          <Show when={compareList()}>
            <button
              type="button"
              class="btn"
              title="Keep this shared list as one of your own"
              onClick={handleSaveShared}
            >
              Save as a list
            </button>
          </Show>
        )}
        {kind === 'shared' && (
          <For each={sharedBundles()}>
            {(b) => (
              <A class="btn" href={withAccountParam(`/lists/bundle/${b.id}`, routerLocation.search)}>
                <ArrowLeft /> {b.title}
              </A>
            )}
          </For>
        )}
        {kind === 'compare' && (
          <>
            {/* Gated on the players in the URL, not on the ones that resolved: a comparison naming
              a private or misspelled profile is exactly when editing them has to be reachable. */}
            <Show when={canEditPlayers()}>
              <button type="button" class="btn hero-secondary" onClick={() => setEditingPlayers((v) => !v)}>
                {editingPlayers() ? 'Cancel' : 'Edit players'}
              </button>
            </Show>
            <Show when={compareList()}>
              {/* Changing how the comparison is combined is a navigation, not local state: the op is
                part of the URL, so a "just the games everyone owns" view is as shareable as the
                grouped one it came from. */}
              <select
                value={compareOp()}
                title="How to combine these players' libraries"
                aria-label="How to combine these players' libraries"
                onChange={(e) => navigate(compareUrl(compareSlots(), e.currentTarget.value))}
              >
                <For each={Object.keys(OP_LABELS) as CombineOp[]}>
                  {(op) => <option value={op}>{OP_LABELS[op]}</option>}
                </For>
              </select>
              <button
                type="button"
                class="btn hero-secondary"
                title="Keep this comparison as a list of your own"
                onClick={handleSaveComparison}
              >
                Save as a list
              </button>
            </Show>
          </>
        )}
        {kind === 'bundle' && (
          <>
            <Show when={bundleLinks().details}>
              {(details) => (
                <a class="btn hero-secondary" href={details()} target="_blank" rel="noopener">
                  View on IsThereAnyDeal ↗
                </a>
              )}
            </Show>
            <Show when={bundleLinks().url}>
              {(url) => (
                <a
                  class="btn"
                  classList={{
                    // One primary per view: picks to buy on Fanatical take it.
                    'btn-primary': !fanaticalPicks(),
                  }}
                  href={url()}
                  target="_blank"
                  rel="noopener"
                >
                  Get this bundle ↗
                </a>
              )}
            </Show>
            <Show when={bundleResolvedCount() > 0 && notOwnedHref({ kind: 'bundle', bundleId: params.bundleId })}>
              {(href) => (
                <A
                  class="btn"
                  href={href()}
                  title="This bundle's games minus the ones you own — save it as a list from there"
                  onClick={() =>
                    rememberBundle(
                      params.bundleId!,
                      heroTitle(),
                      (resolvedBundleGames ?? []).map((g) => g.appid),
                    )
                  }
                >
                  What does this add?
                </A>
              )}
            </Show>
          </>
        )}
        {kind === 'creator' && (
          <Show when={!!creatorResult()?.total && notOwnedHref({ kind: creatorRole(), name: creatorName() })}>
            {(href) => (
              <A
                class="btn"
                href={href()}
                title={`This ${creatorRole()}'s games minus the ones you own — save it as a list from there`}
              >
                What don't I own?
              </A>
            )}
          </Show>
        )}
      </>
    );

  onMount(() => {
    const unregister = registerRouteHandlers({
      pickRandom: pickRandomGame,
      stepGame,
      gamePosition,
      openGame: handleOpenGameRequest,
      onGameClose: handleGameClose,
      refreshGame,
      onTagClick,
      isTagActive,
      getOwners: (appid) =>
        comparePlayers.length ? comparePlayers.flatMap((player) => player.owners.get(appid) ?? []) : null,
      isOwnedList: kind === 'owned',
      similarTo,
      setSimilarTo,
    });
    onCleanup(() => {
      unregister();
      if (comparePlayers.length) notifyOwnersChanged();
    });
  });

  // A bundle (or a list with a bundle source) reloads: its Tier Price comes from the bundle fetch, not the price lookup.
  createEffect(
    on(
      regionCode,
      () => {
        setPriceFetchedAt(undefined);
        if (showsTierPrice() || showsGamePass()) void load();
        else if (hasPrices()) void loadPrices(rowsStore, loadGuard.current());
      },
      { defer: true },
    ),
  );

  // A plain createEffect, not onMount — /lists/bundle/:bundleId, the generic /lists/:listId, and
  // /game/:appid? are each one route *definition* shared across every id, so navigating from one
  // bundle/list/game to another under the same pattern reuses this component instance rather
  // than remounting it. params.bundleId/params.listId/params.appid are read reactively inside
  // load() itself (via the outer `params` object) — referencing them here is what makes this
  // effect re-run on a param-only navigation; 'owned'/'wishlist' have no such param and so only
  // ever run once, identically to the old onMount-based call.
  // Owned/Wishlist reload on another account, or a `?u=` link failing to resolve; no other kind depends on it.
  const accountKey = createMemo(() => `${getEffectiveCurrentAccount()?.id ?? ''}:${getAccountOverrideState().state}`);
  const accountId = createMemo(() => getEffectiveCurrentAccount()?.id);
  // Other kinds keep their rows, but their random-pick history belongs to the previous account.
  createEffect(on(accountId, clearAllRandomQueues, { defer: true }));

  createEffect(() => {
    params.bundleId;
    params.listId;
    params.appid;
    if (kind === 'owned' || kind === 'wishlist') accountKey();
    // A comparison lives entirely in the query string, not the path, so *that* is what has to be
    // read here for editing the players (or the op) to reload without a remount. load()'s own
    // guard is what keeps the canonicalizing rewrite from counting as a change.
    if (kind === 'compare') compareKey();
    // Same reasoning — a shared link's formula lives entirely in ?f=, not the path, so navigating
    // from one shared link to another (no param change, since /lists/shared has none) has to be
    // read here too, or this component instance would just keep showing the first one.
    if (kind === 'shared') sharedFormulaParam();
    if (kind === 'creator') creatorName();
    // Untracked: the reads above are the whole dependency list. load()'s fast path reads the open
    // game, so opening another one re-ran it against the not-yet-updated `params.appid`, reopening
    // the game being left.
    untrack(() => load());
  });

  onCleanup(() => {
    // The panel's own nav bar (renderPanelNav) points at *this* mount's table/getGameList —
    // leaving the route without closing it would leave the panel open on a stale game with a
    // prev/next list that no longer exists once disposeTable runs just below.
    if (isPanelOpen()) panelClose({ leavingRoute: true });
    setBaseTitle(null); // this route's own document.title context — see load()'s setBaseTitle calls
    loadGuard.next(); // invalidate any still-in-flight fetch/stream from this mount
    if (disposeTable) disposeTable();
    if (unsyncView) unsyncView();
  });

  return (
    <div class="list-route">
      {/* One card per list, whatever kind it is (ListHero.tsx) — identity + actions on top, then
          the facts this kind has as labelled tiles. Everything in it rides on fetches the route
          already makes; none of it costs a request. Before it existed only bundles had one, and
          every other kind opened with two or three unlabelled gray lines ("Updated 3h ago", "104
          games", the region readout) that never even said which list — or, for Owned/Wishlist,
          whose account — was on screen. */}
      <Show when={heroTitle()}>
        <ListHero
          title={heroTitle()}
          lead={heroLead}
          // Save only shows with a result, which needs the players Edit players is gated on.
          secondaryActions={kind === 'bundle' || (kind === 'compare' && canEditPlayers())}
          chips={
            <>
              {kind === 'bundle' && (
                <Show when={bundleMeta()?.shop}>
                  {/* Same shopHue/.shop-chip as the browse table's own cells, so a bundle reads
                      the same here as in the picker you arrived from. */}
                  {(shop) => (
                    <span class="shop-chip" style={{ '--shop-hue': String(shopHue(shop())) }}>
                      {shop()}
                    </span>
                  )}
                </Show>
              )}
              <Show when={heroKindLabel()}>{(label) => <span class="list-hero-chip">{label()}</span>}</Show>
              <Show when={heroAccount()}>
                {(account) => (
                  <span class="list-hero-account">
                    <Show when={account().avatarUrl}>
                      {(url) => (
                        <span class="account-avatar-wrap">
                          <img class="account-avatar" src={url()} alt="" width="28" height="28" />
                        </span>
                      )}
                    </Show>
                    {/* /profiles/<steam64> rather than the vanity URL Steam itself returns: the
                        AccountSlot carries no profile URL (see setHeroAccount's own comment), and
                        this form resolves for every account either way. A Family has no one
                        profile to link to, so it stays plain text with a merge count instead. */}
                    <Show
                      when={account().members.length === 1}
                      fallback={
                        <span>
                          {accountDisplayLabel(account())}{' '}
                          <span class="account-count">({account().members.length} accounts merged)</span>
                        </span>
                      }
                    >
                      <a
                        class="account-profile-link"
                        href={`https://steamcommunity.com/profiles/${account().members[0]}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`Steam ID ${account().members[0]}`}
                      >
                        {accountDisplayLabel(account())} <span class="account-profile-arrow">↗</span>
                      </a>
                    </Show>
                  </span>
                )}
              </Show>
            </>
          }
          actions={heroActions}
          tiles={heroTiles()}
          note={heroNote()}
          section={kind === 'owned' ? ownedProfileSection() : playersSection()}
        />
      </Show>
      <Show when={viewKind}>{(k) => <ViewTabs kind={k()} activeId={activeView()?.id ?? null} />}</Show>
      {/* The players form is this route's empty state (fewer than two players in the URL) and its
          edit affordance (the hero's "Edit players"), never a third thing — see
          ComparePlayersForm.tsx on why it lives here rather than on Home. Keyed on the URL's own
          slots so reopening it after a change starts from what's actually on screen. */}
      <Show when={kind === 'compare' && compareFailures().length > 0 && !editingPlayers()}>
        <div class="compare-failures" role="alert">
          <For each={compareFailures()}>
            {(f) => (
              <p>
                <TriangleAlert /> <strong>{f.identifiers.join(' + ')}</strong> — {f.message}
              </p>
            )}
          </For>
          <div class="compare-failures-actions">
            <Show when={compareSlots().length - compareFailures().length >= 2}>
              <button type="button" class="btn btn-primary" onClick={compareOthers}>
                Compare the other {compareSlots().length - compareFailures().length}
              </button>
            </Show>
            <button type="button" class="btn" onClick={() => setEditingPlayers(true)}>
              Edit players
            </button>
          </div>
        </div>
      </Show>
      <Show when={kind === 'compare' && (compareSlots().length < 2 || editingPlayers())}>
        {/* `initialSlots` seeds the form's own draft state and is deliberately not a live
            mirror of the URL — it's an editing buffer. */}
        <ComparePlayersForm
          initialSlots={compareSlots()}
          invalid={compareFailures().flatMap((f) => f.identifiers)}
          submitLabel={compareSlots().length < 2 ? 'Compare libraries' : 'Compare'}
          onCancel={editingPlayers() ? () => setEditingPlayers(false) : undefined}
          onSubmit={(slots) => {
            setEditingPlayers(false);
            navigate(compareUrl(slots, compareOp()));
          }}
        />
      </Show>
      {/* The hero's "Edit sources" action reopens the same combine form used at creation
          (HomeRoute.tsx), pre-filled from this list's own op/sources, saving in place via
          updateDynamicList (same id/folder position — see docs/dev/lists-and-accounts.md). Name
          isn't editable here (renaming is Home's Rename action; updateDynamicList takes no name). */}
      <Show when={kind === 'user' && userList()?.kind === 'dynamic' && editingSources()}>
        <CombineForm
          initialOp={userList()!.op}
          initialSources={userList()!.sources}
          excludeListId={userList()!.id}
          showName={false}
          submitLabel="Save sources"
          onCancel={() => {
            setEditingSources(false);
            editSourcesBtn?.focus();
          }}
          onSubmit={handleUpdateDynamicList}
        />
      </Show>
      <Show when={kind === 'user' && userList()?.kind === 'ranked' && editingRankedSource()}>
        <div class="combine-form">
          <label>
            Rank the games of{' '}
            <select
              value={refKey(userList()!.source!)}
              onChange={(e) => handleChangeRankedSource(e.currentTarget.value)}
            >
              <For each={rankedSourceOptions()}>{(o) => <option value={o.key}>{o.label}</option>}</For>
            </select>
          </label>
          <p>Answers already given are kept, and apply again to any game that's in the new source too.</p>
        </div>
      </Show>
      <div class="list-status">
        <Show when={needsAccount()} fallback={<Show when={statusText()}>{(text) => <span>{text()}</span>}</Show>}>
          No account selected — <A href="/">pick one on Home</A>.
        </Show>
        <Show when={loadFraction()}>
          {(fraction) => (
            <progress class="list-progress" value={fraction()} max={1} aria-label="Loading game details" />
          )}
        </Show>
        <Show when={failedSummary()}>{(text) => <span class="list-failed">{text()}</span>}</Show>
        <For each={scoreNotes()}>{(note) => <span class="list-score-note">{note}</span>}</For>
        <Show when={bundleFailedCount()}>
          {(n) => (
            <span class="list-failed">Steam didn't answer for {n()} of this bundle's games — reload to retry</span>
          )}
        </Show>
        <Show when={gamePass()?.failed}>
          {(n) => (
            <span class="list-failed">Steam didn't answer for {n()} of PC Game Pass's games — reload to retry</span>
          )}
        </Show>
      </div>
      <Show when={hasPrices() || kind === 'bundle'}>
        <div
          class="price-status"
          classList={{ 'list-failed': !!priceStatusText() && priceStatusText() !== PRICES_UNAVAILABLE }}
        >
          {priceStatusText()}
        </div>
      </Show>
      {/* Outside the selection-gated block below on purpose — "Add"/"Remove" both clear the
          selection right after acting (Add explicitly; Remove via load()'s own reset), and the
          whole point of this message is to confirm what just happened *after* that clears. */}
      <div
        class="selection-status"
        classList={{ 'is-visible': !!selectionActionStatus() }}
        role="status"
        onMouseEnter={holdSelectionStatus}
        onMouseLeave={(e) => e.currentTarget.contains(document.activeElement) || resumeSelectionStatus()}
        onFocusIn={holdSelectionStatus}
        onFocusOut={(e) => e.currentTarget.matches(':hover') || resumeSelectionStatus()}
      >
        {selectionActionStatus()?.text}
        <Show when={selectionActionStatus()?.listId}>{(listId) => <A href={`/lists/${listId()}`}>Open list</A>}</Show>
      </div>
      {/* A shared link's layout has its own banner. */}
      <Show when={tableReady() && !viewingShared() && layout()}>
        {(l) => (
          <UnsavedChangesBanner
            name={layoutName()}
            changes={l().changes()}
            note={layoutNote()}
            onSave={() => l().save()}
            onDiscard={() => l().discard()}
          />
        )}
      </Show>
      <Show when={viewAwaitsPrices()}>
        <p class="list-note" role="status">
          Prices are still loading: this view filters on them.
        </p>
      </Show>
      <Show when={viewId() && !activeView()}>
        <p class="list-note">This view no longer exists; showing the whole list.</p>
      </Show>
      <Show when={tableReady() && viewingShared()}>
        <SharedViewBanner
          edited={sharedViewEdited()}
          onKeep={() => {
            setViewingShared(false);
            layout()?.save();
          }}
          onDiscard={handleDiscardSharedView}
        />
      </Show>
      <Show when={emptyText()}>
        <p class="list-empty">{emptyText()}</p>
      </Show>
      <div ref={tableContainer} class="table-container" classList={{ 'table-container--empty': !!emptyText() }} />
      {/* The bundle's games with no Steam listing at all (a course, an asset pack, a shop-exclusive
          key) — there's nothing for the table to show about them (no rating/HLTB/price/ownership),
          but dropping them silently made the table look like the whole bundle. Collapsed by
          default, with the count in the summary, so nothing is hidden even when it's closed —
          which matters: for a bundle of courses these can be the *majority* of what you're buying. */}
      <Show when={offSteamGames().length > 0}>
        <div class="unresolved-games">
          <button
            type="button"
            class="unresolved-summary"
            aria-expanded={unresolvedOpen()}
            onClick={() => setUnresolvedOpen(!unresolvedOpen())}
          >
            <ChevronRight class="unresolved-chevron" /> {offSteamGames().length} more in{' '}
            {kind === 'game-pass' ? GAME_PASS_TITLE : 'this bundle'}, not on Steam
          </button>
          <Show when={unresolvedOpen()}>
            <ul class="unresolved-list">
              <For each={offSteamGames()}>
                {(game) => (
                  <li>
                    <a href={game.href} target="_blank" rel="noopener">
                      {game.title}
                    </a>
                    <Show when={game.type}>
                      <span class="unresolved-type">{game.type}</span>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </Show>
      {/* Last, and stuck to the bottom: appearing above the table shifted every row under the pointer. */}
      <Show when={selectedRows().length > 0}>
        <div class="selection-toolbar">
          <span class="selection-count">{selectedRows().length} selected</span>
          <Show when={pickPlan()}>
            {(plan) => (
              <>
                <span class="selection-pick-cost">
                  <output class="selection-pick-total" aria-live="polite">
                    {formatWithEstimate(plan().cost, plan().currency, regionCurrency())}
                  </output>
                  <span class="selection-pick-detail">{pickPlanDetail(plan(), selectedPickCount())}</span>
                </span>
                <Show when={pickSaving(plan())}>
                  {(saving) => (
                    <span
                      class="selection-pick-savings"
                      style={{ color: saving().overpays ? 'var(--bad)' : 'var(--good)' }}
                      title={`vs ${formatMoney(saving().amount, plan().currency)} for the games you don't own at their best deals`}
                    >
                      {saving().text}
                    </span>
                  )}
                </Show>
                <Show when={selectedOwnedGids().size}>
                  {(owned) => (
                    <span class="selection-pick-owned" style={{ color: 'var(--owned)' }}>
                      {owned()} you own · not in the saving
                    </span>
                  )}
                </Show>
                <Show when={fanaticalPicks()}>
                  {(picks) => (
                    <span class="selection-fanatical">
                      <a
                        class="btn btn-primary"
                        href={picks().url}
                        target="_blank"
                        rel="noopener"
                        title="Opens the bundle on Fanatical through IsThereAnyDeal's link; click the Add to Fanatical bookmark there to add these games"
                      >
                        Buy {selectedPickCount()} on Fanatical ↗
                      </a>
                      <a
                        class="selection-fanatical-bookmarklet"
                        href={FANATICAL_BOOKMARKLET}
                        title="Drag to your bookmarks bar once, then click it on the Fanatical page to add the selected games"
                        onClick={(e) => {
                          e.preventDefault();
                          showSelectionStatus(
                            'Drag "Add to Fanatical" to your bookmarks bar, then click it on the Fanatical page.',
                          );
                        }}
                      >
                        Add to Fanatical
                      </a>
                      <Show when={picks().byHand.length}>
                        <span class="selection-fanatical-by-hand" title={picks().byHand.join('\n')}>
                          {picks().byHand.length} to pick by hand
                        </span>
                      </Show>
                    </span>
                  )}
                </Show>
              </>
            )}
          </Show>
          <select value={addTarget()} aria-label="Add to list" onChange={(e) => setAddTarget(e.currentTarget.value)}>
            <option value="">Add to list…</option>
            <For each={manualLists().filter((l) => l.id !== userList()?.id)}>
              {(l) => <option value={l.id}>{l.name}</option>}
            </For>
            <option value={NEW_LIST_OPTION}>Create new list…</option>
          </select>
          <Show when={addTarget() === NEW_LIST_OPTION}>
            <input
              type="text"
              class="selection-new-list-name"
              placeholder="New list name"
              aria-label="New list name"
              value={newListName()}
              ref={(el) => queueMicrotask(() => el.focus())}
              onInput={(e) => setNewListName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleAddSelectedToList();
              }}
            />
          </Show>
          <button
            type="button"
            disabled={!addTarget() || (addTarget() === NEW_LIST_OPTION && !newListName().trim())}
            onClick={handleAddSelectedToList}
          >
            Add
          </button>
          <Show when={kind === 'user' && userList()?.kind === 'manual'}>
            <button type="button" onClick={handleRemoveSelectedFromList}>
              Remove from this list
            </button>
          </Show>
          <Show when={kind === 'user' && userList()?.kind === 'ranked'}>
            <button
              type="button"
              disabled={!selectedUnranked().length}
              title={
                selectedUnranked().length
                  ? 'Ask only about the selected games that are still unranked'
                  : 'All selected games are ranked or excluded — Re-rank them first'
              }
              onClick={handleCompareSelected}
            >
              Rank {selectedUnranked().length} selected
            </button>
            <button
              type="button"
              title="Ask about it again, starting from its current place"
              onClick={handleRerankSelected}
            >
              Re-rank
            </button>
            <button type="button" title="Leave out of the ranking" onClick={handleExcludeSelected}>
              Exclude
            </button>
          </Show>
          <button type="button" onClick={() => table?.selection.clear()}>
            Clear selection
          </button>
        </div>
      </Show>
    </div>
  );
}
