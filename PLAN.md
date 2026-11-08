# Plan: Play next answers "what can I play tonight" (U214, U215, U216)

Branch `play-next` (worktree `.claude/worktrees/play-next`), closed with `git merge --no-ff` after the user's own test. This file is deleted before the merge.

## Why these

- Play next is the app's most frequent question (F3, L5, A5), opened from Owned's Barely played count.
- U214: a pre-order tops it though it can't be played tonight (e2e "what to play next counts a preorder" records it as a limitation).
- U215: with too few games played, Taste fit is "—" on every row and the view has no useful order: a new or friend account's first look.
- U216: "runs on my Linux PC or Steam Deck" takes several clicks each time; rated the most useful missing view.
- All three are `public/listViews.ts` templates; no upstream call added.

## Steps (one commit each; each bug's e2e committed seen failing first)

1. **U214 — leave unreleased games out of Play next, Short games and the Barely played count.**
   - A hidden-by-default **Availability** column on Owned/Wishlist/user lists (`Out` / `Coming soon`, from Steam's `comingSoon` flag), filterable; both templates exclude `Coming soon` (`NOT_YET = { availability: [COMING_SOON] }` beside `NOT_DONE`). Status stays the viewer's own word: no new value in `STATUS_LABELS`/`GameStatus`, so the panel's status picker (`panel.tsx:2583`) and the profile (`PlayerProfile.tsx:253`) are untouched. (Alternative weighed: a `Coming soon` value in the Status column — see the question asked with this plan.)
   - One predicate for "a Play next candidate" exported from `listViews.ts` (played ≤ `PLAY_NEXT_MAX_HOURS`, not Finished/Abandoned, released), used by the `unplayed` memo (`ListRoute.tsx:3939`) instead of its hand copy, so the count and the view can't drift.
   - Why a column, not a range filter on Released: a template is stamped once, so it can't hold "released by today".
2. **U215 — a usable order without Taste fit.** Play next sorts by Taste fit, then Weighted Rating (`steamdbRating desc`): a missing Taste fit compares equal (`compareNumMissingLast`), so with no profile every row falls to the rating, and rounded ties break on it too. The note above the table (`tasteFitNote`, `ListRoute.tsx:390`) says so when the view sorts by Taste fit: "…has too few games played, so best rated first".
3. **U216 — a "Runs on Linux (ProtonDB)" suggested view on Owned.** ProtonDB filter Native, Platinum, Gold (values from `protonDbValue`, not typed strings); Owned's default sort; columns `capsule, name, protondb, platforms, steamdbRating, tasteFit, playtime, hltbAll`. The name says the source: it isn't Deck Verified.
   - Limitations, in features.md: a native Linux game with no ProtonDB report or whose ProtonDB call didn't answer is left out (filters AND across columns); a provisional tier counts.
4. **Existing views follow** (lands with step 1, extended by step 2). Replace `withStatusExclusion` with frozen **past stamps** per template: literal `{ view, cols }` objects in their historical key order (`rangeFilters, excludeFilters, sorts`), passed through `stamp()`. Play next: pre-status, status-era (today's), step-1; Short games: pre-status, status-era. A stored template view equal to any of them reads as the current stamp; an edited one is left as it is. Drops the `excludeFilters === NOT_DONE` identity check.

## Tests

- `test/listViews.test.js`: past stamps written as literals in the test (not derived from the code's list) for every Play next and Short games stamp, each upgraded; an edited view kept; the candidate predicate (unreleased, Finished, > 2 h, edge 2 h); Runs on Linux's filter equals `protonDbValue` of native/platinum/gold. Update the exact assertions at `:96` (`suggestedTemplates` ids), `:105`, `:113`.
- The Availability column's value as a pure function in a `.ts` module (node tests can't load `.tsx`), tested in `test/gameColumns.test.js`.
- e2e (`e2e/scenarios.spec.ts`):
  - U214 repro: rewrite "A5 edge: what to play next counts a preorder" to leave Someday Saga out of Play next and Short games, count 3.
  - A stored status-era Play next view (`asPlayer(page, DAVE, { listViews: … })`, as `:3296`) opened from the count loses the pre-order.
  - U215 repro: ALICE (3 played, under `MIN_PLAYED_FOR_PROFILE`) opens Play next: full name order Stardew, Hades, Hollow Knight, Valheim, and the note says best rated first.
  - U216: CAROL's Runs on Linux shows 3 of 5 (Silver and no-report games out); suggested-views menus at `:3329` and `~:3349` list it.
  - Hard-coded counts follow: "Play next: 4" at `:876`, `:920`, `:932`; the F3 edge's 4→3 becomes 3→2 at `:938`, `:942`.
- Phone e2e project before each UI commit.

## Docs

- `docs/user/features.md`: Play next and Short games (~40, unreleased out, rating fallback), Barely played (~55), Runs on Linux and its limits, the edited-view caveat beside ~169 ("a view you edited keeps unreleased games; exclude Coming soon in Availability"), the Availability column.
- `docs/dev/journeys.md`: A5.5, F3's "Or" line, C5's mention.
- `docs/dev/game-table.md`: ~16 (columns per list kind), ~54 (the count's predicate, past stamps replacing `withStatusExclusion`).
- `docs/dev/improvements.md`: remove U214, U215, U216.
- `CHANGELOG.md`: one entry per item at the `--no-ff` merge.

## Out of scope

- Runs on Linux on Wishlist (likely more useful there: P1 is a pre-purchase check) — proposed as a follow-up item.
- A Steam Deck Verified signal (a new upstream call); a real OR across columns (`@vates/data-table-core`).
- Other triage findings (C175's and C192's stale premises, moved line refs) — reported separately.
