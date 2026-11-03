# WIP: multi-platform (games outside Steam)

Status of this branch while it's suspended. Delete this file before merging.

## Done

- IGDB client (`lib/igdb.js`, Twitch client credentials `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET`), `GET /api/igdb-game/:igdbId`, IGDB data cached with the normal tiers (decision and IGDB FAQ quote in `docs/dev/integrations.md`).
- Mixed game key: a Steam game stays its numeric appid, a game outside Steam is `igdb:<id>` (`public/gameKey.ts`).
- Search merges Steam's and IGDB's results; an IGDB hit linked to Steam (itself, or a remaster/port) shows as the Steam game.
- Side panel for `igdb:` games (`public/IgdbPanel.tsx`): landscape artwork hero, platforms, IGDB rating, HLTB, screenshots.
- Trailers: YouTube-only from IGDB, played in a youtube-nocookie embed driven by the lightbox's keys (IFrame Player API over postMessage); F fullscreens the YouTube iframe itself (no overlay allowed over YouTube's player).
- Games outside Steam join Recently Looked Up: search box recents and the `/game` table (Steam-only columns show "n/a", sorted last, filter note); left out of combined lists, rankings and shares with a count.

## Before merging

- The owner tests it by hand and approves the merge explicitly. Open hand checks, in real Firefox with a real video:
  - after a click into the player, Space/M/←/→ reach the lightbox (the fix is a 100 ms focus poll; root cause unproven, see `docs/dev/pitfalls.md`);
  - F fullscreens with no black bars; Esc or YouTube's F gives the keys back;
  - YouTube's cursor hides while playing (headless showed `cursor: none`).
- Merge `main` in first: its docs reorganisation (merge 611b5bb) split `docs/dev/frontend.md` into `game-table.md` and `panel-and-lightbox.md`. This branch's `frontend.md` hunks in moved text conflict: keep main's side, then re-apply them in the new files (the recent column list, the "Failed sources"/"A refusal" lines, the IGDB panel and media lines). `doc-refs`/`doc-lint` won't flag a missed line. In `CLAUDE.md`'s docs list keep main's wording.
- `CHANGELOG.md` entry on the `--no-ff` merge.
- Delete this file.

## Found on the way (not this branch's)

- `test/gameColumns.test.js` "Released year grouping" fails under `TZ=America/Los_Angeles` on main: an ISO date is parsed as the day before. To record in `docs/dev/code-backlog.md`.

## Next step, after merging

- Console trailers in our native player, YouTube as the fallback: Nintendo (`assets.nintendo.com` MP4/HLS, `Access-Control-Allow-Origin: *`) and PlayStation Store (`vulcan.dl.playstation.net` MP4, no CORS) expose trailer files in their product pages' data; undocumented (untrusted tier), terms unchecked, needs IGDB → store matching. Extracting YouTube streams is ruled out: googlevideo refuses our origin (CORS) and YouTube's terms forbid it.
- Later: lists, statuses and the play journal for games outside Steam; a one-off, local import of the owner's PSN/Nintendo play history.
