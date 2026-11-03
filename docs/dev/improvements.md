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

## Loading and feedback

- **U7 · minor · L3** — Reset view drops sort/filters instantly with no undo.
- **U188 · minor · D2** — after a failed price batch the panel's Price card says "IsThereAnyDeal didn't answer." with no retry there, and its Refresh details retries bundles but not the price; the only retry is the hero's Prices tile, out of sight behind the panel on a phone. Offer the retry in the card (the Prices tile's refresh), or have Refresh details refetch the game's price.
- **U195 · minor · D2, F1** — past the client share, `GET /api/game-details/:appid` still answers 200 with a `limited` message nothing reads, so Look up, Rank and the panel's Refresh details show per-source "didn't answer" notes and the ⚠ tooltip invites a retry that will be refused. Show the server's message there, as the list's status line does (or answer 429).
- **U225 · minor · F1, L1** — a list whose games aren't cached yet shows "No rows" under "0 / 15 games loaded…", with no progress bar (`loadFraction` 0 is falsy, `ListRoute.tsx:4259`), until the first game's details land (1.9 s desktop, 5.1 s phone, measured): rows wait for details although their names are known (`isListed`, `ListRoute.tsx:1463`). Show the bar from 0 and "Loading…" instead of "No rows"; possibly named rows with placeholder cells (the sort then reshuffles as details land).

## Lists and selection

- **U161 · minor · C1, F3** — excluding a Steam tag drops every game carrying it, even as its 18th tag on a few votes (a "Horror" exclusion loses games with a passing horror level). The table filters raw column values, so: a **Main tags** column (tags ≥ ~30% of the top tag, threshold to measure first), filterable and groupable — excluding there is the soft exclusion, grouping there groups by dominant genre. Alternative: a per-column `filterValues(row)` in `@vates/data-table-core`.
- **U168 · minor · F3, F4** — no way to explore the store by Steam tag ("the best roguelikes I don't own"). `IStoreQueryService/Query` lists appids by `tagids_must_match`, key-less ([integrations.md](integrations.md#a-developers-or-publishers-games--store-search-results)); needs its own volume review like F4's.
- **U198 · minor · F3, D3** — no sign that a game got better or worse since release (Steam's "Recent Reviews"). A **Recent rating** from `GetAppReviews`' date range (last 30 days) — one more review call per uncached game, and a shorter TTL than the rating's ([integrations.md](integrations.md)).
- **U199 · minor · F3, R2** — the rating mixes first impressions with long-term verdicts. A **Rating (10 h+)** from `GetAppReviews`' `playtime_min_hours`; one more review call per uncached game, threshold to measure first.
- **U194 · minor · L1, I2** — focus still drops to `<body>` when the selection bar unmounts after Exclude, Remove from this list, Clear selection or Re-rank (Add now hands focus to a selected row). Have the bar hand focus back on unmount whenever it held focus.
- **U214 · minor · F3, L5** — Play next ranks an owned game that isn't out yet ("Coming soon", e.g. a pre-order) at the top, though it can't be played tonight. Leave unreleased games out of Play next and Short games.
- **U216 · minor · F3, L5, P1** — no view answers "runs on my Linux PC or Steam Deck": filtering on ProtonDB Gold or better (or native Linux) is several clicks each time. A suggested view on Owned, and on Wishlist if it proves useful; rated the most useful missing view in a persona review.
- **U236 · polish · L1** — Home's folder/list tree deletes through a plain `window.confirm`, moves only through each row's "Move to…" select (no drag-and-drop), and soft-deleted lists have no trash or restore.

## Taste profile

- **U204 · minor · F3, B1** — idled games (card farming, left running) skew Plays mostly, Taste fit and Group fit, and nothing tells them apart from real play. An "exclude from my profile" toggle per game.
- **U215 · minor · F3, L5** — with too few played games, Taste fit is "—" on every row, so Play next (sorted by it) shows its games in no useful order; only a line above the table says why. Fall back to the rating, or say in the view that it sorts by rating until Taste fit can be computed.
- **U230 · minor · R1, C7, F3** — a ranking stays inside its own list: Owned and Compare can't show or use it, and Taste fit learns from hours, not from what the player said they prefer. A **My rank** column on Owned, and the ranking as a taste signal where one exists. From the Backloggd study (2026-10-30).
- **U231 · polish · A5** — no look back over a year of play (Backloggd's stats pages). Steam gives only the last launch date per game, no history: at best "played this year" with total hours, not per-year hours or first launches. From the Backloggd study (2026-10-30).

## Comparing

- **U213 · polish · C7, C1** — **Players** is open by default on desktop and costs ~210 px every visit (the table starts at 638 of 900 px). Remember the viewer's open/closed choice (a per-viewer convenience).
- **U207 · minor · C1, C5, C6** — a comparison's Players section says where tastes meet, not what everyone can run or play together. Add the group's hard constraints: worst ProtonDB tier, co-op modes, controller support.
- **U170 · major · C3, L2** — saving a comparison names a player who isn't a stored account by steam64 id: the formula reads "Alice — Owned ∪ 76561198000000002 — Owned", and so do its group labels and Home's tree, though the comparison's own title said "Alice vs. Bob" and a reload doesn't fix it. Store or resolve each source account's name when the list is saved.
- **U196 · minor · C5, F1** — a Deck player has only ProtonDB's crowd tier to go on. A **Deck rating** from `GetAppReviews`' `primarily_steam_deck` (Steam reviews by mostly-Deck players), beside ProtonDB; one more review call per uncached game, and many games will have too few reviews — measure how many of a typical library get one first.
- **U197 · minor · C5, F1** — same for desktop Linux: a **Linux rating** from `GetAppReviews`' `hardware_os`, with U196's cost and sparsity caveats.
- **U139 · polish · C4** — panel Owned by reads "never played · not played". One phrase.
- **U237 · minor · C3** — a saved dynamic list grouped by membership shows only the current account's playtime: no Played column per player and no per-player hours in the panel's "Owned by", which the live comparison has (`createDefaultFetchers`' `onOwners`).

## Bundles and prices

- **U177 · polish · B1** — shop chips (`.shop-chip`) take a hue hashed from the shop's name, outside the tokens, so a shop can land on amber, which ui-guidelines.md's Colour keeps for warnings and owned games (Humble Bundle does). One neutral chip, or a few token hues that exclude amber.
- **U238 · minor · B1** — `/bundles`' clock doesn't tick: its countdowns ("⏳ in 6h"), the Age and Ends in buckets and the hero's New and Ending soon counts are computed when the table processes its rows. Re-run the whole sort/filter/render pass on a timer: ticking only the hero counts would make them disagree with the rows.

## Phone

- **U217 · minor · C8** — a host on a phone or tablet can't present on the TV: the presentation window is a computer's (no Present button there). Casting through the Remote Playback API doesn't work: Firefox for Android has no `video.remote`; Chrome for Android finds no cast target for a native HLS trailer (availability false, `prompt()` rejects `NotAllowedError`) even where YouTube casts. Instead, a TV page (`/tv`, in the TV's browser or a computer on HDMI) paired with the phone by QR code or short code, over a server relay; reviewed plan on the `tv-remote` branch (`PLAN.md`).
- **U189 · minor · L1, C3, I1** — on a phone, Home's five full-width Explore cards (~400 px, repeating the nav bar and the chip's Owned/Wishlist) push **Your lists** below the fold: its heading starts at 898 px on an 844 px screen, so a returning user sees none of their lists. With no account, the Owned and Wishlist cards still read "The current account's games" and lead to "No account selected — pick one on Home". Compact the cards on a phone (two columns, no description), or put Your lists first once it has any; drop or disable the two account cards until there's an account.
- **U202 · minor · B1** — on a phone, a bundle's table starts at 565 px of 844 (hero 190–204 px, two toolbar rows 89 px, the active bar on two lines 55–62 px, the first group header 41 px), so three or four rows fit above the fold; names wrap in the pinned Name column. The active bar wraps whatever its pills (its row count alone takes ~128 px; @vates/data-table declined folding a group's sort into its pill, measuring it would still wrap). Left: the hero, and the pinned Name width.
- **U222 · minor · F2** — on a phone, `/search?q=…` lands on the closest match's full-screen panel, hiding the results and the refine box until × (F2's "refines without reopening the panel" can't happen there). On a phone, open the results with the match highlighted, or open the panel only on a single match.

## Accounts and first visit

- **U181 · minor · A3, I3** — with **Add Steam Family account**, both lookup fields are named "Steam name, profile URL, or 64-bit ID", so a screen reader can't tell them apart. Number them ("Family member 2").

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

- avatars, and a large library (thousands of games: A1's edge, how high the table starts at scale);
- friends lists always private (A4, C4's ◇) and `/api/me` always signed out (Y1–Y3);
- a static wishlist, so R2's "buying a game drops it from the ranking" can't be shown;
- a private profile, so A1's "looks empty — does the UI say why?" edge can't be judged;
- prices in any currency but EUR, so B2's repricing can't be judged;
- search results (`/api/search-games`) and bundles carry no image, so the search dropdown's thumbnails and /bundles' Image column show blank;
- a trailer that plays: Hades' fixture trailer has no stream, so playback and its idle-hide can only be seen on the real server.

## Not yet reviewed

- A4 (no allowed account has a public friends list); Y1–Y3 (needs a Steam sign-in).
- On a real phone: trailer playback (headless Chromium showed black frames), pinch and double-tap zoom, swipe-to-close.
- Firefox and Safari: only Chromium was walked (View Transitions are Chromium/Safari-only).
- O1's `GET /api/metrics` (no mock); D1's age highlight, C2's price columns per group, L1's panel **Add to list**, D3 (◇ not started).
