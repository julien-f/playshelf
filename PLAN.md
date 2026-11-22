# Plan: side panel redesign (branch `panel-redesign`)

Deleted before the merge. Design: the "tiles, refined" mockup (round 4), local copy at `/tmp/claude-1000/-home-julien-dev-julien-f-steam-common-games/3bd32ea3-0b54-4fe4-9c30-a023ead1f7ed/scratchpad/mock/panel-directions.html` (open it in a browser; Hades and a sparse game).

## Goal

The panel is crowded, its sections hard to tell apart, and it scrolls ~2 screens (U278–U288 in `docs/dev/improvements.md`). Every section becomes a card that folds to a one-line answer, so a game fits about one screen folded.

- **Tiles** (half width, in pairs, fixed slots): Reviews | Linux/Deck, To beat | Achievements, DLC | Owned by. Summary = one figure + one qualifier. An opened tile shows its body in a **drawer under its row** (notch pointing at it); tiles never move or resize; both tiles of a pair open → the drawer holds both, in tile order.
- **Wide cards**: Price (figure summary, full width so "€11.00 −45% · 1-year low · 2 bundles" fits), then text rows About, Tags & details, Similar games, News (summary on the title's line, cut with "…"). They open in place.
- **One component** for all: same top line (icon, title, chevron), `figure` or `text` summary; states loading (shimmer) / failed ("⚠ didn't answer", Retry inside) / empty (dimmed, reason, not openable) / ready.
- **Open state remembered per card for every game** (not per game, not by page or ownership): one pref.
- **Header**: name; one meta line (date · developer link · ownership chip · Status · refresh age); one action row: Steam Store (labelled, primary), Add to list (labelled), ⋯ (IsThereAnyDeal, Present, Website/Workshop, Copy link). DLC back trail and demo banner kept.
- **Subnav and its scroll-spy removed** (a folded panel is ~1 screen).

## Data facts checked (no assumption left)

- DLC: `DlcEntry` is `{appid, name, capsule, releaseDate, comingSoon}`: no price, no ownership. DLC summary: count + latest release ("25 · latest 2025-03-12"), or "· N coming soon". The mockup's prices/owned marks are dropped.
- Similar: names come from `similarInLibrary` only when the account's taste profile is cached on this device; otherwise the summary is "Open <account>'s Owned list to compare" (today's fallback, shortened). Hidden on Owned itself, as today.
- Linux/Deck: ProtonDB only (no Steam Deck verification in the panel's data).
- Achievements without a player (`playerCount === 0`): summary "N achievements", no progress bar.
- Owned by: only shown where the route has owners (members or a comparison); elsewhere the tile is empty ("—", "not owned here")? → **open question Q1**.

## Steps (one commit each, test first)

1. **Pure summaries** — new `public/panelSummaries.ts`: one function per card turning the game + panel data into `{ kind: 'figure'|'text', fig?, qualifier?, text?, tone?, state }`, covering loading / failed / empty / ready. Unit tests (`test/panelSummaries.test.js`) for every card's states, incl. HLTB with only "all playstyles", achievements without a player, a subscription leading Price, Similar without a cached library.
2. **Card component + open-state pref** — new `public/panelCards.tsx`: `PanelCard` (tile | wide) and `PanelTileRow` (pair + drawer, `aria-expanded`/`aria-controls`, focus stays on the button, drawer height slide reusing `CollapsibleCard`'s animation, none under reduced motion). Pref `panelOpenCards: string[]` in `prefs.ts`/`types.ts` (synced like other prefs) replacing `expandedSections`. Unit test for the pref toggle.
3. **Tiles** — Reviews, Linux/Deck, To beat (glance chip + HLTB section merged), Achievements as the first two rows; delete `GlanceGrid`/`GlanceChip`, `HltbSection`'s card. e2e: drawer opening keeps both tiles' boxes unchanged; an empty tile doesn't open; open state carries to the next game (↓).
4. **Price wide card** — `PriceSection` + `PanelOfferLines` inside; summary leads with a subscription when there is one. e2e: Price scenarios (record-low, bundles, subscriptions, "didn't answer").
5. **DLC | Owned by tiles, text rows** — DLC and Owned by tiles; About (description; "no store page" note), Tags & details (grouped Genres/Tags/Features, no legend, no duplicate, developer moved to the meta line), Similar, News as rows. Fold U281, U284–U287.
6. **Header** — meta line, labelled actions, ⋯ menu (U279, U286); remove `PanelSubnav`, `initSubnavScrollSpy`/`updateSubnavScrollSpy`/`jumpToPanelSection` (U280).
7. **Broken hero image** (U288) — hide the `<img>` on error and show the row's capsule (`standIn`) or a plain tile with the name.
8. **Docs and screenshots** — `panel-and-lightbox.md` (Sections, Motion, subnav paragraphs), `docs/user/features.md`, `ui-guidelines.md`'s Motion exception wording, glossary if a new label ("To beat"), `game-panel.png` and `list-table-and-panel.png` via the `screenshots` skill; close U278–U288 in `improvements.md`. CHANGELOG entry at the `--no-ff` merge.

Every step: `npm run format`, the touched e2e scenarios (`npm run test:e2e -- -g '<scenario>'`), then `npm run check` through the pre-commit hook. ~100 e2e references use `panel-title`/`panel-section-*`/`panel-glance*`/`panel-subnav*`/`panel-tag-legend`: kept class names where the element survives, updated in the step that removes one.

## Open questions

- **Q1** Owned by on a route without owners (search, a bundle): empty tile in its slot (fixed slots) or the tile pair becomes DLC alone?
- **Q2** Hero: keep today's height and thumbnail strip (out of scope), or shorten to 140 px and drop the strip (the mockup's ~1 screen relies on it)?
- **Q3** Present in ⋯ loses its visible "On TV" state in the header; the hero already says "On TV". Enough?
- **Q4** `panelOpenCards` synced across devices like other prefs, or device-only?

## Out of scope

Lightbox, presentation window, the table; U188 (Price retry) and U275 (refused vs failed sources) — the summary states keep today's failed/refused distinction so either can land later.
