// /search?q=<term> — search for a game straight from a URL, e.g. as a Firefox keyword bookmark
// (docs/user/features.md). Not one of ListRoute's kinds — no ratings/HLTB/price of its own — but
// its results render through the same `@vates/data-table-solid` table every other list route
// uses (a minimal two-column config, not `gameColumns.ts`'s `CORE_COLUMNS`), which is what gets
// this page its keyboard row navigation for free; opening a result uses the same shared side
// panel every other route uses, and participates in its usual step/random/lightbox nav.
import { createSignal, createEffect, createMemo, on, onMount, onCleanup, Show, untrack } from 'solid-js';
import { createStore } from 'solid-js/store';
import { useLocation } from '@solidjs/router';
import { createTableState, DataTableView } from '@vates/data-table-solid';
import { cascadeFirstRows } from './motion.ts';
import type { ColumnDef } from '@vates/data-table-solid';
import { useBaseTitle } from './pageTitle.ts';
import { ListHero } from './ListHero.tsx';
import { registerRouteHandlers } from './AppShell.tsx';
import { panelOpen, panelClose, isPanelOpen, getPanelGame, pickRandomFrom } from './panel.tsx';
import { renderPanelNav, stepGameList } from './panelNav.ts';
import { setPanelParam, setSearchQueryParam, parseUrlState } from './urlState.ts';
import { addRecentGame } from './recentGames.ts';
import { peekMyOwnershipStatus } from './myOwnership.ts';
import { GAME_SEARCH_DEBOUNCE_MS, GAME_SEARCH_MIN_CHARS, ownershipMarkersHtml, searchGames } from './gameSearch.ts';
import type { GameSearchResult } from './gameSearch.ts';
import type { Game, GameDetailsReply } from './types.ts';
import { detailsFields, failedLookupFields, fetchJson } from './utils.ts';
import { SearchClearButton } from './SearchClearButton.tsx';

// CORE_COLUMNS' thumb + Name pair over a bare GameSearchResult; a cell is a tracked scope, so renderName's badge follows ownership landing.
function renderThumb(_value: unknown, row: GameSearchResult): Node {
  if (!row.tinyImage) {
    const span = document.createElement('span');
    span.className = 'game-search-thumb game-search-thumb--empty';
    return span;
  }
  const img = document.createElement('img');
  img.className = 'game-search-thumb';
  img.alt = '';
  img.loading = 'lazy';
  img.src = row.tinyImage;
  return img;
}

function renderName(_value: unknown, row: GameSearchResult): Node {
  const wrap = document.createElement('span');
  wrap.className = 'game-search-name';
  wrap.appendChild(document.createTextNode(row.name));
  wrap.insertAdjacentHTML('beforeend', ownershipMarkersHtml(peekMyOwnershipStatus(row.appid)));
  return wrap;
}

const SEARCH_COLUMNS: ColumnDef<GameSearchResult>[] = [
  {
    key: 'thumb',
    label: '',
    width: 90,
    sortable: false,
    filterable: false,
    groupable: false,
    searchable: false,
    value: () => null,
    render: renderThumb,
  },
  { key: 'name', label: 'Name', sortable: false, filterable: false, groupable: false, render: renderName },
];

// Results without any image (Steam omitted them all) get no empty thumbnail column.
const NAME_ONLY_COLUMNS = SEARCH_COLUMNS.slice(1);

// A fixed queue key: pickRandomFrom (panel.tsx) already self-heals when the underlying list
// changes (it validates its queue against the current appid set), so there's no need for a
// per-query key the way ListRoute.tsx's randomQueueKey is scoped per list/account/group.
const RANDOM_QUEUE_KEY = 'search-route';

export default function SearchRoute() {
  const location = useLocation();
  // A local signal, not a `location.search` memo: the on-page box below writes `?q=` via
  // `history.replaceState` (setSearchQueryParam), which — like every other raw replaceState in
  // this app (see urlState.ts's own comment on this) — never touches @solidjs/router's reactive
  // location, so this route has to track its own query text and sync the URL as a side effect.
  const [query, setQuery] = createSignal(new URLSearchParams(location.search).get('q')?.trim() ?? '');

  const [results, setResults] = createSignal<GameSearchResult[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [searchFailed, setSearchFailed] = createSignal(false);

  // For the keyboard bridges between the search box and the table's first row — see their
  // own onKeyDown handlers below.
  let inputEl: HTMLInputElement | undefined;

  useBaseTitle(() => 'Search');

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  function handleInput(raw: string): void {
    if (debounceTimer != null) clearTimeout(debounceTimer);
    const term = raw.trim();
    debounceTimer = setTimeout(() => {
      setSearchQueryParam(term);
      setQuery(term);
    }, GAME_SEARCH_DEBOUNCE_MS);
  }
  onCleanup(() => {
    if (debounceTimer != null) clearTimeout(debounceTimer);
  });

  let searchToken = 0;
  createEffect(
    on(query, (term) => {
      const token = ++searchToken;
      // Same floor as the nav-bar box (gameSearch.ts) — a 1-character query is expensive and
      // near-meaningless against an unofficial, unpaginated store-search endpoint.
      if (term.length < GAME_SEARCH_MIN_CHARS) {
        setResults([]);
        setSearching(false);
        return;
      }
      setSearching(true);
      setSearchFailed(false);
      searchGames(term)
        .then((list) => {
          if (token === searchToken) setResults(list);
        })
        .catch(() => {
          if (token !== searchToken) return;
          setResults([]);
          setSearchFailed(true);
        })
        .finally(() => {
          if (token === searchToken) setSearching(false);
        });
    }),
  );

  const hasImages = createMemo(() => results().some((r) => r.tinyImage));
  const table = createTableState<GameSearchResult>(results, () => (hasImages() ? SEARCH_COLUMNS : NAME_ONLY_COLUMNS));
  // The first results only: a cascade on every query would flicker as one types.
  let tableContainer: HTMLDivElement | undefined;
  cascadeFirstRows(
    () => table.processedData().length,
    () => tableContainer,
  );

  // The minimal Game[] shape panelNav.ts's stepGameList/renderPanelNav and panel.tsx's
  // pickRandomFrom need — unrelated to what backs the visible table (GameSearchResult is enough
  // for that).
  function getGameList(): Game[] {
    return results().map((r) => ({ appid: r.appid, name: r.name, loading: true, details: null }) as Game);
  }

  // `focus: true` moves real DOM focus too, so the row shows its ring while the panel is open.
  function focusRow(appid: number): void {
    const row = results().find((r) => r.appid === appid);
    if (row) table.focus.moveTo(row, { focus: true });
  }

  // Store-backed, so the panel updates in place when details land rather than reopening (which drops its DLC trail).
  const [games, setGames] = createStore<Record<number, Game>>({});
  const [statusText, setStatusText] = createSignal('');
  let lookupToken = 0;
  async function openResult(appid: number, name: string, tinyImage: string | null, standalone = false): Promise<void> {
    const token = ++lookupToken;
    setStatusText('');
    setGames(appid, { appid, name, loading: true, details: null, standalone });
    const game = games[appid];
    panelOpen(game);
    setPanelParam(appid);
    renderPanelNav({
      hasList: true,
      game,
      getGameList,
      onStep: stepGame,
      onReroll: pickRandomGame,
    });
    focusRow(appid);
    try {
      const data = await fetchJson<GameDetailsReply>(`/api/game-details/${appid}`, undefined, 'Lookup failed');
      if (token !== lookupToken) return; // a newer pick has since taken over
      setGames(appid, { ...detailsFields(data), name: data.name || name });
      addRecentGame(appid, data.name || name, data.meta?.capsule || tinyImage);
    } catch (err) {
      if (token !== lookupToken) return;
      setGames(appid, failedLookupFields());
      setStatusText(`Lookup failed: ${(err as Error).message}`);
    }
  }

  // The panel's ↻: forces fresh details onto the open game.
  async function refreshGame(game: Game): Promise<void> {
    const unresolved = !game.details?.meta;
    try {
      const data = await fetchJson<GameDetailsReply>(
        `/api/game-details/${game.appid}?refresh=1`,
        undefined,
        'Refresh failed',
      );
      const name = data.name || game.name;
      setGames(game.appid, { ...detailsFields(data), name });
      setStatusText('');
      // A lookup that failed lands only now.
      if (unresolved && data.meta) addRecentGame(game.appid, name, data.meta.capsule || null);
    } catch (err) {
      setStatusText(`Refresh failed: ${(err as Error).message}`);
    }
  }

  function stepGame(dir: 1 | -1): boolean {
    const next = stepGameList(getGameList(), getPanelGame(), dir);
    if (!next) return false;
    openResult(next.appid, next.name, null);
    return true;
  }

  function pickRandomGame(): boolean {
    if (getPanelGame()?.standalone) return false;
    const list = getGameList();
    if (!list.length) return false;
    const pick = pickRandomFrom(list, RANDOM_QUEUE_KEY, getPanelGame()?.appid ?? 0) as Game | null;
    if (!pick) return false;
    openResult(pick.appid, pick.name, null);
    return true;
  }

  function gamePosition(): { index: number; total: number } | null {
    const game = getPanelGame();
    if (!game) return null;
    const list = getGameList();
    const index = list.findIndex((g) => g.appid === game.appid);
    return index === -1 ? null : { index, total: list.length };
  }

  // Auto-open happens at most once, for the initial `?q=` landing only (a Firefox keyword
  // bookmark's whole point) — never for a later edit to the on-page box, which would otherwise
  // yank the panel open on every pause while the user is still typing/browsing. `?game=` (a
  // reload, or a shared link) reopens that exact game and counts as having already auto-opened;
  // otherwise the first non-empty result list does, opening its top (closest) match.
  let hasAutoOpened = false;
  onMount(() => {
    const restoreAppid = parseUrlState(location.search).game;
    if (restoreAppid) {
      hasAutoOpened = true;
      openResult(restoreAppid, '', null);
    }
  });
  createEffect(() => {
    const list = results();
    if (hasAutoOpened || !list.length) return;
    hasAutoOpened = true;
    openResult(list[0].appid, list[0].name, list[0].tinyImage);
  });

  onMount(() => {
    const unregister = registerRouteHandlers({
      // A game from the panel (a DLC, a similar game) or the nav box, outside the results: no list nav, as on a list page.
      openGame: (appid) => {
        openResult(appid, '', null, !results().some((r) => r.appid === appid));
        return true;
      },
      stepGame,
      pickRandom: pickRandomGame,
      gamePosition,
      refreshGame,
    });
    onCleanup(() => {
      unregister();
      if (isPanelOpen()) panelClose({ leavingRoute: true });
    });
  });

  return (
    <div class="container">
      <ListHero title="Search" />

      <div class="game-search-wrap search-page-input">
        <input
          ref={inputEl}
          type="text"
          placeholder="Search for a game…"
          aria-label="Search for a game"
          enterkeyhint="search"
          // Seeded once: rebinding it to the trimmed query would eat a trailing space typed during the debounce.
          value={untrack(query)}
          onFocus={(e) => e.currentTarget.select()}
          onInput={(e) => handleInput(e.currentTarget.value)}
          // `on:keydown`, not `onKeyDown`: Solid delegates onX-style handlers for `keydown`
          // through one listener on `document` — registered lazily, the first time anything in
          // the app uses it, which is here, well after AppShell's own plain
          // `document.addEventListener('keydown', …)` (panelKeyboard.ts) — so a delegated
          // handler's `stopPropagation()` runs too late to preempt it (same-target listeners run
          // in registration order, not DOM order). `on:` attaches a real listener directly on
          // this element instead, which genuinely fires — and can stop the event — before it
          // ever reaches that later, document-level listener.
          on:keydown={(e) => {
            // ↓ out of the input and into the table's first row — the table itself already has
            // roving-tabindex Up/Down/Home/End (its own README) once focus is inside it; this is
            // just the bridge into that from the search box.
            if (e.key !== 'ArrowDown') return;
            const first = results()[0];
            if (!first) return;
            e.preventDefault();
            e.stopPropagation();
            table.focus.moveTo(first, { focus: true });
          }}
        />
        <SearchClearButton />
      </div>

      <Show when={statusText()}>
        <p class="search-page-status" role="status">
          {statusText()}
        </p>
      </Show>
      <Show when={query()} fallback={<p class="search-page-status">Type a game name to search.</p>}>
        <Show when={query().length >= GAME_SEARCH_MIN_CHARS} fallback={<p class="search-page-status">Keep typing…</p>}>
          <Show when={!searching()} fallback={<p class="search-page-status">Searching…</p>}>
            <Show
              when={results().length}
              fallback={
                <p class="search-page-status">
                  {searchFailed() ? 'Search failed — try again' : `No games found for "${query()}".`}
                </p>
              }
            >
              <div
                class="table-container search-table"
                ref={tableContainer}
                // `on:keydown`, not `onKeyDown` — see the search input's own comment on why:
                // same reasoning, and this one additionally needs to fire before the table
                // library's own internal row-focus handling can act on ArrowUp at row 0 (e.g.
                // wrap to the last row) — a direct, non-delegated listener on this wrapper still
                // runs after the row's own listener (bubble order: target first, then ancestors),
                // but "after" is what's wanted here: this overrides whatever that did, by moving
                // focus to the input last.
                on:keydown={(e) => {
                  // ↑ out of the table's first row and back to the input — the mirror of the
                  // bridge above.
                  if (e.key !== 'ArrowUp') return;
                  const row = (e.target as HTMLElement).closest<HTMLElement>('tr[data-proc-idx]');
                  if (row?.dataset.procIdx !== '0') return;
                  e.preventDefault();
                  e.stopPropagation();
                  inputEl?.focus();
                }}
              >
                <DataTableView<GameSearchResult>
                  table={table}
                  rowKey="appid"
                  // This page's own box is the search, and its columns are fixed: with both off no
                  // toolbar control applies, so none renders.
                  showSearch={false}
                  showColumns={false}
                  onRowClick={(r) => openResult(r.appid, r.name, r.tinyImage)}
                  currentRow={results().find((r) => r.appid === getPanelGame()?.appid) ?? null}
                />
              </div>
            </Show>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
