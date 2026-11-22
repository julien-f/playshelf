// Which panel cards are open: one device-only pref, the same for every game, route and account.
import { createMemo, createRoot } from 'solid-js';
import { getPref, setPref } from './prefs.ts';

const PANEL_OPEN_CARDS_KEY = 'panelOpenCards';
// Price was always open before cards folded: buying is its point. Only while the pref is unset.
const DEFAULT_OPEN = ['price'];

// One Set per change, not per card: getPref hands out a fresh array.
const openCards = createRoot(() => createMemo(() => new Set(getPref<string[]>(PANEL_OPEN_CARDS_KEY, DEFAULT_OPEN))));

export const isPanelCardOpen = (card: string): boolean => openCards().has(card);

export function togglePanelCard(card: string): void {
  const next = new Set(openCards());
  if (!next.delete(card)) next.add(card);
  setPref(PANEL_OPEN_CARDS_KEY, [...next]);
}
