// Shared prev/next/random nav-bar rendering for the game detail side panel (`#panel-nav`) —
// extracted from library.js's and bundles.js's own near-identical copies (same markup/CSS/keys,
// see docs/dev/frontend.md's side-panel section). Each page keeps its own `getGameList()` (its table's current
// search/filter/sort order — the data shape differs enough per page that the list itself stays
// local) and passes it in here.

import { createComponent, createEffect, createRoot } from 'solid-js';
import ChevronDown from 'lucide-solid/icons/chevron-down';
import ChevronUp from 'lucide-solid/icons/chevron-up';
import Dices from 'lucide-solid/icons/dices';
import type { GameKey } from './gameKey.ts';

// What the bar and the steps need of a row: a Steam row, or (on /search) a game outside Steam.
type NavGame = { readonly appid: GameKey; readonly standalone?: boolean };

let disposeNav: (() => void) | null = null;

// Empties the bar and stops its position tracking.
export function clearPanelNav(): void {
  disposeNav?.();
  disposeNav = null;
  document.getElementById('panel-nav')?.replaceChildren();
}

// Nothing to page through for a standalone lookup, or before ListRoute's table exists (`hasList`).
// "i / N" tracks `getGameList` reactively; ↑/↓ resolve the list at click time, like the keys.
export function renderPanelNav<T extends NavGame>({
  hasList,
  game,
  getGameList,
  onStep,
  onReroll,
}: {
  hasList: boolean;
  game: NavGame;
  getGameList: () => T[];
  onStep: (dir: 1 | -1) => void;
  onReroll: () => void;
}): void {
  clearPanelNav();
  if (!hasList || game.standalone) return;
  const nav = document.getElementById('panel-nav')!;
  nav.innerHTML = `
    <button class="panel-nav-btn" id="panel-prev" aria-label="Previous game" title="Previous game (↑)"></button>
    <output class="panel-nav-pos" aria-live="polite"></output>
    <button class="panel-nav-btn" id="panel-next" aria-label="Next game" title="Next game (↓)"></button>
    <button class="panel-nav-btn panel-nav-reroll" id="panel-reroll" aria-label="Pick a random game" title="Pick a random game (R)"><span class="panel-nav-kbd">R</span></button>
  `;
  const prev = document.getElementById('panel-prev')!;
  const next = document.getElementById('panel-next')!;
  const reroll = document.getElementById('panel-reroll')!;
  const pos = nav.querySelector<HTMLElement>('.panel-nav-pos')!;
  prev.addEventListener('click', () => onStep(-1));
  next.addEventListener('click', () => onStep(1));
  reroll.addEventListener('click', onReroll);
  createRoot((dispose) => {
    disposeNav = dispose;
    // `<ChevronUp />` and co. without JSX: this module stays .ts for its Node tests.
    prev.append(createComponent(ChevronUp, {}) as Node);
    next.append(createComponent(ChevronDown, {}) as Node);
    reroll.prepend(createComponent(Dices, {}) as Node);
    createEffect(() => {
      const list = getGameList();
      const idx = list.findIndex((g) => g.appid === game.appid);
      // A game the table no longer shows has no place to step from; `visibility` keeps the dice in place.
      prev.style.visibility = next.style.visibility = idx === -1 ? 'hidden' : '';
      pos.textContent = idx === -1 ? '' : `${idx + 1} / ${list.length}`;
    });
  });
}

// The step `getGameList()` itself does for ArrowLeft/Right-in-the-lightbox nav (see
// navigateLightboxGame in library.js/bundles.js) — pulled out so both pages' lightbox handler
// and the nav-bar buttons above share the exact same "current index, wrap around" arithmetic.
// Returns null when there's nothing to step to (a standalone lookup, or the current game
// somehow isn't in the list).
export function stepGameList<T extends NavGame>(list: T[], currentGame: NavGame | null, dir: 1 | -1): T | null {
  if (!currentGame || currentGame.standalone) return null;
  const idx = list.findIndex((g) => g.appid === currentGame.appid);
  if (idx === -1) return null;
  return list[(idx + dir + list.length) % list.length];
}
