import { For, Show, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import BookOpen from 'lucide-solid/icons/book-open';
import Building from 'lucide-solid/icons/building';
import Compass from 'lucide-solid/icons/compass';
import Handshake from 'lucide-solid/icons/handshake';
import Play from 'lucide-solid/icons/play';
import Swords from 'lucide-solid/icons/swords';
import Users from 'lucide-solid/icons/users';
import { STATUS_LABELS, type GameStatus } from './gameStatuses.ts';
import { creatorTitle, type CreatorRole } from './creatorData.ts';
import type { Archetype, Creator, StoryGames } from './playerProfile.ts';
import type { PlayedTag } from './tagTaste.ts';
import { fadeInOnLoad, fmtHours, roundHours } from './utils.ts';

const ARCHETYPE_ICONS = { 'book-open': BookOpen, compass: Compass, handshake: Handshake, swords: Swords, users: Users };

export function ProfileBadge(props: { archetype: Archetype; small?: boolean }): JSX.Element {
  return (
    <span class="profile-badge" classList={{ 'profile-badge--small': props.small }} aria-hidden="true">
      <Dynamic component={ARCHETYPE_ICONS[props.archetype.icon]} />
    </span>
  );
}

// Without a Steam avatar, the player's initial on a colour of its own, by position in the comparison.
const AVATAR_COLOURS = ['--kind-tag', '--kind-category', '--kind-genre', '--kind-devpub'];
export function PlayerAvatar(props: { url?: string; label: string; index: number }): JSX.Element {
  return (
    <Show
      when={props.url}
      fallback={
        <span
          class="player-avatar"
          style={{ background: `var(${AVATAR_COLOURS[props.index % AVATAR_COLOURS.length]})` }}
          aria-hidden="true"
        >
          {Array.from(props.label)[0]?.toUpperCase()}
        </span>
      }
    >
      {(url) => <img class="player-avatar" src={url()} alt="" width="36" height="36" ref={fadeInOnLoad} />}
    </Show>
  );
}

const pct = (weight: number) => `${Math.round(weight * 100)}%`;

// Each tag a filter button carrying its weight as a bar; the % is said, not only drawn.
export function TagBars(props: {
  tags: PlayedTag[];
  isActive: (tag: string) => boolean;
  onTag: (tag: string) => void;
  detail?: (tag: PlayedTag) => JSX.Element; // under its bar, e.g. Why these?'s games
}): JSX.Element {
  return (
    <ul class="profile-bars">
      <For each={props.tags}>
        {(played, i) => (
          <li>
            <button
              type="button"
              class="profile-bar"
              classList={{ active: props.isActive(played.tag) }}
              aria-pressed={props.isActive(played.tag)}
              title={`Filter by ${played.tag}, ranked by Tag Match · ${i() === 0 ? 'the top tag' : `${pct(played.weight)} as strong as ${props.tags[0].tag}`}`}
              onClick={() => props.onTag(played.tag)}
            >
              <span class="profile-bar-name">{played.tag}</span>
              <span class="profile-bar-track">
                <span style={{ width: pct(played.weight) }} />
              </span>
              <span class="visually-hidden">{pct(played.weight)}</span>
            </button>
            {props.detail?.(played)}
          </li>
        )}
      </For>
    </ul>
  );
}

function StoryRing(props: { story: StoryGames }): JSX.Element {
  const reached = () => props.story.reached.length;
  const total = () => reached() + props.story.fellShort.length;
  const circumference = 2 * Math.PI * 19;
  return (
    <svg
      class="profile-ring"
      viewBox="0 0 48 48"
      role="img"
      aria-label={`${reached()} of ${total()} story games played for their main story's length`}
    >
      <circle class="profile-ring-track" cx="24" cy="24" r="19" />
      <circle
        class="profile-ring-arc"
        cx="24"
        cy="24"
        r="19"
        stroke-dasharray={`${(circumference * reached()) / total()} ${circumference}`}
        transform="rotate(-90 24 24)"
      />
      <text x="24" y="28" text-anchor="middle" aria-hidden="true">
        {reached()}/{total()}
      </text>
    </svg>
  );
}

export interface ProfileGameInfo {
  name: string;
  art: string | null;
  hours: number;
  main: number | null; // How Long To Beat's main story, hours
  status?: GameStatus | null; // set by the player, deciding over hours
}

const STORY_GAMES_SHOWN = 5;

// A game's store art: a chip's thumbnail, or `large` for a comparison's games.
export function GameArt(props: { art: string | null; large?: boolean }): JSX.Element {
  return (
    <img
      src={props.art ?? undefined}
      alt=""
      width={props.large ? 150 : 46}
      height={props.large ? 56 : 17}
      loading="lazy"
      ref={fadeInOnLoad}
    />
  );
}

// A played game in Why these?'s evidence, opening its panel.
function GameChip(props: {
  appid: number;
  name: string;
  hours: number;
  art: string | null;
  onGame: (appid: number) => void;
}) {
  return (
    <button type="button" class="profile-chip" onClick={() => props.onGame(props.appid)}>
      <GameArt art={props.art} />
      {props.name} <span class="profile-chip-hours">{fmtHours(props.hours)}</span>
    </button>
  );
}

const CREATOR_GAMES_SHOWN = 3;
const CREATOR_ROLES = [
  { role: 'developer', key: 'developers', label: 'Developers' },
  { role: 'publisher', key: 'publishers', label: 'Publishers' },
] as const;

export type FavouriteCreators = Record<'developers' | 'publishers', Creator[]>;

// Each studio filters the table, as the panel's pills do, beside a link to its list of games (More from's);
// Why these? adds the played games behind it.
function CreatorsTile(props: {
  creators: FavouriteCreators;
  whyOpen: boolean;
  href: (role: CreatorRole, name: string) => string;
  isActive: (role: CreatorRole, name: string) => boolean;
  onFilter: (role: CreatorRole, name: string) => void;
  game: (appid: number) => ProfileGameInfo | undefined;
  onGame: (appid: number) => void;
}): JSX.Element {
  return (
    <div class="profile-tile profile-creators">
      <span class="profile-label">
        <Building /> Favourite studios
      </span>
      <For each={CREATOR_ROLES.filter((r) => props.creators[r.key].length)}>
        {(r) => (
          <div class="profile-creators-role">
            <span class="profile-creators-label" id={`profile-creators-${r.role}`}>
              {r.label}
            </span>
            <ul aria-labelledby={`profile-creators-${r.role}`}>
              <For each={props.creators[r.key]}>
                {(creator) => (
                  <li>
                    <button
                      type="button"
                      class="profile-creator"
                      classList={{ active: props.isActive(r.role, creator.name) }}
                      aria-pressed={props.isActive(r.role, creator.name)}
                      title={`Filter Owned by ${creator.name}`}
                      onClick={() => props.onFilter(r.role, creator.name)}
                    >
                      {creator.name}
                    </button>{' '}
                    <span class="profile-creator-count">{creator.appids.length} games</span>{' '}
                    <a href={props.href(r.role, creator.name)} class="profile-creator-link">
                      {creatorTitle(r.role, creator.name)} →
                    </a>
                    <Show when={props.whyOpen}>
                      <div class="profile-bar-games">
                        <For each={creator.appids.slice(0, CREATOR_GAMES_SHOWN)}>
                          {(appid) => (
                            <Show when={props.game(appid)}>
                              {(g) => <GameChip appid={appid} {...g()} onGame={props.onGame} />}
                            </Show>
                          )}
                        </For>
                        <Show when={creator.appids.length > CREATOR_GAMES_SHOWN}>
                          <span class="profile-more">+{creator.appids.length - CREATOR_GAMES_SHOWN} more</span>
                        </Show>
                      </div>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </div>
        )}
      </For>
    </div>
  );
}

// Story games with their hours against their main story's length, reached ones then those short of it.
function StoryList(props: {
  story: StoryGames;
  game: (appid: number) => ProfileGameInfo | undefined;
  onGame: (appid: number) => void;
}): JSX.Element {
  const groups = () => [
    { label: "Reached the main story's length", appids: props.story.reached, reached: true },
    { label: 'Fell short', appids: props.story.fellShort, reached: false },
  ];
  return (
    <div class="profile-story">
      <For each={groups().filter((g) => g.appids.length)}>
        {(group) => (
          <>
            <span class="profile-label">{group.label}</span>
            <For each={group.appids.slice(0, STORY_GAMES_SHOWN)}>
              {(appid) => (
                <Show when={props.game(appid)}>
                  {(g) => (
                    <button type="button" class="profile-story-game" onClick={() => props.onGame(appid)}>
                      <span class="profile-story-name">
                        <GameArt art={g().art} />
                        {g().name}
                      </span>
                      <span class="profile-story-track" classList={{ reached: group.reached }}>
                        {/* No main story left (details refreshed since): an empty bar, not NaN%. */}
                        <span style={{ width: `${g().main ? Math.min(100, (100 * g().hours) / g().main!) : 0}%` }} />
                      </span>
                      <span class="profile-story-hours">
                        {g().status && `${STATUS_LABELS[g().status!]} · `}
                        {g().main ? `${roundHours(g().hours)} / ${roundHours(g().main!)} h` : fmtHours(g().hours)}
                      </span>
                    </button>
                  )}
                </Show>
              )}
            </For>
            <Show when={group.appids.length > STORY_GAMES_SHOWN}>
              <span class="profile-more">+{group.appids.length - STORY_GAMES_SHOWN} more</span>
            </Show>
          </>
        )}
      </For>
    </div>
  );
}

// Owned's profile: the archetype and the tags it plays most, beside its story and no-playtime tiles.
// Why these? opens each figure's evidence in place: games under each tag, the story games in their tile.
export function OwnedProfile(props: {
  archetype: Archetype | null;
  tags: PlayedTag[];
  played: number;
  styleSentence: string | null;
  story: StoryGames | null;
  creators: FavouriteCreators;
  creatorHref: (role: CreatorRole, name: string) => string;
  isCreatorActive: (role: CreatorRole, name: string) => boolean;
  onCreator: (role: CreatorRole, name: string) => void;
  unplayed: number; // games played `playNextHours` or less
  playNextHours: number;
  backlogShown: boolean;
  whyOpen: boolean;
  isTagActive: (tag: string) => boolean;
  onTag: (tag: string) => void;
  onBacklog: () => void;
  onWhy: () => void;
  game: (appid: number) => ProfileGameInfo | undefined;
  onGame: (appid: number) => void;
}): JSX.Element {
  const hasCreators = () => props.creators.developers.length + props.creators.publishers.length > 0;
  const tiles = () => !!props.story || hasCreators() || props.unplayed > 0;
  return (
    <Show when={props.tags.length || tiles()}>
      <div
        id="player-profile"
        class="profile"
        classList={{ 'profile--tiles': tiles() && props.tags.length > 0, 'profile--open': props.whyOpen }}
      >
        <Show when={props.tags.length}>
          <div class="profile-main">
            <div class="profile-head">
              <Show when={props.archetype}>{(archetype) => <ProfileBadge archetype={archetype()} />}</Show>
              <div>
                <h2 class="profile-title">{props.archetype?.name ?? 'Plays mostly'}</h2>
                <p class="profile-sub">
                  <Show when={props.styleSentence}>
                    <span class="profile-style">{props.styleSentence} · </span>
                  </Show>
                  from {props.played} played games ·{' '}
                  <button
                    type="button"
                    class="list-plays-mostly-why"
                    aria-expanded={props.whyOpen}
                    aria-controls="player-profile"
                    onClick={() => props.onWhy()}
                  >
                    Why these? <span aria-hidden="true">{props.whyOpen ? '▴' : '▾'}</span>
                  </button>
                </p>
              </div>
            </div>
            <Show when={props.archetype}>
              <span class="profile-label profile-label--bars">Plays mostly</span>
            </Show>
            <TagBars
              tags={props.tags}
              isActive={props.isTagActive}
              onTag={props.onTag}
              detail={(played) => (
                <Show when={props.whyOpen}>
                  <div class="profile-bar-games">
                    <For each={played.games}>
                      {(g) => <GameChip {...g} art={props.game(g.appid)?.art ?? null} onGame={props.onGame} />}
                    </For>
                  </div>
                </Show>
              )}
            />
            <Show when={props.whyOpen}>
              <details class="profile-how">
                <summary>How it's counted</summary>
                <ul>
                  <li>
                    Tags: hours played × how strongly players tagged each game; tags most of the library carries count
                    less. Bars compare each tag with the top one.
                  </li>
                  <Show when={props.styleSentence}>
                    <li>
                      Play style: single-player, co-op or PvP, whichever holds over half the played games' weight (log
                      hours); a game with several modes goes by the one players tag it most for.
                    </li>
                  </Show>
                  <Show when={hasCreators()}>
                    <li>
                      Studios: developers and publishers of 2 or more played games, most played first (log hours, so one
                      long game doesn't decide); a studio publishing its own games shows as a developer.
                    </li>
                  </Show>
                  <Show when={props.story}>
                    <li>
                      Story games: single-player, with a How Long To Beat main story and no endless tag (roguelike,
                      sandbox…), counted when played for at least 80% of it, or marked Finished or Abandoned in its
                      panel.
                    </li>
                  </Show>
                </ul>
              </details>
            </Show>
          </div>
        </Show>
        <Show when={tiles()}>
          <div class="profile-tiles">
            <Show when={props.story}>
              {(story) => (
                <div class="profile-tile">
                  <span class="profile-label">
                    <BookOpen /> Story games
                  </span>
                  <div class="profile-tile-body">
                    <StoryRing story={story()} />
                    <span>of story games played for their main story's length</span>
                  </div>
                  <Show when={props.whyOpen}>
                    <StoryList story={story()} game={props.game} onGame={props.onGame} />
                  </Show>
                </div>
              )}
            </Show>
            <Show when={hasCreators()}>
              <CreatorsTile
                creators={props.creators}
                whyOpen={props.whyOpen}
                href={props.creatorHref}
                isActive={props.isCreatorActive}
                onFilter={props.onCreator}
                game={props.game}
                onGame={props.onGame}
              />
            </Show>
            <Show when={props.unplayed}>
              <div class="profile-tile">
                <span class="profile-label">
                  <Play /> Barely played
                </span>
                <div class="profile-tile-body">
                  <span class="profile-figure">{props.unplayed}</span>
                  <span>
                    {props.unplayed === 1 ? 'game' : 'games'} played {props.playNextHours} h or less
                  </span>
                  <button
                    type="button"
                    class="btn"
                    aria-pressed={props.backlogShown}
                    aria-label={`Play next: ${props.unplayed} ${props.unplayed === 1 ? 'game' : 'games'} played ${props.playNextHours} h or less`}
                    title="Open Play next: these games, best Taste Fit first"
                    onClick={() => props.onBacklog()}
                  >
                    Play next
                  </button>
                </div>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
}
