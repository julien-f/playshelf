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
  appid: number;
  name: string;
  tinyImage: string | null;
  // Epoch ms of the latest lookup; absent on entries recorded before it was kept.
  lookedUpAt?: number;
}

// A pick writes its entry twice (on select, then once details land): the second keeps the first's stamp.
const SAME_LOOKUP_MS = 60_000;

// The Looked up column's value: an ISO timestamp, which the table's date sort and grouping read.
export function lookedUpValue(g: RecentGame): string | null {
  return g.lookedUpAt === undefined ? null : new Date(g.lookedUpAt).toISOString();
}

export function loadRecentGames(): RecentGame[] {
  return getPref<RecentGame[]>(RECENT_GAMES_PREF_KEY, []);
}

// Moves this game to the front, refreshing its cached name/thumbnail, rather than appending a
// duplicate. An empty `name`/`tinyImage` never overwrites one already stored: a lookup by bare
// appid or store URL knows no name at all (gameSearch.ts's `pick({ appid, name: '' })`), and
// letting that blank out an entry whose real name was resolved on an earlier visit would leave
// the "Recently Looked Up" list showing nothing for a game it had already identified.
export function addRecentGame(appid: number, name: string, tinyImage?: string | null): void {
  const list = loadRecentGames();
  const existing = list.find((g) => g.appid === appid);
  const rest = list.filter((g) => g.appid !== appid);
  const now = Date.now();
  const stamp =
    existing === list[0] && existing?.lookedUpAt !== undefined && now - existing.lookedUpAt < SAME_LOOKUP_MS
      ? existing.lookedUpAt
      : now;
  rest.unshift({
    appid,
    name: name || existing?.name || '',
    tinyImage: tinyImage || existing?.tinyImage || null,
    lookedUpAt: stamp,
  });
  setPref(RECENT_GAMES_PREF_KEY, rest.slice(0, MAX_RECENT_GAMES));
}

// Fills in a stored entry's name/thumbnail *without* moving it to the front — for a game whose
// real name only became known after it was already recorded (an appid/URL lookup, whose name
// resolves from store metadata a moment later). addRecentGame would reorder the list, which is
// wrong here: nothing was looked up again, an existing entry just learned its own name.
export function renameRecentGame(appid: number, name: string, tinyImage?: string | null): void {
  const list = loadRecentGames();
  const idx = list.findIndex((g) => g.appid === appid);
  if (idx === -1) return;
  const next = list.slice();
  next[idx] = { ...list[idx], name: name || list[idx].name, tinyImage: tinyImage || list[idx].tinyImage };
  setPref(RECENT_GAMES_PREF_KEY, next);
}
