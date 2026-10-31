# Frontend

A Solid.js single-page app in `public/`, TypeScript throughout, bundled by Vite. One HTML entry (`index.html` → `AppRoot.tsx`), `@solidjs/router` for navigation, and a persistent shell that survives every route change.

The data model it renders — accounts, lists, combines, the localStorage schema — is [lists-and-accounts.md](lists-and-accounts.md). This file is the machinery: routes, modules, reactivity, the table, the panel, URL state.

- [Routes](#routes)
- [Module map](#module-map)
- [Reactivity](#reactivity)
- [Rows, streaming, and stale loads](#rows-streaming-and-stale-loads)
- [The game table](#the-game-table)
- [Each list kind, in practice](#each-list-kind-in-practice)
- [Global search and the account chip](#global-search-and-the-account-chip)
- [The side panel](#the-side-panel)
- [URL & sharing](#url--sharing)
- [Preferences](#preferences)
- [Known gaps](#known-gaps)

## Routes

| Path                      | What it is                                                               |
| ------------------------- | ------------------------------------------------------------------------ |
| `/`                       | Home — account picker/header, the folder/list tree, combine setup        |
| `/lists/owned`            | Owned games for the effective current account                            |
| `/lists/wishlist`         | That account's wishlist                                                  |
| `/lists/compare`          | A comparison of several accounts' libraries, named by `?u=`              |
| `/lists/shared`           | Someone else's dynamic list formula, named by `?f=`                      |
| `/lists/bundle/:bundleId` | One bundle's games                                                       |
| `/lists/developer?name=`  | A developer's games on Steam (`/lists/publisher?name=`: a publisher's)   |
| `/lists/game-pass`        | The Steam games in the region's PC Game Pass catalog                     |
| `/lists/:listId`          | A user list (manual, dynamic or ranked)                                  |
| `/lists/:listId/rank`     | A ranked list's one-vs-one compare screen                                |
| `/bundles`                | Browse/discover bundles — a table of bundles, not of games               |
| `/game/:appid?`           | "Recently Looked Up", and the canonical link for one game (`igdb:N` too) |
| `/search`                 | Search-by-URL — matches for `?q=`, opening the closest one in the panel  |
| `/about`                  | Static about page — linked from the footer, not the nav bar              |
| anything else             | "Page not found", with a link Home (`NotFoundRoute.tsx`)                 |

- Path for "which list", query params for state within it (`?u=`, `?game=`/`&shot=`, view-sharing params). Except a developer's or publisher's name, in `?name=`: the production SPA fallback 404s on a path ending like a file (`indie.io`), and a `/` in a name doesn't survive a path segment.
- The fixed `/lists/*` routes are registered before the generic `/lists/:listId` to document intent; `@solidjs/router` ranks by segment specificity, so the order isn't load-bearing.
- The production catch-all that makes these real paths work on a cold visit is in [architecture.md](architecture.md).

**`/lists/shared?f=<formula>`** shares any saved _dynamic_ list, the way `/lists/compare` shares a comparison: the formula lives in the URL and resolves in memory (`listShare.ts`'s `decodeListFormula`, `ListRoute.tsx`'s `'shared'` kind), so it opens for someone with none of it in their storage. `f`'s grammar (`listShare.ts`):

```
formula ::= op ":(" source (";" source)* ")"
source  ::= "o:" accountId | "w:" accountId | "b:" bundleId | "d:" name | "p:" name | "r" | "x" | "g:" formula
```

- `:;(),` are legal unencoded in a query, so a formula reads as plain text; each leaf (`accountId`, `bundleId`, a developer's or publisher's `name`) is `encodeURIComponent`'d plus `(`/`)`, and `shareListUrl` escapes those `%` once more, since the route reads `f` through `URLSearchParams` (one decode). A `?u=` carried along (`withAccountParam`) re-encodes the whole value, so that link isn't readable.
- A `user` source (another saved list) can't travel as a bare `listId`, so `encodeListFormula` inlines it as a `g:` group, recursing like `listResolve.ts`'s `resolveRef` with the same visited-set cycle guard. Nesting is uncapped (the one-level cap in `listLabels.ts`'s `createDefaultNaming` only limits label length).
- Decoding turns each `g:` group into a synthetic in-memory `GameList` (`decoded.synthetic`, generated id) referenced as an ordinary `{ kind: 'user', listId }`, so `resolveListWithSources`/`listLabels.ts` are unchanged; only `getList`/`ListNaming.list` check that map first (`ListRoute.tsx`'s `sharedFetchers`/`sharedNaming`, mirroring `compareNaming()`).
- A `user` source pointing at a _manual_ list can't be encoded (no appid-set token): "Share list" disables itself with a tooltip (`shareFailure()`).
- The landing offers **only** "Save as a list" (`handleSaveShared`): each synthetic group is `createList()`'d first to mint a real id, substituted into its parent's `sources[]`, then the top level is saved. No "Edit players"/op-select — there's no form for editing an arbitrary decoded tree.

`/game/:appid?` is **both** the Recently Looked Up list and the canonical single-game link: `ListRoute` renders it as kind `recent`, with `params.appid` as an initial focus. Opening another game there rewrites the path (`/game/<appid>`, `replace`) instead of setting `?game=`, and closing the panel strips it back to `/game` (`onGameClose`).

**Looking up a game never navigates away from a route with a list context of its own** — the nav-bar search box and a panel's DLC/base-game links open in place (a real row if the appid is loaded, a standalone panel via `?game=` otherwise). `/search` counts as having one (its results). Only Home, `/bundles`, `/about`, the rank screen (`RankRoute`) and the 404 page navigate, to `/game/:appid`. See `AppShell.tsx`'s `openGameGlobally`.

- **A game outside Steam** is keyed `igdb:<id>` (`gameKey.ts`'s `GameKey`) wherever a Steam appid can be: `/game/igdb:9001`, `?game=igdb%3A9001`, `RouteHandlers.openGame`. It opens as a standalone panel and is never a table row, nor stored in prefs (Recently Looked Up, statuses, lists, ranking): on `/game` it opens beside the list without joining it. A link is always an absolute path: a relative `igdb:9001` reads as a URL scheme.
- That navigation carries `{ lookup: true }` in its history state, so the panel takes that entry as its own (`overlayHistory.ts`'s `ownPage`): ×, Esc and Back all return to the page the lookup came from in one step, rather than to Recently Looked Up. A shared `/game/:appid` link has no such state and closes to `/game`.

## Module map

**Shell and routes**

- `AppRoot.tsx` — mounts `<Router>` with `AppShell` as its `root`.
- `AppShell.tsx` — the persistent shell: nav bar (`Home · Compare · Bundles`; About is in the footer), Preferences popover, global game search, the shared panel + lightbox (mounted once, not per route), and the app-wide `?u=` resolve effect. The Compare link alone opts out of `withAccountParam`: a comparison names its own players.
  - Landmarks: the bar is the `<header>` (banner), holding the `Main` `<nav>` (`display: contents`, so its links stay items of the bar's flex row), the `<search>` box, the chip and Preferences; then `<main>`, the footer, and the panel as an `<aside>` named by its title. Every `<nav>` carries a name; Home's Explore cards are a list, not a second nav.
- `AccountTiles.tsx` — Home's Accounts: one tile per known account (a Family's faces overlap), ✕ revealed on hover, focus or Edit (touch has no hover), a filter past 8. Removing one focuses the next tile's Remove, else the filter, else the lookup field.
- `AccountChip.tsx` — nav-bar chip saying whose lists are on screen, with Owned/Wishlist links (inline when wide, in its popover when narrow) and a recent-account switcher. Deliberately thinner than Home's account section.
- `ListRoute.tsx` — the generic list viewer (table + docked panel) behind every `/lists/*` and `/game/*` route; owns per-kind loading, columns, price loading, and the hero's contents.
- `RankRoute.tsx` — `/lists/:listId/rank`, a ranked list's compare screen (see [lists-and-accounts.md](lists-and-accounts.md#ranked-lists)).
- `listShare.ts` — encode/decode for `/lists/shared?f=` (see Routes).
- `HomeRoute.tsx` — the account card (header, lookup form, a Family's members, its Accounts tiles via `AccountTiles.tsx`, friends), the Explore cards (one stretched link each) and the folder/list tree with its combine form. Each tree row has one ⋯ popover (`bindNavPopover`) of Move, Rename and Delete; focus goes back to the row's ⋯ (`data-menu-id`, since every refresh rebuilds the rows) after Esc, a rename (the popover is hidden before the name field takes focus, as the field commits on blur), a move or a cancelled delete, and to the next row's ⋯ (else the heading) after a delete. Also forwards an old Comparison-page link (`/?u=alice&u=bob`) to `/lists/compare`.
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

**Account and list model** (plain modules over `prefs.ts`, no Solid reactivity of their own — see [lists-and-accounts.md](lists-and-accounts.md))

- `accountsStore.ts` — `myAccount`/`currentAccount`/`recentAccounts` CRUD, `getEffectiveCurrentAccount()`, all reactive (`getEffectiveCurrentAccount()` follows the `?u=` override signal and the stored accounts).
- `accountOverride.ts` — the `?u=` half: parse, resolve, hand to `accountsStore` as an override that is never adopted into the stored preference.
- `accountData.ts` — owned/wishlist/overview fetches for a resolved account.
- `listsStore.ts` — folder/list CRUD, soft-delete, and the two structural-cycle guards (a dynamic list can't depend on itself transitively; a folder can't move into its own descendant).
- `listResolve.ts` — resolves a `ListRef`/`GameList` to appids, with every impure dependency injected so its tests never touch the network or localStorage.
- `combine.ts` — the pure union/intersect/subtract/group-by-membership engine over resolved sets.
- `ranking.ts` — the pure binary-insertion engine behind ranked lists.
- `listLabels.ts` — how an op and a source read on screen, shared by the hero, Home's combine form, and the tree.
- `membershipColumn.ts` — the "Owned by"/"In" column a group-by-membership list is grouped by (see each list kind below).
- `bundleSnapshots.ts` — the last-known title and games of each bundle a saved list uses, kept for when ITAD stops listing it.
- `myOwnership.ts` — one cached pair of owned/wishlisted appid sets for the effective account, behind both the panel's badge and the search dropdown's markers.
- `recentGames.ts` — the recently-looked-up list backing `/game`.
- `PlayerProfile.tsx` — the profile cards: Owned's `OwnedProfile`, and the `ProfileBadge` and `TagBars` a comparison reuses.
- `playerProfile.ts` — how an account plays beyond its tags: play style (`playStyle`), story games played to length (`storyGames`) and the archetype titling them (`archetypeOf`), from rows and an hours accessor so a comparison's players reuse it.
- `tasteCache.ts` — each account's stored Taste, bounded, and the room a full storage makes by evicting them (`setItemMakingRoom`, which `prefs.ts` writes through).
- `creatorData.ts` — a developer's/publisher's games (`/api/creator-games`), the list's title and path.
- `gamePassData.ts` — the Steam games in PC Game Pass (`/api/game-pass`), the list's title and path, and an Xbox store link for the ones not on Steam.
- `bundleData.ts` / `bundleRows.ts` / `bundleBrowseStore.ts` — bundle fetch/flatten/resolve; the flat row shape `/bundles` sorts over; the last-browsed list `/lists/bundle/:bundleId`'s ‹/› nav steps through.
- `fanaticalPicks.ts` — Buy on Fanatical: the purchase link carrying the picks, and the bookmarklet that adds them there.
- `authStore.ts` / `syncedPrefKeys.ts` — Steam sign-in status and the prefs merge with the server on sign-in (`syncPrefsWithServer`); the pref keys a signed-in account syncs (the server keeps its own copy, checked equal by a test).

**Table, panel, and shared plumbing**

- `gameColumns.ts` — every game-table column definition and its render/format/compare/bucket helpers (see below).
- `rowStore.ts` — `createRowStore`: the appid→index bookkeeping and the `getRow`/`mutateRow` pair over a route's Solid store array.
- `streamBatcher.ts` — batches a high-frequency mutation stream into one `batch()` per flush.
- `staleGuard.ts` — generation counters for "a newer load superseded this one".
- `loadProgress.ts` — the details stream's progress bar and time left.
- `priceLoading.ts` — the `POST /api/prices` call and the row-field mapping/fallbacks around it.
- `panel.tsx` / `panelData.ts` / `panelNav.ts` / `panelHistory.ts` / `panelKeyboard.ts` / `ownerList.ts` — the side panel and its per-game data, prev/next nav, DLC trail rule, keyboard handler, and the pure half of the "Owned by" card.
- `lightbox.tsx` / `mediaItems.ts` / `lightboxSwipe.ts` / `hlsPlayer.ts` — screenshot/video lightbox, its ordered media list, its swipe thresholds/decision, and trailer playback (shared with the presentation window).
- `presentation.ts` / `presentationProtocol.ts` / `PresentationChip.tsx` / `PresentationView.tsx` / `presentationScreen.ts` — presenting on a second screen: the main window's side and the nav chip, their messages, the presentation window itself, and the screen it's placed on (see [The presentation window](#the-presentation-window)).
- `overlayHistory.ts` — the history entry each open overlay pushes (see the side panel).
- `viewTransition.ts` / `artTint.ts` — the shared-element morphs into the panel and the lightbox; the panel ground's tint from the game's art.
- `gameSearch.ts` — the combobox/debounce UI for "look up any game" (the shell owns where results go).
- `urlState.ts` — param parsing, canonical param order, and the `?game=`/`&shot=`/`?u=` writers.
- `gameKey.ts` — `GameKey` (a Steam appid or `igdb:<id>`), `parseGameKey` for a path segment or `?game=`, `isIgdbRow`.
- `IgdbPanel.tsx` — the panel's body for a game outside Steam (see the side panel).
- `prefs.ts` / `StorageFullBanner.tsx` / `prefsPopover.tsx` / `region.ts` / `navPopover.ts` — the localStorage preference blob; the banner when storage refuses a write of it; the Preferences panel's contents; the region preference and its detection; nav popovers' Escape and positioning.
- `tableViewPrefs.ts` / `tableViewKeys.ts` / `tableViewSync.ts` / `SharedViewBanner.tsx` / `UnsavedViewBanner.tsx` — restore/persist/share/reset a table view; the table-view pref keys; the signed-in Save/Revert baseline; the shared-layout and unsaved-changes banners and the Share/Default view buttons.
- `listViews.ts` / `ViewTabs.tsx` — Owned/Wishlist's saved views and their templates; the tabs, the active view's ⋯ and the hero's New view menu.
- `clipboard.ts` / `CopyButton.tsx` — the one copy-then-confirm helper behind every copy button (`copyWithFeedback` for plain DOM buttons, `<CopyButton>` for JSX), with a `window.prompt` fallback where the Clipboard API isn't available (it needs a secure context, and can be permission-denied).
- `pageTitle.ts` — the two-layer `document.title` (route context, overridden by an open game).
- `types.ts` — `Game`, `ReadonlyGame`, and the account/list interfaces; the single source of truth for row shape.
- `utils.ts` — shared formatting/scoring helpers (`scoreColor`, `formatMoney`, `computeSteamdbRating`, `dealRecordTier`, `discountPct`, …).
- `currency.ts` — approximate fixed exchange rates, for ordering and summing mixed-currency prices and their "≈" hint.
- `style.css` — the stylesheet entry: declares the cascade layer order and imports `styles/*.css`, each partial wrapped in its own `@layer` (`reset` and `base`: elements, and the tokens in `tokens.css`, which `presentation.css` imports too; `layout`: the shell; `components`: everything else, one section per screen), except `styles/vendor-data-table.css` (the table library's overrides, unlayered, imported last; see [pitfalls.md](pitfalls.md)).

## Reactivity

Everything the frontend renders is driven by Solid's own reactivity — there is no "please re-render" call anywhere, and reintroducing one is the mistake this section exists to prevent.

Four kinds of state, four mechanisms:

- **A game/row's data** lives in a Solid **store** owned by the route that loaded it (`createStore<Game[]>` in `ListRoute.tsx`, reached through `rowStore.ts`). Writes go through `rowStore.mutateRow(appid, fn)` — `produce(fn)`, so the callback gets an assignable draft — and the store notifies per field, so a streamed field patches only the cells and panel lines that read it. `standaloneRows` (a `createStore<Record<number, Game>>` in the same file) does the same for a game opened as a standalone aside (a nav-bar lookup, a DLC/base-game hop).
- **The side panel's own UI state** (which game is open, hero index, expanded collapsibles, …) is plain signals in `panel.tsx`, set by its own click handlers.
- **A game outside Steam** (`types.ts`'s `IgdbRow`) is no store row: `panel.tsx`'s `igdbRow(key)` is an object of getters over the panel's `igdb` resource (keyed on the open `igdb:` key, fetched by `panelData.ts`'s `fetchIgdbGame`), shaped like a row (`details.meta` with its cover as `banner`, its screenshots, no trailers; `details.hltb`), so the hero, HLTB, the lightbox and the media list take it unchanged. Its getters read only a reply tagged with their own key.
- **Everything the panel fetches for itself** (news, achievements, "Owned by", ownership status, price, bundles, DLC) is a `createResource` keyed on the open game, created in one module-level `createRoot` (the panel is a singleton whose data outlives every render). Fetching and session-caching is `panelData.ts`; the resource is only wiring, giving `.loading`, discard of superseded responses and re-rendering for free. `refetch()` is the panel's Refresh details; each fetcher reads `info.refetching` as "force" (bypass both the session cache and the server's TTL).
  - News, achievements, price and bundles wait `PANEL_SETTLE_MS` before an uncached, unforced fetch and drop it if the panel has moved on, so holding ↓ fetches only the game it stops on; a cached value still answers at once, a game come back to within the pause joins its pending load, and ↻ replaces that load rather than racing it.

- **Shared app state** (prefs, the signed-in user, the `?u=` override and its resolve state, the ownership cache) is a signal owned by its module, read through its getter, so a reader in JSX, a memo, an effect or a table cell `render` follows it with no window event, ready callback or tick counter.
  - `getPref` tracks its key: one signal per key, so a table-view write doesn't rerun a region reader. The account getters build on it; `getAuthUser()`, `getAccountOverride()` and `getAccountOverrideState()` read their own signals.
  - `myOwnership.ts`'s peeks track a signal bumped once the owned/wishlist sets land. An imperative consumer (the nav search dropdown, `ListRoute`'s row stamps) subscribes with `trackMyOwnership()`, which starts no fetch.
  - Keyed reloads go through a primitive memo (`createMemo(currentRegion)`, an account's `?.id`), since `getPref` returns a fresh object on every read.
  - An effect that writes prefs reads its pref inside `on(...)` or `untrack`, or it reruns on its own write. `adoptPrefEntry` is the one silent write (the merge reloads the page right after).

Every resource **source** resolves to a _primitive_ (an appid, or an `appid:account` string), never an object literal: `createResource` memoizes its source with `===`, so an object would refetch every time the source recomputed — e.g. the DLC source re-runs whenever any collapsible is toggled.

Why it matters: a manual notify over plain row objects rebuilds the whole panel body on every change (~6 times per open, dropping hover, focus and the scroll-spy's class); with stores and resources an open rebuilds the subnav once and patches ~30 nodes.

Three rules keep it that way:

1. **One reactive source of truth per row; the only write path is its store's setter.** Enforced by the type system: readers take `ReadonlyGame` (`types.ts`), so `game.field = x` outside a `produce` draft is a typecheck failure rather than a silent no-op. `Readonly` is deliberately shallow — it stops `g.details = …`, not `g.details.rating = …`, and `details` is only ever replaced wholesale.
2. **Async state belongs in `createResource`, not in booleans on a domain object.** News, achievements, price, DLC and owners therefore aren't on the `Game` shape. (`inLibrary`/`onWishlist` stay — they're the _table's_ copy, stamped onto rows for the ✓/☆ name-cell markers; the panel reads its own `ownership` resource, so a standalone lookup still gets a badge. Both go through `myOwnership.ts`'s one cached pair of sets, so they can't disagree.)
3. **Never capture a reactive read into a plain `const` in a component body** — read signals and store fields inside JSX or a `createMemo`. This is what `npm run lint`'s `solid/reactivity` rule checks, and why the panel is a set of small components (`PanelSubnav`, `HltbSection`, `RefreshButton`, …): a component function runs once and is not a reactive scope. The two deliberate exceptions carry an `eslint-disable-next-line`: `PanelRest`'s `const g = props.game` — the row _object_ is stable for the mount (`PanelBody` renders it under a `keyed` `<Show>`), and capturing a store row is not capturing a field of it — and `BundlesBrowseRoute.tsx` handing its `viewingShared` accessor to `bindViewPersistence`, which reads it in its own effect.

Still deliberately imperative: the subnav scroll-spy (measures section positions, marks the current tab and moves its underline, re-run from a `createEffect` when the buttons change); `panelNav.ts` rendering the prev/next/random bar into `#panel-nav` (its "i / N" from one `createEffect` over the route's `getGameList()`, ↑/↓ through the route's `stepGame` at click time, hidden while the open game isn't in the list); and `lightbox.tsx`'s own DOM.

## Rows, streaming, and stale loads

- **Load progress**: while details stream in, the status line shows a bar and a time left from the last 20 s of progress (`loadProgress.ts`) — cached games arrive in a burst, uncached ones at the upstreams' throttled pace, so an overall average would promise far too little. Past a minute it also says why, for the rest of that load.
- **Rows are a Solid store** (`createStore`) owned by the route; Solid's dev mode blocks a direct `row.field = x` on a store proxy, so:
  - Every mutation goes through `createRowStore`'s (`rowStore.ts`) `mutateRow(appid, fn)`, which applies `fn` via `produce(fn)`. That's why the mutate-in-place helpers (`applyDetailsEvent`, `priceLoading.ts`'s `applyPriceInfo`/`nullMissingPriceFields`) take a plain draft.
  - `@vates/data-table-solid` renders each `<td>` as a reactive insertion reading `row[column.key]`, so a field write re-renders exactly that cell — no new object reference needed.
  - A game that isn't one of the route's rows (a DLC/base-game link, a standalone lookup) gets `undefined` from `mutateRow`; the caller writes to `standaloneRows` instead.
- **A streaming/high-frequency `mutateRow` caller must batch**, or the table's live `tableData()` re-sorts/re-filters/re-paginates once per _event_ instead of once per _flush_ (measured: a ~1150-game library took ~33 s of unresponsive main thread unbatched, ~6–7 s batched). Two shapes, two fixes:
  - **Spread over time** (the SSE `/api/game-details/stream` loop, `ListRoute.tsx`'s `streamGameDetails`) — `streamBatcher.ts`'s `createStreamBatcher` queues events and applies them in one `batch()` per ~150 ms flush; its `onFlush` runs `updateStatus`. Each queued event carries its load's generation (`loadGuard`, `staleGuard.ts`) and is dropped if stale by flush time, since two overlapping loads share the queue.
  - **One synchronous burst** (a price response processed in one loop — `loadPrices`) — the loop is wrapped in a bare `batch()`.
  - Deliberately **not** built into `mutateRow`: one-off writes (an achievements load, a DLC toggle, a Refresh details click) must apply immediately.
- **Media load on open, not with the stream**: the stream leaves out each game's screenshots and trailers (`lib/streamEvent.mjs`), most of its bytes yet only ever shown for the open game.
  - Opening a list row loads its own from `GET /api/game-meta` (a cache hit after the stream), and its neighbours' in list order so ↑/↓ land on media at once (`ListRoute.tsx`'s `loadMedia`).
  - Until they're in, `detailsPending` holds a link's `&shot=`, the TV rejoin and the lightbox's TV latch. A failed load marks the row (`mediaFailed`): those settle on the Cover, and opening the game again retries.
  - Standalone and search rows come from `/api/game-details`, media included.

## The game table

Every list of games — owned, wishlist, bundle, recent, user — renders through the same `@vates/data-table-solid` table over the shared column set (`public/gameColumns.ts`), with `ListRoute.tsx` layering per-kind columns on via `insertColumnsAfter`:

- **owned** — Played (h), Last Played, after the HLTB cluster.
- **wishlist** — Wishlist Rank, then `PRICE_COLUMNS`, plus Added.
- **bundle** — ownership status, Tier Price, Add-on, then `PRICE_COLUMNS`.
- **recent** — ownership status, plus Looked up (the stored newest-first order), its default sort.
- **compare** — ownership status, plus one Played (h) per player, shown by default and keyed by position (`playtime:<i>`) so a saved layout fits the next comparison; the membership column when grouped by membership.
- **creator** — ownership status, `PRICE_COLUMNS`, and Taste fit shown by default.
- **shared** — ownership status, plus the membership column when grouped by membership. A priced source adds `PRICE_COLUMNS`, and a bundle source its Tier Price too (`bundleTierFields`, fed by `createDefaultFetchers`' `onBundleGames`; the first bundle wins a game in two), shown once a remaining row has one; a pick-and-mix rate reads "Varies", having no selection to count, and a region change re-fetches the bundle.
- **user** — ownership status, plus Played (h)/Last Played for the **current account** (hidden by default), stamped alongside the ✓/☆ markers from `myOwnership.ts`'s `peekMyOwnership` — the same library fetch, no extra request. A list with a priced source (`listHasPriceSource`: built from a wishlist or a bundle) adds `PRICE_COLUMNS`, and a non-ranked one a bundle source's Tier Price, as **shared** does. A **ranked** list adds Rank, its default sort.

Default sort is Weighted Rating descending, except a bundle (cheapest tier first, then rating), recent (Looked up) and a ranked list (Rank). `/bundles` is a table of bundle rows with its own small column set, reusing `gameColumns.ts`'s bucket/compare helpers so its price/date/count columns group and sort like their game-table counterparts.

`gameColumns.ts`:

- `CORE_COLUMNS` (identity, scores, HLTB, dates, classification, compatibility, extras — every kind shows them) and `PRICE_COLUMNS` (Steam Full Price, Best Deal, Discount, Price Status, Best Deal Shop, the three historical lows — wishlist, bundle and priced user or shared lists only), plus `insertColumnsAfter` and helpers (`fmt`, `renderScoreNum`, `renderBestDeal`, `renderPrice`, `renderCut`, `computePriceStatus`, `PRICE_STATUS_TIERS`, `PRICE_TIERS`/`priceTierBucket`/`formatPriceTier`, `TYPE_LABELS`, `protonDbValue`, `renderProtonBadge`, date/log-bucket helpers).
- Its compare/bucket primitives (`compareMissingLast`, `bucketNumericRange`, …) come from `@vates/data-table-core`, imported through `@vates/data-table-solid`'s re-exports — no direct `@vates/data-table-core` dependency.
- Per-kind column objects (Tier Price/Add-on's render code, the wishlist and owned columns) stay local to `ListRoute.tsx`.
- Most columns carry a `category` (`@vates/data-table-core` ≥ 0.13) — `Scores & Reviews`, `How Long To Beat`, `Play Time & Dates`, `Classification` (also Add-on), `Compatibility`, `Extras`, `Pricing` (`PRICE_COLUMNS` plus Tier Price) — so the Columns/Sort/Group/Filter menus collapse into per-category submenus. Identity (`capsule`/`name`) and Wishlist Rank stay uncategorized.
- On a phone (≤ 768 px) the Name column stays pinned while the table scrolls sideways (`styles/vendor-data-table.css`, keyed on `data-col-key` and `.game-name-cell`).
- The Image column shows `row.thumb` (the 231×87 capsule), falling back to `row.capsule` if it fails, then hiding; a row that starts from a search's tiny image keeps it until details stream in.
- Prev/next ordering (`getGameList`) reads the table's `processedData()` accessor; nothing imports the unsupported `@vates/data-table-core/internal`.

**Record-low badges** — `dealRecordTier(price, row)` (`utils.ts`) is the one source for them, over `DEAL_RECORD_TIERS`: green + bold + 🔥 all-time low, plain + ★ 1-year, amber + ☆ 3-month, rarest first. `<=`, since the current deal can be the low itself. A deal with no discount gets no tier, since ITAD's lows include full prices ([integrations.md](integrations.md)).

- `renderBestDeal` badges the price instead of putting the shop name in the cell; the shop is in the `title` tooltip (plus the tier's `tooltipLabel`, e.g. " — all-time low") and in the hidden `bestDealShop` column.
- The panel's Price card (`PriceSection`) keeps its own render code on `dealRecordTier`: importing `renderBestDeal` would pull `@vates/data-table-solid` into the panel. Unlike the cell, it spells each badge out ("★ 1-year low", "all-time low €2.49 🔥"), having the room.

**Failed sources are marked apart from no data.** `GET /api/game-details` lists rejected sources in `failed` (absent when none did), kept as `row.failedSources` by `applyDetailsEvent`. The rating, HLTB, ProtonDB, store-page (`meta`) and tag columns (`markFailedSources`) show ⚠ with a tooltip instead of "—", the status line counts them per source (`failedSummary`), and the panel's glance chips say "didn't answer" — its Refresh details retries, since failed sources aren't cached. A failed price batch sets `row.pricesFailed` (`nullMissingPriceFields`): the price columns show the same ⚠ and the Price card says IsThereAnyDeal didn't answer; the Prices tile's refresh retries.

**A refusal is said once, in the server's words.** Past this client's share of the outbound budgets ([observability.md](observability.md#outbound-budgets)), the details stream sends one `{ limited }` event: the status line shows its message instead of `failedSummary`'s per-source counts. A 429 on the list's prices, or on the panel's achievements, price or bundles (`refusalMessage`, kept per key by `panelData.ts`), shows the server's message instead of "didn't answer".

**Price columns group by bucket, not exact value** (a raw price is near-unique per row):

- Every price column (Tier Price, Steam Full Price, Best Deal, the three lows) buckets against `PRICE_TIERS` (`[0, 5, 15, 30, 50, 75, 100]`), matching Steam's common price points ($4.99/$14.99/$29.99/$49.99/$74.99), which neither a linear step nor `bucketLogRange` reproduces. A real `$0` is its own "Free" bucket.
- Discount uses a fixed 25-point step (`bucketNumericRange(25)`/`formatNumericRange(25, '%')`).
- Bucket labels have no currency symbol (`formatPriceTier`: `"5–15"`), since the region's currency varies (`tierCurrency`/`priceCurrency`, [integrations.md](integrations.md)).
- A currency more than 2× off USD in `currency.ts`'s rates (yen, won, rupee…) is converted to USD before bucketing, or everything lands in "100+"; a near one (euro, pound…) is bucketed as is, since converting would push its .99 prices across the bounds.
- Tier Price's missing bucket reads "Varies" (`formatMissingGroup(formatPriceTier, 'Varies')`), matching `renderTierPrice`'s "Varies ≠ no data". `ListRoute.tsx`'s `TIER_PRICE_COLUMN` reuses the bucket helpers.

**Tag match** (`tagMatch`, `tagMatchColumn`) scores each row against the Tags column's include filter: the mean of the filtered tags' `tagWeights` (absent: 0), or their minimum when the Tags filter is on All (`filter.modes().tags === 'and'`), in %. Its `value()` reads the filter through the `filterTable` signal, so the table's own `processData` memo re-sorts when the filter changes. A transition of that filter between empty and not (`syncLeadColumn`) shows the column and makes it the first sort, or removes both along with any Tag match range (all its values turn `null`, so a leftover range would hide every row); it's armed only after the stored view is restored, so a saved view keeps its own sort.

**Owned's profile** (`PlayerProfile.tsx`'s `OwnedProfile`, through `ListHero`'s `section` slot; the note slot only says when playtime is private, `playtimeHidden`): built from `loadedRows`, the rows unwrapped once every one's details are in (a task after the stream's last flush), so it doesn't reshuffle while details stream, reads no store proxies, and later row writes (prices, a panel ↻) don't redo it — it copies the array, not the rows, so such a write still shows in whatever is next computed from it. A fresh load clears it; a ↻ refresh keeps the previous one, and its rows, until its own stream ends (the store's rows are new objects by then, so a write in between shows only once it's retaken). Owned's taste, a comparison's Group fit and player profiles, and the Similarity column (the live rows while a fresh load streams) read it too.

- `tagTaste.ts`'s `topPlayedTags` gives the tags and how many played games they come from (`played`); software (`isSoftware`) counts toward no profile — Plays mostly, Taste fit or Group fit. Each tag is a `TagBars` button holding its weight bar and a visually-hidden %, calling `onTagClick` like the panel's pills.
- `playerProfile.ts`'s `profileFacts` and `archetypeOf` (none for a Family) title the card; its story tile (`storyGames`) and barely-played tile show only with data, the card going full width without them. The barely-played count is of games played `PLAY_NEXT_MAX_HOURS` or less and not marked finished or abandoned (`unplayed`, the Play next template's own bounds in `listViews.ts`, whose `withStatusExclusion` adds the status exclusion to a template view stored before it, unedited); its **Play next** (`showBacklog`) opens that view (`templateView`, created the first time), pressed while it's open, back to All games on a second press.
- **Why these?** (`playsMostlyWhy`, a route-level signal since the hero re-renders) opens each figure's evidence in its own card (`profile--open`): each tag's `games` (by their share of its score) under its bar through `TagBars`' `detail`, the story games as `StoryList` rows of hours against `hltbMain`, and a folded **How it's counted**. Game names and art come from the rows (`ProfileGameInfo`).
- Layout: the main card `2fr` beside the stacked tiles; at 768 px and below, stacked, 4 bars (all once Why these? is open), each tile one line.

**Taste fit** (`tasteFit`, `tasteFitColumn` in `ListRoute.tsx`): `tagTaste.ts`'s `fitTo` against the current account's stored `Taste` ([lists-and-accounts.md](lists-and-accounts.md#storage-schema)), read through the `tasteFitSource` signal; Owned saves it (`tasteOf`) once its details finish loading and swaps it into that signal, so its own Taste fit scores on a first visit. While the column shows, the list status (`scoreNotes`, `tasteFitNote`) says whose taste and how old, or why there's none — but not "open Owned" on a `?u=` link to another account (`linked`).

**Players** (compare only, `playersSection`, `ListHero`'s `section` slot): per player, `topPlayedTags` and `playStyle` with that player's hours (`playerHours`, summed over a Family's members) instead of the rows' own playtime.

- Computed from `loadedRows` (see Owned's profile above, `playerProfiles`); only on Grouped or Union (`profilesShown`), whose rows hold every library.
- A `<details>` whose open state is a route-level signal, open by default from 768 px. A tag tapped in it scrolls the table's toolbar up when it's in the lower half of the screen, since an open section pushes it off a phone's.
- Each player a card (`players-card`): `PlayerAvatar` (the account's `avatarUrl`, a Family's first member's, else the initial), `ProfileBadge` and `archetypeOf` (with that player's `storyGames`; none for a Family), then **Playing lately** (`GameOwner.recentMinutes`, which the server leaves at 0 for a library copy over 14 days old) and their tags. Under them one shared-ground card, its labels in a left column (above, at 600 px and below), games as `gameArt` buttons (`thumb ?? capsule`, lazy).
- In it, `tagTaste.ts`'s `commonGround`: the top tags each pair shares (in the summary for two players; closest pair and odd one out for more), tags in common, each player's own (shown on their line in place of their top tags), and favourites everyone played a lot, each opening its panel.
- **Suggest to** (`suggestTarget`, defaulting to the first player with a profile who isn't my ★ or current account): `suggestionsFor`, ranked among that player's unplayed games, since the played ones are what their profile is made of.

**Group fit** (compare only, `groupFitColumn` in `ListRoute.tsx`): the minimum over players of `tagTaste.ts`'s `playerFits` (cosine of the game against each player's play profile), computed once details finish loading; the cell names the least suited player, its `title` lists everyone's score, and the list status (`scoreNotes`) names players left out for lack of a profile unless an open **Players** already does (`playerProfiles` and `playersOpen`).

**Similarity** (`similarity`, `similarityColumn`) scores rows against `ListRoute.tsx`'s `similarTo` game (set from the panel through the `similarTo`/`setSimilarTo` route handlers) with `tagTaste.ts`; the target scores 100, a tagged non-match 0. `syncLeadColumn` shows and sorts it the same way; it's reset on every table build, so a stored view never keeps it.

**Price Status** (`priceStatus`, hidden by default; `PRICE_STATUS_COLUMN`, `computePriceStatus`) makes "which games are at a record low" a filter or group: `All-Time Low` / `1yr Low` / `3mo Low` (via `dealRecordTier`) / `On Sale` (a real discount, not a record) / `Not Discounted` (`bestDealCut === 0`) / `—` (no data). A `value()` function, so no extra fetch or stored field.

- `PRICE_STATUS_TIERS` is the single worst-to-best list behind its sort (`PRICE_STATUS_ORDER` → `comparePriceStatus`) and its look (`renderPriceStatus`); its record entries spread `color`/`icon`/`bold` from `DEAL_RECORD_TIERS`, so the column can't drift from the Best Deal badge. On Sale and Not Discounted stay plain text.
- `defaultSortDir: 'desc'` puts All-Time Low first; `render` also drives group headers, so they show the badge.

**View persistence.** A table's view (visible columns, sort, grouping, filters) auto-persists locally as it changes:

- One `prefs.ts` key per system kind (`ownedListView`, `wishlistListView`, `bundleListView`, `recentListView`, `compareListView`, `sharedListView`, `creatorListView`, `gamePassListView` — the bundle, compare, shared and creator ones shared across instances — plus `bundlesBrowseView` for `/bundles`; listed in `tableViewKeys.ts`). A user list stores its own `tableView` on the list; `tableViewPrefs.ts`'s helpers take either as a `ViewStore` (a load/save pair; `prefViewStore(key)` for a pref key).
- It's applied _after_ `table.setViewState({ sorts: DEFAULT_SORT })`, so a stored view overrides the default sort and a first visit gets the default.
- It's **not** written to the URL as it changes — a URL left in the address bar would go stale on the next table change. "Share view" snapshots it into `?tv=` on a copied link only (one param name; one table per route), never calling `history.replaceState`.
  - On Owned/Wishlist it also adds `u=` for the effective account unless the URL has one; other kinds don't, since `u=` there would only swap the recipient's ownership markers.
  - Disabled on a saved user list (`shareViewFailure`, shown under the buttons): `/lists/<id>` only resolves in the browser holding it.
- An incoming `tv` wins for that visit only: `restoreTableView` applies it without storing it and strips it from the URL, and the route pauses view persistence behind `SharedViewBanner` until the viewer keeps it (saving what's on screen) or goes back to their own. Consuming it matters because a table is rebuilt far more often than on page load.
- A **saved view** (`?view=<id>` on Owned/Wishlist, `listViews.ts`) is the table's `ViewStore` instead of the kind's pref key, with `save` writing only an in-memory draft per view id: table rebuilds keep unsaved edits, and only the banner's Save (`UnsavedChangesBanner`, signed in or not) writes the pref. A `?view=` change re-applies the new view in place, without a reload, dropping the drafts. Default view is hidden there (Revert does it); Share view drops `view=`.
- A signed-in device never auto-syncs a table-view key; edits stay local until an explicit Save. See [lists-and-accounts.md](lists-and-accounts.md) for the Save/Revert flow (`tableViewSync.ts`, `tableViewPrefs.ts`'s `saveTableViewToServer`/`revertTableViewToServer`).

## Each list kind, in practice

Every route opens with a **hero** (`ListHero.tsx`, a `<header>`, a flat section rather than a card): the list's name as the page `<h1>`, an optional lead, kind/shop/account chips, the route's own actions, and the list's facts as a `<dl>` of labelled tiles — all off fetches the route already makes.

- **The hero is dumb**: no data, no per-kind branching; callers pass formatted values, so "what does a wishlist show" is answered in `ListRoute.tsx` alone. Its dates are ISO, like the tables' (see [ui-guidelines.md](ui-guidelines.md)).
- **A tile can be a control**: given `onClick`, a `<button>` in its `<dd>`, named by the `<dt>` and its own text (`aria-labelledby`), `aria-disabled` while its action is in flight (not `disabled`, which would drop the focus of the click). A toggle also passes `active`, rendered as `aria-pressed` and read back from what the click applied.
- **A tile that refreshes replaces the route's Refresh button** (`refreshTileValue` adds a refresh icon beside the value), so it's rendered unconditionally — during a load and after one that failed before fetching, when a retry is wanted.
  - `/bundles`: Updated re-fetches, Prices opens the Preferences popover (`openPrefsPopover`), New/Ending soon toggle filters.
  - Owned/wishlist: Updated does the same. Prices shows only where the list is priced (`hasPrices()`: the wishlist, a user list with a priced source), never on owned. Any list built from an account fetch, at any depth (a comparison; a dynamic, ranked or shared list), gets Updated too: its age is the _oldest_ of the account fetches behind it, and clicking re-resolves them all past the server's cache (`createDefaultFetchers`'s `refresh`/`onFetchedAt`, `listResolve.ts`).
  - The tile is gated on there being an age, not on the kind: a manual list (stored appids) has none. Owned, wishlist and comparisons keep it without an age ("—") so a failed first load can be retried.
  - Exception: a bundle's own hero tile is a plain `<div>` — finding one bundle walks several cached list pages, so `GET /api/bundles/:id` has no force path. It still states the age of the page the bundle was found on (`findBundleById`'s `cacheKey`).
- **Prices carries two actions**: its value (the region) opens the Preferences popover, its sub-line (the price age) re-fetches prices. With a `subOnClick` each half renders as its own button (HTML has no nested buttons); otherwise value and sub-line are one button.
- **A refresh** (`load({ refresh: true })`) keeps the table, its rows' details and the selection until the new list resolves, then rebuilds with the kept details (`withKept`) and streams only new games. It keeps the previous age, a dynamic list's formula line and `heroTitle` (blanking it would tear down the tile being clicked).
- Tiles render through `<Index>`, not `<For>`: recomputes build fresh tile objects, and by-reference keying would replace the activated button and drop its focus.
- On a phone (≤ 768 px) tiles become one swipeable row, and `hero-secondary` actions (a bundle's IsThereAnyDeal link and Rank; a comparison's Edit players and Save) fold behind a More actions toggle (`secondaryActions`), so the table starts higher. A bundle's tiles lead with Tiers and New to you, Ends after, so the price shows without a swipe.

Per kind:

- **owned / wishlist** — name the account they show (avatar, profile link, Family merge count) with Games/Updated tiles, plus Prices on the wishlist. A `?u=` link is authoritative: while it resolves, and if it fails, the stored account is not loaded in its place.
- **bundle** — Ends (with a countdown), Games, Tiers as price chips, Published, Prices, plus ITAD's editorial note; previous/next step through whatever `/bundles` last showed, in its order (`bundleBrowseStore.ts`), with All bundles beside them; Get this bundle is the one primary action. Games with **no Steam listing** (courses, asset packs, shop-exclusive keys) render below the table as a collapsed "N more in this bundle, not on Steam" section, and the status line reads "3 of 13 games matched to a Steam listing", so the table never passes for the whole bundle.
  - **Fanatical pick-and-mix** (`bundle.pickAndMix`, see [integrations.md](integrations.md#fanatical--pick-and-mix-tier-prices)): one chip per quantity tier ("5 for €5.99"); Fanatical charges every pick the per-game rate of the largest tier reached.
    - `cheapestPicks` (`bundleRows.ts`) prices one pick per ITAD gid at that rate, or at a larger tier's price when lower (spare picks free). The plan's chip gets `bundle-tier-chip--active`; the selection toolbar shows the cost (`pickPlanDetail` under it), then the saving or overpay against the same games' best deals (`pickSavings`, green/red).
    - Each row's Tier Price (`tierPerGame`, "/game") is the plan's rate (`pickRate`), rewritten on every row by an effect on selection change — the same on every row, so a sort on it doesn't reorder.
    - With `bundle.pickAndMixNames`, the toolbar adds **Buy N on Fanatical ↗** (`fanaticalBuyUrl`), the draggable **Add to Fanatical** bookmarklet (`FANATICAL_BOOKMARKLET`; clicking it here only says to drag it) and "N to pick by hand" for unmatched picks.
  - **Steam packages**: a gid resolving to several appids is one purchase. `bundlePackages` sets each row's `bundlePackage` ("package · N games" under Tier Price; in a pick-and-mix bundle only the lead row shows the rate, the rest "included"), the selection effect widens every tick to the whole package (`wholePackages`), and the pick count, the selection's best deals and New to you count one row per gid (`onePerGid`) — each package row carries the whole package's price.
- **recent** — says it's local browser history; `params.appid` focuses one game without making it a different kind of view, and the open game is the path, not `?game=` (see Routes).
- **user** — its manual-or-op chip with Games/Folder/Sources/Edited, plus Prices with a priced source. A dynamic list states its formula in the hero: each source named (`listLabels.ts`), linked, with what it contributed (`Alice — Owned 343 ∪ Alice — Wishlist 115 = 457`); a dangling source is flagged in place. `group-by-membership` is one table grouped by an "Owned by"/"In" column (`membershipColumn.ts`: each row's `membership` key, in `combine.ts`'s most-sources-first order via the column's `compare`, headers saying who's in and who's missing); every other op flattens to one table.
- **compare** — an unsaved dynamic list built from the URL: one `account-owned` source per `?u=` slot, combined with `?op=` (default `group-by-membership`), resolved and labeled through the same `listResolve.ts`/`combine.ts`/`listLabels.ts` path as a stored one, so "Save as a list" is `createList()` with the same formula.
  - It resolves each slot itself (`resolveAccountSlot`), never touching `recentAccounts` — comparing someone isn't picking them; the form's account chips write nothing back either.
  - It rewrites the address to the resolved steam64 ids in canonical order, and orders sources by the same rule, so one URL renders one way.
  - Sources are labeled by the player alone, not "⟨player⟩ — Owned", which would repeat in every group heading.

A grouped list is always grouped and sorted by membership first (`withMembershipGrouping`, applied over the restored view — a comparison shares its view key with its flat operations); the flat operations drop it (`withoutMembershipGrouping`). Groups start expanded (`defaultGroupsCollapsed: false`).

**`/bundles`** is one of these tables over bundle rows: cover, title, shop, game count, cheapest tier price, published/ends dates, plus hidden tier-count, age and urgency columns, newest first.

- **Ends in** (Within 48h / This week / Later / Open-ended / Ended) and **Age** (Last 24h / This week / Older / Unknown) are `value()` accessors ordered by their own `compare`, since the buckets are clock-relative and must be recomputed.
- The hero's "Ending soon" and "New" tiles toggle those buckets in the column's include filter ("New" adds both sub-week buckets — bundles publish in waves, so 24h is empty most days).
- `Ended` also tells Active from Expired rows under "Include expired"; `BundleRow.status` remains only as the marker `renderBundleTitle` hangs the row-dimming class on.
- ITAD has no bundle image, so the cover is a 2×2 grid of four of its games' `banner145` assets (already in the list response), beside a per-shop color chip (hue hashed from the shop name) and a colored countdown on anything ending within the week.
- Sort/filter/group run over the whole loaded set; only "include expired" round-trips, since it reaches ITAD's much larger archive rather than the ~30–40 active bundles.

## Global search and the account chip

The "look up any game" box is one nav-bar search in the shell, not one per route.

- Focused while **empty**, it shows recently looked-up games under a heading, with a sticky "See all recently looked up" row (with an arrow) to `/game`. They're `GameSearchResult`-shaped, so roving selection, ownership markers and `onSelect` apply unchanged; the heading and "see all" row are `role="presentation"`.
- `gameSearch.ts` takes the list and the "see all" destination as options rather than importing `recentGames.ts`.
- Typing a query gets "See all results for '…'" instead, to `/search?q=…`.

`AccountChip.tsx` says who the app is showing, following a `?u=` link that resolves after mount, with a link icon (named "from a link") when a link's account is showing.

- Both nav popovers (this and Preferences), and the rank menu, are native popovers (`button[popovertarget]` + `[popover]`: the browser opens, closes and dismisses them on an outside click) sharing `navPopover.ts`: it closes them on Esc ahead of the page's own Esc handlers, and positions the panel in JS because `.site-nav`'s flex-wrap moves its triggers with viewport width (seen off-screen on a real Galaxy S10, ruling out CSS-only anchoring).
- It carries **copyable Steam identifiers** (`accountsStore.ts`'s `accountIdentifiers`: the stored custom-URL name, else the steam64 id), read from the slot since the chip fetches nothing: one for the current account, one per member beside each recents row (outside its switch button, which can't nest one).

## The side panel

`panel.tsx` is a single instance mounted by `AppShell.tsx` — routes only open/close it (`panelOpen(game)`/`panelClose()`/`isPanelOpen()`/`getPanelGame()`/`panelStepHero()`). `AppShell.tsx` passes every `PanelOptions` hook (close, navigate, refresh, tag click/active, owners), each relayed to the mounted route through `routeHandlers`; `ListRoute.tsx` registers them all and `RankRoute.tsx` the refresh; elsewhere refresh and tag clicks no-op.

**Tag pills filter the table.** On a route that registers no `onTagClick`, they render as plain pills. A tag/genre/category/developer/publisher pill toggles that value in the matching column's `include` filter — `initPanel({ onTagClick, isTagActive })` forwards through `routeHandlers` to `ListRoute.tsx`'s `onTagClick`/`isTagActive` (`table.filter.setValues(...)`/`.include()`). The panel's keys (`tags`/`genres`/`categories`/`developers`/`publishers`) are the table's column keys. A Steam tag pill also carries its `tagWeights` entry as a bottom-edge gauge (`.tag-weight`, shared with Plays mostly) and a tooltip.

**Docked, not modal.** Table and panel are two live columns, so the panel is an `<aside>` (complementary), not a dialog; no backdrop, focus trap or click-outside close — its Close button or Escape closes it, and clicking another row swaps the content. A narrow viewport falls back to a full-screen overlay.

**Full-height, out of flow.** The panel is `position: fixed` at the right edge, spanning the viewport height, and `.app-shell` reserves its width (`--panel-w`) as padding while open, so nav and footer shorten with the content. (In flow, it stretched to the document height, breaking `.panel-body`'s scrolling and `.panel-nav`'s pinned bar.)

Above 768px the shell is locked to the viewport and **`.app-scroll` is the page's scroller**, avoiding two scrollbars side by side. Nav and footer sit inside it, so they still scroll away; `.app-content` takes `flex: 1` to keep the footer down on a short page.

- **`AppShell` owns the page's scroll position** (`pageScrollTop`/`scrollPageToTop` — `.app-scroll` on desktop, the document on mobile, so both are read and written). It scrolls to the top on each path change, and shows the floating **Back to top** button (an up arrow) past `TO_TOP_AFTER_PX`. The button's `position: fixed` ignores the shell's gutter, so `.panel-open` offsets it by `--panel-w`; its z-index is below the panel's.
- **A pref write storage refuses** (`prefs.ts`'s `prefsWriteFailed`) shows `StorageFullBanner` (`role="alert"`), fixed along the bottom left of the Back to top button and over the panel. Dismiss hides it until a write succeeds again, handing focus back to where it was before the banner (else `<main>`); the next failure brings it back. The failed edit isn't kept in memory: it snaps back.
- **Below 769px the lock is off** and the document scrolls: the panel is an overlay there, and a document that never scrolls is a URL bar that never collapses.

**Focus and history.**

- Opening moves focus into the panel (heading/close button) so screen readers announce it; Tab flows freely back to the table. Closing returns focus to the shown game's row (else to what opened it from outside the panel; a reopen from inside, by ↑/↓ or a DLC link, keeps that), so ↑/↓ carry on from there.
- Opening the panel, and the lightbox over it, pushes one history entry each (`overlayHistory.ts`), so Back closes the innermost one. Stepping to another game or shot only rewrites the URL, so Back never walks through every game looked at.
- A close by the Close button, Esc, the backdrop or a swipe steps back over its entry, so the next Back leaves the page. The entry it lands on is rewritten to the current address minus that overlay, so a game stepped to in the lightbox stays open; for a browser Back that needs the Navigation API (`currententrychange`).
- Back from a page a panel link led to reopens that game. Entries are tracked by the router's `_depth` stamp (an overlay's own is at least one above the entry below, as the router's stops growing at Chromium's 50-entry history cap), and Back's target keeps the page's URL with the overlay closed (`urlWithoutPanel`/`urlWithoutShot`), so a deep link's Back lands on its list.

**Sections**, in order: hero carousel (`PanelHero`, swipeable, feeding `lightbox.tsx`); a sticky header (DLC trail, name, release date and base-game link, the Store/ITAD/More/copy-link/Refresh icons and ownership badge, the subnav in one row, scrolled to the current tab); a demo banner when the game has a free demo; the glance grid (Weighted Rating, Metacritic, HLTB, Linux/Deck — the review count is the Weighted chip's caption); Price, with the current bundles the game is in below its lines (`PanelBundleLines`); the store description; tags; Similar in <account>'s library; "Owned by"; How Long To Beat; News; Achievements; DLC.

- The Status select (`StatusSelect`) floats on the release date's line: the action row has no room on a phone.
- Collapsible ones share `CollapsibleCard`; a subnav scroll-spy tracks position, as `aria-current` on the section's tab and one accent underline gliding to it.
- The name is the panel's `<h2>` and each section a `<section>` titled by an `<h3>` (a collapsible card's is its toggle button, wrapped), so a screen reader jumps between sections by heading.

- **Motion** — the panel slides in on open (CSS `@starting-style`: from the right, from the bottom on a phone). Its content goes on close, so a copy (`leavePanelGhost`'s `.panel-ghost`, ids and names stripped so it can't answer the live panel's lookups) slides back out and is removed on `animationend`; none under reduced motion, with the lightbox open, on leaving the route, or after a swipe, which already slid it out.
  - A pointer click on a row while the panel is closed morphs the row's thumbnail into the hero instead (`openPanelFromRow`; `ListRoute.tsx` passes its `openGame` as the update). The panel skips its slide then (`.panel-morph`). Keys, ↑/↓, random and DLC hops open at once.
  - `viewTransition.ts`'s `morph` runs both this and the hero → lightbox morph: it names the two ends `game-art` for the transition only, waits up to 150 ms for the destination's picture, and moves focus once the new view is in (`updateCallbackDone`; `panelOpen` skips its own focus while `isMorphUpdating()`). The lightbox's `showModal()` runs inside the morph's update, after `canMorph()`'s `dialog[open]` check, so its open still morphs.
  - The panel's ground (`--panel-ground`, shared by its sticky header, nav bar and glance chips) mixes 12% of a tint from the open game's table capsule into `--surface`: `artTint.ts` averages the image on a canvas and clamps it to OKLCH L 0.17, C ≤ 0.04, so text contrast holds for any art; it stays plain `--surface` while the image is read and when it can't be.
  - While the cover loads, its frame shows the row's table capsule (`standIn`), already cached, so the morph and a step to another game land on the game's art rather than a shimmer.
- **Similar in <account>'s library** — `SimilarSection`: `tagTaste.ts`'s `similarInLibrary`, the IDF-weighted cosine over `tagWeights` plus Production Tier ([decisions.md](decisions.md#production-tier--a-heuristic-not-steam-provided-data)) against the effective account's cached `Taste.games` ([lists-and-accounts.md](lists-and-accounts.md)), so no extra requests. Hidden on Owned's own rows (`isOwnedList` route handler): it would repeat the Similarity sort. Without a cache it links Owned; without an account, only the Steam link. The Sort list by similarity button shows on a route registering `setSimilarTo`.
- **News** — every headline in the game's own `steam_community_announcements` feed (up to 20, `extractNews`' cap), each linking to the post, collapsed behind a chip whose ↗ goes to the Steam news hub. The server filters to that feed because raw `GetNewsForApp` mixes in syndicated press in any language ([integrations.md](integrations.md)). A game with no official posts renders no card.
- **Price** — one always-open card: the Best Deal (with the record-low badge, see the game table), its Discount, the shop, and an "IsThereAnyDeal ↗" title link for history. When there's a deal, the _whole line_ below the title links to ITAD's per-deal `url`, unmodified — buying is the point of the card.
- **Prev/next/random nav** (`panelNav.ts`, ↑/↓/R) steps the route's processed row order. A list's table toolbar has its own random pick (`ListRoute.tsx`'s `viewActions`), since the panel nav only shows once a game is open.
  - `panelKeyboard.ts` binds the page shortcuts (Escape, `?`, `/`, hero stepping, random, list stepping) once and blocks them all but `?` while the lightbox is open (Esc there is the dialog's own `cancel`), so ↑/↓/R are bound again inside `lightbox.tsx` (`initLightbox`'s `onGameNav`/`onGameRandom`, re-pointing through `repointLightboxGame`). `gamePosition` only feeds the lightbox's caption.
  - `ListRoute.tsx`'s `openGame` calls `table?.focus.moveTo(resolved)` on every open: `@vates/data-table-solid`'s external focus API (≥ 0.14) expands the row's group, jumps to its page and scrolls it into view without taking DOM focus from the panel. `SearchRoute.tsx` instead moves real DOM focus onto the row (`focusRow`) for a visible ring, which `moveTo` never does.
- **The DLC trail** — the back button over the name, "⟨game⟩" (named "Back to ⟨game⟩") — is `panelHistory.ts`'s `nextHopHistory` rule (pop rather than push when the target is already on top, so bouncing between a base game and its DLC doesn't grow duplicates); the trail is a signal in `panel.tsx`, preserved across a hop through `/game/:appid` by its `pendingHopAppid` latch.
- **A game outside Steam** (`igdbRow`, `IgdbPanel.tsx` instead of `PanelRest`): name, release date, a "Not on Steam · PS5 · Switch" line saying why the Steam sections are absent, IGDB's rating and HLTB as glance chips, the summary, genre/developer/publisher pills (never filters: no column describes it), HLTB, and in the links row an IGDB credit, copy link and ↻ (the `igdb` resource's `refetch`). No store, ITAD, More, Present, status or ownership, which all need an appid; every Steam resource is keyed on `openAppid`, null for it.
  - IGDB failing shows "⚠ IGDB didn't answer" with Retry; an instance without IGDB credentials (the route's 503) says it can't look up games outside Steam, with no retry.
  - A reply naming a Steam appid (`steamAppid`) opens that Steam game through `onNavigateGame`, which replaces the history entry (`/game/:appid`'s `replace`, or `?game=`'s `replaceState`).
  - Not presented (`presentHero` and the linked lightbox skip it): `OnAir`, the TV's rejoin and the nav chip all name a Steam appid.
  - Its `&shot=` waits on its IGDB reply (`ListRoute.tsx`'s effect on the row's `loading`).
- **Refresh details** refetches every panel resource with `refetching` set (bypass session cache and server TTL).
  - The button shows the details' age as text (`detailsFetchedAt`), visible on touch; only its icon spins.
  - That age is the **oldest** of five separately cached sources (reviews, HLTB, store metadata, tags, ProtonDB — tiers in [data.md](data.md)), so the tooltip breaks it down per source (`detailsFetchedAts`, from `/api/game-details`' `fetchedAts`).
  - The tooltip also names what else it re-fetches, and says when the price isn't included: a game its list already priced has a null `priceSource`, so its price refreshes from the list's Prices tile.

**The lightbox** (`lightbox.tsx`, a lazy singleton) owns its own DOM: HLS playback, zoom/pan (a toolbar toggle and Z, plus double-click, double-tap, pinch and the wheel over the picture, toward the cursor; a trackpad's sideways swipe steps once per gesture), touch/swipe, focus trap, loading indicator, `?shot=` deep links.

- A modal `<dialog>` (`showModal()`): the page behind is inert, and the shortcuts dialog stacks over it. It opens focused on `.lb-surface` (`autofocus`, no ring), where its shortcuts act; Tab reaches the controls. Fullscreen goes on `.lb-surface`: a dialog can't be the fullscreen element. Its button shows only where it works: element fullscreen, else (an iPhone) a trailer, handed to the native player (`webkitEnterFullscreen`). Leaving fullscreen unlocks the orientation the phone was turned to.
- Esc and Android's Back fire `cancel`, closed like ×; `close` covers a dialog the browser closed itself (it does when `cancel` can't be cancelled, without a user activation since the last). Both end in the idempotent `closeLightbox`, which keeps the URL and history in step.
- Its keydown listener stays on `document`, skipped while another dialog is open: a click on non-focusable content can drop focus to `<body>`, past a listener on the dialog. P stops the event's other listeners, or `panelKeyboard.ts`'s own P, finding the lightbox closed, would present a second time.

- **Swipes drag the media with the finger**, one axis each: horizontal pages media within the game, vertical pages the _game_ (up for the next). With no list to page, swiping down closes instead, as in photo viewers; an axis with nothing to step to still drags, damped. A pinch keeps the point between the fingers under them.
  - `lightboxSwipe.ts` holds the thresholds and decision (axis lock, distance, flick), the testable half; the handler only tracks the finger. A touch starting on the chrome never starts a drag, so scrubbing a video doesn't step a shot.
  - A horizontal drag brings the neighbour in beside the item (`.lb-peek`). On release the inline transform is dropped and `renderLightbox`'s enter animation takes over, named for the side the new item (still or trailer) enters from (`lb-anim-right`/`-left`/`-bottom`/`-top`, from `lbLastDir`/`lbLastAxis`), so keyboard game steps animate too; after a swipe it starts where the peek was (`--lb-enter-from`). A key or button wrap past either end enters from the opposite side, while a swipe's follows the finger.
  - The item left fades out where it was (`fadeOutLbItem`'s `.lb-ghost`, removed on `animationend`, which still fires under reduced motion's near-zero durations).
- **Chrome shows only for the input that needs it** (`lb-idle` hides it, part by part, drifting a few pixels as it fades): any mouse move brings it all back for 3 s (longer while a control is hovered or has visible focus), leaving the window hides it; a tap toggles it (on a trailer, only brings it back); Tab shows it.
  - The keyboard gets none (`lbByKey`, set by any key, cleared by a pointer): a keyboard open shows only the media, any key hides the chrome, and a step flashes only the counter (`lb--stepped`), plus the caption on a game change (`lb--stepped-game`). Play/pause, mute and a seek get a 1 s centred feedback instead (`osdLb`).
  - The first open on a device shows a one-time hint at the hidden controls (`showLbHint`, `↑↓ games · ←→ media`, swipe wording on touch).
- **Trailers**: a click plays or pauses; a tap toggles the controls (its click cancelled), and under a finger the large centre button shows with them as play/pause. A tap on a side third waits 300 ms for a second (a 10 s seek, each further tap adding 10 s more); the middle third acts at once. A non-playing trailer shows the large play button (`lb--paused`), the only control until it first plays (`lb--unstarted`, where a tap anywhere plays) and the one left once the rest idles out; an ended one offers a replay there instead (`lb--ended`), never moving on by itself.
  - The bar is YouTube's: the seek line across the top (`aria-valuetext` "1:23 of 2:10"), play, mute and `0:42 / 1:30` below it; a stall shows a spinner after 400 ms (`lb--buffering`).
  - Sound: the viewer's mute is kept (`setLbMuted`, localStorage). When the browser refuses autoplay with sound, `playHls`'s opt-in `onMutedFallback` plays it muted and the lightbox says so with an Unmute pill (`lb--automuted`); the presentation window keeps its own unmute-on-first-click rule. Playback pauses when the page is hidden, without resuming.
- **Its `<video>` is attached only while a video is on screen** (held as `lbVideoEl`, inserted and removed, never parked under `display: none`): a connected media element arms media keys, Picture-in-Picture and extensions — Video Speed Controller swallows its own keys (`r`) in the capture phase on `document` whenever one is connected, killing this app's shortcuts. `wireVideoControls` binds to the reference at mount, while detached, so it can't re-query.
- **State is reactive, DOM imperative**: it holds the open game in a signal and derives the media list on every read (as `PanelHero`'s `items()` does — rule 1 above), so a game opened before its media load gains its screenshots as they land.
- **Paging games (↑/↓/R) lands on real media**: a game paged back to returns to the item the viewer opened on or stepped to there (`lbLastShot`, for the session — not one a game step merely landed on, nor a lone banner); otherwise `preferredShotIndex` takes the first shot of the kind being left — a trailer keeps landing on trailers, the Cover on covers, an image never escalates to one (video autoplays). Otherwise the banner is the fallback only for a game with nothing else (the tell that its media are still loading); that case is latched, taking the first real media to arrive (or the remembered item; staying put when leaving the Cover) unless the viewer steps or reopens. The latch's kind carries on through such a game, whose lone banner isn't a Cover being left.
- **The media fills the viewport**, fullscreen or not; the chrome floats over it on scrims and `.lb-glass` pills (`rgb(0 0 0 / 0.55)`: full-white text keeps 4.7:1 over a white picture).
- **The caption is the list stepper**, top-left: ↑/↓ first (so they stay put whatever the name's length), then `⟨game⟩ game 308 / 343`, hidden for a standalone lookup. The media counter beside it is a bare `3 / 12` (hidden with one item); "game" tells the two fractions apart.
  - Their full wording goes to one visually hidden `role=status` line, debounced 300 ms so holding → doesn't queue every step: "Hades, game 3 of 6, Screenshot 1 of 8", naming the game only when it changes; each kind numbered on its own ("Cover", "Trailer 1 of 2").
  - The zoom button shows only for a still drawn below its natural size, where zooming reveals more; ‹ › sit at the edges for a fine pointer, in the bottom band for a coarse one (at the ends of a trailer's control row).
  - The index is clamped on read: a refresh can shrink the list under it.
  - The caption renders in its own effect (`renderLbCaption`): the position reads the table's `processedData()`, which recomputes on every streamed batch, and reading it in the main render would redo the whole imperative pass. `renderLightbox` reads the position `untrack`ed, for the alt text only.
- A pointer click on the panel hero's loaded picture grows it into the lightbox's (`openLightboxFrom`, through `morph`), the backdrop fading in under it (its own `lb-backdrop` name) in place of the lightbox's fade (`.lb-morph`); a key, a video or a picture still loading opens with a fade instead, the media growing from 96 %. Closing reverses it into the hero's picture when that's in sight (`closeLightbox`; `dialog.close()` runs inside the morph's update, so the old snapshot still has the lightbox), else the dialog fades out (`display`/`overlay` `allow-discrete`). No morph while presenting, nor under reduced motion.
- Every game step goes through `stepGameFromLightbox`, which puts focus back inside the overlay — the host's step opens the panel behind it, and `panelOpen` focuses the panel's hero, out of the focus trap.

`mediaItems.ts` builds the ordered media list and resolves a shot id to an index; the hero uses `meta.banner` (Steam's `header_image`, resolved server-side) once metadata loads, guessing the conventional CDN path only as a placeholder — that guess 404s for games on newer asset pipelines.

## The presentation window

A second window (`present.html`, its own Vite entry: `PresentationView.tsx`): a lightbox on another screen, showing the one media the main window last presented ([features.md](../user/features.md#presenting-on-a-second-screen)). It has no control but fullscreen.

- **Its own entry, not a route**: the SPA shell would bring the nav, the panel and `overlayHistory.ts`'s popstate listener; `PresentationView.tsx` imports neither `panel.tsx` nor `lightbox.tsx`, only `hlsPlayer.ts`, `presentationProtocol.ts` and `presentationScreen.ts`.
- **Its DOM is never rebuilt** (one `<img>`, one `<video>`, hidden in turn): the browser drops fullscreen when the fullscreen element leaves the document. A new media cross-fades in over a copied picture of the last (`.pres-ghost`), and its own darker glass backs its text.
- **The lightbox steers it** while presenting (`linked()` in `lightbox.tsx`: open, presenting, not private); the hero's open opens it, while P and the panel's cast button present the hero's media without it (`presentHero`).
  - A step is presented at once; a burst's later ones only where it stops, after a settle (200 ms a media step, 400 ms a game step: the TV's cross-fade), flushed by a close; nothing while a game's media are still loading (the `awaitingMedia` latch picks the landing item first), nothing for the item already on air. `present(…, { silent })`: the lightbox says it on its own status line, the shell's being inert under the modal.
  - A linked trailer is its poster in `.lb-img`, the `<video>` detached (one decoder, one sound). Its controls send `control`s and mirror `playback`, the time run on locally between reports (`lbTvClock`), one overlay at a time (failed, buffering, paused or ended, playing).
  - P toggles private (`privateMode` in `presentation.ts`, sticky across opens until P or the end of presenting), handing a locally played trailer back at its playhead. A trailer left private or by a lost TV waits, paused where the TV was (`lbHeld`).
- **Rejoining** (`rejoinTv` in `AppShell.tsx`, from the chip's open button and a key relayed from the TV): opens the panel on the on-air game (its game steps go through the panel's list), then the lightbox on the on-air item once loaded, which presents nothing new. The TV relays ←/→/↑/↓/Home/End/R and their release (`key`): the linked lightbox steps (`lightboxCommand`, shared with its own keydown), none open rejoins first, private only has the TV show its caption again (`caption`). Hidden under a fullscreen TV, main's timers are throttled: a relayed step goes on its release (`flushLbTv`).
- **The nav chip is the TV's remote** (`PresentationChip.tsx`), as is the linked lightbox: `control` messages (play, pause, replay, mute, unmute, retry, `seekBy` — applied to the TV's own position, so presses add up — and `seekTo`) go to the window, which answers `playback` (paused, muted, time, ended, failed, `needsClick`, `buffering`) on media events, seeks and stalls at once, its time once a second. It unmutes only after its own first click: Chrome pauses a video unmuted without one. The host's mute (chip, M) holds across media (`hostMuted`); the browser's — no click there yet — lifts on that click. `OnAir` carries the media's `label` and `spoken` form, computed main-side; each present is announced through `announce.ts`, as is a window lost without Stop.
- **Placing it on the TV** (`presentationScreen.ts`, Chromium's Window Management API, offered only when `screen.isExtended`): the first-click card's button asks the `window-management` permission (never on P: a prompt can outlast P's activation and block `window.open`), then `requestFullscreen({ screen })` onto the other screen and `moveTo` it (leaving fullscreen puts a window back where it was). A first grant spends that click's activation, so the button asks for a second one; granted already, one click does it. The screen is remembered (label and position: no stable id) and `present` opens the window there next time. Elsewhere, the drag.
- **The TV's look**: a lower third (name and `OnAir.label`, inside a 5 % title-safe margin) shown after the cross-fade, 5 s on a game change or a trailer's end, 2 s on another media of the game or a repeated P; a mouse move shows only the cursor. The cross-fade's ghost is a canvas copy of a trailer's current frame (a cross-origin one taints the canvas, which still draws). A stall shows the TV-sized spinner; a failure dims the picture under its message (Retry is the chip's or the linked lightbox's); `close` fades it to black, then it closes itself, main closing it 600 ms later only if it couldn't (still loading). Its own reduced-motion and forced-colours rules: base.css isn't loaded there.
- **The OS media keys** reach the TV's trailer (its Media Session metadata and play/pause handlers, set while it's up, kept through a pause, dropped when it ends): the host's one-press "wait!". A lightbox trailer played meanwhile takes them, as browsers give them to the last one playing. Checked by hand: a real media key (Chromium, Firefox); e2e calls the handlers.
- **The main window owns what's presented** (`presented()`, read by the nav chip): set on `present`, before the window even answers, so a second P can't `window.open` it again. `present` also sends to the window `window.open` returned while it's open, even after main forgot it (missed beats): reopening it by name would reload it out of fullscreen.
- **One `BroadcastChannel`, tagged with the main window's id** (`?main=` on its URL, kept in `sessionStorage` so a reload keeps driving the same window): another tab's window ignores it. Stop starts a new id, so a closing window's last `bye` and heartbeat go unheard. A duplicated tab copies `sessionStorage`, so both tabs drive the same window, which still closes with the tab that opened it.
  - Main → window: `onAir` (one `buildMediaItems` item, a plain object: store rows are proxies, which `postMessage` can't clone), `close` (it closes itself; Stop also closes it through `window.open`'s handle, which reaches a window still loading but not one opened before a main-window reload), `main` (back after a reload; it answers with its state at once, or a P before its next heartbeat would `window.open` it again, reloading it out of fullscreen), `bye` (on `pagehide`: the window closes unless `main` follows within 10 s, as a reload's does, a slow one included; `pageshow` from the bfcache says `main` again).
  - Window → main: `hello` (main re-sends what's presented, so a reloaded window resumes), `state` every 5 s as a heartbeat echoing what it shows (so a reloaded main window learns it) and whether it's `hidden`, also on `visibilitychange`, `bye` (forgotten after 2 s without a `hello`: a reload says both, in that order). Main forgets the window at once when `window.open`'s handle says `closed`, and in any case after 3 missed beats (a crashed TV stays open, silent), or 2.5 min if it last said `hidden` (occluded or minimized, its timers throttled to about a minute) — judged only while main is visible, its own timers throttled otherwise; `bye` alone misses a crash. It closes itself on a heartbeat once its opener is gone (Chromium nulls `opener`, others report it `closed`; a reload of main keeps it) — unverified: whether Chrome's Memory Saver discarding the main tab counts as gone.
- **Sound and fullscreen**: browsers may refuse an unmuted autoplay before a first click or key in that window (the main window's doesn't count; Chrome's media engagement often allows it), so a trailer tries sound first and, refused, plays muted through `playHls`'s `onMutedFallback`, a "Click for sound" pill saying so. That first click or key also enters fullscreen; later clicks never leave it (someone in the room clicking), double-click (not within 500 ms of the activating click) or F does.
- **A repeated onAir** (P on what's up) only wakes the caption, restarting nothing but an ended trailer; one handed over from the lightbox carries `startAt` (applied on `loadedmetadata`: loading the stream resets the position; on the trailer already up, at once) and `paused`, sent once and never kept in `presented()`, so a reload or a retry starts afresh. P again on what failed retries it.

## URL & sharing

- `?u=` — **one** slot: which account to show. Parsed and resolved once for the whole app by `AppShell.tsx`, read everywhere via `getEffectiveCurrentAccount()`, forwarded across in-app navigation by `withAccountParam`. Full semantics in [lists-and-accounts.md](lists-and-accounts.md).
- `?u=` repeated — **several** slots: a comparison, one `u=` per player, comma-joined identifiers within a slot for a Family (the old Comparison page's spelling). Not an account override, so nothing resolves it as one and `withAccountParam` doesn't forward it. `/lists/compare` is its address; `normalizeSlots`/`compareUrl` (`urlState.ts`) write it, canonicalized to server-resolved steam64 ids. `&op=` picks the combine op, omitted for the default.
- `?game=<appid>` / `&shot=<idx>` — which game the current list has open (`igdb%3A<id>` for a game outside Steam), and which screenshot; Recently Looked Up writes the game into its path (`/game/<appid>`) instead. Rewritten with `replaceState`; the one entry pushed per open overlay is `overlayHistory.ts`'s. `/game/:appid` is the canonical address for a game; the panel's 🔗 copy-link omits `?u=`, so a shared game link doesn't send recipients into the sender's account.
- `?tv=` — a shared table-view snapshot, consumed once on arrival (see the game table).
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

## Known gaps

- **A row opened before its list's price batch lands self-prices in the panel** — `priceSource` (`panel.tsx`) is still the appid then, so the panel's request duplicates the batch's (both server-cached).
- **Folder/list tree polish** — delete on Home uses a plain `window.confirm`; moving is a "Move to…" select in each row's ⋯ menu (`folderPaths`, leaving out a folder's own subtree), with no drag-and-drop, and there's no trash/restore UI for soft-deleted lists.
- **Per-account playtime in `group-by-membership` lists** — on a comparison, the "Owned by" card lists every owning player with their playtime (`createDefaultFetchers`' `onOwners`, served to the panel through the route's `getOwners`) and the table has one Played column per player; a saved dynamic list grouped by membership still shows only the current account's members, with no per-player columns.
- **`/bundles`' clock doesn't tick.** Its countdowns and buckets (`renderEnds`'s "⏳ in 6h", the Age/Ends in columns, the hero's New and Ending soon counts) are computed when the table processes its rows, not on a timer. A proper fix re-runs the whole sort/filter/render pass on a timer; ticking only the hero counts would make them disagree with the rows.
- **What a load snapshots doesn't follow the account live** — list labels (`createDefaultNaming`) and the Taste fit source are read when `ListRoute` loads, so a renamed persona shows on the next load.
- **`?game=` restore-on-reload is `ListRoute` and `SearchRoute` only** — Home/`/bundles`/`/about` register no route handler with the shell and `RankRoute` registers only `refreshGame`, so `/?game=440` doesn't reopen. Rarely reachable: a lookup from those routes goes to `/game/:appid`.
- **No cross-tab sync** — see [lists-and-accounts.md](lists-and-accounts.md).
