# Plan: side panel redesign (branch `panel-redesign`)

Deleted before the merge. Design: the "tiles, refined" mockup (round 4), local copy at `/tmp/claude-1000/-home-julien-dev-julien-f-steam-common-games/3bd32ea3-0b54-4fe4-9c30-a023ead1f7ed/scratchpad/mock/panel-directions.html`. Revision 2, after review round 1 (item ids in brackets: F frontend, U UI, T testing, P users).

## Goal

The panel is crowded, its sections hard to tell apart, and it scrolls ~2 screens (U278–U288 in `docs/dev/improvements.md`). Every section becomes a card that folds to a one-line answer.

- **Tiles** (half width, in pairs, fixed slots): Weighted Rating | Linux/Deck, To beat | Achievements, DLC | Owned by (see C1). Summary = one figure + one qualifier. An opened tile shows its body in a **drawer under its row** (notch pointing at it); tiles never move or resize; both tiles of a pair open → the drawer holds both, in tile order.
- **Wide cards**: Price (figure summary), then text rows About, Tags & details, Similar games, News (summary on the title's line, cut with "…"). They open in place.
- **One component**: same top line (icon, title, chevron), `figure` or `text` summary. States: loading (static shimmer under reduced motion; name "<Title>, loading"), failed (figure "⚠", qualifier "didn't answer"; body "<Source> didn't answer" + Retry; stays an openable button) [U3], empty (not a button: `<h3>` + summary text, no chevron, `--muted`, not opacity) [U2], ready.
- **Semantics** [U1]: each card's top button wrapped in an `<h3>` (as `CollapsibleCard` today); a drawer part is `<section aria-labelledby=<tile h3 id>>`, its caps label `aria-hidden`. `aria-expanded`/`aria-controls` on the button.
- **Open state**: one device-only pref `panelOpenCards` (not in `syncedPrefKeys.ts`) [Q4], global across games, independent of route and ownership; **default `['price']`** (today Price is always open; buying is its point) [P1, T1]. Read through one `createMemo` → `Set`, per-card booleans as primitives (`getPref` returns a fresh array) [F8].
- **Header**: name; meta line (date · developer link · ownership chip · Status · refresh age = the ↻ button, which stays the refresh [F9]), each control ≥ 24 px tall [U4]; action row: Steam Store (labelled, primary), Add to list (labelled), ⋯ "More actions" (IsThereAnyDeal, Present — reads "Stop presenting" while presenting, with its P key [Q3], Website/Workshop, Copy link — keeps the live-region "copied" announcement [P6]); menu: `aria-expanded`, Esc closes it before the panel, focus back on ⋯ [U8]. `.panel-header-sticky` stays sticky. DLC back trail and demo banner kept.
- **Hero unchanged**: today's height and filmstrip stay (the visible path to each shot, the host's way to pick what goes on the TV; morph, swipe and wheel depend on it) [Q2: all four]. Folded content is then ~1.2 screens, not the mockup's 1.0.
- **Subnav and scroll-spy removed**, with `pinnedSubnavTarget`, the spy's `lightboxOpen` check and `smoothScroll` if unused [F9].
- **Tokens and type** [U5]: existing tokens (`--surface-2`, `--radius-3`, `--fs-figure` for the price) or new tokens added to `palette.test.js`; no 22 px, no 10 px radius.
- **Motion** [U7]: height slide on a click only; no animation when a game step, data arriving or a tile turning empty resizes a drawer or body; one chevron direction for tiles and wide cards. Accent edge only on the opened tile, its notch and its drawer [U9].

## Summaries (step 1's unit tests cover every line)

- **Weighted Rating** [U6]: figure the rating (score colour), qualifier "250k reviews".
- **Linux/Deck**: ProtonDB tier (tier colour), "100 reports"; empty "no reports". ProtonDB only: no Deck verification in the data.
- **To beat** [P5, U6]: "26.7 h", qualifier "main · 66.8 h 100%" (completionist); only All PlayStyles known: "3 h", "all playstyles". Hours with a space. "To beat" added to the glossary.
- **Achievements**: "1 / 2" + bar, qualifier naming whose progress where the data allows [U6]; no player (`playerCount === 0`): "2", "achievements", no bar.
- **Price**: price, discount, ★/🔥 record glyph as in the table [U6], "· 2 bundles"; a subscription leads ("in Game Pass until …").
- **DLC** [F1]: count from `meta.dlc.length` ("25"), qualifier "DLC"; "latest <date>" only once every id is cached. The per-id fetch stays tied to the body being open, and `fetchDlc` gets the `PANEL_SETTLE_MS` pause news/achievements/price have, so holding ↓ with DLC open doesn't fetch every game's DLC [F2].
- **Owned by** [P2]: where the route has members, always ready: one owner "Alice", "45m"; several "3 / 4", "not Bob"; none "none of you". Body lists each owner with hours.
- **About**: description's first line; no store page: "Delisted: no description".
- **Tags & details**: top tag then genres; body grouped Genres / Tags / Features, pills still filter the table [P3], no legend, no duplicate.
- **Similar** [F7, U11, P4]: closest owned names when the taste profile is cached; "needs <account>'s Owned list" (full sentence inside) when not; on Owned and with no account see C2. Body keeps More from, Sort list by similarity and More like this on Steam [P3].
- **News**: latest post's date and title; no official posts: no card.

## Steps (one commit each, test first; docs edited in the step that removes an identifier they name [F5])

Each step lists the e2e tests it updates; an `openCard(page, title)` helper in `e2e/state.ts` opens a folded card, and tests not about folding seed `panelOpenCards` through `asPlayer`'s prefs [T1]. `node scripts/journey-coverage.js` before and after each step: F1.4, I3.4 and the I2 edges keep their ★ [T8].

1. **Pure summaries** — `public/panelSummaries.ts`, one function per card → `{ kind, fig?, qualifier?, text?, tone?, state }`; `test/panelSummaries.test.js` for every state above.
2. **Card component, pref and the first tiles** (old steps 2+3 merged: no dead export [F6, T2]) — `public/panelCards.tsx`: `PanelCard` (tile | wide) and `PanelTileRow`. One button per card for its whole mount; only summary text and body vary; refetches read `.latest`, the shimmer shows only with no value yet; summary fields read through one `createMemo`, never a keyed `<Show>` on it [F3]. `panelOpenCards` replaces `expandedSections` (`revealedAchievements`, `achievementsFilter` stay per-appid). Weighted Rating, Linux/Deck, To beat (glance chip + HLTB merged; its auto-expand effect deleted, not ported [F4]), Achievements. Delete `GlanceGrid`, `GlanceChip`, `HltbSection`'s card; carry `--panel-ground` onto the tiles; `leavePanelGhost` also strips `aria-controls` [F9]. Docs: frontend.md (`CollapsibleCard`, `DlcSection` refs), panel-and-lightbox.md Sections/Motion. Tests: unit for the pref toggle; e2e glance "didn't answer"/refresh (scenarios 5434, 5643, 5804, 5875, 6002, 7964, 9216–9237), both reduced-motion section tests (8715–8730), `I2 edge: a click slides a section open… reopened game` (8862), `I3.1-2,4` h3 names (9559); new: tiles' boxes unchanged on opening one then the other and from loading to ready [T5], keyboard path (Tab, Enter/Space, focus stays, `aria-expanded`), empty tile not a button, Retry in a failed tile (`upstream-down`), open state carried by ↓, on `/game/:appid` and after a reload [T7].
3. **Price wide card** — `PriceSection` + `PanelOfferLines` inside; game-table.md's `PriceSection` ref. e2e: record-low, bundles, subscriptions, "didn't answer"; a fresh browser shows the deal link (default open) [P1].
4. **DLC | Owned by tiles, text rows** — U281, U284, U285; About, Tags & details, Similar, News rows; developer to the meta line; taste.md's `SimilarSection` ref. e2e: `.panel-tag-legend` (6016), `.panel-dlc-item` (11), `.panel-similar-item`, owners; `/api/game-meta` call count with DLC folded (no fetch) [T7]; DLC hop with the DLC tile folded. Mock gaps added here: HLTB "all playstyles" only, a ready News feed, a coming-soon DLC, a second game with achievements [T6].
5. **Header** — meta line, labelled actions, ⋯ menu (U279, U286); remove `PanelSubnav`, the scroll-spy, `jumpToPanelSection` (U280); frontend.md's `PanelSubnav`/`PanelRest`/scroll-spy lines. e2e: subnav (6134–6170), Present (1682, 1699, 1886, 1891), More links (8265–8300, whose "only links found nowhere else" rule changes with "More actions"), `In 1 list: add or remove` (3335, 9686), `.panel-header-sticky` (8653), `panel-contract.spec.ts` if `#panel-title`/`Refresh details` move; meta-line targets ≥ 24 px at 390 px via `ux-measure.js`; no summary overflows at 390 px (`scrollWidth <= clientWidth`) [T5].
6. **Broken hero image** (U288) — hide the `<img>` on error, show the row's capsule (`standIn`) or a plain tile with the name.
7. **User docs and screenshots** — `docs/user/features.md`, `game-panel.png`, `list-table-and-panel.png` (`screenshots` skill); close U278–U286 and U288 (U278 noting titles stay 13 px/600, the cards separating sections [U12]); reword U287 and leave it open (no DLC price or ownership data) [U10]. CHANGELOG at the `--no-ff` merge.

## Contested (round 2)

- **C1** Owned by slot on a route without members (search, a bundle, Recently Looked Up): (a) empty tile in its slot, fixed slots everywhere [U, T]; (b) no tile, DLC becomes a wide text row there, decided from the synchronous `currentMembers().length`, so it never changes while stepping [F, P]. Proposal: (b) — an always-empty tile on most routes teaches to ignore it, and the route can't change under ↑/↓.
- **C2** Similar with no account, and on Owned: (a) hide the card [P4]; (b) keep it for More from / More like this on Steam [F7], summary "More from <developer>". Proposal: (b).

## Out of scope

The hero, lightbox, presentation window, table; U188 (Price retry) and U275 (refused vs failed) — the states keep today's failed/refused distinction.
