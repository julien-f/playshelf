// The "who is being compared" form for /lists/compare (ListRoute.tsx's 'compare' kind) — one row
// per player slot, each slot a token input: chips for who's in it, plus a combobox that offers the
// accounts the app already knows and accepts a raw identifier for anyone it doesn't. Ported in
// shape from the pre-redesign Comparison page's own player inputs, which is the whole point:
// entering N players in one go is what made comparing easy there, and building a comparison out
// of saved account/list picks on Home never got close.
//
// It lives on the compare route rather than on Home so there's exactly one implementation of it,
// and so a bare /lists/compare is a usable destination on its own (its empty state *is* this
// form) instead of a URL you can only arrive at from somewhere else.
//
// **Why a per-slot picker rather than one row of chips under the form** (which is what this was
// first): a chip row can only ever add a player, so a Steam Family assembled out of two accounts
// the app knows was unbuildable — the one shape the slot model exists for. Picking into a
// specific slot makes that two clicks. It also lets a picked account stay an *account* rather than
// collapsing to text, which matters because `accountIdentifiers` falls back to the steam64 id for
// anyone without a Steam custom-URL name: those slots read as 17-digit numbers otherwise, on
// arrival from a `?u=` link just as much as on picking (see slotsFromIdentifiers).
//
// It owns the draft slots being typed and nothing else — no resolving, no navigation, no URL; the
// route decides what a submitted set of slots means. It reads accountsStore.ts, and the current
// account's friends only if this page load already fetched them (accountData.ts's cache).
import {
  createSignal,
  createEffect,
  createMemo,
  createResource,
  on,
  createUniqueId,
  untrack,
  For,
  Index,
  Show,
  type JSX,
} from 'solid-js';
import Plus from 'lucide-solid/icons/plus';
import Star from 'lucide-solid/icons/star';
import X from 'lucide-solid/icons/x';
import {
  getRecentAccounts,
  getMyAccount,
  getAccountOverride,
  getEffectiveCurrentAccount,
  accountDisplayLabel,
  accountIdentifiers,
} from './accountsStore.ts';
import {
  slotsFromIdentifiers,
  slotsToIdentifiers,
  slotIdentifiers,
  filterAccounts,
  entryLabel,
  type KnownAccount,
  type Slot,
  type SlotEntry,
} from './compareSlots.ts';
import { cachedAccountFriends, membersFromAccountId, type AccountFriend } from './accountData.ts';
import type { AccountSlot } from './types.ts';

interface ComparePlayersFormProps {
  initialSlots: string[][];
  submitLabel: string;
  onSubmit: (slots: string[][]) => void;
  onCancel?: () => void;
  // Typed identifiers the last comparison couldn't resolve — their chips are marked.
  invalid?: string[];
}

// Every account the app knows, in getRecentAccounts' order. `recentAccounts` already covers the
// starred and current ones (both setMyAccount and setCurrentAccount upsert into it), so the only
// one that needs adding is a `?u=` link's — deliberately never stored, but obviously worth
// offering while it's the account on screen. Picking one never writes anything back: comparing
// someone isn't picking them as your account, the same rule the route itself follows.
function knownAccounts(): KnownAccount[] {
  const myId = getMyAccount()?.id;
  const recents = getRecentAccounts();
  const override = getAccountOverride();
  const all = override && !recents.some((a) => a.id === override.id) ? [override, ...recents] : recents;
  return all.map((account: AccountSlot) => ({
    id: account.id,
    label: accountDisplayLabel(account),
    avatarUrl: account.avatarUrl,
    starred: account.id === myId,
    members: account.members,
    identifiers: accountIdentifiers(account).map((m) => m.identifier),
  }));
}

// The current account's friends, as Home sorts them, minus anyone already known (its own members too).
function friendAccounts(friends: AccountFriend[], known: KnownAccount[], ownMembers: string[]): KnownAccount[] {
  const taken = new Set([...ownMembers, ...known.filter((a) => a.members.length === 1).map((a) => a.members[0])]);
  return friends
    .filter((f) => !taken.has(f.steamid))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .map((f) => ({
      id: f.steamid,
      label: f.name,
      avatarUrl: f.avatarUrl || undefined,
      starred: false,
      friend: true,
      members: [f.steamid],
      identifiers: [f.steamid],
    }));
}

// Two empty players is the starting shape — a comparison needs at least two, and opening with a
// single field makes it look like the account picker it isn't.
function seedSlots(initial: string[][], known: KnownAccount[]): Slot[] {
  const seeded = slotsFromIdentifiers(initial, known);
  // A new comparison starts from my ★ account: it's in nearly every one.
  const me = known.find((account) => account.starred);
  if (!seeded.length && me) seeded.push([{ kind: 'account', account: me }]);
  while (seeded.length < 2) seeded.push([]);
  return seeded;
}

export function ComparePlayersForm(props: ComparePlayersFormProps): JSX.Element {
  // Only a friends list this page load already fetched (Home's): suggesting friends never costs a request.
  const [friends] = createResource(
    () => getEffectiveCurrentAccount()?.id,
    async (id) => (await cachedAccountFriends(membersFromAccountId(id))?.catch(() => undefined))?.friends ?? [],
  );
  // A memo: a `?u=` account resolving after mount still shows up as a suggestion.
  const known = createMemo(() => {
    const stored = knownAccounts();
    const id = getEffectiveCurrentAccount()?.id;
    return [...stored, ...friendAccounts(friends() ?? [], stored, id ? membersFromAccountId(id) : [])];
  });
  const [slots, setSlots] = createSignal<Slot[]>(seedSlots(props.initialSlots, untrack(known)));
  // Friends land after the seed: name the ones it left as typed Steam IDs.
  createEffect(
    on(
      friends,
      () =>
        setSlots((prev) =>
          prev.map((slot) =>
            slot.flatMap((entry) =>
              entry.kind === 'typed' ? slotsFromIdentifiers([[entry.value]], known())[0] : [entry],
            ),
          ),
        ),
      { defer: true },
    ),
  );
  // Which slot's dropdown is open, what's typed in it, and which row the arrow keys are on. One
  // set of signals rather than per-slot state: only one input can be focused at a time, so only
  // one dropdown can be open, and keeping it flat means closing one is never a matter of
  // remembering to reset the others.
  const [openSlot, setOpenSlot] = createSignal<number | null>(null);
  const [query, setQuery] = createSignal('');
  const [highlight, setHighlight] = createSignal(0);
  // Whether the arrow keys or the pointer moved to the highlighted row since its reset.
  const [pointed, setPointed] = createSignal(false);
  const listboxId = createUniqueId();
  const whyDisabledId = createUniqueId();

  const matches = createMemo(() => (openSlot() == null ? [] : filterAccounts(known(), slots(), query())));
  // The row shown selected, and so the one Enter adds: one pointed at, or the top match for what's typed.
  const activeIdx = (): number | null => (pointed() || query().trim() ? highlight() : null);
  const activeAccount = () => {
    const idx = activeIdx();
    return idx == null ? undefined : matches()[idx];
  };

  function closeDropdown(): void {
    setOpenSlot(null);
    setQuery('');
    setHighlight(0);
    setPointed(false);
  }

  function openDropdown(slotIdx: number): void {
    setOpenSlot(slotIdx);
    setHighlight(0);
    setPointed(false);
  }

  function addEntry(slotIdx: number, entry: SlotEntry): void {
    setSlots((prev) => prev.map((slot, i) => (i === slotIdx ? [...slot, entry] : slot)));
    setQuery('');
    setHighlight(0);
    setPointed(false);
  }

  function removeEntry(slotIdx: number, entryIdx: number): void {
    setSlots((prev) => prev.map((slot, i) => (i === slotIdx ? slot.filter((_, j) => j !== entryIdx) : slot)));
  }

  function removeSlot(slotIdx: number): void {
    closeDropdown();
    setSlots((prev) => prev.filter((_, i) => i !== slotIdx));
  }

  // Enter commits whichever the user meant: the highlighted account when the dropdown has
  // matches, otherwise whatever they typed — an identifier for someone the app has never seen is
  // the case this whole form has to keep working for.
  function commit(slotIdx: number): void {
    const account = activeAccount();
    if (account) {
      addEntry(slotIdx, { kind: 'account', account });
      return;
    }
    const value = query().trim();
    if (value) addEntry(slotIdx, { kind: 'typed', value });
  }

  function handleKeyDown(e: KeyboardEvent, slotIdx: number): void {
    const list = matches();
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (openSlot() !== slotIdx) openDropdown(slotIdx);
        setHighlight((h) => (list.length === 0 || activeIdx() == null ? 0 : (h + 1) % list.length));
        setPointed(true);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlight((h) => (list.length === 0 ? 0 : ((activeIdx() == null ? 0 : h) - 1 + list.length) % list.length));
        setPointed(true);
        break;
      case 'Enter':
        // Swallowed: Enter commits what's typed or pointed to as a chip. Only an empty field with
        // nothing pointed to submits, so nothing half-typed is thrown away.
        e.preventDefault();
        if (!query().trim() && !activeAccount() && filledCount() >= 2) formEl.requestSubmit();
        else commit(slotIdx);
        break;
      case 'Escape':
        // Only closes the dropdown — the route's own Escape (closing the panel) has nothing to do
        // with a form the user is mid-way through.
        if (openSlot() != null) {
          e.stopPropagation();
          closeDropdown();
        }
        break;
      case 'Backspace':
        // The standard token-input affordance: backspace on an empty field deletes the chip
        // before it, so removing a mis-picked account doesn't mean aiming for its ×.
        if (query() === '') {
          const slot = slots()[slotIdx];
          if (slot.length > 0) removeEntry(slotIdx, slot.length - 1);
        }
        break;
    }
  }

  // Leaving the field commits whatever is half-typed in it rather than dropping it — clicking
  // straight from a typed-out name to "Compare" is the obvious thing to do, and focusout fires
  // before the click that caused it (confirmed live: the comparison silently refused to submit,
  // because closing the dropdown had already cleared the text the button was about to read).
  // Only the typed text, never the highlighted row: clicking away isn't picking one.
  function handleFocusOut(slotIdx: number): void {
    const value = query().trim();
    if (value) addEntry(slotIdx, { kind: 'typed', value });
    closeDropdown();
  }

  function handleSubmit(e: Event): void {
    e.preventDefault();
    const filled = slotsToIdentifiers(slots());
    if (filled.length >= 2) props.onSubmit(filled);
  }

  // Counts the text still being typed as well as the committed chips — the button's disabled
  // state is read while the field is focused, before handleFocusOut has turned it into one.
  const filledCount = (): number =>
    slots().filter((slot, i) => slotIdentifiers(slot).length > 0 || (openSlot() === i && query().trim())).length;

  let formEl!: HTMLFormElement;
  function addSlot(): void {
    setSlots((prev) => [...prev, []]);
    [...formEl.querySelectorAll<HTMLInputElement>('input[role="combobox"]')].at(-1)?.focus();
  }

  return (
    <form class="compare-form" ref={formEl} onSubmit={handleSubmit}>
      {/* <Index>, not <For>, over the slots — <For> keys by the array's own identity, so adding a
          chip (which replaces that slot's array) would tear down and rebuild the row, taking the
          focused combobox with it. <Index> keys by position, which is what a fixed list of
          numbered players is. The entries *inside* a slot are the opposite case — they're objects
          that keep their identity — so <For> is right there. */}
      <Index each={slots()}>
        {(slot, slotIdx) => (
          <div class="compare-slot">
            <span class="compare-slot-label" id={`${listboxId}-label-${slotIdx}`}>
              Player {slotIdx + 1}
            </span>
            {/* focusout with a containment check handles click-away and tabbing out alike, and
                skips focus moving *within* the slot (a chip's own × button). Each option's own
                mousedown is prevented below, so picking one never takes focus off the input in
                the first place and so never reaches this. */}
            <div
              class="compare-tokens"
              onFocusOut={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) handleFocusOut(slotIdx);
              }}
            >
              <For each={slot()}>
                {(entry, entryIdx) => {
                  const account = entry.kind === 'account' ? entry.account : null;
                  return (
                    <span
                      class="compare-token"
                      classList={{
                        'is-typed': !account,
                        'is-invalid': entry.kind === 'typed' && !!props.invalid?.includes(entry.value),
                      }}
                      title={
                        entry.kind === 'typed' && props.invalid?.includes(entry.value)
                          ? 'No Steam account found for this'
                          : undefined
                      }
                    >
                      <Show when={account?.avatarUrl}>
                        {(url) => <img class="account-avatar" src={url()} alt="" width="18" height="18" />}
                      </Show>
                      <span class="compare-token-label">{entryLabel(entry)}</span>
                      <Show when={account && account.members.length > 1}>
                        <span class="account-count">({account!.members.length})</span>
                      </Show>
                      <button
                        type="button"
                        class="compare-token-remove"
                        aria-label={`Remove ${entryLabel(entry)}`}
                        onClick={() => removeEntry(slotIdx, entryIdx())}
                      >
                        <X />
                      </button>
                    </span>
                  );
                }}
              </For>
              <input
                type="text"
                role="combobox"
                aria-labelledby={`${listboxId}-label-${slotIdx}`}
                aria-expanded={openSlot() === slotIdx}
                aria-controls={listboxId}
                aria-autocomplete="list"
                aria-activedescendant={
                  openSlot() === slotIdx && activeAccount() ? `${listboxId}-${activeIdx()}` : undefined
                }
                placeholder={slot().length > 0 ? 'Add another account…' : 'Steam name, profile URL, or 64-bit ID…'}
                value={openSlot() === slotIdx ? query() : ''}
                onFocus={() => openDropdown(slotIdx)}
                onInput={(e) => {
                  setQuery(e.currentTarget.value);
                  openDropdown(slotIdx);
                }}
                onKeyDown={(e) => handleKeyDown(e, slotIdx)}
              />
              <Show when={openSlot() === slotIdx && matches().length > 0}>
                <ul class="compare-options" id={listboxId} role="listbox">
                  <For each={matches()}>
                    {(account, optionIdx) => (
                      <li
                        id={`${listboxId}-${optionIdx()}`}
                        role="option"
                        aria-selected={activeIdx() === optionIdx()}
                        classList={{ active: activeIdx() === optionIdx() }}
                        onMouseDown={(e) => e.preventDefault()} // keep focus on the input, so focusout doesn't beat the click
                        onMouseEnter={() => {
                          setHighlight(optionIdx());
                          setPointed(true);
                        }}
                        onClick={() => addEntry(slotIdx, { kind: 'account', account })}
                      >
                        <Show when={account.avatarUrl}>
                          {(url) => <img class="account-avatar" src={url()} alt="" width="20" height="20" />}
                        </Show>
                        <span>
                          <Show when={account.starred}>
                            <Star class="compare-option-star" />{' '}
                          </Show>
                          {account.label}
                        </span>
                        <Show when={account.members.length > 1}>
                          <span class="account-count">Family · {account.members.length} accounts</span>
                        </Show>
                        <Show when={account.friend}>
                          <span class="account-count">Friend</span>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </div>
            <Show when={slots().length > 2}>
              <button
                type="button"
                class="btn"
                title="Remove this player"
                aria-label="Remove this player"
                onClick={() => removeSlot(slotIdx)}
              >
                <X />
              </button>
            </Show>
          </div>
        )}
      </Index>
      {/* Several accounts in one slot are merged into a single library before comparing — the same
          Steam Family shape an AccountSlot has everywhere else in the app. */}
      <p class="compare-form-hint">Add more than one account to a player to compare a Steam Family as one library.</p>
      <div class="compare-form-actions">
        <button type="button" class="btn" onClick={addSlot}>
          <Plus /> Add player
        </button>
        <button
          type="submit"
          class="btn btn-primary"
          aria-disabled={filledCount() < 2 ? 'true' : undefined}
          aria-describedby={filledCount() < 2 ? whyDisabledId : undefined}
        >
          {props.submitLabel}
        </button>
        <Show when={props.onCancel}>
          {(cancel) => (
            <button type="button" class="btn" onClick={() => cancel()()}>
              Cancel
            </button>
          )}
        </Show>
        {/* Last in the row, so hiding it never moves the buttons. */}
        <span id={whyDisabledId} class="compare-form-hint" classList={{ 'is-hidden': filledCount() >= 2 }}>
          {filledCount() === 0 ? 'Add two players' : 'Add a second player'}
        </span>
      </div>
    </form>
  );
}
