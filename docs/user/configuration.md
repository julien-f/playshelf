# Configuration

All settings live in environment variables. `default.env` (committed) lists every one with its default and an explanation — it is the reference; this page covers what you actually need to set.

Create `.env` (gitignored) with only the values you want to override:

```
STEAM_API_KEY=your_key_here
```

- **`STEAM_API_KEY`** — the only required setting. Get one at <https://steamcommunity.com/dev/apikey>. The server exits at startup with a clear message if it's missing.
- **`ITAD_API_KEY`** — optional, enables bundle browsing, every price column and the PC Game Pass list. Without it those surfaces are hidden, with a line saying why, and the rest of the app runs normally. Get one by registering an app at <https://isthereanydeal.com/apps/my/>.
- **`TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET`** — optional, both needed to search and open games outside Steam (PlayStation, Switch, Xbox…) through IGDB. Without them, search covers Steam only and the About page says so. Get them by registering an application at <https://dev.twitch.tv/console/apps> (IGDB's [getting started](https://api-docs.igdb.com/#getting-started)).
- **`HOST`/`PORT`** — where the server binds; `127.0.0.1:3000` by default. `npm run dev` proxies to them too.
- **`TRUST_PROXY`** — set it (usually `1`, the number of proxy hops) when running behind a reverse proxy, so rate limits apply per visitor and link previews and sign-in use the proxy's `https`. Unset by default.
- **`DB_FILE`** — path to the SQLite database (`db.sqlite` by default). Set it empty to run entirely in memory.

Everything else in `default.env` is a limit or a lifetime with a sensible default:

- **Rate limits** (`*_RATE_LIMIT_MAX`, `MAX_USERS`, `STREAM_MAX_GAMES`, `STREAM_CONCURRENCY`, `STREAM_MAX_PER_IP`) — per-client request budgets, how much work one request may queue, and how many game lists one client may load at once.
- **Outbound budgets** (`OUTBOUND_HOURLY_MAX`, `OUTBOUND_DAILY_MAX`) — a hard ceiling on requests this app makes to each third-party service per hour and per day, protecting an API key's quota no matter how many clients are asking. `0` disables.
- **Client share** (`OUTBOUND_CLIENT_SHARE_PERCENT`) — how much of each outbound budget one client (an IP address, or an IPv6 /56) may spend, so one visitor can't use it up for everyone; past it, that visitor's new lookups are refused until the window rolls over. `0` disables.
  - A cold library costs about 2 Steam store calls per game not yet cached, so a client's share covers about `OUTBOUND_HOURLY_MAX × share ÷ 2` such games an hour (default.env's values: about 1,250).
  - Behind a reverse proxy without `TRUST_PROXY`, every visitor is the proxy's address: they all share one client's share.
- **Upstream pacing** (`STORE_MIN_INTERVAL_MS`, 500; `UPSTREAM_MIN_INTERVAL_MS`, 1000) — the pause before a request slot is reused: Steam's store, then HLTB, ProtonDB and Steam's store browse API. Leave them: lowering them raises traffic to undocumented endpoints.
- **Cache lifetimes** (`*_CACHE_TTL_MINUTES`) — how long each kind of upstream data is kept. They're generous on purpose; every screen that shows cached data says how old it is, and the age itself is the button that fetches fresh.
- **Session lifetime** (`SESSION_TTL_DAYS`) — how long "Sign in with Steam" lasts before signing in again.

`npm run cache:clear` empties every cache table without deleting the database.
