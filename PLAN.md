# Subscriptions in the side panel — branch `panel-subscriptions`

The panel's Price card lists the subscriptions a game is in (Game Pass, EA Play, Ubisoft+…), next to its bundles. Source: ITAD's `POST /games/subs/v1` (sanctioned tier). Chosen by the user over our own PC Game Pass catalog (untrusted, heavy cold load) and a Game Pass-only filter.

## Confirmed upstream behavior (live probes, 2026-11-22)

- `POST /games/subs/v1?country=XX`, body: gids → `[{ id: gid, subs: [{ id: number, name: string, leaving: string|null }] }]`; a gid in no subscription is left out of the reply.
- Subs seen: 2 EA Play, 3 EA Play Pro, 4 Ubisoft+ Premium, 5 Ubisoft+ Classics, 6 Game Pass.
- ITAD's Game Pass matches 508 of the 509 games in our FR PC Game Pass catalog; it also counts EA Play titles that Game Pass includes (Battlefield 2042), which `/lists/game-pass` doesn't list. So the panel shows ITAD's name ("Game Pass"), never "PC Game Pass".
- Assumption: the 200 gid batch limit of the other ITAD POSTs applies here too. One gid per call today, so nothing depends on it.

## Steps (one commit each)

1. **Merged per-game route** (backend, plus the frontend's URL and type):
   - `lib/itad.js`: `getGameSubs(gid, { country, force })` cached at `itad-gamesubs:<country>:<gid>`. The bundles tier (`lib/cache.js`), `BUNDLES_CACHE_TTL_MINUTES`. Its own shape check: keep `{ id: integer, name: string }` entries, `leaving` kept only when `Date.parse` accepts it (else `null`), ITAD's order; `[]` when the reply leaves the gid out, and a non-array reply throws `upstreamError`.
   - `server.js`: `GET /api/game-bundles/:appid` → `GET /api/game-offers/:appid` → `{ bundles, subscriptions: [{ id, name, leaving }] }`. Bundles and subs are fetched in parallel. A subs failure degrades to `subscriptions: null` with a `[itad] game subs: …` warning (not cached, so retried), keeping the bundles; a bundles failure stays a 502. No gid → both `[]`, no calls. `gameBundlesLimit` → `gameOffersLimit`, which skips only when both keys are cached. `?refresh=1` forces both.
   - `public/panelData.ts`: `PanelBundles` → `PanelOffers = { bundles, subscriptions } | null`, with the `GameSubscription` type. The cache and resource are renamed `bundles` → `offers`, and `panel.tsx` reads `.bundles` from it (it renders no subscriptions yet).
   - Tests: test/server.test.js (the game-bundles block renamed: subs shape, the gid left out → `[]`, malformed entries and unparseable `leaving` dropped, subs failure → bundles with `subscriptions: null` then a retry calling only subs, the non-array-200 test covering subs, refresh forces both), test/itad.test.js if it covers the per-game getters, test/server-ratelimit-skips.test.js (skip needs both keys), test/panelData.test.js (URL/shape), test/cache.test.js (tier). e2e/mockApi.ts route and fixture rename.
   - Docs: architecture.md route row, bundles-and-prices.md (503 list, the new `/games/subs/v1` entry with the confirmed rules above), data.md cache row.
2. **Render subscriptions** (UI, test-first e2e):
   - `PanelBundleLines` → `PanelOfferLines`: one `<li>` per subscription above the bundles, in one `<ul role="list">` rendered when either is non-empty; an icon not already used in the panel, "In <name>", plain text (no link: ITAD's Game Pass includes EA Play titles `/lists/game-pass` lacks). A `leaving` date gets "leaves <date>" in the bundles' "ends" format and urgency colors.
   - Silent when there are no subscriptions. "Not in any current bundle." keeps its meaning, bundles only. `subscriptions: null` adds "Subscriptions: IsThereAnyDeal didn't answer.".
   - e2e: the mock puts appid 620 in Game Pass (leaving computed from now, +40 days) and Ubisoft+ Classics. A new F1 edge test, "panel lists the game's subscriptions, Game Pass linking to its list", and 892970 shows none. Existing bundle edges adjusted for the new wording.
   - Docs: glossary.md "subscription" row, panel-and-lightbox.md Sections, features.md side panel line, journeys.md F1 edge, CHANGELOG (via the merge).

## Out of scope

- A subscriptions column, filter or list on tables (batch-shaped `getGameSubs` then).
- Links for subscriptions: Game Pass → `/lists/game-pass` only once the game is confirmed in the cached PC catalog; others have no stable page.
- A "I subscribe to…" preference.
