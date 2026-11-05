// Steam sign-in status, as a signal so anything reading getAuthUser() reactively follows it. Backed by lib/auth.js's cookie-session endpoints
// (GET /api/me, POST /auth/logout); "signing in" itself is a plain page navigation to
// /auth/steam/login (AccountChip.tsx), not something this module drives.
import { createSignal } from 'solid-js';
import {
  getAllPrefEntries,
  adoptPrefEntry,
  pushPrefToServer,
  setSignedInSteamid,
  setOnSessionLost,
  type PrefEntry,
} from './prefs.ts';
import { isSyncedPrefKey } from './syncedPrefKeys.ts';
import { getMyAccount, setMyAccount, getCurrentAccount, setCurrentAccount } from './accountsStore.ts';
import { resolveAccountSlot } from './accountData.ts';

export interface AuthUser {
  steamid: string;
}

const [currentUser, setCurrentUser] = createSignal<AuthUser | null>(null);

export function getAuthUser(): AuthUser | null {
  return currentUser();
}

// Bumped when a push finds the session gone, so a sign-in check still merging knows not to sign in after it.
let sessionEpoch = 0;
function handleSessionLost(): void {
  sessionEpoch++;
  setCurrentUser(null);
}

// Whether this browser has ever completed a prefs sync with this steamid before — gates the one
// asymmetry in the merge below. Deliberately its own localStorage key, outside prefs.ts's synced
// blob: it must never itself be synced (or adopted from the server), or a fresh browser adopting
// another device's prefs would inherit "already trusted" and skip its own first-sync guard.
const SYNCED_FLAG_PREFIX = 'steam.isonoe.net:prefs-synced:';

function hasSyncedBefore(steamid: string): boolean {
  try {
    return localStorage.getItem(SYNCED_FLAG_PREFIX + steamid) === '1';
  } catch {
    return true;
  }
}

function markSyncedBefore(steamid: string): void {
  try {
    localStorage.setItem(SYNCED_FLAG_PREFIX + steamid, '1');
  } catch {
    /* unavailable storage */
  }
}

// Merges this device's local prefs against the account's server-side ones. Run on every sign-in
// check, not just the first, so two devices signed into the same account converge instead of
// drifting apart after their one and only sync.
//
// A device's *first ever* sync with a given account is treated differently from every sync after it:
//
//   - First sync: local never overrides a key the server already has, no matter its timestamp —
//     only server → local for anything both sides have, since a brand-new device's local
//     `updatedAt` might just be leftover anonymous-browsing clutter with a coincidentally recent
//     timestamp, not a considered edit competing with whatever's already configured on the
//     account. A key the server has never seen at all still pushes up — that's contributing new
//     data, not overriding existing configuration, so nothing is lost.
//   - Every sync after that: plain last-write-wins, per key, both ways — by then this device has
//     proven itself a real sync participant, so its timestamps are trustworthy signals of actual
//     edits (including retrying a push that failed on a previous attempt).
//
// Equal timestamps are left alone — indistinguishable from "already in sync".
//
// Returns whether anything was adopted from the server and every adoption was kept — the caller
// reloads in that case (a partial one would reload into another first sync, forever), since
// every store (accountsStore, listsStore, ...) seeds its in-memory state from localStorage once
// at load; live-patching each of them to notice an external write isn't worth it for something
// that, once merged, won't differ again until the next real edit on either side.
//
// Exported for unit testing (see test/authStore.test.js) — same reasoning as
// autoPopulateAccountFromLogin's own comment below.
export async function syncPrefsWithServer(steamid: string, serverEntries: Record<string, PrefEntry>): Promise<boolean> {
  const firstSync = !hasSyncedBefore(steamid);
  const localEntries = getAllPrefEntries();

  const keys = new Set([...Object.keys(localEntries), ...Object.keys(serverEntries)].filter(isSyncedPrefKey));
  let adopted = false;
  let unkept = false;
  const pushes: Promise<void>[] = [];

  for (const key of keys) {
    const local = localEntries[key];
    const server = serverEntries[key];
    if (server && (!local || firstSync || server.updatedAt > local.updatedAt)) {
      // The same value under a newer time (a push from another device): nothing on screen changes, so no reload.
      const sameValue = !!local && JSON.stringify(local.value) === JSON.stringify(server.value);
      // Counted only once persisted: a reload re-reads storage, so an unkept adoption would reload forever.
      if (adoptPrefEntry(key, server.value, server.updatedAt)) adopted ||= !sameValue;
      else {
        unkept = true;
        console.warn(
          `[auth] couldn't store the account's "${key}" pref locally; this device won't use the account's value`,
        );
      }
    } else if (local && (!server || local.updatedAt > server.updatedAt)) {
      pushes.push(pushPrefToServer(key, local.value, local.updatedAt));
    }
  }

  await Promise.all(pushes);
  // Still unsynced while a server value isn't kept, or a later sync would let the stale local one win.
  if (!unkept) markSyncedBefore(steamid);
  return adopted && !unkept;
}

// A verified Steam login already IS a resolved identity — nobody should have to retype their own
// steamid into Home's picker right after signing in with it. Only fills in whichever of
// myAccount/currentAccount is still unset, same "never overwrites the stored preference"
// philosophy as the `?u=` override (see accountsStore.ts's own comment on that) — an existing
// pick, from an earlier manual resolve or a prefs merge above, is left alone. Runs on every
// sign-in check but is a no-op once both are set, so a failed resolve (e.g. a transient network
// error) just retries on the next page load rather than needing its own one-time flag.
// Exported for unit testing (see test/authStore.test.js) — same reasoning as lib/hltb.js's own
// exported stringSimilarity/levenshtein: worth exercising directly rather than only through
// initAuth's full fetch('/api/me') + merge + this call chain.
export async function autoPopulateAccountFromLogin(steamid: string): Promise<void> {
  if (getMyAccount() && getCurrentAccount()) return;
  try {
    const account = await resolveAccountSlot([steamid]);
    if (!getMyAccount()) setMyAccount(account);
    if (!getCurrentAccount()) setCurrentAccount(account);
  } catch (err) {
    console.error('[auth] failed to resolve your account after Steam sign-in', err);
  }
}

// Fire-and-forget from AppShell's onMount — checks whether a session cookie is already signed
// in (e.g. returning from /auth/steam/callback, or just a normal page load while signed in) and
// merges prefs with the server every time, not just the first.
export async function initAuth(): Promise<void> {
  setOnSessionLost(handleSessionLost);
  try {
    const res = await fetch('/api/me');
    const { steamid, prefs } = (await res.json()) as {
      steamid: string | null;
      prefs: Record<string, PrefEntry> | null;
    };
    if (!steamid) {
      setCurrentUser(null);
      setSignedInSteamid(null);
      return;
    }
    // Set only after the merge: an adoption reloads, and pending pushes would flush under the old state.
    const epoch = sessionEpoch;
    const adopted = await syncPrefsWithServer(steamid, prefs ?? {});
    if (epoch !== sessionEpoch) return;
    setCurrentUser({ steamid });
    setSignedInSteamid(steamid);
    if (adopted) {
      location.reload();
      return;
    }
    await autoPopulateAccountFromLogin(steamid);
  } catch (err) {
    console.error('[auth] failed to check sign-in status', err);
    setCurrentUser(null);
  }
}

export async function signOut(): Promise<void> {
  // Pending pushes go first, while the session still accepts them.
  await setSignedInSteamid(null);
  try {
    await fetch('/auth/logout', { method: 'POST' });
  } catch (err) {
    console.error('[auth] sign-out request failed', err);
  }
  setCurrentUser(null);
}
