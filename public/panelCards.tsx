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
  // A refusal offers no retry; absent, the body says what didn't answer itself (Price: price or bundles).
  failed?: () => { message: string; retry?: () => void };
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

// A card's box and top line; a wide card's body comes in as `children`.
function PanelCardBox(props: {
  def: PanelCardDef;
  kind: 'tile' | 'wide';
  open: boolean;
  onToggle: () => void;
  children?: JSX.Element;
}): JSX.Element {
  const s = createMemo(() => props.def.summary());
  const empty = () => s().state === 'empty';
  return (
    <div
      class={`panel-card panel-card--${props.kind}`}
      classList={{
        'panel-card--open': props.open && !empty(),
        'panel-card--empty': empty(),
        'panel-card--text': s().kind === 'text',
      }}
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
          {/* A text card (fixed per card) answers on the title's line, cut with "…". */}
          <Show
            when={s().kind === 'text'}
            fallback={
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
            }
          >
            <span class="panel-card-line" style={{ color: s().tone }}>
              <Show when={s().state !== 'loading'} fallback={<span class="sk panel-card-sk" />}>
                {s().text}
              </Show>
            </span>
          </Show>
          <Show when={!empty()}>
            <ChevronRight class="panel-card-chevron" />
          </Show>
        </button>
      </h3>
      {props.children}
    </div>
  );
}

// A card body by its state: the caller's when ready, the source that didn't answer, or a shimmer.
function CardBody(props: { def: PanelCardDef; state: CardSummary['state'] }): JSX.Element {
  return (
    <Switch>
      <Match when={props.state === 'ready' || (props.state === 'failed' && !props.def.failed)}>{props.def.body}</Match>
      <Match when={props.state === 'failed' && props.def.failed}>
        {(failed) => (
          <>
            <p class="panel-no-data">{failed()().message}</p>
            <Show when={failed()().retry}>
              {(retry) => (
                <button type="button" class="btn panel-card-retry" onClick={() => retry()()}>
                  Retry
                </button>
              )}
            </Show>
          </>
        )}
      </Match>
      <Match when={props.state === 'loading'}>
        <span class="sk panel-card-body-sk" />
      </Match>
    </Switch>
  );
}

// Toggles `card` and, on a click only, slides `slot` to its new height (`measure`, with the part
// leaving still mounted); `setLeaving` keeps that part, inert, until the slide ends.
function createSlideToggle(
  slot: () => HTMLElement,
  setLeaving: (card: string | null) => void,
  measure: (card: string, closing: boolean) => number,
) {
  let slides = 0;
  return (card: string) => {
    const el = slot();
    const from = el.getBoundingClientRect().height;
    for (const a of el.getAnimations()) a.cancel();
    const closing = isPanelCardOpen(card);
    const slide = !prefersReducedMotion();
    setLeaving(closing && slide ? card : null);
    togglePanelCard(card);
    if (!slide) return;
    const to = measure(card, closing);
    const n = ++slides;
    void slideHeight(el, from, to).then(() => n === slides && setLeaving(null));
  };
}

// A full-width card, opening in place.
export function PanelWideCard(props: { def: PanelCardDef }): JSX.Element {
  const state = createMemo(() => props.def.summary().state);
  const open = createMemo(() => isPanelCardOpen(props.def.card));
  const [leaving, setLeaving] = createSignal<string | null>(null);
  let slot!: HTMLDivElement;
  const toggle = createSlideToggle(
    () => slot,
    setLeaving,
    (_card, closing) => (closing ? 0 : slot.getBoundingClientRect().height),
  );
  return (
    <PanelCardBox def={props.def} kind="wide" open={open()} onToggle={() => toggle(props.def.card)}>
      <div class="panel-card-slot" ref={slot}>
        <Show when={(open() && state() !== 'empty') || leaving()}>
          <div class="panel-card-body" id={bodyId(props.def.card)} inert={!!leaving()}>
            <CardBody def={props.def} state={state()} />
          </div>
        </Show>
      </div>
    </PanelCardBox>
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
      <CardBody def={props.def} state={props.state} />
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
  // The drawer's height without the part leaving: 0 once it was the last.
  function measure(card: string, closing: boolean): number {
    if (!parts().some((def) => def.card !== card)) return 0;
    const part = closing ? document.getElementById(bodyId(card)) : null;
    if (part) part.style.display = 'none';
    const to = slot.getBoundingClientRect().height;
    if (part) part.style.display = '';
    return to;
  }
  const toggle = createSlideToggle(() => slot, setLeaving, measure);

  return (
    <div class="panel-tile-row">
      <For each={tiles}>
        {(def, i) => <PanelCardBox def={def} kind="tile" open={open[i()]()} onToggle={() => toggle(def.card)} />}
      </For>
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
