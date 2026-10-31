import { parseGameKey, type GameKey } from './gameKey.ts';
import { getPref, setPref } from './prefs.ts';

// Recently looked-up games — carved out of gameSearch.ts (see docs/dev/frontend.md) so this
// storage layer is separate from that file's combobox/debounce UI, and so it
// can back a new first-class, browsable "Recently Looked Up" system list (/game, see
// ListRoute.tsx) rather than only ever being a dropdown convenience feed. Repointed at prefs.ts's
// shared blob (the 'recentGames' key) instead of its own standalone localStorage key — one more
// preference the same future per-key server sync (see prefs.ts) can reach, same reasoning every other
// preference here already follows. No migration from the old standalone key: this whole feature
// is part of a full frontend replacement (see docs/dev/lists-and-accounts.md's own "no migration"
// decision) — an existing user's recent-games history just resets once.
//
// Unlike accountsStore.ts's recentAccounts (namespaced per account, uncapped, soft-removable
// while referenced by a dynamic list), a game looked up via search means the same thing
// regardless of which page/list it was looked up from, so this stays one flat, capped,
// hard-removable list — nothing here can be a dynamic-list *source's own dependency* the way an
// account or another user list can (a "recent-games" ListRef just reads this list directly, see
// listResolve.ts), so there's no soft-delete concern to carry over.

const RECENT_GAMES_PREF_KEY = 'recentGames';
export const MAX_RECENT_GAMES = 500;

export interface RecentGame {
  appid: GameKey;
  name: string;
  tinyImage: string | null;
}

// An appid, or a canonical `igdb:N`.
const isStoredKey = (appid: unknown): boolean =>
  typeof appid === 'number' ? Number.isSafeInteger(appid) && appid > 0 : parseGameKey(String(appid)) === appid;

// Drops broken entries: a tab opened before games outside Steam stores `appid: null` when it picks an `igdb:N` one.
export function loadRecentGames(): RecentGame[] {
  return getPref<RecentGame[]>(RECENT_GAMES_PREF_KEY, []).filter((g) => isStoredKey(g?.appid));
}

// Moves this game to the front, refreshing its cached name/thumbnail, rather than appending a
// duplicate. An empty `name`/`tinyImage` never overwrites one already stored: a lookup by bare
// appid or store URL knows no name at all (gameSearch.ts's `pick({ appid, name: '' })`), and
// letting that blank out an entry whose real name was resolved on an earlier visit would leave
// the "Recently Looked Up" list showing nothing for a game it had already identified.
export function addRecentGame(appid: GameKey, name: string, tinyImage?: string | null): void {
  const list = loadRecentGames();
  const existing = list.find((g) => g.appid === appid);
  const rest = list.filter((g) => g.appid !== appid);
  rest.unshift({ appid, name: name || existing?.name || '', tinyImage: tinyImage || existing?.tinyImage || null });
  setPref(RECENT_GAMES_PREF_KEY, rest.slice(0, MAX_RECENT_GAMES));
}

// Fills in a stored entry's name/thumbnail *without* moving it to the front — for a game whose
// real name only became known after it was already recorded (an appid/URL lookup, whose name
// resolves from store metadata a moment later). addRecentGame would reorder the list, which is
// wrong here: nothing was looked up again, an existing entry just learned its own name.
export function renameRecentGame(appid: GameKey, name: string, tinyImage?: string | null): void {
  const list = loadRecentGames();
  const idx = list.findIndex((g) => g.appid === appid);
  if (idx === -1) return;
  const next = list.slice();
  next[idx] = { appid, name: name || list[idx].name, tinyImage: tinyImage || list[idx].tinyImage };
  setPref(RECENT_GAMES_PREF_KEY, next);
}
