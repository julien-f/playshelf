# Glossary

The words the UI uses, so a new label, doc line or backlog item says the same thing the same way ([ui-guidelines.md](ui-guidelines.md#wording-and-numbers)). Meanings are one line; the rules live where linked.

## Accounts and people

| On screen                    | Means                                                                   | In code                  | Avoid                                                                               |
| ---------------------------- | ----------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------- |
| account                      | a Steam profile, or a Steam Family, the app reads; kept in this browser | `AccountSlot`            | user, profile (Steam's page)                                                        |
| ★ account ("Star … as mine") | the user's own account                                                  | `myAccount`              | main account                                                                        |
| current account              | the account Owned and Wishlist show now, named by the nav chip          | effective account, `?u=` |                                                                                     |
| Steam Family account         | one account merging several members' libraries                          | a slot with members      | group (a comparison's)                                                              |
| member                       | one Steam profile inside a Family account                               | member                   | player                                                                              |
| player                       | one account in a comparison                                             | compare slot             | member                                                                              |
| Steam name                   | a profile's display name                                                | `personaname`            | persona: in the docs that's a kind of user ([journeys.md](journeys.md#who-uses-it)) |

## Lists

| On screen                  | Means                                                                                                           | In code               | Avoid                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------- |
| list                       | any set of games the table shows ([features.md](../user/features.md#lists))                                     | `GameList`, list kind | collection, library (an account's Owned)    |
| Owned, Wishlist            | an account's owned games and wishlist                                                                           | `owned`, `wishlist`   | library, wishes                             |
| manual list                | games picked by hand                                                                                            | `manual`              |                                             |
| dynamic list               | a list worked out from sources on every open ([combining](../user/features.md#combining-lists))                 | `dynamic`             | smart list, saved search                    |
| ranked list                | a source's games ordered by one-vs-one picks ([ranking](../user/features.md#ranking-a-list))                    | `ranked`              | sorted list, top list                       |
| source                     | a list another list is built from                                                                               | `sources`             | input                                       |
| Union, Intersect, Subtract | how a dynamic list combines its sources                                                                         | op                    | merge, AND/OR                               |
| Grouped by membership      | a combine mode grouping games by which sources hold them                                                        | `group-by-membership` | Group by membership                         |
| formula                    | a dynamic list's sources and operator, which also name it by default ("Me — Wishlist ∩ Family — Owned")         | formula, `?f=`        |                                             |
| comparison                 | several accounts' libraries side by side, from **Compare**                                                      | `compare`             | versus, match                               |
| Recently Looked Up         | the games looked up from search, at `/game`                                                                     | `recent`              | history                                     |
| bundle, tier               | a store bundle; one of its price steps, which also gets every cheaper tier's games                              | bundle, tier          | pack, level                                 |
| Exclude                    | leave a game out of a ranking; its button reads "Haven't played" on one's own games, "Not interested" elsewhere | excluded              | remove, delete (they leave the list itself) |

## Tables and views

| On screen       | Means                                                                                                     | In code                  | Avoid               |
| --------------- | --------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------- |
| layout          | a table's columns, sort, filters and grouping; a draft until **Save**                                     | table view prefs, `?tv=` | settings, view      |
| view            | a named layout kept as a tab on Owned or Wishlist (Play next, Bargains)                                   | `listViews`              | filter, preset, tab |
| Updated         | how old a list's data is; clicking it refreshes them ([freshness](../user/features.md#how-fresh-is-this)) | fetchedAt                | Refresh, Reload     |
| Refresh prices  | the Prices tile's refresh: prices only, the rest of the list kept                                         | price reload             | Updated             |
| Refresh details | the panel's refetch of one game's data from every source                                                  | details refresh          | Updated, Reload     |

## Scores and prices

| On screen       | Means                                                                                                                        | In code          | Avoid                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------- |
| Weighted Rating | the default rating, pulled toward 50% on few reviews ([decisions.md](decisions.md#ratings--wilson-score-vs-weighted-rating)) | `steamdbRating`  | SteamDB rating, score  |
| Taste Fit       | how close a game is to the current account's taste ([features.md](../user/features.md#lists))                                | taste fit        | match, recommendation  |
| Group Fit       | Taste Fit for the comparison's player it suits least ([comparing](../user/features.md#comparing-libraries))                  | group fit        | average fit            |
| Plays mostly    | the Steam tags an account spends its time on                                                                                 | play profile     | favourite genres       |
| Best Deal       | the lowest current price across stores, from IsThereAnyDeal                                                                  | `bestDealPrice`  | cheapest, lowest price |
| 🔥 ★ ☆          | a deal at or near its record low ([prices](../user/features.md#prices))                                                      | `dealRecordTier` |                        |

## Presenting

| On screen | Means                                                                                                                | In code        | Avoid        |
| --------- | -------------------------------------------------------------------------------------------------------------------- | -------------- | ------------ |
| Present   | show the game's media on the second-screen window ([features.md](../user/features.md#presenting-on-a-second-screen)) | presentation   | cast, stream |
| On TV     | the panel's and nav chip's mark of what the presentation window shows                                                | presented item | casting      |
