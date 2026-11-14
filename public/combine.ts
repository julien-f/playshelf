// Pure combine engine — union/intersect/subtract/group-by-membership over resolved appid sets
// (see docs/dev/lists-and-accounts.md's Combine section). No I/O, no ListRef resolution here —
// that's listResolve.ts's job; this module only ever sees plain Set<number>/LabeledSet inputs
// so it's trivially testable and reusable for both a live combine preview and a saved dynamic
// list's resolve.
import type { CombineOp } from './types.ts';

// Short form — a chip/label on its own, where surrounding context already says it's a combine.
export const OP_LABELS: Record<CombineOp, string> = {
  union: 'Union',
  intersect: 'Intersect',
  subtract: 'Subtract',
  'group-by-membership': 'Grouped by membership',
};

// Own keys only: `in` would let `?op=constructor` through.
export function isCombineOp(raw: string): raw is CombineOp {
  return Object.hasOwn(OP_LABELS, raw);
}

export interface LabeledSet {
  key: string; // an identifier for the source (e.g. a ListRef's own key/label) — only used by
  // group-by-membership, where a game's group is which combination of keys it's in
  appids: Set<number>;
}

export interface MembershipGroup {
  keys: string[]; // which source keys this group's games belong to, in source order
  appids: number[];
}

export function union(sets: Set<number>[]): Set<number> {
  const result = new Set<number>();
  for (const s of sets) for (const id of s) result.add(id);
  return result;
}

export function intersect(sets: Set<number>[]): Set<number> {
  if (sets.length === 0) return new Set();
  let result = sets[0];
  for (let i = 1; i < sets.length; i++) {
    const next = sets[i];
    const filtered = new Set<number>();
    for (const id of result) if (next.has(id)) filtered.add(id);
    result = filtered;
  }
  return new Set(result);
}

// First set minus every other set.
export function subtract(sets: Set<number>[]): Set<number> {
  if (sets.length === 0) return new Set();
  const [first, ...rest] = sets;
  const result = new Set(first);
  for (const s of rest) for (const id of s) result.delete(id);
  return result;
}

// Groups games by which exact combination of sources they belong to — generalizes the old
// Comparison page's "group by exact owner set" table (see docs/dev/architecture.md's Request flow section):
// an N-way combine of account-Owned lists in this mode reproduces it. Groups are ordered most-
// sources-first ("most owners to fewest"), matching that page's own group ordering.
export function groupByMembership(sources: LabeledSet[]): MembershipGroup[] {
  const membership = new Map<number, string[]>(); // appid -> keys it belongs to, in source order
  for (const { key, appids } of sources) {
    for (const id of appids) {
      const keys = membership.get(id);
      if (keys) keys.push(key);
      else membership.set(id, [key]);
    }
  }

  const groups = new Map<string, MembershipGroup>();
  for (const [appid, keys] of membership) {
    const groupKey = keys.join('\0');
    let group = groups.get(groupKey);
    if (!group) {
      group = { keys, appids: [] };
      groups.set(groupKey, group);
    }
    group.appids.push(appid);
  }
  return [...groups.values()].sort((a, b) => b.keys.length - a.keys.length);
}

export type CombineResult = Set<number> | MembershipGroup[];

// One dispatch entry point for listResolve.ts — always takes LabeledSet[] regardless of op
// (union/intersect/subtract just discard the keys) so a caller doesn't need to branch on shape
// before calling in.
export function combine(op: CombineOp, sources: LabeledSet[]): CombineResult {
  const sets = sources.map((s) => s.appids);
  switch (op) {
    case 'union':
      return union(sets);
    case 'intersect':
      return intersect(sets);
    case 'subtract':
      return subtract(sets);
    case 'group-by-membership':
      return groupByMembership(sources);
  }
}
