// Human-readable labels for the list model (listsStore.ts/types.ts) — what a combine operation
// is called, and how a single source (a ListRef) reads on screen. Kept out of both listsStore.ts
// (pure CRUD, no presentation) and any one route: a dynamic list's op and sources are named in
// the hero card (ListRoute.tsx), in Home's own combine form and in its tree, and those wordings
// drifting apart is exactly the kind of thing nobody notices until two screens disagree about
// the same list.
//
// Pure, like listsStore.ts/combine.ts/listResolve.ts: everything that needs a store to answer
// (an account's display label, a user list's name) is injected as a `ListNaming`, so this module
// and its tests never touch localStorage. createDefaultNaming() at the bottom wires the real
// stores in for routes to use — the same seam listResolve.ts's own createDefaultFetchers() is.
import type { CombineOp, GameList, ListRef } from './types.ts';
import { getRecentAccounts, getMyAccount, getEffectiveCurrentAccount, accountDisplayLabel } from './accountsStore.ts';
import { getList, listDeps } from './listsStore.ts';
import { membersFromAccountId } from './accountData.ts';
import { getBundleSnapshot } from './bundleSnapshots.ts';
import { creatorListPath, creatorTitle } from './creatorData.ts';
import { GAME_PASS_PATH, GAME_PASS_TITLE } from './gamePassData.ts';
import { OP_LABELS } from './combine.ts';

// What each op actually does, for a picker where the reader may be meeting them for the first
// time (Home's combine form appends this to combine.ts's OP_LABELS).
export const OP_DESCRIPTIONS: Record<CombineOp, string> = {
  union: 'games in any source',
  intersect: 'games in every source',
  subtract: 'the first source minus the rest',
  'group-by-membership': 'one table per combination of sources',
};

// The infix symbol a formula joins its sources with; group-by-membership's rows are a union too.
export const OP_SYMBOLS: Record<CombineOp, string> = {
  union: '∪',
  intersect: '∩',
  subtract: '−', // U+2212 minus: the set-minus ∖ reads as | in italics
  'group-by-membership': '∪',
};

export function opLabel(op: CombineOp | undefined): string {
  return OP_LABELS[op ?? 'union'];
}

// The store-backed facts describing a ListRef, injected rather than imported (see the module
// comment). `identifiers` are what a `?u=` link needs to open that account — an accountId is a
// canonical, always-resolvable set of steam64 ids, unlike the vanity name it may have been typed
// as. A bundle has no client-side name at all without an ITAD fetch, so there's nothing to
// inject for it; it's named by id.
export interface ListNaming {
  account(accountId: string): { label: string; identifiers: string[] } | null;
  list(listId: string): { name: string; deleted: boolean; orphaned?: boolean } | null;
  // Optional: without it a bundle source reads as its id.
  bundle?(bundleId: string): { title: string } | null;
}

export interface RefDescription {
  label: string;
  // Where this source can be opened, when it has an address of its own — null for one that
  // doesn't, or whose target is gone.
  href: string | null;
  // Why this source can't be shown as an ordinary one: a hard-deleted list, a soft-deleted one
  // kept alive only by this formula, a ref saved without its id. The label still says whatever it
  // can — a formula with a named hole in it explains far more than one silently missing a term
  // (and the list itself keeps resolving: a dangling source contributes an empty set, per
  // listResolve.ts). An *account* has no such state under createDefaultNaming below — an
  // accountId is always openable, being the member ids themselves — but an injected naming can
  // still report one.
  problem?: string;
  // The source contributes nothing (a list that's gone, a ref with no id) — as opposed to a
  // problem worth reporting that still resolves (a soft-deleted list, a forgotten account).
  countsAsEmpty?: boolean;
}

export function describeListRef(ref: ListRef, naming: ListNaming): RefDescription {
  switch (ref.kind) {
    case 'account-owned':
    case 'account-wishlist': {
      const which = ref.kind === 'account-owned' ? 'Owned' : 'Wishlist';
      if (!ref.accountId)
        return {
          label: `Unknown account — ${which}`,
          href: null,
          problem: 'this source names no account',
          countsAsEmpty: true,
        };
      const account = naming.account(ref.accountId);
      if (!account) {
        return {
          label: `${ref.accountId} — ${which}`,
          href: null,
          problem: 'this account is no longer one of your accounts',
        };
      }
      // `?u=`: the source pins an explicit accountId (never "whichever account is current" — see
      // docs/dev/lists-and-accounts.md), so its link has to open that same account.
      const path = ref.kind === 'account-owned' ? '/lists/owned' : '/lists/wishlist';
      return {
        label: `${account.label} — ${which}`,
        href: `${path}?u=${encodeURIComponent(account.identifiers.join(','))}`,
      };
    }
    case 'bundle':
      if (!ref.bundleId)
        return { label: 'Unknown bundle', href: null, problem: 'this source names no bundle', countsAsEmpty: true };
      // The title is the last-known one (bundleSnapshots.ts): ITAD is the only source for it, and
      // this is a synchronous labeling function.
      return {
        label: naming.bundle?.(ref.bundleId)?.title ?? `Bundle ${ref.bundleId}`,
        href: `/lists/bundle/${ref.bundleId}`,
      };
    case 'recent-games':
      return { label: 'Recently Looked Up', href: '/game' };
    case 'game-pass':
      return { label: GAME_PASS_TITLE, href: GAME_PASS_PATH };
    case 'developer':
    case 'publisher':
      if (!ref.name)
        return {
          label: `Unknown ${ref.kind}`,
          href: null,
          problem: `this source names no ${ref.kind}`,
          countsAsEmpty: true,
        };
      return { label: creatorTitle(ref.kind, ref.name), href: creatorListPath(ref.kind, ref.name) };
    case 'user': {
      if (!ref.listId)
        return { label: 'Unknown list', href: null, problem: 'this source names no list', countsAsEmpty: true };
      const list = naming.list(ref.listId);
      if (!list)
        return {
          label: 'A list that no longer exists',
          href: null,
          problem: 'this list was deleted',
          countsAsEmpty: true,
        };
      return {
        label: list.name,
        href: `/lists/${ref.listId}`,
        // Soft-deleted (listsStore.ts keeps a referenced list resolvable rather than dropping it,
        // so this formula still works) — worth saying, since it's hidden everywhere else.
        problem: list.orphaned
          ? 'IsThereAnyDeal no longer lists this bundle; these are its last-known games'
          : list.deleted
            ? 'this list is deleted, and kept only because this formula uses it'
            : undefined,
      };
    }
    default:
      return { label: 'Unknown source', href: null, problem: 'unrecognized source kind', countsAsEmpty: true };
  }
}

export function describeSources(list: GameList, naming: ListNaming): RefDescription[] {
  return listDeps(list).map((ref) => describeListRef(ref, naming));
}

// The whole formula as one plain string ("Alice — Owned ∩ Bob — Owned") — for a tooltip, a test,
// or anywhere the linked/annotated rendering ListRoute.tsx builds out of describeSources would be
// overkill. Null for a combine with no sources.
//
// Takes op/sources rather than a list, so Home's combine form can name a formula that isn't a
// saved list yet (its "Will be named…" preview).
export function formatCombine(op: CombineOp | undefined, sources: ListRef[], naming: ListNaming): string | null {
  const described = sources.map((ref) => describeListRef(ref, naming));
  if (!described.length) return null;
  const joined = described.map((s) => s.label).join(` ${OP_SYMBOLS[op ?? 'union']} `);
  return op === 'group-by-membership' ? `${joined} — grouped by membership` : joined;
}

// Null for a manual list (there's no formula) or a dynamic one with no sources saved.
export function formatFormula(list: GameList, naming: ListNaming): string | null {
  if (list.kind === 'ranked') return list.source ? `Ranking of ${describeListRef(list.source, naming).label}` : null;
  if (list.kind !== 'dynamic') return null;
  return formatCombine(list.op, list.sources ?? [], naming);
}

// What a list is called on screen: its own name when it has one, else its formula — an unnamed
// dynamic list is labeled by what it does ("Alice — Owned ∩ Bob — Owned"), recomputed on every
// read so the label follows a source edit or an account rename instead of freezing at creation
// time (see docs/dev/lists-and-accounts.md's Combine section).
//
// The last fallback catches a dynamic list with no sources saved, and a manual one with no name.
export function listDisplayName(list: GameList, naming: ListNaming): string {
  return list.name || formatFormula(list, naming) || 'Untitled list';
}

// The real stores behind ListNaming, for routes. Accounts are looked up across everything the app
// knows about (recents, `myAccount`, the account currently being explored) rather than recents
// alone: a formula can pin an account that was never added to recents — a `?u=` link's, or one
// soft-removed from recents while still referenced, which removeRecentAccount deliberately keeps
// (see accountsStore.ts).
//
// `depth` guards label *length*, not termination — a cyclic formula can't be saved in the first
// place (listsStore.ts's wouldCreateCycle). One level of nesting is spelled out in parens; deeper
// than that, an unnamed list is named by its kind rather than growing the label without end.
export function createDefaultNaming(depth = 0): ListNaming {
  return {
    account(accountId) {
      const known = [...getRecentAccounts({ includeRemoved: true }), getMyAccount(), getEffectiveCurrentAccount()];
      const match = known.find((a) => a?.id === accountId);
      if (match) return { label: accountDisplayLabel(match), identifiers: match.members };
      // Not on record any more, but an accountId is self-describing enough to still open: it *is*
      // the member steam64 ids. Named by id rather than reported as missing outright.
      const members = membersFromAccountId(accountId);
      return members.length ? { label: members.join(' + '), identifiers: members } : null;
    },
    list(listId) {
      const found = getList(listId);
      if (!found) return null;
      // An unnamed source list is described by its own formula, parenthesized: a formula reading
      // "Alice — Owned ∩ Bob — Owned − Demos" would otherwise be unparseable as one term.
      const name =
        found.name ||
        (depth < 1 ? `(${listDisplayName(found, createDefaultNaming(depth + 1))})` : 'Untitled combined list');
      return { name, deleted: found.deletedAt != null, orphaned: found.orphanOf != null };
    },
    bundle(bundleId) {
      const snapshot = getBundleSnapshot(bundleId);
      return snapshot ? { title: snapshot.title } : null;
    },
  };
}
