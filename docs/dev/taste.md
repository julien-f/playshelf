# Taste

How the app reads what an account plays from its tags (`tagTaste.ts`, `playerProfile.ts`, `PlayerProfile.tsx`): Owned's profile card, Taste Fit, a comparison's Players and Group Fit, and the panel's Similar in library. Where a `Taste` is stored: [lists-and-accounts.md](lists-and-accounts.md#storage-schema); why two players are compared by a count rather than a score: [decisions.md](decisions.md#how-alike-two-players-are--a-count-not-a-score). The Similarity column's wiring: [game-table.md](game-table.md).

## Owned's profile

`PlayerProfile.tsx`'s `OwnedProfile`, through `ListHero`'s `section` slot (the note slot only says when playtime is private, `playtimeHidden`), is built from `loadedRows`, the rows unwrapped once every one's details are in (a task after the stream's last flush), so it doesn't reshuffle while details stream, reads no store proxies, and later row writes (prices, a panel ↻) don't redo it — it copies the array, not the rows, so such a write still shows in whatever is next computed from it. A fresh load clears it; a ↻ refresh keeps the previous one, and its rows, until its own stream ends (the store's rows are new objects by then, so a write in between shows only once it's retaken). Owned's taste, a comparison's Group Fit and player profiles, and the Similarity column (the live rows while a fresh load streams) read it too.

- `tagTaste.ts`'s `topPlayedTags` gives the tags and how many played games they come from (`played`); software (`isSoftware`) counts toward no profile — Plays mostly, Taste Fit or Group Fit. Each tag is a `TagBars` button holding its weight bar and a visually-hidden %, calling `onTagClick` like the panel's pills.
- `playerProfile.ts`'s `profileFacts` and `archetypeOf` (none for a Family) title the card; its story tile (`storyGames`), Favourite studios tile (`favouriteCreators`: each name an `onTagClick` filter on the Developers/Publishers column, like the panel's pills, beside a link to its developer/publisher list with `?u=` kept) and barely-played tile show only with data, the card going full width without them. The barely-played count is of released games played `PLAY_NEXT_MAX_HOURS` or less and not marked finished or abandoned (`unplayed`, by `isPlayNextCandidate`, the Play next template's own bounds in `listViews.ts`); its **Play next** (`showBacklog`) opens that view (`templateView`, created the first time), pressed while it's open, back to All games on a second press.
- **Why these?** (`playsMostlyWhy`, a route-level signal since the hero re-renders) opens each figure's evidence in its own card (`profile--open`): each tag's `games` (by their share of its score) under its bar through `TagBars`' `detail`, the story games as `StoryList` rows of hours against `hltbMain`, each studio's played games as `GameChip`s, and a folded **How it's counted**. Game names and art come from the rows (`ProfileGameInfo`).
- Layout: the main card `2fr` beside the stacked tiles; at 768 px and below, stacked, 4 bars (all once Why these? is open), each tile one line, one studio per role (all once open).

## Taste Fit

The Taste Fit column (`tasteFit`, `tasteFitColumn` in `ListRoute.tsx`) is `tagTaste.ts`'s `fitTo` against the current account's stored `Taste` ([lists-and-accounts.md](lists-and-accounts.md#storage-schema)), read through the `tasteFitSource` signal; Owned saves it (`tasteOf`) once its details finish loading and swaps it into that signal, so its own Taste Fit scores on a first visit. With no taste on this device it's left out of the default columns (a column of "—"), its default read when the table builds; while the column shows, the list status (`scoreNotes`, `tasteFitNote`) says whose taste and how old, or why there's none — but not "open Owned" on a `?u=` link to another account (`linked`).

## Players

A comparison's Players section (`playersSection`, `ListHero`'s `section` slot) shows, per player, `topPlayedTags` and `playStyle` with that player's hours (`playerHours`, summed over a Family's members) instead of the rows' own playtime.

- Computed from `loadedRows` (see Owned's profile above, `playerProfiles`); only on Grouped or Union (`profilesShown`), whose rows hold every library.
- A `<details>` whose open state is a route-level signal, open by default from 768 px. A tag tapped in it scrolls the table's toolbar up when it's in the lower half of the screen, since an open section pushes it off a phone's.
- Each player a card (`players-card`): `PlayerAvatar` (the account's `avatarUrl`, a Family's first member's, else the initial), `ProfileBadge` and `archetypeOf` (with that player's `storyGames`; none for a Family), then **Playing lately** (`GameOwner.recentMinutes`, which the server leaves at 0 for a library copy over 14 days old) and their tags. Under them one shared-ground card, its labels in a left column (above, at 600 px and below), games as `gameArt` buttons (`thumb ?? capsule`, lazy).
- In it, `tagTaste.ts`'s `commonGround`: the top tags each pair shares (in the summary for two players; closest pair and odd one out for more), tags in common, each player's own (shown on their line in place of their top tags), and favourites everyone played a lot, each opening its panel.
- **Suggest to** (`suggestTarget`, defaulting to the first player with a profile who isn't my ★ or current account): `suggestionsFor`, ranked among that player's unplayed games, since the played ones are what their profile is made of.

## Group Fit

A comparison's Group Fit column (`groupFitColumn` in `ListRoute.tsx`) is the minimum over players of `tagTaste.ts`'s `playerFits` (cosine of the game against each player's play profile), computed once details finish loading; the cell names the least suited player, its `title` lists everyone's score, and the list status (`scoreNotes`) names players left out for lack of a profile unless an open **Players** already does (`playerProfiles` and `playersOpen`).

## Similar in library

The panel's Similar in <account>'s library section (`SimilarSection`) is `tagTaste.ts`'s `similarInLibrary`: the IDF-weighted cosine over `tagWeights` plus Production Tier ([decisions.md](decisions.md#production-tier--a-heuristic-not-steam-provided-data)) against the effective account's cached `Taste.games` ([lists-and-accounts.md](lists-and-accounts.md)), so no extra requests. Hidden on Owned's own rows (`isOwnedList` route handler): it would repeat the Similarity sort. Without a cache it links Owned; without an account, only the Steam link. The Sort list by similarity button shows on a route registering `setSimilarTo`.
