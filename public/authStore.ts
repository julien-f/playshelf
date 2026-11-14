// Steam sign-in status, as a signal so anything reading getAuthUser() reactively follows it. Backed by lib/auth.js's cookie-session endpoints
// (GET /api/me, POST /auth/logout); "signing in" itself is a plain page navigation to
// /auth/steam/login (AccountChip.tsx), not something this module drives.
import { batch, createSignal } from 'solid-js';
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
import { announce } from './announce.ts';

export interface AuthUser {
  steamid: string;
}

const [currentUser, setCurrentUser] = createSignal<AuthUser | null>(null);

export function getAuthUser(): AuthUser | null {
  return currentUser();
}

// The steamid last signed in on this browser, until Sign out or Stay signed out: what tells an expired
// session from never having signed in. Never synced, like SYNCED_FLAG_PREFIX below.
const SIGNED_IN_AS_KEY = 'steam.isonoe.net:signed-in-as';

function readSignedInAs(): string | null {
  try {
    return localStorage.getItem(SIGNED_IN_AS_KEY);
  } catch {
    return null;
  }
}

function writeSignedInAs(steamid: string | null): void {
  try {
    if (steamid) localStorage.setItem(SIGNED_IN_AS_KEY, steamid);
    else localStorage.removeItem(SIGNED_IN_AS_KEY);
  } catch {
    /* unavailable storage */
  }
}

const [sessionExpired, setSessionExpired] = createSignal(false);

// Signed in on this browser before, signed out now without asking to: the account chip says so.
export function isSessionExpired(): boolean {
  return sessionExpired();
}

// "Stay signed out": forgets the expired sign-in, as an explicit Sign out would.
export function dismissSessionExpired(): void {
  writeSignedInAs(null);
  setSessionExpired(false);
}

// Bumped when a push finds the session gone, so a sign-in check still merging knows not to sign in after it.
let sessionEpoch = 0;
function handleSessionLost(): void {
  sessionEpoch++;
  setCurrentUser(null);
  if (readSignedInAs() && !sessionExpired()) {
    setSessionExpired(true);
    announce(`${SESSION_EXPIRED_TITLE}. ${SESSION_EXPIRED_DETAIL}`);
  }
}

export const SESSION_EXPIRED_TITLE = 'Your Steam sign-in expired';
export const SESSION_EXPIRED_DETAIL = 'Changes made on this device since then will sync when you sign in again.';

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
// reloads in that case (a partial one would reload into another first sync, forever): getPref's
// readers follow an adoption, but those that copy a pref at load don't (U274).
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

  // Batched: readers rerun once the merge has written every key, not on a half-merged state.
  batch(() => {
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
  });

  await Promise.all(pushes);
  // Still unsynced while a server value isn't kept, or a later sync would let the stale local one win.
  if (!unkept) markSyncedBefore(steamid);
  return adopted && !unkept;
}

// A verified login is a resolved identity: fills only an unset myAccount/currentAccount, so a failed resolve
// retries on the next load. Exported for test/authStore.test.js.
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
      setSessionExpired(readSignedInAs() !== null);
      return;
    }
    // Set only after the merge: an adoption reloads, and pending pushes would flush under the old state.
    const epoch = sessionEpoch;
    const adopted = await syncPrefsWithServer(steamid, prefs ?? {});
    if (epoch !== sessionEpoch) return;
    setCurrentUser({ steamid });
    setSignedInSteamid(steamid);
    writeSignedInAs(steamid);
    setSessionExpired(false);
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
  dismissSessionExpired();
  // Pending pushes go first, while the session still accepts them.
  await setSignedInSteamid(null);
  try {
    await fetch('/auth/logout', { method: 'POST' });
  } catch (err) {
    console.error('[auth] sign-out request failed', err);
  }
  setCurrentUser(null);
}
