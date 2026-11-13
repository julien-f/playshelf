# Lists & accounts

The data model the frontend is built around: everything the app shows (an account's owned games, its wishlist, a bundle, a saved comparison) is a **list of appids**, rendered through one generic viewer ([frontend.md](frontend.md)'s `ListRoute.tsx`). Game display data (rating/HLTB/tags/price) is never stored on a list; it's resolved live via `game-details/stream`, keyed by appid.

Accounts, lists, folders and preferences live in `localStorage` (`prefs.ts`). Signing in with Steam optionally syncs them to the server (see [Sync](#sync)); localStorage stays the source every read goes through.

- [Accounts](#accounts)
  - [`?u=` URL semantics](#u-url-semantics)
- [Lists](#lists)
  - [Kinds](#kinds)
  - [Ranked lists](#ranked-lists)
  - [Combine](#combine)
  - [Folders](#folders)
  - [Soft-delete](#soft-delete)
- [Sign-in](#sign-in)
- [Sync](#sync)
- [Storage schema](#storage-schema)

## Accounts

Two account slots, both optional, distinct from any list:

- **`myAccount`** — "this is me", a pinned default identity, set by starring (★) any entry in the account picker. Home's lookup stars the very first account it resolves (none starred or current yet), signing in its account while none is starred; one reached by a `?u=` or compare link never is.
- **`currentAccount`** — whoever is being explored (may be `myAccount`, someone else, or empty). Drives the account header and the Owned/Wishlist system lists.

Both are full `AccountSlot` objects (see the schema below), not id references, so clearing history never orphans either.

- **Picking `currentAccount`** draws from `myAccount`, `recentAccounts`, or a fresh resolve. The resolve form takes several identifiers at once ("Add Steam Family account") and produces one `AccountSlot` with several `members`: a Family.
- **`recentAccounts`** is global and uncapped, with individual removal and clear-all. Read in one order everywhere (`getRecentAccounts`): `myAccount` first, then by display label (case- and accent-insensitive, ties by id) — a fixed place per account rather than most-recently-used. Removing one a dynamic list still references soft-removes it (`removedAt`, see [Soft-delete](#soft-delete)).
- **Account header**: avatar, persona name and profile link, online status (as of the last library refresh), owned and wishlist counts.
- **Display fields stay current**: `label`/`avatarUrl`/`vanities` are captured when the account is picked; Home's account card refreshes them wherever the account is stored (`refreshAccountInfo`) from the profile it fetches anyway, and so does opening a saved list, for each account whose Owned it resolves (`createDefaultFetchers`' `onPlayers`).
- **Copyable identifier**: ⧉ copies each member's nicest identifier (`accountsStore.ts`'s `accountIdentifiers`): its Steam custom-URL name (`AccountSlot.vanities`, captured at resolve time from `/api/common-games`' `profileurl`), else its steam64 id. One per member: a Family's joined label is nothing an input accepts back. Offered wherever an account is named (account card, the nav chip and its recents), with no fetch.
- **Fetched once per account**: Home, the Owned/Wishlist lists, a comparison and the ✓/☆ markers share each account's fetches (`accountData.ts`, [data.md](data.md#refresh-paths)), so switching back to an account or opening its list after Home costs no request; a ↻ anywhere replaces them, and the ✓/☆ markers follow.
- **Reactive**: changing `currentAccount` while `/lists/owned` or `/lists/wishlist` is open re-fetches that route in place: its load effect reads the account reactively.

### `?u=` URL semantics

`?u=` is a **URL override**, never adopted (unlike `?tv=`, which is consumed). `accountOverride.ts` parses and resolves it into `accountsStore.ts`'s in-memory override slot; `getEffectiveCurrentAccount()` (override ?? stored) is what every reader of "the current account" calls. Only Home's account picker deals in the stored one directly.

- **Wins everywhere it's read** (Home's account card, `/lists/owned`, `/lists/wishlist`, ownership markers via `myOwnership.ts`) but never overwrites the stored preference and never lands in `recentAccounts`: browsing from a link isn't picking an account.
- **Resolved once for the whole app** by `AppShell.tsx` (an effect on `location.search`). `syncAccountOverrideFromUrl` is keyed on the identifiers, so an unrelated param write (`?game=`, `&shot=`) costs no re-resolve.
- **Forwarded across in-app navigation** (`withAccountParam`, `urlState.ts`): nav links, Home's fixed list links, `ListRoute`'s own `navigate()` calls and the panel's ownership badges carry it, or clicking "Owned" would quietly switch back to your own library. The panel's 🔗 game link deliberately doesn't: it's the game's canonical address, for anyone.
- **Authoritative on `/lists/owned`/`/lists/wishlist`**: while it resolves, and if it fails, the stored account is not loaded in its place; the route shows the override's status instead.
- **Adopted only explicitly**: "Set as my current account" in Home's "Exploring … from this link" note, or any account pick, stores it and strips `u=` via the router's `navigate(..., { replace: true })` — a bare `history.replaceState` is invisible to `@solidjs/router`'s location signal, leaving `withAccountParam` hrefs pointing at the old account.
- **Several slots is a comparison, not an account** (`?u=alice&u=bob`): `parseAccountParam` returns nothing for it, so it's never an override and never forwarded. Its address is `/lists/compare` ([Combine](#combine)); Home forwards `/?u=alice&u=bob` there, so links to Home's comparison keep working.

## Lists

A list is a set of appids, usually named — a dynamic one may have no name of its own (see [Combine](#combine)).

### Kinds

- **System lists** (never stored, always live-derived): _Owned_ and _Wishlist_ for `currentAccount`; one per browsed _Bundle_; one per developer or publisher (`/lists/developer?name=`, `/lists/publisher?name=`; `ListRef.kind: 'developer' | 'publisher'` with its `name`, joining a combine from its own page like a bundle); **Recently Looked Up** (`/game`, `recentGames.ts`) — global local search history, not account-scoped, an Explore card on Home beside Owned/Wishlist/Compare/Bundles and usable as a combine source (`ListRef.kind: 'recent-games'`); **PC Game Pass** (`/lists/game-pass`, `gamePassData.ts`) — the Steam games in the region's PC Game Pass catalog, an Explore card and a combine source (`ListRef.kind: 'game-pass'`), reloaded on a region change; a failed catalog fetch fails the list (no snapshot, unlike a bundle).
- **User lists** (stored, full CRUD):
  - **`manual`** — a stored `appids[]`; games are added from a table's row selection ("Add to list", including a new list) and removed per row or in bulk.
  - **`dynamic`** — a formula (`op` + `sources: ListRef[]`) recomputed on every open, stated in its hero ([game-table.md](game-table.md#other-kinds)). Its Updated tile states the oldest account, store-search or PC Game Pass fetch behind it and re-resolves them all (`createDefaultFetchers`' `refresh`/`onFetchedAt` — on the real wiring, not the injectable `ListResolveFetchers` seam the resolver's tests use). "Edit sources" reopens the combine form pre-filled and saves in place.
  - **`ranked`** — one `source: ListRef`, ordered by one-vs-one answers. Resolves to its source's appids; `ListRoute.tsx` applies the order as a Rank column.

### Ranked lists

- **Algorithm** — `ranking.ts`: binary insertion over tie groups (`groups: number[][]`, best first), ⌈log₂(k+1)⌉ answers per game against k groups. Pure, a new state per step; the compare screen's undo is a stack of states.
- **Re-rank** — `rerank()` stores a `hints[appid]` anchor (a game it was tied with, else the one below, else above). The next insertion asks the anchor's group first, gallops away (`cursor.gallop`: 1, 2, 4… live groups) until an answer turns back, then bisects: ~2·log₂(distance) answers. A missing/out-of-source anchor falls back to bisection; `progress()` counts ~2 per hinted game.
- **Answers** — prefer candidate/opponent, tie (joins the opponent's group), skip (to the back of `skipped`), exclude either side.
- **Focus and order** — `nextPair`/`answer`/`progress` take optional `RankingOptions`: `focus` ("Rank N game(s)" on a selection or filter, the Continue button's "Rank N shown") limits the candidates, `order` (the table's sort — unranked rows of `processedData()`) asks those first, then the rest in source order. Opponents are still picked by binary search, so the final order is unaffected. Both reach `/lists/:listId/rank` as router history state (`rankFocus`/`rankOrder`), not in the URL.
  - The compare screen stores an incoming focus on the ranking (`RankingState.focus`, `withFocus`), so a later visit resumes on it; `pendingFocus` says whether any is left, a used-up focus is dropped on the next visit, "Rank all instead" clears it, a new selection replaces it.
  - While it lasts, the list page shows "Continue: N chosen left" and measures its Ranked tile against it. A mid-way insertion of a game outside the focus is dropped and restarts later.
- **Progress is its own pref key, `ranking:<listId>`** — `{ groups, excluded, skipped, hints?, cursor?, focus? }` (`cursor`: the game mid-insertion, its `lo`/`hi` gap and optional `anchor`/`gallop`; `focus`: see Focus and order). Kept off the `lists` blob since it's written once per answer; its server push is debounced (see [Sync](#sync)). Set to `null` when the list is hard-deleted.
- **Never pruned to the source** — games outside the current source are filtered at read time (`ranks`/`progress`/`nextPair` take the resolved source set), so a source that briefly fails, or a "Change source" and back, loses nothing. Binary search runs over _live_ groups; `cursor.lo/hi` index the stored `groups`.
- **UI** — `/lists/:listId/rank` (`RankRoute.tsx`) asks the pairs; the list page adds the Rank column (default sort), a Ranked tile with the remaining-comparisons estimate, "Change source" and Re-rank/Exclude row actions. "🏆 Rank this list" (owned/wishlist/bundle/PC Game Pass/user lists, `rankSourceRef`; not compare, shared, developer/publisher or Recently Looked Up, which have nothing stable to point at) creates one and passes `rankOrder` plus `rankFocus` (the selection, else the filtered rows when a filter hides some). "Continue ranking" does the same over unranked, non-excluded rows. Once a list has rankings, "🏆 Rank this list" becomes a menu of them (`rankingsOf`) plus "+ New ranking", named by an optional criterion.
- **Side panel** — the compare screen opens the shell's panel (`panelOpen`) with the details it already fetched and closes it once that game leaves the pair. Its key listener runs in the capture phase, ahead of `panelKeyboard.ts`: an armed I/X + ←/→ wins (`stopImmediatePropagation`), plain ←/→ go to the panel's media while it's open, Esc leaves the screen only when no panel/dialog is open. `urlState.ts`'s param rewrites keep `history.state`, so `?game=`/`&shot=` don't drop `rankFocus`.
- **Not shareable** — Share list is offered on dynamic lists only (`ListRoute.tsx`'s `shareFailure`), and `listShare.ts` rejects a ranked `user` source (`'ranked-source'`): the grammar has no token for an order.
- `listDeps()` (`listsStore.ts`) is what cycle detection and the referenced-by checks walk: a dynamic list's `sources`, a ranked list's `[source]`.

### Combine

Home's combine form (`CombineForm.tsx`) picks 2+ source lists and an operation, then saves a dynamic list:

- `union`, `intersect`, `subtract` — a flat list. Order matters only for `subtract` (first source minus the union of the rest, `combine.ts`); the form tracks pick order and shows it as a numbered, reorderable (▲▼) list while `subtract` is selected.
- `group-by-membership` — rows grouped by which combination of sources each game belongs to. N accounts' Owned lists combined this way is a library comparison.

Unsaved combined lists, viewed live with "Save as a list", come from `/lists/compare`, `/lists/shared` and a bundle's "What does this add?".

**Naming is optional for a dynamic list.** Unnamed, it's labeled by its formula everywhere (tree, hero, `<title>`, another list's formula — `listLabels.ts`'s `listDisplayName`, falling back to `formatFormula`), derived on every read so it follows a source edit or an account rename. The form previews the label; a derived label renders dimmed/italic (`.derived-name`). As a source it's parenthesized (`(Alice — Owned ∪ Alice — Wishlist) ∩ Bob — Owned`), one level deep; deeper reads "Untitled combined list".

**Comparing libraries — `/lists/compare?u=alice&u=bob`.** A dynamic list that was never saved: the URL's player slots are its formula (one `account-owned` source each), built in memory and resolved through the same path as a stored one. "Save as a list" is one `createList` call with that formula, named as the page was ("Alice vs. Bob"); renaming an account later doesn't rename it. Saving keeps each player as a hidden account (`keepAccountForLists`, see [Soft-delete](#soft-delete)) so the formula and group headings name them; Edit sources doesn't offer such a player's other lists. Machinery (canonical URL rewrite, player form, ordering) is in [game-table.md](game-table.md#comparison).

- Slots are resolved by the route and **never land in `recentAccounts`** — comparing someone isn't picking them, the same rule as a `?u=` override.
- The players form (`ComparePlayersForm.tsx`) offers `getRecentAccounts()` (which already includes `myAccount`/`currentAccount`, both upserted into recents) plus a `?u=` link's account, listed first, when one is being explored.

**Sharing a dynamic list — `/lists/shared?f=<formula>`.** The same idea for any dynamic list's formula (owned/wishlist/bundle/developer/publisher/recent-games/game-pass/nested user-list sources, any op): encoded into a compact URL grammar (`listShare.ts`) and resolved in memory on arrival. A `user` source pointing at a _manual_ list has no token in the grammar, so the hero's "🔗 Share list" is disabled with a tooltip. Grammar and nesting: [frontend.md](frontend.md#routes).

`ListRef`s into account-scoped system lists (`account-owned`/`account-wishlist`) always pin an explicit `accountId`, so a saved "Alice ∩ Bob" keeps meaning that whatever `currentAccount` becomes.

**Cycle detection**: saving or editing a dynamic or ranked list walks the full dependency graph (`wouldCreateCycle`) and refuses a save that would introduce a cycle (A←B←A), rather than truncating one at resolve time.

### Folders

User lists (not system lists or bundles) live in a folder/list tree on Home, arbitrarily nested:

```
Folder { id, name, parentId: string | null, order }
GameList { ...above..., parentId: string | null, order }
```

- Flat arrays keyed by `parentId`: rename and move are single-item mutations. Folders and lists share one `order` numbering per `parentId`, so they interleave; a moved or new item goes last (`nextOrder`).
- Create and rename use one inline name field in the tree (Enter or leaving it saves, Esc or an empty name cancels; clearing a dynamic or ranked list's name hands it back to its default label), delete `window.confirm` (an empty folder goes without asking); moving is a "Move to…" select in each row's ⋯ menu (`folderPaths`, leaving out a folder's own subtree, which `isDescendantFolder` also refuses). No drag-and-drop, multi-select or trash view (U236).
- Deleting a non-empty folder asks whether to delete everything inside or move its contents up (`deleteFolder`'s `'delete'`/`'promote'`); delete applies [Soft-delete](#soft-delete) to each list inside.

### Soft-delete

- A `GameList` or `AccountSlot` still referenced by a dynamic or ranked list is stamped (`deletedAt`/`removedAt`) instead of deleted: hidden from the tree, pickers and recents, but still resolvable. Deleting such a list says it was hidden instead. There's no restore UI.
- **An account a saved list names but nobody picked** (a compared player, a `?u=` link's account behind a ranking or a combine) is stored the same way, hidden, so the list names it (`accountsStore.ts`'s `keepAccountForLists`): on saving a comparison, and on opening any saved list whose `account-owned` source isn't stored — which also restores one another device's `recentAccounts` push dropped (last write wins on the whole key). An account used only by a Wishlist source stays named by its steam64 ids (U247).
- **Sweep**: `deleteList`, `updateDynamicList`, `updateRankedSource` and `orphanBundle` purge soft-deleted items nothing references any more, repeated until nothing more goes, then prune the bundle snapshots and soft-removed accounts no list uses. A soft-deleted list still counts as referencing its sources, since it still resolves.
- **A referenced bundle disappearing** (ITAD stops listing it after it ends; `GET /api/bundles/:id` 404s): `bundleSnapshots.ts` keeps each referenced bundle's last-known title and appids, refreshed when a resolve succeeds in full (`listResolve.ts`'s `resolveBundleSource`). On the 404, `listsStore.ts`'s `orphanBundle` turns the snapshot into a soft-deleted manual list (`orphanOf: { bundleId }`, "<title> (no longer listed)") and re-points every source at it. Any other failure falls back to the snapshot without converting, and fails the list when there is none; a 404 for a bundle with no snapshot contributes nothing.

## Sign-in

Sign in with Steam (`lib/auth.js`, the `/auth/*` routes in `server.js`) is Steam's OpenID 2.0, its only sign-in for third parties. Off without `PUBLIC_ORIGIN` ([configuration.md](../user/configuration.md)): the routes answer 503 and the startup log says why.

- **`GET /auth/steam/login`** first moves a visitor on another host to `PUBLIC_ORIGIN`'s, where Steam sends them back; there it sets a random `steam_login_state` cookie (5 minutes) and redirects to Steam with that state inside `openid.return_to`.
- **`GET /auth/steam/callback`** accepts the assertion only when:
  - its `state` matches the cookie — login CSRF, which would sign a visitor in as someone else;
  - the signed `return_to` is the one sent for `PUBLIC_ORIGIN` and that state, never the request's `Host` — else any site using Steam sign-in could replay its visitors' assertions here;
  - its `response_nonce` is within `NONCE_MAX_AGE_MS` of this clock and unused this process run (a drifting clock refuses every sign-in, with an `[auth]` warning);
  - Steam confirms the signature (`check_authentication`).
  - Then it records the user, opens a session and redirects Home; a refusal clears the state cookie and answers 400, an unreachable Steam 502.
- **Cookies** are `HttpOnly; SameSite=Lax`, and `Secure` when `PUBLIC_ORIGIN` is `https` — the scheme visitors see, while the request's own is the proxy hop's without `TRUST_PROXY`.
- **Sessions**: a random id in the `sid` cookie, kept in `sessions` by its SHA-256, so a copy of `db.sqlite` signs no one in. One lasts `SESSION_TTL_DAYS`; `GET /api/me` slides it forward to the full length once half is gone, with no absolute cap: accepted, as a session only reaches synced prefs. Expired rows are swept at startup and hourly; `POST /auth/logout` deletes the session.
- **In the browser** (`authStore.ts`): the account chip's popover (`AccountChip.tsx`) links to the login; `initAuth` asks `GET /api/me` on every page load, then merges prefs ([Sync](#sync)).
- **Signing in fills `myAccount`/`currentAccount` when unset** (`autoPopulateAccountFromLogin`), via the same `resolveAccountSlot` as Home's picker; an existing pick is never overwritten, and a failed resolve retries on the next load.
- **An expired sign-in shows** (`authStore.ts`'s `isSessionExpired`): the `steam.isonoe.net:signed-in-as` localStorage key (its own, never synced) holds the steamid last signed in on this browser; signed out by a check or a 401 while it's set puts an amber dot on the account chip and **Sign in again** / **Stay signed out** in its popover. Sign out and Stay signed out clear the key; an `/api/me` that fails (offline, 5xx) never sets it.
- **Sign out sends pending pushes first**, then logs out, so a debounced edit still reaches the account.

## Sync

Signing in (the account chip's popover, `AccountChip.tsx`) is optional; without it nothing is sent. Signed in, the server holds a second replica, kept eventually consistent; routes in [architecture.md](architecture.md), the `user_prefs` table in [data.md](data.md).

- **Per key, with its own `updatedAt`** (`prefs.ts`'s storage format; `getPref`/`setPref` callers never see it). `setPref` pushes the changed key to `PUT /api/me/prefs/:key`, never a whole blob, so keys changing on different tabs/devices can't clobber each other.
  - `lists`, `ranking:<listId>`, `recentGames` and `gameStatuses`, written on every view change, answer, lookup or status, push after a 3 s pause instead (`DEBOUNCED_PUSH_PREFIXES`; flushed with `keepalive` when the tab is hidden), since `PUT /api/me/prefs/:key` is rate-limited (`PREFS_RATE_LIMIT_MAX`, [default.env](../../default.env)).
- **The server always accepts a write** (`setUserPref`, `lib/auth.js`); `updatedAt` is stored for display, not a write guard — the client already decided this write wins. It refuses only a key outside `public/syncedPrefKeys.ts` (a new synced key goes there and in `lib/auth.js`'s copy, `isSyncedPrefKey`) and a write taking the account past `PREFS_MAX_BYTES`; a refused push leaves the change on that device.
- **Every sign-in check merges** (`authStore.ts`'s `syncPrefsWithServer`, from `initAuth` on every page load):
  - **First sync of a device with an account** (no `steam.isonoe.net:prefs-synced:<steamid>` localStorage flag — its own key, never synced, so an adopted blob can't carry it): server wins for every key both sides have, whatever the timestamps (a new device's local state may be leftover anonymous browsing); keys only local are pushed.
  - **Every later sync**: per-key last-write-wins both ways; a key on one side propagates; a tie is left alone.
  - One key is one value: concurrent edits to it on two devices keep the newest whole, `lists` and `listViews` alike (two views added at once on two devices: one is lost).
  - Adopting anything from the server reloads the page: `getPref`'s readers follow an adopted key, but not those that copy it at load ([below](#storage-schema), U274). An adoption storage refuses (full, disabled) is skipped with an `[auth]` warning instead, or every load would re-adopt and reload.
- **Table-view keys sync like any key** (`TABLE_VIEW_PREF_KEYS`, `public/tableViewKeys.ts`). They're written only on **Save** (a table change is a draft until then, [game-table.md](game-table.md#layouts-and-saved-views)), so each push is one.
  - A schema v2 blob's table-view keys read as `updatedAt: 0`, so the account's saved layout wins at the next sync: v2 wrote them on every edit and never pushed them.
- **A push answered 401** (the session ended while the page was open; `prefs.ts`'s `sessionLost`) signs out on the spot and drops pending pushes: each edit's local `updatedAt` stays newer than the server's, so the next sign-in's merge pushes it. Two limits:
  - signing back in as another Steam account is that account's first sync on this device, so its values win over those edits;
  - another open tab keeps its own state until it reloads.
- **An adopted entry with the same value** as this device's (another device pushed it) only takes the server's `updatedAt`: no reload.
- **A user list's view is not a table-view key**: it is the list's own `tableView`, saved into `lists` on **Save** (`setListTableView`, minus `page`/`searchQuery`).

## Storage schema

One flat blob under the localStorage key `steam.isonoe.net:prefs` (`prefs.ts`): a top-level `schemaVersion` and one `{ value, updatedAt }` entry per key. A v1 blob (raw values) is read as entries with `updatedAt: 0`, older than any real write. The interfaces are declared in `public/types.ts`, the source of truth; at a glance:

```
AccountSlot  id (sorted-joined member steam64 ids) · members[] · rawInputs[] · label? · avatarUrl?
             vanities? (steam64 → Steam custom-URL name, for the members that set one)
             memberAvatars? (a Family's steam64 → avatar; stored on pick, and on opening it on Home when missing)
             removedAt?
Folder       id · name · parentId (null = root) · order
GameList     id · name? (absent = unnamed, labeled by its formula) · parentId · order · createdAt · updatedAt
             orphanOf? { bundleId } (a bundle's last-known games — see Soft-delete)
             kind 'manual'  → appids[]
             kind 'dynamic' → op + sources[] (ListRef)
             kind 'ranked'  → source (ListRef); progress in pref key ranking:<id>
             tableView? · deletedAt?
ListRef      kind 'account-owned' | 'account-wishlist' | 'bundle' | 'recent-games' | 'user' | 'developer' | 'publisher' | 'game-pass'
             accountId? (pinned explicitly, never "whichever is current") · bundleId? · listId? · name?
```

Pref keys: `schemaVersion`, `myAccount`, `currentAccount`, `recentAccounts`, `region`, `lists`, `folders`, `listViews` (`{ owned?, wishlist? }`: `SavedView[]` each — `id` · `name` · `tableView` · `template?` — for whichever account is current, never a list or combine source), `recentGames`, `gameStatuses` (appid → `f` finished / `a` abandoned, one flat map for whoever uses the browser — not per account: a Family's or solo slot's id would split it; shown where `accountsStore.ts`'s `showingMyAccount` says the account on screen is theirs), `ranking:<listId>`, `bundleSnapshots`, the table-view keys above (which instances share one: [game-table.md](game-table.md#layouts-and-saved-views); a user list keeps its own `tableView`).

Outside the blob: `steam.isonoe.net:taste:<accountId>` (`tagTaste.ts`'s `Taste`: play profile, the library's tag rarities and each owned game's top 10 tags — ~325 KB for 1,000 games), rewritten each time that account's Owned list finishes loading and read by every list's Taste Fit and the panel's similar owned games. A device-local cache (`tasteCache.ts`): never synced, and kept out of the blob that every pref read parses.

Also outside it, device-local: `steam.isonoe.net:lightbox-hint-seen`, set once the lightbox's one-time hint has shown, `steam.isonoe.net:lightbox-muted`, the viewer's own trailer mute, and `steam.isonoe.net:presentation-screen`, the screen the presentation window was last placed on.

- **Bounded**: at most `TASTE_CACHE_MAX` tastes; saving one evicts the oldest (`at`, the last Owned load), never the ★ or current account's. An evicted account's Taste Fit asks to open its Owned again.
- **Evicted first when storage is full**: a write that hits the quota (`QuotaExceededError`) evicts tastes oldest first until it fits — a pref write any taste, a taste write any but the ★, current and its own — and puts them back if it never does. A `setPref` write that still fails isn't pushed to the server either (the edit snaps back), warns `[prefs]` and shows a banner ([frontend.md](frontend.md#shell)).

**Two open tabs** share the blob, and no edit is lost: `getPref` re-reads it whenever its string changed, and every mutation reads the current value before writing.

- A `storage` event from another tab reruns the readers of each key it changed (`prefs.ts`): the region, the accounts, a game panel's lists follow it on screen.
- Readers that copy a pref at load wait for a reload (U274): an open list's rows, Home's list tree, a table's layout.
