# Journeys

What users come to the app to get done: the input for design reviews (walk each one, judge the friction) and for end-to-end tests.

- **Goals**: explore Steam libraries as lists of games, with ratings, completion times and prices in one table; combine lists to answer what Steam can't (what friends both own, what a bundle adds, what the family already has); share a view; run it yourself for a group of friends.
- **Non-goals**: buying or trading through the app; social features beyond reading Steam's friends lists; storing anything about an account beyond its cached public data and the user's own lists.

Each journey: **Who / goal**, numbered **Steps** as a user would take them, **Done when** (what must be true at the end) and **Edges** worth checking. ◇ marks a step or outcome the app doesn't support yet: the target a design review pushes toward. Which steps `e2e/scenarios.spec.ts` locks (★) is derived, never written: `node scripts/journey-coverage.js`.

Tests map to journeys by title: `A1: …` covers A1's built steps, `A1.1,3-4: …` only those steps, `A1 edge: …` its edges.

- [Accounts](#accounts)
- [Comparing libraries](#comparing-libraries)
- [Lists](#lists)
- [Ranking](#ranking)
- [Bundles and prices](#bundles-and-prices)
- [Finding a game](#finding-a-game)
- [Media](#media)
- [Sharing](#sharing)
- [Sync](#sync)
- [Freshness and failures](#freshness-and-failures)
- [Devices and input](#devices-and-input)
- [Running an instance](#running-an-instance)

## Accounts

### A1 First visit: look at my library

- **Who / goal**: a new visitor wants to see their own games with ratings and completion times.
- **Steps**:
  1. open `/`
  2. paste a profile URL, vanity name or steam64 id
  3. resolve
  4. it becomes my ★ account automatically, being the first ◇
  5. open **Owned**
- **Done when**: the account card shows avatar, name, owned/wishlist counts; the nav chip names the account; Owned streams in rows with rating/HLTB filled progressively; reloading keeps everything.
- **Edges**: unknown identifier; private profile (looks empty — does the UI say _why_ it might be?); a very large library (thousands of games); slow upstream.

### A2 Explore a friend without losing my own setup

- **Who / goal**: I want to peek at a friend's wishlist, then return to mine.
- **Steps**:
  1. nav chip
  2. pick a known account (or resolve a new one on Home)
  3. **Wishlist**
  4. switch back to my account from the chip
- **Done when**: my ★ account is unchanged; the friend lands in Home's Accounts; open lists re-load in place on switch.
- **Edges**: removing an account that a dynamic list still uses (soft-remove, list keeps working); many accounts (filter by name); removing on touch (Edit/Done).

### A3 Treat a Steam Family as one account

- **Who / goal**: a household sharing a Steam Family wants one merged library.
- **Steps**:
  1. Home
  2. enter one identifier
  3. **Add Steam Family account**
  4. resolve
  5. open Owned
- **Done when**: one account slot with several members; a game anyone owns counts as owned; the copy button copies one identifier per member.

### A4 Reach a friend through my friends list

- **Who / goal**: explore a friend without knowing their Steam identifier.
- **Steps**:
  1. Home, on my account
  2. friends list
  3. explore one
  4. back on Home, their friends list marks mutual friends
- **Done when**: the friend becomes the current account and joins Home's Accounts, so Compare's player boxes offer them next.
- **Or**: 5. select several friends 6. **Compare with me** ◇ 7. lands on C1's result with me plus them, my current account unchanged
- **Edges**: private friends list; a Family's merged friends list; the list's refresh after adding a friend on Steam.

### A5 What kind of player is this?

- **Who / goal**: get a feel for an account's tastes and habits — mine, or a friend's before suggesting a game.
- **Steps**:
  1. Owned (mine, or a friend's via A2 or a `?u=` link)
  2. read Plays mostly and how many played games it's built from
  3. read the profile line: solo, co-op or PvP; whether story games are played through
  4. click the count of games played 2 h or less: it opens Owned's **Play next** view (L5), best Taste fit first
- **Done when**: every figure says what it's counted from, and stays silent rather than guessing below its threshold; software (Wallpaper Engine) counts toward none of it.
- **Edges**: private playtime (no profile, and it says so); fewer than 5 played games; a profile too thin for an archetype or tiles (no empty box); a Family, whose profile mixes its members (no archetype).

## Comparing libraries

### C1 What can we all play tonight?

- **Who / goal**: a group of 2–5 friends wants the games they all own, best-rated first.
- **Steps**:
  1. **Compare**
  2. one player box per friend (pick known accounts or type identifiers; or start from A4's **Compare with me** ◇)
  3. submit
  4. read the "everyone" group
  5. sort by rating, filter by tag (e.g. co-op)
- **Done when**: groups ordered from "all of them" down to "only one"; the URL alone reproduces the comparison; my current account is unchanged.
- **Edges**: one friend private/unknown; a player box holding a Family; **Intersect** in the mode select (Union / Intersect / Subtract / Grouped by membership) for a single flat table.

### C2 What would one purchase unlock?

- **Who / goal**: find games all but one friend own, to decide what that friend should buy.
- **Steps**:
  1. C1
  2. read the group missing exactly one player
  3. sort it by price ◇
- **Done when**: group labels say clearly who is _in_ and who is _missing_; a group missing players carries price columns ◇, so no panel needs opening.

### C3 Keep a comparison

- **Steps**:
  1. C1
  2. **Save as a list**
  3. later, reopen it from Home's tree
- **Done when**: it re-resolves (new purchases show up) and its page states its formula and sources.

### C4 Which of my friends own this game?

- **Who / goal**: I'm looking at one game and want to know who I could play it with.
- **Steps**:
  1. F1
  2. the panel's "Owned by"
  3. it lists my friends who own it ◇
- **Done when**: today "Owned by" covers the current account's own members, or a comparison's players; answering this needs friends' libraries, i.e. one library fetch per friend — check integrations.md's budgets first.

### C5 Can everyone actually run it?

- **Who / goal**: the group from C1 includes a Linux / Steam Deck player.
- **Steps**:
  1. C1
  2. add the ProtonDB column
  3. filter out Borked
  4. pick from what's left
- **Done when**: games with no ProtonDB report are distinguishable from Borked ones.

### C6 Co-op with one friend

- **Who / goal**: find a co-op game we both own that neither of us has worn out.
- **Steps**:
  1. Compare me and a friend
  2. **Intersect**
  3. filter tag co-op
  4. filter low playtime for _both_ of us
- **Done when**: each player has a Played column (`Played (h) · <name>`) to filter on.

### C7 How alike are we, and what should I suggest to them?

- **Who / goal**: two or more friends want to see where their tastes meet and differ, and what one could pass on to another.
- **Steps**:
  1. C1
  2. open **Players**
  3. read each player's top tags and play style, and how many top tags each pair shares
  4. read the shared favourites and the tags in common
  5. **Suggest to** a player: games another played a lot that they never have
  6. open one in the panel
- **Done when**: how alike players are is a count of top tags they share, never an uncalibrated score; each suggestion says who played it, how long, and whether the player owns it.
- **Edges**: a player without a profile (says why); no shared favourites ("none yet"); **Intersect** or **Subtract** (the profiles need whole libraries).

### C8 Present games on a second screen while I browse

- **Who / goal**: the host of a game night shows trailers and screenshots on a second screen to the people in the room, while freely browsing the app on their own; the second screen changes only when they present something, or step through the lightbox steering it.
- **Steps**:
  1. open a game's panel
  2. **P** (or the panel's cast button): the presentation window opens on the panel's media
  3. place it on the second screen (its button, in Chrome or Edge with two screens; else drag it there), click it for fullscreen
  4. browse other games and lists; the presentation doesn't move
  5. pause, play, mute or replay the trailer from the nav bar's chip, which shows what's on the TV
  6. open a media from the panel: the lightbox opens on it, on the TV, the panel marking it "On TV"; ←/→ step the TV through the game's media, ↑/↓ through the list's games; Esc leaves the TV on the last one
  7. click what the nav bar's chip says is on the TV: the lightbox reopens on it, steering the TV again
  8. stop presenting from the nav bar's ×
- **Done when**: the second screen changed only when something was presented, stepped to in the lightbox or controlled from the chip, and stayed fullscreen through it; the nav bar names the game and media presented; nothing's left after stopping.
- **Edges**:
  - the windows: Ctrl+P (the browser's print); pop-ups blocked; the presentation window reloaded, closed or crashed (the nav bar forgets it); the main window reloaded (it remembers), closed or crashed (the presentation closes); P right after reloading the main window (no second window); a second tab of the app (doesn't drive this window); Esc on the presentation; a click in the room (stays fullscreen); placing refused or one screen (the drag, then); placed before (opens there); a phone (no Present button)
  - what's shown: a trailer that fails (says so, in the lightbox too); P again on what's up (no restart, except an ended trailer); the browser refusing sound (muted, says so)
  - the lightbox: P in one not presenting (presents it from where the trailer was, then steers the TV); P in one steering the TV (private: browse without the room seeing, on every open, until P again); a held → or ↓ (the TV gets the first step at once, then only where it stops; a game whose media is still loading, once); a trailer on the TV (its poster here, its controls driving the TV); stop from its pill, or the TV lost (a plain lightbox, nothing starting by itself); keys pressed on the TV (step it, opening it if need be; private, they don't)

## Lists

### L1 Build a manual list

- **Who / goal**: keep a "to play with Alice" shortlist.
- **Steps**:
  1. from any list, select rows
  2. add to a new manual list
  3. name it
  4. put it in a folder
  5. or, while reading one game's panel, **Add to list** there ◇
- **Done when**: the list appears in Home's tree; adding/removing games persists across reloads.
- **Edges**: delete then restore (soft-delete — no restore UI yet, frontend.md's Known gaps); a folder's "Move to…" never offers its own subfolders; a row's ⋯ menu from the keyboard (Esc, Rename, Move and Delete each leave focus on a row's ⋯, or the heading once the tree is empty); an edit the browser can't store (storage full) says so instead of silently snapping back.

### L2 Wishlisted but already owned in the family

- **Who / goal**: prune my wishlist of games someone in my family already has.
- **Steps**:
  1. Home
  2. combine
  3. **Intersect** my Wishlist with the family's Owned
  4. save as dynamic
- **Done when**: default name reads the formula ("Me — Wishlist ∩ Family — Owned"); renaming an account updates it.
- **Edges**: **Subtract** order is visible and reorderable; freezing turns it into a manual list; a source that is itself a dynamic or ranked list; deleting a list another one uses; Recently Looked Up as a source leaves its games outside Steam out, with "(N not on Steam, left out)".

### L3 Customize and keep a table view

- **Steps**:
  1. any list
  2. change columns, sort, group, filters
  3. reload
  4. **Default view**
- **Done when**: the view persists per list kind; reset restores defaults.
- **Edges**: grouping Recently Looked Up by a Steam-only column puts its games outside Steam in a "Not on Steam" group, last.

### L4 Turn lookups into a shortlist

- **Steps**:
  1. look up several games (F1)
  2. Home
  3. **Recently Looked Up**
  4. select the keepers
  5. add to a manual list
- **Done when**: the manual list keeps them after Recently Looked Up moves on.
- **Edges**: a selection with games outside Steam adds the Steam ones and says how many it left out; only those selected, Add says lists hold Steam games only.

### L5 Switch between views of my library

- **Who / goal**: keep "Recently played", "Play next" and "Short games" on Owned, or "Bargains" on Wishlist, and switch between them without filtering again.
- **Steps**:
  1. Owned
  2. **New view**: a suggested view, or **Save as view** for the table as it is
  3. switch views from the tabs under the header
  4. change a view's sort or filters, then **Save** or **Revert**
  5. Home: open a view from the Owned card
- **Done when**: each view keeps its own layout; a friend's Owned opens through the same views; leaving a view drops its unsaved edits; Share view sends the layout, not the view.
- **Edges**: a link to a deleted view; Bargains while prices load; Short games while HLTB loads, and games with no HLTB entry; the tabs on a phone.

## Ranking

### R1 Rank my played games

- **Who / goal**: build a personal top list from my library without ranking all of it.
- **Steps**:
  1. Owned
  2. filter (e.g. played > 5 h)
  3. **Rank N games**
  4. answer pairs with ← / → / ↓ / S / X / Z
  5. stop with Esc halfway
  6. later **Continue: N chosen left** (or **Continue ranking**, for the whole list) on the list page to resume
- **Done when**: no answer lost on stop; the progress bar's estimate shrinks; the list sorts by Rank; **Details** opens the panel without losing the pair.
- **Edges**: Re-rank a selected game; Exclude one, then bring it back; Undo right after resuming; the source gains/loses a game; Change source keeps answers.

### R2 Rank what to buy next

- **Who / goal**: order my wishlist, or a bundle's games, by how much I want them.
- **Steps**:
  1. Wishlist
  2. **Rank this list**
  3. answer using Details (trailer, rating, HLTB) since I haven't played them
  4. sort the ranked list by Rank next to price columns
- **Done when**: the ranked list shows prices and badges like its source; buying a game (it leaves the Wishlist) drops it from the ranking.
- **Edges**: the exclude option reads "Not interested" here, not "Haven't played".

### R3 Share my ranking

- **Who / goal**: send a friend my top 20.
- **Steps**:
  1. ranked list
  2. **Share view** ◇
  3. friend opens it
- **Done when**: the friend sees the order read-only, and can save it or rank the same games themselves; ranked lists can't be shared today.

## Bundles and prices

### B1 Is this bundle worth it for me?

- **Who / goal**: judge a bundle by what it adds to my library and how good those games are.
- **Steps**:
  1. **Bundles**
  2. narrow with "New" / "Ending soon"
  3. open one
  4. check tier price vs. best deals, owned badges, ratings
- **Done when**: owned games are obvious; games with no Steam listing are listed below the table, not dropped.
- **Edges**: no `ITAD_API_KEY` configured (Bundles unavailable — is that explained?); region change reprices; a Fanatical pick-and-mix bundle shows its quantity tiers, prices the selection and links to buying it (★); a tab left open for hours shows stale countdowns (frontend.md, Known gaps).

### B2 Is my wishlist on sale?

- **Steps**:
  1. Wishlist
  2. sort by discount or filter record-low badges (🔥 ★ ☆)
  3. Preferences (gear icon) to set region
- **Or**: step 2 as Wishlist's **Bargains** view (L5).
- **Done when**: prices state their region and age; the refresh on the Prices figure refreshes them only.

### B3 What does this bundle add for the whole household?

- **Who / goal**: judge a bundle against everything my Family or group already owns, not just my own games.
- **Steps**:
  1. open a bundle
  2. **What does this add?** (bundle minus my Owned, unsaved)
  3. **Save as a list**
  4. **Edit sources** to swap in the Family's Owned (or **Group by membership** with a friend's Owned)
- **Edges**: the bundle ends and IsThereAnyDeal stops listing it — the list keeps its last-known games and says so.
- **Done when**: the default name reads the formula; games with no Steam listing are still accounted for.

### B4 Buy a friend a gift

- **Who / goal**: pick something from a friend's wishlist within a budget.
- **Steps**:
  1. explore the friend (A2/A4)
  2. **Wishlist**
  3. sort by best price or filter record lows
  4. open one
  5. check it's not in their Family's library
- **Done when**: prices are in _my_ region, not theirs, and say so; switching back to my account is one click.

### B5 What can I play with PC Game Pass?

- **Who / goal**: a PC Game Pass subscriber wants to know which games on their wishlist they can play without buying them.
- **Steps**:
  1. Home → **PC Game Pass**
  2. check the catalog's region and the games not on Steam
  3. Home's combine form: my Wishlist ∩ PC Game Pass, then save
- **Done when**: rows are the Steam games in my region's catalog; the ones not on Steam are named below the table; the list says Game Pass plays them through the Xbox app; Updated re-fetches the catalog.
- **Edges**: no `ITAD_API_KEY` (says why); the catalog down (says so, Updated retries); a region change reloads the catalog; playing together when one friend owns it on Steam and another has it through Game Pass ◇ (the app doesn't know which games cross-play).

## Finding a game

### F1 Look up one game

- **Who / goal**: check a game's rating, length, Linux support and price before buying.
- **Steps**:
  1. nav search (`/`)
  2. type
  3. pick
  4. read the panel (media, rating, HLTB, ProtonDB, price, owned-by)
  5. ↑/↓ or R to wander
- **Done when**: on a list route the panel opens in place; elsewhere it goes to `/game/:appid`; the game joins Recently Looked Up.
- **Edges**: no match; DLC → base-game link; phone width (panel vs. table); Back closes the panel (and the lightbox over it) before leaving the list.

### F2 Search from the browser address bar

- **Steps**:
  1. add the OpenSearch engine (or a Firefox keyword bookmark on `/search?q=%s`)
  2. type `steam half-life`
- **Done when**: lands on `/search` with the closest match open; the on-page box refines without reopening the panel.
- **Edges**: a Steam game and one outside Steam sharing the exact name (the Steam one opens).

### F3 What should I play next?

- **Who / goal**: pick something from my backlog for tonight, short and well rated.
- **Steps**:
  1. Owned
  2. show the Played column
  3. filter to never played
  4. sort by HLTB (shortest first) or rating
  5. **Pick a random game** (or **R**) for a random pick, or browse with ↑/↓
- **Or**: steps 2–4 as Owned's **Play next** view, or **Short games** for the short ones (L5).
- **Done when**: HLTB and rating fill in without a reload; the random pick draws only from the filtered rows and works on a phone; the filter survives a reload (L3).
- **Edges**: games with no HLTB entry (where do they sort?); a Family account (whose playtime counts?); Plays mostly's **Why these?** on a phone (each tag's games stack under its bar).

### F4 What else did this studio make?

- **Who / goal**: I liked a game; see what else its developer made or its publisher put out, and which of those I don't own.
- **Steps**:
  1. open a game's panel
  2. **More from** → its developer (or publisher)
  3. sort by rating; **What don't I own?** for the ones I don't own
  4. open one in the panel
  5. Back to where I came from
- **Done when**: the list is named for the developer or publisher ("Games by X", "Published by X"); ownership and Taste fit show; the ones I don't own open as a shared list I can save; the panel opens in place; Back returns.
- **Edges**: no game under that exact name; more than Steam's first page (only those are ranked); Steam's store search down; a game with no Steam tags; developer = publisher; a name ending in `.io` or holding a `/`; opened from `/game/:appid`; going from one developer's list to another's; phone width; keyboard only.

### F5 Look up a game that isn't on Steam

- **Who / goal**: someone who also plays on Switch, PS5 or Xbox checks a console game's length and rating.
- **Steps**:
  1. nav search (`/`)
  2. type
  3. pick a result showing its platforms
  4. read the panel (platforms, IGDB rating, HLTB, media)
- **Done when**: the dropdown and the panel show its platforms; HLTB fills in; on a list route the panel opens in place, elsewhere at `/game/igdb:<id>`; the game joins Recently Looked Up, first, and the search box's recents ("Not on Steam" under its name).
- **Edges**: a title also on Steam appears once, as the Steam game; a PC game IGDB doesn't link to Steam shows twice (accepted: no dedup by name, a wrong merge would hide a game), and labelled "Not on Steam" in Recently Looked Up (accepted, same reason); a game IGDB links to Steam opens and is recorded as the Steam game; IGDB down (Steam results, a line saying so, Retry); an instance without IGDB (Steam results only, no failure line; its lookups aren't recorded); ↑/↓ and R across /search's and Recently Looked Up's mixed rows, the lightbox open too; in Recently Looked Up, its Steam-only columns read "n/a" (neither "—" nor ⚠), sort last both ways, and a filter hiding it says so; phone width; a tab opened before this build (its broken recents dropped).

## Media

### M1 Get a feel for a game from its media

- **Who / goal**: before buying or ranking a game, I want to see what it looks like in play, with nothing but the media on screen.
- **Steps**:
  1. open a game's panel
  2. click, tap or Enter its picture
  3. step through its screenshots with ←/→ or a swipe
  4. reach a trailer; it plays
  5. zoom a screenshot to read its interface
  6. close with Esc, ×, Back or a swipe down where there's no list
- **Done when**: the media fills the screen; driven by keyboard, nothing shows but the media and a brief counter after each step; ←/→ keep stepping across a playing trailer; closing lands on the panel showing the last item, focus where it was.
- **Edges**: a game with only its Cover (its media still loading); a refresh that shrinks the media; a slow picture (its thumbnail stands in); reduced motion; the first open's hint.

### M2 Pick tonight's game by its look

- **Who / goal**: browse a filtered list (F3, R2) by screenshots rather than by rows.
- **Steps**:
  1. open the lightbox on a game of the list
  2. ↓ or swipe up through the games
  3. R for a random one
  4. ↑ back to one I liked
  5. close, and the panel is on that game
- **Done when**: every step lands on real media, never on a trailer from a screenshot; the game's name and its place in the list flash briefly, then go; a game paged back to opens on the item last looked at.
- **Edges**: wrapping past either end; no list behind the game (no game stepping, and nothing suggests it); a game whose media are still loading.

### M3 Watch a trailer, on a phone or the couch

- **Who / goal**: watch a game's trailer full screen, with the controls out of the way.
- **Steps**:
  1. open the trailer
  2. go fullscreen (F, or its button)
  3. tap to show the controls; seek, mute, pause with the centre button
  4. tap again to hide them
- **Done when**: a tap toggles the controls and never pauses by itself; targets are 44 px under a finger; a mute is kept for the next trailers; the phone turns to landscape and back after; Esc leaves fullscreen before closing.
- **Edges**: the browser refuses sound (muted, an Unmute button saying so); a double-tap seek, then more taps on that side; an iPhone (the native player); the trailer ends (a replay, no moving on).

## Sharing

### S1 Send a friend a view

- **Who / goal**: show a friend my curated, filtered wishlist.
- **Steps**:
  1. set up the table
  2. **Share view** (carries my account on Owned/Wishlist)
  3. friend opens the link
- **Done when**: the friend sees my account's list with my layout; their own account and saved views are untouched; clicking around keeps the shared account. The link previews in a chat app with the app's name, description and image.
- **Edges**: sharing a dynamic list (`/lists/shared?f=`) → friend saves it; on a ranked or manual-sourced list the button says why it can't share, before it's clicked ◇.

### S2 Link one game

- **Steps**:
  1. panel
  2. Copy link to this game
  3. open elsewhere
- **Done when**: `/game/<appid>` opens for anyone and carries no account.
- **Edges**: a game outside Steam (`/game/igdb:<id>`).

### S3 Open a link from a fresh browser

- **Who / goal**: the recipient of S1, C1 or S2 has never used the app.
- **Steps**:
  1. open the link in a private window
  2. change the view
  3. reload
  4. go Home
- **Done when**: the page works with no local state; their changes are theirs and the link's layout is only the starting point; Home offers no ★ account until they pick one.
- **Edges**: a `/lists/<id>` link to a list that exists only in the sender's browser (what does the dead link say?); reload with `?game=` on a route that doesn't restore it (frontend.md, Known gaps); a developer's or publisher's list, which needs nothing local.

## Sync

### Y1 Same lists on another device

- **Who / goal**: I built lists on my desktop and want them on my laptop.
- **Steps**:
  1. sign in with Steam (nav chip) on both
  2. edit a list on one
  3. reload the other
- **Done when**: first sign-in on a new device never overwrites the account's existing prefs; later edits merge per key, last-write-wins; a changed table view shows the "unsaved changes" banner with Save / Revert instead of syncing silently.
- **Edges**: a list deleted on one device while the other edits it; signing out; signing in as a Steam account other than my ★ one.

### Y2 Losing my browser data

- **Who / goal**: I cleared site data, or switched browsers, and my lists are gone.
- **Steps**:
  1. open the app
  2. Home is empty
  3. sign in with Steam
- **Done when**: if I had synced, everything comes back; if I hadn't, did the app ever suggest syncing before it mattered? There's no export/backup path.

### Y3 Two tabs at once

- **Steps**:
  1. open the same list in two tabs
  2. add a game in one
  3. remove another in the second
  4. reload both
- **Done when**: no silent loss of either edit; today there's no cross-tab sync (lists-and-accounts.md), so this is where one tab overwrites the other.

## Freshness and failures

### D1 "I just bought it — why isn't it here?"

- **Who / goal**: a game I bought an hour ago is missing from Owned; library data is cached for up to 30 days.
- **Steps**:
  1. Owned
  2. notice the **Updated** age
  3. click it
  4. the game appears
- **Done when**: an age older than a few days is highlighted ◇, so the fix is suggested before I wonder; on a dynamic list or comparison, Updated re-fetches every source account.
- **Edges**: a single bundle's page, where the age can't be refreshed (features.md explains why).

### D2 An upstream is down

- **Who / goal**: HLTB, ProtonDB, ITAD or the Steam store fails or rate-limits partway through a large list.
- **Steps**:
  1. open a large Owned or Wishlist
  2. watch the affected column
  3. retry with Refresh details in the panel once the upstream is back
- **Done when**: the failing column says it failed rather than looking empty; other columns and the rest of the table are unaffected; the Refresh details retry works.

### D3 Back after a month

- **Who / goal**: I haven't opened the app in weeks; what changed that I care about?
- **Steps**:
  1. open Home
  2. see what's new since my last visit ◇: wishlist games now at a record low, new bundles containing wishlist games, owned games not yet in my ranking
- **Done when**: each item links to the list that shows it; nothing is stored server-side, so "last visit" lives in localStorage (and Sync).

## Devices and input

### I1 Phone first

- **Who / goal**: on the couch, on a phone, doing A1, C1, F3 or R1.
- **Steps**:
  1. each of those at phone width
- **Done when**: the table stays usable (columns, horizontal scroll); the panel and swipe-to-close work; ranking works by tapping cards, with no keyboard.

### I2 Keyboard only

- **Steps**:
  1. `?`
  2. `/` to search
  3. ↑/↓ through the table
  4. ←/→ through the panel's media
  5. Esc
  6. rank a pair with keys only
- **Done when**: focus is always visible and never trapped; Esc closes the innermost thing first.
- **Edges**: Home's tree, every row's actions behind one ⋯ menu (L1's edge); the lightbox opens with no focus ring until Tab and shows no controls while driven by keyboard, only a brief counter after each step; Ctrl/⌘/Alt shortcuts stay the browser's.

### I3 Screen reader

- **Who / goal**: someone who can't see the screen finds their way around a page and an open game by its structure.
- **Steps**:
  1. jump by landmark: banner, Main navigation, search, main, the open game
  2. jump by heading: one h1 naming the page, the sections below it
  3. fill a form; each field says what it's for
  4. open a game; jump through its sections by heading
  5. open and close the shortcuts dialog, the lightbox (and the shortcuts over it), the nav menus and a list's ⋯ menu on Home; focus returns where it was
- **Done when**: every page has one h1 and no skipped heading level; every navigation and complementary landmark is named; every control is a native element, or has a role, name and state.
- **Edges**: a hidden achievement reveals from the keyboard; the lightbox's counters say what they count; Esc closes only the innermost dialog; copying a link is announced.

## Running an instance

### O1 Self-host and keep it healthy

- **Who / goal**: someone deploying their own instance for a group of friends.
- **Steps**:
  1. set the keys in `.env` (see `default.env`; `ITAD_API_KEY` for Bundles and prices)
  2. start
  3. use it
  4. check `GET /api/metrics` and the log warnings
- **Done when**: a missing optional key disables only its feature, and the UI says so; metrics show outbound usage against its budget before an upstream starts refusing (observability.md).
