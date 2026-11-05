import {
  fmtAge,
  fmtPlaytime,
  formatMoney,
  scoreColor,
  smoothScroll,
  dealRecordTier,
  DEAL_RECORD_TIERS,
  fmtH,
  fmtLastPlayed,
  computeSteamdbRating,
  PROTON_TIER_COLORS,
  PROTON_TIER_UNKNOWN,
  focusGameRow,
  fadeInOnLoad,
  safeHref,
  fmtReleaseDate,
  MEDIA_FAILED,
  noStorePage,
  metaOrBasics,
} from './utils.ts';
import { openLightbox, openLightboxFrom, lightboxShot, lightboxOpen } from './lightbox.tsx';
import { isMorphUpdating, loadedWhen, morph } from './viewTransition.ts';
import { animate, durationToken, easeOut, prefersReducedMotion } from './motion.ts';
import { sampleArtTint } from './artTint.ts';
import { decideSwipeAxis, type SwipeAxis } from './lightboxSwipe.ts';
import { pushOverlayEntry, popOverlayEntry } from './overlayHistory.ts';
import { buildMediaItems, mediaLabel, resolveShotIndex } from './mediaItems.ts';
import type { MediaItem } from './mediaItems.ts';
import { getMyOwnershipStatus, getOwnersFor } from './myOwnership.ts';
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
  fetchBundles,
  bundlesRefusal,
  fetchDlc,
  isItadOff,
} from './panelData.ts';
import type {
  DlcEntry,
  GameBundle,
  PanelAchievements,
  PanelBundles,
  PanelDlc,
  PanelNews,
  PanelPrice,
} from './panelData.ts';
import { bestPickRate, bundleUrgency, pickTiers } from './bundleRows.ts';
import { fmtDateTime } from './dateTime.ts';
import { formatWithEstimate } from './currency.ts';
import { currentRegion, regionCurrency } from './region.ts';
import { nextHopHistory } from './panelHistory.ts';
import { similarInLibrary } from './tagTaste.ts';
import { loadTaste } from './tasteCache.ts';
import { clearPanelNav } from './panelNav.ts';
import type { PanelHistoryEntry } from './panelHistory.ts';
import { setGameTitle } from './pageTitle.ts';
import { PRICES_UNAVAILABLE } from './priceLoading.ts';
import { TIER_RANGE_TITLE } from './bundleData.ts';
import { withAccountParam, urlWithoutPanel } from './urlState.ts';
import { copyWithFeedback } from './clipboard.ts';
import type { DetailsAges, GameMeta, PriceFields, ReadonlyGame } from './types.ts';

import {
  createSignal,
  createEffect,
  createMemo,
  createResource,
  createRoot,
  For,
  Show,
  untrack,
  type JSX,
} from 'solid-js';
import { Dynamic, render } from 'solid-js/web';
import { A, useLocation, useCurrentMatches } from '@solidjs/router';
import { creatorListPath, type CreatorRole } from './creatorData.ts';
import { present, presented, privateMode } from './presentation.ts';
import ArrowUpDown from 'lucide-solid/icons/arrow-up-down';
import Check from 'lucide-solid/icons/check';
import ChevronLeft from 'lucide-solid/icons/chevron-left';
import ChevronRight from 'lucide-solid/icons/chevron-right';
import CircleDollarSign from 'lucide-solid/icons/circle-dollar-sign';
import Ellipsis from 'lucide-solid/icons/ellipsis';
import Gamepad2 from 'lucide-solid/icons/gamepad-2';
import Globe from 'lucide-solid/icons/globe';
import Link from 'lucide-solid/icons/link';
import Newspaper from 'lucide-solid/icons/newspaper';
import Package from 'lucide-solid/icons/package';
import RefreshCw from 'lucide-solid/icons/refresh-cw';
import ShoppingCart from 'lucide-solid/icons/shopping-cart';
import Star from 'lucide-solid/icons/star';
import Timer from 'lucide-solid/icons/timer';
import Cast from 'lucide-solid/icons/cast';
import TriangleAlert from 'lucide-solid/icons/triangle-alert';
import Wrench from 'lucide-solid/icons/wrench';
import X from 'lucide-solid/icons/x';

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
export interface PanelOptions {
  onTagClick: (dim: string, val: string) => void;
  tagsFilterable: () => boolean; // false: tags render as plain pills
  isTagActive: (dim: string, val: string) => boolean;
  onRefresh: (game: ReadonlyGame) => void;
  onNavigateGame: (appid: number, name: string) => void;
  onClose: (opts?: { leavingRoute?: boolean }) => void;
  // The route's own owners for a game (a comparison's players), over the current account's.
  getOwners: (appid: number) => GameOwner[] | null;
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
//  1. The panel's own UI state (`panelGame`/`heroIdx`/`moreLinksOpen`/`panelHistory`/
//     `expandedSections`/`revealedAchievements`/`achievementsFilter`/`panelRefreshing`) — plain
//     signals, set directly by this file's own click handlers.
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
const [moreLinksOpen, setMoreLinksOpen] = createSignal(false); // whether the header's "⋯" overflow menu (Workshop/Website) is open

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

  // Dismiss the "⋯ More links" menu on outside click, same convention as gameSearch.ts's
  // own dropdown — needs to catch clicks *outside* the panel too (backdrop, page behind it),
  // so this stays a document-level listener rather than something the menu button's own
  // onClick could handle alone. Uses `e.composedPath()` rather than `e.target.closest(...)` —
  // the menu button's own click toggles `moreLinksOpen` synchronously, which re-renders this
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
      moreLinksOpen() &&
      !e.composedPath().some((el) => el instanceof Element && el.classList.contains('panel-icon-more'))
    )
      setMoreLinksOpen(false);
  });
  // Capture, as bindNavPopover: ahead of panelKeyboard.ts's Esc, which skips a handled one.
  // Not once focus has left the panel: a layer opened above it (the shortcuts dialog, nav search) owns Esc.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || !moreLinksOpen()) return;
      const active = document.activeElement;
      if (active && active !== document.body && !active.closest('#game-panel')) return;
      e.preventDefault();
      setMoreLinksOpen(false);
      document.querySelector<HTMLElement>('#game-panel .panel-icon-more-btn')?.focus();
    },
    true,
  );

  initPanelSwipe();
  initHeroSwipe();
  initSubnavScrollSpy();

  // The one place document.title's "a game is open" layer is driven from (see pageTitle.ts).
  // `game.name` is read inside the effect, so a standalone lookup's placeholder title
  // (`App <appid>`, before store metadata resolves the real one) is replaced as soon as the
  // store row's `name` is written — the effect subscribes to that one field.
  createEffect(() => {
    const game = panelGame();
    setGameTitle(game ? game.name : null);
  });
}

// Highlights whichever subnav button corresponds to the section currently scrolled to the
// top of the visible body, instead of the subnav being a static row of jump-links with no
// sense of "where am I". Bound once to #panel-body (a stable element across every render)
// rather than to the subnav, which is rebuilt whenever the panel moves to a different game.
function initSubnavScrollSpy() {
  const body = document.getElementById('panel-body')!;
  body.addEventListener(
    'scroll',
    () => {
      requestAnimationFrame(updateSubnavScrollSpy);
    },
    { passive: true },
  );
  // Scrolling by hand hands the highlight back to the scroll position.
  for (const type of ['wheel', 'touchstart', 'keydown'] as const)
    body.addEventListener(type, () => (pinnedSubnavTarget = null), { passive: true });
  // The tabs wrap differently at another width, moving the underline's tab.
  window.addEventListener('resize', () => requestAnimationFrame(updateSubnavScrollSpy), { passive: true });
}

// The section a subnav click jumped to, kept highlighted until the user scrolls themselves: one
// near the end can't reach the top, where the rule below looks.
let pinnedSubnavTarget: string | null = null;

// Buttons are walked in DOM order, which the body below keeps identical to the physical
// top-to-bottom order of the sections themselves (Owners right after the tag cloud,
// then HLTB/News/Achievements — see subnavItems below) — so the *last* button whose
// section has scrolled up to (or past) the sticky header counts as "current", same idea as
// a scrollspy TOC. None qualifying means we're still above the first section, i.e. still
// looking at the Overview (glance grid/description) itself.
function updateSubnavScrollSpy() {
  if (untrack(lightboxOpen)) return; // behind it, unseen: measured again on close
  const nav = document.querySelector('.panel-subnav');
  if (!nav) return;
  const body = document.getElementById('panel-body')!;
  const headerH = document.querySelector('.panel-header-sticky')?.getBoundingClientRect().height ?? 0;
  const threshold = body.getBoundingClientRect().top + headerH + 8;
  const buttons = [...nav.querySelectorAll<HTMLElement>('.panel-subnav-btn')];
  // Scrolled to the end, the last section showing is current, though it never reached the top.
  const atEnd = body.scrollTop > 0 && body.scrollTop + body.clientHeight >= body.scrollHeight - 2;
  const limit = atEnd ? body.getBoundingClientRect().bottom - 24 : threshold;
  let activeTarget = 'top';
  for (const btn of buttons) {
    const target = btn.dataset.target;
    if (target === undefined || target === 'top') continue;
    const el = document.getElementById(target);
    if (!el || el.getBoundingClientRect().top > limit) continue;
    activeTarget = target;
  }
  if (pinnedSubnavTarget && buttons.some((btn) => btn.dataset.target === pinnedSubnavTarget))
    activeTarget = pinnedSubnavTarget;
  let active: HTMLElement | undefined;
  for (const btn of buttons) {
    const on = btn.dataset.target === activeTarget;
    btn.classList.toggle('active', on);
    if (on) {
      btn.setAttribute('aria-current', 'true');
      active = btn;
    } else btn.removeAttribute('aria-current');
  }
  const list = nav.querySelector('ul');
  placeSubnavUnderline(list, active);
  // The tabs scroll sideways in one row: bring the current one into view when it changes or moves (a tab
  // arriving before it, a resize), leaving a manual swipe alone.
  const li = active?.parentElement;
  const placed = li ? `${activeTarget} ${li.offsetLeft} ${li.offsetWidth}` : undefined;
  if (list && li && list.dataset.active !== placed) {
    list.dataset.active = placed;
    const left = Math.min(li.offsetLeft, Math.max(list.scrollLeft, li.offsetLeft + li.offsetWidth - list.clientWidth));
    if (left !== list.scrollLeft) list.scrollTo({ left, behavior: smoothScroll() });
  }
}

// The current tab's underline, one bar on the list moved under it; it glides only once placed.
function placeSubnavUnderline(list: HTMLElement | null, btn: HTMLElement | undefined) {
  if (!list || !btn || !btn.offsetWidth) return;
  const li = btn.parentElement!;
  list.style.setProperty('--underline-x', `${li.offsetLeft}px`);
  list.style.setProperty('--underline-y', `${li.offsetTop + li.offsetHeight}px`);
  list.style.setProperty('--underline-w', String(li.offsetWidth));
  if (!list.dataset.glide) requestAnimationFrame(() => (list.dataset.glide = ''));
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
    // fetcher reads as "force" (bypass both this app's session cache and the server's own TTL).
    // A refetch of a resource whose source is currently null — price, for a game its list
    // already priced — is a no-op by construction, no extra check needed here. DLC isn't
    // refetched: forcing every one of a game's DLC would cost one store lookup each.
    await Promise.all([
      panelOptions.onRefresh(game),
      panelData.refetchNews(),
      panelData.refetchPrice(),
      panelData.refetchBundles(),
      panelData.refetchAchievements(),
    ]);
  } finally {
    setPanelRefreshing(false);
  }
}

// The 🔗 button beside Store/ITAD in the header — copies a link back to this exact game.
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

// Which collapsible sections (HLTB breakdown, news, achievements — anything built with
// CollapsibleCard() below) are expanded, keyed `${appid}:${section}` so each game/section
// pair remembers its own choice independently, and which individual hidden achievements
// have been click-revealed (keyed `${appid}:${apiname}`). Re-opening a game later in the
// same session remembers prior choices; never cleared (a handful of strings per game
// touched is negligible, and a page reload resets it anyway). Solid signals (each holding a Set,
// replaced wholesale on every toggle) rather than plain module-level Sets, so a CollapsibleCard's
// own expanded/collapsed chevron reacts to a toggle on its own.
const [expandedSections, setExpandedSections] = createSignal<Set<string>>(new Set());
const [revealedAchievements, setRevealedAchievements] = createSignal<Set<string>>(new Set());
// Which achievement list filter ('all' | 'unlocked' | 'locked') each game is currently
// showing — same per-appid, never-cleared-this-session shape as expandedSections above.
// Defaults to 'all' (map lookup miss) for any appid never touched.
const [achievementsFilter, setAchievementsFilter] = createSignal<Map<number, string>>(new Map());

function isSectionExpanded(appid: number, section: string) {
  return expandedSections().has(`${appid}:${section}`);
}

function toggleSection(appid: number, section: string) {
  const key = `${appid}:${section}`;
  const wasExpanded = expandedSections().has(key);
  const next = new Set(expandedSections());
  if (wasExpanded) next.delete(key);
  else next.add(key);
  setExpandedSections(next);
}

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
// section anywhere is expanded/collapsed, and must not turn that into a fresh DLC fetch.
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
    return fetchNews(appid, { force: isForced(info), settled: () => openAppid() === appid });
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
        force: isForced(info),
        settled: () => appidAndAccount() === key,
        achievementCount: g.details?.meta?.achievementCount,
      });
    },
  );

  // Both of these are free in practice — myOwnership.ts already holds the current account's
  // owned/wishlist sets (and per-member playtimes) from one fetch shared with the ✓/☆ markers on
  // every table row, so these await a resolved promise rather than making a request.
  const ownersKey = createMemo(() => {
    const key = appidAndAccount();
    return key == null ? null : `${key}:${ownersRev()}`;
  });
  const [owners] = createResource<GameOwner[], string>(ownersKey, () => {
    const appid = openAppid();
    if (appid == null) return [];
    return panelOptions.getOwners(appid) ?? getOwnersFor(appid);
  });

  const [ownership] = createResource<OwnershipStatus | null, string>(appidAndAccount, () => {
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
    return fetchPrice(Number(appid), region, { force: isForced(info), settled: () => priceSource() === key });
  });

  const bundlesSource = createMemo(() => (openAppid() == null ? null : `${openAppid()}:${currentRegion()}`));
  const [bundles, { refetch: refetchBundles }] = createResource<PanelBundles, string>(bundlesSource, (key, info) => {
    const [appid, region] = key.split(':');
    return fetchBundles(Number(appid), region, { force: isForced(info), settled: () => bundlesSource() === key });
  });

  // DLC is the one card whose fetch is gated behind actually expanding it (see panelData.ts's
  // fetchDlc) — expressed here as "this game's card is expanded" being part of the source, so
  // expanding it *is* what starts the fetch. That also covers the case the old code needed a
  // separate kick-off for: `expandedSections` remembers "DLC is expanded" per appid for the whole
  // session, so a game reopened later renders its card already open, with no click left to happen
  // — the source is already truthy on the first render, so the fetch just runs.
  // `shown` is how many entries the card asks for: DLC_PAGE, plus DLC_PAGE per "Show more".
  const [dlcMore, setDlcMore] = createSignal<{ appid: number; shown: number } | null>(null);
  // The number shown rides along as an `appid:shown` string, so "Show more" re-runs the fetch.
  const dlcShown = (): number => {
    const g = panelGame();
    const ids = g?.details?.meta?.dlc;
    if (!g || !ids?.length || !isSectionExpanded(g.appid, 'dlc')) return 0;
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
    return fetchDlc(ids, { onPartial: (entries) => setDlcPartial({ appid, entries }) });
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
    bundles,
    refetchBundles,
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

// Clicking a DLC entry in the expanded card (see DlcSection), or the "Part of <Base Game>"
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
  return g ? buildMediaItems(g.appid, metaOrBasics(g.details)) : [];
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
  pinnedSubnavTarget = null; // a jump in the previous game's panel says nothing about this one
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
  setMoreLinksOpen(false);
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
  setMoreLinksOpen(false);
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
  for (const el of [ghost, ...ghost.querySelectorAll('[id], [name], [aria-labelledby]')])
    for (const attr of ['id', 'name', 'aria-labelledby']) el.removeAttribute(attr);
  ghost.className = 'panel-ghost';
  ghost.inert = true;
  ghost.ariaHidden = 'true';
  ghost.addEventListener('animationend', () => ghost.remove(), { once: true });
  panel.after(ghost);
  ghost.querySelector('.panel-body')!.scrollTop = panel.querySelector('.panel-body')!.scrollTop;
}

// Scrolls #panel-body so `target` (a section id, or the literal 'top') sits just below the
// sticky title/subnav header, rather than under it. Computed via getBoundingClientRect()
// deltas (viewport-relative, so it's correct regardless of #panel-body's own positioning
// context) rather than offsetTop, which is relative to the nearest *positioned* ancestor —
// here that's #game-panel (position: fixed), not #panel-body itself, so offsetTop would
// include the hero/hero-filmstrip height above the header and land short.
function jumpToPanelSection(target: string) {
  pinnedSubnavTarget = target;
  updateSubnavScrollSpy();
  const body = document.getElementById('panel-body')!;
  if (target === 'top') {
    body.scrollTo({ top: 0, behavior: smoothScroll() });
    return;
  }
  const el = document.getElementById(target);
  if (!el) return;
  const headerH = document.querySelector('.panel-header-sticky')?.getBoundingClientRect().height ?? 0;
  const delta = el.getBoundingClientRect().top - body.getBoundingClientRect().top - headerH - 8;
  body.scrollTo({ top: body.scrollTop + delta, behavior: smoothScroll() });
}

// ProtonDB's community-reported Linux/Steam Deck compatibility tiers, worst to best.
// Colors are our own (not scraped from protondb.com), just distinct + dark enough for
// white badge text: red (unplayable) through gold/platinum (flawless) plus a green
// "native" tier for games with an actual Linux port (no Proton layer needed at all).
// Tier names themselves come straight from ProtonDB's API (see lib/steam.js) and are
// already human-readable words — capitalized for display, not remapped through a label
// table, so a new tier ProtonDB introduces still renders (just without a custom color).
// No "pending" entry — extractProtonDb (lib/steam.js) maps a "pending" (too-few-reports)
// result to its own provisionalTier before it ever reaches the client, flagged `pd.pending`
// (see GlanceGrid below) so it can still be shown, just visibly marked low-confidence rather
// than presented as equal to a confirmed tier of the same name.
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Compact review-count suffix for the reviews line, e.g. 465234 -> "465k", 2100000 -> "2.1m".
function fmtCompactCount(n: number) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

// Tags/genres/categories/developer-publisher used to each get their own "uppercase
// title + pill row" section — four near-identical blocks in a row. Merged into one
// cloud instead, kind distinguished by a small colored dot (+ a legend) rather than
// by which section a pill happens to sit in. `kind` picks the dot color/legend label;
// `dim` is the actual click-filter
// dimension, kept separate from `kind` since developers/publishers share one visual
// kind but are two different filter dimensions.
type TagKind = keyof typeof TAG_KIND_META;
const TAG_KIND_META = {
  tags: { label: 'Tag' },
  genres: { label: 'Genre' },
  categories: { label: 'Category' },
  devpub: { label: 'Developer/Publisher' },
};

// A Steam tag's `weights` entry (relative to the game's top tag) shows as a gauge along its pill's bottom edge.
function TagCloud(props: {
  groups: { kind: TagKind; dim: string; items?: string[] | null; weights?: Record<string, number | null> | null }[];
}): JSX.Element {
  const present = createMemo(() => props.groups.filter((gr) => gr.items?.length));
  const pills = createMemo(() =>
    present().flatMap(({ kind, dim, items, weights }) => {
      const values = kind === 'tags' ? [...items!] : [...items!].sort((a, b) => a.localeCompare(b));
      return values.map((v) => ({ kind, dim, v, w: weights?.[v] ?? null }));
    }),
  );
  const seenKinds = createMemo(() => [...new Set(present().map((gr) => gr.kind))]);
  return (
    <Show when={present().length}>
      <section class="panel-section">
        <h3 class="panel-section-title">Tags &amp; details</h3>
        <div class="panel-tags">
          <For each={pills()}>
            {({ kind, dim, v, w }) => {
              const dot = <span class={`panel-tag-dot panel-tag-dot--${kind}`} />;
              // "Action" can be both a tag and a genre: two chips a screen reader must tell apart.
              const kindName = `${v}, ${TAG_KIND_META[kind].label.toLowerCase()}`;
              const title = w == null ? undefined : `${Math.round(w * 100)}% of the top tag's votes`;
              const gauge =
                w == null ? null : <span class={`tag-weight tag-weight--${kind}`} style={{ width: `${w * 100}%` }} />;
              return (
                <Show
                  when={panelOptions.tagsFilterable()}
                  fallback={
                    <span class="panel-tag" title={title}>
                      {dot}
                      <span aria-hidden="true">{v}</span>
                      <span class="visually-hidden">{kindName}</span>
                      {gauge}
                    </span>
                  }
                >
                  <button
                    class="panel-tag panel-tag-btn"
                    classList={{ active: panelOptions.isTagActive(dim, v) }}
                    aria-pressed={panelOptions.isTagActive(dim, v)}
                    aria-label={kindName}
                    title={title}
                    onClick={() => panelOptions.onTagClick(dim, v)}
                  >
                    {dot}
                    {v}
                    {gauge}
                  </button>
                </Show>
              );
            }}
          </For>
        </div>
        <div class="panel-tag-legend">
          <For each={seenKinds()}>
            {(k) => (
              <span class="panel-tag-legend-item">
                <span class={`panel-tag-dot panel-tag-dot--${k}`} />
                {TAG_KIND_META[k].label}
              </span>
            )}
          </For>
        </div>
      </section>
    </Show>
  );
}

// The glance strip: four tiles (Weighted Rating, Metacritic, HLTB, Linux/Deck) —
// every chip built from one template (a label, a value, a detail line) so the four
// read as one family. Each chip IS the link to its source; there's no separate
// "Links" section duplicating them. Only *evaluative* values (the two scores, the
// Linux/Deck tier) get semantic color — HLTB is a plain duration, not a judgment,
// so it stays neutral ink.
// `faded`: for a value that's a real tier/score but a low-confidence one (currently only
// ProtonDB's provisional-tier case below) — dims the whole chip so it doesn't read as equally
// certain as a normal chip of the same color/value.
function GlanceChip(props: {
  href?: string | null;
  value: string | number | JSX.Element;
  color?: string | null;
  label: string;
  detail?: JSX.Element;
  faded?: boolean;
}): JSX.Element {
  const inner = () => (
    <>
      <span class="panel-glance-label">{props.label}</span>
      <span
        class="panel-glance-num"
        classList={{ 'panel-glance-num--figure': /^[\d—]/.test(String(props.value)) }}
        style={props.color ? { color: props.color } : undefined}
      >
        {props.value}
      </span>
      <Show when={props.detail}>
        <span class="panel-glance-val">{props.detail}</span>
      </Show>
    </>
  );
  const style = () => (props.faded ? { opacity: 0.65 } : undefined);
  return (
    <Show
      when={props.href}
      fallback={
        <div class="panel-glance-chip panel-glance-chip--static" style={style()}>
          {inner()}
        </div>
      }
    >
      {(href) => (
        <a class="panel-glance-chip" href={href()} target="_blank" rel="noopener" style={style()}>
          {inner()}
        </a>
      )}
    </Show>
  );
}

function GlanceGrid(props: { game: ReadonlyGame }): JSX.Element {
  const details = () => props.game.details;
  const reviewsUrl = () => `https://store.steampowered.com/app/${props.game.appid}/#app_reviews_hash`;
  const protondbUrl = () => `https://www.protondb.com/app/${props.game.appid}`;
  // Its stream part hasn't arrived yet: "…", not "no data".
  const pendingChip = (source: string, label: string) =>
    props.game.pendingSources?.includes(source) ? <GlanceChip value="…" label={label} detail="still loading" /> : null;
  // The source errored (server.js's `failed`): said apart from "no data", ↻ above retries it.
  const failedChip = (source: string, label: string, href: string) =>
    pendingChip(source, label) ??
    (props.game.failedSources?.includes(source) ? (
      <GlanceChip href={href} value={<TriangleAlert />} color="var(--warn)" label={label} detail="didn't answer" />
    ) : null);

  // Every chip stays in the grid even when its source has no data for this game — a missing
  // weighted rating or ProtonDB tier is itself informative, and a chip that vanishes instead makes
  // the 2×2 grid reflow into a lopsided 3-chip layout. Each still links out where a useful
  // destination exists, same as the HLTB search fallback. The rating link points at the game's
  // Steam reviews (the actual source of the underlying data) rather than SteamDB, since the
  // number/caption is this app's own weighted rating, not SteamDB's.
  const ratingChip = () => {
    const r = details()?.rating;
    if (!r)
      return (
        failedChip('rating', 'Weighted', reviewsUrl()) ?? (
          <GlanceChip href={reviewsUrl()} value="—" label="Weighted" detail="no rating" />
        )
      );
    const pct = r.total ? Math.round((r.positive / r.total) * 100) : 0;
    const steamdbRating = Math.round(computeSteamdbRating(r.positive, r.total) ?? 0);
    return (
      <GlanceChip
        href={reviewsUrl()}
        value={steamdbRating}
        color={scoreColor(steamdbRating)}
        label="Weighted"
        detail={
          <>
            {pct}% of {fmtCompactCount(r.total)}
          </>
        }
      />
    );
  };

  const mcChip = () => {
    const mc = details()?.meta?.metacritic;
    return mc ? (
      <GlanceChip
        href={safeHref(mc.url)}
        value={mc.score}
        color={scoreColor(mc.score)}
        label="Metacritic"
        detail="critic score"
      />
    ) : (
      (pendingChip('meta', 'Metacritic') ?? <GlanceChip value="—" label="Metacritic" detail="no score" />)
    );
  };

  const hltbChip = () => {
    const h = details()?.hltb;
    // A matched HLTB entry can still have no submitted completion times (all: null, e.g. a very
    // new/obscure game) — that's a real page with no data, not a failed search, so it still links
    // straight to the page rather than a generic search.
    if (!h?.id)
      return (
        failedChip('hltb', 'HLTB', `https://howlongtobeat.com/?q=${encodeURIComponent(props.game.name)}`) ?? (
          <GlanceChip
            href={`https://howlongtobeat.com/?q=${encodeURIComponent(props.game.name)}`}
            value="—"
            label="HLTB"
            detail="search"
          />
        )
      );
    const hltbUrl = `https://howlongtobeat.com/game/${h.id}`;
    return h.all ? (
      <GlanceChip href={hltbUrl} value={`${h.all}h`} label="HLTB" detail="all playstyles" />
    ) : (
      <GlanceChip href={hltbUrl} value="—" label="HLTB" detail="no data" />
    );
  };

  const protonChip = () => {
    const pd = details()?.protondb;
    if (!pd?.tier)
      return (
        failedChip('protondb', 'Linux/Deck', protondbUrl()) ?? (
          <GlanceChip href={protondbUrl()} value="—" label="Linux/Deck" detail="no reports" />
        )
      );
    // The tier's badge colour, lightened to read as text on the panel's dark ground.
    const color = `color-mix(in srgb, ${PROTON_TIER_COLORS[pd.tier] || PROTON_TIER_UNKNOWN} 60%, var(--text))`;
    // Kept short (no "reports"/"confidence" words): a tile is narrow, and "strong · 336" reads fine without them.
    const detail = [pd.confidence, pd.total ? fmtCompactCount(pd.total) : ''].filter(Boolean).join(' · ');
    // pd.pending: too few reports for ProtonDB itself to be confident, showing its provisionalTier
    // instead of nothing (see extractProtonDb, lib/steam.js) — faded, with a "?" and a
    // "provisional" caption suffix, so it doesn't read as an equally-confirmed tier.
    const value = pd.pending ? `${capitalize(pd.tier)} ?` : capitalize(pd.tier);
    return (
      <GlanceChip
        href={protondbUrl()}
        value={value}
        color={color}
        faded={pd.pending}
        label="Linux/Deck"
        detail={[detail, pd.pending && 'provisional'].filter(Boolean).join(' · ')}
      />
    );
  };

  return (
    <Show
      when={props.game.loading}
      fallback={
        <Show when={details()}>
          <div class="panel-glance">
            {ratingChip()}
            {mcChip()}
            {hltbChip()}
            {protonChip()}
          </div>
        </Show>
      }
    >
      <div class="panel-glance">
        <For each={[0, 1, 2, 3]}>
          {() => (
            <div class="panel-glance-chip panel-glance-chip--sk">
              <span class="sk" style={{ width: '100%', height: '32px', 'border-radius': '6px' }} />
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

// Shared "one card, expand-in-place" shape used by HLTB breakdown, news, and achievements:
// a full-width chip (glance-grid numeral + caption, same template as GlanceChip) as the
// header/toggle, an optional icon-link out to the source, and a divided list below once
// expanded. Kept as one component so the three sections read as one visual family instead
// of three near-identical hand-rolled blocks that drift apart over time.
// `numHtml` is optional — HLTB's breakdown has no single number that isn't either
// misleading (an arbitrary pick among Main/Extra/Completionist) or a plain repeat of the
// glance strip's own "All PlayStyles" figure, so it renders as a plain text-only teaser
// instead of forcing a numeral into a slot where one doesn't actually fit. `icon` fills
// that same leading slot instead, for a card with no num at all (HLTB, News) — without
// it, those two rows read as plain text next to achievements' bold colored percentage,
// losing the "one visual family" look this whole shape is meant to have.
function CollapsibleCard(props: {
  appid: number;
  section: string;
  num?: JSX.Element;
  numColor?: string | null;
  icon?: JSX.Element;
  val: JSX.Element;
  body: JSX.Element;
  linkHref?: string | null;
  linkTitle: string;
}): JSX.Element {
  const expanded = () => isSectionExpanded(props.appid, props.section);
  // A click (only: a section opened by itself or reopened on ↑/↓ just shows) slides the body open
  // or shut; it stays mounted, inert, until a collapse ends, and a click mid-way turns it around.
  const [closing, setClosing] = createSignal(false);
  let body: HTMLDivElement | undefined;
  let slides = 0;
  const onToggle = () => {
    const opening = !expanded();
    const live = body?.isConnected ? body : undefined;
    const from = live?.getBoundingClientRect().height ?? 0;
    for (const a of live?.getAnimations() ?? []) a.cancel();
    setClosing(!opening && !prefersReducedMotion());
    toggleSection(props.appid, props.section);
    const el = body?.isConnected ? body : undefined;
    if (!el) return;
    el.inert = !opening;
    const slide = ++slides;
    const to = opening ? el.getBoundingClientRect().height : 0;
    const frames = [
      { height: `${from}px`, overflow: 'clip' },
      { height: `${to}px`, overflow: 'clip' },
    ];
    void animate(el, frames, { duration: durationToken('--dur-3'), easing: easeOut() }).then(() => {
      if (slide !== slides) return;
      if (!opening) setClosing(false);
      updateSubnavScrollSpy();
    });
  };
  const numSpan = () =>
    props.num != null ? (
      <span class="panel-glance-num" style={props.numColor ? { color: props.numColor } : undefined}>
        {props.num}
      </span>
    ) : props.icon ? (
      <span class="panel-achievements-icon">{props.icon}</span>
    ) : null;
  return (
    <div class="panel-achievements-card">
      <div class="panel-achievements-card-header">
        <h3 class="panel-collapsible-heading">
          <button
            type="button"
            class="panel-achievements-chip panel-collapsible-chip"
            aria-expanded={expanded() ? 'true' : 'false'}
            onClick={onToggle}
          >
            {numSpan()}
            <span class="panel-glance-val">{props.val}</span>
            <ChevronRight class="panel-achievements-chevron" />
          </button>
        </h3>
        <Show when={props.linkHref}>
          {(href) => (
            <a
              class="panel-icon-link"
              href={href()}
              target="_blank"
              rel="noopener"
              title={props.linkTitle}
              aria-label={props.linkTitle}
            >
              ↗
            </a>
          )}
        </Show>
      </div>
      <Show when={expanded() || closing()}>
        <div class="panel-collapsible-body" ref={body}>
          <div class="panel-achievements-list">{props.body}</div>
        </div>
      </Show>
    </div>
  );
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

// Achievements section, off the `achievements` resource (see "Per-game async data" above):
// fetched separately from the rating/HLTB/tags stream, since the achievement *list* only depends
// on the appid but progress depends on which account is loaded. The list itself is still fetched
// and shown with zero accounts loaded (`playerCount: 0`, no `steamUrl`) — only the
// achieved/unlocktime/progress-summary parts need an account, gated by `hasProgress` below.
// Shown once fetched, failure included; PanelSubnav lists the section on the same condition.
const achievementsShown = () => panelData.achievements() !== undefined;

function AchievementsSection(props: { game: ReadonlyGame }): JSX.Element {
  // `undefined` means the fetch hasn't been attempted yet — nothing to show and no failure to
  // report either, so stay silent. `null` means it was attempted and failed — that's worth a
  // visible message rather than silently looking identical to a game with no achievements at all.
  const data = () => panelData.achievements();
  // With no player loaded (`playerCount === 0` — a standalone "look up any game" lookup),
  // `unlocked` is always 0 by construction, not a real "nobody's unlocked anything" result — the
  // list itself (names/descriptions/icons/rarity) is still real store metadata worth showing,
  // just without any progress claim on top of it. `hasProgress` gates every place that would
  // otherwise imply real unlock data.
  const hasProgress = () => (data()?.playerCount ?? 0) > 0;
  const pct = () => {
    const d = data();
    return d && hasProgress() ? Math.round((d.unlocked / d.total) * 100) : null;
  };

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
                  onClick={() => {
                    if (spoiler()) revealAchievement(props.game.appid, a.apiname);
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
    <Show
      when={panelData.achievements.loading}
      fallback={
        <Show when={achievementsShown()}>
          <section class="panel-section" id="panel-section-achievements">
            <Show
              when={data()}
              fallback={
                <>
                  <h3 class="panel-section-title">Achievements</h3>
                  <div class="panel-no-data">
                    {achievementsRefusal(props.game.appid, currentMembers()) ?? "Steam didn't answer."}
                  </div>
                </>
              }
            >
              {(d) => (
                <Show
                  when={d().total}
                  fallback={
                    <>
                      <h3 class="panel-section-title">Achievements</h3>
                      <div class="panel-no-data">This game has no achievements.</div>
                    </>
                  }
                >
                  <CollapsibleCard
                    appid={props.game.appid}
                    section="achievements"
                    num={hasProgress() ? `${pct()}%` : '—'}
                    numColor={hasProgress() ? scoreColor(pct()!) : null}
                    val={
                      <>
                        <b>Achievements</b> ·{' '}
                        {hasProgress() ? `${d().unlocked} / ${d().total} unlocked` : `${d().total} total`}
                      </>
                    }
                    body={body}
                    linkHref={d().steamUrl}
                    linkTitle="View achievements on Steam"
                  />
                </Show>
              )}
            </Show>
          </section>
        </Show>
      }
    >
      <section class="panel-section" id="panel-section-achievements">
        <h3 class="panel-section-title">Achievements</h3>
        <div class="panel-achievements">
          <span class="sk" style={{ width: '100%', height: '48px', 'border-radius': '6px' }} />
        </div>
      </section>
    </Show>
  );
}

// The "Owned by" card — one row per member of the current account who owns this game: name,
// when they last played it, and their own playtime with a meter relative to the most-played
// member. Renders nothing at all when nobody in the account owns it, when no account is loaded,
// or before the `owners` resource has resolved. Takes no `game` prop — that resource is already
// keyed on whichever game is open, so there'd be nothing for one to do.
//
// Deliberately shown even for a single-account slot, where it's one row: "owned, never played"
// is itself worth seeing, and it's the only place last-played shows up in the panel.
function OwnersSection(): JSX.Element {
  const owners = (): GameOwner[] => panelData.owners() ?? [];
  const sorted = createMemo(() => sortOwners(owners()));
  const maxMinutes = createMemo(() => Math.max(...sorted().map((o) => o.minutes), 1));
  return (
    <Show when={sorted().length > 0}>
      <section class="panel-section" id="panel-section-owners">
        <div class="panel-section-title">
          <h3>Owned by</h3> <span class="panel-section-subtitle">most recently played first</span>
        </div>
        <ul class="panel-owners" role="list">
          <For each={sorted()}>
            {(o) => {
              const lastPlayed = fmtLastPlayed(o.lastPlayedSec);
              const playtime = fmtPlaytime(o.minutes);
              // Steam's `rtime_last_played` is genuinely 0 for plenty of owned-and-played games
              // (confirmed live on a game with 477h on it), so a bare "never played" — what the
              // pre-redesign card said, and a bug carried over in the original port — would flatly
              // contradict the playtime printed right underneath it. Only claim "never played"
              // when there's no playtime either.
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
                    <div
                      class="panel-owner-meter-fill"
                      style={{ width: `${ownerMeterPct(o.minutes, maxMinutes())}%` }}
                    />
                  </div>
                  <span class="panel-owner-playtime">{playtime ? `${playtime} played` : 'not played'}</span>
                </li>
              );
            }}
          </For>
        </ul>
      </section>
    </Show>
  );
}

// Recent news/announcements (patch notes, event posts) — a handful of headlines, each
// linking straight to the full post, plus a link to the game's full news hub on the Steam
// store for anything older than what's shown here. Dates use the same plain-ISO convention
// as fmtLastPlayed/the table's date columns rather than a relative "3 days ago" string.
const newsShown = () => {
  const news = panelData.news();
  return news === null || !!news?.length;
};

function NewsSection(props: { game: ReadonlyGame }): JSX.Element {
  const items = () => panelData.news();
  return (
    <Show
      when={panelData.news.loading}
      fallback={
        // A failed fetch with nothing to fall back on (`null` — see panelData.ts's fetchNews, which
        // keeps a previous successful load rather than wiping it) is worth a visible message rather
        // than silently looking identical to a game with no news at all.
        <Show when={newsShown()}>
          <section class="panel-section" id="panel-section-news">
            <Show
              when={items()}
              fallback={
                <>
                  <h3 class="panel-section-title">News</h3>
                  <div class="panel-no-data">Couldn't load news.</div>
                </>
              }
            >
              {(list) => (
                <CollapsibleCard
                  appid={props.game.appid}
                  section="news"
                  icon={<Newspaper />}
                  // Spelling out "more on Steam" here (not just relying on the ↗ icon's title
                  // tooltip) makes it explicit that this list is a preview, not the full history.
                  val={
                    <>
                      <b>News</b> · more on Steam
                    </>
                  }
                  body={
                    <ul class="panel-news" role="list">
                      <For each={list()}>
                        {(n) => (
                          <li>
                            <a
                              class="panel-news-item"
                              href={safeHref(n.url) || undefined}
                              target="_blank"
                              rel="noopener"
                            >
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
                  }
                  linkHref={`https://store.steampowered.com/news/app/${props.game.appid}`}
                  linkTitle="View all news on Steam"
                />
              )}
            </Show>
          </section>
        </Show>
      }
    >
      <section class="panel-section" id="panel-section-news">
        <h3 class="panel-section-title">News</h3>
        <span class="sk" style={{ display: 'block', width: '100%', height: '48px', 'border-radius': '6px' }} />
      </section>
    </Show>
  );
}

// Price info — a single always-open card (no chip grid, no collapsible secondary numbers):
// the current best deal (same display/color/badge/tooltip as the Best Deal table cell in
// bundles.tsx/library.ts), its discount off Steam Full Price when there is one, a direct link
// to the shop itself, and a link to the game's ITAD page for the fuller picture (historical
// lows, every other shop) this card deliberately leaves out. See the original panel.ts's own
// (much longer) header comment — preserved in git history — for the full "where do these
// numbers come from" reasoning; unchanged by this conversion.
function PriceSection(props: { game: ReadonlyGame }): JSX.Element {
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
  const tooltip = () => {
    const shop = deal()?.bestDealShop;
    return shop ?? '';
  };

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
    <Show
      when={panelData.price.loading}
      fallback={
        <Show when={p() !== undefined}>
          <section class="panel-section" id="panel-section-price">
            <div class="panel-section-title">
              <h3>Price</h3>{' '}
              <a href={`https://isthereanydeal.com/steam/app/${props.game.appid}`} target="_blank" rel="noopener">
                IsThereAnyDeal ↗
              </a>
            </div>
            <Show
              when={deal()}
              fallback={
                <div class="panel-no-data">
                  {isItadOff()
                    ? PRICES_UNAVAILABLE
                    : p() === null || p()?.pricesFailed
                      ? (priceRefusal(props.game.appid, currentRegion()) ?? "IsThereAnyDeal didn't answer.")
                      : 'No pricing data available.'}
                </div>
              }
            >
              <Show
                when={shopUrl()}
                fallback={
                  <div class="panel-price-line" title={tooltip() || undefined}>
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
                    title={tooltip() || undefined}
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
            <PanelBundleLines game={props.game} />
          </section>
        </Show>
      }
    >
      <section class="panel-section" id="panel-section-price">
        <h3 class="panel-section-title">Price</h3>
        <span class="sk" style={{ display: 'block', width: '100%', height: '32px', 'border-radius': '6px' }} />
      </section>
    </Show>
  );
}

// The current bundles the open game is in, under the Price card's own lines.
// Nothing while loading or without ITAD (the price lines say that); otherwise none and failed are said apart.
function PanelBundleLines(props: { game: ReadonlyGame }): JSX.Element {
  return (
    <Show
      when={
        !panelData.bundles.loading &&
        panelData.bundles() !== undefined &&
        !(panelData.bundles() === null && isItadOff())
      }
    >
      <div class="panel-bundles">
        <Show when={panelData.bundles() === null}>
          <div class="panel-no-data">
            Bundles: {bundlesRefusal(props.game.appid, currentRegion()) ?? "IsThereAnyDeal didn't answer."}
          </div>
        </Show>
        <Show when={panelData.bundles()?.length === 0}>
          <div class="panel-no-data">Not in any current bundle.</div>
        </Show>
        <Show when={panelData.bundles()?.length}>
          <ul class="panel-bundle-list" role="list">
            <For each={panelData.bundles()}>
              {(b) => {
                const urgency = bundleUrgency(b.expiry);
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
                        <span
                          style={
                            urgency?.tier === 'urgent'
                              ? { color: scoreColor(20) }
                              : urgency?.tier === 'soon'
                                ? { color: scoreColor(55) }
                                : {}
                          }
                        >
                          ends <time datetime={b.expiry!}>{fmtDateTime(b.expiry)}</time>
                          {urgency?.label ? ` (${urgency.label})` : ''}
                        </span>
                      </Show>
                    </div>
                  </li>
                );
              }}
            </For>
          </ul>
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

function DlcSection(props: { game: ReadonlyGame }): JSX.Element {
  const dlcIds = () => props.game.details?.meta?.dlc ?? [];
  // Whichever entries have already resolved, for the streamed-in-as-they-land state below —
  // tagged with the appid they belong to, so a partial list is never shown under another game.
  const loaded = () => {
    const partial = panelData.dlcPartial();
    return (partial?.appid === props.game.appid ? partial.entries : []).filter((d): d is DlcEntry => d != null);
  };
  const skeleton = (
    <div class="panel-collapsible-body-pad">
      <span class="sk" style={{ display: 'block', width: '100%', height: '48px', 'border-radius': '6px' }} />
    </div>
  );

  // One list for streaming and done, sorted throughout: entries already shown keep their element
  // (and capsule) when the rest arrive, instead of a second list replacing the first.
  const entries = createMemo(() => sortDlcByRelease(panelData.dlc.loading ? loaded() : (panelData.dlc() ?? [])));
  const empty = () => {
    if (panelData.dlc.loading || panelData.dlc() === undefined) return skeleton;
    return (
      <div class="panel-collapsible-body-pad">
        <div class="panel-no-data">
          {panelData.dlc() === null ? "Couldn't load DLC details." : 'No DLC details available.'}
        </div>
      </div>
    );
  };
  const notShown = () => dlcIds().length - panelData.dlcShown();
  const body = (
    <Show when={entries().length} fallback={empty()}>
      <div class="panel-dlc-list">
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
      </div>
    </Show>
  );

  return (
    <Show when={dlcIds().length}>
      <section class="panel-section" id="panel-section-dlc">
        <CollapsibleCard
          appid={props.game.appid}
          section="dlc"
          icon={<Package />}
          val={
            <>
              <b>DLC</b> · {dlcIds().length} available
            </>
          }
          body={body}
          linkHref={`https://store.steampowered.com/dlc/${props.game.appid}/`}
          linkTitle="View all DLC on Steam"
        />
      </section>
    </Show>
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
      style={loading() && standIn() !== src() ? { 'background-image': `url("${standIn()}")` } : undefined}
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
// focus and the scroll-spy's `active` class. See docs/dev/frontend.md's Reactivity section.

// The HLTB Main/Extra/Completionist breakdown. The glance strip above already carries HLTB's
// "All PlayStyles" number (see GlanceGrid), so this is the fuller breakdown beneath it, not a
// second copy of the headline figure.
const hltbShown = (g: ReadonlyGame) => {
  const h = g.details?.hltb;
  return !g.loading && !!h && !!(h.main || h.extra || h.completionist);
};

function HltbSection(props: { game: ReadonlyGame }): JSX.Element {
  const h = () => props.game.details?.hltb;
  const present = () => hltbShown(props.game);
  const parts = () => {
    const x = h();
    return [x?.main && 'Main Story', x?.extra && 'Main + Extra', x?.completionist && 'Completionist'].filter(Boolean);
  };

  // Collapsed by default like achievements/news, EXCEPT when `all` itself is missing — then this
  // breakdown is the only duration data the panel has at all, so hiding it behind a click would
  // bury the one piece of HLTB info actually available for this game. An effect, not a write
  // during render: a signal write inside a tracked scope is exactly the "changing state while
  // deriving from it" mistake the store conversion is meant to make impossible.
  createEffect(() => {
    const x = h();
    if (!present() || x?.all != null) return;
    const key = `${props.game.appid}:hltb`;
    if (expandedSections().has(key)) return;
    setExpandedSections((prev) => new Set(prev).add(key));
  });

  return (
    <Show when={present()}>
      <section class="panel-section" id="panel-section-hltb">
        <CollapsibleCard
          appid={props.game.appid}
          section="hltb"
          icon={<Timer />}
          val={
            <>
              <b>How Long To Beat</b> · {parts().join(', ')}
            </>
          }
          body={
            <div class="panel-collapsible-body-pad">
              <dl class="panel-hltb">
                <Show when={h()?.main}>
                  {(v) => (
                    <div class="panel-hltb-item">
                      <dt class="panel-hltb-label">Main Story</dt>
                      <dd class="panel-hltb-val">{fmtH(v())}</dd>
                    </div>
                  )}
                </Show>
                <Show when={h()?.extra}>
                  {(v) => (
                    <div class="panel-hltb-item">
                      <dt class="panel-hltb-label">Main + Extra</dt>
                      <dd class="panel-hltb-val">{fmtH(v())}</dd>
                    </div>
                  )}
                </Show>
                <Show when={h()?.completionist}>
                  {(v) => (
                    <div class="panel-hltb-item">
                      <dt class="panel-hltb-label">Completionist</dt>
                      <dd class="panel-hltb-val">{fmtH(v())}</dd>
                    </div>
                  )}
                </Show>
              </dl>
            </div>
          }
          linkHref={h()?.id ? `https://howlongtobeat.com/game/${h()!.id}` : null}
          linkTitle="View on HowLongToBeat"
        />
      </section>
    </Show>
  );
}

// Same list of names in the same order — a developer list that's identical to the publisher list
// is folded into one "Developer/Publisher" group rather than shown twice. Takes both arrays as
// parameters rather than closing over them, so the element comparison reads its own arguments
// rather than a captured reactive read (which `solid/reactivity` rightly can't tell apart from a
// stale snapshot).
function sameNames(a: string[], b: string[]): boolean {
  return a.length > 0 && a.length === b.length && a.every((v, i) => v === b[i]);
}

// Tags/genres/categories/developer-publisher, as one cloud (see TagCloud above).
function TagCloudSection(props: { game: ReadonlyGame }): JSX.Element {
  const meta = () => props.game.details?.meta;
  const groups = createMemo(() => {
    const devs = metaOrBasics(props.game.details)?.developers || [];
    const pubs = metaOrBasics(props.game.details)?.publishers || [];
    const sameDevPub = sameNames(devs, pubs);
    return [
      { kind: 'tags' as const, dim: 'tags', items: props.game.details?.tags, weights: props.game.details?.tagWeights },
      { kind: 'genres' as const, dim: 'genres', items: meta()?.genres },
      { kind: 'categories' as const, dim: 'categories', items: meta()?.categories },
      { kind: 'devpub' as const, dim: 'developers', items: devs },
      ...(sameDevPub ? [] : [{ kind: 'devpub' as const, dim: 'publishers', items: pubs }]),
    ];
  });
  return (
    <Show when={!props.game.loading}>
      <TagCloud groups={groups()} />
    </Show>
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

// The account's owned games closest by tags, from Owned's device cache; Steam's page covers the whole store.
function SimilarSection(props: { game: ReadonlyGame }): JSX.Element {
  const account = () => getEffectiveCurrentAccount();
  // On Owned, a row's closest owned games are the list's own Sort list by similarity.
  const shown = () => account() && !(panelOptions.isOwnedList() && !props.game.standalone);
  const hasTags = () => !!props.game.details?.tags?.length;
  // Per game opened, so a library Owned cached meanwhile shows up.
  const library = createMemo(() => {
    const taste = shown() ? loadTaste(account()!.id) : null;
    return { taste, similar: taste && similarInLibrary(taste, props.game, SIMILAR_SHOWN) };
  });
  return (
    // A tagless game still gets its More from line.
    <Show when={!props.game.loading && (hasTags() || gameCreators(metaOrBasics(props.game.details)).length)}>
      <section class="panel-section" id="panel-section-similar">
        <div class="panel-section-title">
          <h3>{shown() ? `Similar in ${accountDisplayLabel(account()!)}'s library` : 'Similar games'}</h3>{' '}
          <a href={steamMoreLikeUrl(props.game.appid)} target="_blank" rel="noopener">
            More like this on Steam ↗
          </a>
        </div>
        <MoreFrom game={props.game} />
        <Show when={shown() && hasTags()}>
          <Show
            when={library().similar?.length}
            fallback={
              <div class="panel-similar-empty">
                {library().taste?.games.length ? (
                  'No close match in this library.'
                ) : (
                  <>
                    Open <A href={withAccountParam('/lists/owned')}>{accountDisplayLabel(account()!)}'s Owned list</A>{' '}
                    once on this device to compare.
                  </>
                )}
              </div>
            }
          >
            <ul class="panel-similar-list" role="list">
              <For each={library().similar}>
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
      </section>
    </Show>
  );
}

// Store and ITAD are the two links everyone wants at a glance and stay directly in the header
// row — Workshop/Website are each conditional, tucked into a single "⋯ More" menu instead (see
// the original file's own comment, preserved in git history, for the full reasoning).
function MoreLinks(props: { game: ReadonlyGame }): JSX.Element {
  const items = () =>
    [
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

  return (
    <Show when={items().length}>
      <div
        class="panel-icon-more"
        // Else a menu left open behind focus would outlive the Esc meant for it (that closes the game).
        onFocusOut={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setMoreLinksOpen(false);
        }}
      >
        <button
          type="button"
          class="panel-icon-link panel-icon-more-btn"
          aria-haspopup="true"
          aria-expanded={moreLinksOpen() ? 'true' : 'false'}
          title="More links"
          aria-label="More links"
          onClick={() => setMoreLinksOpen(!moreLinksOpen())}
        >
          <Ellipsis />
        </button>
        <Show when={moreLinksOpen()}>
          <ul class="panel-icon-more-menu">
            <For each={items()}>
              {(it) => (
                <li>
                  <a class="panel-icon-more-item" href={safeHref(it.href) || undefined} target="_blank" rel="noopener">
                    <it.icon /> {it.label} ↗
                  </a>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </Show>
  );
}

// Presents the hero's media (presentation.ts), opening the presentation window first if needed.
// Pressed, in the accent, while the hero's media is what's on the second screen.
function PresentButton(): JSX.Element {
  const heroOnTv = createMemo(() => {
    const items = getPanelItems();
    return onTv(items[clampedHeroIdx(items.length)]?.shotId);
  });
  return (
    <button
      type="button"
      class="panel-icon-link panel-present-btn"
      classList={{ 'panel-present-btn--on': heroOnTv() }}
      title={heroOnTv() ? 'On TV' : 'Present on second screen (P)'}
      aria-label={heroOnTv() ? 'On TV' : 'Present on second screen'}
      aria-keyshortcuts="P"
      onClick={presentHero}
    >
      <Cast />
    </button>
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

// A sticky jump-nav for the sections below the fold — see the original file's own comment
// (preserved in git history) for the full reasoning. Listed in the same order the sections
// actually appear below (Owners right after the tag cloud, ahead of the collapsibles) so
// scroll-spy highlighting (see updateSubnavScrollSpy) always lights up left-to-right.
// One object per tab: `<For>` keeps a tab's button while the same object stays in the list, so a section arriving adds its own.
type SubnavItem = { label: string; target: string };
const SUBNAV = {
  owners: { label: 'Owned by', target: 'panel-section-owners' },
  hltb: { label: 'HLTB', target: 'panel-section-hltb' },
  news: { label: 'News', target: 'panel-section-news' },
  achievements: { label: 'Achievements', target: 'panel-section-achievements' },
  dlc: { label: 'DLC', target: 'panel-section-dlc' },
} satisfies Record<string, SubnavItem>;

function PanelSubnav(props: { game: ReadonlyGame }): JSX.Element {
  // Each condition counts a section only once it has *confirmed* content (or a confirmed
  // failure, which renders its own "couldn't load" card) — deliberately NOT while its fetch is
  // still in flight, even though the loading skeleton is on screen by then. A still-pending
  // section isn't a jump target yet, and counting one makes this list non-monotonic: News would
  // be true while `news.loading`, then false again for a game whose news resolves empty. Through
  // the `< 2` gate below, that took the whole bar — Overview button included — down with it, so
  // the bar flashed in and out as the panel's own fetches settled (measured live: visible at
  // 4104ms, gone at 4126ms, for a game with no news/HLTB/DLC). Every term here now only ever
  // goes absent → present as a game loads, so the bar appears at most once per open and never
  // disappears.
  //
  // Each shares its section component's show predicate, a plain boolean rather than a rendered
  // `<Component/>` call's own truthiness (always truthy regardless of what it renders to).
  const items = createMemo(() => {
    const g = props.game;
    return [
      !!panelData.owners()?.length && SUBNAV.owners,
      hltbShown(g) && SUBNAV.hltb,
      newsShown() && SUBNAV.news,
      achievementsShown() && SUBNAV.achievements,
      !!g.details?.meta?.dlc?.length && SUBNAV.dlc,
    ].filter((it): it is SubnavItem => !!it);
  });

  // Re-run the scroll-spy whenever the set of buttons changes, since a newly rendered button
  // starts out without the `active` class the spy assigns imperatively (it has to measure where
  // each section actually sits). Queued as a microtask so it runs after Solid has patched the
  // DOM. Nothing else needs this anymore: the buttons themselves are no longer thrown away and
  // rebuilt every time some unrelated field of the game changes.
  createEffect(() => {
    items();
    lightboxOpen();
    queueMicrotask(updateSubnavScrollSpy);
  });

  return (
    <Show when={items().length >= 2}>
      <nav class="panel-subnav" aria-label="Sections">
        <ul class="panel-subnav-list">
          <li>
            <button type="button" class="panel-subnav-btn" data-target="top" onClick={() => jumpToPanelSection('top')}>
              Overview
            </button>
          </li>
          <For each={items()}>
            {(it) => (
              <li>
                <button
                  type="button"
                  class="panel-subnav-btn"
                  data-target={it.target}
                  onClick={() => jumpToPanelSection(it.target)}
                >
                  {it.label}
                </button>
              </li>
            )}
          </For>
        </ul>
      </nav>
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

  // `description` (Steam's `short_description`) can carry literal HTML entities as plain text
  // (e.g. "Baldur's Gate..." legitimately has "&amp;" for "Dungeons & Dragons"), and JSX text
  // interpolation doesn't decode entities on its own — decoding it inertly via a DOMParser
  // document that's never attached to the page (runs no scripts, loads no resources) and then
  // rendering the decoded *text* (never raw markup/innerHTML) is what the original file did too;
  // preserved verbatim here since JSX interpolation is already exactly as safe as that
  // plain-text insert was.
  const description = () => metaOrBasics(g.details)?.description;
  const decodedDescription = () => {
    const d = description();
    return d ? new DOMParser().parseFromString(d, 'text/html').body.textContent || '' : '';
  };

  // "← Back" only appears once a DLC hop is actually in progress — a plain table-row click never
  // gets this button, only a game reached by following a DLC link (or by going back through more
  // than one of them) does.
  // Shown by the copy-link button's flash: created here, where an owner can dispose of it.
  const copiedIcon = (<Check />) as Node;

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
            <Show when={releaseDate() || hasBaseGame() || statusShown()}>
              <div class="panel-release">
                <Show when={releaseDate()}>{(r) => <DayText text={fmtReleaseDate(r())} />}</Show>
                <Show when={releaseDate() && hasBaseGame()}>
                  <span class="panel-meta-sep"> · </span>
                </Show>
                <Show when={hasBaseGame()}>
                  <BaseGameLink game={g} />
                </Show>
                <Show when={statusShown()}>
                  <StatusSelect appid={g.appid} />
                </Show>
              </div>
            </Show>
          </div>
          <div class="panel-icon-links">
            <a
              class="panel-icon-link"
              href={`https://store.steampowered.com/app/${g.appid}`}
              target="_blank"
              rel="noopener"
              title="Steam Store"
              aria-label="Steam Store"
            >
              <ShoppingCart />
            </a>
            <a
              class="panel-icon-link"
              href={`https://isthereanydeal.com/steam/app/${g.appid}`}
              target="_blank"
              rel="noopener"
              title="IsThereAnyDeal"
              aria-label="IsThereAnyDeal"
            >
              <CircleDollarSign />
            </a>
            <MoreLinks game={g} />
            <PresentButton />
            <span class="panel-icon-divider" role="separator" aria-hidden="true" />
            <button
              type="button"
              class="panel-icon-link panel-copy-link-btn"
              title="Copy link to this game"
              aria-label="Copy link to this game"
              onClick={(e) => copyPanelLink(e, copiedIcon)}
            >
              <Link />
            </button>
            <RefreshButton game={g} />
            <OwnershipRow game={g} />
          </div>
        </div>
        <PanelSubnav game={g} />
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
      <GlanceGrid game={g} />
      <Show when={!g.loading}>
        <PriceSection game={g} />
      </Show>
      <Show when={noStorePage(g)}>
        <p class="panel-no-data">No Steam store page: delisted or unavailable, so no description, genres or media.</p>
      </Show>
      <Show when={description()}>
        <p class="panel-desc" id="panel-desc">
          {decodedDescription()}
        </p>
      </Show>
      <TagCloudSection game={g} />
      <SimilarSection game={g} />
      <OwnersSection />
      <HltbSection game={g} />
      <NewsSection game={g} />
      <AchievementsSection game={g} />
      <Show when={!g.loading}>
        <DlcSection game={g} />
      </Show>
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
