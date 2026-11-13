# Plan — focus hand-off, private profiles, per-comparison draft

Branch `focus-and-privacy` (worktree via `node scripts/worktree.js focus-and-privacy`), one commit per item, `--no-ff` merge with one CHANGELOG entry per user-visible fix. Machine is shared: one e2e suite / browser at a time, so items run sequentially (no BATCH lanes).

Items: U254, U194, U169, U182 (focus dropped to `<body>`), U256 + U267 (private profile in A1/A4), U258 (comparison draft).

## 1. Shared focus hand-off (commit 1, then one commit per item)

Rule: ui-guidelines.md Keyboard — "removing the focused element moves focus to its nearest equivalent". Today each site hand-rolls it (`StorageFullBanner.tsx` returnTo, `ListRoute.handleAddSelectedToList`, `openSavedList`, `bundleStepFocus`).

New `public/focusHandoff.ts`:

```ts
// Runs `change`; if focus was inside `from` and the change left it on <body> or a detached
// element, focuses the first candidate still on the page.
export async function keepFocus(
  from: Element | null | undefined,
  change: () => void | Promise<void>,
  ...candidates: Array<() => HTMLElement | null | undefined>
): Promise<void>;
```

- Captures `from.contains(document.activeElement)` before `change`; after it (awaited, Solid updates synchronously in handlers) checks `document.activeElement` is body or `!isConnected`; picks first `candidate()` that is connected; last resort `main.app-content`.
- Does nothing if focus moved elsewhere meanwhile (user clicked/tabbed away during an async change).
- Unit-testable with a tiny DOM stub? `npm test` is node without jsdom → covered by e2e per site instead; the helper stays ~15 lines.

Sites:

- **U254** `UnsavedChangesBanner` (TableViewControls.tsx): Save/Discard wrap their callbacks in `keepFocus(bannerEl, …, shareLayoutBtn, firstToolbarControl)`. The banner gets a ref; candidates passed from ListRoute as a prop `focusAfter: () => HTMLElement | null` (toolbar's Share layout, else the toolbar's first button).
- **U194** selection bar (ListRoute.tsx ~4578): Exclude, Remove from this list, Clear selection, Re-rank go through `keepFocus(barEl, action, nearest remaining row, first row)`. "Nearest": the first visible row after the first acted-on row's index, via `focusGameRow`-like lookup (rows removed by Exclude/Remove aren't candidates). Add's existing hand-off moves onto the helper (same candidates, its visible-row preference kept).
- **U169** panel achievements (panel.tsx ~1375): reveal → `keepFocus(button, reveal, nextSpoilerButton, revealedRow)`. Revealed row gets `tabindex="-1"` only so it can take focus (not a tab stop).
- **U182** nav search (gameSearch.ts ~307): second Esc no longer `blur()`s; it hands focus to where it came from (record `relatedTarget` on the input's `focus` — covers `/` and click and Tab), if still connected, else `main.app-content`. Not via `keepFocus` (no removal), but uses its fallback lookup (exported `focusFallback(...)`).
- `StorageFullBanner` Dismiss migrates onto `keepFocus` (same behaviour, one copy). `openSavedList`/`bundleStepFocus` stay: they span a navigation, not a removal.

Tests: one e2e per item (keyboard path: Enter on the control, assert `document.activeElement` is the expected element, not body), in `e2e/scenarios.spec.ts` beside each journey's tests. Mouse path for U254 (item says mouse too).

Docs: ui-guidelines.md Keyboard bullet names the helper ("use `keepFocus`"); frontend.md module map gains `focusHandoff.ts`.

## 2. U256 — private library named, with the fix

- **Server** (`server.js` `/api/common-games`, `lib/steam.js getOwnedGames`): `getOwnedGames` throws its clientError with `privateSteamId` set. The route runs libraries with `Promise.allSettled`; on such a rejection it awaits the summaries (already in flight) and throws `clientError("Frank's games aren't public on Steam — in Steam, Edit Profile → Privacy Settings → Game details: Public.")`, with the persona name, falling back to the id if summaries failed. Body gains `account: { steamid, name }` beside `error` (400), so the client can name the slot.
- Not cached differently: the private miss already caches per `games:` key as before (check: does cachedFetch cache a thrown clientError? if not, unchanged).
- **Client**: `fetchJson` copies an error body's `account` onto the thrown Error (`err.account`). Compare's failed-slot title (ListRoute ~2446) uses `err.account?.name` over the typed input. Home's `resolveError` shows the message as-is (now named).
- mock (`e2e/mockApi.ts:374`) answers the same shape.
- Tests: unit test on the route's error (test/ server tests with mocked upstream, as existing common-games tests do); e2e A1 edge for Home's message and C1 for Compare's h1.
- Glossary check for wording ("games", not "library"; U263).

## 3. U267 — private friends list

`AccountFriends.tsx:102`: a single-member account → "{accountLabel}'s friends list is private on Steam — in Steam, Edit Profile → Privacy Settings → Friends List: Public." A Family keeps the per-member count wording (glossary: member is right there) plus the same where-to-set hint. e2e A4 edge. Mock: a fixture with a private friends list exists? (`unavailable` in mock) — add if missing.

## 4. U258 — draft per comparison

`ListRoute.storedLayout()`: for `kind === 'compare'` the draft id becomes `viewPrefKey() + ':' + <op>|<sorted account ids>` (from `compareAccounts()`, set before the table build). Saved layout (pref) stays shared across comparisons — only the unsaved draft is per comparison. sessionStorage, tab-scoped, so stale per-comparison drafts die with the tab. e2e C1 edge: filter in A/B/C unsaved, open A/B/D → no banner, all rows; back to A/B/C → draft still there.

## Out of scope

- U257, U259, U261 (other Compare items), U224 (focus on open), U179, U245, U263, U181.
- A clickable link to Steam's privacy settings page (text path only).
- Linting or auditing all other focus-removal sites beyond the four items + StorageFullBanner.
- C174 (folding compare into shared lists), C175 (★ account).

## Revisions after review (round 1: frontend, backend, UX — all blocking changes applied)

Focus:

- `keepFocus(from, change, ...candidates: Array<() => boolean>)`: each candidate focuses and reports success (reuses `focusGameRow`'s scroll; candidates skip elements failing `checkVisibility()` via a `focusVisible(el)` helper). Sync unless `change` returns a promise. Focus-in-`from` captured before `change`.
- U254: `UnsavedChangesBanner` takes a required `focusAfter` candidate; passed by ListRoute and BundlesBrowseRoute. `SharedViewBanner`'s keep/discard (same bug, same component pattern) get the same.
- U194: Clear selection / Exclude → a visible selected row (Add's rule, shared), else first row; Remove → nearest remaining row by index captured before the change. Re-rank and "Rank N selected" navigate to RankRoute: fixed there — RankRoute focuses its first choice on mount when focus is on `<body>`.
- U169: revealed row first (ref on the persisting `<li>`, focus `firstElementChild`, `tabindex=-1`); no next-spoiler jump.
- U182: recorded `relatedTarget` used only if connected and not a text entry; else `main.app-content`.

U256:

- `getOwnedGames` tags its private clientError (`privateSteamId`); not cached (createCachedFetch caches only resolved loads), so a retry after the fix reaches Steam.
- Route: one `Promise.allSettled([summaries, ...libraries])`; any non-private rejection rethrown first as-is; else every private member named: "Frank's games aren't public. In Steam: Edit Profile → Privacy Settings → My profile and Game details: Public." (several: "Frank's and Gina's games aren't public…"); id when summaries failed.
- Error carries `accounts: [{ steamid, name }]`; `sendRouteError` spreads a client error's `body` into the reply. `ApiError` gets a typed optional `accounts`. Compare h1 and banner label use the name for a single-member slot; a Family slot keeps its typed label.
- A static "Steam privacy settings ↗" link (`https://steamcommunity.com/my/edit/settings`) after the message on Home and Compare when `accounts` is set, and in U267; one shared component.
- Tests: server.test.js private case (name, id fallback, two private, private + 5xx → 502), mock shape, accountData test.

U267: "Dave's friends list isn't public. In Steam: Edit Profile → Privacy Settings → Friends List: Public." + link; a Family keeps the count wording plus the hint.

U258: key `compareListView:` + sorted `compareAccounts()` ids (no op). Update game-table.md's drafts line and `viewPrefKey`'s comment.
