# Plan: design docs (branch `design-docs`)

Fill the gaps in the UX design docs: personas, core journeys, tracked ◇ targets, a glossary, and ui-guidelines.md kept to judgment rules. Reviewed by a UX and a docs-tooling agent. Deleted before the merge.

## 1. Personas — `journeys.md`

- `## Who uses it` after Goals / Non-goals, derived from the journeys' _Who_ lines (says so), each with an evidence line. Named, no ids (`P<n>` is setup-backlog's prefix; `[A-Z]\d+` is a journey id):
  - **Curator**: own library, wishlist, backlog, rankings, deals, gifts.
  - **Game-night host**: a group of 2–5 friends; what we all own and can run; a TV.
  - **Household**: a Steam Family; one merged library, bundles for everyone.
  - **Link recipient**: follows a friend's link with no local state; the app's first impression.
  - **Instance admin**: self-hosts; an operator, out of design reviews beyond O1.
- Traits, not personas: Linux/Deck, phone, keyboard, screen reader. Journeys for conditions (I1–I3, M1–M3, D2, Y1–Y3) stay untagged = everyone.
- `**Who / goal** (Game-night host):` — nothing parses that line.
- U216's dangling `P1` dropped. CLAUDE.md's plan-review line points at the personas.

## 2. Core journeys

- journeys.md's intro names them: A1, C1, F1, F3, B1, S1, S3.
- `ux-review`: always in the default walk; a finding there ranks above one of the same severity elsewhere.

## 3. ◇ targets tracked

- Rule: a ◇ names its U-item (`◇ U229`). File the untracked ones, graded by what the user does today (scale in improvements.md). C4 filed as blocked on a volume review (like U168). B5's cross-play: no data source → a plain edge, no ◇.
- `journey-coverage.js`: collect ◇ on every line of a journey section (steps, one-line Or, Done when, Edges), intro exempt; `--check` fails on a ◇ without a U-id or with one not open in improvements.md (`^- \*\*(U\d+) ·`); `--targets` lists them. Tests in `test/journeyCoverage.test.js`.
- Closing an item then requires dropping or re-pointing its ◇ in the same commit: say so in ux-fix's SKILL.md and BATCH.md; ux-review's "◇ is a known target" line points at the item.

## 4. `ui-guidelines.md` keeps judgment rules

- Lucide import rules → frontend.md `## Icons`; ui-guidelines keeps `## Icons` (architecture.md links it) with the rules about meaning.
- `CollapsibleCard` measurements → panel-and-lightbox.md; motion helper inventory → frontend.md's Module map. Keep the Motion, Type, Colour section names (code comments cite them); repoint `viewTransition.ts:3` if needed.

## 5. Glossary — `docs/dev/glossary.md`

- Table: term on screen · meaning (one line + link, never a formula) · code name · avoid. Defines view vs layout, the three refresh words, player/account/member, Exclude/Not interested/Haven't played, tier, Best Deal, Present/On TV, etc.
- Wording section gains a capitalization rule and an error-message pattern (what happened, then what to do), and links the glossary. Mismatches found in the UI become U-items; doc slips fixed in place.
- Indexed in CLAUDE.md and README.md.

## 6. Scope — Goals / Non-goals

- Add the constraints that drive decisions, linking their source: no server-side user data beyond cache and opt-in sync; request volume bounded by unsanctioned upstreams; defaults over preferences; cross-play unknown.

## Not done

- A screen map (Routes table + features.md cover it); a Declined section (add with the first decline).

## Commits

One per section; one `### Development` changelog entry at the merge.
