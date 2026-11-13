# Improvements

UX backlog from `ux-review` runs against [journeys.md](journeys.md) and [ui-guidelines.md](ui-guidelines.md); last run 2026-10-23. Each item names the scenarios it blocks or slows; a dedicated run per item re-walks those scenarios. Severity: **blocker** (goal unreachable) · **major** (reached with confusion or a workaround) · **minor** · **polish**. Fix items with the `ux-fix` skill; remove an item once it ships.

- [Sharing](#sharing)
- [Loading and feedback](#loading-and-feedback)
- [Lists and selection](#lists-and-selection)
- [Taste profile](#taste-profile)
- [Comparing](#comparing)
- [Bundles and prices](#bundles-and-prices)
- [Phone](#phone)
- [Accounts and first visit](#accounts-and-first-visit)
- [Consistency and polish](#consistency-and-polish)
- [Review tooling](#review-tooling)
- [Not yet reviewed](#not-yet-reviewed)

## Sharing

- **U172 · minor · S3, B1, I3** — a dead link to a list (`/lists/<unknown id>`) or a bundle (`/lists/bundle/<unknown id>`) shows one bare status line: no h1, no way back, and the bundle's reads "Error: Bundle not found". Page not found has a heading and Go to Home; give these the same, with All bundles for a bundle.
- **U229 · minor · R3, L1, S1** — manual and ranked lists can't be shared by link ("my top 10 co-op games"); the share grammar has no token for a list of appids or an order ([lists-and-accounts.md](lists-and-accounts.md#ranked-lists)). A snapshot token (appids in order), read-only on arrival. From the Backloggd study (2026-10-30).
- **U239 · polish · S3** — a reload with `?game=` reopens the game only on list routes and `/search`: Home, `/bundles` and `/about` register no route handler with the shell and the rank screen only `refreshGame`, so `/?game=440` doesn't reopen. Rarely reachable: a lookup from those routes goes to `/game/:appid`.
- **U240 · polish · S1, S2** — link previews have no `og:url` or `<link rel="canonical">` (without `game`/`shot`/`tv`), no card for `/lists/shared?f=` ("A combined Steam list") or `/search?q=`, a `?game=` card only on `/lists/*`, and `/index.html` and `/present.html` are served as static files without tags.
- **U241 · polish · S3** — a copied `/lists/owned?view=<id>` link tells the recipient "This view no longer exists", as if deleted, though it was never in their browser. Say it isn't saved in this browser, like the user-list message.
- **U242 · polish · Y1, S3** — a missing list says lists "live in the browser that created them", wrong for a signed-in user whose lists sync: a second device opening the link before the first sync lands is told it doesn't exist. Wait for the first sync, or reword.
- **U243 · polish · Y1** — on an instance without `PUBLIC_ORIGIN`, the account chip still offers Sign in with Steam, which opens a bare "isn't available" text page. Hide it and say why, as the ITAD surfaces do (`/api/health`'s `itadConfigured`).

## Loading and feedback

- **U7 · minor · L3** — Reset view drops sort/filters instantly with no undo.
- **U188 · minor · D2** — after a failed price batch the panel's Price card says "IsThereAnyDeal didn't answer." with no retry there, and its Refresh details retries bundles but not the price; the only retry is the hero's Prices tile, out of sight behind the panel on a phone. Offer the retry in the card (the Prices tile's refresh), or have Refresh details refetch the game's price.
- **U195 · minor · D2, F1** — past the client share, `GET /api/game-details/:appid` still answers 200 with a `limited` message nothing reads, so Look up, Rank and the panel's Refresh details show per-source "didn't answer" notes and the ⚠ tooltip invites a retry that will be refused. Show the server's message there, as the list's status line does (or answer 429).
- **U225 · minor · F1, L1** — a list whose games aren't cached yet shows "No rows" under "0 / 15 games loaded…", with no progress bar (`loadFraction` 0 is falsy, `ListRoute.tsx:4259`), until the first game's details land (1.9 s desktop, 5.1 s phone, measured): rows wait for details although their names are known (`isListed`, `ListRoute.tsx:1463`). Show the bar from 0 and "Loading…" instead of "No rows"; possibly named rows with placeholder cells (the sort then reshuffles as details land).
- **U250 · minor · D1** — the **Updated** age reads the same at an hour or three weeks, so a missing recent purchase gives no hint that a refresh would fix it. Highlight an age older than a few days.

## Lists and selection

- **U161 · minor · C1, F3** — excluding a Steam tag drops every game carrying it, even as its 18th tag on a few votes (a "Horror" exclusion loses games with a passing horror level). The table filters raw column values, so: a **Main tags** column (tags ≥ ~30% of the top tag, threshold to measure first), filterable and groupable — excluding there is the soft exclusion, grouping there groups by dominant genre. Alternative: a per-column `filterValues(row)` in `@vates/data-table-core`.
- **U168 · minor · F3, F4** — no way to explore the store by Steam tag ("the best roguelikes I don't own"). `IStoreQueryService/Query` lists appids by `tagids_must_match`, key-less ([integrations.md](integrations.md#a-developers-or-publishers-games--store-search-results)); needs its own volume review like F4's.
- **U198 · minor · F3, D3** — no sign that a game got better or worse since release (Steam's "Recent Reviews"). A **Recent rating** from `GetAppReviews`' date range (last 30 days) — one more review call per uncached game, and a shorter TTL than the rating's ([integrations.md](integrations.md)).
- **U199 · minor · F3, R2** — the rating mixes first impressions with long-term verdicts. A **Rating (10 h+)** from `GetAppReviews`' `playtime_min_hours`; one more review call per uncached game, threshold to measure first.
- **U194 · minor · L1, I2** — focus still drops to `<body>` when the selection bar unmounts after Exclude, Remove from this list, Clear selection or Re-rank (Add now hands focus to a selected row). Have the bar hand focus back on unmount whenever it held focus.
- **U214 · minor · F3, L5** — Play next ranks an owned game that isn't out yet ("Coming soon", e.g. a pre-order) at the top, though it can't be played tonight. Leave unreleased games out of Play next and Short games.
- **U216 · minor · F3, L5** — no view answers "runs on my Linux PC or Steam Deck": filtering on ProtonDB Gold or better (or native Linux) is several clicks each time. A suggested view on Owned, and on Wishlist if it proves useful; rated the most useful missing view in a persona review.
- **U236 · polish · L1** — Home's folder/list tree deletes through a plain `window.confirm`, moves only through each row's "Move to…" select (no drag-and-drop), and soft-deleted lists have no trash or restore.
- **U249 · minor · L1** — a game's panel has no **Add to list**: adding the game being read means finding and selecting its row, and a looked-up game outside the list has none.

## Taste profile

- **U204 · minor · F3, B1** — idled games (card farming, left running) skew Plays mostly, Taste Fit and Group Fit, and nothing tells them apart from real play. An "exclude from my profile" toggle per game.
- **U215 · minor · F3, L5** — with too few played games, Taste Fit is "—" on every row, so Play next (sorted by it) shows its games in no useful order; only a line above the table says why. Fall back to the rating, or say in the view that it sorts by rating until Taste Fit can be computed.
- **U230 · minor · R1, C7, F3** — a ranking stays inside its own list: Owned and Compare can't show or use it, and Taste Fit learns from hours, not from what the player said they prefer. A **My rank** column on Owned, and the ranking as a taste signal where one exists. From the Backloggd study (2026-10-30).
- **U231 · polish · A5** — no look back over a year of play (Backloggd's stats pages). Steam gives only the last launch date per game, no history: at best "played this year" with total hours, not per-year hours or first launches. From the Backloggd study (2026-10-30).

## Comparing

- **U213 · polish · C7, C1** — **Players** is open by default on desktop and costs ~210 px every visit (the table starts at 638 of 900 px). Remember the viewer's open/closed choice (a per-viewer convenience).
- **U207 · minor · C1, C5, C6** — a comparison's Players section says where tastes meet, not what everyone can run or play together. Add the group's hard constraints: worst ProtonDB tier, co-op modes, controller support.
- **U170 · major · C3, L2** — saving a comparison names a player who isn't a stored account by steam64 id: the formula reads "Alice — Owned ∪ 76561198000000002 — Owned", and so do its group labels and Home's tree, though the comparison's own title said "Alice vs. Bob" and a reload doesn't fix it. Store or resolve each source account's name when the list is saved.
- **U196 · minor · C5, F1** — a Deck player has only ProtonDB's crowd tier to go on. A **Deck rating** from `GetAppReviews`' `primarily_steam_deck` (Steam reviews by mostly-Deck players), beside ProtonDB; one more review call per uncached game, and many games will have too few reviews — measure how many of a typical library get one first.
- **U197 · minor · C5, F1** — same for desktop Linux: a **Linux rating** from `GetAppReviews`' `hardware_os`, with U196's cost and sparsity caveats.
- **U139 · polish · C4** — panel Owned by reads "never played · not played". One phrase.
- **U237 · minor · C3** — a saved dynamic list grouped by membership shows only the current account's playtime: no Played column per player and no per-player hours in the panel's "Owned by", which the live comparison has (`createDefaultFetchers`' `onOwners`).
- **U246 · minor · A4, C1** — a comparison can't start from the friends list: each friend is typed or picked again in Compare's player boxes. Select friends there, **Compare with me**, landing on C1's result with the current account unchanged.
- **U247 · minor · C2** — a comparison's group missing one player has no price columns, so pricing what that player should buy means opening each panel. Price columns on comparisons, sortable (U244's totals then apply).
- **U248 · minor · C4** — the panel's Owned by covers the account's own members or a comparison's players, never the friends who own the game. Needs one library fetch per friend: blocked on a volume review against [integrations.md](integrations.md)'s trust tiers, before any design.

## Bundles and prices

- **U177 · polish · B1** — shop chips (`.shop-chip`) take a hue hashed from the shop's name, outside the tokens, so a shop can land on amber, which ui-guidelines.md's Colour keeps for warnings and owned games (Humble Bundle does). One neutral chip, or a few token hues that exclude amber.
- **U244 · minor · B1, C2** — grouped price columns show no total, so "what would this tier (or the missing friend's games) cost at best deals / 1-year lows" is summed by hand. Give Steam Full Price, Best Deal and the three lows an `aggregate` (region currency, once per gid, an incomplete marker for an unpriced row; off for pick & mix), shown through the release's aggregate formatter, not the cell render (Best Deal's record badge would read the first row's lows); hiding owned rows then sums only what's new. Waits for the @vates/data-table release after 0.21.0: before it, a group split across pages sums each page's rows only.
- **U238 · minor · B1** — `/bundles`' clock doesn't tick: its countdowns ("⏳ in 6h"), the Age and Ends in buckets and the hero's New and Ending soon counts are computed when the table processes its rows. Re-run the whole sort/filter/render pass on a timer: ticking only the hero counts would make them disagree with the rows.

## Phone

- **U217 · minor · C8** — a host on a phone or tablet can't present on the TV: the presentation window is a computer's (no Present button there). Casting through the Remote Playback API doesn't work: Firefox for Android has no `video.remote`; Chrome for Android finds no cast target for a native HLS trailer (availability false, `prompt()` rejects `NotAllowedError`) even where YouTube casts. Instead, a TV page (`/tv`, in the TV's browser or a computer on HDMI) paired with the phone by QR code or short code, over a server relay; reviewed plan on the `tv-remote` branch (`PLAN.md`).
- **U189 · minor · L1, C3, I1** — on a phone, Home's five full-width Explore cards (~400 px, repeating the nav bar and the chip's Owned/Wishlist) push **Your lists** below the fold: its heading starts at 898 px on an 844 px screen, so a returning user sees none of their lists. With no account, the Owned and Wishlist cards still read "The current account's games" and lead to "No account selected — pick one on Home". Compact the cards on a phone (two columns, no description), or put Your lists first once it has any; drop or disable the two account cards until there's an account.
- **U202 · minor · B1** — on a phone, a bundle's table starts at 565 px of 844 (hero 190–204 px, two toolbar rows 89 px, the active bar on two lines 55–62 px, the first group header 41 px), so three or four rows fit above the fold; names wrap in the pinned Name column. The active bar wraps whatever its pills (its row count alone takes ~128 px; @vates/data-table declined folding a group's sort into its pill, measuring it would still wrap). Left: the hero, and the pinned Name width.
- **U222 · minor · F2** — on a phone, `/search?q=…` lands on the closest match's full-screen panel, hiding the results and the refine box until × (F2's "refines without reopening the panel" can't happen there). On a phone, open the results with the match highlighted, or open the panel only on a single match.

## Accounts and first visit

- **U181 · minor · A3, I3** — with **Add Steam Family account**, both lookup fields are named "Steam name, profile URL, or 64-bit ID", so a screen reader can't tell them apart. Number them ("Family member 2").
- **U245 · polish · A1** — the first account resolved doesn't become the ★ account: only a Steam sign-in stars one (`authStore.ts`), so a first visitor stars it by hand or never. Star the first resolved account while none is starred.
- **U251 · minor · D3** — Home says nothing about what changed since the last visit: wishlist games now at a record low, new bundles holding wishlist games, owned games not yet in a ranking. Each item links to its list; "last visit" lives in localStorage (and Sync), nothing server-side.

## Consistency and polish

- **U169 · minor · I2, I3** — revealing a hidden achievement with Enter or Space drops focus to `<body>` (the spoiler button becomes a div), against ui-guidelines.md's "focus is never dropped". Move focus to the revealed row, or to the next hidden one.
- **U39 · polish** — the search box shifts sideways as the account chip's label changes length ("Alice" vs. "Alice + Bob + Carol"); missing thumbnails have no placeholder; wishlisted/owned name colours have no legend (still true in Recently Looked Up).
- **U179 · polish · I2, I3** — the first Tab stop reads "Skip to table" on pages with no table (Home, Compare's form, About, the rank screen), where it skips to `main`. "Skip to content" there.
- **U182 · polish · I2** — a second Esc in the nav search blurs it to `<body>`, so the next Tab starts from the page top. Hand focus to the main content's first stop, or back to where `/` was pressed.
- **U192 · polish · R1** — right after **Continue**, Undo is disabled with no reason given, so the last answer before Esc can't be undone (R1's edge "Undo right after resuming"); the stack is in memory only. Keep the undo stack with the ranking, or say "Undo covers this session's answers".
- **U223 · polish · F1** — tag and developer pills are filter buttons on list routes but inert on `/search` and the rank screen, styled the same (same border, only the cursor differs), so a click there does nothing with no hint why. Give the inert pills a plainer style.
- **U224 · polish · F1, I2** — focus on open differs per page: list routes move it to the hero's "Open in lightbox", `/game/:appid` to Close, `/search` keeps it on the row and Enter on the current row doesn't move it into the panel. One rule (the panel's first stop) everywhere, Search's row ring aside.

## Review tooling

States `npm run dev:mock` can't show yet — each needs a fixture or state in `e2e/mockApi.ts`:

- a static wishlist, so R2's "buying a game drops it from the ranking" can't be shown;
- prices in any currency but EUR, so B2's repricing can't be judged;
- a library of thousands of games: `big-library` adds 1200 (A1's edge, how high the table starts at scale).

## Not yet reviewed

- Y1–Y3 on the real server (needs a Steam sign-in; mocks have `signed-in`).
- On a real phone: trailer playback (headless Chromium showed black frames), pinch and double-tap zoom, swipe-to-close.
- Firefox and Safari: only Chromium was walked (View Transitions are Chromium/Safari-only).
- O1's `GET /api/metrics` (no mock).
