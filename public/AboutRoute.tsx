// /about — static content; test/aboutPage.test.js keeps its sources and durations in step with lib/ and default.env.
import { useBaseTitle } from './pageTitle.ts';
import { ListHero } from './ListHero.tsx';

export default function AboutRoute() {
  useBaseTitle(() => 'About');

  return (
    <div class="container">
      <ListHero title="About" />

      <section>
        <h2>About</h2>
        <p>
          Playshelf compares Steam libraries across players and helps you browse a single library, with ratings,
          playtime, and completion-time estimates. It's a small personal project, not affiliated with or endorsed by
          Valve, Steam, HowLongToBeat, ProtonDB, IsThereAnyDeal, Fanatical or Microsoft.
        </p>
      </section>

      <section>
        <h2>Data sources</h2>
        <ol class="how-steps">
          <li>
            <strong>Steam Web API</strong> (Valve) — name and avatar, owned games and playtime, wishlist, friends list
            and achievements for any account you look up, plus each game's review score and news.
          </li>
          <li>
            <strong>Steam Store</strong> — store pages (description, screenshots, trailers, genres, release date), user
            tags, package and bundle contents, and the "look up any game" search box's name results. Uses unofficial
            storefront endpoints.
          </li>
          <li>
            <strong>Steam sign-in</strong> — confirms your Steam ID when you Sign in with Steam. Your password stays
            with Steam.
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
            <strong>IsThereAnyDeal</strong> — bundles, current prices and Best Deal, and matching bundle and PC Game
            Pass games to Steam. Requires a free API key; the page shows a clear message if one isn't configured.
          </li>
          <li>
            <strong>Fanatical</strong> — Pick &amp; mix tier prices and end dates. Fetched from an unofficial feed.
          </li>
          <li>
            <strong>Microsoft</strong> — the PC Game Pass catalog for your region, and the names of its games not on
            Steam. Fetched from unofficial endpoints.
          </li>
        </ol>
        <p>
          This site's server makes all of these requests, not your browser — except game images and trailers, which load
          straight from Steam.
        </p>
      </section>

      <section>
        <h2>What's stored</h2>
        <ul>
          <li>
            <strong>On this site's server, for everyone:</strong> a cache of what the sources above return, including
            the public Steam data of every account looked up (name, avatar, owned games and playtime, wishlist, friends
            list, achievements). Each entry expires on its own — within a year at most, within a month for libraries,
            wishlists and friends lists — and is fetched again only if someone asks.
          </li>
          <li>
            <strong>If you Sign in with Steam:</strong> your Steam ID and when you signed in; a sign-in cookie that
            lasts 30 days without a visit; and what syncs across your devices — your accounts (including the Steam IDs
            of accounts you added), lists, rankings, game statuses, Recently Looked Up, region, and saved layouts and
            views. Signing out ends the session but keeps the synced copy; ask below to have it deleted.
          </li>
          <li>
            <strong>In your browser:</strong> the same accounts, lists and layouts, in this site's local storage. They
            stay after you sign out, until you clear the site's data.
          </li>
          <li>
            <strong>In chat apps:</strong> a shared link's preview (an account's name and avatar, or a game's or list's
            title) is kept by the chat app, even after the profile changes.
          </li>
        </ul>
        <p>
          No passwords, ads, analytics or tracking, and nothing is shared beyond the requests needed to show you the
          page.
        </p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>
          Questions, or want data related to your profile or your synced copy removed? Open an issue on{' '}
          <a href="https://github.com/julien-f/playshelf/issues">GitHub</a>.
        </p>
      </section>
    </div>
  );
}
