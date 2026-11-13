# Playshelf

Live at [steam.isonoe.net](https://steam.isonoe.net).

Explore Steam libraries as lists of games — one account's owned games or wishlist, a bundle, or a list you build yourself — with ratings, completion times and current prices in one sortable table.

Combine lists to answer the questions Steam can't: what two friends both own, what's on your wishlist but already owned by someone in your family, what a bundle adds that you don't have yet. Steam Families are supported as a single merged account.

![A bundle's games in the sortable table — tier price, best deal, weighted rating, completion time — with one game's detail panel open beside it](docs/images/list-table-and-panel.png)

[Setup](#setup) · [Development](#development) · [Documentation](#documentation)

- [What the app does](docs/user/features.md) — the full feature tour
- [Configuration](docs/user/configuration.md) — every setting

## Setup

Requires Node.js 22.15 or later.

```bash
echo "STEAM_API_KEY=your_key_here" > .env   # only required setting
npm install
npm run build          # bundle the frontend to dist/
npm start              # http://127.0.0.1:3000
```

Get a Steam API key at <https://steamcommunity.com/dev/apikey>. An optional `ITAD_API_KEY` ([get one](https://isthereanydeal.com/apps/my/)) enables bundle browsing, price columns and the PC Game Pass list; everything else works without it. All settings and their defaults are documented in `default.env` — put overrides in `.env`.

## Development

```bash
npm run dev             # Vite on :58991 + Express on :3000, together
npm run dev:mock        # Vite alone (port: node scripts/ports.js mock), /api mocked from the e2e fixtures — for UI work
npm run check           # every check (steps() in scripts/check.js), in parallel, one line each, output only for failures
npm test                # Node's test runner
npm run test:e2e        # the journeys' tests in a browser, against mocked data (first: npx playwright install chromium)
npm run typecheck       # tsc --noEmit over public/ and e2e/
npm run lint            # eslint-plugin-solid over public/
npm run format          # Prettier over the whole tree
```

Open `http://localhost:58991` in dev (not `:3000` — that serves the last `npm run build`).

Tests, the mocked server and the git hooks (`npm install` enables them; `pre-push` runs what CI runs) are in [testing.md](docs/dev/testing.md).

Application data lives in `db.sqlite` (gitignored); it holds the upstream caches plus signed-in users, their sessions and synced settings. `npm run cache:clear` empties the cache tables without deleting the file or touching accounts.

## Documentation

### User

- [features.md](docs/user/features.md) — what the app does, feature by feature, with screenshots
- [configuration.md](docs/user/configuration.md) — every setting worth setting, and what the rest default to

### Development

The developer docs are indexed, each with when to read it, in [CLAUDE.md](CLAUDE.md#where-things-are-documented).

Screenshots used by the docs live in [docs/images/](docs/images).

`CLAUDE.md` holds the working conventions for this repo (style, git and development workflow).
