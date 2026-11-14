// The hero card at the top of every list route — the one place a list says what it *is* before
// its table says what's in it (see ListRoute.tsx's own heroTiles/hero JSX for each kind's
// content). Generalized from what used to be `kind === 'bundle'`-only markup: a bundle got a
// title, its shop/dates/tiers/counts as labelled tiles and ITAD's note, while every other kind
// opened with an unlabelled gray "Updated 3h ago" line and no name at all — `/lists/owned`
// didn't even say whose library was on screen (only <title> did, via pageTitle.ts).
//
// Deliberately dumb: no data of its own, no per-kind branching. Callers pass already-formatted
// values, so "what does a wishlist show" stays answerable in one place (ListRoute.tsx) rather
// than being split between there and here.
//
// `lead`/`chips`/`actions`/`note` are eagerly-created JSX props (built once by the caller's own
// render, reactive internally through whatever signals they read); `tiles` is a plain array
// recomputed as its inputs change. That split is on purpose — buttons keep their identity across
// a count/age change, and a tile's own value can't hold state worth preserving.
//
// The tiles render through `<Index>`, not `<For>`: a recompute builds fresh tile objects every
// time, so `<For>`'s by-reference keying tore every tile's DOM down and rebuilt it on any change
// — which a clickable tile (see `onClick`) can't afford, since activating one recomputes the
// array and the button the user was on would be replaced mid-interaction, dropping keyboard
// focus. `<Index>` keys by position and patches each tile's contents in place instead.
import { createSignal, createUniqueId, Index, Show, type JSX } from 'solid-js';
import { createCountUp } from './motion.ts';
import Ellipsis from 'lucide-solid/icons/ellipsis';
import RefreshCw from 'lucide-solid/icons/refresh-cw';

// One of a tile's chips (a bundle's tiers): a toggle with `onClick`, else plain text.
interface HeroChip {
  text: string;
  title: string;
  ariaLabel?: string;
  active?: boolean;
  onClick?: () => void;
}

export interface HeroTile {
  // Uppercased by CSS — write it in sentence case ("Ends", "Best deal"), not shouting.
  label: string;
  value?: JSX.Element;
  // In place of `value`, rendered here so a chip's button keeps its node (and focus) as the tiles recompute.
  chips?: HeroChip[];
  // A number `value` counts to its new value as it changes (motion.ts's createCountUp); its colour, if any.
  valueColor?: string;
  // A second, smaller line under the value (a qualifier, not a second fact — "on Steam",
  // "Updated 2h ago").
  sub?: JSX.Element;
  // Native tooltip on the value, for the number this tile is deliberately *not* showing
  // (e.g. ITAD's own game count next to the count this route can actually enumerate).
  title?: string;
  // Puts a real <button> in the tile — for a tile whose number is also a way to
  // act on it (`/bundles`' "Ending soon", which toggles the table down to those rows). `active`
  // is its pressed state, read back from whatever the click applied rather than held here, so
  // undoing it elsewhere (the table's own Clear filters) unpresses the tile. Left out on a plain
  // action (Updated's refresh), which then carries no aria-pressed: it isn't a toggle.
  onClick?: () => void;
  active?: boolean;
  // A tile whose action is momentarily unavailable (a refresh already in flight). Still a button,
  // so the row doesn't reflow as it flips back and forth; aria-disabled, not disabled, so the
  // focus of the click that started it stays put.
  disabled?: boolean;
  // A second action, on the `sub` line — for the one tile that states two facts a reader can act
  // on separately (Prices: the region its value names, opened with the tile's own click, and how
  // old those prices are, re-fetched with this one). A tile with one gives up being a button
  // itself, since the two controls would otherwise have to nest, which HTML doesn't allow.
  subOnClick?: () => void;
  subDisabled?: boolean;
  subTitle?: string;
}

interface ListHeroProps {
  title: string;
  lead?: JSX.Element; // before the title — the bundle route's ‹/› nav
  chips?: JSX.Element; // after the title — kind/shop/account chips
  actions?: JSX.Element; // right-hand side of the title row — refresh, outbound links
  // Some actions carry `hero-secondary`: on a phone they fold behind a ⋯ toggle.
  secondaryActions?: boolean;
  tiles?: HeroTile[];
  note?: JSX.Element; // its own line under the tiles — prose (ITAD's note, a list's formula)
  section?: JSX.Element; // a block of its own under the note — a comparison's players
}

export function ListHero(props: ListHeroProps): JSX.Element {
  const [moreOpen, setMoreOpen] = createSignal(false);
  const uid = createUniqueId();
  return (
    <header class="list-hero">
      <div class="list-hero-header">
        <div class="list-hero-titlebar">
          {props.lead}
          <h1 class="list-hero-title">{props.title}</h1>
          {props.chips}
        </div>
        <Show when={props.actions}>
          <div class="list-hero-actions" classList={{ 'list-hero-actions--open': moreOpen() }}>
            {props.actions}
            <Show when={props.secondaryActions}>
              <button
                type="button"
                class="btn list-hero-more"
                aria-label="More actions"
                aria-expanded={moreOpen()}
                onClick={() => setMoreOpen((v) => !v)}
              >
                <Ellipsis />
              </button>
            </Show>
          </div>
        </Show>
      </div>
      <Show when={props.tiles?.length}>
        <dl class="list-hero-stats">
          <Index each={props.tiles}>
            {(tile, i) => {
              const id = `${uid}-${i}`;
              const isButton = () => !!tile().onClick && !tile().subOnClick;
              const counting = createCountUp(
                () => tile().value,
                () => tile().label,
              );
              const colored = (v: JSX.Element) => (
                <Show when={tile().valueColor} fallback={v}>
                  {(color) => <span style={{ color: color() }}>{v}</span>}
                </Show>
              );
              const chips = () => (
                <span class="bundle-tier-chips">
                  <Index each={tile().chips}>
                    {(chip) => (
                      <Show
                        when={chip().onClick}
                        fallback={
                          <span
                            class="bundle-tier-chip"
                            classList={{ 'bundle-tier-chip--active': !!chip().active }}
                            title={chip().title}
                          >
                            {chip().text}
                          </span>
                        }
                      >
                        <button
                          type="button"
                          class="bundle-tier-chip list-stat-btn"
                          title={chip().title}
                          aria-label={chip().ariaLabel}
                          aria-pressed={!!chip().active}
                          onClick={() => chip().onClick?.()}
                        >
                          {chip().text}
                        </button>
                      </Show>
                    )}
                  </Index>
                </span>
              );
              // Mid-count, the final value stays the text read out and copied; the steps are only drawn.
              const value = () => (
                <Show when={!tile().chips} fallback={chips()}>
                  <Show when={counting()} fallback={colored(tile().value)}>
                    {(n) => (
                      <>
                        <span class="list-stat-count" aria-hidden="true">
                          {colored(n())}
                        </span>
                        <span class="visually-hidden">{tile().value}</span>
                      </>
                    )}
                  </Show>
                </Show>
              );
              return (
                <div class="list-stat">
                  <dt class="list-stat-label" id={`${id}-label`}>
                    {tile().label}
                  </dt>
                  {/* Two actions: a button per line (no nested buttons); one: value and sub-line in one button. */}
                  <dd>
                    <Show
                      when={isButton()}
                      fallback={
                        <>
                          <Show
                            when={tile().onClick && tile().subOnClick}
                            fallback={
                              <span class="list-stat-value" title={tile().title}>
                                {value()}
                              </span>
                            }
                          >
                            <button
                              type="button"
                              class="list-stat-value list-stat-btn"
                              id={`${id}-value`}
                              aria-labelledby={`${id}-label ${id}-value`}
                              title={tile().title}
                              aria-disabled={tile().disabled ? 'true' : undefined}
                              onClick={() => !tile().disabled && tile().onClick?.()}
                            >
                              {value()}
                            </button>
                          </Show>
                          <Show when={tile().sub}>
                            <Show when={tile().subOnClick} fallback={<span class="list-stat-sub">{tile().sub}</span>}>
                              <button
                                type="button"
                                class="list-stat-sub list-stat-btn"
                                id={`${id}-sub`}
                                aria-labelledby={`${id}-label ${id}-sub`}
                                title={tile().subTitle}
                                aria-disabled={tile().subDisabled ? 'true' : undefined}
                                onClick={() => !tile().subDisabled && tile().subOnClick?.()}
                              >
                                {tile().sub}
                              </button>
                            </Show>
                          </Show>
                        </>
                      }
                    >
                      <button
                        type="button"
                        class="list-stat-btn"
                        id={`${id}-btn`}
                        aria-labelledby={`${id}-label ${id}-btn`}
                        aria-pressed={tile().active}
                        aria-disabled={tile().disabled ? 'true' : undefined}
                        onClick={() => !tile().disabled && tile().onClick?.()}
                      >
                        <span class="list-stat-value" title={tile().title}>
                          {value()}
                        </span>
                        <Show when={tile().sub}>
                          <span class="list-stat-sub">{tile().sub}</span>
                        </Show>
                      </button>
                    </Show>
                  </dd>
                </div>
              );
            }}
          </Index>
        </dl>
      </Show>
      <Show when={props.note}>
        <div class="list-hero-note">{props.note}</div>
      </Show>
      {props.section}
    </header>
  );
}

// The ↻ a refresh tile needs to advertise itself: a tile carries no chrome of its own, so once
// the route's own ↻ Refresh button is gone (it did exactly what clicking the tile does), the
// hover state is otherwise the only hint the tile is a control at all. Composed by the caller
// into its `value` rather than added here as a prop, so the card stays dumb about what any
// tile's click means.
export function refreshTileValue(text: string): JSX.Element {
  return (
    // One inline run: a two-action tile's sub-line button is a flex column.
    <span>
      {text} <RefreshCw class="list-stat-icon" />
    </span>
  );
}
