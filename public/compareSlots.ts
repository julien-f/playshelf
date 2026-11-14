// The slot model behind ComparePlayersForm.tsx — what a player slot holds, how it converts to the
// plain identifiers the route submits, and how a set of identifiers converts back into named
// chips. Split out of the component: this is the part with rules worth testing, and it needs
// neither a DOM nor a store.
import { normalizeInput } from './utils.ts';

// One of the app's known accounts, as the form needs it. `identifiers` is parallel to `members`
// (accountsStore.ts's accountIdentifiers): the member's Steam custom-URL name when it set one,
// its steam64 id otherwise.
export interface KnownAccount {
  id: string;
  label: string;
  avatarUrl?: string;
  starred: boolean;
  friend?: boolean; // a friend of the current account, not a stored account
  members: string[];
  identifiers: string[];
}

// A slot holds entries, not strings. An account the app knows is kept whole — a Family is *one*
// entry, not one per member — so it can render as a chip saying who it is. Identifiers alone are
// no good to show: an account with no Steam custom-URL name is a 17-digit number on screen, which
// is what this model exists to stop.
export type SlotEntry = { kind: 'account'; account: KnownAccount } | { kind: 'typed'; value: string };

export type Slot = SlotEntry[];

export function entryIdentifiers(entry: SlotEntry): string[] {
  return entry.kind === 'account' ? entry.account.identifiers : [entry.value];
}

export function entryLabel(entry: SlotEntry): string {
  return entry.kind === 'account' ? entry.account.label : entry.value;
}

// What the route is handed: one slot's worth of plain identifiers, blanks dropped.
export function slotIdentifiers(slot: Slot): string[] {
  return slot
    .flatMap(entryIdentifiers)
    .map((v) => v.trim())
    .filter(Boolean);
}

export function slotsToIdentifiers(slots: Slot[]): string[][] {
  return slots.map(slotIdentifiers).filter((slot) => slot.length > 0);
}

function token(value: string): string {
  // normalizeInput so a pasted profile URL counts as the name or id it contains — the same
  // account typed two ways shouldn't read as two different players.
  return normalizeInput(value.trim()).toLowerCase();
}

function accountTokens(account: KnownAccount): Set<string> {
  return new Set([...account.members, ...account.identifiers].map((v) => v.toLowerCase()));
}

// Whether every member of `account` is named in `identifiers`, in either spelling. Every member,
// not any: half a Family is a different player from the whole Family.
export function namesAccount(identifiers: string[], account: KnownAccount): boolean {
  const typed = new Set(identifiers.map(token).filter(Boolean));
  if (typed.size === 0) return false;
  return account.members.every(
    (member, i) => typed.has(member.toLowerCase()) || typed.has((account.identifiers[i] ?? '').toLowerCase()),
  );
}

export function slotHasAccount(slot: Slot, account: KnownAccount): boolean {
  return namesAccount(slot.flatMap(entryIdentifiers), account);
}

export function slotsHaveAccount(slots: Slot[], account: KnownAccount): boolean {
  return slots.some((slot) => slotHasAccount(slot, account));
}

// Rebuilds slots of raw identifiers (what a `?u=` URL carries) into named entries, so reopening
// the form on an existing comparison shows "Dana", not the steam64 id the URL spells it as.
//
// A multi-member account only matches a slot it accounts for *entirely* — otherwise a Family
// would swallow a slot that merely mentions one of its members. Everything else is matched one
// identifier at a time against the single-member accounts, so a slot someone built by picking two
// people comes back as those same two chips.
export function slotsFromIdentifiers(slots: string[][], known: KnownAccount[]): Slot[] {
  const families = known.filter((a) => a.members.length > 1);
  const singles = known.filter((a) => a.members.length === 1);
  return slots.map((identifiers) => {
    const typed = new Set(identifiers.map(token).filter(Boolean));
    const whole = families.find((account) => {
      const wanted = accountTokens(account);
      return namesAccount(identifiers, account) && [...typed].every((t) => wanted.has(t));
    });
    if (whole) return [{ kind: 'account' as const, account: whole }];
    return identifiers.map((value): SlotEntry => {
      const match = singles.find((account) => namesAccount([value], account));
      return match ? { kind: 'account', account: match } : { kind: 'typed', value };
    });
  });
}

// The dropdown's own list: accounts matching `query`, minus any already placed anywhere in the
// form. Filtered out rather than shown disabled — unlike a static chip row, a dropdown is opened
// fresh each time, so there's no cursor to keep stable, and a disabled row in a listbox is just
// something for the arrow keys to trip over.
export function filterAccounts(known: KnownAccount[], slots: Slot[], query: string): KnownAccount[] {
  const q = query.trim().toLowerCase();
  const found = known.filter((account) => {
    if (slotsHaveAccount(slots, account)) return false;
    if (!q) return true;
    return account.label.toLowerCase().includes(q) || [...accountTokens(account)].some((t) => t.includes(q));
  });
  // Enter picks the first row; a Family is never exact for one member's name (namesAccount needs all).
  const exact = (account: KnownAccount): boolean => account.label.toLowerCase() === q || namesAccount([q], account);
  return q ? [...found.filter(exact), ...found.filter((a) => !exact(a))] : found;
}
