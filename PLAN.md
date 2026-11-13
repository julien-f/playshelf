# Plan — doc review fixes

Branch `docs-review` (worktree `.claude/worktrees/docs-review`), one commit per step, each closing its C-items in `docs/dev/code-backlog.md`. Deleted before the merge.

- Steps 1–2 (wrong facts, About) are cherry-picked onto `main` as ordinary commits (About with a CHANGELOG Fixed entry), so the user-visible fix doesn't wait on the reorganisation.
- Steps 3–9 merge with `--no-ff` via `node scripts/merge.js`, one CHANGELOG Development entry ("Reorganise the developer docs"). Comment-only edits in `public/`/`lib/` need no entry on the branch.
- In scope: C323–C332, C335–C337. Deferred: C333 (features.md rewrite, own plan), C334 (trimming; trim its padded-tables part, done by step 7), P74 (backlog housekeeping).
- Order: wrong facts first, then the index, the splits, then dedup and history over the new layout so each fact moves once.

## Every step's checks

- `npm run format`; `node scripts/doc-refs.js` (checks `](file#anchor)` links in docs, skills, CLAUDE.md, README — not code comments, prose mentions, or a link whose topic moved).
- For each doc a step splits or re-heads: `grep -rn '<doc>.md' public lib server.js scripts e2e test default.env .claude docs CLAUDE.md`, and repoint by topic.
- The pre-commit hook reruns check steps; `public/` changes also run typecheck, lint and desktop e2e.

## 1. Statements the code contradicts — C323, C324 (→ main)

- Each C323 bullet corrected in place; numbers replaced by a link to their owner (`PREFS_RATE_LIMIT_MAX` in default.env).
- Stale `public/panel.js` comments in `lib/steam.js` and `lib/itad.js:463`: name the current consumer.
- pitfalls.md: merge fix → `scripts/merge.js`; EADDRINUSE fix → `node scripts/dev-server.js up`; lockfile entry's symptom generalised to any main-checkout commit.
- testing.md: one flake procedure (the `--repeat=24` one), one `page.clock` popup bullet.

## 2. About — C325 (→ main, user-visible)

- Tests first, seen failing:
  - Unit (`test/aboutSources.test.js`): every `createTrackedFetch('<group>')` name in `lib/` maps to an About source whose name appears in `public/AboutRoute.tsx` (steam-api/steam-reviews → Steam Web API, steam-store/steam-browse → Steam Store, steam-openid → Steam sign-in, hltb, protondb, itad, fanatical, gamepass → Microsoft); an unmapped group fails — the root cause of Fanatical and Game Pass going missing.
  - e2e `S3 edge: About names every data source…`: add `Fanatical` and `Microsoft` (exact `<strong>` text); the What's stored section (`locator('section', { hasText: "What's stored" })`) contains "Sign in with Steam" and not "no accounts".
- Text (glossary terms: account, Recently Looked Up, Sign in with Steam, Best Deal, Pick & mix, PC Game Pass; "saved layouts and views", not "settings"), written so C270's privacy page can lift it:
  - Sources: Steam Web API (incl. wishlist, friends list, achievements, news), Steam Store (incl. package and bundle contents), Steam sign-in (password stays with Steam), HowLongToBeat, ProtonDB, IsThereAnyDeal (bundles, prices, Best Deal, matching to Steam), Fanatical (Pick & mix tiers), Microsoft (PC Game Pass catalog). All asked by the server; images and trailers load from Steam directly.
  - What's stored: the server cache (public data of every account looked up, expiring on its own — durations per the open choice below); after Sign in with Steam: Steam ID and sign-in times, a session cookie, the synced accounts (incl. Steam IDs added), lists, rankings, statuses, Recently Looked Up, region, saved layouts and views; signing out ends the session but keeps the synced copy (ask to have it deleted); the browser's copy stays until the site's data is cleared; chat apps keep their own link previews. No passwords, ads, analytics or tracking.
  - Intro disclaimer also names IsThereAnyDeal, Fanatical and Microsoft.
- C270 gains: no server-side deletion route, and the only removal channel is a public GitHub issue.
- Run `npm run test:one test/aboutSources.test.js`, `npm run test:e2e -- --project=phone -g About`.

## 3. One doc index — C330 (index part)

- `scripts/doc-lint.js` `INDEXES = ['CLAUDE.md']` (and `test/docLint.test.js`); README keeps the user-doc links and one line pointing at CLAUDE.md's index. Done first so steps 4–6 add each new doc to CLAUDE.md only.

## 4. Bundles and prices out of integrations.md — C327

- New `docs/dev/bundles-and-prices.md`, opening "everything behind `ITAD_API_KEY`" + trust-tier link: ITAD (bundles, resolving, prices, currency), Fanatical, Humble Choice, Game Pass, moved as is, headings already spelled "Pick & mix"; it owns the confirmed pricing rules and assumptions.
- integrations.md: real `## Trust tiers` (the two tiers, live-site use) and `## Request volume and pacing` (young-game refetch line, link previews' zero upstream cost, breakers, pacing) headings; keeps Steam, HLTB, ProtonDB; TOC rewritten.
- "IsThereAnyDeal › Rate limiting" → architecture.md's Rate limits.
- Frontend detail: `hltbAll`, demo banner, capsule sizes → game-table.md / panel-and-lightbox.md; `flattenBundleGames`, `loadPrices`, `formatMoney`, currency fields → game-table.md (owner of the bundle page), upstream fact kept.
- CLAUDE.md: index line "before changing bundles, prices, Fanatical, Humble Choice or PC Game Pass"; integrations line narrowed; the "record confirmed rules and assumptions" bullet names both docs; CLAUDE.md:34 and skills link `#trust-tiers`. `code-audit/SKILL.md` compliance dimension names both docs.
- Repoint: `lib/itadDates.js`, `lib/earlyExpired.js`, `lib/humbleChoice.js`, `lib/fanatical.js`, `lib/itad.js`, `public/fanaticalPicks.ts`, `public/priceLoading.ts`, `public/utils.ts`, `public/ListRoute.tsx`, `server.js` (ITAD limiter → architecture), `test/fanatical.test.js`, `test/frontend-utils.test.js`.

## 5. Presentation window and app shell — C328

- New `docs/dev/presentation.md` with the BroadcastChannel messages as a table (direction · message · meaning); `.app-scroll`, Back to top, `StorageFullBanner` → a frontend.md "Shell" section; `--panel-w` and `#the-side-panel` (cited by `e2e/panel-contract.spec.ts`) stay.
- CLAUDE.md index line; frontend.md module map's presentation routing; repoint `public/presentation.ts`, `public/PresentationView.tsx`, `public/AppShell.tsx`. Restate P70's measure (it counts panel-and-lightbox.md reads).

## 6. Taste model doc — C326

- New `docs/dev/taste.md` from game-table.md (Owned's profile, Players, Taste Fit, Group Fit, Similarity) and panel-and-lightbox.md (Similar in library): `tagTaste.ts`, `playerProfile.ts`, `PlayerProfile.tsx`. Taste storage stays in lists-and-accounts.md, "How alike two players are" in decisions.md, both linked. CLAUDE.md index line; C178 points here.

## 7. game-table.md structure — C329

- `## The game table`: Column set · Columns per kind · Default sort and grouping · Prices (incl. Price Status, bucket grouping, `loadPrices`) · Failed and refused sources · Scores (Tag Match, Similarity wiring; Taste/Group Fit link taste.md) · Layouts and saved views.
- `## Each list kind in practice` (anchor kept, 4 inbound links): The hero · Bundle page · Comparison · Other kinds · `/bundles`.
- Saved views written new from `public/listViews.ts` (`VIEW_TEMPLATES`, `suggestedTemplates`) and `ViewTabs.tsx`; frontend.md's and lists-and-accounts.md's lines stay.
- No hand-written TOC (frontend.md's already misses Icons and Motion; dropped too).

## 8. One owner per fact — C330, C331

| Fact                                          | Owner                                             | Others                                                              |
| --------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| Refresh details                               | data.md#refresh-paths (what it forces)            | panel doc: the button; frontend.md: the `info.refetching` mechanism |
| `morph`                                       | frontend.md#motion                                | panel doc: what morphs, link                                        |
| `?u=` forwarding, copy-link, `recentAccounts` | lists-and-accounts.md `?u=` semantics             | frontend.md one line per param; game-table.md link                  |
| Client context middleware                     | observability.md                                  | architecture.md one line + link                                     |
| Fanatical feed rules / Pick & mix pricing     | bundles-and-prices.md                             | game-table.md link                                                  |
| Feed TTL, `tagnames:` expiry                  | data.md                                           | link                                                                |
| Hook staged-paths rule                        | testing.md#hooks                                  | CLAUDE.md links                                                     |
| User-list hero example                        | game-table.md                                     | lists-and-accounts.md link                                          |
| Young-game refetch                            | data.md#cache-tiers (rule); decisions.md (sample) | integrations.md one line                                            |
| Link previews                                 | architecture.md                                   | integrations.md zero-cost line                                      |
| Row store                                     | frontend.md Rows                                  | Reactivity links                                                    |

- C331: data.md's Cache tiers table keeps its heading and first two columns (`test/cacheTiersDoc.test.js` parses them), drops Default and the Reason text default.env states; configuration.md drops defaults; README's check steps → `steps()` in scripts/check.js; port literals (testing.md, `ux-fix`/`ux-review` SKILL.md, dev port included) → `node scripts/ports.js`; "phone width" defined once in ui-guidelines.md; dev docs name constants.

## 9. Current behaviour only — C332

- Each listed passage rephrased as the present rule and its why; dated upstream observations that justify a rule stay.

## 10. Process docs, gaps, glossary — C335, C336, C337

- Four topical pitfalls → their docs (exact error text kept; `public/styles/components.css` comment repointed to frontend.md); two non-pitfalls deleted; pitfalls cited by `scripts/background-server.js`, `scripts/merge.js`, CLAUDE.md and `ux-fix` stay.
- testing.md: Checks subsection (doc-refs, doc-lint); CLAUDE.md's testing line widened (skill evals, perf).
- journeys.md: title grammar → testing.md, one linked line left; answered review questions restated as expected behaviour; Y2/Y3 get `◇ U<n>` filed in improvements.md in the same commit (`check:journeys`) or are marked non-goals; intro and `#who-uses-it` untouched.
- architecture.md: `lib/upstream.js` exports, `/assets` immutable caching, `/opensearch.xml`, the final JSON error handler, `/api/health`'s body; one "Sign-in" section in lists-and-accounts.md (server and client), data.md's sessions bullet cut to the schema.
- glossary.md: Pick & mix (Avoid: pick-and-mix; rename in `docs/` only — not URLs, cache keys, screenshots, released CHANGELOG), New to you, Tier Price, Status, Similarity, Price Status; U265 replaced by the mark's description.

## Before the merge

- `/code-review` over `main..docs-review`, then the user's go-ahead.
