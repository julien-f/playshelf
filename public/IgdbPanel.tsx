// The side panel's body for a game outside Steam (panel.tsx's PanelBody picks it for an `igdb:` key).
// Only what IGDB and HLTB answer: no store, price, status or list actions, which all need a Steam appid.
import { Match, Show, Switch, type JSX } from 'solid-js';
import { igdbIdOf, NOT_ON_STEAM } from './gameKey.ts';
import { safeHref } from './utils.ts';
import type { IgdbRow } from './types.ts';

export function IgdbPanelRest(props: {
  game: IgdbRow;
  actions: JSX.Element; // copy link, ↻
  glance: JSX.Element;
  details: JSX.Element; // pills, HLTB
  onRetry: () => void;
}): JSX.Element {
  const ok = () => (props.game.igdb?.status === 'ok' ? props.game.igdb.reply.game : null);
  const platforms = () => [NOT_ON_STEAM, ...(ok()?.platforms ?? [])].join(' · ');
  return (
    <>
      <div class="panel-header-sticky">
        <div class="panel-title-row">
          <div>
            <h2 class="panel-title" id="panel-title">
              {props.game.name || `IGDB game ${igdbIdOf(props.game.appid)}`}
            </h2>
            <Show when={ok()?.releaseDate}>
              {(date) => (
                <div class="panel-release">
                  <time datetime={date()}>{date()}</time>
                </div>
              )}
            </Show>
            <Show when={ok()}>
              <div class="panel-release panel-igdb-platforms">{platforms()}</div>
            </Show>
          </div>
          <div class="panel-icon-links">
            <Show when={safeHref(ok()?.url)}>
              {(href) => (
                <a
                  class="panel-icon-link panel-igdb-credit"
                  href={href()}
                  target="_blank"
                  rel="noopener"
                  title="Data from IGDB.com"
                >
                  IGDB ↗
                </a>
              )}
            </Show>
            <span class="panel-icon-divider" role="separator" aria-hidden="true" />
            {props.actions}
          </div>
        </div>
      </div>
      <Switch>
        <Match when={props.game.igdb?.status === 'failed' && props.game.igdb}>
          {(failed) => (
            <p class="panel-no-data panel-igdb-status">
              ⚠ {failed().message}{' '}
              <button type="button" class="btn" onClick={() => props.onRetry()}>
                Retry
              </button>
            </p>
          )}
        </Match>
        <Match when={props.game.igdb?.status === 'unavailable'}>
          <p class="panel-no-data panel-igdb-status">This instance can't look up games outside Steam.</p>
        </Match>
        <Match when={props.game.igdb?.status === 'notFound'}>
          <p class="panel-no-data panel-igdb-status">IGDB has no game with this id.</p>
        </Match>
        <Match when={ok()}>
          {(game) => (
            <>
              {props.glance}
              <Show when={game().summary}>
                <p class="panel-desc" id="panel-desc">
                  {game().summary}
                </p>
              </Show>
              {props.details}
            </>
          )}
        </Match>
      </Switch>
    </>
  );
}
