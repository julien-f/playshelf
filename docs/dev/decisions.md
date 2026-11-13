# Decisions

Choices that look wrong without their reasoning: the numbers this app derives itself rather than reading off an upstream (columns in `public/gameColumns.ts`, lines in the side panel — see [game-table.md](game-table.md) and [panel-and-lightbox.md](panel-and-lightbox.md)), and tooling choices.

## Ratings — Wilson score vs. Weighted Rating

- **Wilson Score** (hidden by default): the Wilson score lower bound at 95% confidence, computed server-side in `getGameRating`/`computeRating` from Steam's review counts. Never replace it with positive/total: that lets 2 positive reviews outrank 50,000 mostly positive ones.
- **Weighted Rating** (default-visible, default sort): `computeSteamdbRating(positive, total)` in `public/utils.ts`, client-side from the same counts — `p − (p − 0.5) × 2^(−k × log₁₀(n + 1))`, `p = positive/total`, `n = total`, `k = STEAMDB_RATING_SHRINK_STRENGTH`. A shrinkage toward 50% that fades with review volume; always between 50 and `p`, approaching `p` monotonically.
  - Adapted from SteamDB's formula ([steamdb.info-issues#793](https://github.com/SteamDatabase/steamdb.info-issues/issues/793)), which uses `k = 1` (90% over 100 reviews → 80%). This app uses `k = 2` (→ ~87–88%), converging faster — a tuning choice, so don't expect parity with SteamDB.
  - Returns the unrounded value: round only for display, so the column sorts deterministically between equal displayed integers. Grouping buckets it like every score column (`scoreBucket` in `public/gameColumns.ts`), not on the raw value.
  - `computeSteamdbRating` and the `steamdbRating` row key keep their names: renaming the key would break shared view links (`?tv=`) that sort or filter on it.
- **Steam %**: the raw ratio, hidden by default.
- **The side panel** shows only the Weighted Rating, as one chip linking to the game's Steam reviews and captioned with the raw ratio and review count ("Weighted · 99% of 465k") — no Wilson score, no Steam summary tier ("Very Positive"). A table showing Wilson Score beside the panel reports two different numbers for the same game: expected.

## Ratings — Steam purchasers' reviews, from the store browse batch

- **Population**: the ratings count reviews from Steam purchasers only, as Steam's own store score does (key activations left out), from the store browse item's `reviews.summary_filtered` (`review_count`, `percent_positive`) — not `GetAppReviews`' all-purchase counts. Built by C275 ([code-backlog.md](code-backlog.md)); until then `getGameRating` still counts every purchase.
- **Why** (2026-11-13, 32 games, one pass of each endpoint):
  - Paid games' browse counts are 0.45–1.00× the all-purchase totals (median 0.80); free-to-play games' are equal (`counts_all_purchases`). Language and the off-topic filter explain none of the gap: both sources are all-language and off-topic-filtered.
  - Above 1k reviews the Weighted Rating moves ≤ 1.8 points (median 0.4); below, up to 17 (3d Bridges 37.6 → 20.6, A Long Way Home 61 → 75): key reviews on small games swing either way, and those are the least reliable. The Weighted Rating's shrinkage already handles small counts.
  - Steam's word differs on 5 of 32 games, and the browse one is the word the store page shows.
  - One browse call covers 50 games, against one `GetAppReviews` call per game.
- **Costs**: browse's whole-number percent moves a rating by up to 0.5 point (±1 displayed on some games), and positives become `review_count × percent / 100`, an estimate the Wilson Score also reads.
- **Not a hybrid** (browse above 1k reviews, all purchases below): one column would rank games measured two ways, a game would jump at the threshold, and the extra reviews would land only on small games, where they're least reliable.
- The review variants (U196–U199) stay panel-only, one `GetAppReviews` call per opened game, until a volume review (P76).

## Production Tier — a heuristic, not Steam-provided data

Steam has no budget or studio-size field, so "Production Tier (est.)" (hidden by default) is a best-effort AAA/AA/Indie guess, `computeProductionTier` in `public/utils.ts`, from three signals every row already has:

- `meta.isFree`/`meta.priceInitial` — the undiscounted price in USD cents (`getAppDetails` pins `cc=us`);
- `rating.total` — review count, a reach proxy;
- whether a Metacritic entry exists — press coverage skips most indie releases.

Decision order:

1. DLC (`meta.fullgame` set) and non-game types (`dlc`/`demo`/`music`/`video`/`series`/`episode`/`mod`/`hardware`/`advertising`) → `null`: a cheap DLC of a AAA game would read as Indie, and looking up the parent costs a fetch.
2. Free-to-play → judged on review volume alone, against a high bar (`FREE_AAA_REVIEW_THRESHOLD`).
3. Paid with no known price → `null`.
4. From `AAA_PRICE_CENTS` → AAA. From `AA_PRICE_CENTS` → AA with `AA_REVIEW_THRESHOLD` reviews or a Metacritic entry, else Indie. Below it → Indie whatever the reviews (Vampire Survivors, Stardew Valley, Terraria stay Indie).

It is also one dimension (`tier:<tier>`, weight 1) of `tagTaste.ts`'s tag vectors, so Similar in this list and Group Fit weigh budget, which no Steam tag says; Plays mostly never shows it.

- **No publisher/developer allowlist**: it would be the strongest signal, but needs externally maintained knowledge (name variants, acquisitions, spin-offs); the heuristic stays self-updating from Steam's data.
- **Accepted misclassifications**: cheap rereleases of old AAA IP, prestige-priced niche sims from small studios, veteran-founded studios shipping a small polished game. Hence "(est.)" in the label.

## How alike two players are — a count, not a score

- A comparison's Players section says how many of their top 10 tags two players share (`tagTaste.ts`'s `commonGround`), not a similarity score.
- A raw cosine of two play profiles is high for almost any pair (common tags dominate even after IDF), so "65% similar" can mean "typical".
- Centering it needs a typical player to subtract. The only one available is built from the compared players' own libraries, and players mostly own what they play: with two players it's their midpoint, so any pair comes out opposite (two players sharing 11 of 12 games scored −0.98).
- A count states a fact the shared tags beside it explain, and needs no calibration. A score could come back once there are enough libraries to calibrate it against.

## Young games — refetched as they age

- Why [data.md](data.md#cache-tiers)'s half-age rule: on production's cache (2026-11-08), of 30 games released in the last 6 months and refetched, those cached in their first ~9 days changed review label (4 of 13), ProtonDB tier (9 of 13) or gained HLTB times (5 of 13); those cached later barely moved, except HLTB times resting on few submissions.
- Its cost: [integrations.md](integrations.md#request-volume-and-pacing).

## Trailers — native HLS where the browser has it

- `playHls` (`public/hlsPlayer.ts`) hands the stream to the browser when `canPlayType('application/vnd.apple.mpegurl')` says it can (Safari, Firefox for Android), and loads hls.js only otherwise.
- Firefox for Android's own player then picks the quality, and stays low: 480p for a whole 60 s trailer on a Galaxy S10 over Wi-Fi, never climbing (2026-10-31). hls.js reached 1080p from the start on the same phone, landscape lock intact.
- Kept native anyway: no visible difference on a phone screen, about 4× the data (Steam's 1080p variant is 5.8 Mbit/s vs. 1.4 for 480p, and hls.js buffered up to 140 s ahead vs. ~10 s), hls.js's ~130 KB gzipped on the first trailer, and the fullscreen orientation workaround (`holdLbTrailerForFullscreen`, [lightbox.tsx](../../public/lightbox.tsx)) tested only with native playback across a step.

## Linting: Babel, not typescript-eslint

- `eslint.config.mjs` parses with `@babel/eslint-parser`: TypeScript 7 (`tsgo`) ships no JavaScript compiler API, so `@typescript-eslint/parser` can't run here, and its peer range refuses `typescript@7`. None of the Solid rules are type-aware, so a syntax-only parser loses nothing.
- `eslint-plugin-solid` still pulls `@typescript-eslint/utils` for its helpers; `package.json`'s `overrides` point those packages' `typescript` peer at the root spec, silencing the `ERESOLVE` warnings without changing what loads.
- The `@babel/*` packages are explicit devDependencies rather than relying on `vite-plugin-solid` hoisting them.
