// The `?u=` half of "which account is the app showing" — parsing the param out of the URL,
// resolving its identifiers to a real AccountSlot, and handing that to accountsStore.ts as an
// override of the stored `currentAccount` (see that file's own `?u=` section for the "override,
// never adopt" rule itself, and docs/dev/lists-and-accounts.md for the design).
//
// Kept separate from accountsStore.ts on purpose: that file is plain AccountSlot state over
// prefs.ts with no fetching of its own, while resolving an identifier means a real
// /api/common-games round trip (accountData.ts's resolveAccountSlot — there's no standalone
// "just resolve this identifier" endpoint, see docs/dev/architecture.md's Request flow section). This module is
// the policy layer between the two, and it's the one place the param is read; every consumer
// asks accountsStore.ts's getEffectiveCurrentAccount() instead of parsing the URL itself.
//
// AppShell.tsx drives this once for the whole app (a createEffect on the router's own
// `location.search`), rather than each route doing it — the shell outlives every navigation, and
// a `?u=` link is honored identically on all of them.
import { createSignal } from 'solid-js';
import { parseAccountParam, urlWithoutAccountParam } from './urlState.ts';
import { resolveAccountSlot } from './accountData.ts';
import { setAccountOverride, setCurrentAccount } from './accountsStore.ts';
import { createStaleGuard } from './staleGuard.ts';
import type { AccountSlot } from './types.ts';

export interface AccountOverrideState {
  // 'none'      — no `?u=` in the URL; the stored currentAccount is what's showing.
  // 'resolving' — identifiers found, the resolve is in flight (nothing to show yet).
  // 'ready'     — resolved; accountsStore.ts's override is set.
  // 'error'     — the identifiers couldn't be resolved (bad vanity name, private/unknown
  //               profile, upstream failure); the override is left cleared, so the stored
  //               account shows instead and `message` explains why the link didn't take.
  state: 'none' | 'resolving' | 'ready' | 'error';
  identifiers: string[];
  message?: string;
}

const NONE: AccountOverrideState = { state: 'none', identifiers: [] };

// A factory rather than bare module-level state, same reason myOwnership.ts's
// createMyOwnershipCache() is one: this module's real content is mutable state (the last
// synced param, the in-flight resolve), and a test can't reload a TS-stripped ESM file to reset
// a module-level `let`. The app uses the
// single instance exported below; tests build their own.
export function createAccountOverrideSync() {
  // A signal: a reader shows "Resolving…" then the error even when the override itself stays null.
  const [state, setState] = createSignal<AccountOverrideState>(NONE);
  // The identifier set the current state was computed for — `syncFromUrl` is called on *every*
  // URL change (a panel `?game=` write, a lightbox step, a shared table view), so without this
  // key an unrelated param write would re-resolve the same account over and over.
  let syncedKey: string | null = null;
  const guard = createStaleGuard();

  function getState(): AccountOverrideState {
    return state();
  }

  // Drops the override and forgets the synced param, so a subsequent syncFromUrl for a URL the
  // `u=` has just been stripped from is a no-op rather than a second clear. Called when the user
  // explicitly picks an account (HomeRoute) — at which point the param is redundant and gets
  // stripped from the URL via replaceState, per docs/dev/lists-and-accounts.md.
  function clear(): void {
    guard.next(); // any in-flight resolve is now irrelevant
    syncedKey = '';
    setAccountOverride(null);
    setState(NONE);
  }

  function syncFromUrl(search: string): void {
    // Several slots is a comparison, not an account to explore — parseAccountParam returns
    // nothing for one, so a `/lists/compare` URL leaves the stored account alone (and the nav
    // chip saying whose lists you'd get by clicking Owned, which is still yours).
    const { identifiers } = parseAccountParam(search);
    const key = identifiers.join(',');
    if (key === syncedKey) return;
    syncedKey = key;
    if (identifiers.length === 0) return clear();
    const gen = guard.next();
    setAccountOverride(null); // don't leave a previous link's account showing while this resolves
    setState({ state: 'resolving', identifiers });
    resolveAccountSlot(identifiers).then(
      (account) => {
        if (guard.isStale(gen)) return;
        setAccountOverride(account);
        setState({ state: 'ready', identifiers });
      },
      (err: Error) => {
        if (guard.isStale(gen)) return;
        setAccountOverride(null);
        setState({ state: 'error', identifiers, message: err.message });
      },
    );
  }

  return { getState, syncFromUrl, clear };
}

const defaultSync = createAccountOverrideSync();
export const getAccountOverrideState = defaultSync.getState;
export const syncAccountOverrideFromUrl = defaultSync.syncFromUrl;
const clearAccountOverride = defaultSync.clear;

// An explicit account pick — a fresh resolve, a recents click, adopting what a `?u=` link showed.
// Storing it also consumes the override, param and all, rather than leaving the link overriding
// the preference just set. Through the router (replacing, not pushing), not a bare
// history.replaceState: see urlWithoutAccountParam's own comment.
export function adoptAccount(
  account: AccountSlot,
  navigate: (to: string, options: { replace: boolean }) => void,
  location: { pathname: string; search: string },
): void {
  clearAccountOverride();
  setCurrentAccount(account);
  navigate(urlWithoutAccountParam(location.pathname, location.search), { replace: true });
}

// The one-line status a route shows in place of its own content while a `?u=` link is being
// resolved or has failed — shared by HomeRoute and ListRoute so both explain a link that didn't
// take the same way, rather than each falling back to its own "no account selected" message and
// leaving the user to guess that the link was the problem.
export function accountOverrideStatusText(state: AccountOverrideState): string | null {
  if (state.state === 'resolving') return `Resolving ${state.identifiers.join(' + ')} from this link…`;
  if (state.state === 'error')
    return `Couldn't resolve ${state.identifiers.join(' + ')} from this link: ${state.message}`;
  return null;
}
