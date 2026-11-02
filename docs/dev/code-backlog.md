# Code backlog

Code findings from `code-audit` runs, judged against CLAUDE.md's conventions and the docs each dimension names. Severity: **critical** (exploitable, or loses or corrupts data) · **major** · **minor** · **cleanup** (no behaviour change); effort S/M/L. Fix items with the `code-fix` skill; remove an item once it ships.

Last audited: simplify 2026-10-11 · correctness 2026-10-11 · security 2026-10-23 · perf 2026-10-28 · reliability 2026-10-10 · compliance 2026-10-10 · tests 2026-10-10 · docs 2026-11-01; backend only (`server.js`, `lib/`), every dimension: 2026-10-31.

- [Simplify](#simplify)
- [Correctness](#correctness)
- [Security](#security)
- [Performance](#performance)
- [Reliability](#reliability)
- [Compliance](#compliance)
- [Tests](#tests)
- [Docs](#docs)

## Simplify

- **C173 · minor · M** — `public/ListRoute.tsx`'s column, default-visible and sort choices are three nested ternary chains over 8 list kinds (`columns`, `defaultVisible`, `sort` in `load()`); each new kind adds a level to all three. A per-kind lookup table would state each kind's set once.
- **C174 · minor · L** — three unsaved dynamic lists with their own URL grammar, entry point and save path: `/lists/compare?u=&op=`, `/lists/shared?f=` and a bundle's "What does this add?". A comparison is `f=group-by-membership:(o:…;o:…)`: fold compare into `shared` (redirecting legacy `?u=&u=` links) and `ComparePlayersForm.tsx` into `CombineForm.tsx` with a "someone's Owned" source, dropping `compareNaming`, compare's canonical rewrite and `compareListView`. Behaviour change: needs a reviewed plan.
- **C175 · minor · M** — `myAccount` (★) is vestigial: `public/myOwnership.ts:17` keeps it "unused… in case it's wanted later"; only the star UI, comparison player order (`public/ListRoute.tsx:2152`), `AccountFriends.tsx` and sign-in auto-fill read it. Drop it, or derive "me" from the signed-in account, leaving one account notion (current, plus `?u=`).
- **C177 · minor · M** — soft-delete (`deletedAt`/`removedAt`, the sweep) duplicates the dangling-source handling the formula hero already has: hard-delete and flag the source, or refuse the delete naming the referencing lists. Likewise `orphanBundle`/`orphanOf` could fall back to the bundle snapshot on a 404 as on any other failure, instead of converting it to a manual list.
- **C178 · cleanup · M** — Taste fit and a comparison's Group fit are one score at different arities (Group fit: the least-suited player's). One "Fit" column, per account or min over players, would be one notion.
- **C191 · cleanup · S** — `public/combine.ts:62` holds a literal NUL byte inside a string, so editing tools refuse the file (a fix had to move `isCombineOp` to `public/listsStore.ts` instead). Write it as the `\0` escape.
- **C192 · cleanup · M** — the combine op set is stated three times: `OP_LABELS` (`public/listLabels.ts`), `COMBINE_OPS` in `public/listsStore.ts` (for `isCombineOp`) and a differently shaped `COMBINE_OPS` in `public/CombineForm.tsx`. Move the op table to a small module both stores import (`public/listLabels.ts` importing `public/listsStore.ts` rules out the direct way).
- **C193 · cleanup · M** — the panel's More links menu hand-rolls window-capture Esc, outside-click and focus-leave closing (`public/panel.tsx`), a second copy of what `bindNavPopover` (`public/navPopover.ts`) does, already diverged. Make it a native popover bound with `bindNavPopover`.
- **C268 · cleanup · S** — `isGamePassCached` (`lib/gamepass.js`) repeats `getGamePass`'s walk (catalog → `catalogGids` → `splitEntries` → title keys) over the cache; only the key builders are shared, so a change to the walk must be made twice. One walk parameterized by "fetch" vs. "peek the cache" would state it once.

## Correctness

- **C194 · minor · S** — a list stored or synced with an unknown combine op before `isCombineOp` existed still fails to resolve on every device: nothing checks `op` when lists are read back (`public/listsStore.ts`). Drop or repair such a list on load, with a `[lists]` warning.
- **C195 · minor · S** — `fmtLastPlayed` (`public/utils.ts:289`) gives the UTC day while Released and the Taste fit date use `fmtLocalDate`'s local day: a game played at 20:00 in UTC-8 shows tomorrow's date. Use `fmtLocalDate`.
- **C222 · minor · S** — `trackedFetch` (`lib/metrics.js`) counts a call in the lifetime `requests` when it starts but adds its latency and status when it ends, so `sinceRestart`'s `avgLatencyMs` reads low during a burst of slow calls (HLTB), and `requests` exceeds its status counts plus network errors, unlike `lastHour`, which counts on completion. Count completed calls the same way in both.
- **C201 · minor · S** — the Demo column's filter list labels both values "Demo": the checklist formats the stringified raw value, and `format` (`public/gameColumns.ts:1145`) treats the truthy string `'false'` as a demo. Compare against `'true'` there, or give the column a `value` getter returning its label.
- **C236 · minor · S** — the tag-name map (`fetchTagNameMap`, `lib/steam.js`) is kept for the meta TTL (365 days), so tags Steam adds meanwhile are dropped by `resolveSteamTags` for up to a year. Refetch on a cooldown when a browse item has an unknown tagid.
- **C273 · minor · S** — list labels (`createDefaultNaming`) and the Taste fit source are read when `ListRoute` loads, so an account renamed meanwhile shows its new persona only on the next load.

## Security

- **C181 · minor · S** — no Content-Security-Policy, so any XSS through upstream text runs uncontained; the other headers come from the live proxy ([architecture.md](architecture.md#build-and-serving)). Set a strict CSP (`script-src 'self'`, Steam CDN images) in `server.js`, checking what inline styles, the Steam/ITAD images and the HLS video hosts need.
- **C182 · minor · S** — `GET /api/me` (`server.js:1249`) has no rate limit and `getSessionUser` parses the account's whole prefs (up to `PREFS_MAX_BYTES`) on every call: a signed-in client hammering it blocks the event loop. Put it behind a limiter; have auth read only the session row and load prefs only where returned.

## Performance

Baseline for these items (2026-10-28, a 1196-game account, warm cache, real dev server): details stream 0.38 s server-side, 7.0 MB raw / 1.3 MB gzip; `/lists/owned` first rows 170 ms–1.2 s with one 270–320 ms long task while the stream lands; JS heap 92 MB. Measured 2026-10-30 (production build, fresh browser; phone = 390×844, CPU ×4, 1.6 Mbps / 150 ms; lightbox with 1080p JPEGs and a real HLS trailer on the mock): Owned's phone load first row 6.0 s, full list 15.9 s; a 15-game cold list first row 5.1 s.

- **C211 · minor · M** — `getAppDetails` (`lib/steam.js:440`) caches Steam's raw store page, ~20 KB a game (49.5 MB of the 80 MB `db.sqlite`), ~59% of it never read (descriptions, requirements, the achievements list, ratings, package groups): a warm stream reads and parses 24 MB, ~66 ms (Node bench). Drop those keys before caching; old rows shrink on their next fetch.
- **C213 · minor · M** — the same account's owned games and wishlist are re-fetched by every caller, with no session cache or in-flight dedupe in `public/accountData.ts`: Home (`HomeRoute.tsx:156`), Owned/Wishlist (`ListRoute.tsx:2606`), dynamic-list sources (`listResolve.ts:218`) and `myOwnership.ts:92` each fetch their own, so Home → Owned → open a game downloads and parses the 138 KB library three times. One promise per members key, shared, replaced by a refresh (which also refreshes the ✓/☆ sets, stale after a refresh today). Measured on a phone Owned load: fetched twice, ~1.4 s of the link.
- **C214 · minor · M** — every visit to `/lists/owned` re-streams all details (7 MB) and redoes C205's end-of-load work (`public/ListRoute.tsx:2885`): Owned → Home → Owned pays it twice. A session cache of details by appid, cleared by ↻, so a load streams only what's missing.
- **C218 · minor · S** — a lightbox game step preloads only within the game: on 4G, ↓ to a game not yet seen shows ~250 ms of nothing, then the thumb, sharp at ~650 ms. Preload the landing item of the next and previous game when their media are already fetched; fetching them for it would raise appdetails volume ([integrations.md](integrations.md)'s trust tiers).
- **C219 · cleanup · S** — `RankRoute` is imported eagerly (`public/AppRoot.tsx:21`), ~3 KB gzip in `main` for a route reached only from a ranked list. Lazy-load it like `ListRoute`.
- **C220 · cleanup · S** — the stream sends `tags` alongside `tagWeights`, whose keys it repeats (`server.js:795`, 267 KB raw per 1196 games). Derive `tags` client-side (`public/ListRoute.tsx:717`, `public/panel.tsx:2165`).
- **C226 · minor · M** — a phone's list load runs as a chain: main.js (2.2 s), then the lazy `ListRoute` chunks (4.3 s), then `/api/common-games` (5.3 s), then the stream; `panel.tsx` and `lightbox.tsx` (~71 KB raw) sit in `main`. Modulepreload `ListRoute`'s chunks on `/lists/*`, start the library fetch before the route chunk, lazy-load panel and lightbox (savings inferred).
- **C228 · minor · S** — the phone's Owned load fetches ~100 thumbnails for 99 games (1.3 MB) vs 47 on desktop: each stream flush reorders the first page by Weighted Rating, so rows pass through view and load their image, sharing 1.6 Mbps with the 628 KB stream (9.8 s vs ~3.1 s pure transfer). Defer row thumbnails until the stream settles, or tighten the lazy margin.
- **C229 · minor · M** — a lightbox game step still costs layout and script on a phone: a held ↓ over 40 steps at CPU ×4 drops ~8 frames (median, dev build, 390×844), the panel behind it unrendered. Left: `syncLbZoomBtn`'s `offsetWidth` read right after each render (`lightbox.tsx`), and the art tint's image load and `getImageData` per game (`panel.tsx`, keep the tint unchanged on close rather than re-setting it). Measure with a trace split before changing either.
- **C232 · cleanup · S** — `/favicon.svg` is re-requested on every lightbox step (39 times in a 1.5 s held key, headless Chromium), served with max-age 0 by `express.static` (`server.js:251`); cause of the re-checks inferred (each `replaceState`). Give it a max-age.
- **C249 · minor · M** — tags are fetched with one `IStoreBrowseService/GetItems` call per game (`fetchStoreBrowseItem`, `lib/steam.js`), though it takes many ids (`dropDemos` sends 10): a cold 1196-game load spends 1196 untrusted-tier calls where ~24 would do. Batch uncached appids over a short window into one call, one `browse:` row each. Assumes ~50 ids per call works (seen with 10): confirm and record in integrations.md.
- **C272 · minor · S** — a row opened before its list's price batch lands prices itself in the panel: `priceSource` (`public/panel.tsx`) is still the appid then, so the panel's request duplicates the batch's (both cached server-side).

## Reliability

- **C168 · minor · S** — `pushPrefToServer` (`public/prefs.ts`) treats any response as success: a 429 (`authLimit`) or 413 (over the 2 MB cap) is neither logged nor retried until the next sign-in merge, so a pref change can silently stay local. Check `res.ok`, log with the `[prefs]` tag and re-schedule the key's push.
- **C169 · minor · M** — `.githooks/pre-commit:10` sets aside only tracked unstaged edits; an untracked file the commit lacks (a new module) still lets the checks pass. Set untracked files aside too, per worktree (not `git stash -u`, shared across worktrees).
- **C1 · minor · M** — dependency updates wait on a manual `dependency-audit` run. Dependabot or Renovate could open them, since CI (`.github/workflows/ci.yml`) runs `check` and the e2e suite on PRs, but their PRs lack the `CHANGELOG.md` entry the pre-commit hook requires (CI doesn't check it) and skip `npm run build`, so each still needs a local pass through dependency-audit's Applying.
- **C190 · minor · M** — a shared `?f=` or compare link with many account sources fires all their `/api/common-games` calls at once (`resolveListWithSources`, `public/listResolve.ts:152`): past `SEARCH_RATE_LIMIT_MAX` they 429, the whole list fails, and the viewer's search budget is spent for a minute. Dedupe and cap sources at decode with a clear message, or resolve with bounded concurrency.
- **C200 · minor · S** — an achievements rarity call refused by the client share (`server.js:1029`) only sets `rarityFailed`, so the panel shows the generic rarity failure, not the share message `achievementsRefusal` (`public/panelData.ts`) shows on a 429. Rethrow on `isClientBudgetExhausted` so the route answers 429.

## Compliance

- **C270 · minor · S** — the site has no privacy page, though Valve's API terms ask for a privacy policy on non-public end-user data and for telling users what Steam data is stored ([steamcommunity.com/dev/apiterms](https://steamcommunity.com/dev/apiterms)); `AboutRoute.tsx` only disclaims affiliation. Add one: what is cached and for how long ([data.md](data.md)), the synced prefs, and that chat apps keep their own copy of a link preview.
- **C271 · minor · S** — no `robots.txt`, so a crawler that runs JavaScript and follows links can open `?u=` pages and drive Steam requests through the app. `Disallow: /lists/`, after checking that WhatsApp's and Slack's preview fetchers ignore it.
- **C221 · minor · S** — `getProtonDbStatus` is called for every appid (`server.js:737`), DLC, soundtracks and hardware included; the cache holds `null` for all 49 such rows, so ~2% of calls to an undocumented upstream are certain misses. Chain it off the meta lookup like HLTB and skip non-played types — once confirmed ProtonDB never has reports for them (inferred from the cache), recorded in integrations.md.
- **C40 · minor · S** — players `GetPlayerSummaries` omits are never cached (`lib/steam.js` `fetchPlayerBatch`), so a deleted or invalid account in a friends list is re-requested on every load. Cache the omission briefly once it's confirmed Steam omits only ids that really don't exist (not transiently); record that in integrations.md.

## Tests

- **C234 · minor · M** — two phone zoom e2e tests fail now and then under load, with or without data-table 0.21.0 and the 2026-10-31 zoom-button fix: "M1 edge: on a phone, a double-tap zoom leaves the controls as they were" 1–3 in 60 (`lb-idle` after `page.clock.runFor(500)`, `not.toHaveClass(/lb-idle/)`) and "F1 edge: a screenshot shown below its size zooms from a visible button, or Z" 1–3 in 60 (`node scripts/e2e-flakes.js --repeat=60 --load=24 --workers=12 --project=phone -g zoom`, load ~48–57 on 12 cores, 2026-10-31). Keep a failure's trace and find what each raced.
- **C202 · minor · M** — the presentation window's own 10 s close (a main-window reload keeps it; a `bye` without `main` closes it, `PresentationView.tsx`'s `mainGone`) is untested: its clock is real, so the e2e can't wait it out cheaply. Install fake timers in the popup through `e2e/presentationHooks.ts` and test both.
- **C198 · minor · S** — no mock game has the Steam Workshop category (`e2e/mockApi.ts`), so the panel's Workshop link is untested. Give one fixture game that category and assert the link.

## Docs

None open.
