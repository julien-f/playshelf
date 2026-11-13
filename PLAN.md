# Plan: UX follow-ups (branch `ux-followups`, on `design-docs-merge`)

Recommendations after the design-docs work, reviewed by a frontend, a testing and a UX agent. One commit per step, closed by `git merge --no-ff`. Deleted before the merge.

## Dropped

- **Firefox e2e**: not now (user's call).
- **Usage metrics behind the personas**: production's `inbound` counts API routes, every client route is the same app shell, and volume is a handful of requests a day. One line under journeys.md's _Who uses it_ says so; no tracking added.

## 1. Mock fixtures — `e2e/mockApi.ts`, `e2e/fixtures.ts`

- Avatars: all three fields, absolute URLs from `url.origin` (`safeHref` keeps only `http(s)`); `/api/mock-media` delays only under `slow-media`.
- Public friends by default: Alice = [Bob, Carol, Dave], Bob = [Alice, Carol] (Mutual), entries in server.js's shape; others private, `unavailable` as steamids.
- `frank`, a private profile: common-games 400 with server.js's message, wishlist 200 empty with `communityvisibilitystate: 1`, friends unavailable.
- Search `tinyImage` (some results without, for F2's no-image case) and bundles' `assets.banner145`.
- Tests to adapt: A1's "Friends (private)" → a friendless player; A2 edge's chip initial → a player without avatar; F2 edge's image-less search.
- improvements.md: _Review tooling_ drops what exists or is added (keeps non-EUR prices, static wishlist); _Not yet reviewed_ drops A4.

## 2. U252 wording — `public/`, e2e, docs

- **Share view** → **Share layout** (tooltip: "Copy a link to this list as you see it: account, columns, sort, filters"), **Default view** → **Reset layout**; "Recently looked up" → "Recently Looked Up"; columns Taste Fit, Group Fit, Tag Match (prose that names them too). Labels aren't keys: stored layouts and links unaffected.
- Every locator and doc the frontend review listed; glossary and ui-guidelines follow; CHANGELOG Changed.

## 3. U246 Compare from the friends list — `AccountFriends.tsx`

- A checkbox per friend (`aria-label="Select <name>"`, ≥ 24 px), none on the current account's own Family members; selection a `Set` signal; at most 5 friends (C1's group), the rest disabled with the reason in text.
- **Compare with <account label> (N)** beside the list's ↻ meta line → `compareUrl([current slot, ...selected])`; the current slot passed as a primitive prop. Lands on the comparison; Back (and Edit players) undo; a `?u=` explore is left by the compare URL, Back returns to it.
- e2e: `A4.5-7`, the member exclusion, the cap, Back. ◇ U246 dropped (A4, C1); U246 closed; features.md; CHANGELOG Added.

## 4. U249 Add to list from the panel — `panel.tsx`, `listsStore.ts`, `ListRoute.tsx`

- An icon button (ListPlus) after Present in the panel's icons, opening a menu of checkbox items, one per manual list (checked = holds the game; click toggles, saved at once), then **New list…** (name, creates with the game). Trigger shows the count when in any list.
- The More menu's open/close machinery generalised to one `openHeaderMenu` signal, not copied. The "Added N games to …" logic moves to a listsStore helper both use.
- Viewing a manual list and toggling its game from the panel reloads that list.
- ux-measure the header at 390 px. e2e: `L1.5`, toggle off on the viewed list, `/game` with no list. ◇ U249 dropped; U249 closed; features.md, panel-and-lightbox.md; CHANGELOG Added.

## 5. UX review as personas

- `ux-review` on mocks: the core journeys plus A4, L1, L3, L5, at both widths; findings in improvements.md.

## Status (paused 2026-11-13)

- Done: metrics note, 1 (fixtures), 2 (U252 renames). Next: 3 (U246), 4 (U249), 5 (review).
- At the merge: CHANGELOG Changed (the renames), Added (U246, U249).
- Machine load: run with the session capped (`systemctl --user set-property --runtime <scope> CPUQuota=800% CPUWeight=10 IOWeight=10`); every commit's hook runs desktop e2e.
