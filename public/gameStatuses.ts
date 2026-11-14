// The player's own statuses for games Steam can't tell from unplayed: one map for whoever uses this
// browser, not per account — a Family's or solo slot's id would split one person's statuses.
import { createMemo, createRoot } from 'solid-js';
import { getPref, setPref } from './prefs.ts';

export type GameStatus = 'finished' | 'abandoned';

const GAME_STATUSES_KEY = 'gameStatuses';

// Stored as one letter per game: the whole map is one synced key, flushed with keepalive (64 KiB) on tab hide.
const CODES: Record<GameStatus, string> = { finished: 'f', abandoned: 'a' };
const BY_CODE: Record<string, GameStatus> = { f: 'finished', a: 'abandoned' };

export const STATUS_LABELS: Record<GameStatus, string> = { finished: 'Finished', abandoned: 'Abandoned' };

// One copy per change, not per row: getPref hands out a fresh copy of the whole map.
const statusMap = createRoot(() => createMemo(() => getPref<Record<string, string>>(GAME_STATUSES_KEY, {})));

export function getStatus(appid: number): GameStatus | null {
  return BY_CODE[statusMap()[appid]] ?? null;
}

export function setStatus(appid: number, status: GameStatus | null): void {
  const { [appid]: _previous, ...rest } = getPref<Record<string, string>>(GAME_STATUSES_KEY, {});
  setPref(GAME_STATUSES_KEY, status ? { ...rest, [appid]: CODES[status] } : rest);
}
