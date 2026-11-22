import {
  fmtAge,
  fmtPlaytime,
  formatMoney,
  scoreColor,
  dealRecordTier,
  DEAL_RECORD_TIERS,
  fmtLastPlayed,
  computeSteamdbRating,
  focusGameRow,
  fadeInOnLoad,
  safeHref,
  fmtReleaseDate,
  MEDIA_FAILED,
  metaOrBasics,
} from './utils.ts';
import { openLightbox, openLightboxFrom, lightboxShot, lightboxOpen } from './lightbox.tsx';
import { isMorphUpdating, loadedWhen, morph } from './viewTransition.ts';
import { prefersReducedMotion } from './motion.ts';
import { sampleArtTint } from './artTint.ts';
import { decideSwipeAxis, type SwipeAxis } from './lightboxSwipe.ts';
import { pushOverlayEntry, popOverlayEntry } from './overlayHistory.ts';
import { gameMediaItems, mediaLabel, resolveShotIndex } from './mediaItems.ts';
import type { MediaItem } from './mediaItems.ts';
import { getMyOwnershipStatus, getOwnersFor, myOwnershipVersion, peekMemberNames } from './myOwnership.ts';
import type { OwnershipStatus } from './myOwnership.ts';
import { STATUS_LABELS, getStatus, setStatus, type GameStatus } from './gameStatuses.ts';
import { sortOwners, ownerMeterPct } from './ownerList.ts';
import type { GameOwner } from './accountData.ts';
import { accountDisplayLabel, getEffectiveCurrentAccount, showingMyAccount } from './accountsStore.ts';
import {
  achievementsAccountKey,
  fetchNews,
  fetchAchievements,
  achievementsRefusal,
  fetchPrice,
  priceRefusal,
  fetchOffers,
  offersRefusal,
  fetchDlc,
  isItadOff,
} from './panelData.ts';
import type {
  DlcEntry,
  GameBundle,
  PanelAchievements,
  PanelOffers,
  PanelDlc,
  PanelNews,
  PanelPrice,
} from './panelData.ts';
import { bestPickRate, bundleUrgency, pickTiers } from './bundleRows.ts';
import {
  aboutSummary,
  achievementsSummary,
  dlcSummary,
  newsSummary,
  ownedBySummary,
  similarSummary,
  tagsSummary,
  capitalize,
  linuxDeckSummary,
  priceSummary,
  protonTierColor,
  ratingSummary,
  spacedHours,
  toBeatSummary,
} from './panelSummaries.ts';
import { PanelTileRow, PanelWideCard, type PanelCardDef } from './panelCards.tsx';
import { isPanelCardOpen } from './panelOpenCards.ts';
import { fmtDateTime } from './dateTime.ts';
import { formatWithEstimate } from './currency.ts';
import { currentRegion, regionCurrency } from './region.ts';
import { nextHopHistory } from './panelHistory.ts';
import { similarInLibrary } from './tagTaste.ts';
import { loadTaste } from './tasteCache.ts';
import { clearPanelNav } from './panelNav.ts';
import type { PanelHistoryEntry } from './panelHistory.ts';
import { setGameTitle } from './pageTitle.ts';
import { TIER_RANGE_TITLE } from './bundleData.ts';
import { withAccountParam, urlWithoutPanel } from './urlState.ts';
import { copyWithFeedback } from './clipboard.ts';
import type { DetailsAges, GameMeta, PriceFields, ReadonlyGame } from './types.ts';

import { createSignal, createEffect, createMemo, createResource, createRoot, For, Show, type JSX } from 'solid-js';
import { Dynamic, render } from 'solid-js/web';
import { A, useLocation, useCurrentMatches } from '@solidjs/router';
import { creatorListPath, type CreatorRole } from './creatorData.ts';
import { present, presented, privateMode, stopPresenting } from './presentation.ts';
import Kbd from './Kbd.tsx';
import ArrowUpDown from 'lucide-solid/icons/arrow-up-down';
import Check from 'lucide-solid/icons/check';
import ChevronLeft from 'lucide-solid/icons/chevron-left';
import CircleDollarSign from 'lucide-solid/icons/circle-dollar-sign';
import Ellipsis from 'lucide-solid/icons/ellipsis';
import ListPlus from 'lucide-solid/icons/list-plus';
import { announce } from './announce.ts';
import { addToManualList, getLists, removeAppidsFromList } from './listsStore.ts';
import Gamepad2 from 'lucide-solid/icons/gamepad-2';
import Globe from 'lucide-solid/icons/globe';
import Link from 'lucide-solid/icons/link';
import Newspaper from 'lucide-solid/icons/newspaper';
import Package from 'lucide-solid/icons/package';
import RefreshCw from 'lucide-solid/icons/refresh-cw';
import ShoppingCart from 'lucide-solid/icons/shopping-cart';
import Star from 'lucide-solid/icons/star';
import Ticket from 'lucide-solid/icons/ticket';
import Timer from 'lucide-solid/icons/timer';
import Cast from 'lucide-solid/icons/cast';
import ThumbsUp from 'lucide-solid/icons/thumbs-up';
import Trophy from 'lucide-solid/icons/trophy';
import Users from 'lucide-solid/icons/users';
import Info from 'lucide-solid/icons/info';
import Tag from 'lucide-solid/icons/tag';
import Sparkles from 'lucide-solid/icons/sparkles';
import Wallet from 'lucide-solid/icons/wallet';
import Wrench from 'lucide-solid/icons/wrench';
import X from 'lucide-solid/icons/x';
import { focusVisible, keepFocus } from './focusHandoff.ts';

// A pick-and-mix bundle has no tier price; its best quantity rate stands in, as on its own page.
function bundleTierText(b: GameBundle): string {
  if (b.tierPrice != null && b.tierPriceMax != null)
    return `${formatMoney(b.tierPrice, b.tierCurrency)}–${formatMoney(b.tierPriceMax, b.tierCurrency)} tier`;
  if (b.tierPrice != null) return `${formatMoney(b.tierPrice, b.tierCurrency)} tier`;
  const region = regionCurrency();
  const rate = bestPickRate(pickTiers(b.pickAndMix, region));
  return rate ? `from ${formatWithEstimate(rate.amount, rate.currency, region, '/game')}` : 'Varies';
}

// The shell's hooks, passed once to initPanel.
interface PanelOptions {
  onTagClick: (dim: string, val: string) => void;
  tagsFilterable: () => boolean; // false: tags render as plain pills
  isTagActive: (dim: string, val: string) => boolean;
  onRefresh: (game: ReadonlyGame) => void;
  onListChanged: (listId: string) => void; // a manual list gained or lost the open game
  onNavigateGame: (appid: number, name: string) => void;
  onClose: (opts?: { leavingRoute?: boolean }) => void;
  // The route's own owners for a game (a comparison's players), over the current account's.
  getOwners: (appid: number) => GameOwner[] | null;
  hasOwners: () => boolean; // static per route, so the Owned by tile never appears late
  getOwnerMembers: () => string[] | null; // the route's owners' names, over the account's members'
  hasList: () => boolean;
  isOwnedList: () => boolean;
  similarTo: () => number | null;
  setSimilarTo: (appid: number | null) => void;
}

// ── Shared game side panel ──────────────────────────────────────────────────
// Mounted once by AppShell.tsx's single `initPanel(options)` call (see docs/dev/panel-and-lightbox.md), not
// per-route — ListRoute.tsx, SearchRoute.tsx and RankRoute.tsx (the callers of `panelOpen`) just open/close it,
// never configure it; `PanelOptions` are the shell's hooks, which relay to the mounted route. A
// real Solid component (converted from the original panel.ts's hand-rolled innerHTML rebuilds):
// `initPanel(options)` mounts it once into the static `#panel-body` element every page's own
// markup already has; `panelOpen(game)`/`panelClose()` show/hide it. Anything page-specific —
// tag-click filtering, the nav bar's list of games — is left to the host page via options or by
// wrapping panelOpen/panelClose with its own extra logic.
//
// Every exported function below keeps its exact original name/signature (every host page's
// import is untouched by this conversion) — the one
// deliberate behavior difference is internal: `panelOptions.onClose` still exists because
// panelClose() itself is called from more places than just the host's own code (the × button
// and swipe-to-close both call it directly) — a host that needs to run cleanup on every close
// (not just the ones it explicitly triggers) should do it there rather than in a wrapper around
// panelClose(), which those other paths would silently bypass.
//
// Docked, not modal (see docs/dev/panel-and-lightbox.md and style.css's own "App shell layout"
// comment): the panel is a sibling column next to whatever list/content is showing, not an
// overlay — no backdrop element, no click-outside-to-close, no `inert`-toggling of the
// background (there's nothing to make inert; the rest of the page stays fully interactive
// while the panel is open). `.open` still gates visibility (hidden entirely when no game is
// open, shown as a column when one is), it just means something different in the CSS now.
//
// Reactivity model — three kinds of state, no "please re-render" call anywhere:
//
//  1. The panel's own UI state (`panelGame`/`heroIdx`/`openHeaderMenu`/`panelHistory`/
//     `revealedAchievements`/`achievementsFilter`/`panelRefreshing`) — plain signals, set directly
//     by this file's own click handlers; which cards are open is panelOpenCards.ts's pref.
//  2. The open game's data — read straight off the game object, which is a Solid *store* row
//     owned by whichever route loaded it (see rowStore.ts). A field written as the details
//     stream lands patches only what renders that field.
//  3. Everything the panel fetches for itself (news, achievements, owners, ownership, price,
//     DLC) — a `createResource` each, keyed on whichever game is open (see "Per-game async
//     data" below), with the fetching itself in panelData.ts.
//
// This replaced a `revision` counter signal and an exported `renderPanelBody(game)` that bumped
// it: host routes (and this file's own loaders) mutated plain `Game` objects, which Solid cannot
// see, so ~30 call sites had to announce every write, and each announcement re-rendered the
// entire panel body. See docs/dev/frontend.md's Reactivity section for the full story — and note
// what the shape below is *for*: `npm run lint`'s `solid/reactivity` rule is what keeps a plain
// `const x = someSignal()` / `const g = props.game.field` capture from quietly reintroducing the
// same class of bug.
let panelOptions: PanelOptions;
const [panelGame, setPanelGame] = createSignal<ReadonlyGame | null>(null);
const [heroIdx, setHeroIdx] = createSignal(0);
// The hero's index within a game's `length` media: a stale one from a longer list would overrun it.
const clampedHeroIdx = (length: number) => Math.max(0, Math.min(heroIdx(), length - 1));
let panelPrevFocus: HTMLElement | null = null;
const [panelRefreshing, setPanelRefreshing] = createSignal(false); // true while the host's onRefresh() is in flight
// The header menu open, if any: "⋯ More actions" or the lists holding the game.
type HeaderMenu = 'more' | 'lists';
const [openHeaderMenu, setOpenHeaderMenu] = createSignal<HeaderMenu | null>(null);

// Stack of {appid, name} for games navigated away from via a DLC link or "DLC for <Base Game>"
// link click (see navigateToGame/panelGoBack below) — NOT touched by an ordinary panel open (a
// table row click, a search-box pick, prev/next/random), since those aren't part of any such
// browsing trail. Holds plain {appid, name} pairs rather than full game objects — going back
// re-opens via the same host mechanism (panelOptions.onNavigateGame) a fresh lookup would use,
// same dedup-with-already-loaded-rows behavior included, rather than panel.tsx caching its own
// stale copy of a game's details. The push/pop rule itself is nextHopHistory (panelHistory.ts).
const [panelHistory, setPanelHistory] = createSignal<PanelHistoryEntry[]>([]);

// The appid of a hop this panel itself started — set by navigateToGame/panelGoBack right before
// handing off to the host's own opener, and consumed by the next panelOpen, which is what keeps
// that open from clearing the trail those two just pushed to or popped from.
//
// Module state rather than a `panelOpen({ keepHistory })` argument, which is what this replaced:
// the host may take a whole route navigation to get there (`onNavigateGame` → AppShell's
// openGameGlobally → `/game/:appid` for the recents list, where the actual open happens later
// from that route's own load()), and no argument survives that. It's also the only place in the
// app that knows the answer — every other opener starts a fresh trail — so asking three modules
// to thread a boolean back here was both fragile and, for the `/game/:appid` path, impossible:
// the trail was silently wiped on every hop, so "← Back" never appeared at all and panelGoBack
// was unreachable.
let pendingHopAppid: number | null = null;

function panelShuffle(arr: { appid: number }[]) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const randomQueues = new Map<string, { appid: number }[]>(); // queueKey → remaining shuffled games

// Picks the next game from a shuffle bag scoped to queueKey (e.g. a group key,
// or a fixed constant for a page with only one list) so repeated picks cycle
// through every item before repeating. The bag is rebuilt when exhausted or
// when `list` no longer matches what's left in it (e.g. after filtering).
export function pickRandomFrom(list: { appid: number }[], queueKey: string, currentAppid: number) {
  if (!list.length) return null;
  let queue = randomQueues.get(queueKey) || [];
  const ids = new Set(list.map((g) => g.appid));
  const queueValid = queue.length > 0 && queue.every((g) => ids.has(g.appid));
  if (!queueValid) {
    const remaining = panelShuffle(list).filter((g) => g.appid !== currentAppid);
    queue = remaining.length ? remaining : panelShuffle(list);
  }
  const pick = queue.shift();
  randomQueues.set(queueKey, queue);
  return pick;
}

export function clearRandomQueue(queueKey: string) {
  randomQueues.delete(queueKey);
}

export function clearAllRandomQueues() {
  randomQueues.clear();
}

export function initPanel(options: PanelOptions) {
  panelOptions = options;

  document.getElementById('panel-close')!.addEventListener('click', () => panelClose());

  const panelBodyEl = document.getElementById('panel-body')!;
  render(() => <PanelBody />, panelBodyEl);

  panelBodyEl.addEventListener(
    'wheel',
    (e) => {
      const strip = (e.target as Element).closest?.('.panel-filmstrip') as HTMLElement | null;
      if (!strip) return;
      e.preventDefault();
      strip.scrollLeft += e.deltaY || e.deltaX;
    },
    { passive: false },
  );

  // Dismiss the "⋯ More actions" menu on outside click, same convention as gameSearch.ts's
  // own dropdown — needs to catch clicks *outside* the panel too (backdrop, page behind it),
  // so this stays a document-level listener rather than something the menu button's own
  // onClick could handle alone. Uses `e.composedPath()` rather than `e.target.closest(...)` —
  // the menu button's own click toggles `openHeaderMenu` synchronously, which re-renders this
  // exact DOM subtree (a brand new button element replacing the old one) *before* this
  // document-level listener runs (it's registered after Solid's own delegated click listener,
  // so it always fires second) — by then `e.target` is the already-detached old button, whose
  // `.closest()` walk no longer reaches the (also-replaced) `.panel-icon-more` wrapper,
  // reading as an "outside" click and immediately closing the menu that same click just
  // opened. `composedPath()` is captured at dispatch time, before any handler (including
  // Solid's own) had a chance to mutate the DOM, so it's unaffected by that race — confirmed
  // live (the menu never opened at all before this fix).
  document.addEventListener('click', (e) => {
    if (
      openHeaderMenu() &&
      !e
        .composedPath()
        .some(
          (el) =>
            el instanceof HTMLElement &&
            el.classList.contains('panel-icon-more') &&
            el.dataset.menu === openHeaderMenu(),
        )
    )
      setOpenHeaderMenu(null);
  });
  // Capture, as bindNavPopover: ahead of panelKeyboard.ts's Esc, which skips a handled one.
  // Not once focus has left the panel: a layer opened above it (the shortcuts dialog, nav search) owns Esc.
  window.addEventListener(
    'keydown',
    (e) => {
      const menu = openHeaderMenu();
      if (e.key !== 'Escape' || !menu) return;
      const active = document.activeElement;
      if (active && active !== document.body && !active.closest('#game-panel')) return;
      e.preventDefault();
      setOpenHeaderMenu(null);
      document
        .querySelector<HTMLElement>(`#game-panel .panel-icon-more[data-menu='${menu}'] .panel-icon-more-btn`)
        ?.focus();
    },
    true,
  );

  initPanelSwipe();
  initHeroSwipe();

  // The one place document.title's "a game is open" layer is driven from (see pageTitle.ts).
  // `game.name` is read inside the effect, so a standalone lookup's placeholder title
  // (`App <appid>`, before store metadata resolves the real one) is replaced as soon as the
  // store row's `name` is written — the effect subscribes to that one field.
  createEffect(() => {
    const game = panelGame();
    setGameTitle(game ? game.name : null);
  });
}

export function isPanelOpen() {
  return panelGame() != null;
}
export function getPanelGame() {
  return panelGame();
}

// Forces a fresh rating/HLTB/store-metadata/tags fetch for the open game, bypassing
// its cache TTL. The actual fetch + state update is host-specific (app.ts updates its
// `games` array and table row; library.ts updates its data-table row) — panelOptions.onRefresh
// does that and panel.tsx only owns the button's disabled/spinning state and re-render.
async function handlePanelRefresh() {
  const game = panelGame();
  if (!game || panelRefreshing()) return;
  setPanelRefreshing(true);
  try {
    // Each `refetch()` re-runs that resource's fetcher with `refetching` set, which is what its
    // fetcher reads as `refresh` (bypass both this app's session cache and the server's own TTL).
    // A refetch of a resource whose source is currently null — price, for a game its list
    // already priced — is a no-op by construction, no extra check needed here. DLC isn't
    // refetched: forcing every one of a game's DLC would cost one store lookup each.
    await Promise.all([
      panelOptions.onRefresh(game),
      panelData.refetchNews(),
      panelData.refetchPrice(),
      panelData.refetchOffers(),
      panelData.refetchAchievements(),
    ]);
  } finally {
    setPanelRefreshing(false);
  }
}

// ⋯'s Copy link — copies a link back to this exact game.
// Always `/game/<appid>` (the canonical, single, shareable link — see
// docs/dev/frontend.md's routing section and ListRoute.tsx's `recent` kind), never
// whatever route/list happened to have this game open (which may carry `u=`/filters/sort/a
// route-local `?game=` from whatever search led here) — someone sharing "check out this game"
// almost always means the game itself, not "reproduce my exact search too", and a route-local
// link wouldn't even resolve for a recipient who doesn't already have that same list loaded
// (an account's Owned/Wishlist, a specific bundle), unlike /game/<appid>, which works for anyone.
function copyPanelLink(e: MouseEvent, copied: Node) {
  const game = panelGame();
  if (!game) return;
  copyWithFeedback(e.currentTarget as HTMLElement, `${location.origin}/game/${game.appid}`, {
    copied,
    copiedClass: 'panel-copy-link-btn--copied',
  });
}

// Which hidden achievements have been click-revealed (keyed `${appid}:${apiname}`), for the session.
const [revealedAchievements, setRevealedAchievements] = createSignal<Set<string>>(new Set());
// Which achievement list filter ('all' | 'unlocked' | 'locked') each game is currently
// showing — same per-appid, never-cleared-this-session shape as revealedAchievements above.
// Defaults to 'all' (map lookup miss) for any appid never touched.
const [achievementsFilter, setAchievementsFilter] = createSignal<Map<number, string>>(new Map());

// ── Per-game async data ──────────────────────────────────────────────────────
// News, achievements, "Owned by", ownership status, price and DLC — everything the panel
// fetches for itself, as six `createResource`s keyed on whichever game is open. The fetching
// and session-caching itself lives in panelData.ts; this is only the reactive wiring.
//
// This replaced six hand-rolled `loadX(game)` functions that each set a `game.xLoading` flag,
// awaited a fetch, wrote the result onto the `Game` object, and called `renderPanelBody(game)`
// behind an `if (panelGame() === game)` staleness guard. A resource keyed on the open game
// gives all four of those for free: `.loading` is the flag, the value is the result, a
// superseded response is discarded rather than needing the guard, and — since a resource is a
// signal — whatever reads it re-renders on its own with no "please re-render" bump. See
// docs/dev/frontend.md's Reactivity section for the whole story.
//
// `createRoot`: these are computations, so they need an owner, and there is no component to own
// them — the panel is a module-level singleton whose data outlives every render of it (an
// in-flight fetch survives a close/reopen). One explicit, never-disposed root at module scope is
// exactly that lifetime, and keeps the resources readable from the plain module functions below
// (panelOpen, handlePanelRefresh) the same way the signals above already are.
//
// Every source below resolves to a *primitive* (an appid, or an `appid:account` string) rather
// than an object literal: `createResource` memoizes its source with `===`, so an object would
// refetch every time the source merely recomputed — e.g. `dlcSource` re-runs whenever any
// card anywhere is opened/folded, and must not turn that into a fresh DLC fetch.
// Bumped by a route whose `getOwners` answer changed (a comparison resolved, or was left).
const [ownersRev, setOwnersRev] = createSignal(0);
export function notifyOwnersChanged(): void {
  setOwnersRev((n) => n + 1);
}

// The account the panel answers for; reactive, so switching accounts re-keys the account-specific resources below.
function currentMembers(): string[] {
  return getEffectiveCurrentAccount()?.members ?? [];
}

// The ground's tint from the open game's table thumbnail, the image most likely cached already.
createRoot(() => {
  createEffect(() => {
    const g = panelGame();
    const panel = document.getElementById('game-panel');
    panel?.style.removeProperty('--panel-tint');
    const url = g && (g.thumb || g.capsule);
    if (!panel || !url) return;
    void sampleArtTint(url).then((tint) => {
      if (tint && panelGame() === g) panel.style.setProperty('--panel-tint', tint);
    });
  });
});

const panelData = createRoot(() => {
  const openAppid = createMemo(() => panelGame()?.appid ?? null);
  // Shared by the three account-specific resources — achievementsAccountKey is just "sort the
  // member ids and join them", which is as much the right cache key for owners/ownership as it
  // is for achievements.
  const appidAndAccount = createMemo(() => {
    const appid = openAppid();
    return appid == null ? null : `${appid}:${achievementsAccountKey(currentMembers())}`;
  });

  // A plain `refetch()` from the refresh button is always a forced one; the source-driven initial
  // load passes `refetching: false`. That's the only distinction any of these fetchers needs.
  const isForced = (info: { refetching: boolean | unknown }) => info.refetching !== false;

  const [news, { refetch: refetchNews }] = createResource<PanelNews, number>(openAppid, (appid, info) => {
    // A cached value comes back synchronously, so reopening a game paints its real News card
    // instead of flashing the loading skeleton at it again.
    return fetchNews(appid, { refresh: isForced(info), settled: () => openAppid() === appid });
  });

  const [achievements, { refetch: refetchAchievements }] = createResource<PanelAchievements, string>(
    appidAndAccount,
    (key, info) => {
      // Read off the current game rather than packed into the source key: the key only has to
      // change when the *identity* of what's being fetched changes (this appid, this account), and
      // a resource fetcher runs untracked, so reading the game here subscribes to nothing.
      const g = panelGame();
      if (!g) return null;
      return fetchAchievements(g.appid, currentMembers(), {
        refresh: isForced(info),
        settled: () => appidAndAccount() === key,
        achievementCount: g.details?.meta?.achievementCount,
      });
    },
  );

  // Both of these are free in practice — myOwnership.ts already holds the current account's
  // owned/wishlist sets (and per-member playtimes) from one fetch shared with the ✓/☆ markers on
  // every table row, so these await a resolved promise rather than making a request.
  // A ↻ of the account anywhere moves myOwnershipVersion, so an open panel follows it.
  const ownershipKey = createMemo(() => {
    const key = appidAndAccount();
    return key == null ? null : `${key}:${myOwnershipVersion()}`;
  });
  const ownersKey = createMemo(() => {
    const key = ownershipKey();
    return key == null ? null : `${key}:${ownersRev()}`;
  });
  const [owners] = createResource<GameOwner[], string>(ownersKey, () => {
    const appid = openAppid();
    if (appid == null) return [];
    return panelOptions.getOwners(appid) ?? getOwnersFor(appid);
  });

  const [ownership] = createResource<OwnershipStatus | null, string>(ownershipKey, () => {
    const appid = openAppid();
    return appid == null ? null : getMyOwnershipStatus(appid);
  });

  // Only for a game whose price nothing else has already loaded: a wishlist/bundle list batches
  // every row's prices in one call, and those rows carry the result in their own price fields
  // (which is what `bestDealPrice !== undefined` detects) for the table's price columns to render
  // — the panel reads those directly instead of duplicating the request. Checked as the resource
  // *source*, so a row that gets priced by its list later simply stops being a candidate.
  const priceSource = createMemo(() => {
    const g = panelGame();
    if (!g || g.bestDealPrice !== undefined) return null;
    return `${g.appid}:${currentRegion()}`;
  });

  const [price, { refetch: refetchPrice }] = createResource<PanelPrice, string>(priceSource, (key, info) => {
    const [appid, region] = key.split(':');
    return fetchPrice(Number(appid), region, { refresh: isForced(info), settled: () => priceSource() === key });
  });

  const offersSource = createMemo(() => (openAppid() == null ? null : `${openAppid()}:${currentRegion()}`));
  const [offers, { refetch: refetchOffers }] = createResource<PanelOffers, string>(offersSource, (key, info) => {
    const [appid, region] = key.split(':');
    return fetchOffers(Number(appid), region, { refresh: isForced(info), settled: () => offersSource() === key });
  });

  // DLC's fetch waits for its card to be open (part of the source), the same for every game.
  // `shown` is how many entries the card asks for: DLC_PAGE, plus DLC_PAGE per "Show more".
  const [dlcMore, setDlcMore] = createSignal<{ appid: number; shown: number } | null>(null);
  // The number shown rides along as an `appid:shown` string, so "Show more" re-runs the fetch.
  const dlcShown = (): number => {
    const g = panelGame();
    const ids = g?.details?.meta?.dlc;
    if (!g || !ids?.length || !isPanelCardOpen('dlc')) return 0;
    const more = dlcMore();
    return Math.min(ids.length, more?.appid === g.appid ? more.shown : DLC_PAGE);
  };
  const dlcSource = createMemo(() => (dlcShown() ? `${panelGame()!.appid}:${dlcShown()}` : null));

  // The in-progress list, streamed in one entry at a time (see fetchDlc's `onPartial`) — a
  // resource is one value per fetch, so the partial state is its own signal alongside it rather
  // than something forced through `mutate`. Tagged with the appid it belongs to, so a partial
  // list can never be shown under a different game.
  const [dlcPartial, setDlcPartial] = createSignal<{ appid: number; entries: (DlcEntry | undefined)[] } | null>(null);

  const [dlc] = createResource<PanelDlc, string>(dlcSource, (key) => {
    const [appid, shown] = key.split(':').map(Number);
    const ids = (panelGame()?.details?.meta?.dlc ?? []).slice(0, shown);
    return fetchDlc(ids, {
      onPartial: (entries) => setDlcPartial({ appid, entries }),
      settled: () => dlcSource() === key,
    });
  });
  const showMoreDlc = (appid: number) => setDlcMore({ appid, shown: dlcShown() + DLC_PAGE });

  return {
    news,
    refetchNews,
    achievements,
    refetchAchievements,
    owners,
    ownership,
    price,
    refetchPrice,
    offers,
    refetchOffers,
    dlc,
    dlcPartial,
    dlcShown,
    showMoreDlc,
  };
});

// The price fields backing the Price card: whatever the host route already loaded onto the row
// (see `priceSource` above), else this panel's own lookup. Both are the same `PriceFields` shape
// — priceLoading.ts's `applyPriceInfo` fills either one — so nothing downstream cares which it
// got. `undefined` means "no price data for this game at all" (nothing loaded it, and this panel
// isn't looking it up either), which renders as no card.
function panelPriceFields(game: ReadonlyGame): PriceFields | null | undefined {
  return game.bestDealPrice !== undefined ? game : panelData.price();
}

// Clicking a DLC entry in the expanded card (DlcBody), or the "Part of <Base Game>"
// link (see BaseGameLink) — same relationship walked in opposite directions, so both push the
// game being left onto panelHistory, then hand off to the host's own "open this appid"
// mechanism (the same one backing the "look up any game" search box), just told to keep the
// history stack instead of starting a fresh one. `name` is the target's already-known name
// (from the just-fetched DLC list, or from `fullgame` on the current game's own metadata),
// passed through purely to avoid a title flash while the host's own fetch is in flight, same
// convention as gameSearch.ts's onSelect.
function navigateToGame(appid: number, name: string) {
  const game = panelGame();
  if (!game) return;
  // See nextHopHistory (panelHistory.ts) for the push-vs-pop rule.
  setPanelHistory((hist) => nextHopHistory(hist, { appid: game.appid, name: game.name }, appid));
  pendingHopAppid = appid;
  panelOptions.onNavigateGame(appid, name);
}

// The header's "← Back" button (see PanelRest) — pops the trail and reopens whatever
// was on top the same way navigateToGame opens a DLC/base-game link, just in the other
// direction. Popping before calling onNavigateGame (rather than after) means the callback
// only ever needs to know "keep whatever's left in the stack", identical in both directions.
function panelGoBack() {
  const hist = panelHistory();
  if (!hist.length) return;
  const prev = hist[hist.length - 1];
  setPanelHistory(hist.slice(0, -1));
  pendingHopAppid = prev.appid;
  panelOptions.onNavigateGame(prev.appid, prev.name);
}

function getPanelItems() {
  const g = panelGame();
  return g ? gameMediaItems(g) : [];
}

// dir: -1 (previous) or 1 (next). wrap: true for keyboard arrow navigation
// (cycles through all media), false for the hero prev/next buttons and the
// swipe (clamps at the ends, returning false there).
export function panelStepHero(dir: number, { wrap = false } = {}) {
  if (!panelGame()) return false;
  const items = getPanelItems();
  if (wrap) {
    if (items.length <= 1) return false;
    setHeroIdx((heroIdx() + dir + items.length) % items.length);
  } else {
    const next = Math.max(0, Math.min(heroIdx() + dir, items.length - 1));
    if (next === heroIdx()) return false;
    setHeroIdx(next);
  }
  if (wrap) (document.getElementById('panel-hero')?.querySelector('.panel-hero-open') as HTMLElement | null)?.focus();
  return true;
}

// Whether `shotId` of the open game is what the presentation window shows.
function onTv(shotId: string | undefined): boolean {
  const on = presented();
  return !!on && on.appid === panelGame()?.appid && on.item.shotId === shotId;
}

// P and the Present button: the hero's current media goes to the presentation window.
export function presentHero(): void {
  const g = panelGame();
  const items = getPanelItems();
  if (g && items.length) present(g, items[clampedHeroIdx(items.length)].shotId);
}

export function panelOpen(game: ReadonlyGame) {
  // Every opener (a table row, a search-box pick, prev/next/random, a deep link) starts a fresh
  // browsing trail — except the DLC/base-game hop this panel started itself, which arrives here
  // with `pendingHopAppid` armed (see its own comment above). Consumed either way: if some
  // *other* game opens first, that hop never completed and the trail it belonged to is stale.
  const isHop = pendingHopAppid === game.appid;
  pendingHopAppid = null;
  if (!isHop) setPanelHistory([]);
  pushOverlayEntry('panel', () => panelClose(), urlWithoutPanel);
  setPanelGame(game);
  setHeroIdx(0);
  setOpenHeaderMenu(null);
  // A reopen from inside the panel or its lightbox (↑/↓, a DLC hop) keeps the original opener.
  const active = document.activeElement as HTMLElement | null;
  if (active && active !== document.body && !active.closest('#game-panel, #screenshot-lightbox'))
    panelPrevFocus = active;
  document.getElementById('panel-body')!.scrollTop = 0;
  // No load* calls here: news/achievements/owners/ownership/price are resources keyed on the
  // open game (see "Per-game async data" above), so setting `panelGame` above is itself what
  // starts whichever of them this game still needs — and what makes a reopen free when it
  // doesn't.
  for (const ghost of document.querySelectorAll('.panel-ghost')) ghost.remove();
  document.getElementById('game-panel')!.classList.add('open');
  if (!isMorphUpdating()) focusPanel();
}

function focusPanel() {
  (
    (document.getElementById('panel-hero')?.querySelector('.panel-hero-open') ??
      document.getElementById('panel-close')!) as HTMLElement
  ).focus();
}

// A pointer click on a row while the panel is closed morphs the row's thumbnail into the panel's
// hero; any other open is instant.
export function openPanelFromRow(event: MouseEvent | KeyboardEvent, open: () => void): void {
  const thumb = (event.target as Element | null)?.closest('tr')?.querySelector<HTMLImageElement>('img.game-thumb');
  if (!(event instanceof MouseEvent) || isPanelOpen() || !thumb?.naturalWidth || thumb.style.visibility === 'hidden')
    return open();
  const panel = document.getElementById('game-panel')!;
  morph({
    from: thumb,
    update: open,
    to: () => document.querySelector('#panel-hero .panel-hero-main'),
    ready: (hero) => {
      const img = hero.querySelector<HTMLImageElement>('.panel-hero-img');
      return img ? loadedWhen(img, 'loading', img) : Promise.resolve();
    },
    focus: () => {
      if (isPanelOpen() && !panel.contains(document.activeElement)) focusPanel();
    },
    start: () => panel.classList.add('panel-morph'),
    finish: () => panel.classList.remove('panel-morph'),
  });
}

// `leavingRoute`: the route is unmounting under a navigation — its host keeps `?game=` on the
// history entry being left (see `onClose`), so Back to it reopens the game.
export function panelClose({ leavingRoute = false, animate = true } = {}) {
  const game = panelGame();
  if (!game) return;
  if (animate && !leavingRoute) leavePanelGhost();
  setPanelGame(null);
  setOpenHeaderMenu(null);
  // Closing the panel ends whatever DLC browsing trail was in progress — including a hop that
  // was handed off but never opened (a bad appid, a failed lookup), which must not be left armed
  // to attach a stale trail to some later, unrelated open of that same game.
  setPanelHistory([]);
  pendingHopAppid = null;
  document.getElementById('game-panel')!.classList.remove('open');
  clearPanelNav();
  // The shown game's row first: after ↑/↓ or a deep link, the opener is a stale row or the panel itself.
  if (!focusGameRow(document.querySelector('main'), game.appid)) panelPrevFocus?.focus();
  panelPrevFocus = null;
  // Every close path funnels through here — the × button is bound straight to this function
  // (see initPanel above), and swipe-to-close calls it directly too — so this is the one place
  // host-specific close cleanup (clearing `?game=`/`&shot=` from the URL, resetting the host's
  // own "active game" state) can hook in without every
  // host having to remember to wrap all of those paths itself.
  panelOptions.onClose({ leavingRoute });
  popOverlayEntry('panel');
}

// Its content goes at once on close, so a copy slides out in its place; one stripped of ids and
// names, which would otherwise answer the live panel's lookups (and join its radio groups).
function leavePanelGhost() {
  if (prefersReducedMotion() || document.body.classList.contains('lb-open')) return;
  const panel = document.getElementById('game-panel')!;
  const ghost = panel.cloneNode(true) as HTMLElement;
  const refs = ['id', 'name', 'aria-labelledby', 'aria-controls'];
  for (const el of [ghost, ...ghost.querySelectorAll(refs.map((attr) => `[${attr}]`).join(', '))])
    for (const attr of refs) el.removeAttribute(attr);
  ghost.className = 'panel-ghost';
  ghost.inert = true;
  ghost.ariaHidden = 'true';
  ghost.addEventListener('animationend', () => ghost.remove(), { once: true });
  panel.after(ghost);
  ghost.querySelector('.panel-body')!.scrollTop = panel.querySelector('.panel-body')!.scrollTop;
}

// A YYYY-MM-DD date as a <time>, readable by machines; anything else (a coarse "Q4 2026") as plain text.
function DayText(props: { text: string }): JSX.Element {
  return (
    <Show when={/^\d{4}-\d{2}-\d{2}$/.test(props.text)} fallback={props.text}>
      <time datetime={props.text}>{props.text}</time>
    </Show>
  );
}

// Steam's own percent strings already carry a decimal (e.g. "80.9"), but round numbers
// parse to a plain integer (100 from "100.0") — toFixed(1) on those would print "100.0%",
// so only force the decimal when the value isn't already a whole number.
function fmtRarity(pct: number) {
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

function revealAchievement(appid: number, apiname: string) {
  const next = new Set(revealedAchievements());
  next.add(`${appid}:${apiname}`);
  setRevealedAchievements(next);
}

function setAchievementsFilterFor(appid: number, filter: string) {
  const next = new Map(achievementsFilter());
  next.set(appid, filter);
  setAchievementsFilter(next);
}

// The Achievements tile's body, off the `achievements` resource (see "Per-game async data" above):
// fetched separately from the rating/HLTB/tags stream, since the achievement *list* only depends
// on the appid but progress depends on which account is loaded. The list itself is still fetched
// and shown with zero accounts loaded (`playerCount: 0`, no `steamUrl`) — only the
// achieved/unlocktime/progress-summary parts need an account, gated by `hasProgress` below.

function AchievementsBody(props: { game: ReadonlyGame }): JSX.Element {
  const data = () => panelData.achievements.latest;
  // With no player loaded (`playerCount === 0` — a standalone "look up any game" lookup),
  // `unlocked` is always 0 by construction, not a real "nobody's unlocked anything" result — the
  // list itself (names/descriptions/icons/rarity) is still real store metadata worth showing,
  // just without any progress claim on top of it. `hasProgress` gates every place that would
  // otherwise imply real unlock data.
  const hasProgress = () => (data()?.playerCount ?? 0) > 0;

  // Sorted once per fetch and cached on the payload itself (a fresh object every fetch/refresh,
  // so this never goes stale) rather than re-sorting the full list on every render.
  const sorted = createMemo(() => {
    const d = data();
    if (!d) return [];
    return (d._sortedAchievements ??= d.achievements.slice().sort((a, b) => Number(b.achieved) - Number(a.achieved)));
  });
  // 'unlocked'/'locked' only make sense with real progress loaded — filtering by achieved status
  // when nobody's loaded would just be "everything" vs. "nothing" either way. `createMemo` rather
  // than a bare thunk since `visible()` is read from two separate JSX spots below (the `<Show>`
  // and the `<For>`) in the same render — a memo shares one `filter()` pass across both instead
  // of each read re-running it.
  const filter = createMemo(() => (hasProgress() ? achievementsFilter().get(props.game.appid) || 'all' : 'all'));
  const visible = createMemo(() =>
    filter() === 'all' ? sorted() : sorted().filter((a) => (filter() === 'unlocked') === !!a.achieved),
  );

  const body = (
    <>
      <Show when={hasProgress()}>
        <div class="panel-achievements-filter">
          <For each={['all', 'unlocked', 'locked']}>
            {(opt) => (
              <button
                type="button"
                class={`panel-achievements-filter-btn${filter() === opt ? ' active' : ''}`}
                aria-pressed={filter() === opt}
                onClick={() => setAchievementsFilterFor(props.game.appid, opt)}
              >
                {opt === 'all' ? 'All' : opt === 'unlocked' ? 'Unlocked' : 'Locked'}
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={!hasProgress()}>
        <div class="panel-no-data">Load a player above to see who's unlocked what.</div>
      </Show>
      <Show when={hasProgress() && data()?.private}>
        <div class="panel-no-data">Progress unavailable — profile may be private.</div>
      </Show>
      <Show when={data()?.rarityFailed}>
        <div class="panel-no-data">Rarity: Steam didn't answer.</div>
      </Show>
      <Show when={!visible().length}>
        <div class="panel-no-data">No achievements match this filter.</div>
      </Show>
      <ul class="panel-achievement-list" role="list">
        <For each={visible()}>
          {(a) => {
            // A hidden achievement not yet unlocked keeps its name/description a surprise by
            // default, same as Steam's own profile pages — the schema still carries the real text
            // either way (whether it's still a spoiler depends on which account is loaded, not on
            // the shared/cached schema), this just withholds it client-side until clicked, rather
            // than never sending it at all.
            const revealed = () => revealedAchievements().has(`${props.game.appid}:${a.apiname}`);
            const spoiler = () => a.hidden && !a.achieved && !revealed();
            const name = () => (spoiler() ? 'Hidden achievement' : a.name || a.apiname);
            const desc = () => (spoiler() ? 'Click to reveal' : a.description || '');
            const icon = a.achieved ? a.icon : a.icongray || a.icon;
            // Unlock date is real data the server already returns (`unlocktime`, seconds since
            // epoch) but otherwise has nowhere to show — surfaced as a plain hover tooltip rather
            // than a fifth line of on-card text.
            const title = a.achieved && a.unlocktime ? `Unlocked ${fmtLastPlayed(a.unlocktime)}` : '';
            // Rarity isn't a spoiler — it's shown even for a still-hidden achievement, same as
            // Steam's own profile pages. Fixed to 1 decimal only when it's not a whole number.
            const rarityLabel = a.globalPct == null ? null : fmtRarity(a.globalPct);
            return (
              <li>
                <Dynamic
                  component={spoiler() ? 'button' : 'div'}
                  type={spoiler() ? 'button' : undefined}
                  class={`panel-achievement-row${a.achieved ? ' unlocked' : ''}${spoiler() ? ' panel-achievement--spoiler' : ''}`}
                  title={title || undefined}
                  // Focusable once revealed, so the reveal keeps focus on it rather than on <body>.
                  tabindex={a.hidden && !a.achieved && !spoiler() ? -1 : undefined}
                  onClick={(e: MouseEvent & { currentTarget: HTMLElement }) => {
                    if (!spoiler()) return;
                    const item = e.currentTarget.parentElement;
                    const reveal = revealAchievement.bind(null, props.game.appid, a.apiname);
                    void keepFocus(item, reveal, () => focusVisible(item?.firstElementChild as HTMLElement | null));
                  }}
                >
                  <img class="panel-achievement-icon" src={icon} alt="" loading="lazy" />
                  <span class="panel-achievement-text">
                    <span class="panel-achievement-name">{name()}</span>
                    <Show when={desc()}>{(d) => <span class="panel-achievement-desc">{d()}</span>}</Show>
                  </span>
                  <Show when={rarityLabel != null}>
                    <span class="panel-achievement-rarity" title={`${rarityLabel} of players have unlocked this`}>
                      {rarityLabel}
                    </span>
                  </Show>
                </Dynamic>
              </li>
            );
          }}
        </For>
      </ul>
    </>
  );

  return (
    <>
      {body}
      <Show when={data()?.steamUrl}>
        {(href) => (
          <a class="panel-card-link" href={href()} target="_blank" rel="noopener">
            Achievements on Steam ↗
          </a>
        )}
      </Show>
    </>
  );
}

// The Price card's body: the current best deal (same display/color/badge/tooltip as the Best Deal table cell in
// bundles.tsx/library.ts), its discount off Steam Full Price when there is one, a direct link
// to the shop itself, and a link to the game's ITAD page for the fuller picture (historical
// lows, every other shop) this card deliberately leaves out. See the original panel.ts's own
// (much longer) header comment — preserved in git history — for the full "where do these
// numbers come from" reasoning; unchanged by this conversion.
function PriceBody(props: { game: ReadonlyGame }): JSX.Element {
  // Either the host route's own batched prices (already on the row) or this panel's own lookup —
  // see panelPriceFields. `undefined` means nothing priced this game and nothing is going to.
  const p = () => panelPriceFields(props.game);
  // Narrowed to "has a price": `bestDealPrice` is nullable on the row shape, and everything
  // below (the amount, the record tier, the lows it's compared against) only exists when it isn't
  // null — one check here rather than a non-null assertion at each use.
  const deal = () => {
    const v = p();
    return v && v.bestDealPrice != null ? (v as PriceFields & { bestDealPrice: number }) : null;
  };
  // dealRecordTier (public/utils.ts) is the single shared source of this tier/color/icon logic.
  const rec = () => {
    const d = deal();
    return d ? dealRecordTier(d.bestDealPrice, d) : null;
  };
  const shopUrl = () => safeHref(deal()?.bestDealUrl);

  // Historical lows (all-time/1yr/3mo) — see the original file's own (much longer) comment,
  // preserved in git history, for the full "why collapse equal-amount tiers" reasoning.
  const lowGroups = createMemo(() => {
    const d = deal();
    const groups: { amount: number; tiers: (typeof DEAL_RECORD_TIERS)[number][] }[] = [];
    if (!d) return groups;
    for (const t of [...DEAL_RECORD_TIERS].reverse()) {
      const amount = d[t.low];
      if (amount == null || amount === d.bestDealPrice) continue;
      const last = groups[groups.length - 1];
      if (last && last.amount === amount) last.tiers.unshift(t);
      else groups.push({ amount, tiers: [t] });
    }
    return groups;
  });

  const line = () => {
    const d = deal()!;
    // `0` (the best deal genuinely isn't any cheaper than Steam) is treated the same as `null`/
    // undefined (no discount to show) — "if any" per the spec, not a flat "-0%" reading as noise.
    // The shop name, and — unlike the table cell, which stays tooltip-only since it's
    // space-constrained — the *whole rest of the card* doubles as the buy link (see the original
    // file's own comment, preserved in git history, for the full reasoning).
    return (
      <>
        <span
          class="panel-price-amount"
          style={{ ...(rec() ? { color: rec()!.color } : {}), ...(rec()?.bold ? { 'font-weight': 600 } : {}) }}
        >
          {formatMoney(d.bestDealPrice, d.priceCurrency)}
          {rec() ? ' ' + rec()!.icon : ''}
        </span>
        <Show when={rec()}>{(r) => <span style={{ color: r().color }}>{r().tooltipLabel}</span>}</Show>
        <Show when={d.bestDealCut}>
          <>
            <span class="panel-price-sep">·</span>
            <span class="panel-price-discount">-{d.bestDealCut}%</span>
          </>
        </Show>
        <Show when={d.bestDealShop}>
          <>
            <span class="panel-price-sep">·</span>
            <span class="panel-price-shop">
              {shopUrl() ? 'Buy at ' : 'at '}
              {d.bestDealShop}
              {shopUrl() ? ' ↗' : ''}
            </span>
          </>
        </Show>
      </>
    );
  };

  return (
    <>
      <Show
        when={deal()}
        fallback={
          <div class="panel-no-data">
            {p() === null || p()?.pricesFailed
              ? (priceRefusal(props.game.appid, currentRegion()) ?? "IsThereAnyDeal didn't answer.")
              : 'No pricing data available.'}
          </div>
        }
      >
        <Show
          when={shopUrl()}
          fallback={
            <div class="panel-price-line" title={deal()?.bestDealShop || undefined}>
              {line()}
            </div>
          }
        >
          {(url) => (
            <a
              class="panel-price-line panel-price-line--link"
              href={url()}
              target="_blank"
              rel="noopener"
              title={deal()?.bestDealShop || undefined}
            >
              {line()}
            </a>
          )}
        </Show>
        <Show when={lowGroups().length}>
          <div class="panel-price-lows">
            <For each={lowGroups()}>
              {({ amount, tiers }, i) => {
                const icons = tiers.map((t) => t.icon).join('');
                // "all-time / 1-year low" when two windows share the amount.
                const visibleLabel = `${tiers.map((t) => t.tooltipLabel.replace(/ low$/, '')).join(' / ')} low`;
                const lowColor = tiers[0].color; // rarest tier in the group leads the color too
                const money = () => formatMoney(amount, deal()?.priceCurrency ?? null);
                return (
                  <>
                    <Show when={i() > 0}>
                      <span class="panel-price-sep">·</span>
                    </Show>
                    <span class="panel-price-low" style={{ color: lowColor }}>
                      {visibleLabel} {money()} {icons}
                    </span>
                  </>
                );
              }}
            </For>
          </div>
        </Show>
      </Show>
      <PanelOfferLines game={props.game} />
      <a
        class="panel-card-link"
        href={`https://isthereanydeal.com/steam/app/${props.game.appid}`}
        target="_blank"
        rel="noopener"
      >
        IsThereAnyDeal ↗
      </a>
    </>
  );
}

function PriceCard(props: { game: ReadonlyGame }): JSX.Element {
  // A ↻ keeps the summary shown; another game's load (the same resource, re-keyed) shimmers.
  const latest = <T,>(r: { loading: boolean; latest: T }) => (r.loading && !panelRefreshing() ? undefined : r.latest);
  const price: PanelCardDef = {
    card: 'price',
    title: 'Price',
    icon: Wallet,
    summary: () =>
      props.game.loading
        ? priceSummary(undefined, undefined, false)
        : priceSummary(
            props.game.bestDealPrice !== undefined ? props.game : latest(panelData.price),
            latest(panelData.offers),
            isItadOff(),
          ),
    body: <PriceBody game={props.game} />,
    sectionId: 'panel-section-price',
  };
  return <PanelWideCard def={price} />;
}

// An end date and how soon it is, colored like a bundle's: `verb` is "ends" or "leaves".
function UrgentDate(props: { verb: string; date: string }): JSX.Element {
  const urgency = () => bundleUrgency(props.date);
  return (
    <span
      style={
        urgency()?.tier === 'urgent'
          ? { color: scoreColor(20) }
          : urgency()?.tier === 'soon'
            ? { color: scoreColor(55) }
            : {}
      }
    >
      {props.verb} <time datetime={props.date}>{fmtDateTime(props.date)}</time>
      {urgency()?.label ? ` (${urgency()!.label})` : ''}
    </span>
  );
}

// The subscriptions and current bundles the open game is in, under the Price card's own lines.
// Nothing while loading or without ITAD (the price lines say that); no subscription is silent, most games have none.
function PanelOfferLines(props: { game: ReadonlyGame }): JSX.Element {
  const subscriptions = () => panelData.offers()?.subscriptions ?? [];
  const bundles = () => panelData.offers()?.bundles ?? [];
  return (
    <Show
      when={
        !panelData.offers.loading && panelData.offers() !== undefined && !(panelData.offers() === null && isItadOff())
      }
    >
      <div class="panel-bundles">
        <Show when={panelData.offers() === null}>
          <div class="panel-no-data">
            Bundles and subscriptions:{' '}
            {offersRefusal(props.game.appid, currentRegion()) ?? "IsThereAnyDeal didn't answer."}
          </div>
        </Show>
        <Show when={panelData.offers()?.subscriptions === null}>
          <div class="panel-no-data">Subscriptions: IsThereAnyDeal didn't answer.</div>
        </Show>
        <Show when={subscriptions().length || bundles().length}>
          <ul class="panel-bundle-list" role="list">
            <For each={subscriptions()}>
              {(s) => (
                <li class="panel-bundle">
                  <span class="panel-bundle-title">
                    <Ticket /> In {s.name}
                  </span>
                  <Show when={s.leaving}>
                    <div class="panel-bundle-meta">
                      <UrgentDate verb="leaves" date={s.leaving!} />
                    </div>
                  </Show>
                </li>
              )}
            </For>
            <For each={bundles()}>
              {(b) => {
                const shopUrl = safeHref(b.url);
                return (
                  <li class="panel-bundle">
                    <A class="panel-bundle-title" href={`/lists/bundle/${b.id}`}>
                      <Package /> {b.title}
                    </A>
                    <div class="panel-bundle-meta">
                      <Show when={b.shop}>
                        <Show when={shopUrl} fallback={<span>{b.shop}</span>}>
                          <a href={shopUrl!} target="_blank" rel="noopener">
                            {b.shop} ↗
                          </a>
                        </Show>
                        <span class="panel-price-sep">·</span>
                      </Show>
                      <span title={b.tierPriceMax != null ? TIER_RANGE_TITLE : undefined}>{bundleTierText(b)}</span>
                      <Show when={b.expiry}>
                        <span class="panel-price-sep">·</span>
                        <UrgentDate verb="ends" date={b.expiry!} />
                      </Show>
                    </div>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>
        <Show when={panelData.offers()?.bundles.length === 0}>
          <div class="panel-no-data">Not in any current bundle.</div>
        </Show>
      </div>
    </Show>
  );
}

// "Part of <Base Game>" — the reverse of the DLC card below: present only when the
// currently open game is itself a piece of DLC (`meta.fullgame`, free on the same
// appdetails response, see extractAppDetails in lib/steam.js). Same real-`<a href>` /
// intercepted-click treatment as a DLC entry, just walking the base-game/DLC relationship
// in the other direction via the same navigateToGame.
function BaseGameLink(props: { game: ReadonlyGame }): JSX.Element {
  const fg = () => props.game.details?.meta?.fullgame;
  const onClick = (e: MouseEvent) => {
    const base = fg();
    if (!base || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigateToGame(base.appid, base.name || '');
  };
  return (
    <Show when={fg()}>
      {(base) => (
        <>
          DLC for{' '}
          <a class="panel-basegame-link" href={withAccountParam(`/game/${base().appid}`)} onClick={onClick}>
            {base().name || `App ${base().appid}`}
          </a>
        </>
      )}
    </Show>
  );
}

// DLC — a base game's downloadable content, collapsed by default (see panelData.ts's fetchDlc
// for why it's the one card whose body isn't already loaded by render time). The collapsed
// header's count comes straight from `meta.dlc` (the bare appid list, free — see
// extractAppDetails in lib/steam.js) so it's shown immediately even before the card is ever
// expanded; only the expanded body's names/capsules depend on the lazy fetch. Each entry is
// a real `<a href>` — `/game/<appid>`, the app's canonical single-game link (see
// docs/dev/frontend.md's routing section) — rather than a plain button, so
// ctrl/cmd/shift-click and middle-click open it in a new tab the normal way, while a plain click
// navigates within this panel instead via navigateToGame. This used to be a host-supplied
// `panelOptions.gameHref` (each of the three deleted pages had its own URL shape); with one
// canonical link for every route there's nothing left for a host to decide, and nobody had
// passed it since the redesign — so these were `href="#"`, and middle-click opened nothing.
// The expanded DLC card resolves this many entries at a time (see panelData.ts's fetchDlc).
const DLC_PAGE = 20;

function sortDlcByRelease(list: DlcEntry[]) {
  const sortKey = (d: DlcEntry) => {
    const t = d.releaseDate ? Date.parse(d.releaseDate) : NaN;
    return Number.isNaN(t) ? -Infinity : t;
  };
  return list.slice().sort((a, b) => {
    if (!!a.comingSoon !== !!b.comingSoon) return a.comingSoon ? -1 : 1;
    return sortKey(b) - sortKey(a);
  });
}

function DlcItem(props: { d: DlcEntry }): JSX.Element {
  const onClick = (e: MouseEvent) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigateToGame(props.d.appid, props.d.name);
  };
  return (
    <li>
      <a class="panel-dlc-item" href={withAccountParam(`/game/${props.d.appid}`)} onClick={onClick}>
        {/* Hidden rather than a broken-image icon, its box kept so the names stay aligned (as renderThumb). */}
        <img
          class="panel-dlc-capsule"
          ref={fadeInOnLoad}
          src={props.d.capsule}
          alt=""
          loading="lazy"
          onError={(e) => (e.currentTarget.style.visibility = 'hidden')}
        />
        <span class="panel-dlc-name">{props.d.name}</span>
      </a>
    </li>
  );
}

// ── Hero carousel ────────────────────────────────────────────────────────────
// Its own stable component (not part of the big coarse re-render below) — reading
// `panelGame()`/`heroIdx()` directly, so stepping the hero only patches the hero's own DOM
// subtree, same as the original panelStepHero → renderPanelHero's targeted `.outerHTML`
// update, just done via Solid's own fine-grained reactivity instead of a hand-rolled partial
// DOM replace.
function HeroMain(props: { items: MediaItem[]; idx: number }): JSX.Element {
  const idx = () => props.idx;
  const current = () => props.items[idx()];
  const name = () => panelGame()?.name ?? '';
  const isShot = () => idx() > 0;
  const hasMany = () => props.items.length > 1;
  const src = () => (current().type === 'video' ? current().thumb : current().main);
  // The cover's stand-in is the table's capsule, likely cached: the cover has no smaller version.
  const standIn = () => (current().shotId === 'banner' ? panelGame()?.thumb || current().thumb : current().thumb);
  // Which source has finished, rather than a flag the last load cleared: a browser keeps painting
  // the previous image until the next one has loaded, so on a slow connection the hero showed the
  // last item (or the last game's) under the new one's name. Until `src()` itself is in, the image
  // is hidden and its frame shows the item's thumbnail, already loaded by the filmstrip.
  const [loadedSrc, setLoadedSrc] = createSignal<string>();
  const [brokenSrc, setBrokenSrc] = createSignal<string>();
  const loading = () => loadedSrc() !== src() && brokenSrc() !== src();
  const isOnTv = createMemo(() => onTv(current().shotId));
  // While presenting (and not private), the lightbox it opens puts it on the TV and steers it there.
  const toTv = () => !!presented() && !privateMode();
  // A pointer click on a loaded picture morphs it into the lightbox's; a key or a video opens at once.
  const openCurrent = (e: MouseEvent & { currentTarget: HTMLElement }) => {
    const g = panelGame();
    if (!g) return;
    const img = e.currentTarget.querySelector<HTMLImageElement>('.panel-hero-img');
    if (e.detail > 0 && img && current().type === 'image' && !loading() && brokenSrc() !== src())
      openLightboxFrom(img, g, idx());
    else openLightbox(g, idx());
  };
  // A broken image (banner guess 404ing, or — as with a video's poster — a genuinely dead
  // upstream Steam CDN asset) used to hide the whole `.panel-hero-main`, which also wiped
  // out the prev/next nav and, for videos, the play-button overlay and click target — even
  // though the video itself (or the full-res screenshot behind a broken thumb) still plays/
  // loads fine. Just mark the image broken and leave the rest of the hero working.
  return (
    <div
      class={`panel-hero-main${current().type === 'video' ? ' is-video' : ''}${loading() ? ' panel-hero-main--loading' : ''}`}
      // Always an object: an `undefined` style drops the whole attribute, the morph's view-transition-name with it.
      style={{ 'background-image': loading() && standIn() !== src() ? `url("${standIn()}")` : undefined }}
    >
      <button
        class="panel-hero-open"
        classList={{ 'panel-hero-open--present': toTv() }}
        aria-label={isOnTv() ? 'On TV: open in the lightbox' : toTv() ? 'Present this media' : 'Open in lightbox'}
        onClick={openCurrent}
      >
        {/* Said on the picture, not only in its label: a click presents it, or it's what the TV shows. */}
        <Show when={presented()}>
          <span class="panel-hero-present lb-glass" aria-hidden="true">
            <Show when={isOnTv()} fallback={!privateMode() && <Cast />}>
              <span class="panel-hero-present-dot" />
            </Show>
            {isOnTv() ? 'On TV' : privateMode() ? 'Open' : 'Present'}
          </span>
        </Show>
        <img
          class={`panel-hero-img${loading() ? ' loading' : ''}${brokenSrc() === src() ? ' panel-hero-img--broken' : ''}${isShot() ? ' panel-hero-img--shot' : ''}`}
          src={src()}
          alt={name()}
          onLoad={(e) => setLoadedSrc(e.currentTarget.getAttribute('src') ?? undefined)}
          onError={(e) => setBrokenSrc(e.currentTarget.getAttribute('src') ?? undefined)}
        />
      </button>
      <Show when={hasMany()}>
        <button
          class="panel-hero-btn panel-hero-prev"
          disabled={idx() <= 0}
          aria-label="Previous"
          onClick={() => panelStepHero(-1)}
        >
          &#8249;
        </button>
        <button
          class="panel-hero-btn panel-hero-next"
          disabled={idx() >= props.items.length - 1}
          aria-label="Next"
          onClick={() => panelStepHero(1)}
        >
          &#8250;
        </button>
      </Show>
    </div>
  );
}

function PanelHero(): JSX.Element {
  // `g.details?.meta` is read here, inside an accessor, rather than captured once — a standalone
  // "look up any game" open (or a DLC/base-game navigation hop) shows the panel immediately
  // against a bare skeleton row (`{loading: true, details: null}`) and fills in real metadata
  // (screenshots/videos) asynchronously, without ever replacing the row object itself. Reading
  // the field through the store row is what makes the hero pick that up; it used to need a
  // `revision()` read here for the same reason, back when the row was a plain object.
  const items = getPanelItems;
  const idx = () => clampedHeroIdx(items().length);
  const hasMany = () => items().length > 1;
  let filmstripEl: HTMLUListElement | undefined;

  // Follows the lightbox over it, so closing that leaves the hero on the last item looked at.
  createEffect(() => {
    const shot = lightboxShot();
    if (shot && shot.appid === panelGame()?.appid) setHeroIdx(resolveShotIndex(items(), shot.shotId));
  });

  // Keeps the active filmstrip thumb scrolled into view whenever the hero steps — same
  // "scrollIntoView on every step, including the very first render" behavior the original
  // buildPanelHero/renderPanelHero had.
  createEffect(() => {
    heroIdx();
    if (lightboxOpen()) return; // following the lightbox unseen: scrolled on close
    filmstripEl?.querySelector('.panel-film-item.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  });

  // `error` doesn't bubble, so the filmstrip's broken-thumbnail fallback needs the capture
  // phase — Solid's JSX has no capture-phase prop for a plain element, so this is wired up
  // imperatively via the ref callback instead (same `addEventListener(..., true)` the
  // original file used), delegated once here (not per-<img>) since Solid already only
  // re-renders a given <img> when its own props actually change.
  const onFilmstripRef = (el: HTMLUListElement) => {
    filmstripEl = el;
    el.addEventListener(
      'error',
      (e) => {
        const img = e.target as HTMLImageElement;
        if (!img.classList?.contains('panel-film-thumb')) return;
        const fallback = img.dataset.fallback;
        if (fallback && img.src !== fallback) {
          img.src = fallback;
          return;
        }
        img.classList.add('panel-film-thumb--broken');
      },
      true,
    );
  };

  return (
    <div id="panel-hero" class="panel-hero">
      <Show when={items().length}>
        <HeroMain items={items()} idx={idx()} />
      </Show>
      <Show when={hasMany()}>
        <ul class="panel-filmstrip" ref={onFilmstripRef} aria-label="Media">
          <For each={items()}>
            {(item, i) => {
              // Screenshots have a separate full-res `main` behind the small `thumb` — if
              // the thumbnail variant 404s (a stale/broken CDN asset upstream), retrying
              // with the full-res image gives the filmstrip a second shot before giving up.
              // Videos have no such fallback, so a broken video thumb goes straight to the
              // broken-image state.
              const fallback = item.type === 'image' && item.main !== item.thumb ? item.main : '';
              return (
                <li>
                  <button
                    type="button"
                    class={`panel-film-item${i() === idx() ? ' active' : ''}${item.type === 'video' ? ' is-video' : ''}`}
                    aria-label={mediaLabel(items(), i())}
                    aria-current={i() === idx() ? 'true' : undefined}
                    onClick={() => setHeroIdx(i())}
                  >
                    <img
                      class="panel-film-thumb"
                      ref={fadeInOnLoad}
                      src={item.thumb}
                      data-fallback={fallback}
                      alt=""
                      loading="lazy"
                    />
                  </button>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
      <Show when={panelGame()?.mediaFailed}>
        <div class="panel-no-data">{MEDIA_FAILED}</div>
      </Show>
    </div>
  );
}

// ── The rest of the panel body ───────────────────────────────────────────────
// Split into small components, each reading only the fields it renders — a game object is a
// Solid store row now (see rowStore.ts), so a field written as data streams in patches just the
// text node that shows it. This used to be one coarse block that re-read every field of the game
// and rebuilt the entire subtree on every `revision` bump: ~6 full teardowns per open (five
// async loaders, most bumping on start and finish), each throwing away hover state, keyboard
// focus. See docs/dev/frontend.md's Reactivity section.

// ── The tiles: Weighted Rating | Linux/Deck, To beat | Achievements ─────────────────────────────

const HLTB_PARTS = [
  ['main', 'Main Story'],
  ['extra', 'Main + Extra'],
  ['completionist', 'Completionist'],
] as const;

// A details source (the stream's) that didn't answer: ↻'s refetch is its retry.
const detailsFailed = (source: string) => () => ({
  message: `${source} didn't answer`,
  retry: () => void handlePanelRefresh(),
});

function RatingBody(props: { game: ReadonlyGame }): JSX.Element {
  const r = () => props.game.details?.rating;
  const weighted = () => Math.round(computeSteamdbRating(r()?.positive ?? 0, r()?.total ?? 0) ?? 0);
  const steamPct = () => (r()?.total ? Math.round((r()!.positive / r()!.total) * 100) : 0);
  const mc = () => props.game.details?.meta?.metacritic;
  return (
    <>
      <dl class="panel-figs">
        <div class="panel-fig">
          <dt>Weighted</dt>
          <dd style={{ color: scoreColor(weighted()) }}>{weighted()}</dd>
        </div>
        <div class="panel-fig">
          <dt>Steam</dt>
          <dd>{steamPct()}%</dd>
        </div>
        <div class="panel-fig">
          <dt>Metacritic</dt>
          <Show
            when={mc()}
            fallback={
              <Show when={props.game.pendingSources?.includes('meta')} fallback={<dd class="panel-fig-none">—</dd>}>
                <dd class="panel-fig-none">still loading</dd>
              </Show>
            }
          >
            {(m) => (
              <dd style={{ color: scoreColor(m().score) }}>
                <Show when={safeHref(m().url)} fallback={m().score}>
                  {(href) => (
                    <a href={href()} target="_blank" rel="noopener">
                      {m().score}
                    </a>
                  )}
                </Show>
              </dd>
            )}
          </Show>
        </div>
      </dl>
      <a
        class="panel-card-link"
        href={`https://store.steampowered.com/app/${props.game.appid}/#app_reviews_hash`}
        target="_blank"
        rel="noopener"
      >
        Reviews on Steam ↗
      </a>
    </>
  );
}

function LinuxDeckBody(props: { game: ReadonlyGame }): JSX.Element {
  const pd = () => props.game.details?.protondb;
  return (
    <>
      <p class="panel-card-text">
        ProtonDB: <span style={{ color: protonTierColor(pd()?.tier ?? '') }}>{capitalize(pd()?.tier ?? '')}</span>
        {pd()?.confidence ? `, ${pd()!.confidence} confidence` : ''}
        {pd()?.total ? ` over ${pd()!.total} reports` : ''}.
        <Show when={pd()?.pending}> Provisional: too few reports for ProtonDB to be sure.</Show>
      </p>
      <a
        class="panel-card-link"
        href={`https://www.protondb.com/app/${props.game.appid}`}
        target="_blank"
        rel="noopener"
      >
        ProtonDB ↗
      </a>
    </>
  );
}

function ToBeatBody(props: { game: ReadonlyGame }): JSX.Element {
  const h = () => props.game.details?.hltb;
  return (
    <>
      <dl class="panel-figs">
        <For each={HLTB_PARTS}>
          {([key, label]) => (
            <Show when={h()?.[key]}>
              {(v) => (
                <div class="panel-fig">
                  <dt>{label}</dt>
                  <dd>{spacedHours(v())}</dd>
                </div>
              )}
            </Show>
          )}
        </For>
        <Show when={!HLTB_PARTS.some(([key]) => h()?.[key]) && h()?.all}>
          {(v) => (
            <div class="panel-fig">
              <dt>All PlayStyles</dt>
              <dd>{spacedHours(v())}</dd>
            </div>
          )}
        </Show>
      </dl>
      <a
        class="panel-card-link"
        href={
          h()?.id
            ? `https://howlongtobeat.com/game/${h()!.id}`
            : `https://howlongtobeat.com/?q=${encodeURIComponent(props.game.name)}`
        }
        target="_blank"
        rel="noopener"
      >
        HowLongToBeat ↗
      </a>
    </>
  );
}

function PanelTiles(props: { game: ReadonlyGame }): JSX.Element {
  // A ↻ keeps the summary shown; another game's load (the same resource, re-keyed) shimmers.
  const achievements = () =>
    panelData.achievements.loading && !panelRefreshing() ? undefined : panelData.achievements.latest;
  const rating: PanelCardDef = {
    card: 'rating',
    title: 'Rating',
    icon: ThumbsUp,
    summary: () => ratingSummary(props.game),
    body: <RatingBody game={props.game} />,
    failed: detailsFailed('Steam reviews'),
  };
  const linuxDeck: PanelCardDef = {
    card: 'linux-deck',
    title: 'Linux/Deck',
    icon: Gamepad2,
    summary: () => linuxDeckSummary(props.game),
    body: <LinuxDeckBody game={props.game} />,
    failed: detailsFailed('ProtonDB'),
  };
  const toBeat: PanelCardDef = {
    card: 'to-beat',
    title: 'To beat',
    icon: Timer,
    summary: () => toBeatSummary(props.game),
    body: <ToBeatBody game={props.game} />,
    failed: detailsFailed('HowLongToBeat'),
    sectionId: 'panel-section-hltb',
  };
  const achievementsTile: PanelCardDef = {
    card: 'achievements',
    title: 'Achievements',
    icon: Trophy,
    summary: () => {
      const account = getEffectiveCurrentAccount();
      return achievementsSummary(achievements(), account ? accountDisplayLabel(account) : null);
    },
    body: <AchievementsBody game={props.game} />,
    failed: () => {
      const refusal = achievementsRefusal(props.game.appid, currentMembers());
      return refusal
        ? { message: refusal }
        : { message: "Steam didn't answer.", retry: () => void panelData.refetchAchievements() };
    },
    sectionId: 'panel-section-achievements',
  };
  return (
    <>
      <PanelTileRow first={rating} second={linuxDeck} />
      <PanelTileRow first={toBeat} second={achievementsTile} />
    </>
  );
}

const SIMILAR_SHOWN = 5;

const steamMoreLikeUrl = (appid: number): string => `https://store.steampowered.com/recommended/morelike/app/${appid}/`;

// Each name once with every role it has here; a developer that also publishes opens as developer.
function gameCreators(
  meta: Pick<GameMeta, 'developers' | 'publishers'> | null | undefined,
): { name: string; role: CreatorRole; label: string }[] {
  const devs = meta?.developers ?? [];
  const pubs = meta?.publishers ?? [];
  return [
    ...devs.map((name) => ({
      name,
      role: 'developer' as const,
      label: pubs.includes(name) ? 'developer & publisher' : 'developer',
    })),
    ...pubs
      .filter((name) => !devs.includes(name))
      .map((name) => ({ name, role: 'publisher' as const, label: 'publisher' })),
  ];
}

function MoreFrom(props: { game: ReadonlyGame }): JSX.Element {
  const location = useLocation();
  const creators = createMemo(() => gameCreators(metaOrBasics(props.game.details)));
  const matches = useCurrentMatches();
  // The matched <Route>'s role (AppRoot.tsx), not pathname: the router ignores case and a trailing slash.
  const isOpen = (role: CreatorRole, name: string) =>
    matches().at(-1)?.route.info?.role === role && new URLSearchParams(location.search).get('name')?.trim() === name;
  return (
    <Show when={creators().length}>
      <div class="panel-similar-more">
        More from:{' '}
        <For each={creators()}>
          {(c, i) => (
            <>
              {i() > 0 && ' · '}
              <Show
                when={!isOpen(c.role, c.name)}
                fallback={
                  <span class="panel-similar-more-current" aria-current="page">
                    {c.name}
                  </span>
                }
              >
                <a
                  href={withAccountParam(`${creatorListPath(c.role, c.name)}&game=${props.game.appid}`)}
                  aria-label={`All games by ${c.name} (${c.label})`}
                >
                  {c.name}
                </a>
              </Show>{' '}
              <span class="panel-similar-role">({c.label})</span>
            </>
          )}
        </For>
      </div>
    </Show>
  );
}

// ── The lower cards: DLC | Owned by (DLC alone, wide, without owners), About, Tags, Similar, News ──

// Synchronous, so the Owned by tile never appears late (a cold comparison's players resolve later).
const hasOwnerSource = () => panelOptions.hasOwners() || currentMembers().length > 0;

// Who Owned by counts: the comparison's players, else the account's members.
function ownerMemberNames(): string[] {
  const players = panelOptions.getOwnerMembers();
  if (players?.length) return players;
  const account = getEffectiveCurrentAccount();
  if (!account) return [];
  if (account.members.length === 1) return [accountDisplayLabel(account)];
  const names = peekMemberNames();
  return names.length ? names : account.members;
}

const decodeHtml = (html: string) => new DOMParser().parseFromString(html, 'text/html').body.textContent || '';

// Most recently played first; "never played" only with no playtime either (Steam's last-played can be 0).
function OwnersBody(): JSX.Element {
  const sorted = createMemo(() => sortOwners(panelData.owners() ?? []));
  const maxMinutes = createMemo(() => Math.max(...sorted().map((o) => o.minutes)));
  return (
    <ul class="panel-owners" role="list">
      <For each={sorted()}>
        {(o) => {
          const lastPlayed = fmtLastPlayed(o.lastPlayedSec);
          const playtime = fmtPlaytime(o.minutes);
          const lastPlayedText = lastPlayed || (o.minutes > 0 ? 'last played unknown' : 'never played');
          return (
            <li class="panel-owner">
              <div class="panel-owner-top">
                <span class="panel-owner-name">{o.name}</span>
                <span class="panel-owner-lastplayed">
                  <DayText text={lastPlayedText} />
                </span>
              </div>
              <div class="panel-owner-meter-track">
                <div class="panel-owner-meter-fill" style={{ width: `${ownerMeterPct(o.minutes, maxMinutes())}%` }} />
              </div>
              <span class="panel-owner-playtime">{playtime ? `${playtime} played` : 'not played'}</span>
            </li>
          );
        }}
      </For>
    </ul>
  );
}

function DlcBody(props: { game: ReadonlyGame }): JSX.Element {
  const dlcIds = () => props.game.details?.meta?.dlc ?? [];
  // Whichever entries have already resolved, tagged with their appid so another game's never show.
  const loaded = () => {
    const partial = panelData.dlcPartial();
    return (partial?.appid === props.game.appid ? partial.entries : []).filter((d): d is DlcEntry => d != null);
  };
  // One list for streaming and done, sorted throughout: entries already shown keep their element.
  const entries = createMemo(() => sortDlcByRelease(panelData.dlc.loading ? loaded() : (panelData.dlc() ?? [])));
  const notShown = () => dlcIds().length - panelData.dlcShown();
  return (
    <>
      <Show
        when={entries().length}
        fallback={
          <Show
            when={!panelData.dlc.loading && panelData.dlc() !== undefined}
            fallback={<span class="sk panel-card-body-sk" />}
          >
            <div class="panel-no-data">
              {panelData.dlc() === null ? "Couldn't load DLC details." : 'No DLC details available.'}
            </div>
          </Show>
        }
      >
        <ul class="panel-dlc-items" role="list">
          <For each={entries()}>{(d) => <DlcItem d={d} />}</For>
        </ul>
        <Show
          when={panelData.dlc.loading}
          fallback={
            <Show when={notShown() > 0}>
              <button type="button" class="panel-dlc-more" onClick={() => panelData.showMoreDlc(props.game.appid)}>
                {notShown() > DLC_PAGE ? `Show ${DLC_PAGE} more of ${notShown()}` : `Show ${notShown()} more`}
              </button>
            </Show>
          }
        >
          <Show when={panelData.dlcShown() - entries().length}>
            {(n) => <div class="panel-dlc-loading-more">Loading {n()} more…</div>}
          </Show>
        </Show>
      </Show>
      <a
        class="panel-card-link"
        href={`https://store.steampowered.com/dlc/${props.game.appid}/`}
        target="_blank"
        rel="noopener"
      >
        All DLC on Steam ↗
      </a>
    </>
  );
}

function NewsBody(props: { game: ReadonlyGame }): JSX.Element {
  return (
    <>
      <ul class="panel-news" role="list">
        <For each={panelData.news.latest ?? []}>
          {(n) => (
            <li>
              <a class="panel-news-item" href={safeHref(n.url) || undefined} target="_blank" rel="noopener">
                <span class="panel-news-title">{n.title}</span>
                <span class="panel-news-meta">
                  <DayText text={fmtLastPlayed(n.date)} />
                  {n.feedLabel ? ` · ${n.feedLabel}` : ''}
                </span>
              </a>
            </li>
          )}
        </For>
      </ul>
      <a
        class="panel-card-link"
        href={`https://store.steampowered.com/news/app/${props.game.appid}`}
        target="_blank"
        rel="noopener"
      >
        All news on Steam ↗
      </a>
    </>
  );
}

// Grouped by kind, so a pill needs no colour key; a tag that is also a genre shows once, as the genre.
const TAG_GROUPS = [
  { key: 'genres', label: 'Genres', kind: 'genre' },
  { key: 'tags', label: 'Tags', kind: 'tag' },
  { key: 'categories', label: 'Features', kind: 'category' },
] as const;

function TagsBody(props: { game: ReadonlyGame }): JSX.Element {
  const groups = createMemo(() => {
    const meta = props.game.details?.meta;
    const genres = [...(meta?.genres ?? [])].sort((a, b) => a.localeCompare(b));
    const items = {
      genres,
      tags: (props.game.details?.tags ?? []).filter((t) => !genres.includes(t)),
      categories: [...(meta?.categories ?? [])].sort((a, b) => a.localeCompare(b)),
    };
    return TAG_GROUPS.map((g) => ({ ...g, items: items[g.key] })).filter((g) => g.items.length);
  });
  const weight = (dim: string, v: string) => (dim === 'tags' ? (props.game.details?.tagWeights?.[v] ?? null) : null);
  return (
    <dl class="panel-tag-groups">
      <For each={groups()}>
        {(group) => (
          <div class="panel-tag-group">
            <dt>{group.label}</dt>
            <dd class="panel-tags">
              <For each={group.items}>
                {(v) => {
                  // "Co-op" can be both a tag and a feature: two pills a screen reader must tell apart.
                  const name = `${v}, ${group.kind}`;
                  const w = weight(group.key, v);
                  const title = w == null ? undefined : `${Math.round(w * 100)}% of the top tag's votes`;
                  const gauge = w == null ? null : <span class="tag-weight" style={{ width: `${w * 100}%` }} />;
                  return (
                    <Show
                      when={panelOptions.tagsFilterable()}
                      fallback={
                        <span class="panel-tag" title={title}>
                          <span aria-hidden="true">{v}</span>
                          <span class="visually-hidden">{name}</span>
                          {gauge}
                        </span>
                      }
                    >
                      <button
                        class="panel-tag panel-tag-btn"
                        classList={{ active: panelOptions.isTagActive(group.key, v) }}
                        aria-pressed={panelOptions.isTagActive(group.key, v)}
                        aria-label={name}
                        title={title}
                        onClick={() => panelOptions.onTagClick(group.key, v)}
                      >
                        {v}
                        {gauge}
                      </button>
                    </Show>
                  );
                }}
              </For>
            </dd>
          </div>
        )}
      </For>
    </dl>
  );
}

type SimilarLibrary = { taste: ReturnType<typeof loadTaste>; similar: ReturnType<typeof similarInLibrary> | null };

// The account's owned games closest by tags, from Owned's device cache; Steam's page covers the whole store.
function SimilarBody(props: {
  game: ReadonlyGame;
  shown: boolean;
  library: SimilarLibrary;
  account: string;
}): JSX.Element {
  const hasTags = () => !!props.game.details?.tags?.length;
  return (
    <>
      <MoreFrom game={props.game} />
      <Show when={props.shown && hasTags()}>
        <Show
          when={props.library.similar?.length}
          fallback={
            <div class="panel-similar-empty">
              {props.library.taste?.games.length ? (
                'No close match in this library.'
              ) : (
                <>
                  Open <A href={withAccountParam('/lists/owned')}>{props.account}'s Owned list</A> once on this device
                  to compare.
                </>
              )}
            </div>
          }
        >
          <ul class="panel-similar-list" role="list">
            <For each={props.library.similar}>
              {(s) => (
                <li>
                  <button
                    class="panel-similar-item"
                    title={`${s.score}% similar by Steam tags`}
                    onClick={() => navigateToGame(s.game.appid, s.game.name)}
                  >
                    <span class="panel-similar-name">{s.game.name}</span>
                    <span class="panel-similar-score">{s.score}%</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
      {/* A standalone lookup isn't a row, so the list has nothing to rank against it. */}
      <Show when={panelOptions.hasList() && !props.game.standalone && hasTags()}>
        <button
          class="panel-similar-sort"
          onClick={() =>
            panelOptions.setSimilarTo(panelOptions.similarTo() === props.game.appid ? null : props.game.appid)
          }
        >
          <Show
            when={panelOptions.similarTo() === props.game.appid}
            fallback={
              <>
                <ArrowUpDown /> Sort list by similarity
              </>
            }
          >
            <X /> Stop sorting by similarity
          </Show>
        </button>
      </Show>
      <a class="panel-card-link" href={steamMoreLikeUrl(props.game.appid)} target="_blank" rel="noopener">
        More like this on Steam ↗
      </a>
    </>
  );
}

function PanelLowerCards(props: { game: ReadonlyGame }): JSX.Element {
  const storeFailed = detailsFailed('Steam store');
  const dlc: PanelCardDef = {
    card: 'dlc',
    title: 'DLC',
    icon: Package,
    summary: () =>
      dlcSummary(props.game, panelData.dlcShown() && !panelData.dlc.loading ? panelData.dlc.latest : undefined),
    body: <DlcBody game={props.game} />,
    failed: storeFailed,
    sectionId: 'panel-section-dlc',
  };
  const ownedBy: PanelCardDef = {
    card: 'owned-by',
    title: 'Owned by',
    icon: Users,
    summary: () => ownedBySummary(panelData.owners.loading ? undefined : panelData.owners(), ownerMemberNames()),
    body: <OwnersBody />,
    wordFig: true,
    sectionId: 'panel-section-owners',
  };
  const about: PanelCardDef = {
    card: 'about',
    title: 'About',
    icon: Info,
    summary: () => aboutSummary(props.game, decodeHtml),
    body: (
      <p class="panel-desc" id="panel-desc">
        {decodeHtml(metaOrBasics(props.game.details)?.description ?? '')}
      </p>
    ),
    failed: storeFailed,
  };
  const tags: PanelCardDef = {
    card: 'tags',
    title: 'Tags & details',
    icon: Tag,
    summary: () => tagsSummary(props.game),
    body: <TagsBody game={props.game} />,
    failed: detailsFailed('Steam'),
  };
  const account = () => getEffectiveCurrentAccount();
  // On Owned, a row's closest owned games are the list's own Sort list by similarity.
  const similarShown = () => !!account() && !(panelOptions.isOwnedList() && !props.game.standalone);
  // Per game opened, so a library Owned cached meanwhile shows up.
  const library = createMemo((): SimilarLibrary => {
    const taste = similarShown() ? loadTaste(account()!.id) : null;
    return { taste, similar: taste && similarInLibrary(taste, props.game, SIMILAR_SHOWN) };
  });
  const accountLabel = () => (account() ? accountDisplayLabel(account()!) : '');
  const similar: PanelCardDef = {
    card: 'similar',
    title: 'Similar games',
    icon: Sparkles,
    summary: () =>
      similarSummary(props.game, {
        closest:
          similarShown() && props.game.details?.tags?.length
            ? (library().similar?.map((s) => s.game.name) ?? null)
            : undefined,
        account: similarShown() ? accountLabel() : null,
      }),
    body: <SimilarBody game={props.game} shown={similarShown()} library={library()} account={accountLabel()} />,
    sectionId: 'panel-section-similar',
  };
  // A ↻ keeps the summary shown; another game's load (the same resource, re-keyed) shimmers.
  const latestNews = () => (panelData.news.loading && !panelRefreshing() ? undefined : panelData.news.latest);
  const news: PanelCardDef = {
    card: 'news',
    title: 'News',
    icon: Newspaper,
    summary: () => newsSummary(latestNews()) ?? { kind: 'text', state: 'empty', text: 'no posts' },
    body: <NewsBody game={props.game} />,
    failed: () => ({ message: "Steam didn't answer.", retry: () => void panelData.refetchNews() }),
    sectionId: 'panel-section-news',
  };
  const hasNews = createMemo(() => newsSummary(latestNews()) !== null);
  return (
    <>
      <Show when={hasOwnerSource()} fallback={<PanelWideCard def={dlc} />}>
        <PanelTileRow first={dlc} second={ownedBy} />
      </Show>
      <PanelWideCard def={about} />
      <PanelWideCard def={tags} />
      <PanelWideCard def={similar} />
      <Show when={hasNews()}>
        <PanelWideCard def={news} />
      </Show>
    </>
  );
}

const toggleHeaderMenu = (menu: HeaderMenu) => setOpenHeaderMenu(openHeaderMenu() === menu ? null : menu);
const closeHeaderMenu = (menu: HeaderMenu) => openHeaderMenu() === menu && setOpenHeaderMenu(null);

// ⋯ More actions: what leaves for elsewhere (ITAD, Workshop, the website), Present and Copy link,
// so the action row keeps the one primary action and Add to list.
function MoreActions(props: { game: ReadonlyGame; copied: Node }): JSX.Element {
  const links = () =>
    [
      {
        icon: CircleDollarSign,
        label: 'IsThereAnyDeal',
        href: `https://isthereanydeal.com/steam/app/${props.game.appid}`,
      },
      !props.game.loading &&
        (props.game.details?.meta?.categories || []).includes('Steam Workshop') && {
          icon: Wrench,
          label: 'Steam Workshop',
          href: `https://steamcommunity.com/app/${props.game.appid}/workshop/`,
        },
      props.game.details?.meta?.website && {
        icon: Globe,
        label: 'Official website',
        href: props.game.details.meta.website,
      },
    ].filter((it): it is { icon: typeof Globe; label: string; href: string } => !!it);
  // While the hero's media is what's on the second screen, Present turns into its stop.
  const heroOnTv = createMemo(() => {
    const items = getPanelItems();
    return onTv(items[clampedHeroIdx(items.length)]?.shotId);
  });
  return (
    <div
      class="panel-icon-more"
      data-menu="more"
      // Else a menu left open behind focus would outlive the Esc meant for it (that closes the game).
      onFocusOut={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) closeHeaderMenu('more');
      }}
    >
      <button
        type="button"
        class="panel-icon-link panel-icon-more-btn"
        aria-haspopup="true"
        aria-expanded={openHeaderMenu() === 'more' ? 'true' : 'false'}
        title="More actions"
        aria-label="More actions"
        onClick={() => toggleHeaderMenu('more')}
      >
        <Ellipsis />
      </button>
      <Show when={openHeaderMenu() === 'more'}>
        <ul class="panel-icon-more-menu">
          <For each={links()}>
            {(it) => (
              <li>
                <a class="panel-icon-more-item" href={safeHref(it.href) || undefined} target="_blank" rel="noopener">
                  <it.icon /> {it.label} ↗
                </a>
              </li>
            )}
          </For>
          <li class="panel-present-item">
            <button
              type="button"
              class="panel-icon-more-item panel-present-btn"
              classList={{ 'panel-present-btn--on': heroOnTv() }}
              aria-keyshortcuts={heroOnTv() ? undefined : 'P'}
              onClick={() => (heroOnTv() ? stopPresenting() : presentHero())}
            >
              <Cast /> {heroOnTv() ? 'Stop presenting' : 'Present on second screen'}
              <Show when={!heroOnTv()}>
                <Kbd k="P" />
              </Show>
            </button>
          </li>
          <li>
            <button
              type="button"
              class="panel-icon-more-item panel-copy-link-btn"
              aria-label="Copy link to this game"
              onClick={(e) => copyPanelLink(e, props.copied)}
            >
              <Link /> Copy link
            </button>
          </li>
        </ul>
      </Show>
    </div>
  );
}

// The manual lists, each checked while it holds the game: a click adds or removes it, saved at once.
function ListsMenu(props: { appid: number }): JSX.Element {
  // getLists reads a tracked pref: a list made, renamed or synced elsewhere shows up here.
  const lists = createMemo(() => getLists().filter((l) => l.kind === 'manual'));
  // By id: each change stores new list objects, and re-rendering the row would drop its focus.
  const listIds = createMemo(() => lists().map((l) => l.id));
  const holds = (id: string) => lists().some((l) => l.id === id && l.appids?.includes(props.appid));
  const holding = createMemo(() => lists().filter((l) => l.appids?.includes(props.appid)).length);
  let nameInput: HTMLInputElement | undefined;
  const label = () => (holding() ? `In ${holding()} list${holding() === 1 ? '' : 's'}: add or remove` : 'Add to list');
  const toggle = (listId: string, name: string, add: boolean) => {
    if (add) addToManualList({ listId }, [props.appid]);
    else removeAppidsFromList(listId, [props.appid]);
    announce(add ? `Added to "${name}".` : `Removed from "${name}".`);
    panelOptions.onListChanged(listId);
  };
  return (
    <div
      class="panel-icon-more"
      data-menu="lists"
      onFocusOut={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) closeHeaderMenu('lists');
      }}
    >
      <button
        type="button"
        class="btn panel-lists-btn"
        aria-expanded={openHeaderMenu() === 'lists' ? 'true' : 'false'}
        title={label()}
        aria-label={label()}
        onClick={() => toggleHeaderMenu('lists')}
      >
        <ListPlus /> {holding() ? `In ${holding()} list${holding() === 1 ? '' : 's'}` : 'Add to list'}
      </button>
      <Show when={openHeaderMenu() === 'lists'}>
        <ul class="panel-icon-more-menu panel-lists-menu">
          <For each={listIds()}>
            {(id) => {
              const name = () => lists().find((l) => l.id === id)?.name ?? 'list';
              return (
                <li>
                  <label class="panel-icon-more-item">
                    <input
                      type="checkbox"
                      checked={holds(id)}
                      onChange={(e) => toggle(id, name(), e.currentTarget.checked)}
                    />
                    {name()}
                  </label>
                </li>
              );
            }}
          </For>
          <li>
            <form
              class="panel-lists-new"
              onSubmit={(e) => {
                e.preventDefault();
                const name = nameInput?.value.trim();
                if (!name || !nameInput) return;
                announce(addToManualList({ newName: name }, [props.appid]).message);
                nameInput.value = '';
              }}
            >
              <input ref={nameInput} type="text" aria-label="New list name" placeholder="New list name" />
              <button type="submit" class="btn">
                Create
              </button>
            </form>
          </li>
        </ul>
      </Show>
    </div>
  );
}

// How old this game's details are, and the ↻ that fixes it, as one control — the same shape the
// list heroes' Updated tile has (ListHero.tsx's refreshTileValue). The age used to be readable
// only inside this button's `title`, which a touch device never shows at all: the panel was the
// one surface stating no data age anywhere on screen, while being the surface a stale rating or
// playtime estimate is actually read from.
// What the visible figure is the oldest of, in the order the panel itself reads them. The number
// on the button is one age for five separately-cached sources whose TTLs run 90–180 days, so it
// is routinely dated by whichever one nobody has had a reason to re-fetch since — the breakdown
// is what makes it interpretable, and the tooltip is where it fits without turning a button into
// a table.
const DETAILS_SOURCES: [keyof DetailsAges, string][] = [
  ['rating', 'Reviews'],
  ['hltb', 'How Long To Beat'],
  ['meta', 'Store details'],
  ['tags', 'Tags'],
  ['protondb', 'ProtonDB'],
];

function refreshTitle(game: ReadonlyGame): string {
  const ages = game.detailsFetchedAts;
  const lines = ages
    ? DETAILS_SOURCES.filter(([key]) => ages[key] !== undefined).map(([key, label]) => `${label}: ${fmtAge(ages[key])}`)
    : [];
  // The price is deliberately conditional: a game whose list already priced it is not re-priced
  // from here (see panelData's priceSource), which is exactly the case a reader would otherwise
  // have to discover by clicking and watching nothing happen.
  const pricedHere = game.bestDealPrice === undefined;
  return [
    ...lines,
    `${lines.length ? '\n' : ''}Click to re-fetch these, plus news, achievements${pricedHere ? ' and price' : ''}.`,
    // The server keeps a source fetched under FORCE_MIN_AGE_MINUTES ago (default.env).
    'A source fetched minutes ago is kept as it is.',
    ...(pricedHere ? [] : ["The price came from this list — refresh it on the list's own Prices tile."]),
  ].join('\n');
}

function RefreshButton(props: { game: ReadonlyGame }): JSX.Element {
  const age = () => (props.game.detailsFetchedAt === undefined ? '' : fmtAge(props.game.detailsFetchedAt));
  return (
    <Show when={!props.game.loading}>
      <button
        type="button"
        class="panel-refresh-btn"
        disabled={panelRefreshing()}
        title={refreshTitle(props.game)}
        aria-label="Refresh details"
        onClick={handlePanelRefresh}
      >
        <Show when={age() || panelRefreshing()}>
          <span class="panel-refresh-age">{panelRefreshing() ? 'Refreshing…' : age()}</span>
        </Show>
        {/* Only the icon spins — the animation used to be on the button itself, which now has
            text in it. */}
        <RefreshCw class={`panel-refresh-icon${panelRefreshing() ? ' is-refreshing' : ''}`} />
      </button>
    </Show>
  );
}

// "In library" / "On wishlist" status — unlike the Price card, this one *is* fetched by panel.tsx
// itself (the `ownership` resource above), against `currentAccount` (whichever account's list is
// actually on screen — see myOwnership.ts's own comment for why this used to be `myAccount` and
// isn't anymore) rather than a separately pinned identity, so it always has exactly one
// unambiguous /lists/owned or /lists/wishlist to link to. See the original file's own comment
// (preserved in git history) for the "why 'In library' not 'In your library'" reasoning this
// label wording still follows. Links to `?game=<appid>` on that list (not the bare route) so
// landing there also reopens this exact game, same as `copyPanelLink`'s own `/game/<appid>` link
// opens a specific game rather than just a list.
//
// withAccountParam: these badges answer "does the account currently on screen have this", which
// is the `?u=` link's account when one is being explored (see myOwnership.ts / accountsStore.ts's
// own `?u=` section) — so the list they link to has to be that same account's, not the visitor's
// own stored one. `copyPanelLink` above deliberately does NOT do this: that link is the game's
// canonical shareable address, and carrying whichever account the sender happened to be exploring
// into it would make it explore that account for everyone it's shared with.
//
// Read off the resource, not off `g.inLibrary`/`g.onWishlist`: those two fields still exist, but
// they're the *table's* copy of this, stamped onto every row by the host route for its ✓/☆
// name-cell markers (see gameColumns.ts) — a standalone lookup or a DLC hop is never one of those
// rows and would have no badge at all. The resource answers for any open game, and both go
// through myOwnership.ts's one cached pair of sets, so they can't disagree.
// The player's own status for a game of theirs (gameStatuses.ts), which Steam can't tell from hours.
function StatusSelect(props: { appid: number }): JSX.Element {
  const status = () => getStatus(props.appid);
  return (
    <select
      class="panel-status"
      classList={{ set: !!status() }}
      aria-label="Status"
      title="Marked finished or abandoned, Play next leaves it out"
      value={status() ?? ''}
      onChange={(e) => setStatus(props.appid, (e.currentTarget.value || null) as GameStatus | null)}
    >
      <option value="">{status() ? 'No status' : 'Mark…'}</option>
      <For each={Object.entries(STATUS_LABELS)}>{([value, label]) => <option value={value}>{label}</option>}</For>
    </select>
  );
}

function OwnershipRow(props: { game: ReadonlyGame }): JSX.Element {
  const own = () => panelData.ownership();
  return (
    <Show when={own()?.inLibrary || own()?.onWishlist}>
      <div class="panel-ownership-row">
        <Show when={own()?.inLibrary}>
          <A
            class="panel-ownership-badge owned"
            href={withAccountParam(`/lists/owned?game=${props.game.appid}`)}
            aria-label="In library"
            title="In library"
          >
            <Check /> <span class="panel-ownership-label">In library</span>
          </A>
        </Show>
        <Show when={own()?.onWishlist}>
          <A
            class="panel-ownership-badge wishlisted"
            href={withAccountParam(`/lists/wishlist?game=${props.game.appid}`)}
            aria-label="On wishlist"
            title="On wishlist"
          >
            <Star /> <span class="panel-ownership-label">On wishlist</span>
          </A>
        </Show>
      </div>
    </Show>
  );
}

function PanelRest(props: { game: ReadonlyGame }): JSX.Element {
  // The one deliberate capture of a "reactive variable" in this file: `props.game` is the game
  // *object*, and PanelBody renders this component under a `keyed` <Show>, so a different game
  // means a new PanelRest rather than a new value for this prop. The object itself is a Solid
  // store row, so every `g.field` read below is still tracked individually — capturing the row
  // is not the same thing as capturing a field of it.
  // eslint-disable-next-line solid/reactivity
  const g = props.game;
  const meta = () => g.details?.meta;

  // "← Back" only appears once a DLC hop is actually in progress — a plain table-row click never
  // gets this button, only a game reached by following a DLC link (or by going back through more
  // than one of them) does.
  // Shown by the copy-link button's flash: created here, where an owner can dispose of it.
  const copiedIcon = (
    <span class="panel-copied">
      <Check /> Copied
    </span>
  ) as Node;

  const back = () => {
    const hist = panelHistory();
    return hist.length ? hist[hist.length - 1] : null;
  };

  // Release date and "DLC for X" folded onto one line ("<date> · DLC for X") since both are
  // short, secondary metadata about the same thing. `hasBaseGame` is a plain boolean rather than
  // the rendered element's own truthiness (a `<Component/>` call is truthy regardless of what it
  // renders to, including `null`) so the separator and the link itself can never disagree about
  // whether there's a base game to show.
  const releaseDate = () => metaOrBasics(g.details)?.releaseDate;
  const hasBaseGame = () => !g.loading && !!meta()?.fullgame;
  const developer = () => metaOrBasics(g.details)?.developers?.[0];
  // On this line, which has room: the action row below has none on a phone.
  const statusShown = () => !!panelData.ownership()?.inLibrary && showingMyAccount();

  return (
    <>
      <div class="panel-header-sticky">
        <Show when={back()}>
          {(prev) => (
            <button
              type="button"
              class="panel-back-btn"
              title={`Back to ${prev().name}`}
              aria-label={`Back to ${prev().name}`}
              onClick={panelGoBack}
            >
              <ChevronLeft /> {prev().name}
            </button>
          )}
        </Show>
        <div class="panel-title-row">
          <div>
            {/* The `App <appid>` fallback is presentational only — a game looked up by bare appid
                has no name at all until store metadata resolves one, and nothing persists this
                string as if it were a real title (see ListRoute.tsx's recents mapping). */}
            <h2 class="panel-title" id="panel-title">
              {g.name || `App ${g.appid}`}
            </h2>
            {/* date · developer · base game · ownership · Status · the details' age, which is ↻ */}
            <div class="panel-meta">
              <Show when={releaseDate()}>{(r) => <DayText text={fmtReleaseDate(r())} />}</Show>
              <Show when={developer()}>
                {(name) => (
                  <>
                    <Show when={releaseDate()}>
                      <span class="panel-meta-sep" aria-hidden="true">
                        ·
                      </span>
                    </Show>
                    <a
                      class="panel-developer"
                      href={withAccountParam(`${creatorListPath('developer', name())}&game=${g.appid}`)}
                      aria-label={`All games by ${name()} (developer)`}
                    >
                      {name()}
                    </a>
                  </>
                )}
              </Show>
              <Show when={hasBaseGame()}>
                <Show when={releaseDate() || developer()}>
                  <span class="panel-meta-sep" aria-hidden="true">
                    ·
                  </span>
                </Show>
                <BaseGameLink game={g} />
              </Show>
              <OwnershipRow game={g} />
              <Show when={statusShown()}>
                <StatusSelect appid={g.appid} />
              </Show>
              <RefreshButton game={g} />
            </div>
          </div>
        </div>
        <div class="panel-actions">
          <a
            class="btn btn-primary panel-store-btn"
            href={`https://store.steampowered.com/app/${g.appid}`}
            target="_blank"
            rel="noopener"
          >
            <ShoppingCart /> Steam Store
          </a>
          <ListsMenu appid={g.appid} />
          <MoreActions game={g} copied={copiedIcon} />
        </div>
      </div>
      {/* A free demo is a "try before you buy" call to action, not supplementary info like the
          Website/Workshop links tucked into "⋯ More". */}
      <Show when={!g.loading && g.details?.demo}>
        {(demo) => (
          <a
            class="btn panel-demo-banner"
            href={safeHref(`https://store.steampowered.com/app/${demo()}`) || undefined}
            target="_blank"
            rel="noopener"
          >
            <Gamepad2 class="panel-demo-banner-icon" /> Try the Free Demo
          </a>
        )}
      </Show>
      <PanelTiles game={g} />
      <PriceCard game={g} />
      <PanelLowerCards game={g} />
    </>
  );
}

function PanelBody(): JSX.Element {
  return (
    <>
      <PanelHero />
      {/* `keyed`, so the body below is rebuilt when the panel moves to a *different game* — and
          only then. Every field of the game itself is read reactively off the store row (see
          PanelRest), so data streaming in for the game already on screen patches the one thing it
          changed instead of re-rendering anything. */}
      <Show when={panelGame()} keyed>
        {(game) => <PanelRest game={game} />}
      </Show>
    </>
  );
}

function initHeroSwipe() {
  // Bound to #panel-body (stable across renders) rather than #panel-hero itself, which is
  // recreated on every panelOpen but not on most re-renders (see PanelHero above) — binding
  // here rather than to the hero element means this never needs to be rebound.
  const hero = document.getElementById('panel-body')!;
  let startX = 0,
    startY = 0,
    tracking = false,
    axis: SwipeAxis | null = null;

  hero.addEventListener(
    'touchstart',
    (e) => {
      const target = e.target as Element;
      if (e.touches.length !== 1 || target.closest('.panel-filmstrip') || !target.closest('.panel-hero')) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      tracking = true;
      axis = null;
    },
    { passive: true },
  );

  hero.addEventListener(
    'touchmove',
    (e) => {
      if (!tracking || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      axis ??= decideSwipeAxis(dx, dy, 8);
    },
    { passive: true },
  );

  hero.addEventListener(
    'touchend',
    (e) => {
      if (!tracking || axis !== 'x') {
        tracking = false;
        return;
      }
      tracking = false;
      const dx = e.changedTouches[0].clientX - startX;
      if (Math.abs(dx) < 40) return;
      panelStepHero(dx < 0 ? 1 : -1);
    },
    { passive: true },
  );

  hero.addEventListener(
    'touchcancel',
    () => {
      tracking = false;
    },
    { passive: true },
  );
}

function initPanelSwipe() {
  const panel = document.getElementById('game-panel')!;
  let startX = 0,
    startY = 0,
    tracking = false,
    axis: SwipeAxis | null = null;

  panel.addEventListener(
    'touchstart',
    (e) => {
      const target = e.target as Element;
      // A hero with something to step to has its own swipe, which decides later than this one.
      const heroSwipes = !!target.closest('.panel-hero') && getPanelItems().length > 1;
      if (e.touches.length !== 1 || target.closest('.panel-filmstrip') || heroSwipes) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      tracking = true;
      axis = null;
      panel.style.transition = 'none';
    },
    { passive: true },
  );

  panel.addEventListener(
    'touchmove',
    (e) => {
      if (!tracking || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      axis ??= decideSwipeAxis(dx, dy, 6);
      if (axis !== 'x' || dx <= 0) return;
      e.preventDefault();
      panel.style.transform = `translateX(${dx}px)`;
    },
    { passive: false },
  );

  function finish(clientX: number) {
    if (!tracking) return;
    tracking = false;
    const dx = clientX - startX;
    if (axis === 'x' && dx > 80) {
      panel.style.transition = 'transform 0.2s ease';
      panel.style.transform = 'translateX(100%)';
      setTimeout(() => {
        panelClose({ animate: false }); // the swipe already slid it out
        panel.style.transition = '';
        panel.style.transform = '';
      }, 200);
    } else {
      if (panel.style.transform) {
        panel.style.transition = 'transform 0.25s ease';
        panel.style.transform = '';
        setTimeout(() => {
          panel.style.transition = '';
        }, 250);
      } else {
        panel.style.transition = '';
      }
    }
  }

  panel.addEventListener('touchend', (e) => finish(e.changedTouches[0].clientX), { passive: true });
  panel.addEventListener(
    'touchcancel',
    () => {
      tracking = false;
      panel.style.transition = 'transform 0.25s ease';
      panel.style.transform = '';
      setTimeout(() => {
        panel.style.transition = '';
      }, 250);
    },
    { passive: true },
  );
}
