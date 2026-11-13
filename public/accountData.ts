// Account-scoped game data — owned games and wishlist, for a resolved AccountSlot. Clean,
// minimal fetch functions against the existing /api/common-games and /api/wishlist endpoints
// (see docs/dev/lists-and-accounts.md) rather than a
// mechanical copy of library.tsx's loadLibrary/loadWishlist, which are large UI-orchestration
// functions (row-building, table wiring, URL/history updates, accounts-bar rendering) — none of
// that belongs here; ListRoute.tsx owns the equivalent orchestration generically, for any list
// kind, not just account-scoped ones.
import { createSignal, type Signal } from 'solid-js';
import { isClientCacheFresh, steamVanity, fmtLastPlayed, postJson, safeHref } from './utils.ts';
import { accountIdFor } from './accountsStore.ts';
import type { AccountSlot } from './types.ts';

// An AccountSlot.id is itself the sorted-joined resolved member steam64 ids (see
// accountsStore.ts's accountIdFor) — so resolving an id back to its members is just splitting
// on '+', no lookup needed.
export function membersFromAccountId(accountId: string): string[] {
  return accountId.split('+').filter(Boolean);
}

export interface AccountLibraryGame {
  appid: number;
  name: string;
  playtimeMinutes: number; // summed across every member of the slot
  lastPlayedUnix: number; // max across members; 0 = never played
}

// One member account's stake in one game, for the panel's "Owned by" card. Derived from the
// per-member playtime/lastPlayed maps /api/common-games already returns alongside the games
// themselves — the summed/maxed numbers on AccountLibraryGame above are all a table row needs,
// but they flatten away exactly the per-member breakdown a merged Steam Family wants to see.
export interface GameOwner {
  name: string; // persona name, or the steamid when Steam knows no name for it
  minutes: number; // this member's own playtime
  lastPlayedSec: number; // 0 = owns it, never launched it
  recentMinutes: number; // Steam's last two weeks, 0 when its library copy is older than that too
}

export interface AccountWishlistItem {
  appid: number;
  priority: number;
  dateAdded: string | null;
}

// One member account of a slot, as /api/common-games returns it (a raw Steam
// GetPlayerSummaries player object plus the server's own `gameCount`) — only the fields this
// module reads. Everything is optional: a profile the API knows nothing about, or one it failed to
// answer for, still comes back as a bare `{ steamid, personaname, profileurl: '', placeholder: true }`
// (see getPlayerSummaries in lib/steam.js).
export interface RawAccountPlayer {
  steamid: string;
  personaname?: string;
  profileurl?: string;
  avatarmedium?: string;
  communityvisibilitystate?: number;
  gameCount?: number;
  timecreated?: number; // Unix seconds; absent for a private profile
  loccountrycode?: string; // ISO 3166-1 alpha-2, e.g. "US"; absent when unset or profile is private
  realname?: string; // absent unless the profile owner set one and made it public
  placeholder?: boolean;
}

// The shape of /api/common-games' success response, as read below — only the fields this
// module touches.
interface CommonGamesResponse {
  games: { appid: number; name: string }[];
  players: RawAccountPlayer[];
  fetchedAt: number | null;
  playtime: Record<number, Record<string, number>>;
  lastPlayed: Record<number, Record<string, number>>;
  recentPlaytime?: Record<number, Record<string, number>>;
}

// One member account's worth of display-ready data — everything Home's Account card renders,
// derived once here so the component itself stays plain JSX with no branching of its own to
// keep in sync with what's unit-tested.
export interface AccountPlayer {
  steamid: string;
  name: string;
  profileUrl: string; // '' when Steam returned no (or a non-http) profile URL — don't render a link
  avatarUrl: string; // '' likewise
  isPrivate: boolean; // communityvisibilitystate !== 3 — a private/friends-only profile
  gameCount: number | null;
  memberSince: string; // bare ISO date the account was created, '' when Steam didn't return one
  countryCode: string; // ISO 3166-1 alpha-2, '' when unset
  realName: string; // '' when unset — Steam's own realname is optional and privacy-gated
  placeholder: boolean; // Steam returned nothing for it: `name` is just the steamid
}

// Presence (`personastate`/`gameextrainfo`) is deliberately NOT mapped here, even though Steam
// returns it on the same response: it rides the `player:` cache entry, which sits on the library
// tier whose TTL is now measured in weeks (see default.env), so anything this app could say about
// "who's online" would be an assertion about a moment long past. The Account card shows how old
// its data is instead, with a ↻ to refresh it — an honest, actionable fact where presence was a
// dishonest one.
export function toAccountPlayer(p: RawAccountPlayer): AccountPlayer {
  return {
    steamid: p.steamid,
    name: p.personaname || p.steamid,
    profileUrl: safeHref(p.profileurl),
    avatarUrl: safeHref(p.avatarmedium),
    isPrivate: p.communityvisibilitystate !== undefined && p.communityvisibilitystate !== 3,
    gameCount: typeof p.gameCount === 'number' ? p.gameCount : null,
    memberSince: fmtLastPlayed(p.timecreated),
    countryCode: p.loccountrycode || '',
    realName: p.realname || '',
    placeholder: p.placeholder === true,
  };
}

// The member fields a slot is built from; a friend (AccountFriend) has them all but `placeholder`.
type SlotPlayer = Pick<AccountPlayer, 'steamid' | 'name' | 'profileUrl' | 'avatarUrl'> & {
  placeholder?: boolean;
};

// What refreshAccountInfo should store for an account from its players: no label while any of them
// is a placeholder, which would overwrite the stored name with a steamid.
export function accountInfoFrom(ps: SlotPlayer[]) {
  const vanities = Object.fromEntries(
    ps.flatMap((p) => (steamVanity(p.profileUrl) ? [[p.steamid, steamVanity(p.profileUrl)!]] : [])),
  );
  // A Family's faces, per member: a single account's is avatarUrl.
  const memberAvatars = Object.fromEntries(
    ps.length > 1 ? ps.flatMap((p) => (p.avatarUrl && !p.placeholder ? [[p.steamid, p.avatarUrl]] : [])) : [],
  );
  return {
    label: ps.some((p) => p.placeholder) ? undefined : ps.map((p) => p.name).join(' + '),
    avatarUrl: ps.length === 1 ? ps[0].avatarUrl : undefined,
    vanities: Object.keys(vanities).length ? vanities : undefined,
    memberAvatars: Object.keys(memberAvatars).length ? memberAvatars : undefined,
  };
}

export function accountSlotFrom(players: SlotPlayer[], rawInputs: string[]): AccountSlot {
  const members = players.map((p) => p.steamid).sort();
  const { label, avatarUrl, vanities, memberAvatars } = accountInfoFrom(players);
  const unresolved = players.filter((p) => p.placeholder).map((p) => p.steamid);
  return {
    ...(unresolved.length && { unresolved }),
    id: accountIdFor(members),
    members,
    rawInputs,
    label,
    avatarUrl: avatarUrl || undefined,
    vanities: vanities ?? {},
    ...(memberAvatars && { memberAvatars }),
  };
}

// The shape of /api/wishlist's success response, as read below.
interface WishlistResponse {
  items: { appid: number; priority: number; dateAdded: string | null }[];
  fetchedAt: number | null;
}

// One /api/common-games call's worth of everything this module reads from it: the slot's unioned
// library *and* its member accounts' own display data. They come back in the same response, so a
// caller that needs both (Home's Account card — owned count plus a per-member profile link/status/
// game count) gets them for one request rather than two identical POSTs.
export interface AccountOverview {
  games: AccountLibraryGame[];
  players: AccountPlayer[];
  // appid → which members of this slot own it, and how much each has played. Only ever more
  // than one entry for a Steam Family; a single-account slot still gets its own entry, which is
  // what makes "never played" visible on a game you own.
  owners: Map<number, GameOwner[]>;
  // When the server's cached copy of this account's owned games was written (epoch ms), or null
  // when it was fetched fresh for this very request. Surfaced as the Account card's "Updated
  // <when>" readout — see lib/cache.js's getCachedAt.
  fetchedAt: number | null;
}

// Same for a wishlist fetch: the items plus how old the server's copy of them is.
export interface AccountWishlist {
  items: AccountWishlistItem[];
  fetchedAt: number | null;
}

const refreshQuery = (refresh: boolean) => (refresh ? '?refresh=1' : '');

type AccountDataKind = 'owned' | 'wishlist' | 'friends';
interface CacheEntry {
  promise: Promise<unknown>;
  at: number;
  failed?: boolean;
  value?: unknown; // once settled, for a synchronous read
  // Landed while replaced: no reader was told, so restoring it moves the version.
  unannounced?: boolean;
}
// One fetch per kind and account, shared by every caller (Home, a list, the panel's ✓/☆).
const accountCache = new Map<string, CacheEntry>();
const versions = new Map<string, Signal<number>>();
// Bumped whenever the value a synchronous read sees changes, a first fetch landing included.
const settles = new Map<string, Signal<number>>();

const cacheKey = (kind: AccountDataKind, members: string[]) => `${kind}:${accountIdFor(members)}`;
const isFresh = (entry: CacheEntry | undefined): entry is CacheEntry =>
  entry !== undefined && isClientCacheFresh(entry.at);

function counter(map: Map<string, Signal<number>>, key: string): Signal<number> {
  let signal = map.get(key);
  if (!signal) {
    const [count, setCount] = createSignal(0);
    map.set(key, (signal = [count, setCount]));
  }
  return signal;
}

// Tracked; bumped when new data replaces a key's earlier data (a ↻, or a refetch past the max age).
export function accountDataVersion(kind: AccountDataKind, members: string[]): number {
  return counter(versions, cacheKey(kind, members))[0]();
}

function storeEntry<T>(key: string, promise: Promise<T>): Promise<T> {
  const replaced = accountCache.get(key);
  const entry: CacheEntry = { promise, at: Date.now() };
  accountCache.set(key, entry);
  const bump = (map: Map<string, Signal<number>>) => map.get(key)?.[1]((v) => v + 1);
  promise.then(
    (value) => {
      entry.value = value;
      if (accountCache.get(key) !== entry) return void (entry.unannounced = true);
      bump(settles);
      if (replaced) bump(versions);
    },
    () => {
      entry.failed = true;
      if (accountCache.get(key) !== entry) return;
      // A failed refresh keeps what it replaced unless that failed too; else the next caller asks again.
      if (!replaced || replaced.failed) return void accountCache.delete(key);
      accountCache.set(key, replaced);
      bump(settles);
      if (replaced.unannounced) {
        replaced.unannounced = false;
        bump(versions);
      }
    },
  );
  return promise;
}

// A refresh never joins an in-flight fetch: it replaces it, so later callers get the fresh data.
function cachedFetch<T>(
  kind: AccountDataKind,
  members: string[],
  refresh: boolean,
  load: () => Promise<T>,
): Promise<T> {
  const key = cacheKey(kind, members);
  const entry = accountCache.get(key);
  if (!refresh && isFresh(entry)) return entry.promise as Promise<T>;
  return storeEntry(key, load());
}

// Tests start from an empty cache.
export function clearAccountDataCache(): void {
  accountCache.clear();
}

function toAccountOverview(data: CommonGamesResponse): AccountOverview {
  const slotSteamIds = data.players.map((p) => p.steamid);
  const games = data.games.map((game) => {
    const pt = data.playtime?.[game.appid] ?? {};
    const lp = data.lastPlayed?.[game.appid] ?? {};
    return {
      appid: game.appid,
      name: game.name,
      playtimeMinutes: slotSteamIds.reduce((sum, id) => sum + (pt[id] || 0), 0),
      lastPlayedUnix: Math.max(0, ...slotSteamIds.map((id) => lp[id] || 0)),
    };
  });
  const nameById = new Map(data.players.map((p) => [p.steamid, p.personaname || p.steamid]));
  const owners = new Map<number, GameOwner[]>();
  for (const game of data.games) {
    const pt = data.playtime?.[game.appid] ?? {};
    const lp = data.lastPlayed?.[game.appid] ?? {};
    const recent = data.recentPlaytime?.[game.appid] ?? {};
    // Membership comes from the playtime map rather than the slot's full member list: the
    // response only carries an entry for a member who actually owns the game, which is exactly
    // the distinction this card exists to show for a Family.
    const entries = slotSteamIds
      .filter((id) => id in pt || id in lp)
      .map((id) => ({
        name: nameById.get(id) ?? id,
        minutes: pt[id] || 0,
        lastPlayedSec: lp[id] || 0,
        recentMinutes: recent[id] || 0,
      }));
    if (entries.length) owners.set(game.appid, entries);
  }
  return { games, players: data.players.map(toAccountPlayer), owners, fetchedAt: data.fetchedAt ?? null };
}

// Fetches one account's owned games (its members' libraries unioned, same Family-simulation
// /api/common-games already does server-side for a single slot) with per-game playtime/last-
// played summed/maxed across members, plus its member accounts' display data.
export function fetchAccountOverview(
  members: string[],
  { refresh = false }: { refresh?: boolean } = {},
): Promise<AccountOverview> {
  return cachedFetch('owned', members, refresh, async () =>
    toAccountOverview(
      await postJson<CommonGamesResponse>(
        `/api/common-games${refreshQuery(refresh)}`,
        { members },
        'Failed to fetch owned games',
      ),
    ),
  );
}

// Fetches one account's wishlist (its members' wishlists unioned, same as /api/wishlist does
// server-side).
export function fetchAccountWishlist(
  members: string[],
  { refresh = false }: { refresh?: boolean } = {},
): Promise<AccountWishlist> {
  return cachedFetch('wishlist', members, refresh, async () => {
    const data = await postJson<WishlistResponse>(
      `/api/wishlist${refreshQuery(refresh)}`,
      { members },
      'Failed to fetch wishlist',
    );
    return { items: data.items, fetchedAt: data.fetchedAt ?? null };
  });
}

// Both halves of what myOwnership.ts keeps per account — the owned games (with their playtime)
// behind the ✓/☆ markers, and the per-member breakdown behind the panel's "Owned by" card — from one request,
// since /api/common-games returns both in the same response. `fetchedAt` rides along for the
// third caller (listResolve.ts's createDefaultFetchers): a comparison or a dynamic list is built
// out of these sets, and its own hero has to be able to say how old they are.
export async function fetchAccountOwnedData(
  accountId: string,
  opts: { refresh?: boolean } = {},
): Promise<{
  games: Map<number, AccountLibraryGame>;
  owners: Map<number, GameOwner[]>;
  players: AccountPlayer[];
  fetchedAt: number | null;
}> {
  const { games, owners, players, fetchedAt } = await fetchAccountOverview(membersFromAccountId(accountId), opts);
  return { games: new Map(games.map((g) => [g.appid, g])), owners, players, fetchedAt };
}

export interface AccountFriend {
  steamid: string;
  name: string;
  avatarUrl: string;
  profileUrl: string;
  memberSince: string; // '' when Steam didn't return one — see AccountSlot's own field
  countryCode: string;
  realName: string;
}

// The shape of /api/friends' success response, as read below.
interface FriendsResponse {
  friends: {
    steamid: string;
    personaname?: string;
    avatar?: string | null;
    profileurl?: string;
    timecreated?: number;
    loccountrycode?: string;
    realname?: string;
  }[];
  unavailable: string[]; // member steamids whose friends list is private — excluded from `friends`, not "no friends"
  fetchedAt: number | null;
}

export interface AccountFriends {
  friends: AccountFriend[];
  unavailable: string[];
  fetchedAt: number | null;
}

// Fetches one account's friends (its members' own friends lists unioned, same convention
// fetchAccountWishlist uses). A member whose friends list is private shows up in `unavailable`
// rather than being silently indistinguishable from "no friends" — see docs/dev/integrations.md's
// Friends section.
export function fetchAccountFriends(
  members: string[],
  { refresh = false }: { refresh?: boolean } = {},
): Promise<AccountFriends> {
  return cachedFetch('friends', members, refresh, async () => {
    const data = await postJson<FriendsResponse>(
      `/api/friends${refreshQuery(refresh)}`,
      { members },
      'Failed to fetch friends',
    );
    return {
      friends: data.friends.map((f) => ({
        steamid: f.steamid,
        name: f.personaname || f.steamid,
        avatarUrl: f.avatar || '',
        profileUrl: safeHref(f.profileurl),
        memberSince: fmtLastPlayed(f.timecreated),
        countryCode: f.loccountrycode || '',
        realName: f.realname || '',
      })),
      unavailable: data.unavailable,
      fetchedAt: data.fetchedAt ?? null,
    };
  });
}

// The friends list this page load already fetched for these members, if any — never a request.
// Tracked: a fetch in flight still shows once it lands.
export function cachedAccountFriends(members: string[]): AccountFriends | undefined {
  const key = cacheKey('friends', members);
  counter(settles, key)[0]();
  const entry = accountCache.get(key);
  return isFresh(entry) ? (entry.value as AccountFriends | undefined) : undefined;
}

// Home's "pick an account" resolve step — there's no standalone "just resolve an identifier"
// endpoint (see docs/dev/architecture.md's Request flow section), so this is the one place a raw typed
// identifier (vanity name/URL/steamid) actually becomes a resolved AccountSlot, via the same
// /api/common-games call every owned-games fetch already makes. Its library seeds the cache, so
// the account card or list that follows doesn't download it again.
export async function resolveAccountSlot(rawInputs: string[]): Promise<AccountSlot> {
  const data = await postJson<CommonGamesResponse>(
    '/api/common-games',
    { members: rawInputs },
    'Failed to resolve account',
  );
  const slot = accountSlotFrom(data.players.map(toAccountPlayer), rawInputs);
  const key = cacheKey('owned', slot.members);
  if (!isFresh(accountCache.get(key))) void storeEntry(key, Promise.resolve(toAccountOverview(data)));
  return slot;
}

// The wishlist counterpart of fetchAccountOwnedData — appids plus the age of the server's copy,
// for the same reason (see there).
export async function fetchAccountWishlistData(
  accountId: string,
  opts: { refresh?: boolean } = {},
): Promise<{ appids: Set<number>; fetchedAt: number | null }> {
  const { items, fetchedAt } = await fetchAccountWishlist(membersFromAccountId(accountId), opts);
  return { appids: new Set(items.map((i) => i.appid)), fetchedAt };
}
