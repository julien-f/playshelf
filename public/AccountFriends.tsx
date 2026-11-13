// The currently-explored account's friends list, with any friend who's also a friend of the
// signed-in user's own account marked. Its own component (not inlined into HomeRoute.tsx's
// account card) so each fetch can key a `createResource` on a plain accountId string — Solid's
// reactivity rules require a primitive resource source, not the AccountSlot object itself.
import { createEffect, createResource, createMemo, createSignal, For, on, Show, type JSX } from 'solid-js';
import { A } from '@solidjs/router';
import ArrowRight from 'lucide-solid/icons/arrow-right';
import Handshake from 'lucide-solid/icons/handshake';
import RefreshCw from 'lucide-solid/icons/refresh-cw';
import { accountSlotFrom, fetchAccountFriends, membersFromAccountId, type AccountFriend } from './accountData.ts';
import { fmtAge } from './utils.ts';
import { compareUrl } from './urlState.ts';
import type { AccountSlot } from './types.ts';

// `info.refetching` is what the ↻ below sets — the same "a refetch means force" convention the
// side panel's own resources use (see panelData.ts), bypassing both the server's cache and
// Steam's copy of a friends list that changes far more often than the long TTL it's cached for.
async function loadFriends(
  accountId: string,
  info: { refetching: boolean | unknown },
): Promise<{ friends: AccountFriend[]; unavailable: string[]; fetchedAt: number | null }> {
  return fetchAccountFriends(membersFromAccountId(accountId), { refresh: info.refetching === true });
}

// C1's group: past it, a comparison costs a library fetch per player for no game night.
const MAX_COMPARED = 5;

export function AccountFriends(props: {
  accountId: string;
  // The account's own identifiers, comma-joined (a Family's members), and its name, for Compare.
  accountIdentifiers: string;
  accountLabel: string;
  myAccountId: string | null;
  onExplore: (account: AccountSlot) => void;
}): JSX.Element {
  const [explored, { refetch: refetchExplored }] = createResource(() => props.accountId, loadFriends);
  // Only fetched when exploring somebody else's account — comparing an account's friends against
  // its own friends would mark every single one of them "mutual", which says nothing useful.
  const [mine] = createResource(
    () => (props.myAccountId && props.myAccountId !== props.accountId ? props.myAccountId : undefined),
    loadFriends,
  );
  const mineIds = createMemo(() => new Set((mine()?.friends ?? []).map((f) => f.steamid)));
  // A Family's members are friends of each other: comparing it with one of them says nothing.
  const ownMembers = createMemo(() => new Set(membersFromAccountId(props.accountId)));
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  createEffect(
    on(
      () => props.accountId,
      () => setSelected(new Set<string>()),
      { defer: true },
    ),
  );
  const toggle = (steamid: string, on: boolean) => {
    const next = new Set(selected());
    if (on) next.add(steamid);
    else next.delete(steamid);
    setSelected(next);
  };
  const compareHref = createMemo(() =>
    compareUrl([props.accountIdentifiers.split(','), ...[...selected()].map((steamid) => [steamid])]),
  );

  // Mutual friends first (the more interesting fact when browsing someone else's list), then
  // alphabetical — Steam's own GetFriendList order is neither stable nor meaningful (roughly
  // friend-since, unspecified for a merged Family's union).
  const sortedFriends = createMemo(() => {
    const mutual = mineIds();
    return [...(explored()?.friends ?? [])].sort((a, b) => {
      const am = mutual.has(a.steamid),
        bm = mutual.has(b.steamid);
      if (am !== bm) return am ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  });

  return (
    <Show when={explored()}>
      {(data) => (
        <details class="account-friends">
          {/* "0" would read as "no friends"; with nothing visible because it's private, say so. */}
          <summary>
            Friends ({data().friends.length === 0 && data().unavailable.length > 0 ? 'private' : data().friends.length})
          </summary>
          {/* Same age-is-the-control shape as the list heroes' Updated tile and the panel's own
              ↻ — inside the disclosure rather than in its summary, since clicking a button in a
              <summary> would also toggle the disclosure it sits in. */}
          <p class="account-friends-meta">
            <button
              type="button"
              class="account-friends-refresh"
              disabled={explored.loading}
              title="How old the server's cached copy of this friends list is — click to re-fetch it from Steam"
              onClick={() => void refetchExplored()}
            >
              Updated {explored.loading ? 'Refreshing…' : fmtAge(data().fetchedAt)}{' '}
              <RefreshCw class="account-friends-refresh-icon" />
            </button>
          </p>
          <Show when={data().unavailable.length > 0}>
            <p class="account-friends-note">
              Friends list is private for {data().unavailable.length} member{data().unavailable.length > 1 ? 's' : ''}.
            </p>
          </Show>
          <Show
            when={data().friends.length > 0}
            fallback={data().unavailable.length ? undefined : <p>No public friends found.</p>}
          >
            <Show
              when={selected().size > 0}
              fallback={
                <p class="account-friends-note">
                  Select up to {MAX_COMPARED} friends to compare with {props.accountLabel}.
                </p>
              }
            >
              <p class="account-friends-compare">
                <A class="btn" href={compareHref()}>
                  Compare with {props.accountLabel} ({selected().size})
                </A>
                <Show when={selected().size >= MAX_COMPARED}>
                  <span class="account-friends-note">Up to {MAX_COMPARED} friends: a comparison is for one group.</span>
                </Show>
              </p>
            </Show>
            <ul class="account-friends-list">
              <For each={sortedFriends()}>
                {(f) => (
                  <li>
                    <Show when={!ownMembers().has(f.steamid)}>
                      <input
                        type="checkbox"
                        class="account-friends-select"
                        aria-label={`Select ${f.name}`}
                        checked={selected().has(f.steamid)}
                        disabled={!selected().has(f.steamid) && selected().size >= MAX_COMPARED}
                        onChange={(e) => toggle(f.steamid, e.currentTarget.checked)}
                      />
                    </Show>
                    <Show when={f.avatarUrl}>
                      {(url) => (
                        <span class="account-avatar-wrap">
                          <img class="account-avatar" src={url()} alt="" width="28" height="28" />
                        </span>
                      )}
                    </Show>
                    <Show when={f.profileUrl} fallback={<span class="account-name">{f.name}</span>}>
                      {(url) => (
                        <a
                          class="account-name account-profile-link"
                          href={url()}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {f.name} <span class="account-profile-arrow">↗</span>
                        </a>
                      )}
                    </Show>
                    <Show when={mineIds().has(f.steamid)}>
                      <span class="account-friend-mutual" title="Also a friend of your own account">
                        <Handshake /> Mutual
                      </span>
                    </Show>
                    <button
                      type="button"
                      class="btn"
                      title={`Explore ${f.name}'s library`}
                      onClick={() => props.onExplore(accountSlotFrom([f], [f.steamid]))}
                    >
                      Explore <ArrowRight />
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </details>
      )}
    </Show>
  );
}
