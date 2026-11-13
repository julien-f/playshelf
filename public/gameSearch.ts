import { esc, fetchJson, isTextEntry } from './utils.ts';
import { focusVisible, handOffFocus, inViewport } from './focusHandoff.ts';
import { createComponent, createEffect, untrack } from 'solid-js';
import ArrowRight from 'lucide-solid/icons/arrow-right';
import { peekMyOwnership, trackMyOwnership } from './myOwnership.ts';
import type { OwnershipStatus } from './myOwnership.ts';

export interface GameSearchResult {
  appid: number;
  name: string;
  tinyImage: string | null;
}

// The nav bar's "look up any game" widget (AppShell), opening the side panel for an arbitrary
// Steam game, independent of anyone's library or wishlist.
//
// initGameSearch({ inputEl, resultsEl, onSelect, recents, onSeeAllRecents, onSeeAllResults }):
//  - inputEl:   the text input the user types a name, appid, or store URL into
//  - resultsEl: container the dropdown of name-search matches renders into (hidden when empty)
//  - onSelect({ appid, name }): called when the user picks a result, or presses Enter with a
//    raw appid/store URL typed in (name is '' in that case — the caller derives it from store
//    metadata once /api/game-details resolves)
//  - recents(): recently looked-up games, shown in the same dropdown whenever the box is
//    focused/clicked while empty. Picked exactly like a search match (same shape, same onSelect).
//  - onSeeAllRecents(): the "see all" row under that list
//  - onSeeAllResults(term): the analogous trailing row under actual search matches

export const GAME_SEARCH_DEBOUNCE_MS = 300;
export const GAME_SEARCH_MIN_CHARS = 2;

// Throws on a failed request, so callers can tell it from no match.
export async function searchGames(term: string): Promise<GameSearchResult[]> {
  const url = `/api/search-games?q=${encodeURIComponent(term)}`;
  const data = await fetchJson<{ results?: GameSearchResult[] }>(url, undefined, 'Search failed');
  return data.results || [];
}

// Recognizes a bare appid ("1245620") or a Steam store URL containing "/app/<id>" — either
// way, no name search is needed; the appid alone is enough to open the panel.
export function parseDirectAppid(raw: string): number | null {
  const text = raw.trim();
  if (/^\d+$/.test(text)) return Number(text);
  const m = text.match(/\/app\/(\d+)/);
  return m ? Number(m[1]) : null;
}

// Small "already owned/wishlisted" markers next to a result — same `myOwnership.ts` status
// (checked against `currentAccount`, whichever account's list is actually on screen) the side
// panel's own ownership badge shows, so a lookup reports the same thing whether it's opened from
// this dropdown or already open in the panel. The ownership peek never blocks (a search
// result list re-renders on every keystroke) — see `MyOwnershipPeek.status` for what `null` means here
// (no `currentAccount` loaded, or the fetch simply hasn't landed yet).
export function ownershipMarkersHtml(status: OwnershipStatus | null): string {
  if (!status) return '';
  const marks: string[] = [];
  if (status.inLibrary) marks.push('<span class="game-search-badge owned" title="Owned">✓</span>');
  if (status.onWishlist) marks.push('<span class="game-search-badge wishlisted" title="On wishlist">☆</span>');
  return marks.join('');
}

// `active`: true for the result currently highlighted via ArrowUp/ArrowDown (not hover —
// hover is native `:hover`/`:focus-visible` CSS, this is the keyboard roving selection).
// `id` + `role="option"` back `inputEl`'s `aria-activedescendant` in initGameSearch below;
// `tabindex="-1"` keeps real DOM focus on the input the whole time, same combobox pattern
// as a native `<select>`'s listbox — arrow keys move the highlight, not focus itself.
export function gameSearchResultHtml(
  r: GameSearchResult,
  active: boolean,
  ownership: OwnershipStatus | null = null,
): string {
  const thumb = r.tinyImage
    ? `<img class="game-search-thumb" src="${esc(r.tinyImage)}" alt="" loading="lazy">`
    : '<span class="game-search-thumb game-search-thumb--empty"></span>';
  return `
    <button type="button" id="game-search-opt-${esc(r.appid)}" role="option" aria-selected="${active}" tabindex="-1"
      class="game-search-result${active ? ' active' : ''}" data-appid="${esc(r.appid)}" data-name="${esc(r.name)}">
      ${thumb}
      <span class="game-search-name">${esc(r.name)}</span>
      ${ownershipMarkersHtml(ownership)}
    </button>
  `;
}

// The dropdown's trailing "see all" row and, for the recents view, a section heading above it.
// The heading carries `role="presentation"` (it's not selectable), but the "see all" row is a
// real option — it takes part in the same ArrowUp/ArrowDown roving selection as the results
// above it (as the last virtual index, see moveActive/renderResults), so it's reachable without
// a mouse. `tabindex="-1"` matches every option: real DOM focus stays on the input throughout.
export function gameSearchSectionHtml(label: string): string {
  return `<div class="game-search-section" role="presentation">${esc(label)}</div>`;
}

// Shown in place of results, so an empty or failed search doesn't look like nothing happened.
export function gameSearchEmptyHtml(term: string, failed = false): string {
  const text = failed ? 'Search failed — try again' : `No games match “${term}”`;
  return `<div class="game-search-empty" role="status">${esc(text)}</div>`;
}

export function gameSearchMoreHtml(label: string, active = false): string {
  return `<button type="button" id="game-search-more-opt" role="option" aria-selected="${active}" tabindex="-1"
    class="game-search-more${active ? ' active' : ''}">${esc(label)}</button>`;
}

// Should the dropdown show recently looked-up games rather than search matches? Only for a
// genuinely empty box: one or more characters typed means the user is searching, and a
// half-typed term (below GAME_SEARCH_MIN_CHARS) showing an unrelated recents list instead of
// simply nothing would read as a broken search, not as a shortcut.
// The dropdown shows the latest few; its "see all" row opens the whole history.
const RECENTS_SHOWN = 10;

export function shouldShowRecents(rawValue: string): boolean {
  return rawValue.trim() === '';
}

export function initGameSearch({
  inputEl,
  resultsEl,
  onSelect,
  recents,
  onSeeAllRecents,
  onSeeAllResults,
}: {
  inputEl: HTMLInputElement;
  resultsEl: HTMLElement;
  onSelect: (game: GameSearchResult) => void;
  // Recently looked-up games, shown when the box is focused but empty — the storage behind them
  // (recentGames.ts) is injected rather than imported so this file stays the combobox/debounce UI
  // it was carved down to, and so the caller owns what "see all" means (a route to navigate to,
  // which this module knows nothing about).
  recents: () => GameSearchResult[];
  onSeeAllRecents: () => void;
  onSeeAllResults: (term: string) => void;
}) {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastResults: GameSearchResult[] = [];
  let lastTerm = ''; // the search that produced lastResults, for the "see all results" row's label/target
  let activeFetch = 0; // guards against a slower earlier request clobbering a faster later one
  let activeIdx = -1; // ArrowUp/ArrowDown highlight; -1 = none yet (Enter falls back to the top match)
  // Whether what's currently in the dropdown is the recents list rather than search matches —
  // the results themselves are the same `GameSearchResult` shape either way (and pick the same
  // way), so this only drives the heading/"see all" chrome around them.
  let showingRecents = false;
  let escClosedResults = false; // the last Esc closed the dropdown, so the next one empties the box
  // `<ArrowRight />` without JSX: this module stays .ts for its Node tests. Moved into each re-render.
  const moreArrow = createComponent(ArrowRight, {}) as Node;

  resultsEl.setAttribute('role', 'listbox');
  inputEl.setAttribute('aria-autocomplete', 'list');
  inputEl.setAttribute('aria-expanded', 'false');
  if (resultsEl.id) inputEl.setAttribute('aria-controls', resultsEl.id);

  // Whether the trailing "see all" row is shown at all — always for recents (showResults only
  // gets called with a non-empty recents list), only alongside actual matches otherwise. It's
  // the roving selection's last virtual index (lastResults.length), one past the real options.
  function moreRowShown(): boolean {
    return showingRecents || lastResults.length > 0;
  }

  function renderResults() {
    const moreActive = moreRowShown() && activeIdx === lastResults.length;
    const peek = peekMyOwnership();
    const options = lastResults.map((r, i) => gameSearchResultHtml(r, i === activeIdx, peek.status(r.appid))).join('');
    const moreHtml = !moreRowShown()
      ? ''
      : gameSearchMoreHtml(
          showingRecents ? 'See all Recently Looked Up ' : `See all results for "${lastTerm}" `,
          moreActive,
        );
    resultsEl.innerHTML = showingRecents
      ? gameSearchSectionHtml('Recently Looked Up') + options + moreHtml
      : options + moreHtml;
    resultsEl.querySelector('#game-search-more-opt')?.append(moreArrow);
    if (activeIdx >= 0 && activeIdx < lastResults.length)
      inputEl.setAttribute('aria-activedescendant', `game-search-opt-${lastResults[activeIdx].appid}`);
    else if (moreActive) inputEl.setAttribute('aria-activedescendant', 'game-search-more-opt');
    else inputEl.removeAttribute('aria-activedescendant');
  }

  function showResults(results: GameSearchResult[], { recent = false }: { recent?: boolean } = {}) {
    lastResults = results;
    activeIdx = -1;
    showingRecents = recent;
    if (!results.length) {
      hideResults();
      return;
    }
    renderResults();
    resultsEl.hidden = false;
    inputEl.setAttribute('aria-expanded', 'true');
  }

  function hideResults() {
    // A pending or in-flight search would reopen what was just closed.
    if (debounceTimer != null) clearTimeout(debounceTimer);
    activeFetch++;
    lastResults = [];
    activeIdx = -1;
    showingRecents = false;
    resultsEl.hidden = true;
    resultsEl.innerHTML = '';
    inputEl.setAttribute('aria-expanded', 'false');
    inputEl.removeAttribute('aria-activedescendant');
  }

  // The open dropdown's ✓/☆ markers follow the ownership cache landing and the account changing.
  createEffect(() => {
    trackMyOwnership();
    if (!resultsEl.hidden) untrack(renderResults);
  });

  // dir: 1 (ArrowDown) or -1 (ArrowUp). Wraps at both ends, same `(idx + dir + len) % len`
  // convention panel.js/library.js use for prev/next game paging — except the very first
  // press, which has no current index to offset from: ArrowDown starts at the top result,
  // ArrowUp starts at the bottom one, matching most native combobox widgets.
  function moveActive(dir: number) {
    const total = lastResults.length + (moreRowShown() ? 1 : 0);
    if (!total) return;
    activeIdx = activeIdx === -1 ? (dir > 0 ? 0 : total - 1) : (activeIdx + dir + total) % total;
    renderResults();
    resultsEl
      .querySelector('.game-search-result.active, .game-search-more.active')
      ?.scrollIntoView({ block: 'nearest' });
  }

  async function runSearch(term: string) {
    const fetchId = ++activeFetch;
    try {
      const results = await searchGames(term);
      if (fetchId !== activeFetch) return; // a newer keystroke's request already landed
      if (document.activeElement !== inputEl) return; // left the box (Tab, say) before it answered
      lastTerm = term;
      if (results.length) showResults(results);
      else showEmpty(term, false);
    } catch {
      if (fetchId === activeFetch && document.activeElement === inputEl) showEmpty(term, true);
    }
  }

  function showEmpty(term: string, failed: boolean) {
    hideResults();
    resultsEl.innerHTML = gameSearchEmptyHtml(term, failed);
    resultsEl.hidden = false;
  }

  function pick(game: GameSearchResult) {
    hideResults();
    inputEl.value = '';
    onSelect(game);
  }

  function activateMore() {
    const term = lastTerm;
    const wasRecents = showingRecents;
    hideResults();
    if (wasRecents) onSeeAllRecents();
    else onSeeAllResults(term);
  }

  // Recently looked-up games in the same dropdown, on an empty box — the convention every store
  // and browser search bar already uses, so it costs no nav-bar space of its own and needs no
  // second widget. Returns whether there was anything to show.
  function showRecents(): boolean {
    const list = recents();
    if (!list.length) return false;
    showResults(list.slice(0, RECENTS_SHOWN), { recent: true });
    return true;
  }

  // Both events, not just focus: clicking an already-focused box (after Escape closed the
  // dropdown, say) fires no focus event, and "click the search box, see my recents" is exactly
  // the gesture this is for.
  const openRecentsIfEmpty = () => {
    if (shouldShowRecents(inputEl.value)) showRecents();
  };
  inputEl.addEventListener('focus', openRecentsIfEmpty);
  // Where focus came from (`/`, a click or Tab), for Esc to hand it back.
  let cameFrom: HTMLElement | null = null;
  inputEl.addEventListener('focus', (e) => {
    const from = e.relatedTarget;
    cameFrom = from instanceof HTMLElement && !isTextEntry(from) ? from : null;
  });
  inputEl.addEventListener('click', openRecentsIfEmpty);

  inputEl.addEventListener('blur', () => (escClosedResults = false));

  inputEl.addEventListener('input', () => {
    escClosedResults = false;
    if (debounceTimer != null) clearTimeout(debounceTimer);
    const term = inputEl.value.trim();
    // Cleared back to empty — that's the recents view again, not just an empty dropdown.
    if (shouldShowRecents(inputEl.value)) {
      if (!showRecents()) hideResults();
      return;
    }
    // A raw appid/URL doesn't need a name search — hide any stale dropdown instead.
    if (term.length < GAME_SEARCH_MIN_CHARS || parseDirectAppid(term) != null) {
      hideResults();
      return;
    }
    debounceTimer = setTimeout(() => runSearch(term), GAME_SEARCH_DEBOUNCE_MS);
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault(); // so the page's own Esc doesn't also close the panel
      const wasOpen = !resultsEl.hidden;
      hideResults();
      if (wasOpen) {
        escClosedResults = true;
        return;
      }
      // Leave the box, so the page's own shortcuts work again.
      if (escClosedResults) inputEl.value = '';
      // Not one scrolled out of sight since: focusing it would jump the page there.
      handOffFocus(() => !!cameFrom && inViewport(cameFrom) && focusVisible(cameFrom));
      return;
    }
    if (e.key === 'ArrowDown') {
      if (lastResults.length) e.preventDefault();
      moveActive(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      if (lastResults.length) e.preventDefault();
      moveActive(-1);
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    // Before the empty-term bail: the recents view, "more" row included, shows with an empty box.
    if (moreRowShown() && activeIdx === lastResults.length) {
      activateMore();
      return;
    }
    if (activeIdx >= 0 && lastResults[activeIdx]) {
      pick(lastResults[activeIdx]);
      return;
    }
    const term = inputEl.value.trim();
    if (!term) return;
    const directAppid = parseDirectAppid(term);
    if (directAppid != null) {
      pick({ appid: directAppid, name: '', tinyImage: null });
      return;
    }
    if (lastResults.length) pick(lastResults[0]); // no arrow-key highlight yet — same as clicking the top match
  });

  resultsEl.addEventListener('click', (e) => {
    if ((e.target as Element).closest('.game-search-more')) {
      activateMore();
      return;
    }
    const btn = (e.target as Element).closest('.game-search-result') as HTMLElement | null;
    if (!btn) return;
    pick({ appid: Number(btn.dataset.appid), name: btn.dataset.name ?? '', tinyImage: null });
  });

  // Dismiss the dropdown on a click outside the input's wrapper (input, clear button, dropdown).
  document.addEventListener('click', (e) => {
    if (!inputEl.parentElement!.contains(e.target as Node)) hideResults();
  });
}

// The "recently looked up games" storage/widget that used to live here moved to
// recentGames.ts (see docs/dev/frontend.md) — it's not combobox/debounce UI,
// and needed to be repointed at a new pref key to back the "Recently Looked Up" system list.
// This file shows that list again (the `recents` option above), but only ever as data handed in
// by the caller — the storage still isn't this module's, and neither is the route its "see all"
// row leads to.
