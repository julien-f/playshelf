// "Is this game owned/wishlisted by whichever account is currently loaded" — used by panel.tsx
// (the ownership badge under a game's title, which links back to /lists/owned or
// /lists/wishlist) and gameSearch.ts (a small owned/wishlisted marker on each dropdown result),
// so both show the same status regardless of which route/list opened the game (see
// docs/dev/lists-and-accounts.md — this was one of the "genuine follow-up polish" items left
// open when the redesign first went functionally complete).
//
// Keyed off `currentAccount` (accountsStore.ts), not `myAccount` — this used to be the other way
// around (a badge answering "do *I* own this" no matter which account's list was on screen), but
// that made the panel's own "In library"/"On wishlist" badge unlinkable to anything: `myAccount`
// and `currentAccount` can be two different accounts entirely (e.g. checking a friend's
// wishlist), so a badge based on `myAccount` had no single correct `/lists/owned`/
// `/lists/wishlist` destination to send a click to. `currentAccount` is exactly "whichever
// account's list is actually on screen" — the same account those two routes themselves read —
// so a status based on it always has one unambiguous place to link to, and it's shown at all
// only when it's actually true for what's currently loaded, matching the plain (no "your"/"my")
// wording those routes and this badge already use. `myAccount`/"★ star as mine" (accountsStore.ts
// /HomeRoute.tsx) is no longer read by this file — left in place unused rather than removed,
// in case it's wanted for something else later.
//
// Read via getEffectiveCurrentAccount(), so a `?u=` link being explored is what these badges
// answer for (see accountsStore.ts's own `?u=` section) — "whichever account's list is on
// screen" is exactly what that override changes — and the badges' own /lists/owned and
// /lists/wishlist links carry the param along (panel.tsx) so clicking one stays on that account.
// Returns `null` throughout when no account is loaded at all — same as the legacy page's
// own "no badge at all" behavior.
import { createSignal } from 'solid-js';
import { getEffectiveCurrentAccount } from './accountsStore.ts';
import {
  accountDataVersion,
  fetchAccountOwnedData,
  fetchAccountWishlistData,
  membersFromAccountId,
} from './accountData.ts';
import type { AccountLibraryGame, GameOwner } from './accountData.ts';
import { fmtLastPlayed, hoursFromMinutes } from './utils.ts';

// `null` for a half whose fetch failed: unknown, never "not owned".
export interface OwnershipStatus {
  inLibrary: boolean | null;
  onWishlist: boolean | null;
}

// Same shape as an Owned list row's own playtime/lastPlayed (hours; bare ISO date, '' = never).
export interface MyPlaytime {
  playtime: number;
  lastPlayed: string;
}

export interface MyOwnershipPeek {
  // `null` for "no account" or "still loading": a tracked reader re-runs once it lands.
  status(appid: number): OwnershipStatus | null;
  // Summed across a Family's members, latest play date wins (as the Owned list computes it).
  // `undefined` while loading, with no account or after a failed fetch; `null` for a game not owned.
  playtime(appid: number): MyPlaytime | null | undefined;
}

// A factory, not a bare module-level singleton — same "testable cache" shape as
// `staleGuard.ts`'s `createStaleGuard`/`streamBatcher.ts`'s `createStreamBatcher`/
// `lib/dedup.js`'s `createDedup`, for the same reason: this file's real state (the cached
// owned/wishlist appid sets, keyed by whichever `currentAccount` they were fetched for) needs a
// clean instance per test, and this repo's usual "delete require.cache between tests" pattern
// only resets a *stateless* module (one with no top-level mutable state at all, like
// accountsStore.ts/prefs.ts) — confirmed live not to reset a module-level `let` here, since
// Node's CJS-require-of-an-ESM-file caches the module namespace outside `require.cache`
// entirely. The app itself uses exactly one instance (exported as the bare functions below);
// tests create their own via `createMyOwnershipCache()` instead.
export function createMyOwnershipCache() {
  let cachedAccountId: string | null = null;
  let cachedVersions: string | null = null; // dataVersions() the sets were fetched at
  let ownedPromise: Promise<unknown> | null = null;
  let wishlistPromise: Promise<Set<number>> | null = null;
  let ownedGames: Map<number, AccountLibraryGame> | null = null;
  // appid → per-member playtime for the current account, from the very same response ownedGames
  // comes out of (see fetchAccountOwnedData) — so the panel's "Owned by" card costs no request
  // of its own. Empty map rather than null once the fetch has failed, same as ownedGames.
  let ownersMap: Map<number, GameOwner[]> = new Map();
  let wishlistSet: Set<number> | null = null;
  let ownedFailed = false;
  let wishlistFailed = false;
  // Bumped once both halves land, so a peek read in JSX, a memo or a table cell re-runs then.
  const [loaded, notifyLoaded] = createSignal(undefined, { equals: false });

  function notifyReady(): void {
    if (ownedGames && wishlistSet) notifyLoaded();
  }

  // Tracked: the account data's versions, which a ↻ anywhere moves (accountData.ts).
  function dataVersions(accountId: string): string {
    const members = membersFromAccountId(accountId);
    return `${accountDataVersion('owned', members)}:${accountDataVersion('wishlist', members)}`;
  }

  // Starts (or reuses) the two fetches for whatever `currentAccount` currently is. Returns false
  // with no fetch at all when nothing is loaded — the "no badge" case throughout this module.
  function ensureLoading(): boolean {
    const account = getEffectiveCurrentAccount();
    if (!account) {
      cachedAccountId = cachedVersions = null;
      ownedPromise = wishlistPromise = null;
      ownedGames = wishlistSet = null;
      return false;
    }
    const versions = dataVersions(account.id);
    if (account.id === cachedAccountId && versions === cachedVersions) return true;
    // A refreshed account keeps its sets until the new ones land, so its markers don't blink.
    if (account.id !== cachedAccountId) {
      ownedGames = null;
      wishlistSet = null;
      ownedFailed = wishlistFailed = false;
      ownersMap = new Map();
    }
    cachedAccountId = account.id;
    cachedVersions = versions;
    // Each response writes only while it's still the current fetch: a slower one for an account
    // switched away from must not overwrite the new account's sets.
    const owned: Promise<void> = fetchAccountOwnedData(account.id)
      .then(
        (data) => ({ ...data, failed: false }),
        () => ({ games: new Map<number, AccountLibraryGame>(), owners: new Map<number, GameOwner[]>(), failed: true }),
      )
      .then(({ games, owners, failed }) => {
        if (ownedPromise !== owned) return;
        ownedGames = games;
        ownedFailed = failed;
        ownersMap = owners;
        notifyReady();
      });
    const wishlist: Promise<Set<number>> = fetchAccountWishlistData(account.id)
      .then(
        ({ appids: s }) => ({ s, failed: false }),
        () => ({ s: new Set<number>(), failed: true }),
      )
      .then(({ s, failed }) => {
        if (wishlistPromise !== wishlist) return s;
        wishlistSet = s;
        wishlistFailed = failed;
        notifyReady();
        return s;
      });
    ownedPromise = owned;
    wishlistPromise = wishlist;
    return true;
  }

  // Async — waits for both sets to resolve (a fresh session's first check). `null` = no
  // `currentAccount` loaded; otherwise always resolves, even if one/both fetches failed
  // (that half unknown rather than blocking the whole status on e.g. a private wishlist).
  async function getMyOwnershipStatus(appid: number): Promise<OwnershipStatus | null> {
    if (!ensureLoading()) return null;
    await Promise.all([ownedPromise!, wishlistPromise!]);
    return statusOf(appid);
  }

  function statusOf(appid: number): OwnershipStatus {
    return {
      inLibrary: ownedFailed ? null : ownedGames!.has(appid),
      onWishlist: wishlistFailed ? null : wishlistSet!.has(appid),
    };
  }

  // Sync and tracked; a lookup starts loading. One peek per list of rows: reading the account parses the whole prefs blob.
  // Meant for one run; subscribes at creation, so a tracked scope with no lookups still follows the account.
  function peekMyOwnership(): MyOwnershipPeek {
    trackMyOwnership();
    // On the first lookup, so an empty list or search starts no fetch.
    let ready: boolean | undefined;
    const isReady = (): boolean => (ready ??= ensureLoading());
    return {
      status: (appid) => (isReady() && ownedGames && wishlistSet ? statusOf(appid) : null),
      playtime: (appid) => {
        const games = isReady() && !ownedFailed ? ownedGames : null;
        if (!games) return undefined;
        const game = games.get(appid);
        if (!game) return null;
        return { playtime: hoursFromMinutes(game.playtimeMinutes), lastPlayed: fmtLastPlayed(game.lastPlayedUnix) };
      },
    };
  }

  // One row's status, for a reader rendering a single cell.
  function peekMyOwnershipStatus(appid: number): OwnershipStatus | null {
    return peekMyOwnership().status(appid);
  }

  // Who — among the current account's members — owns this game, and how much each has played it.
  // Same account source and same fetch as the ✓/☆ markers above, so the panel's "Owned by" card
  // stays consistent with its ownership badges by construction. `[]` for a game nobody in the
  // account owns, or with no account loaded at all (the card renders nothing either way).
  async function getOwnersFor(appid: number): Promise<GameOwner[]> {
    if (!ensureLoading()) return [];
    await ownedPromise!;
    return ownersMap.get(appid) ?? [];
  }

  // Subscribes an imperative consumer's effect to what the peeks depend on, before it has anything to peek.
  function trackMyOwnership(): void {
    loaded();
    const account = getEffectiveCurrentAccount();
    if (account) dataVersions(account.id);
  }

  return { getMyOwnershipStatus, peekMyOwnership, peekMyOwnershipStatus, getOwnersFor, trackMyOwnership };
}

const defaultCache = createMyOwnershipCache();
export const getMyOwnershipStatus = defaultCache.getMyOwnershipStatus;
export const peekMyOwnership = defaultCache.peekMyOwnership;
export const peekMyOwnershipStatus = defaultCache.peekMyOwnershipStatus;
export const getOwnersFor = defaultCache.getOwnersFor;
export const trackMyOwnership = defaultCache.trackMyOwnership;
