// AccountSlot CRUD — myAccount/currentAccount/recentAccounts (see docs/dev/lists-and-accounts.md).
// Backed by prefs.ts's 'myAccount'/'currentAccount'/'recentAccounts' keys, same one-blob
// convention every other preference here uses. myAccount/currentAccount are stored as full
// AccountSlot objects, not id references into recentAccounts, so clearing/removing recents can
// never orphan either of them.
//
// Soft-remove for recentAccounts mirrors listsStore.ts's soft-delete for GameList exactly (same
// "still referenced by a dynamic list → hide, don't destroy" rule) — isAccountReferenced() is
// listsStore.ts's own source-scanning logic, reused rather than duplicated here.
import { batch, createSignal, untrack } from 'solid-js';
import { getPref, setPref } from './prefs.ts';
import { isAccountReferenced } from './listsStore.ts';
import type { AccountSlot } from './types.ts';

const MY_ACCOUNT_KEY = 'myAccount';
const CURRENT_ACCOUNT_KEY = 'currentAccount';
const RECENT_ACCOUNTS_KEY = 'recentAccounts';

// The canonical AccountSlot.id for a set of resolved member steam64 ids — sorted so the same
// Family always produces the same id regardless of the order its accounts were entered in.
export function accountIdFor(members: string[]): string {
  return [...members].sort().join('+');
}

// How an account names itself on screen: its last-known Steam persona/Family label, falling back
// to whatever the user actually typed, and finally to the resolved member ids (a `?u=` link's
// account can carry no label at all until its resolve lands). One helper rather than the
// `label || rawInputs.join(' + ')` expression hand-repeated per surface — the nav bar's account
// chip, Home's recents list and a dynamic list's formula all have to name the same account the
// same way.
export function accountDisplayLabel(account: AccountSlot): string {
  return account.label || account.rawInputs.join(' + ') || account.members.join(' + ');
}

// The nicest identifier each member of a slot copies as: its Steam custom-URL name when the
// account set one, its steam64 id otherwise. Both forms resolve back to the same account — in
// this app's own account field (utils.ts's normalizeInput) and in a steamcommunity.com URL — but
// the custom name is the one a person can read out or recognize. Per member rather than one
// string for the slot: a Family's joined label is nothing any input accepts back.
// `vanities` is absent on accounts resolved before it was stored, which simply fall back to ids.
export function accountIdentifiers(account: AccountSlot): { steamid: string; identifier: string }[] {
  return account.members.map((steamid) => ({ steamid, identifier: account.vanities?.[steamid] || steamid }));
}

function readRecents(): AccountSlot[] {
  return getPref<AccountSlot[]>(RECENT_ACCOUNTS_KEY, []);
}
function writeRecents(list: AccountSlot[]): void {
  setPref(RECENT_ACCOUNTS_KEY, list);
}

// ── myAccount / currentAccount ───────────────────────────────────────────────────────────────

export function getMyAccount(): AccountSlot | null {
  return getPref<AccountSlot | null>(MY_ACCOUNT_KEY, null);
}

// Setting myAccount also upserts it into recentAccounts — starring an account is itself a use
// of it, and it should show up there the same as any other resolve/pick would.
export function setMyAccount(picked: AccountSlot | null): void {
  const account = picked && withStoredDisplay(picked);
  // One update for getRecentAccounts' readers, which sort on myAccount too.
  batch(() => {
    setPref(MY_ACCOUNT_KEY, account);
    if (account) upsertRecentAccount(account);
  });
}

export function getCurrentAccount(): AccountSlot | null {
  return getPref<AccountSlot | null>(CURRENT_ACCOUNT_KEY, null);
}

export function setCurrentAccount(picked: AccountSlot | null): void {
  const account = picked && withStoredDisplay(picked);
  setPref(CURRENT_ACCOUNT_KEY, account);
  if (account) upsertRecentAccount(account);
}

// An unresolved member's display fields are unknown, not cleared, so a re-pick keeps the stored ones.
function withStoredDisplay({ unresolved, ...account }: AccountSlot): AccountSlot {
  const stored =
    unresolved && [getMyAccount(), getCurrentAccount(), ...readRecents()].find((a) => a?.id === account.id);
  if (!stored) return account;
  const { label, avatarUrl } = stored;
  const kept = (byMember: Record<string, string> = {}) =>
    Object.fromEntries(Object.entries(byMember).filter(([id]) => unresolved.includes(id)));
  const vanities = { ...account.vanities, ...kept(stored.vanities) };
  const memberAvatars = { ...account.memberAvatars, ...kept(stored.memberAvatars) };
  return { ...account, label, avatarUrl, vanities, ...(Object.keys(memberAvatars).length && { memberAvatars }) };
}

// ── The `?u=` override ───────────────────────────────────────────────────────────────────────

// `?u=` is a URL *override*, not a "consume and adopt" param (unlike the `?tv=` table-view one):
// present in the URL, it takes precedence over the stored `currentAccount` everywhere the
// current account is read, but it never overwrites the stored preference — opening someone
// else's shared link shouldn't silently change your own default account. See
// docs/dev/lists-and-accounts.md's own `?u=` section, and accountOverride.ts for the URL-parsing/
// resolving half of this (kept out of here so this file stays plain AccountSlot state with no
// fetching of its own).
//
// Deliberately in-memory only, never through prefs.ts: it's per-load display state belonging to
// one shared link, and persisting it would be exactly the silent adoption the override exists to
// avoid. It's also deliberately kept out of `recentAccounts` for the same reason — browsing
// someone's library from a link isn't the same act as picking an account for yourself.
const [accountOverride, setOverride] = createSignal<AccountSlot | null>(null);

export function getAccountOverride(): AccountSlot | null {
  return accountOverride();
}

export function setAccountOverride(account: AccountSlot | null): void {
  if (untrack(accountOverride)?.id === account?.id) return; // keep the object a reader already has
  setOverride(account);
}

// "Whichever account the app is currently showing" — the override when a `?u=` link is being
// explored, the stored preference otherwise. Every read of the current account outside
// HomeRoute's own account *picker* goes through this rather than getCurrentAccount(), so a
// shared link is honored on every route (the Owned/Wishlist lists, the panel's ownership badges,
// Home's own account header) rather than only wherever the param happened to be parsed.
export function getEffectiveCurrentAccount(): AccountSlot | null {
  return accountOverride() ?? getCurrentAccount();
}

// Whether the account on screen is the person using this browser: their ★ account (or a Family
// with them in it), or, with none starred, the stored current account but not a `?u=` link's.
export function showingMyAccount(): boolean {
  const mine = getMyAccount();
  const shown = getEffectiveCurrentAccount();
  if (!mine) return !getAccountOverride() && !!shown;
  return !!shown?.members.some((id) => mine.members.includes(id));
}

// ── recentAccounts ───────────────────────────────────────────────────────────────────────────

const byName = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

// Mine first, then by name: each account keeps its place (the id tiebreak: on every device too).
// Soft-removed entries only with includeRemoved.
export function getRecentAccounts({ includeRemoved = false }: { includeRemoved?: boolean } = {}): AccountSlot[] {
  const list = readRecents();
  const filtered = includeRemoved ? list : list.filter((a) => !a.removedAt);
  const myId = getMyAccount()?.id;
  return [...filtered].sort(
    (a, b) =>
      Number(b.id === myId) - Number(a.id === myId) ||
      byName.compare(accountDisplayLabel(a), accountDisplayLabel(b)) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

// Adds or updates the entry for this AccountSlot.id (clearing any soft-remove), so re-picking the
// same Family updates one entry rather than piling up duplicates.
function upsertRecentAccount(account: AccountSlot): void {
  const recents = readRecents();
  const idx = recents.findIndex((a) => a.id === account.id);
  const entry: AccountSlot = { ...account, removedAt: undefined };
  if (idx === -1) recents.push(entry);
  else recents[idx] = entry;
  writeRecents(recents);
}

// An account's display fields (label, avatars, custom-URL names) are captured when it's picked
// and nothing else updates them — so one picked before a field existed, or renamed on Steam
// since, kept its old face in the chip, recents and list labels. This refreshes them wherever
// the account is stored, from a fetch that returned newer ones; nothing is written when nothing
// changed.
export function refreshAccountInfo(
  accountId: string,
  info: {
    label?: string;
    avatarUrl?: string;
    vanities?: Record<string, string>;
    memberAvatars?: Record<string, string>;
  },
): boolean {
  const fresh = Object.fromEntries(Object.entries(info).filter(([, v]) => v !== undefined && v !== ''));
  const differs = (a: AccountSlot) =>
    Object.entries(fresh).some(([k, v]) => JSON.stringify(a[k as keyof AccountSlot]) !== JSON.stringify(v));
  let changed = false;
  for (const key of [MY_ACCOUNT_KEY, CURRENT_ACCOUNT_KEY]) {
    const slot = getPref<AccountSlot | null>(key, null);
    if (slot?.id === accountId && differs(slot)) {
      setPref(key, { ...slot, ...fresh });
      changed = true;
    }
  }
  const recents = readRecents();
  if (recents.some((a) => a.id === accountId && differs(a))) {
    writeRecents(recents.map((a) => (a.id === accountId ? { ...a, ...fresh } : a)));
    changed = true;
  }
  return changed;
}

// Stores an account a saved list names but nobody picked (a compared player, a `?u=` link's), hidden
// like a soft-removed one, so the list reads its name. False when it's already stored or has no name.
export function keepAccountForLists({ unresolved: _unresolved, ...account }: AccountSlot): boolean {
  const recents = readRecents();
  if (!account.label || recents.some((a) => a.id === account.id)) return false;
  writeRecents([...recents, { ...account, removedAt: Date.now() }]);
  return true;
}

// Soft-removes when a dynamic list still references this account, hard-removes otherwise —
// same shape as listsStore.ts's deleteList. Never touches myAccount/currentAccount even if
// they happen to hold the same id, since those are stored independently.
export function removeRecentAccount(id: string): { softRemoved: boolean } {
  return removeRecent(id);
}

function removeRecent(id: string): { softRemoved: boolean } {
  const recents = readRecents();
  const idx = recents.findIndex((a) => a.id === id);
  if (idx === -1) return { softRemoved: false };
  if (isAccountReferenced(id)) {
    recents[idx] = { ...recents[idx], removedAt: Date.now() };
    writeRecents(recents);
    return { softRemoved: true };
  }
  recents.splice(idx, 1);
  writeRecents(recents);
  return { softRemoved: false };
}

// "Clear all" — removes every current entry via the same soft-remove-if-referenced rule as a
// single removeRecentAccount call, just applied across the whole list.
export function clearRecentAccounts(): void {
  batch(() =>
    readRecents().forEach((a) => {
      if (!a.removedAt) removeRecent(a.id);
    }),
  );
}

// Permanently purges any soft-removed account no longer referenced by anything — listsStore.ts's
// sweepDeletedLists() calls it after every change that could have removed the last reference.
export function sweepRemovedAccounts(): void {
  const recents = readRecents();
  const kept = recents.filter((a) => !a.removedAt || isAccountReferenced(a.id));
  if (kept.length !== recents.length) writeRecents(kept);
}
