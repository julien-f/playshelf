// The "Owned by" / "In" column a group-by-membership list is grouped by: one table for every
// group rather than one per group, so sort, filters and columns are set once and saved like any
// other view. Groups keep combine.ts's order (most sources first) through `compare`, and each
// header says who's in and who's missing. See docs/dev/game-table.md.
import type { ColumnDef, SortEntry } from '@vates/data-table-solid';
import type { MembershipGroup } from './combine.ts';
import type { Game } from './types.ts';

export const MEMBERSHIP_KEY = 'membership';

// A group's key on its rows (Game.membership).
export function membershipKey(group: MembershipGroup): string {
  return group.keys.join(' ');
}

// `sourceKeys`: every source in formula order; `names`: each source key's on-screen label. Read
// after the column's own label in a group header ("Owned by: All 3").
export function membershipLabel(keys: string[], sourceKeys: string[], names: Map<string, string>): string {
  const name = (key: string) => names.get(key) ?? key;
  if (keys.length === sourceKeys.length) return sourceKeys.length === 2 ? 'Both' : `All ${sourceKeys.length}`;
  if (keys.length === 1) return `Only ${name(keys[0])}`;
  const missing = sourceKeys.filter((key) => !keys.includes(key));
  return `${keys.map(name).join(' + ')} — not ${missing.map(name).join(', ')}`;
}

export function membershipColumn(
  groups: MembershipGroup[],
  sourceKeys: string[],
  names: Map<string, string>,
  players: boolean,
): ColumnDef<Game> {
  const rank = new Map(groups.map((group, i) => [membershipKey(group), i]));
  const labels = new Map(groups.map((group) => [membershipKey(group), membershipLabel(group.keys, sourceKeys, names)]));
  return {
    key: MEMBERSHIP_KEY,
    label: players ? 'Owned by' : 'In',
    format: (value) => labels.get(String(value)) ?? String(value ?? ''),
    compare: (a, b) => (rank.get(String(a)) ?? Infinity) - (rank.get(String(b)) ?? Infinity),
    groupable: true,
  };
}

// A group-by-membership list is always grouped by it first, most sources first; any grouping or
// sort the viewer adds comes after. Applied over a restored view, which may come from the same
// kind's flat operations. The sort is what orders the groups (the table only adds one itself when
// grouping from its own toolbar).
export function withMembershipGrouping<T extends { groupBy?: string[]; sorts?: SortEntry[] }>(view: T): T {
  const groupBy = view.groupBy ?? [];
  const sorts = view.sorts ?? [];
  if (groupBy[0] === MEMBERSHIP_KEY && sorts[0]?.key === MEMBERSHIP_KEY && sorts[0].dir === 'asc') return view;
  return {
    ...view,
    groupBy: [MEMBERSHIP_KEY, ...groupBy.filter((key) => key !== MEMBERSHIP_KEY)],
    sorts: [{ key: MEMBERSHIP_KEY, dir: 'asc' }, ...sorts.filter((s) => s.key !== MEMBERSHIP_KEY)],
  };
}

// The reverse, for the same kinds' flat operations: a view saved while grouped would otherwise
// keep a sort (and chip) on a column that isn't there.
export function withoutMembershipGrouping<T extends { groupBy?: string[]; sorts?: SortEntry[] }>(view: T): T {
  const grouped = view.groupBy?.includes(MEMBERSHIP_KEY);
  const sorted = view.sorts?.some((s) => s.key === MEMBERSHIP_KEY);
  if (!grouped && !sorted) return view;
  return {
    ...view,
    ...(view.groupBy ? { groupBy: view.groupBy.filter((key) => key !== MEMBERSHIP_KEY) } : {}),
    ...(view.sorts ? { sorts: view.sorts.filter((s) => s.key !== MEMBERSHIP_KEY) } : {}),
  };
}
