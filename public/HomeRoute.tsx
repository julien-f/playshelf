// Home — account picker/header and the folder/list tree (see docs/dev/lists-and-accounts.md).
// Accounts come from accountsStore.ts's reactive getters; the list tree is re-read after each mutation (`refreshTree`).
//
// **Current scope, deliberately trimmed for a first pass**: folder/list reorganizing (rename/
// move/delete) uses an inline name field, a Move select and a `window.confirm` rather than a polished drag-
// and-drop tree UI — real functionality (backed by the fully-built `listsStore.ts`), minimal
// chrome. No trash/restore UI for soft-deleted lists yet. The combine
// form below can pick any recent account's Owned/Wishlist, Recently Looked Up, or any existing
// user list as a source. A bundle joins it only from its own page ("What does this add?" opens a
// /lists/shared link, saved from there) — offering every bundle here would need a bundle picker.
import {
  createSignal,
  createEffect,
  createMemo,
  on,
  onCleanup,
  onMount,
  For,
  Index,
  Match,
  Show,
  Switch,
  type JSX,
} from 'solid-js';
import { A, useLocation, useNavigate } from '@solidjs/router';
import {
  getMyAccount,
  setMyAccount,
  getEffectiveCurrentAccount,
  getAccountOverride,
  accountDisplayLabel,
  accountIdentifiers,
  refreshAccountInfo,
} from './accountsStore.ts';
import { getAccountOverrideState, adoptAccount, accountOverrideStatusText } from './accountOverride.ts';
import { withAccountParam, parseUrlState, compareUrl, COMPARE_PATH } from './urlState.ts';
import { resolveAccountSlot, fetchAccountOverview, fetchAccountWishlist, accountInfoFrom } from './accountData.ts';
import type { AccountPlayer } from './accountData.ts';
import { ApiError, normalizeInput, steamVanity, fmtAge, countryFlag } from './utils.ts';
import { SteamPrivacyLink } from './SteamPrivacyLink.tsx';
import { CopyButton } from './CopyButton.tsx';
import { AccountFriends } from './AccountFriends.tsx';
import { AccountTiles } from './AccountTiles.tsx';
import {
  getFolders,
  getLists,
  createFolder,
  createList,
  renameFolder,
  renameList,
  deleteFolder,
  deleteList,
  moveFolder,
  moveList,
  folderPaths,
  isDescendantFolder,
  getRanking,
} from './listsStore.ts';
import { getListViews, type ViewKind } from './listViews.ts';
import { bindNavPopover } from './navPopover.ts';
import { useBaseTitle } from './pageTitle.ts';
import { createDefaultNaming, formatFormula, listDisplayName } from './listLabels.ts';
import { CombineForm } from './CombineForm.tsx';
import { GAME_PASS_PATH, GAME_PASS_TITLE } from './gamePassData.ts';
import Blend from 'lucide-solid/icons/blend';
import Ellipsis from 'lucide-solid/icons/ellipsis';
import FolderIcon from 'lucide-solid/icons/folder';
import FolderPlus from 'lucide-solid/icons/folder-plus';
import Gamepad2 from 'lucide-solid/icons/gamepad-2';
import Heart from 'lucide-solid/icons/heart';
import RotateCcwClock from 'lucide-solid/icons/rotate-ccw-clock';
import LibraryBig from 'lucide-solid/icons/library-big';
import ListIcon from 'lucide-solid/icons/list';
import ListPlus from 'lucide-solid/icons/list-plus';
import Lock from 'lucide-solid/icons/lock';
import Package from 'lucide-solid/icons/package';
import Plus from 'lucide-solid/icons/plus';
import RefreshCw from 'lucide-solid/icons/refresh-cw';
import Star from 'lucide-solid/icons/star';
import Trophy from 'lucide-solid/icons/trophy';
import Users from 'lucide-solid/icons/users';
import X from 'lucide-solid/icons/x';
import type { AccountSlot, Folder, GameList, ListRef, CombineOp } from './types.ts';
import { MAX_RECENT_GAMES } from './recentGames.ts';

// `personastate`/`gameextrainfo` ride on the same 6h library cache tier as the rest of an
// account's data (see toAccountPlayer in accountData.ts) — real data, just not live — so the
// tooltip says "as of the last refresh" rather than implying real-time presence.

interface TreeRow {
  type: 'folder' | 'list';
  item: Folder | GameList;
  depth: number;
}

export default function HomeRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const myAccount = getMyAccount;
  // The *effective* current account — a `?u=` link's override when one is being explored,
  // the stored preference otherwise (see accountsStore.ts's own `?u=` section). Everything
  // below (the account card, the counts/players fetch, the document title) reads this, so a
  // shared link renders exactly as a picked account does; only the picker itself (recents,
  // ★ starring) still deals in stored accounts.
  const currentAccount = getEffectiveCurrentAccount;
  const overrideState = getAccountOverrideState;
  const [resolveInputs, setResolveInputs] = createSignal<string[]>(['']);
  const [resolveError, setResolveError] = createSignal<{ text: string; isPrivate: boolean } | null>(null);
  const [resolving, setResolving] = createSignal(false);
  // null while loading; 'failed' when the fetch failed, so it doesn't read as an empty library.
  type Count = number | null | 'failed';
  const showCount = (n: Count) => (n === null ? '…' : n === 'failed' ? "couldn't load" : <data value={n}>{n}</data>);
  const [counts, setCounts] = createSignal<{ owned: Count; wishlist: Count }>({
    owned: null,
    wishlist: null,
  });
  // The current account's member accounts as Steam itself describes them (persona name, profile
  // URL, presence, profile visibility, per-member game count) — see the counts effect below for
  // why this rides along on the same fetch rather than being stored on AccountSlot.
  const [players, setPlayers] = createSignal<AccountPlayer[]>([]);
  // How old the server's cached copy of the current account's data is (epoch ms, null = fetched
  // fresh), and whether a forced re-fetch is in flight — see the Account card's "Updated <when>"
  // line below.
  const [fetchedAt, setFetchedAt] = createSignal<number | null>(null);
  const [refreshing, setRefreshing] = createSignal(false);

  const [folders, setFoldersSig] = createSignal<Folder[]>(getFolders());
  const [lists, setListsSig] = createSignal<GameList[]>(getLists());

  function refreshTree(): void {
    setFoldersSig(getFolders());
    setListsSig(getLists());
  }

  // Counts and per-member profile data aren't stored on AccountSlot itself (they'd go stale —
  // AccountSlot only caches a label/avatar so recents can render instantly) — refetched live
  // whenever currentAccount changes, including on initial mount for whatever was already stored.
  // Extracted from the effect below so the card's own ↻ can re-run it with `refresh: true`,
  // which forces the server past its library-tier cache for this account (owned games, wishlist
  // and profile alike) rather than waiting out a TTL now measured in weeks.
  function loadAccountData(account: AccountSlot, { refresh = false }: { refresh?: boolean } = {}): void {
    setCounts({ owned: null, wishlist: null });
    setPlayers([]);
    // Every load, not just a refresh: a superseded one never settles these for the next account.
    setRefreshing(refresh);
    setFetchedAt(null);
    const members = account.members;
    // Guards every setter below: switching accounts again before this fetch settles (e.g.
    // adopting a `?u=` override right after landing on it, which fires this same effect for
    // the previous account first) must not let the *older* response — which can resolve later
    // — clobber state that already moved on to a different account. Confirmed live: without
    // this, the header briefly showed one account's owned/wishlist counts alongside a stale
    // solePlayer() (memberSince/countryCode/realName) from whichever account was current a
    // moment earlier. Reads accountsStore.ts's own plain `getEffectiveCurrentAccount()`, not the
    // local `currentAccount` signal — this runs inside async callbacks, well outside any tracked
    // scope, so a signal read here wouldn't ever see a later update anyway (and would trip
    // `solid/reactivity`); the plain module accessor always reflects the live value on demand.
    const isStale = (): boolean => getEffectiveCurrentAccount()?.id !== account.id;
    const owned = fetchAccountOverview(members, { refresh }).then(
      ({ games, players: ps, fetchedAt: at }) => {
        if (isStale()) return;
        setCounts((c) => ({ ...c, owned: games.length }));
        setPlayers(ps);
        setFetchedAt(at);
        // Keeps the stored slot's name/avatar current (accountsStore.ts's refreshAccountInfo).
        refreshAccountInfo(account.id, accountInfoFrom(ps));
      },
      () => {
        if (!isStale()) setCounts((c) => ({ ...c, owned: 'failed' }));
      },
    );
    const wishlist = fetchAccountWishlist(members, { refresh }).then(
      ({ items }) => {
        if (!isStale()) setCounts((c) => ({ ...c, wishlist: items.length }));
      },
      () => {
        if (!isStale()) setCounts((c) => ({ ...c, wishlist: 'failed' }));
      },
    );
    void Promise.allSettled([owned, wishlist]).then(() => {
      if (!isStale()) setRefreshing(false);
    });
  }

  // Keyed on the id: a refreshed label (refreshAccountInfo) is the same account, not a new fetch.
  // A memo, since `on` alone re-runs on every event's freshly read (equal) account.
  const currentAccountId = createMemo(() => currentAccount()?.id);
  createEffect(
    on(currentAccountId, () => {
      const account = currentAccount();
      if (!account) {
        setCounts({ owned: null, wishlist: null });
        setPlayers([]);
        setFetchedAt(null);
        setRefreshing(false);
        return;
      }
      loadAccountData(account);
    }),
  );

  // The resolved slot a `?u=` link is currently showing, or null when there's no override (or
  // it hasn't resolved yet / failed) — what the "Exploring …" note and its adopt button read.
  const overrideAccount = createMemo(() => (overrideState().state === 'ready' ? getAccountOverride() : null));

  // Only meaningful for a single-account slot — a Steam Family has no one persona/presence/
  // profile to speak for the whole slot, so its members are listed individually instead (see the
  // Account card below).
  const solePlayer = createMemo(() => (players().length === 1 ? players()[0] : null));

  // What a member copies as: the custom-URL name from the live profile URL when Steam returned
  // one, else whatever the slot captured at resolve time (a profile the API answered nothing for
  // still has a stored name), else the steam64 id. See accountsStore.ts's accountIdentifiers.
  function copyIdentifier(p: AccountPlayer): string {
    return steamVanity(p.profileUrl) || currentAccount()?.vanities?.[p.steamid] || p.steamid;
  }

  // document.title's per-route "base" layer (see pageTitle.ts) — whichever account is currently
  // loaded, same fallback-to-bare-app-name-when-none convention the old comparison page's own
  // updateTitle() used. The side panel's own game-open title takes over on top of this when a
  // game is opened from here, same as every other route.
  useBaseTitle(() => {
    const account = currentAccount();
    return account ? accountDisplayLabel(account) : null;
  });

  // An old Comparison-page link — `/?u=alice&u=bob`, several slots — used to land here and be
  // explained away ("showing the first"). It has a real address again, so it's forwarded to it
  // instead. Replace, not push: the visitor never chose to be on Home.
  createEffect(() => {
    const slots = parseUrlState(location.search).slots;
    if (slots.length > 1) navigate(compareUrl(slots), { replace: true });
  });

  async function resolveAndSetCurrent(): Promise<void> {
    const trimmed = resolveInputs()
      .map((s) => normalizeInput(s.trim()))
      .filter(Boolean);
    if (trimmed.length === 0 || resolving()) return;
    setResolving(true);
    setResolveError(null);
    try {
      pickAccount(await resolveAccountSlot(trimmed));
      setResolveInputs(['']);
    } catch (err) {
      setResolveError({ text: (err as Error).message, isPrivate: !!(err instanceof ApiError && err.accounts) });
    } finally {
      setResolving(false);
    }
  }

  function pickAccount(account: AccountSlot): void {
    adoptAccount(account, navigate, location);
  }

  // An action, not a state: the glyph shows the state, and a voice user says what the tooltip says.
  function starLabel(account: AccountSlot): string {
    const label = accountDisplayLabel(account);
    return myAccount()?.id === account.id ? `Unstar ${label}` : `Star ${label} as mine`;
  }

  function toggleMyAccount(account: AccountSlot): void {
    setMyAccount(myAccount()?.id === account.id ? null : account);
  }

  let lookupField!: HTMLInputElement;

  // The fixed list links have to carry a `?u=` override along (`withAccountParam`) or clicking
  // "Owned" while exploring a shared link would quietly show the *stored* account's library
  // instead. Built off the router's own reactive `location.search`, so each href updates itself
  // the moment an explicit pick strips the param (pickAccount above).
  function accountLink(path: string): string {
    return withAccountParam(path, location.search);
  }

  // A list's saved views (listViews.ts), straight from its card.
  function viewLinks(kind: ViewKind): { name: string; href: string }[] {
    return getListViews(kind).map((v) => ({ name: v.name, href: accountLink(`/lists/${kind}?view=${v.id}`) }));
  }

  // Home's ways into the lists that aren't the user's own; `name` is each link's accessible name.
  const exploreCards = () => [
    {
      name: 'Owned',
      href: accountLink('/lists/owned'),
      icon: LibraryBig,
      description: "The current account's games",
      views: viewLinks('owned'),
    },
    {
      name: 'Wishlist',
      href: accountLink('/lists/wishlist'),
      icon: Heart,
      description: "The current account's wishlist",
      views: viewLinks('wishlist'),
    },
    // No `?u=`: a comparison names its own players in the URL, and carrying an unrelated
    // account override alongside them would be two different claims about whose games are on screen.
    { name: 'Compare', href: COMPARE_PATH, icon: Users, description: 'Two or more players, grouped by who owns what' },
    { name: 'Bundles', href: accountLink('/bundles'), icon: Package, description: 'Current Steam game bundles' },
    {
      name: GAME_PASS_TITLE,
      href: accountLink(GAME_PASS_PATH),
      icon: Gamepad2,
      description: 'Steam games currently in PC Game Pass',
    },
    {
      name: 'Recently Looked Up',
      href: accountLink('/game'),
      icon: RotateCcwClock,
      description: `The last ${MAX_RECENT_GAMES} games you searched for`,
    },
  ];

  // What the tree's inline name field is naming: a new folder or list (no id), or an existing row.
  type NameTarget = { kind: 'folder' | 'list'; id?: string };
  const [nameTarget, setNameTarget] = createSignal<NameTarget | null>(null);
  let newFolderBtn!: HTMLButtonElement;
  let newListBtn!: HTMLButtonElement;
  let treeHeading!: HTMLHeadingElement;
  function newNameTarget(): NameTarget | null {
    const target = nameTarget();
    return target && !target.id ? target : null;
  }

  // `name` null = cancelled; an empty one too, except on a list labeled without one (all but manual).
  function handleNamed(target: NameTarget, name: string | null, viaKey: boolean): void {
    setNameTarget(null);
    const trimmed = name?.trim() ?? '';
    if (name != null) {
      if (!target.id) {
        if (trimmed && target.kind === 'folder') createFolder(trimmed);
        else if (trimmed) createList({ name: trimmed, kind: 'manual' });
      } else if (target.kind === 'folder') {
        if (trimmed) renameFolder(target.id, trimmed);
      } else {
        const list = lists().find((l) => l.id === target.id);
        if (list && trimmed !== (list.name ?? '') && (trimmed || list.kind !== 'manual'))
          renameList(list.id, trimmed || undefined);
      }
      refreshTree();
    }
    // A blur already put focus where the user went.
    if (viaKey) (target.id ? menuTrigger(target.id) : target.kind === 'folder' ? newFolderBtn : newListBtn)?.focus();
  }

  function NameField(props: { target: NameTarget; initial: string; placeholder?: string }): JSX.Element {
    let done = false;
    function finish(name: string | null, viaKey: boolean): void {
      if (done) return;
      done = true;
      handleNamed(props.target, name, viaKey);
    }
    return (
      <input
        type="text"
        class="tree-name-field"
        aria-label={props.target.kind === 'folder' ? 'Folder name' : 'List name'}
        value={props.initial}
        placeholder={props.placeholder}
        ref={(el) =>
          queueMicrotask(() => {
            el.focus();
            el.select();
          })
        }
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.isComposing) {
            e.preventDefault();
            finish(e.currentTarget.value, true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            finish(null, true);
          }
        }}
        onBlur={(e) => finish(e.currentTarget.value, false)}
      />
    );
  }

  // ── Combine setup (creating a dynamic list) ───────────────────────────────────────────────
  const [combineOpen, setCombineOpen] = createSignal(false);

  function toggleCombine(): void {
    setCombineOpen((v) => !v);
  }

  // No name is a valid choice, not a missing field: the list is then labeled by its own formula
  // everywhere, and follows a later source edit (see listLabels.ts).
  function handleCreateCombine(input: { name?: string; op: CombineOp; sources: ListRef[] }): void {
    const list = createList({ name: input.name, kind: 'dynamic', op: input.op, sources: input.sources });
    navigate(accountLink(`/lists/${list.id}`));
    document.querySelector<HTMLElement>('main')?.focus();
  }

  // A list's on-screen label — its name, or its formula when it has none (listLabels.ts).
  function listName(list: GameList): string {
    return listDisplayName(list, createDefaultNaming());
  }

  // Each returns whether the row went away (a folder always does: Cancel moves its contents up).
  function handleDeleteFolder(folder: Folder): boolean {
    const hasChildren =
      folders().some((f) => f.parentId === folder.id) || lists().some((l) => l.parentId === folder.id);
    const mode = hasChildren
      ? window.confirm(
          `"${folder.name}" isn't empty. Delete it and everything inside? Cancel to move its contents up instead.`,
        )
        ? 'delete'
        : 'promote'
      : 'delete';
    deleteFolder(folder.id, mode);
    refreshTree();
    return true;
  }

  function handleDeleteList(list: GameList): boolean {
    if (!window.confirm(`Delete "${listName(list)}"?`)) return false;
    const result = deleteList(list.id);
    if (result.softDeleted)
      window.alert(`"${listName(list)}" is still referenced by another list, so it was hidden instead of deleted.`);
    refreshTree();
    return true;
  }

  function childrenOf(parentId: string | null): { type: 'folder' | 'list'; item: Folder | GameList; order: number }[] {
    const childFolders = folders()
      .filter((f) => f.parentId === parentId)
      .map((f) => ({ type: 'folder' as const, item: f, order: f.order }));
    const childLists = lists()
      .filter((l) => l.parentId === parentId)
      .map((l) => ({ type: 'list' as const, item: l, order: l.order }));
    return [...childFolders, ...childLists].sort((a, b) => a.order - b.order);
  }

  function collectRows(parentId: string | null, depth: number, out: TreeRow[]): void {
    for (const child of childrenOf(parentId)) {
      out.push({ type: child.type, item: child.item, depth });
      if (child.type === 'folder') collectRows(child.item.id, depth + 1, out);
    }
  }

  const treeRows = createMemo(() => {
    const out: TreeRow[] = [];
    collectRows(null, 0, out);
    return out;
  });

  // Where a row can go: the top level or any folder, minus where it already is and — for a
  // folder — itself and its own descendants (listsStore.ts's moveFolder refuses those anyway).
  const ROOT = '__root__';
  function moveTargets(row: TreeRow): { id: string; label: string }[] {
    const all = folders();
    const here = row.item.parentId ?? ROOT;
    return [{ id: ROOT, label: 'Top level' }, ...folderPaths(all).map((f) => ({ id: f.id, label: f.path }))].filter(
      (t) =>
        t.id !== here &&
        !(
          row.type === 'folder' &&
          t.id !== ROOT &&
          (t.id === row.item.id || isDescendantFolder(t.id, row.item.id, all))
        ),
    );
  }
  function handleMove(row: TreeRow, target: string): void {
    const parentId = target === ROOT ? null : target;
    if (row.type === 'folder') moveFolder(row.item.id, parentId);
    else moveList(row.item.id, parentId);
    refreshTree();
  }
  function MoveSelect(props: { row: TreeRow; name: string }): JSX.Element {
    return (
      <Show when={moveTargets(props.row).length > 0}>
        <select
          class="tree-move"
          aria-label={`Move ${props.name} to…`}
          value=""
          onChange={(e) => {
            const target = e.currentTarget.value;
            e.currentTarget.value = '';
            if (!target) return;
            handleMove(props.row, target);
            menuTrigger(props.row.item.id)?.focus(); // the moved row was rebuilt, its menu with it
          }}
        >
          {/* Without `selected`, the browser skips this disabled option and shows the first folder as already picked. */}
          <option value="" disabled selected>
            Move to…
          </option>
          <For each={moveTargets(props.row)}>{(t) => <option value={t.id}>{t.label}</option>}</For>
        </select>
      </Show>
    );
  }

  function rowName(row: TreeRow): string {
    return row.type === 'folder' ? (row.item as Folder).name : listName(row.item as GameList);
  }

  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  // What a row holds, from what's already in memory: no list is resolved for it.
  function rowSummary(row: TreeRow): string {
    if (row.type === 'folder') return `Folder · ${plural(childrenOf(row.item.id).length, 'item')}`;
    const list = row.item as GameList;
    if (list.kind === 'manual') return `List · ${plural(list.appids?.length ?? 0, 'game')}`;
    if (list.kind === 'ranked') return `Ranking · ${getRanking(list.id).groups.flat().length} ranked`;
    const formula = list.name && formatFormula(list, createDefaultNaming());
    return `Combined · ${formula || plural(list.sources?.length ?? 0, 'source')}`;
  }

  function TreeIcon(props: { row: TreeRow }): JSX.Element {
    return (
      <Switch fallback={<ListIcon class="tree-icon" />}>
        <Match when={props.row.type === 'folder'}>
          <FolderIcon class="tree-icon" />
        </Match>
        <Match when={(props.row.item as GameList).kind === 'dynamic'}>
          <Blend class="tree-icon" />
        </Match>
        <Match when={(props.row.item as GameList).kind === 'ranked'}>
          <Trophy class="tree-icon" />
        </Match>
      </Switch>
    );
  }

  const menuTrigger = (id: string) => document.querySelector<HTMLElement>(`[data-menu-id="${id}"]`);

  // A row's ⋯: Move, Rename and Delete in a popover, which hands focus back to ⋯ when it closes.
  function TreeMenu(props: { row: TreeRow }): JSX.Element {
    let trigger!: HTMLButtonElement;
    let panel!: HTMLDivElement;
    onMount(() => onCleanup(bindNavPopover(trigger, panel)));
    // Hidden first, so focus is back on ⋯ before the name field takes it (its blur commits).
    function rename(): void {
      panel.hidePopover();
      setNameTarget({ kind: props.row.type, id: props.row.item.id });
    }
    function remove(): void {
      panel.hidePopover();
      const index = treeRows().findIndex((r) => r.item.id === props.row.item.id);
      const deleted =
        props.row.type === 'folder'
          ? handleDeleteFolder(props.row.item as Folder)
          : handleDeleteList(props.row.item as GameList);
      if (!deleted) return; // cancelled: focus is already back on ⋯
      const rows = treeRows();
      const next = rows[Math.min(index, rows.length - 1)];
      (next ? menuTrigger(next.item.id) : treeHeading)?.focus();
    }
    return (
      <>
        <button
          ref={trigger}
          type="button"
          class="tree-more"
          popovertarget={`tree-menu-${props.row.item.id}`}
          aria-label={`More actions for ${rowName(props.row)}`}
          title="More actions"
          data-menu-id={props.row.item.id}
        >
          <Ellipsis />
        </button>
        <div ref={panel} id={`tree-menu-${props.row.item.id}`} class="site-nav-popover-panel tree-menu-panel" popover>
          <MoveSelect row={props.row} name={rowName(props.row)} />
          <button type="button" class="tree-menu-item" aria-label={`Rename ${rowName(props.row)}`} onClick={rename}>
            Rename
          </button>
          <button type="button" class="tree-menu-item" aria-label={`Delete ${rowName(props.row)}`} onClick={remove}>
            Delete
          </button>
        </div>
      </>
    );
  }

  return (
    <div class="home-route">
      <h1 class="visually-hidden">Home</h1>
      <section class="home-account">
        <h2 class="visually-hidden">Account</h2>

        {/* A `?u=` link being explored — see accountsStore.ts's own `?u=` section. Said out loud
            rather than left implicit: the account card below is showing someone the *link*
            picked, not the visitor's own stored account, and that difference is invisible
            otherwise. The adopt button is the only way this ever becomes their stored account
            (pickAccount, which also strips the now-redundant param). */}
        <Show when={overrideState().state !== 'none'}>
          <div class="account-override">
            <Show when={accountOverrideStatusText(overrideState())}>
              {(text) => <p class="account-override-status">{text()}</p>}
            </Show>
            <Show when={overrideAccount()}>
              {(account) => (
                <p class="account-override-status">
                  Exploring <strong>{accountDisplayLabel(account())}</strong> from this link — your own current account
                  is unchanged.
                  <button type="button" class="btn" onClick={() => pickAccount(account())}>
                    Set as my current account
                  </button>
                </p>
              )}
            </Show>
          </div>
        </Show>
        {/* The header speaks for the slot as a whole — one avatar/name/presence for a plain
            single account, or just the joined label plus a per-member list below for a Steam
            Family, where no single persona/profile/presence describes the whole thing. Everything
            beyond the label/avatar comes from `players()` (fetched live, see the effect above),
            not from the stored AccountSlot, so it can't show a stale persona or presence. */}
        <Show
          when={currentAccount()}
          fallback={
            <p class="home-intro">
              Browse a Steam library with ratings, completion times and prices, and compare it with your friends'
              libraries. Start by looking up your account.
            </p>
          }
        >
          {(account) => (
            <div class="account-header">
              <Show when={solePlayer()?.avatarUrl || account().avatarUrl}>
                {(url) => (
                  <span class="account-avatar-wrap account-avatar-lg">
                    <img class="account-avatar" src={url()} alt="" width="64" height="64" />
                  </span>
                )}
              </Show>
              <div>
                <div class="account-label">
                  <Show when={solePlayer()?.profileUrl} fallback={solePlayer()?.name || accountDisplayLabel(account())}>
                    {(url) => (
                      <a
                        class="account-profile-link"
                        href={url()}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`Steam ID ${solePlayer()!.steamid}`}
                      >
                        {solePlayer()!.name} <span class="account-profile-arrow">↗</span>
                      </a>
                    )}
                  </Show>
                  <Show when={solePlayer()?.realName}>{(n) => <span class="account-realname">({n()})</span>}</Show>
                  <Show when={solePlayer()}>
                    {(p) => (
                      <CopyButton
                        text={copyIdentifier(p())}
                        title={`Copy this account's Steam identifier (${copyIdentifier(p())})`}
                      />
                    )}
                  </Show>
                  {/* Not while exploring a `?u=` link: that state has its own "Set as my current account". */}
                  <Show when={overrideState().state === 'none'}>
                    <button
                      type="button"
                      class="account-star-btn"
                      classList={{ 'is-mine': myAccount()?.id === account().id }}
                      title={starLabel(account())}
                      aria-label={starLabel(account())}
                      onClick={() => toggleMyAccount(account())}
                    >
                      <Star />
                    </button>
                  </Show>
                  <Show when={solePlayer()?.isPrivate}>
                    <span
                      class="account-private"
                      title="This Steam profile isn't public — some data may be missing or empty"
                    >
                      <Lock /> Private
                    </span>
                  </Show>
                </div>
                <div class="account-counts">
                  Owned: {showCount(counts().owned)} · Wishlisted: {showCount(counts().wishlist)}
                  <Show when={players().length > 1}>
                    {' · '}
                    <data value={players().length}>{players().length}</data> accounts merged
                  </Show>
                  <Show when={solePlayer()?.memberSince}>
                    {(s) => (
                      <>
                        {' · Member since '}
                        <time datetime={s()}>{s()}</time>
                      </>
                    )}
                  </Show>
                  <Show when={solePlayer()?.countryCode}>{(c) => ` ${countryFlag(c())}`}</Show>
                </div>
                {/* Steam data is cached server-side for a long time (see default.env's
                    LIBRARY_CACHE_TTL_MINUTES), so the age of what's on screen is stated outright
                    rather than left to be guessed at — and the statement *is* the control that
                    fixes it, the same shape the list heroes' Updated tile and the side panel's
                    own Refresh details button now use, rather than a separate button beside the text. */}
                <div class="account-updated">
                  <button
                    type="button"
                    class="account-updated-btn"
                    disabled={refreshing()}
                    title="How old the server's cached copy of this account is — click to re-fetch its games, wishlist and profile from Steam"
                    onClick={() => loadAccountData(account(), { refresh: true })}
                  >
                    Updated {refreshing() ? 'Refreshing…' : fmtAge(fetchedAt())}{' '}
                    <RefreshCw class="account-updated-icon" />
                  </button>
                </div>
              </div>
            </div>
          )}
        </Show>

        <form
          class="home-lookup"
          onSubmit={(e) => {
            e.preventDefault();
            resolveAndSetCurrent();
          }}
        >
          {/* <Index>, not <For> — <For> keys each item by the value itself (`===` on the
              array element), which is exactly wrong for a list of strings the user is actively
              typing into: changing "a" to "ab" makes the old and new values two *different*
              strings, so <For> would tear down and recreate that index's whole <input> on every
              keystroke, dropping focus mid-word. <Index> keys by array position instead — typing
              updates the same DOM node in place, the same fix Solid's own docs give for this. */}
          <Index each={resolveInputs()}>
            {(value, i) => (
              <input
                type="text"
                // Only the added ones get focus: the first field is there on load.
                ref={(el) => (i > 0 ? queueMicrotask(() => el.focus()) : (lookupField = el))}
                value={value()}
                placeholder="Steam name, profile URL, or 64-bit ID…"
                aria-label="Steam name, profile URL, or 64-bit ID"
                onInput={(e) =>
                  setResolveInputs((prev) => prev.map((v, idx) => (idx === i ? e.currentTarget.value : v)))
                }
              />
            )}
          </Index>
          <button type="button" onClick={() => setResolveInputs((prev) => [...prev, ''])}>
            <Plus /> Add Steam Family account
          </button>
          {/* aria-disabled, not disabled: a disabled button drops the focus of the press that started it. */}
          <button type="submit" class="btn btn-primary" aria-disabled={resolving() ? 'true' : undefined}>
            {resolving() ? 'Looking up…' : 'Look up'}
          </button>
        </form>
        <Show when={resolveError()}>
          {(e) => (
            <p class="error">
              {e().text}
              <Show when={e().isPrivate}>
                {' '}
                <SteamPrivacyLink />
              </Show>
            </p>
          )}
        </Show>

        {/* A Steam Family (several accounts unioned into one slot) — one row per member, since
            the header above can only speak for the slot as a whole. */}
        <Show when={players().length > 1}>
          <ul class="account-members">
            <For each={players()}>
              {(p) => (
                <li>
                  <Show when={p.avatarUrl}>
                    {(url) => (
                      <span class="account-avatar-wrap">
                        <img class="account-avatar" src={url()} alt="" width="28" height="28" />
                      </span>
                    )}
                  </Show>
                  <Show when={p.profileUrl} fallback={<span class="account-name">{p.name}</span>}>
                    {(url) => (
                      <a
                        class="account-name account-profile-link"
                        href={url()}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`Steam ID ${p.steamid}`}
                      >
                        {p.name} <span class="account-profile-arrow">↗</span>
                      </a>
                    )}
                  </Show>
                  <CopyButton
                    text={copyIdentifier(p)}
                    title={`Copy this account's Steam identifier (${copyIdentifier(p)})`}
                  />
                  <Show when={p.realName}>
                    <span class="account-realname">({p.realName})</span>
                  </Show>
                  <Show when={p.gameCount != null}>
                    <span class="account-count">{p.gameCount} games</span>
                  </Show>
                  <Show when={p.memberSince}>
                    <span class="account-count">Since {p.memberSince}</span>
                  </Show>
                  <Show when={p.countryCode}>
                    <span class="account-count">{countryFlag(p.countryCode)}</span>
                  </Show>
                  <Show when={p.isPrivate}>
                    <span
                      class="account-private"
                      title="This Steam profile isn't public — some data may be missing or empty"
                    >
                      <Lock /> Private
                    </span>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <AccountTiles
          myAccountId={myAccount()?.id ?? null}
          currentAccountId={currentAccount()?.id ?? null}
          onPick={pickAccount}
          emptyFocus={() => lookupField}
        />

        <Show when={currentAccount()}>
          {(account) => (
            <AccountFriends
              accountId={account().id}
              accountIdentifiers={accountIdentifiers(account())
                .map((m) => m.identifier)
                .join(',')}
              accountLabel={accountDisplayLabel(account())}
              myAccountId={myAccount()?.id ?? null}
              onExplore={pickAccount}
            />
          )}
        </Show>
      </section>

      <section class="home-explore">
        <h2>Explore</h2>
        <ul class="explore-cards">
          <For each={exploreCards()}>
            {(card) => (
              <li class="explore-card">
                <span class="explore-icon">
                  <card.icon />
                </span>
                <h3>
                  <A href={card.href}>{card.name}</A>
                </h3>
                <p>{card.description}</p>
                <Show when={card.views?.length}>
                  <ul class="explore-views" aria-label={`${card.name} views`}>
                    <For each={card.views}>
                      {(view) => (
                        <li>
                          <A href={view.href}>{view.name}</A>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </section>

      <section class="home-tree">
        <h2 ref={treeHeading} tabindex="-1">
          Your lists
        </h2>
        <div class="tree-actions">
          <button type="button" ref={newListBtn} onClick={() => setNameTarget({ kind: 'list' })}>
            <ListPlus /> New list
          </button>
          <button type="button" onClick={toggleCombine}>
            <Show when={combineOpen()} fallback={<Blend />}>
              <X />
            </Show>{' '}
            {combineOpen() ? 'Cancel combine' : 'New combined list'}
          </button>
          <button type="button" ref={newFolderBtn} onClick={() => setNameTarget({ kind: 'folder' })}>
            <FolderPlus /> New folder
          </button>
        </div>

        <Show when={combineOpen()}>
          <CombineForm submitLabel="Create combined list" onSubmit={handleCreateCombine} />
        </Show>
        <Show when={treeRows().length > 0 || newNameTarget()} fallback={<p>No lists yet — create one above.</p>}>
          <ul class="list-tree">
            <For each={treeRows()}>
              {(row) => (
                <li style={{ 'padding-left': `${row.depth * 24}px` }}>
                  <TreeIcon row={row} />
                  <Show
                    when={nameTarget()?.id === row.item.id}
                    fallback={
                      <span class="tree-text">
                        {row.type === 'folder' ? (
                          <span class="tree-name">{rowName(row)}</span>
                        ) : (
                          <A class="tree-name" href={`/lists/${row.item.id}`}>
                            <span classList={{ 'derived-name': !row.item.name }}>{rowName(row)}</span>
                          </A>
                        )}
                        <span class="tree-summary">{rowSummary(row)}</span>
                      </span>
                    }
                  >
                    <NameField
                      target={{ kind: row.type, id: row.item.id }}
                      initial={row.item.name ?? ''}
                      placeholder={row.type === 'list' ? rowName(row) : undefined}
                    />
                  </Show>
                  <TreeMenu row={row} />
                </li>
              )}
            </For>
            <Show when={newNameTarget()}>
              {(target) => (
                <li>
                  <Show when={target().kind === 'folder'} fallback={<ListIcon class="tree-icon" />}>
                    <FolderIcon class="tree-icon" />
                  </Show>
                  <NameField target={target()} initial="" />
                </li>
              )}
            </Show>
          </ul>
        </Show>
      </section>
    </div>
  );
}
