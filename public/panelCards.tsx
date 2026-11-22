// The side panel's cards: each folds to a one-line answer (panelSummaries.ts). A tile sits in a
// pair (`PanelTileRow`), and opens its body in a drawer under the row, so tiles never move.
import { createMemo, createSignal, For, Match, Show, Switch, type Component, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import ChevronRight from 'lucide-solid/icons/chevron-right';
import type { CardSummary } from './panelSummaries.ts';
import { isPanelCardOpen, togglePanelCard } from './panelOpenCards.ts';
import { animate, durationToken, easeOut, prefersReducedMotion } from './motion.ts';

export interface PanelCardDef {
  card: string; // its panelOpenCards key, and its ids' stem
  title: string;
  icon: Component<{ class?: string }>;
  summary: () => CardSummary;
  body: JSX.Element; // built once by the caller: the ready state's
  failed: () => { message: string; retry?: () => void }; // a refusal offers no retry
  sectionId?: string; // the #panel-section-* id the subnav jumps to
}

const titleId = (card: string) => `panel-card-${card}-title`;
const bodyId = (card: string) => `panel-card-${card}-body`;

// Its button's name: title, then the answer; the ⚠ glyph is read as its words.
function cardName(title: string, s: CardSummary): string {
  if (s.state === 'loading') return `${title}, loading`;
  return [title, s.state === 'failed' ? null : s.fig, s.qualifier ?? s.text].filter(Boolean).join(', ');
}

// Slides `el` between two heights (ui-guidelines.md's one layout exception), clipped meanwhile.
export function slideHeight(el: HTMLElement, from: number, to: number): Promise<void> {
  const frames = [
    { height: `${from}px`, overflow: 'clip' },
    { height: `${to}px`, overflow: 'clip' },
  ];
  return animate(el, frames, { duration: durationToken('--dur-3'), easing: easeOut() });
}

function PanelTile(props: { def: PanelCardDef; open: boolean; onToggle: () => void }): JSX.Element {
  const s = createMemo(() => props.def.summary());
  const empty = () => s().state === 'empty';
  return (
    <div
      class="panel-card panel-card--tile"
      classList={{ 'panel-card--open': props.open && !empty(), 'panel-card--empty': empty() }}
      id={props.def.sectionId}
    >
      <h3 class="panel-card-heading" id={titleId(props.def.card)}>
        {/* One button for the card's whole mount, so focus stays on it whatever its state becomes. */}
        <button
          type="button"
          class="panel-card-top"
          aria-label={cardName(props.def.title, s())}
          aria-disabled={empty() ? 'true' : undefined}
          aria-expanded={empty() ? undefined : props.open ? 'true' : 'false'}
          aria-controls={empty() ? undefined : bodyId(props.def.card)}
          onClick={() => !empty() && props.onToggle()}
        >
          <Dynamic component={props.def.icon} class="panel-card-icon" />
          <span class="panel-card-title">{props.def.title}</span>
          <Show when={!empty()}>
            <ChevronRight class="panel-card-chevron" />
          </Show>
          <span class="panel-card-summary">
            <span class="panel-card-fig" style={{ color: s().tone }}>
              <Show when={s().state !== 'loading'} fallback={<span class="sk panel-card-sk" />}>
                {s().fig ?? '—'}
              </Show>
            </span>
            <span class="panel-card-qualifier">{s().qualifier}</span>
            <span class="panel-card-bar">
              <Show when={s().bar != null}>
                <span class="panel-card-bar-fill" style={{ width: `${s().bar! * 100}%`, background: s().tone }} />
              </Show>
            </span>
          </span>
        </button>
      </h3>
    </div>
  );
}

function DrawerPart(props: { def: PanelCardDef; state: CardSummary['state']; leaving: boolean }): JSX.Element {
  return (
    <section
      class="panel-drawer-part"
      id={bodyId(props.def.card)}
      aria-labelledby={titleId(props.def.card)}
      inert={props.leaving}
    >
      <div class="panel-drawer-label" aria-hidden="true">
        <Dynamic component={props.def.icon} />
        {props.def.title}
      </div>
      <Switch>
        <Match when={props.state === 'ready'}>{props.def.body}</Match>
        <Match when={props.state === 'failed'}>
          <p class="panel-no-data">{props.def.failed().message}</p>
          <Show when={props.def.failed().retry}>
            {(retry) => (
              <button type="button" class="btn panel-drawer-retry" onClick={() => retry()()}>
                Retry
              </button>
            )}
          </Show>
        </Match>
        <Match when={props.state === 'loading'}>
          <span class="sk panel-drawer-sk" />
        </Match>
      </Switch>
    </section>
  );
}

// Two tiles over one drawer: an opened tile's body shows there, both in tile order when both are open.
export function PanelTileRow(props: { first: PanelCardDef; second: PanelCardDef }): JSX.Element {
  // Fixed slots: the defs are the caller's consts, each reading its own data reactively.
  // eslint-disable-next-line solid/reactivity
  const tiles = [props.first, props.second];
  const states = tiles.map((def) => createMemo(() => def.summary().state));
  const open = tiles.map((def) => createMemo(() => isPanelCardOpen(def.card)));
  // A part sliding shut stays until it has, inert.
  const [leaving, setLeaving] = createSignal<string | null>(null);
  const parts = createMemo(() =>
    tiles.filter((def, i) => (open[i]() && states[i]() !== 'empty') || leaving() === def.card),
  );
  let slot!: HTMLDivElement;
  let slides = 0;

  // A click (only: data arriving or a game step just resizes it) slides the drawer to its new height.
  const toggle = (card: string) => {
    const from = slot.getBoundingClientRect().height;
    for (const a of slot.getAnimations()) a.cancel();
    const closing = isPanelCardOpen(card);
    const slide = !prefersReducedMotion();
    setLeaving(closing && slide ? card : null);
    togglePanelCard(card);
    if (!slide) return;
    let to = 0;
    if (parts().some((def) => def.card !== card)) {
      const part = closing ? document.getElementById(bodyId(card)) : null;
      if (part) part.style.display = 'none';
      to = slot.getBoundingClientRect().height;
      if (part) part.style.display = '';
    }
    const n = ++slides;
    void slideHeight(slot, from, to).then(() => n === slides && setLeaving(null));
  };

  return (
    <div class="panel-tile-row">
      <For each={tiles}>{(def, i) => <PanelTile def={def} open={open[i()]()} onToggle={() => toggle(def.card)} />}</For>
      <div class="panel-drawer-slot" ref={slot}>
        <Show when={parts().length}>
          <div class="panel-drawer">
            <For each={parts()}>
              {(def) => <DrawerPart def={def} state={states[tiles.indexOf(def)]()} leaving={leaving() === def.card} />}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}
