// The compare screen of a ranked list (/lists/:listId/rank, see docs/dev/lists-and-accounts.md's
// Ranked lists section): asks one "which do you prefer?" pair at a time and feeds each answer to
// ranking.ts's binary insertion. Every answer is stored right away (listsStore.ts's setRanking),
// so leaving at any point loses nothing; undo is an in-memory stack of previous states.
import { createSignal, createEffect, createMemo, on, onCleanup, onMount, Show, For, type JSX } from 'solid-js';
import ArrowLeft from 'lucide-solid/icons/arrow-left';
import Info from 'lucide-solid/icons/info';
import { createStore } from 'solid-js/store';
import { A, useParams, useNavigate, useLocation } from '@solidjs/router';
import { getList, getRanking, setRanking } from './listsStore.ts';
import { resolveListWithSources, flattenCombineResult, createDefaultFetchers } from './listResolve.ts';
import { createDefaultNaming, listDisplayName } from './listLabels.ts';
import {
  nextPair,
  answer,
  progress,
  withFocus,
  pendingFocus,
  ranks,
  type RankingState,
  type RankingPair,
  type RankingAnswer,
  type RankingOptions,
} from './ranking.ts';
import { setBaseTitle } from './pageTitle.ts';
import { panelOpen, panelClose, isPanelOpen, getPanelGame } from './panel.tsx';
import { isLightboxOpen } from './lightbox.tsx';
import { withAccountParam } from './urlState.ts';
import {
  computeSteamdbRating,
  detailsFields,
  fetchGameDetails,
  isTextEntry,
  scoreColor,
  steamAppAsset,
} from './utils.ts';
import { registerRouteHandlers } from './AppShell.tsx';
import Kbd from './Kbd.tsx';
import { focusFirst, focusLost, handOffFocus } from './focusHandoff.ts';
import type { Game, GameDetails, GameDetailsReply } from './types.ts';

const MAX_UNDO = 100;
// Tie, Skip and Undo's keys, which wait while the details panel is open.
const ANSWER_KEYS = new Set(['ArrowDown', '=', 's', 'S', 'z', 'Z', 'Backspace']);

export default function RankRoute() {
  const params = useParams();
  const navigate = useNavigate();
  const location = useLocation<{ rankFocus?: number[]; rankOrder?: number[] } | undefined>();
  // The chosen games — from the list page's "Compare selected"/"Rank N games" (history state),
  // stored on the ranking by load() so a later visit resumes on them.
  function focus(): Set<number> | undefined {
    const ids = state()?.focus;
    return ids?.length ? new Set(ids) : undefined;
  }
  // Plus the list page's table sort, which orders the games asked (ranking.ts's RankingOptions).
  function opts(): RankingOptions {
    const order = location.state?.rankOrder;
    return { focus: focus(), order: Array.isArray(order) ? order : undefined };
  }
  // Keeps the table order, drops only the choice.
  function compareAll(): void {
    const current = state();
    const src = source();
    navigate(location.pathname, { replace: true, state: { rankOrder: location.state?.rankOrder } });
    if (!current || !src) return;
    showNext(nextPair(withFocus(current, undefined), src, { order: opts().order }));
  }
  const [title, setTitle] = createSignal('');
  const [status, setStatus] = createSignal('Resolving list…');
  const [source, setSource] = createSignal<Set<number> | null>(null);
  // "Haven't played" only fits games you own; a wishlist or a bundle is about wanting them.
  const excludeLabel = (): string =>
    getList(params.listId!)?.source?.kind === 'account-owned' ? "Haven't played — exclude" : 'Not interested — exclude';
  const [state, setState] = createSignal<RankingState | null>(null);
  const [pair, setPair] = createSignal<RankingPair | null>(null);
  const [undoStack, setUndoStack] = createSignal<RankingState[]>([]);
  // X (exclude) or I (details panel) arms an action; the next ←/→ says which side.
  const [armed, setArmed] = createSignal<'exclude' | 'info' | null>(null);
  const excludeArmed = () => armed() === 'exclude';
  // Store-backed, so the panel showing one of them updates in place when its details land or refresh.
  const [games, setGames] = createStore<Record<number, Game>>({});
  let loadToken = 0;

  // Shows the next pair; `save` also stores the ranking it came with.
  function showNext(next: { state: RankingState; pair: RankingPair | null }, save = true): void {
    setState(next.state);
    setPair(next.pair);
    if (save) setRanking(params.listId!, next.state);
  }

  function listHref(): string {
    return withAccountParam(`/lists/${params.listId}`);
  }

  async function load(): Promise<void> {
    const token = ++loadToken;
    const list = getList(params.listId!);
    if (!list || list.kind !== 'ranked') {
      setStatus("This ranked list isn't in this browser: it was deleted, or it was made in another one.");
      return;
    }
    const name = listDisplayName(list, createDefaultNaming());
    setTitle(name);
    setBaseTitle(`Rank — ${name}`);
    try {
      const { result } = await resolveListWithSources(list, createDefaultFetchers());
      if (token !== loadToken) return;
      const appids = flattenCombineResult(result);
      // A new choice replaces the stored one; a used-up one is dropped rather than resumed.
      const incoming = location.state?.rankFocus;
      const saved = getRanking(list.id);
      let stored = saved;
      if (Array.isArray(incoming) && incoming.length) stored = withFocus(saved, incoming);
      else if (saved.focus && !pendingFocus(saved, appids)) stored = withFocus(saved, undefined);
      if (stored !== saved) setRanking(list.id, stored);
      setState(stored);
      setSource(appids);
      showNext(nextPair(stored, appids, opts()), false);
      setUndoStack([]);
      setStatus('');
    } catch (err) {
      if (token !== loadToken) return;
      setStatus(`Error: ${(err as Error).message}`);
    }
  }

  function setDetails(appid: number, data: GameDetailsReply): void {
    setGames(appid, { ...detailsFields(data), name: data.name || `App ${appid}` });
    if (data.limited) setStatus(data.limited);
  }

  // Cached per appid for this mount; the server's own cache makes a repeat cheap anyway.
  function fetchDetails(appid: number): void {
    if (appid in games) return;
    setGames(appid, { appid, name: `App ${appid}`, loading: true, details: null });
    fetchGameDetails(appid)
      .then((data) => setDetails(appid, data))
      .catch(() => {
        /* card falls back to the header image and appid */
      });
  }

  createEffect(() => {
    const p = pair();
    if (p) {
      fetchDetails(p.candidate);
      fetchDetails(p.opponent);
    }
  });

  // Arriving from a list's button (Rank N games, Re-rank, Continue ranking) leaves focus on <body>.
  let arrived = false;
  createEffect(() => {
    if (arrived || !pair()) return;
    arrived = true;
    if (focusLost()) handOffFocus(focusFirst('.rank-card-pick'));
  });

  // Focused before opening, so closing returns focus there however the panel was opened (I + ←/→ too).
  const detailsButtons = new Map<number, HTMLButtonElement>();
  function openPanel(appid: number): void {
    fetchDetails(appid);
    detailsButtons.get(appid)?.focus();
    panelOpen(games[appid]);
  }
  // The panel's ↻ Refresh; tags stay plain pills, since nothing here filters by them.
  async function refreshGame(game: Game): Promise<void> {
    try {
      setDetails(game.appid, await fetchGameDetails(game.appid, { refresh: true }));
    } catch (err) {
      setStatus(`Refresh failed: ${(err as Error).message}`);
    }
  }
  onMount(() => onCleanup(registerRouteHandlers({ refreshGame })));
  // The panel stays open only while its game is still one of the pair.
  function syncPanel(): void {
    const open = getPanelGame();
    const p = pair();
    if (open && (!p || (open.appid !== p.candidate && open.appid !== p.opponent))) panelClose();
  }

  function respond(ans: RankingAnswer): void {
    const current = state();
    const src = source();
    if (!current || !src || !pair()) return;
    setUndoStack((stack) => [...stack.slice(-(MAX_UNDO - 1)), current]);
    showNext(answer(current, src, ans, opts()));
    setArmed(null);
    syncPanel();
  }

  function undo(): void {
    const stack = undoStack();
    const src = source();
    if (!stack.length || !src) return;
    const previous = stack[stack.length - 1];
    setUndoStack(stack.slice(0, -1));
    showNext(nextPair(previous, src, opts()));
    setArmed(null);
    syncPanel();
  }

  // Capture phase, so it runs before AppShell's own panel shortcuts: an armed I/X + ←/→ wins over
  // the panel's media stepping, and Esc can still see whether it's about to close the panel.
  function onKeydown(e: KeyboardEvent): void {
    if (isLightboxOpen()) return;
    if (isTextEntry(e.target as Element | null)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key;
    // AppShell's handler closes the shortcuts dialog or the panel first, when one is open.
    if (key === 'Escape') {
      if (!e.defaultPrevented && !isPanelOpen() && !document.querySelector('.shortcuts-modal.open'))
        navigate(listHref());
      return;
    }
    // The open panel has the keyboard (↓ scrolls it); an answer would also close it under the reader.
    if (isPanelOpen() && ANSWER_KEYS.has(key)) {
      setArmed(null);
      return;
    }
    if (key === 'z' || key === 'Z' || key === 'Backspace') {
      e.preventDefault();
      undo();
      return;
    }
    const p = pair();
    if (!p) return;
    if (key === 'x' || key === 'X') {
      e.preventDefault();
      setArmed((a) => (a === 'exclude' ? null : 'exclude'));
      return;
    }
    if (key === 'i' || key === 'I') {
      e.preventDefault();
      setArmed((a) => (a === 'info' ? null : 'info'));
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const left = key === 'ArrowLeft';
      const action = armed();
      if (action) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setArmed(null);
        if (action === 'info') openPanel(left ? p.candidate : p.opponent);
        else respond(left ? 'exclude-candidate' : 'exclude-opponent');
        return;
      }
      if (isPanelOpen()) return; // browses the panel's media instead
      e.preventDefault();
      respond(left ? 'candidate' : 'opponent');
      return;
    }
    if (key === 'ArrowDown' || key === '=') {
      e.preventDefault();
      respond('tie');
      return;
    }
    if (key === 's' || key === 'S') {
      e.preventDefault();
      respond('skip');
      return;
    }
    setArmed(null);
  }
  document.addEventListener('keydown', onKeydown, true);
  onCleanup(() => {
    document.removeEventListener('keydown', onKeydown, true);
    if (isPanelOpen()) panelClose({ leavingRoute: true });
    loadToken++;
    setBaseTitle(null);
  });

  // By content: closing the panel hands back an equal new state, and reloading would drop its returned focus.
  const rankStateKey = createMemo(() =>
    JSON.stringify([location.state?.rankFocus ?? null, location.state?.rankOrder ?? null]),
  );
  createEffect(
    on([() => params.listId, rankStateKey], () => {
      void load();
    }),
  );

  function currentProgress() {
    const s = state();
    const src = source();
    return s && src ? progress(s, src, opts()) : null;
  }

  function card(appid: number, side: 'candidate' | 'opponent', note: JSX.Element): JSX.Element {
    const d = (): GameDetails | null | undefined => games[appid]?.details;
    const meta = () => d()?.meta ?? null;
    const year = () => meta()?.releaseDate?.match(/\d{4}/)?.[0];
    // The table's default HLTB figure (all playstyles), so the card and the row agree.
    const hltb = () => d()?.hltb?.all;
    const rating = () => {
      const r = d()?.rating;
      const v = r ? computeSteamdbRating(r.positive, r.total) : null;
      return v == null ? null : Math.round(v);
    };
    return (
      <div class="rank-card" classList={{ 'rank-card-armed': excludeArmed() }}>
        <button
          type="button"
          class="rank-card-pick"
          onClick={() => {
            if (armed() === 'info') {
              setArmed(null);
              openPanel(appid);
            } else respond(excludeArmed() ? `exclude-${side}` : side);
          }}
        >
          <img src={steamAppAsset(appid, 'header.jpg')} alt="" width="460" height="215" loading="eager" />
          <span class="rank-card-name">
            {meta()?.name || `App ${appid}`}
            <Show when={rating() != null}>
              <span class="rank-card-rating" style={{ color: scoreColor(rating()) }} title="Weighted Rating">
                {rating()}
              </span>
            </Show>
          </span>
          <span class="rank-card-facts">
            {[
              year(),
              ...(meta()?.genres ?? []).slice(0, 2),
              hltb() ? `${Math.round(hltb()! * 10) / 10} h to beat` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <span class="rank-card-note">{note}</span>
        </button>
        <div class="rank-card-actions">
          <button
            type="button"
            class="btn"
            title="Open this game's details in the side panel"
            ref={(el) => detailsButtons.set(appid, el)}
            onClick={() => openPanel(appid)}
          >
            <Info /> Details
          </button>
          <button
            type="button"
            class="btn"
            title="Leave this game out of the ranking"
            onClick={() => respond(`exclude-${side}`)}
          >
            {excludeLabel()}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div class="rank-route">
      <header class="rank-header">
        <A href={listHref()} class="btn">
          <ArrowLeft /> Back to list
        </A>
        <h1>{title()}</h1>
      </header>
      <Show when={status()}>
        <div class="list-status">{status()}</div>
      </Show>
      <Show when={focus()}>
        {(f) => (
          <div class="rank-focus-banner">
            Comparing {f().size} chosen games.
            <button type="button" class="btn" onClick={compareAll}>
              Rank all instead
            </button>
          </div>
        )}
      </Show>
      <Show when={currentProgress()}>
        {(p) => (
          <div class="rank-progress">
            <Show
              when={focus()}
              fallback={
                <>
                  <progress max={p().ranked + p().pending} value={p().ranked} />
                  <span>
                    {p().ranked} / {p().ranked + p().pending} ranked
                    {p().excluded ? ` · ${p().excluded} excluded` : ''}
                    {p().pending ? ` · ≈ ${p().remaining} comparison${p().remaining === 1 ? '' : 's'} left` : ''}
                  </span>
                </>
              }
            >
              {(f) => (
                <>
                  <progress max={f().size} value={f().size - p().pending} />
                  <span>
                    {p().pending} of {f().size} chosen games left
                    {p().pending ? ` · ≈ ${p().remaining} comparison${p().remaining === 1 ? '' : 's'}` : ''}
                  </span>
                </>
              )}
            </Show>
          </div>
        )}
      </Show>
      <Show
        when={pair()}
        fallback={
          <Show when={source()}>
            <div class="rank-done">
              <Show
                when={focus()}
                fallback={<p>Every game in this list is ranked. New games added to its source will show up here.</p>}
              >
                <p>Every chosen game is ranked.</p>
                <Show when={source() && state() && progress(state()!, source()!).pending}>
                  <button type="button" class="btn" onClick={compareAll}>
                    Rank the rest
                  </button>
                </Show>
              </Show>
              <A href={listHref()} class="btn btn-primary">
                See the ranking
              </A>
              <Show when={undoStack().length}>
                <button type="button" class="btn" onClick={undo}>
                  Undo last answer
                </button>
              </Show>
            </div>
          </Show>
        }
      >
        {(p) => (
          <>
            <h2 class="rank-question">
              {armed() === 'exclude'
                ? 'Exclude which game? (← / →)'
                : armed() === 'info'
                  ? 'Show details of which game? (← / →)'
                  : 'Which do you prefer?'}
            </h2>
            <div class="rank-pair">
              {card(p().candidate, 'candidate', 'New to the ranking')}
              {card(p().opponent, 'opponent', `Currently #${ranks(state()!, source()!).get(p().opponent) ?? '?'}`)}
            </div>
            <div class="rank-actions">
              <button type="button" class="btn" onClick={() => respond('tie')}>
                Tie{' '}
                <Show when={!isPanelOpen()}>
                  <Kbd k="↓" />
                </Show>
              </button>
              <button type="button" class="btn" onClick={() => respond('skip')}>
                Skip, ask later{' '}
                <Show when={!isPanelOpen()}>
                  <kbd>S</kbd>
                </Show>
              </button>
              <button type="button" class="btn" disabled={!undoStack().length} onClick={undo}>
                Undo{' '}
                <Show when={!isPanelOpen()}>
                  <kbd>Z</kbd>
                </Show>
              </button>
            </div>
            <p class="rank-hint">
              <For
                each={[
                  ['← / →', isPanelOpen() ? "browse the panel's media" : 'pick'],
                  ['X then ← / →', 'exclude'],
                  ['I then ← / →', 'details'],
                  ['Esc', isPanelOpen() ? 'close the panel' : 'stop — progress is saved'],
                ]}
              >
                {([k, v]) => (
                  <span>
                    <Kbd k={k} /> {v}
                  </span>
                )}
              </For>
            </p>
          </>
        )}
      </Show>
    </div>
  );
}
