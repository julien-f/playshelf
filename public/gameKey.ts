import type { IgdbRow, PanelGame } from './types.ts';

// Which game: a Steam appid, or `igdb:<id>` for a game outside Steam (never stored in prefs).
export type IgdbKey = `igdb:${number}`;
export type GameKey = number | IgdbKey;

export const isIgdbKey = (key: GameKey | null | undefined): key is IgdbKey => typeof key === 'string';

// Not by key: a list's table row for a game outside Steam (types.ts's IgdbTableRow) carries one too.
export const isIgdbRow = (g: PanelGame): g is IgdbRow => 'igdb' in g;

// A list's row for a Steam game: types.ts's TableGame holds games outside Steam too.
export const isSteamRow = <T extends { appid: GameKey }>(row: T): row is Extract<T, { appid: number }> =>
  !isIgdbKey(row.appid);

export const igdbIdOf = (key: IgdbKey): number => Number(key.slice('igdb:'.length));

// A path segment or `?game=` value: `igdb:N` (also `%3A`-encoded) for IGDB, else `Number(raw)`, which callers validate.
export function parseGameKey(raw: string): GameKey {
  const igdb = /^igdb(?::|%3A)(\d+)$/i.exec(raw)?.[1];
  return igdb && Number(igdb) > 0 ? `igdb:${Number(igdb)}` : Number(raw);
}
