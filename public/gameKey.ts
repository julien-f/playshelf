import type { IgdbRow, PanelGame } from './types.ts';

// Which game: a Steam appid, or `igdb:<id>` for a game outside Steam (never stored in prefs).
export type IgdbKey = `igdb:${number}`;
export type GameKey = number | IgdbKey;

export const isIgdbKey = (key: GameKey | null | undefined): key is IgdbKey => typeof key === 'string';

export const isIgdbRow = (g: PanelGame): g is IgdbRow => isIgdbKey(g.appid);

export const igdbIdOf = (key: IgdbKey): number => Number(key.slice('igdb:'.length));

// A path segment or `?game=` value: `igdb:N` (also `%3A`-encoded) for IGDB, else `Number(raw)`, which callers validate.
export function parseGameKey(raw: string): GameKey {
  const igdb = /^igdb(?::|%3A)(\d+)$/i.exec(raw)?.[1];
  return igdb && Number(igdb) > 0 ? `igdb:${Number(igdb)}` : Number(raw);
}
