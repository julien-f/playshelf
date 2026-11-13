// /bundles — browse/discover current Steam bundles via IsThereAnyDeal (see
// docs/dev/frontend.md). Opening a bundle
// here always navigates to /lists/bundle/:bundleId (ListRoute.tsx's `bundle` kind) rather than
// rendering the resolved game table inline the way the legacy bundles.tsx page did — this route
// is only ever the "which bundle do you want" picker, not the bundle detail view too.
//
// The bundle list itself is a real @vates/data-table-solid table, the same viewer every list of
// games in the app already goes through — it replaced a hand-rolled row-of-flexbox-<button>s list
// ported from bundles.tsx, which had three problems this fixes wholesale: it was capped at a
// 260px scroll box (a legacy holdover from when the list sat *above* the opened bundle's own game
// table on one page — on this route the list *is* the page, with nothing below it to protect),
// its columns couldn't align across rows (each row being its own independent flex container, the
// leftover space its proportional title/shop items divided up differed per row depending on how
// wide that row's price/count/expiry text happened to be), and it had no filtering at all — only
// the server-side sort/"include expired" controls. Sorting is now the table's own, so the sort
// <select> is gone too; only "include expired" still round-trips to the server (see load()).
//
// A bundle row is not a Game, so this route has its own small column set rather than anything
// from gameColumns.ts — but it reuses that file's generic bucket/compare helpers (price tiers,
// missing-value grouping) so a price/date/count column here groups and sorts the same way its
// counterpart does in a game table.
import { createSignal, createEffect, createMemo, on, onMount, onCleanup, Show } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { withAccountParam } from './urlState.ts';
import { createTableState, DataTableView, datePartGroup, numericRangeGroup } from '@vates/data-table-solid';
import { cascadeFirstRows, slideRowsOnViewChange } from './motion.ts';
import type { ColumnDef } from '@vates/data-table-solid';
import { fmt, compareDateMissingLast, compareNumMissingLast, priceTierGroup } from './gameColumns.ts';
import { fmtDateTime, renderDateTime } from './dateTime.ts';
import { fadeInOnLoad, fmtAge, formatMoney, oldestFetchedAt, scoreColor } from './utils.ts';
import {
  toBundleRow,
  bundleUrgency,
  shopHue,
  bundleEndsIn,
  compareEndsIn,
  ENDS_IN,
  bundleAge,
  compareBundleAge,
  BUNDLE_AGE,
  bundleOwnership,
  type BundleListItem,
  type BundleOwnership,
  type BundleRow,
  type GidAppids,
} from './bundleRows.ts';
import { currentRegion, regionCurrency, regionLabel } from './region.ts';
import { setBrowsedBundles } from './bundleBrowseStore.ts';
import { openPrefsPopover } from './prefsPopover.tsx';
import { shareTableView, resetTableView, bindViewPersistence, prefViewStore, layoutDraft } from './tableViewPrefs.ts';
import { createStaleGuard } from './staleGuard.ts';
import { SharedViewBanner } from './SharedViewBanner.tsx';
import { UnsavedChangesBanner, ViewActions } from './TableViewControls.tsx';
import { useBaseTitle } from './pageTitle.ts';
import { convert, formatWithEstimate } from './currency.ts';
import { ListHero, refreshTileValue, type HeroTile } from './ListHero.tsx';
import { fetchBundlePage, isUnavailable, loadErrorText, resolveBundleAppids } from './bundleData.ts';
import { accountDisplayLabel, getEffectiveCurrentAccount } from './accountsStore.ts';
import { peekMyOwnership } from './myOwnership.ts';
import { BUNDLES_UNAVAILABLE } from './priceLoading.ts';
import { isItadOff } from './panelData.ts';

const PAGE_SIZE = 50; // ITAD's own max per page (lib/itad.js's getBundles `limit`)
// How many pages load() fetches back-to-back before handing over to the "Load more" button. The
// active list is ~30-40 bundles in practice (one page, so it always loads in full — which is what
// makes client-side filtering/sorting over the *whole* set meaningful rather than over an
// arbitrary first page); only "Include expired" reaches ITAD's much larger archive, which is what
// this cap and the button exist for.
const MAX_AUTO_PAGES = 4;
// Fixed — the table owns user-facing ordering now, so this only needs to be a stable order for
// paging through. Newest-first also means a capped expired load keeps the most recent archive.
const FETCH_SORT = '-publish';

const VIEW_PREF_KEY = 'bundlesBrowseView';
// /api/bundles/resolve's cap (server.js MAX_BUNDLE_RESOLVE_GAMES).
const RESOLVE_CHUNK = 500;

// ── Cell rendering ────────────────────────────────────────────────────────────────────────────

// A 2×2 block of the bundle's first four game banners, standing in for the bundle cover ITAD
// doesn't have (see bundleCovers). Same shape as the game tables' own capsule column — an
// unlabelled, unsortable/unfilterable/ungroupable leading identity column whose images hide
// themselves rather than showing a broken-image icon if a URL 404s. A bundle with fewer than four
// games carrying artwork simply fills fewer cells; the grid's own tracks keep every row's block
// the same size regardless, so the column stays aligned.
function renderCovers(_value: unknown, row: BundleRow): Node {
  const wrap = document.createElement('div');
  wrap.className = 'bundle-covers';
  for (const src of row.covers) {
    const img = document.createElement('img');
    img.className = 'bundle-cover';
    img.alt = '';
    img.loading = 'lazy';
    img.width = 80;
    img.height = 30;
    img.src = src;
    fadeInOnLoad(img);
    img.addEventListener('error', () => {
      img.style.visibility = 'hidden';
    });
    wrap.appendChild(img);
  }
  return wrap;
}

function renderBundleTitle(value: unknown): Node {
  const span = document.createElement('span');
  span.className = 'bundle-title';
  span.textContent = value == null || value === '' ? '—' : String(value);
  return span;
}

// Hue from the shop name itself (shopHue), so a shop ITAD adds tomorrow gets its own consistent
// color with no code change; saturation/lightness live in `.shop-chip`'s own CSS so no hash can
// produce an unreadable chip. Doubles as the group header when grouping by Shop — the table falls
// back to a column's own `render` for a group with no `groupFormat`, which is what's wanted here.
function renderShop(value: unknown): Node {
  const span = document.createElement('span');
  if (value == null || value === '') {
    span.textContent = '—';
    return span;
  }
  const name = String(value);
  span.className = 'shop-chip';
  span.style.setProperty('--shop-hue', String(shopHue(name)));
  span.textContent = name;
  return span;
}

// The above, plus — for a bundle actually about to go — a colored relative countdown, the one
// column on a bundle *browse* page where "act now" is real information rather than trivia. Colors
// are scoreColor's own tiers, the same scale every other urgency/quality signal in the app uses
// (Best Deal's record badges, Price Status), rather than a second palette meaning the same thing.
function renderEnds(value: unknown): Node {
  const urgency = bundleUrgency(value as string | null);
  // `later`'s empty label deliberately renders nothing at all — see bundleUrgency.
  let rel: HTMLSpanElement | undefined;
  if (urgency && urgency.label) {
    rel = document.createElement('span');
    rel.className = 'bundle-ends-rel';
    rel.textContent = urgency.tier === 'ended' ? urgency.label : `⏳ ${urgency.label}`;
    rel.style.color =
      urgency.tier === 'urgent' ? scoreColor(20) : urgency.tier === 'soon' ? scoreColor(55) : 'var(--muted)';
  }
  // An expired row is dimmed as a whole (the table's rowClass), so nothing further here.
  return renderDateTime(value, rel);
}

function inRegionCurrency(amount: number, currency: string | null | undefined): number {
  return convert(amount, currency ?? regionCurrency(), regionCurrency()) ?? amount;
}

const COLUMNS: ColumnDef<BundleRow>[] = [
  {
    key: 'covers',
    label: 'Image',
    width: 188,
    sortable: false,
    filterable: false,
    groupable: false,
    value: () => null,
    render: renderCovers,
  },
  { key: 'title', label: 'Bundle', type: 'string', groupable: false, format: fmt.str, render: renderBundleTitle },
  { key: 'shop', label: 'Shop', type: 'string', groupable: true, format: fmt.str, render: renderShop },
  {
    key: 'games',
    label: 'Games',
    type: 'number',
    groupable: true,
    format: fmt.num,
    defaultSortDir: 'desc',
    compare: compareNumMissingLast,
    ...numericRangeGroup(10, '', '—'),
  },
  {
    // Bucketed against the same PRICE_TIERS staircase every game-table price column uses, and
    // "Varies" (not "—") for a null price, matching the bundle detail table's own Tier Price
    // column — a pick-and-mix bundle genuinely has no single tier price, which is not the same as
    // missing data. compareNumMissingLast for the same reason it carries one there: under the
    // default numeric comparator `null` coerces to 0 and sorts as the cheapest thing in the table.
    key: 'price',
    label: 'Cheapest Tier',
    type: 'number',
    groupable: true,
    // Sorted, filtered and bucketed in the region's currency (currency.ts's approximate rates):
    // some shops only price in USD, and "$6 < €10" is not an order. Shown in the shop's own.
    value: (row) => (row.price == null ? null : inRegionCurrency(row.price, row.currency)),
    format: (v, row) =>
      // no row for a standalone value (filter chip, range bound): `v` is already in region currency
      !row
        ? v == null
          ? 'Varies'
          : formatMoney(v as number, regionCurrency())
        : row.price == null
          ? 'Varies'
          : `${row.pickQuantity ? `${row.pickQuantity} for ` : ''}${formatWithEstimate(row.price, row.currency ?? regionCurrency(), regionCurrency())}`,
    compare: compareNumMissingLast,
    ...priceTierGroup(() => regionCurrency(), 'Varies'),
  },
  { key: 'tierCount', label: 'Tiers', type: 'number', groupable: true, format: fmt.num },
  // Published before Ends — a bundle's own life order, and the default sort's column sits next to
  // the ones it's read against rather than at the far end of the row.
  {
    key: 'publish',
    label: 'Published',
    type: 'date',
    groupable: true,
    format: (v) => fmtDateTime(v as string | null),
    render: (v) => renderDateTime(v),
    compare: compareDateMissingLast,
    defaultSortDir: 'desc',
    defaultValueSort: { by: 'alpha', dir: 'desc' },
    ...datePartGroup('month', undefined, '—'),
  },
  // Hidden by default, the publish-side counterpart of "Ends in" below, and what the hero's "New"
  // tile toggles.
  {
    key: 'age',
    label: 'Age',
    type: 'string',
    groupable: true,
    value: (row) => bundleAge(row.publish),
    format: fmt.str,
    compare: compareBundleAge,
  },
  {
    key: 'expiry',
    label: 'Ends',
    type: 'date',
    groupable: true,
    format: (v) => fmtDateTime(v as string | null),
    render: renderEnds,
    compare: compareDateMissingLast,
    defaultValueSort: { by: 'alpha', dir: 'asc' },
    ...datePartGroup('month', undefined, '—'),
  },
  // Hidden by default: the Ends column already carries each row's own countdown, so this one
  // exists to filter/group *by* urgency — and it's what the hero card's "Ending soon" tile
  // toggles. A `value()` accessor rather than a field on BundleRow,
  // deliberately against this file's flatten-at-fetch rule: the tier is clock-relative, so it has
  // to be recomputed on each pass rather than frozen at the moment the row was fetched. Its
  // `Ended` bucket is also how Active and Expired rows are told apart under "Include expired" —
  // the hidden Status column that used to be the way to do that said nothing this doesn't.
  {
    key: 'endsIn',
    label: 'Ends in',
    type: 'string',
    groupable: true,
    value: (row) => bundleEndsIn(row.expiry),
    format: fmt.str,
    compare: compareEndsIn,
  },
];

// A count against the current account: "…" while loading, "—" when unknown (no account, a failed lookup, an expired bundle).
function ownershipColumn(
  key: string,
  label: string,
  ownershipOf: (row: BundleRow) => BundleOwnership | null | undefined,
  count: (o: BundleOwnership) => number | null,
  text: (n: number) => string,
  // Said on hover: the cell's base is the bundle's Steam games, not the Games column's count.
  what: string,
  color?: string,
): ColumnDef<BundleRow> {
  const valueOf = (row: BundleRow) => {
    const o = ownershipOf(row);
    return o ? count(o) : null;
  };
  const cellText = (row: BundleRow) => {
    const o = ownershipOf(row);
    if (o === undefined) return '…';
    const n = o && count(o);
    return n == null ? '—' : text(n);
  };
  return {
    key,
    label,
    type: 'number',
    groupable: true,
    searchable: false,
    defaultSortDir: 'desc',
    value: valueOf,
    format: (v, row) => (row ? cellText(row) : v == null ? '—' : String(v)),
    render: (_v, row) => {
      const span = document.createElement('span');
      span.textContent = cellText(row);
      const o = ownershipOf(row);
      const n = valueOf(row);
      if (o && n != null) span.title = `${n} of ${o.steam} Steam games ${what}`;
      if (color && n) span.style.color = color;
      return span;
    },
    compare: compareNumMissingLast,
  };
}

const DEFAULT_VISIBLE = ['covers', 'title', 'shop', 'games', 'wishlist', 'newToYou', 'price', 'publish', 'expiry'];
// Newest first. This is a discovery page — "what's new since I last looked" is the browsing
// question — and a publish date never changes, so the order is stable between visits rather than
// reshuffling daily the way an ending-soonest sort does as deadlines approach and rows drop off.
// "What's about to go" is covered without the sort: renderEnds colors anything inside a week, so
// an expiring bundle catches the eye wherever it happens to sit.
const DEFAULT_SORT = [{ key: 'publish', dir: 'desc' as const }];

export default function BundlesBrowseRoute() {
  const navigate = useNavigate();
  const [rows, setRows] = createSignal<BundleRow[]>([]);
  const [statusText, setStatusText] = createSignal('');
  const [unavailable, setUnavailable] = createSignal(isItadOff());
  const [includeExpired, setIncludeExpired] = createSignal(false);
  const [moreAvailable, setMoreAvailable] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  // Toggling "Include expired" mid-load would otherwise let the old request's pages append
  // themselves onto the new list — the whole point of this route reloading from offset 0.
  const loadGuard = createStaleGuard();
  let offset = 0;

  // gid → Steam appid(s), shared by every load: a game's appid doesn't depend on the region or the list.
  const [appidsByGid, setAppidsByGid] = createSignal<ReadonlyMap<string, GidAppids>>(new Map());
  const [failedGids, setFailedGids] = createSignal<ReadonlySet<string>>(new Set());
  const requested = new Set<string>();
  const account = createMemo(getEffectiveCurrentAccount);
  // Expired bundles aren't resolved: ITAD's archive is unbounded, each page ~600 lookups on a cold cache.
  createEffect(
    on([rows, () => !!account()], async ([list, hasAccount]) => {
      if (!hasAccount) return;
      const gids = [...new Set(list.flatMap((r) => (r.status === 'Expired' ? [] : r.gids)))].filter(
        (g) => !requested.has(g),
      );
      for (const g of gids) requested.add(g);
      for (let i = 0; i < gids.length; i += RESOLVE_CHUNK) {
        const chunk = gids.slice(i, i + RESOLVE_CHUNK);
        let failed: string[];
        try {
          const res = await resolveBundleAppids(chunk);
          setAppidsByGid((prev) => new Map([...prev, ...Object.entries(res.appids)]));
          failed = res.failed;
        } catch {
          failed = chunk;
        }
        if (failed.length) setFailedGids((prev) => new Set([...prev, ...failed]));
      }
    }),
  );
  // One ownership peek per pass, as myOwnership.ts asks.
  const ownership = createMemo(() => {
    if (!account()) return new Map(rows().map((r) => [r.id, null]));
    const peek = peekMyOwnership();
    const map = appidsByGid();
    const failed = failedGids();
    return new Map(
      rows().map((r) => [r.id, r.status === 'Expired' ? null : bundleOwnership(r.gids, map, failed, peek.status)]),
    );
  });
  const ownershipOf = (row: BundleRow) => ownership().get(row.id);
  const ownershipNote = () => {
    if (!rows().length) return '';
    if (!account()) return 'Pick an account on Home to see which bundles hold wishlisted or owned games';
    if (rows().some((r) => ownership().get(r.id) === null && r.status !== 'Expired'))
      return "Steam didn't answer for some bundles' games: their Wishlist and New to you read —";
    return '';
  };

  const table = createTableState<BundleRow>(
    rows,
    [
      ...COLUMNS.slice(0, 4),
      ownershipColumn(
        'wishlist',
        'Wishlist',
        ownershipOf,
        (o) => o.wishlist,
        (n) => (n ? `☆ ${n}` : ''),
        'on the wishlist',
        'var(--wishlisted)',
      ),
      ownershipColumn(
        'newToYou',
        'New to you',
        ownershipOf,
        (o) => (o.owned == null ? null : o.steam - o.owned),
        String,
        'not owned',
      ),
      ownershipColumn(
        'owned',
        'Owned',
        ownershipOf,
        (o) => o.owned,
        (n) => (n ? `✓ ${n}` : ''),
        'owned',
        'var(--owned)',
      ),
      ...COLUMNS.slice(4),
    ],
    {
      initialViewState: { pageSize: 50, visibleCols: DEFAULT_VISIBLE, sorts: DEFAULT_SORT },
    },
  );
  let tableContainer: HTMLDivElement | undefined;
  cascadeFirstRows(
    () => table.processedData().length,
    () => tableContainer,
  );
  slideRowsOnViewChange(table, () => tableContainer);
  // The layout as a draft until Save; a 🔗 Share layout link's layout is shown but not saved until kept.
  const layout = layoutDraft(table, VIEW_PREF_KEY, prefViewStore(VIEW_PREF_KEY));
  const [viewingShared, setViewingShared] = createSignal(layout.restore());
  const [sharedViewEdited, setSharedViewEdited] = createSignal(false);
  // eslint-disable-next-line solid/reactivity -- bindViewPersistence reads it in its own effect
  onCleanup(bindViewPersistence(table, layout.store, viewingShared, setSharedViewEdited));
  function handleDiscardSharedView(): void {
    table.setViewState(layout.store.load());
    setViewingShared(false);
  }
  // Feeds /lists/bundle/:bundleId's prev/next nav (see bundleBrowseStore.ts) — off processedData,
  // not the raw row list, so ‹/› steps through exactly what's on screen in the order it's shown,
  // including whatever filter/sort/search the user has applied here.
  createEffect(() => setBrowsedBundles(table.processedData().map((b) => ({ id: b.id, title: b.title }))));

  // Oldest page write time across this load (a load pulls several pages); undefined = nothing
  // loaded yet, which renders no readout rather than a premature "just now".
  const [fetchedAt, setFetchedAt] = createSignal<number | null | undefined>(undefined);
  function noteFetchedAt(at: number | null): void {
    setFetchedAt((prev) => oldestFetchedAt(prev, at));
  }

  async function fetchPage(refresh = false): Promise<BundleListItem[]> {
    const { bundles, fetchedAt: at } = await fetchBundlePage({
      country: currentRegion(),
      sort: FETCH_SORT,
      expired: includeExpired(),
      offset,
      limit: PAGE_SIZE,
      refresh,
    });
    noteFetchedAt(at);
    return bundles;
  }

  async function load({
    append = false,
    refresh = false,
  }: { append?: boolean; refresh?: boolean } = {}): Promise<void> {
    const gen = loadGuard.next();
    if (!append) {
      offset = 0;
      setRows([]);
      setFetchedAt(undefined);
    }
    setLoading(true);
    setStatusText(append ? 'Loading more bundles…' : 'Loading bundles…');
    try {
      const collected: BundleRow[] = [];
      let reachedEnd = false;
      for (let page = 0; page < (append ? 1 : MAX_AUTO_PAGES); page++) {
        const bundles = await fetchPage(refresh);
        if (loadGuard.isStale(gen)) return;
        collected.push(...bundles.map((b) => toBundleRow(b, undefined, regionCurrency())));
        offset += bundles.length;
        if (bundles.length < PAGE_SIZE) {
          reachedEnd = true;
          break;
        }
      }
      setRows(append ? [...rows(), ...collected] : collected);
      setMoreAvailable(!reachedEnd);
      setUnavailable(false);
      // The table renders its own row count, so there's nothing left to say once rows exist.
      setStatusText(rows().length ? '' : 'No current bundles');
    } catch (err) {
      if (loadGuard.isStale(gen)) return;
      setUnavailable(isUnavailable(err));
      setStatusText(loadErrorText(err));
    } finally {
      if (!loadGuard.isStale(gen)) setLoading(false);
    }
  }

  // A memo, so writing the same region again doesn't reload.
  const regionCode = createMemo(currentRegion);
  createEffect(on(regionCode, () => void load(), { defer: true }));

  // The hero's "Ending soon" tile as a filter toggle over the hidden "Ends in" column — same
  // include-set-only shape as ListRoute.tsx's panel pills, so it never touches the table filter
  // dropdown's separate exclude state, and clearing it from there clears the tile's pressed state
  // with it.
  const endingSoonOnly = () => table.filter.include().endsIn?.has(ENDS_IN.urgent) ?? false;
  const toggleEndingSoonOnly = () => table.filter.setValues('endsIn', [ENDS_IN.urgent], !endingSoonOnly());
  // Same, over the Age column — the other half of the browsing question this page exists for.
  // A week rather than the tile below's 48h, and both of the column's own sub-week buckets at
  // once (its checklist is OR within a column): bundles publish in waves, so a 24h window is
  // empty most days — observed live, the newest of 43 active bundles was 62 hours old.
  const NEW_WINDOW: string[] = [BUNDLE_AGE.fresh, BUNDLE_AGE.week];
  const newOnly = () => NEW_WINDOW.every((v) => table.filter.include().age?.has(v));
  const toggleNewOnly = () => table.filter.setValues('age', NEW_WINDOW, !newOnly());
  // A range rather than a value checklist: "at least one", and an unknown count (null) never matches.
  const wishlistOnly = () => table.filter.ranges().wishlist?.min === '1';
  const toggleWishlistOnly = () => table.filter.setRange('wishlist', 'min', wishlistOnly() ? '' : '1');

  // The same hero card every list route now opens with (ListHero.tsx) — this route is the one you
  // arrive at a bundle *from*, so a loose toolbar here next to a real card there was a visible
  // seam between two adjacent screens. Deliberately thin: no bundle count (the table's own
  // toolbar already renders "37 / 37 rows", and unlike a fixed tile it follows the filters) and
  // no derived stats beyond the one below, since the Ends/Shop columns already group and filter.
  function heroTiles(): HeroTile[] {
    const tiles: HeroTile[] = [];
    // Always rendered, unlike the other tiles: this one *is* the ↻ Refresh control now (the
    // button that used to sit in the actions row did exactly what clicking it does), so it has to
    // be there on the paths that have no age to report — mid-load, and after a load that failed
    // before it ever fetched, which is precisely when a retry is wanted.
    tiles.push({
      label: 'Updated',
      value: refreshTileValue(loading() ? 'Refreshing…' : fetchedAt() === undefined ? '—' : fmtAge(fetchedAt())),
      title:
        "How old the server's cached copy of this list is — a bundle can go live or expire at any time. Click to re-fetch",
      onClick: () => load({ refresh: true }),
      disabled: loading(),
    });
    tiles.push({
      label: 'Prices',
      value: regionLabel(regionCode()),
      title: 'Prices are shown for this region — click to change it in Preferences',
      onClick: openPrefsPopover,
    });
    // The publish-side twin of the tile below: this is a discovery page, and its default sort is
    // newest-first precisely because "what appeared since I last looked" is the question — but
    // nothing counted it. Same rules as that one throughout (processedData, absent at zero unless
    // its own filter is what emptied it).
    const fresh = table.processedData().filter((row) => NEW_WINDOW.includes(bundleAge(row.publish))).length;
    if (fresh > 0 || newOnly()) {
      tiles.push({
        label: 'New',
        value: fresh,
        valueColor: scoreColor(80),
        sub: newOnly() ? 'in the last 7 days · only these' : 'in the last 7 days',
        title: newOnly() ? 'Showing only these — click to clear' : 'Show only the bundles published in the last 7 days',
        active: newOnly(),
        onClick: toggleNewOnly,
      });
    }
    // The one thing this page can say that nothing else does at a glance: the Ends column shows
    // each row's own countdown, but finding the ones about to go means sorting by it first — which
    // is also why this tile is the one that clicks (toggleEndingSoonOnly).
    // Counted off processedData rather than the raw list, so it agrees with whatever filter/search
    // is applied — a "3 ending soon" that includes rows the table isn't showing is worse than
    // nothing. Absent at zero rather than showing a reassuring "0" nobody asked about.
    // Counted off processedData like the tiles around it; absent without an account or wishlisted game.
    const acct = account();
    const wished = table.processedData().filter((row) => (ownershipOf(row)?.wishlist ?? 0) > 0).length;
    if (acct && (wished > 0 || wishlistOnly())) {
      tiles.push({
        label: 'Wishlist',
        value: wished,
        valueColor: 'var(--wishlisted)',
        sub: wishlistOnly() ? 'bundles with wishlisted games · only these' : 'bundles with wishlisted games',
        title: wishlistOnly()
          ? 'Showing only these — click to clear'
          : `Show only the bundles holding games on ${accountDisplayLabel(acct)}'s wishlist`,
        active: wishlistOnly(),
        onClick: toggleWishlistOnly,
      });
    }
    const endingSoon = table.processedData().filter((row) => bundleUrgency(row.expiry)?.tier === 'urgent').length;
    // Kept on screen while its own filter is on even at a count of zero — otherwise the last
    // urgent bundle expiring (or a reload dropping it) leaves the table filtered down to nothing
    // with the control that filtered it gone.
    if (endingSoon > 0 || endingSoonOnly()) {
      tiles.push({
        label: 'Ending soon',
        value: endingSoon,
        valueColor: scoreColor(20),
        sub: endingSoonOnly() ? 'within 48h · only these' : 'within 48h',
        title: endingSoonOnly() ? 'Showing only these — click to clear' : 'Show only the bundles ending within 48h',
        active: endingSoonOnly(),
        onClick: toggleEndingSoonOnly,
      });
    }
    return tiles;
  }

  onMount(() => {
    if (!unavailable()) void load();
  });
  useBaseTitle(() => 'Bundles');

  return (
    <div class="bundles-browse-route">
      <ListHero
        title="Bundles"
        actions={
          unavailable() ? undefined : (
            <>
              {/* A data-scope control, not a view one — it round-trips to ITAD (see load()) — so it
                sits here rather than with the table-view buttons in the toolbar. */}
              <label class="bundles-expired-toggle">
                <input
                  type="checkbox"
                  checked={includeExpired()}
                  onChange={(e) => {
                    setIncludeExpired(e.currentTarget.checked);
                    load();
                  }}
                />
                Include expired
              </label>
            </>
          )
        }
        tiles={unavailable() ? undefined : heroTiles()}
        note={
          unavailable()
            ? `${BUNDLES_UNAVAILABLE} Whoever runs it can turn Bundles and prices on with a free IsThereAnyDeal API key.`
            : undefined
        }
      />
      <Show when={!unavailable()}>
        <Show when={viewingShared()}>
          <SharedViewBanner
            edited={sharedViewEdited()}
            onKeep={() => {
              setViewingShared(false);
              layout.save();
            }}
            onDiscard={handleDiscardSharedView}
          />
        </Show>
        <Show when={!viewingShared()}>
          <UnsavedChangesBanner
            name="your bundles layout"
            changes={layout.changes()}
            note="kept in this tab until you save or discard."
            onSave={() => layout.save()}
            onDiscard={() => layout.discard()}
          />
        </Show>
        <Show when={statusText() || ownershipNote()}>
          <div class="bundles-status">{statusText() || ownershipNote()}</div>
        </Show>
        <div class="table-container" ref={tableContainer}>
          <DataTableView<BundleRow>
            table={table}
            rowKey="id"
            rowClass={(row) => (row.status === 'Expired' ? 'bundle-row--expired' : undefined)}
            onRowClick={(row) => navigate(withAccountParam(`/lists/bundle/${row.id}`))}
            toolbarEnd={
              <ViewActions
                onShare={(btn) => shareTableView(table, btn)}
                onReset={() => resetTableView(table, layout.store)}
              />
            }
          />
        </div>
        <Show when={moreAvailable()}>
          <button type="button" class="btn" disabled={loading()} onClick={() => load({ append: true })}>
            Load more
          </button>
        </Show>
      </Show>
    </div>
  );
}
