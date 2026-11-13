# Frontend

A Solid.js single-page app in `public/`, TypeScript throughout, bundled by Vite. One HTML entry for the app (`index.html` → `AppRoot.tsx`, plus `present.html` for the presentation window), `@solidjs/router` for navigation, and a persistent shell that survives every route change.

The data model it renders — accounts, lists, combines, the localStorage schema — is [lists-and-accounts.md](lists-and-accounts.md). This file is the machinery: routes, modules, reactivity, URL state. The table and each list kind are [game-table.md](game-table.md); the side panel and lightbox [panel-and-lightbox.md](panel-and-lightbox.md); the presentation window [presentation.md](presentation.md).

## Routes

| Path                      | What it is                                                              |
| ------------------------- | ----------------------------------------------------------------------- |
| `/`                       | Home — account picker/header, the folder/list tree, combine setup       |
| `/lists/owned`            | Owned games for the effective current account                           |
| `/lists/wishlist`         | That account's wishlist                                                 |
| `/lists/compare`          | A comparison of several accounts' libraries, named by `?u=`             |
| `/lists/shared`           | Someone else's dynamic list formula, named by `?f=`                     |
| `/lists/bundle/:bundleId` | One bundle's games                                                      |
| `/lists/developer?name=`  | A developer's games on Steam (`/lists/publisher?name=`: a publisher's)  |
| `/lists/game-pass`        | The Steam games in the region's PC Game Pass catalog                    |
| `/lists/:listId`          | A user list (manual, dynamic or ranked)                                 |
| `/lists/:listId/rank`     | A ranked list's one-vs-one compare screen                               |
| `/bundles`                | Browse/discover bundles — a table of bundles, not of games              |
| `/game/:appid?`           | "Recently Looked Up", and the canonical link for one game               |
| `/search`                 | Search-by-URL — matches for `?q=`, opening the closest one in the panel |
| `/about`                  | Static about page — linked from the footer, not the nav bar             |
| anything else             | "Page not found", with a link Home (`NotFoundRoute.tsx`)                |

- Path for "which list", query params for state within it (`?u=`, `?game=`/`&shot=`, view-sharing params). Except a developer's or publisher's name, in `?name=`: the production SPA fallback 404s on a path ending like a file (`indie.io`), and a `/` in a name doesn't survive a path segment.
- The fixed `/lists/*` routes are registered before the generic `/lists/:listId` to document intent; `@solidjs/router` ranks by segment specificity, so the order isn't load-bearing.
- `@solidjs/router` ignores letter case and a trailing slash (`/Lists/Owned/` matches `/lists/owned`), so `ListRoute` reads its kind from the matched `<Route>`'s `info` (`AppRoot.tsx`), never by comparing `pathname`; `linkPreview` (`server.js`) normalises the path the same way.
- The production catch-all that makes these real paths work on a cold visit is in [architecture.md](architecture.md).

**`/lists/shared?f=<formula>`** shares any saved _dynamic_ list, the way `/lists/compare` shares a comparison: the formula lives in the URL and resolves in memory (`listShare.ts`'s `decodeListFormula`, `ListRoute.tsx`'s `'shared'` kind), so it opens for someone with none of it in their storage. `f`'s grammar (`listShare.ts`):

```
formula ::= op ":(" source (";" source)* ")"
source  ::= "o:" accountId | "w:" accountId | "b:" bundleId | "d:" name | "p:" name | "r" | "x" | "g:" formula
```

- `:;(),` are legal unencoded in a query, so a formula reads as plain text; each leaf (`accountId`, `bundleId`, a developer's or publisher's `name`) is `encodeURIComponent`'d plus `(`/`)`, and `shareListUrl` escapes those `%` once more, since the route reads `f` through `URLSearchParams` (one decode). A `?u=` carried along (`withAccountParam`) re-encodes the whole value, so that link isn't readable.
- A `user` source (another saved list) can't travel as a bare `listId`, so `encodeListFormula` inlines it as a `g:` group, recursing like `listResolve.ts`'s `resolveRef` with the same visited-set cycle guard. Nesting stops at `MAX_DEPTH` (`cycle-or-too-deep`), a backstop mirroring `listResolve.ts`'s; the one-level cap in `listLabels.ts`'s `createDefaultNaming` only limits label length.
- Decoding turns each `g:` group into a synthetic in-memory `GameList` (`decoded.synthetic`, generated id) referenced as an ordinary `{ kind: 'user', listId }`, so `resolveListWithSources`/`listLabels.ts` are unchanged; only `getList`/`ListNaming.list` check that map first (`ListRoute.tsx`'s `sharedFetchers`/`sharedNaming`, mirroring `compareNaming()`).
- A `user` source pointing at a _manual_ or _ranked_ list can't be encoded (no token for an appid set or an order): "Share list" disables itself with a tooltip (`shareFailure()`).
- The landing offers **only** "Save as a list" (`handleSaveShared`): each synthetic group is `createList()`'d first to mint a real id, substituted into its parent's `sources[]`, then the top level is saved. No "Edit players"/op-select — there's no form for editing an arbitrary decoded tree.

`/game/:appid?` is **both** the Recently Looked Up list and the canonical single-game link: `ListRoute` renders it as kind `recent`, with `params.appid` as an initial focus. Opening another game there rewrites the path (`/game/<appid>`, `replace`) instead of setting `?game=`, and closing the panel strips it back to `/game` (`onGameClose`).

**Looking up a game never navigates away from a route with a list context of its own** — the nav-bar search box and a panel's DLC/base-game links open in place (a real row if the appid is loaded, a standalone panel via `?game=` otherwise). `/search` counts as having one (its results). Only Home, `/bundles`, `/about`, the rank screen (`RankRoute`) and the 404 page navigate, to `/game/:appid`. See `AppShell.tsx`'s `openGameGlobally`.

- That navigation carries `{ lookup: true }` in its history state, so the panel takes that entry as its own (`overlayHistory.ts`'s `ownPage`): ×, Esc and Back all return to the page the lookup came from in one step, rather than to Recently Looked Up. A shared `/game/:appid` link has no such state and closes to `/game`.

## Shell

Above [phone width](ui-guidelines.md#touch-and-phone) the shell is locked to the viewport and **`.app-scroll` is the page's scroller**, avoiding two scrollbars side by side. Nav and footer sit inside it, so they still scroll away; `.app-content` takes `flex: 1` to keep the footer down on a short page.

- **`AppShell` owns the page's scroll position** (`pageScrollTop`/`scrollPageToTop` — `.app-scroll` on desktop, the document on mobile, so both are read and written). It scrolls to the top on each path change, and shows the floating **Back to top** button (an up arrow) past `TO_TOP_AFTER_PX`. The button's `position: fixed` ignores the shell's gutter, so `.panel-open` offsets it by `--panel-w`; its z-index is below the panel's.
- **A pref write storage refuses** (`prefs.ts`'s `prefsWriteFailed`) shows `StorageFullBanner` (`role="alert"`), fixed along the bottom left of the Back to top button and over the panel. Dismiss hides it until a write succeeds again, handing focus back to where it was before the banner (else `<main>`); the next failure brings it back. The failed edit isn't kept in memory: it snaps back.
- **At phone width the lock is off** and the document scrolls: the panel is an overlay there, and a document that never scrolls is a URL bar that never collapses.

## Module map

**Shell and routes**

- `AppRoot.tsx` — mounts `<Router>` with `AppShell` as its `root`.
- `AppShell.tsx` — the persistent shell: nav bar (`Home · Compare · Bundles`; About is in the footer), Preferences popover, global game search, the shared panel + lightbox (mounted once, not per route), and the app-wide `?u=` resolve effect. The Compare link alone opts out of `withAccountParam`: a comparison names its own players.
  - Landmarks: the bar is the `<header>` (banner), holding the `Main` `<nav>` (`display: contents`, so its links stay items of the bar's flex row), the `<search>` box, the chip and Preferences; then `<main>`, the footer, and the panel as an `<aside>` named by its title. Every `<nav>` carries a name; Home's Explore cards are a list, not a second nav.
- `AccountTiles.tsx` — Home's Accounts: one tile per known account (a Family's faces overlap), ✕ revealed on hover, focus or Edit (touch has no hover), a filter past 8. Removing one focuses the next tile's Remove, else the previous one's, else the filter, else the lookup field.
- `AccountChip.tsx` — nav-bar chip saying whose lists are on screen, with Owned/Wishlist links (inline when wide, in its popover when narrow) and a recent-account switcher. Deliberately thinner than Home's account section.
- `ListRoute.tsx` — the generic list viewer (table + docked panel) behind every `/lists/*` and `/game/*` route; owns per-kind loading, columns, price loading, and the hero's contents.
- `RankRoute.tsx` — `/lists/:listId/rank`, a ranked list's compare screen (see [lists-and-accounts.md](lists-and-accounts.md#ranked-lists)).
- `listShare.ts` — encode/decode for `/lists/shared?f=` (see Routes).
- `HomeRoute.tsx` — the account card (header, lookup form, a Family's members, its Accounts tiles via `AccountTiles.tsx`, friends), the Explore cards (one stretched link each) and the folder/list tree with its combine form. Each tree row has one ⋯ popover (`bindNavPopover`) of Move, Rename and Delete; focus goes back to the row's ⋯ (`data-menu-id`, since every refresh rebuilds the rows) after Esc, a rename (the popover is hidden before the name field takes focus, as the field commits on blur), a move or a cancelled delete, and to the next row's ⋯ (else the heading) after a delete. Also forwards `/?u=alice&u=bob` to `/lists/compare`.
- `AccountFriends.tsx` — the home account card's friends list, marking friends shared with the starred "My account" (`myAccountId`), not the signed-in one.
- `CombineForm.tsx` — the source/op picker shared by Home (create a dynamic list) and `ListRoute` (Edit sources); it only assembles `{ name, op, sources }` for its `onSubmit`.
- `ComparePlayersForm.tsx` — the "who is being compared" form (`/lists/compare`'s empty state and "Edit players").
  - Each player slot is a **token input**: chips for who's in it, plus a combobox (`role="combobox"`/`listbox"`, arrow keys + Enter, named by its "Player N" label) offering known accounts and accepting a raw identifier; Enter in an empty field (no row arrowed to or hovered) submits once two players are in. Per slot, so a Steam Family built from two known accounts is buildable.
  - Blur commits whatever is half-typed. It owns the draft slots and reads `accountsStore.ts` once at mount; the route decides what a submitted set means.
- `compareSlots.ts` — that form's slot model (`SlotEntry`, `slotsToIdentifiers`/`slotsFromIdentifiers`, `namesAccount`, `filterAccounts`), split out to be testable without a DOM or store. A slot holds _entries_ (a known account kept whole, or a typed identifier), not strings, since an account with no custom-URL name would otherwise show as a 17-digit id. `slotsFromIdentifiers` matches a `?u=` URL back to named chips for "Edit players".
- `BundlesBrowseRoute.tsx` — `/bundles`, the bundle picker as a real table.
- `SearchRoute.tsx` — `/search?q=`, so a URL (e.g. a Firefox keyword bookmark) can jump to a game.
  - Not a `ListRoute` kind (results have no ratings/HLTB/price), but renders through `@vates/data-table-solid`'s `DataTableView` with a two-column config (thumb + name); `showSearch={false}` and `showColumns={false}` leave no toolbar control, so none renders.
  - Opening a result reuses `ListRoute.tsx`'s `openStandaloneInPlace`-style placeholder-then-fetch, and registers `stepGame`/`pickRandom`/`gamePosition` with the shell (via `panelNav.ts`'s `stepGameList`/`renderPanelNav` and `panel.tsx`'s `pickRandomFrom`), so ↑/↓/R, the panel nav and lightbox game-stepping work here too.
  - A debounced on-page search box keeps `?q=` in sync, auto-opening the closest match only on the initial landing. The nav-bar box's "See all results for …" row (`gameSearch.ts`) is the other way in.
- `AboutRoute.tsx`, `NotFoundRoute.tsx`, `ShortcutsModal.tsx`, `ListHero.tsx` — static about page; unknown-path page; the `?` shortcuts dialog (rendered once by the shell); the hero every list route opens with.

**Account and list model** (modules over `prefs.ts`, some owning a signal of their own — see [Reactivity](#reactivity) and [lists-and-accounts.md](lists-and-accounts.md))

- `accountsStore.ts` — `myAccount`/`currentAccount`/`recentAccounts` CRUD, `getEffectiveCurrentAccount()`, all reactive (`getEffectiveCurrentAccount()` follows the `?u=` override signal and the stored accounts).
- `accountOverride.ts` — the `?u=` half: parse, resolve, hand to `accountsStore` as an override that is never adopted into the stored preference.
- `accountData.ts` — owned/wishlist/friends fetches for a resolved account, each shared through one keyed cache: `CLIENT_CACHE_MAX_AGE_MS`, a ↻ replaces an in-flight fetch, a failed ↻ falls back to what it replaced (unless that failed too; restoring newer data moves the version), a failed first fetch isn't kept, and `resolveAccountSlot`'s response seeds the library.
- `listsStore.ts` — folder/list CRUD, soft-delete, and the two structural-cycle guards (a dynamic list can't depend on itself transitively; a folder can't move into its own descendant).
- `listResolve.ts` — resolves a `ListRef`/`GameList` to appids, with every impure dependency injected so its tests never touch the network or localStorage.
- `combine.ts` — the pure union/intersect/subtract/group-by-membership engine over resolved sets.
- `ranking.ts` — the pure binary-insertion engine behind ranked lists.
- `listLabels.ts` — how an op and a source read on screen, shared by the hero, Home's combine form, and the tree.
- `membershipColumn.ts` — the "Owned by"/"In" column a group-by-membership list is grouped by (see [game-table.md](game-table.md#other-kinds)).
- `gameStatuses.ts` — the viewer's own Finished/Abandoned mark per game, one synced map for whoever uses the browser.
- `tagTaste.ts` — tag-weight vectors: an account's `Taste`, Taste Fit, Group Fit, similarity and the profile figures built on them (see [taste.md](taste.md)).
- `bundleSnapshots.ts` — the last-known title and games of each bundle a saved list uses, kept for when ITAD stops listing it.
- `myOwnership.ts` — one cached pair of owned/wishlisted appid sets for the effective account, behind both the panel's badge and the search dropdown's markers.
- `recentGames.ts` — the recently-looked-up list backing `/game`.
- `PlayerProfile.tsx` — the profile cards: Owned's `OwnedProfile`, and the `ProfileBadge` and `TagBars` a comparison reuses (see [taste.md](taste.md)).
- `playerProfile.ts` — how an account plays beyond its tags: play style (`playStyle`), story games played to length (`storyGames`) and the archetype titling them (`archetypeOf`), from rows and an hours accessor so a comparison's players reuse it (see [taste.md](taste.md)).
- `tasteCache.ts` — each account's stored Taste, bounded, and the room a full storage makes by evicting them (`setItemMakingRoom`, which `prefs.ts` writes through).
- `creatorData.ts` — a developer's/publisher's games (`/api/creator-games`), the list's title and path.
- `gamePassData.ts` — the Steam games in PC Game Pass (`/api/game-pass`), the list's title and path, and an Xbox store link for the ones not on Steam.
- `bundleData.ts` / `bundleRows.ts` / `bundleBrowseStore.ts` — bundle fetch/flatten/resolve; the flat row shape `/bundles` sorts over; the last-browsed list `/lists/bundle/:bundleId`'s ‹/› nav steps through.
- `fanaticalPicks.ts` — Buy on Fanatical: the purchase link carrying the picks, and the bookmarklet that adds them there.
- `authStore.ts` / `syncedPrefKeys.ts` — Steam sign-in status and the prefs merge with the server on sign-in (`syncPrefsWithServer`); the pref keys a signed-in account syncs (the server keeps its own copy, checked equal by a test).

**Table, panel, and shared plumbing**

- `dateTime.ts` — an ISO timestamp as the viewer's local date and time: flat, or the stacked date-over-time table cell.
- `gameColumns.ts` — every game-table column definition and its render/format/compare/bucket helpers (see [game-table.md](game-table.md)).
- `rowStore.ts` — `createRowStore`: the appid→index bookkeeping and the `getRow`/`mutateRow` pair over a route's Solid store array.
- `streamBatcher.ts` — batches a high-frequency mutation stream into one `batch()` per flush.
- `detailsEvent.ts` — `applyDetailsEvent`: merges one details-stream part into a row and flattens it into the table's fields.
- `staleGuard.ts` — generation counters for "a newer load superseded this one".
- `loadProgress.ts` — the details stream's progress bar and time left.
- `loadTiming.ts` — a list load's User Timing measures from `list:start`: `list:rows` (the table is built), `list:listed` (every row's fast part received), `list:done` (store parts too); the latest load's only. Read them in DevTools' Performance panel or with `performance.getEntriesByType('measure')`.
- `priceLoading.ts` — the `POST /api/prices` call and the row-field mapping/fallbacks around it.
- `panel.tsx` / `panelData.ts` / `panelNav.ts` / `panelHistory.ts` / `panelKeyboard.ts` / `ownerList.ts` — the side panel and its per-game data, prev/next nav, DLC trail rule, keyboard handler, and the pure half of the "Owned by" card (see [panel-and-lightbox.md](panel-and-lightbox.md#the-side-panel)).
- `lightbox.tsx` / `mediaItems.ts` / `lightboxSwipe.ts` / `hlsPlayer.ts` — screenshot/video lightbox, its ordered media list, its swipe thresholds/decision, and trailer playback (shared with the presentation window) (see [panel-and-lightbox.md](panel-and-lightbox.md), [presentation.md](presentation.md)).
- `presentation.ts` / `presentationProtocol.ts` / `PresentationChip.tsx` / `PresentationView.tsx` / `presentationScreen.ts` — presenting on a second screen: the main window's side and the nav chip, their messages, the presentation window itself, and the screen it's placed on (see [presentation.md](presentation.md)).
- `overlayHistory.ts` — the history entry each open overlay pushes (see [panel-and-lightbox.md](panel-and-lightbox.md#the-side-panel)).
- `viewTransition.ts` / `artTint.ts` — the shared-element morphs into the panel and the lightbox; the panel ground's tint from the game's art.
- `gameSearch.ts` — the combobox/debounce UI for "look up any game" (the shell owns where results go).
- `urlState.ts` — param parsing, canonical param order, and the `?game=`/`&shot=`/`?u=` writers.
- `prefs.ts` / `StorageFullBanner.tsx` / `prefsPopover.tsx` / `region.ts` / `navPopover.ts` — the localStorage preference blob; the banner when storage refuses a write of it; the Preferences panel's contents; the region preference and its detection; nav popovers' Escape and positioning.
- `tableViewPrefs.ts` / `tableViewKeys.ts` / `tableViewSync.ts` / `SharedViewBanner.tsx` / `TableViewControls.tsx` — a table's layout draft, restore/share/reset; the table-view pref keys; what a stored layout leaves out and which parts differ; the shared-layout and unsaved-changes banners and the Share/Reset layout buttons.
- `listViews.ts` / `ViewTabs.tsx` — Owned/Wishlist's saved views and their templates; the tabs, the active view's ⋯ and the hero's New view menu.
- `clipboard.ts` / `CopyButton.tsx` — the one copy-then-confirm helper behind every copy button (`copyWithFeedback` for plain DOM buttons, `<CopyButton>` for JSX), with a `window.prompt` fallback where the Clipboard API isn't available (it needs a secure context, and can be permission-denied).
- `announce.ts` — the app's one polite live region, for a change shown only visually.
- `motion.ts` — JS animations (`animate`), skipped under reduced motion like the CSS ones.
- `Kbd.tsx` / `SearchClearButton.tsx` — a key cap; the × emptying a search field.
- `pageTitle.ts` — the two-layer `document.title` (route context, overridden by an open game).
- `types.ts` — `Game`, `ReadonlyGame`, and the account/list interfaces; the single source of truth for row shape.
- `SteamPrivacyLink.tsx` — the link to Steam's privacy settings, beside a private-profile message.
- `focusHandoff.ts` — hands focus on when the element holding it goes (`keepFocus`), per ui-guidelines.md's Keyboard rule.
- `utils.ts` — shared formatting/scoring helpers (`scoreColor`, `formatMoney`, `computeSteamdbRating`, `dealRecordTier`, `discountPct`, …).
- `currency.ts` — approximate fixed exchange rates, for ordering and summing mixed-currency prices and their "≈" hint.
- `style.css` — the stylesheet entry: declares the cascade layer order and imports `styles/*.css`, each partial wrapped in its own `@layer` (`reset` and `base`: elements, and the tokens in `tokens.css`, which `presentation.css` imports too; `layout`: the shell; `components`: everything else, one section per screen), except `styles/vendor-data-table.css` (the table library's overrides and its `html:root { --color-* }` theme, unlayered and imported last: the library injects an unlayered `<style>`, which beats any layered rule whatever its specificity, so a `.dt-*` override in a layer has no effect).

## Icons

- One import per icon: `import X from 'lucide-solid/icons/x'`. `npm run lint` bans the `lucide-solid` and `lucide-solid/icons` barrels, which would make the dev server transform every icon.
- Import an icon by its canonical name: an alias kept for a renamed icon ships as a source re-export with no `.d.ts`, so it renders but fails the typecheck with `TS2307: Cannot find module 'lucide-solid/icons/<alias>'`. The alias file names the canonical one (`history.jsx` imports `./rotate-ccw-clock`).
- `.lucide` in `styles/base.css` sizes an icon at `1em` in `currentColor` (stroke 1.75): set its size and colour on the element around it.

## Motion

How [ui-guidelines.md](ui-guidelines.md#motion)'s rules are built.

- Helpers: `createCountUp` (a hero tile's count; its drawn steps `aria-hidden`), `slideRowsOnViewChange` (positions read on the pointerdown or keydown that starts a sort, filter or grouping change), `cascadeFirstRows` (first rows staggered), `fadeInOnLoad` (images); banners slide in through `@starting-style`.
- The lightbox's seek line is `.lb-vc-scrub`; the panel sections' height slide is `CollapsibleCard`.
- View Transitions go through `viewTransition.ts`'s `morph`: feature-detected, the two ends named `game-art` only for the transition's length, waiting up to `MORPH_WAIT_MS` for the destination's picture, the root cross-fade off, focus moved after `updateCallbackDone`. The lightbox's own dialog morphs, as the snapshots paint above it: its `showModal()` and `close()` run inside the morph's update (`showModal()` after `canMorph()`'s `dialog[open]` check), so the snapshot at either end has the lightbox. Not for route changes: the router has no hook, and a lazy route would freeze the screen while its chunk loads.
- Web Animations go through `motion.ts`'s `animate`, which resolves even when it skips or is cancelled, so cleanup waiting on it always runs.
- Reduced motion: `styles/base.css` sets every transition to `0s` and every animation to a near-instant single run; that doesn't reach the Web Animations API, hence `animate` skipping under it; JS smooth scrolls go through `smoothScroll()`.

## Reactivity

Everything the frontend renders is driven by Solid's own reactivity — there is no "please re-render" call anywhere, and reintroducing one is the mistake this section exists to prevent.

Four kinds of state, four mechanisms:

- **A game/row's data** lives in a Solid **store** owned by the route that loaded it, written only through `mutateRow` ([Rows](#rows-streaming-and-stale-loads)); the store notifies per field, so a streamed field patches only the cells and panel lines that read it.
- **The side panel's own UI state** (which game is open, hero index, expanded collapsibles, …) is plain signals in `panel.tsx`, set by its own click handlers.
- **Everything the panel fetches for itself** (news, achievements, "Owned by", ownership status, price, bundles, DLC) is a `createResource` keyed on the open game, created in one module-level `createRoot` (the panel is a singleton whose data outlives every render). Fetching and caching (for `CLIENT_CACHE_MAX_AGE_MS`) is `panelData.ts`; the resource is only wiring, giving `.loading`, discard of superseded responses and re-rendering for free. Refresh details refetches news, achievements, price and bundles, whose fetchers read `info.refetching` as `refresh` (bypass both the session cache and the server's TTL); owners and ownership read `myOwnership.ts`'s cache, keyed on `myOwnershipVersion()` so a ↻ of the account elsewhere refetches them.
  - News, achievements, price and bundles wait `PANEL_SETTLE_MS` before an uncached, unforced fetch and drop it if the panel has moved on, so holding ↓ fetches only the game it stops on; a cached value still answers at once, a game come back to within the pause joins its pending load, and ↻ replaces that load rather than racing it.

- **Shared app state** (prefs, the signed-in user, the `?u=` override and its resolve state, the ownership cache) is a signal owned by its module, read through its getter, so a reader in JSX, a memo, an effect or a table cell `render` follows it with no window event, ready callback or tick counter.
  - `getPref` tracks its key: one signal per key, so a table-view write doesn't rerun a region reader. The account getters build on it; `getAuthUser()`, `getAccountOverride()` and `getAccountOverrideState()` read their own signals.
  - `myOwnership.ts`'s peeks track a signal bumped once the owned/wishlist sets land, and `accountData.ts`'s per-account version, which a ↻ anywhere moves: the sets are re-derived, the old ones shown until then. An imperative consumer (the nav search dropdown, `ListRoute`'s row stamps) subscribes with `trackMyOwnership()`, which starts no fetch.
  - Keyed reloads go through a primitive memo (`createMemo(currentRegion)`, an account's `?.id`), since `getPref` returns a fresh object on every read.
  - An effect that writes prefs reads its pref inside `on(...)` or `untrack`, or it reruns on its own write. `adoptPrefEntry` is the one silent write (the merge reloads the page right after).

Every resource **source** resolves to a _primitive_ (an appid, or an `appid:account` string), never an object literal: `createResource` memoizes its source with `===`, so an object would refetch every time the source recomputed — e.g. the DLC source re-runs whenever any collapsible is toggled.

Why it matters: a manual notify over plain row objects rebuilds the whole panel body on every change (~6 times per open, dropping hover, focus and the scroll-spy's class); with stores and resources an open rebuilds the subnav once and patches ~30 nodes.

Three rules keep it that way:

1. **One reactive source of truth per row; the only write path is its store's setter.** Enforced by the type system: readers take `ReadonlyGame` (`types.ts`), so `game.field = x` outside a `produce` draft is a typecheck failure rather than a silent no-op. `Readonly` is deliberately shallow — it stops `g.details = …`, not `g.details.rating = …`, and `details` is only ever replaced wholesale.
2. **Async state belongs in `createResource`, not in booleans on a domain object.** News, achievements, price, DLC and owners therefore aren't on the `Game` shape. (`inLibrary`/`onWishlist` stay — they're the _table's_ copy, stamped onto rows for the ✓/☆ name-cell markers; the panel reads its own `ownership` resource, so a standalone lookup still gets a badge. Both go through `myOwnership.ts`'s one cached pair of sets, so they can't disagree.)
3. **Never capture a reactive read into a plain `const` in a component body** — read signals and store fields inside JSX or a `createMemo`. This is what `npm run lint`'s `solid/reactivity` rule checks, and why the panel is a set of small components (`PanelSubnav`, `HltbSection`, `RefreshButton`, …): a component function runs once and is not a reactive scope. Deliberate exceptions carry an `eslint-disable-next-line` with their reason (`grep -rn 'solid/reactivity' public`), e.g. `PanelRest`'s `const g = props.game` — the row _object_ is stable for the mount (`PanelBody` renders it under a `keyed` `<Show>`), and capturing a store row is not capturing a field of it.
   - A JSX prop passed as `body={body()}` is a getter: every signal `body()` reads rebuilds its whole DOM, detaching elements (an e2e locator's `boundingBox()` returns `null` under load). Pass JSX built once (`body={body}`) with `<Show>`/`<For>` inside, over one memo for every state, as `DlcSection` in `panel.tsx`.

Still deliberately imperative: the subnav scroll-spy (measures section positions, marks the current tab and moves its underline, re-run from a `createEffect` when the buttons change); `panelNav.ts` rendering the prev/next/random bar into `#panel-nav` (its "i / N" from one `createEffect` over the route's `getGameList()`, ↑/↓ through the route's `stepGame` at click time, hidden while the open game isn't in the list); and `lightbox.tsx`'s own DOM.

## Rows, streaming, and stale loads

- **Load progress**: while details stream in, the status line shows a bar and a time left from the last 20 s of progress (`loadProgress.ts`) — cached games arrive in a burst, uncached ones at the upstreams' throttled pace, so an overall average would promise far too little. Past a minute it also says why, for the rest of that load.
  - It counts fast parts first; once every row has one, it counts store parts ("genres, Metacritic, achievements still coming"), whose pace is Steam's store details cap.
  - `loaded` (both parts in) still gates what waits for the whole list — taste fit, group fit, the profile — so those move at the store part's pace.
- **Two stream parts** (`detailsEvent.ts`'s `applyDetailsEvent`): an uncached game's fast part and store part arrive separately, in either order; each event changes only its own fields and sources. `pendingSources` lists what hasn't arrived: a missing value of a pending source renders "…" (`markFailedSources`), the panel's chip says "still loading", and `noStorePage`/`detailsPending` don't read a pending `meta` as final. While `meta` is pending, `metaOrBasics` fills name, art, date, platforms, developers and publishers from the browse item's `basics`; the production tier stays null (it needs the price). Opening such a game loads its appdetails at once (`loadMedia`), ahead of the stream's queue.
- **Rows are a Solid store** (`createStore<Game[]>` in `ListRoute.tsx`, reached through `rowStore.ts`) owned by the route; Solid's dev mode blocks a direct `row.field = x` on a store proxy, so:
  - Every mutation goes through `createRowStore`'s (`rowStore.ts`) `mutateRow(appid, fn)`, which applies `fn` via `produce(fn)`. That's why the mutate-in-place helpers (`applyDetailsEvent`, `priceLoading.ts`'s `applyPriceInfo`/`nullMissingPriceFields`) take a plain draft.
  - `@vates/data-table-solid` renders each `<td>` as a reactive insertion reading `row[column.key]`, so a field write re-renders exactly that cell — no new object reference needed.
  - A game that isn't one of the route's rows (a DLC/base-game link, a standalone lookup) gets `undefined` from `mutateRow`; the caller writes to `standaloneRows` instead, a `createStore<Record<number, Game>>` in the same file.
- **A streaming/high-frequency `mutateRow` caller must batch**, or the table's live `tableData()` re-sorts/re-filters/re-paginates once per _event_ instead of once per _flush_ (measured: a ~1150-game library took ~33 s of unresponsive main thread unbatched, ~6–7 s batched). Two shapes, two fixes:
  - **Spread over time** (the SSE `/api/game-details/stream` loop, `ListRoute.tsx`'s `streamGameDetails`) — `streamBatcher.ts`'s `createStreamBatcher` queues events and applies them in one `batch()` per ~150 ms flush; its `onFlush` runs `updateStatus`. Each queued event carries its load's generation (`loadGuard`, `staleGuard.ts`) and is dropped if stale by flush time, since two overlapping loads share the queue.
  - **One synchronous burst** (a price response processed in one loop — `loadPrices`) — the loop is wrapped in a bare `batch()`.
  - Deliberately **not** built into `mutateRow`: one-off writes (an achievements load, a DLC toggle, a Refresh details click) must apply immediately.
- **Media load on open, not with the stream**: the stream leaves out each game's screenshots and trailers (`lib/streamEvent.mjs`), most of its bytes yet only ever shown for the open game.
  - Opening a list row loads its own from `GET /api/game-meta` (a cache hit after the stream), and its neighbours' in list order so ↑/↓ land on media at once (`ListRoute.tsx`'s `loadMedia`).
  - Until they're in, `detailsPending` holds a link's `&shot=`, the TV rejoin and the lightbox's TV latch. A failed load marks the row (`mediaFailed`): those settle on the Cover, and opening the game again retries.
  - Standalone and search rows come from `/api/game-details`, media included.

## Global search and the account chip

The "look up any game" box is one nav-bar search in the shell, not one per route.

- Focused while **empty**, it shows recently looked-up games under a heading, with a sticky "See all Recently Looked Up" row (with an arrow) to `/game`. They're `GameSearchResult`-shaped, so roving selection, ownership markers and `onSelect` apply unchanged; the heading and "see all" row are `role="presentation"`.
- `gameSearch.ts` takes the list and the "see all" destination as options rather than importing `recentGames.ts`.
- Typing a query gets "See all results for '…'" instead, to `/search?q=…`.

`AccountChip.tsx` says who the app is showing, following a `?u=` link that resolves after mount, with a link icon (named "from a link") when a link's account is showing.

- The popover menus (this chip, Preferences, the rank menu, Home's tree rows, the view tabs' menus) are native popovers (`button[popovertarget]` + `[popover]`: the browser opens, closes and dismisses them on an outside click) sharing `navPopover.ts`: it closes them on Esc ahead of the page's own Esc handlers, and positions the panel in JS because `.site-nav`'s flex-wrap moves its triggers with viewport width (seen off-screen on a real Galaxy S10, ruling out CSS-only anchoring).
- It carries **copyable Steam identifiers** (`accountsStore.ts`'s `accountIdentifiers`: the stored custom-URL name, else the steam64 id), read from the slot since the chip fetches nothing: one for the current account, one per member beside each recents row (outside its switch button, which can't nest one).

## URL & sharing

- `?u=` — **one** slot: which account to show. Parsed and resolved once for the whole app by `AppShell.tsx`, read everywhere via `getEffectiveCurrentAccount()`, forwarded across in-app navigation by `withAccountParam`. Full semantics in [lists-and-accounts.md](lists-and-accounts.md).
- `?u=` repeated — **several** slots: a comparison, one `u=` per player, comma-joined identifiers within a slot for a Family; never an override or forwarded ([lists-and-accounts.md](lists-and-accounts.md#u-url-semantics)). `/lists/compare` is its address; `normalizeSlots`/`compareUrl` (`urlState.ts`) write it, canonicalized to server-resolved steam64 ids. `&op=` picks the combine op, omitted for the default.
- `?game=<appid>` / `&shot=<idx>` — which game the current list has open, and which screenshot; Recently Looked Up writes the game into its path (`/game/<appid>`) instead. Rewritten with `replaceState`; the one entry pushed per open overlay is `overlayHistory.ts`'s. `/game/:appid` is the canonical address for a game, which the panel's 🔗 copies without `?u=`.
- `?tv=` — a shared table-view snapshot, consumed once on arrival (see [game-table.md](game-table.md#layouts-and-saved-views)).
- `?view=<id>` — Owned/Wishlist's saved view; not forwarded by nav links (Owned opens All games), and a deleted one falls back to the whole list with a note.
- `?q=` — `/search`'s term. Read on mount, written back (`setSearchQueryParam`, `urlState.ts`) as the on-page box is edited, debounced like the nav-bar box. Always `replaceState`.
- `reorderUrlParams` (`urlState.ts`) puts every URL through one canonical param order, so the same state always serializes to the same string; `urlWithParams` is the single place a `URLSearchParams` becomes a URL, returning a bare path once the last param is deleted.

## Preferences

`prefs.ts` is one flat `{key: value}` JSON blob under a single localStorage key, so the whole set is enumerable at once; `setPref`'s sync hook is per-key so two preferences changing in different tabs can't race each other's server writes.

Region is the only user-facing preference, in the nav bar's Preferences popover (`prefsPopover.tsx` owns the panel, `AppShell.tsx` only its button). `region.ts` holds a curated list of major Steam pricing regions and `detectCountry()`; price-showing routes re-price from an effect on `currentRegion()`.

- The first entry is always "Auto-detect (⟨what it resolves to now⟩)", and `currentRegion` consults `detectCountry()` live on every upstream call.
- `detectCountry` tries the OS timezone (`Intl.DateTimeFormat().resolvedOptions().timeZone`, via a curated map including Eurozone→`DE`) before `navigator.language` — language is a UI preference and often stays "en-US" anywhere (e.g. `LANG=en_US.UTF-8` in `Europe/Paris`).
- The Eurozone label leads with "Europe", not "Germany" — `DE` is only the code Steam/ITAD key Eurozone pricing off.
- Region is not a URL param: it describes the viewer, so a shared link shouldn't override the recipient's preference.
