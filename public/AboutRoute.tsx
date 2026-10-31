// /about — ported verbatim from the legacy about.html (no logic of its own there either, just
// static content) as part of the SPA route table (see docs/dev/frontend.md).
import { createResource, Show } from 'solid-js';
import { useBaseTitle } from './pageTitle.ts';
import { ListHero } from './ListHero.tsx';
import { fetchJson } from './utils.ts';

export default function AboutRoute() {
  useBaseTitle(() => 'About');
  // Unknown (health unreachable) says nothing rather than guess.
  const [health] = createResource(() =>
    fetchJson<{ igdbConfigured?: boolean }>('/api/health', undefined, 'Health check failed').catch(() => null),
  );

  return (
    <div class="container">
      <ListHero title="About" />

      <section>
        <h2>About</h2>
        <p>
          Playshelf compares Steam libraries across players and helps you browse a single library, with ratings,
          playtime, and completion-time estimates. It's a small personal project, not affiliated with or endorsed by
          Valve, Steam, HowLongToBeat, or ProtonDB.
        </p>
      </section>

      <section>
        <h2>Data sources</h2>
        <ol class="how-steps">
          <li>
            <strong>Steam Web API</strong> (Valve) — profile info (name, avatar), owned games, and playtime for any
            player you look up, plus store review scores used to compute ratings.
          </li>
          <li>
            <strong>Steam Store</strong> — store metadata (description, screenshots, genres, release date), user tags,
            and the "look up any game" search box's name results. Uses unofficial storefront endpoints.
          </li>
          <li>
            <strong>HowLongToBeat</strong> — estimated time to complete a game. Fetched from an unofficial endpoint;
            estimates may occasionally be missing or stale if that changes.
          </li>
          <li>
            <strong>ProtonDB</strong> — community reports of how well a game runs on Linux and the Steam Deck (the
            Linux/Deck tier). Fetched from an unofficial endpoint.
          </li>
          <li>
            <strong>IsThereAnyDeal</strong> — current Steam bundle listings and prices, on the Bundles page. Requires a
            free API key; the page shows a clear message if one isn't configured.
          </li>
          <li>
            <strong>IGDB</strong> (Twitch) — games outside Steam (PlayStation, Switch, Xbox…) in the search box's
            results, and their details in the side panel. Requires free Twitch API credentials.
            <Show when={health()?.igdbConfigured === false}> This instance has none, so it searches Steam only.</Show>
          </li>
        </ol>
      </section>

      <section>
        <h2>What's stored</h2>
        <p>
          Only public Steam profile data (Steam ID, name, avatar, owned games/playtime) and the ratings/tags/
          completion-time estimates above are cached temporarily to keep the site fast — cached entries expire
          automatically, from an hour for library data up to a few weeks for slower-changing data like ratings and tags.
          Nothing else is collected: no accounts, no passwords, no analytics or tracking, and no data is shared with
          anyone beyond the API calls needed to show you the page.
        </p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>
          Questions, or want data related to your profile removed from the cache? Open an issue on{' '}
          <a href="https://github.com/julien-f/playshelf/issues">GitHub</a>.
        </p>
      </section>
    </div>
  );
}
