// @refresh reload
// (solid-refresh: the shell mounts app-wide singletons once — panel, lightbox, keyboard shortcuts —
// and hot-swapping it in dev would mount them a second time, so a change reloads the page instead.)
// The persistent app shell — nav bar, ⚙ Preferences popover, global "look up any game" search,
// the shared side panel + lightbox (mounted once, not per-route) — passed as @solidjs/router's
// `root` (see AppRoot.tsx) so it wraps every route instead of remounting on each navigation.
// This is the app's one nav bar/shell now that the legacy pages (app.tsx/library.tsx/
// bundles.tsx) and the two modules that existed purely to bootstrap them per-page
// (pageShell.ts's `initPageShell`, and nav.tsx's own `initNav`/cross-page `<nav>`) are all
// deleted (see docs/dev/frontend.md). The ⚙ Preferences popover's own
// open/close/position mechanics used to live here as a deliberate, temporary duplicate of
// nav.tsx's identically-named pair for exactly that transition period; they're now navPopover.ts's
// `bindNavPopover`, shared with the account chip's own popover (AccountChip.tsx).
import { onMount, onCleanup, createEffect, createRoot, createSignal, on, For, Show, type JSX } from 'solid-js';
import { A, useNavigate, useLocation, type RouteSectionProps } from '@solidjs/router';
import { PrefsPanel } from './prefsPopover.tsx';
import { initLightbox, openLightbox, repointLightboxGame } from './lightbox.tsx';
import { buildMediaItems, preferredShotIndex } from './mediaItems.ts';
import { presented, setPrivateMode } from './presentation.ts';
import { initPanel, isPanelOpen, getPanelGame } from './panel.tsx';
import { bindPanelKeyboardShortcuts } from './panelKeyboard.ts';
import { initGameSearch } from './gameSearch.ts';
import { addRecentGame, loadRecentGames } from './recentGames.ts';
import type { GameOwner } from './accountData.ts';
import { setPanelParam, setLightboxParam, withAccountParam, COMPARE_PATH } from './urlState.ts';
import { overlayClosesPage } from './overlayHistory.ts';
import { syncAccountOverrideFromUrl } from './accountOverride.ts';
import type { Game } from './types.ts';
import { isIgdbKey, type GameKey } from './gameKey.ts';
import { ShortcutsModal } from './ShortcutsModal.tsx';
import { AccountChip } from './AccountChip.tsx';
import { PresentationChip } from './PresentationChip.tsx';
import { initAuth } from './authStore.ts';
import { bindNavPopover } from './navPopover.ts';
import { SearchClearButton } from './SearchClearButton.tsx';
import { StorageFullBanner } from './StorageFullBanner.tsx';
import { prefsWriteFailed } from './prefs.ts';
import { detailsPending, mediaPending, smoothScroll } from './utils.ts';
import ArrowUp from 'lucide-solid/icons/arrow-up';
import Settings from 'lucide-solid/icons/settings';
import X from 'lucide-solid/icons/x';

// Route-specific behavior (keyboard shortcuts, and now "open this looked-up game") can't be
// hardcoded at the shell level — different routes have different "list" contexts, or none at all
// (Home, About, the Bundles browse screen). Each mounted route registers its own handlers here;
// the shell delegates through this indirection, defaulting to a no-op/fallback when nothing is
// registered rather than each route needing to rebind the whole document-level keydown listener
// itself, or the shell needing to know which routes are "list-shaped" at all.
//
// `openGame(appid)`: ListRoute and SearchRoute (beside its results) register this (every ListRoute kind can place a looked-up
// game somewhere sensible — its own row if it has one, otherwise a standalone panel docked to
// that same route — see ListRoute's own comment on `handleOpenGameRequest`), so it always returns
// true there. Home/BundlesBrowseRoute/AboutRoute/RankRoute never register it — there's no list/table for a
// game to be "in the context of" on those routes — so `openGameGlobally` below falls through to
// navigating to `/game/:appid` (the Recently Looked Up list) instead.
//
// `onGameClose()`: only ListRoute's `recent` kind registers this — closing the panel there
// should strip `:appid` back to the bare `/game` address (that kind's own address IS the
// focused game, not a `?game=` query param — see ListRoute's own comment on `handleOpenGameRequest`),
// which the shell's own generic `setPanelParam(null)` call below doesn't know how to do (it only
// ever touches the query string). Driven straight off `initPanel`'s `onClose` — the one place
// every close path (× button, Escape, swipe-to-close) already funnels through — rather than a
// route-local reactive effect watching `isPanelOpen()`: a first attempt at exactly that
// (`ListRoute.tsx`'s own `createEffect`) never actually observed the panel-closed transition live
// (confirmed via console logging — the effect re-ran for unrelated reasons but never once with
// `isPanelOpen() === false`, root cause not tracked down), so this goes through the same
// already-proven-reliable synchronous callback `setPanelParam(null)` itself relies on instead.
interface RouteHandlers {
  pickRandom?: () => boolean; // true if it actually picked — same idiom as stepGame below
  stepGame?: (dir: 1 | -1) => boolean;
  gamePosition?: () => { index: number; total: number } | null;
  openGame?: (appid: GameKey) => boolean;
  onGameClose?: () => void;
  refreshGame?: (game: Game) => Promise<void>;
  onTagClick?: (dim: string, value: string) => void;
  isTagActive?: (dim: string, value: string) => boolean;
  getOwners?: (appid: number) => GameOwner[] | null; // null: the current account's own (panel.tsx)
  isOwnedList?: boolean; // the panel's similar owned games would only repeat it
  similarTo?: () => number | null; // the game the list is sorted by similarity to
  setSimilarTo?: (appid: number | null) => void;
}
let routeHandlers: RouteHandlers = {};
// A signal, unlike routeHandlers: the panel's tag pills render as buttons only while it holds.
const [tagsFilterable, setTagsFilterable] = createSignal(false);
// Likewise: the panel's Sort list by similarity shows only on a route with a list.
const [hasList, setHasList] = createSignal(false);
const [isOwnedList, setIsOwnedList] = createSignal(false);
export function registerRouteHandlers(handlers: RouteHandlers): () => void {
  routeHandlers = handlers;
  setTagsFilterable(handlers.onTagClick != null);
  setHasList(handlers.setSimilarTo != null);
  setIsOwnedList(!!handlers.isOwnedList);
  return () => {
    // A route mounting before the previous one's cleanup has already registered its own.
    if (routeHandlers !== handlers) return;
    routeHandlers = {};
    setTagsFilterable(false);
    setHasList(false);
    setIsOwnedList(false);
  };
}

// About is deliberately not here: it's a static page nobody visits twice, and the bar was out of
// room for a destination people do use repeatedly. It moved to the footer, which is where an
// About link conventionally lives anyway. `noAccountParam` is the Compare link's alone — a
// comparison names its own players in the URL, and carrying an unrelated account override
// alongside them would be two different claims about whose games are on screen.
const NAV_LINKS: { href: string; label: string; end?: boolean; noAccountParam?: boolean }[] = [
  { href: '/', label: 'Home', end: true },
  { href: COMPARE_PATH, label: 'Compare', noAccountParam: true },
  { href: '/bundles', label: 'Bundles' },
];

// Roughly a screenful: far enough down that the nav bar is long gone, so the ↑ button appears
// only once it has something to offer.
const TO_TOP_AFTER_PX = 600;

export function AppShell(props: RouteSectionProps): JSX.Element {
  let searchInputEl!: HTMLInputElement;
  let scrollEl!: HTMLDivElement;
  let prefsBtnEl!: HTMLButtonElement;
  let prefsPanelEl!: HTMLDivElement;
  // The `?` shortcuts dialog — see ShortcutsModal.tsx. State lives here because
  // bindPanelKeyboardShortcuts' `shortcuts` option needs it.
  const [shortcutsOpen, setShortcutsOpen] = createSignal(false);
  // Whether the page is scrolled far enough down to be worth offering the ↑ button — the nav bar
  // scrolls away with everything else, so this is the only way back up short of a long drag.
  const [scrolled, setScrolled] = createSignal(false);
  const navigate = useNavigate();
  const location = useLocation();

  // `.app-scroll` is the page's scroller, except below 769px, where the shell isn't
  // viewport-locked and the document scrolls instead (see style.css's `.app-shell`) — so reading
  // or setting "the page's scroll position" has to cover both. Whichever isn't the live scroller
  // is already at 0 and ignores the write.
  const pageScrollTop = () => scrollEl.scrollTop || window.scrollY;
  function scrollPageToTop(behavior?: ScrollBehavior): void {
    scrollEl.scrollTo({ top: 0, behavior });
    window.scrollTo({ top: 0, behavior });
  }

  // `?u=` (the account-override param — see accountOverride.ts/accountsStore.ts) is resolved
  // here, once for the whole app, rather than per route: the shell outlives every navigation, so
  // a shared link is honored identically on all of them (Home's account header, the Owned/
  // Wishlist lists, the panel's ownership badges) and stays resolved while clicking between
  // them. This effect runs on every URL change — syncFromUrl itself is keyed on the identifiers,
  // so an unrelated param write (a panel `?game=`, a lightbox `&shot=`) costs nothing.
  createEffect(() => syncAccountOverrideFromUrl(location.search));

  // Scroll to the top on navigation. The router does this itself (`window.scrollTo(0, 0)` on
  // every non-hash navigation), which no longer reaches the desktop layout's own scroller — so
  // without this a route change would land wherever the previous one was scrolled to.
  // Keyed on the path alone: the panel's `?game=`/`&shot=` params are raw `history.replaceState`
  // writes (urlState.ts), which never scrolled the window either.
  createEffect(
    on(
      () => location.pathname,
      () => scrollPageToTop(),
    ),
  );

  // The one place a game-lookup, from anywhere in the shell, gets routed to wherever it belongs
  // — the currently mounted route's own registered handler if it has one (ListRoute: opens the
  // game in place, never navigating away from whatever list/page is on screen), or `/game/:appid`
  // (the Recently Looked Up list) as the fallback for a route with no game/list context of its
  // own at all (Home, Bundles browse, About, Rank, 404) — see registerRouteHandlers's own comment above.
  function openGameGlobally(appid: GameKey): void {
    if (routeHandlers.openGame?.(appid)) return;
    // withAccountParam: a `?u=` link being explored has to survive this navigation, or looking
    // up a game from Home would silently drop back to the stored account (see urlState.ts).
    navigate(withAccountParam(`/game/${appid}`, location.search), { state: { lookup: true } }); // closes back here: overlayHistory.ts's `ownPage`
  }

  // Opens what's on the TV in the lightbox, steering it without sending it again: the panel on its game
  // first (game steps go through its list), then the item once loaded (5 s at most), else a game step's landing.
  function rejoinTv(): Promise<boolean> {
    const on = presented();
    if (!on) return Promise.resolve(false);
    if (getPanelGame()?.appid !== on.appid) openGameGlobally(on.appid);
    return new Promise((resolve) =>
      createRoot((dispose) => {
        let settled = false; // its effect may run again before the disposal takes
        const done = (game: Game | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          dispose();
          // Its media never came (5 s): nothing to open on but the Cover, which the TV doesn't show.
          if (!game || (detailsPending(game) && on.item.shotId !== 'banner')) return resolve(false);
          setPrivateMode(false);
          const items = buildMediaItems(game.appid, game.details?.meta);
          const i = items.findIndex((s) => s.shotId === on.item.shotId);
          openLightbox(game, i >= 0 ? i : preferredShotIndex(items, on.item.type));
          resolve(true);
        };
        const ours = () => {
          const game = getPanelGame();
          return game?.appid === on.appid ? game : null;
        };
        const timeout = setTimeout(() => done(ours()), 5000);
        createEffect(() => {
          const game = ours();
          // Details in, media too unless failed: a failed store page waits for nothing (↻ retries it).
          if (game && ((game.details && !mediaPending(game)) || on.item.shotId === 'banner')) done(game);
        });
      }),
    );
  }

  onMount(() => {
    // Fire-and-forget: checks whether a session cookie is already signed in (e.g. having just
    // landed back from /auth/steam/callback) and reconciles prefs on this browser's first sign-in
    // for that account — see authStore.ts. Never blocks initial render.
    void initAuth();

    // Capture, because scroll events don't bubble and the scroller differs by viewport width —
    // the same idiom navPopover.ts uses to follow either one.
    const onScroll = () => setScrolled(pageScrollTop() > TO_TOP_AFTER_PX);
    window.addEventListener('scroll', onScroll, true);
    onCleanup(() => window.removeEventListener('scroll', onScroll, true));

    const disposeLightbox = initLightbox({
      // `&shot=<id>` deep links: the lightbox reports every open/step/close, and this writes it
      // next to the panel's own `?game=`. Wiring this back is what makes a copied link reopen the
      // exact screenshot again — `setLightboxParam` had no caller at all since the redesign, so
      // the param was parsed and ordered but never written.
      onParamChange: (shot) => setLightboxParam(shot),
      // ↑/↓ and R inside the lightbox step to another game in whatever list is on screen, using
      // the same handlers the panel's own ↑/↓/R use. Re-pointing the lightbox at that game is
      // these callbacks' job — stepping the panel behind the overlay otherwise leaves the
      // *previous* game's shots on screen and the keys read as dead. Both go through
      // `repointLightboxGame`, which lands on real media rather than the banner (mediaItems.ts's
      // `preferredShotIndex`); the shot to pick depends on the one being left, so the lightbox
      // decides it rather than this callback.
      onGameNav: (dir) => {
        if (!routeHandlers.stepGame?.(dir === 1 ? 1 : -1)) return;
        const game = getPanelGame();
        if (game) repointLightboxGame(game);
      },
      onGameRandom: () => {
        if (!routeHandlers.pickRandom?.()) return;
        const game = getPanelGame();
        if (game) repointLightboxGame(game);
      },
      // Which row of the list the open game is, for the lightbox's caption — the counter it
      // shows otherwise is media-within-this-game, which says nothing about where you are in
      // the list you're paging through.
      getGamePosition: () => routeHandlers.gamePosition?.() ?? null,
      onRejoin: rejoinTv,
    });
    onCleanup(disposeLightbox);
    initPanel({
      onClose: ({ leavingRoute = false } = {}) => {
        if (leavingRoute || overlayClosesPage('panel')) return;
        routeHandlers.onGameClose?.();
        setPanelParam(null);
      },
      onNavigateGame: openGameGlobally,
      // The panel's own "↻ Refresh" button (force-refreshes this game's details, news, price and
      // DLC). Delegated to the mounted route rather than implemented here: the refreshed details
      // have to land on that route's own store-backed row, not just on the panel's plain copy.
      onRefresh: (game) => routeHandlers.refreshGame?.(game),
      onTagClick: (dim, value) => routeHandlers.onTagClick?.(dim, value),
      tagsFilterable,
      getOwners: (appid) => routeHandlers.getOwners?.(appid) ?? null,
      hasList,
      isOwnedList,
      similarTo: () => (hasList() ? (routeHandlers.similarTo?.() ?? null) : null),
      setSimilarTo: (appid) => routeHandlers.setSimilarTo?.(appid),
      isTagActive: (dim, value) => routeHandlers.isTagActive?.(dim, value) ?? false,
    });
    initGameSearch({
      inputEl: searchInputEl,
      resultsEl: document.getElementById('app-search-results') as HTMLElement,
      onSelect: (game) => {
        // A game outside Steam never reaches stored prefs (gameKey.ts).
        if (!isIgdbKey(game.appid)) addRecentGame(game.appid, game.name, game.tinyImage);
        openGameGlobally(game.appid);
      },
      // Focusing the empty box shows what was looked up recently, and "see all" opens that same
      // list as a real route (/game — the Recently Looked Up system list, whose own store this
      // dropdown is reading). Read on each open rather than captured once: a lookup made a moment
      // ago has to be at the top of the list the next time the box is focused.
      recents: loadRecentGames,
      onSeeAllRecents: () => navigate(withAccountParam('/game', location.search)),
      // Analogous "see all" for actual search matches (not recents) — the full-page results list
      // with a shareable, editable URL, rather than the dropdown's capped/transient one.
      onSeeAllResults: (term) => navigate(withAccountParam(`/search?q=${encodeURIComponent(term)}`, location.search)),
    });

    bindPanelKeyboardShortcuts({
      pickRandom: () => routeHandlers.pickRandom?.(),
      stepGame: (dir) => routeHandlers.stepGame?.(dir) ?? false,
      focusSearchInput: () => searchInputEl.focus(),
      shortcuts: {
        isOpen: shortcutsOpen,
        toggle: () => setShortcutsOpen((v) => !v),
        close: () => setShortcutsOpen(false),
      },
    });

    onCleanup(bindNavPopover(prefsBtnEl, prefsPanelEl));
  });

  return (
    <div class="app-shell" classList={{ 'panel-open': isPanelOpen() }}>
      <div class="app-scroll" ref={scrollEl}>
        {/* First Tab stop, shown only when focused: past the nav and toolbar straight to the rows. */}
        <a
          class="skip-link"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            const target =
              document.querySelector<HTMLElement>('main .dt-tr[tabindex]') ?? document.querySelector('main');
            target?.focus();
          }}
        >
          Skip to table
        </a>
        <header id="site-nav" class="site-nav">
          {/* A plain link: the router's <A> would mark it current on Home, beside the Home link. */}
          <a href={withAccountParam('/', location.search)} class="site-brand">
            <svg class="site-brand-mark" viewBox="0 0 32 32" aria-hidden="true">
              <rect width="32" height="32" rx="7" />
              <path d="M6 7h5v17H6zM12.5 11h4v13h-4zM18.6 12.6l3.8-1.4 4.4 12.2-3.8 1.4zM4 24h24v3H4z" />
            </svg>
            Playshelf
          </a>
          <nav class="site-nav-links" aria-label="Main">
            <For each={NAV_LINKS}>
              {(link) => (
                <A
                  href={link.noAccountParam ? link.href : withAccountParam(link.href, location.search)}
                  end={link.end}
                  class="site-nav-link"
                  activeClass="active"
                >
                  {link.label}
                </A>
              )}
            </For>
          </nav>
          <search class="app-search-wrap">
            <input
              ref={searchInputEl}
              id="app-search-input"
              type="text"
              placeholder="Look up any game…"
              aria-label="Look up any game"
              autocomplete="off"
              enterkeyhint="search"
              onFocus={(e) => e.currentTarget.select()}
            />
            <SearchClearButton />
            <div id="app-search-results" class="game-search-results" hidden />
          </search>
          <PresentationChip onOpen={() => void rejoinTv()} />
          <AccountChip />
          <div class="site-nav-prefs site-nav-popover">
            <button
              type="button"
              class="site-nav-link site-nav-prefs-btn"
              aria-label="Preferences"
              popovertarget="nav-prefs-panel"
              ref={prefsBtnEl}
            >
              <Settings />
            </button>
            <PrefsPanel ref={prefsPanelEl} />
          </div>
        </header>

        <main class="app-content" tabindex="-1">
          {props.children}
        </main>

        <footer class="app-footer">
          <span>
            Press <kbd>?</kbd> for keyboard shortcuts
          </span>
          <A href="/about" class="app-footer-link">
            About
          </A>
        </footer>
      </div>

      {/* Docked, not modal — <aside> (complementary) rather than "dialog"/aria-modal, since the
          rest of the page stays fully interactive while this is open (see panel.tsx's own
          comment and docs/dev/frontend.md). Fixed and full-height, so it sits outside the
          scrolling column entirely (see style.css's .app-shell). */}
      <aside id="game-panel" class="game-panel" aria-labelledby="panel-title">
        <button id="panel-close" class="panel-close" aria-label="Close">
          <X />
        </button>
        <div id="panel-nav" class="panel-nav" />
        <div id="panel-body" class="panel-body" />
      </aside>

      <Show when={scrolled()}>
        <button
          class="app-to-top"
          title="Back to top"
          aria-label="Back to top"
          onClick={() => scrollPageToTop(smoothScroll())}
        >
          <ArrowUp />
        </button>
      </Show>
      <Show when={prefsWriteFailed()}>
        <StorageFullBanner />
      </Show>
      <ShortcutsModal open={shortcutsOpen()} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}
