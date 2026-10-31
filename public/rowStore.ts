// Shared appid-indexed row bookkeeping behind a route's table store — `rowIndex` (appid → array
// index into the route's own Solid store array) is the O(1) lookup `getRow`/`mutateRow` need,
// since a store array is otherwise only addressable by index.
//
// Every read and write of a row goes through here, and the store is the single source of truth
// for row data: `getRow` hands back the store's own row (a Solid store proxy, so whoever renders
// it re-renders per field, on its own), and `mutateRow` is the only way to change one. This
// replaced a shape where each route also kept a second, deliberately plain `panelRows` map — one
// shallow clone per row — purely because panel.tsx's own loaders mutated whatever `Game` object
// they were handed via plain `game.field = x` writes, which a store proxy rejects outright. Those
// loaders are `createResource`s now (see panelData.ts) and write to no row at all, so the panel
// takes the real store row, the two-copies-kept-in-sync bookkeeping is gone, and a field written
// here reaches the panel with no "please re-render" bump in between. See docs/dev/frontend.md's "Frontend
// reactivity" section.
import { produce } from 'solid-js/store';
import type { GameKey } from './gameKey.ts';

// The rows a key can name: a numeric appid only ever a Steam game's, when T also holds games outside Steam.
type RowOf<T, K extends GameKey> = Extract<T, { appid: K }>;

export interface RowStore<T> {
  // The store's own row for `appid`, or `undefined` if it isn't one of the currently loaded rows.
  // A store proxy: reading a field of it inside a tracked scope subscribes to that one field.
  // Handed out as `Readonly<T>` — a store row can only be written through `mutateRow` below
  // (Solid rejects a direct write outright, so an unguarded `row.field = x` would otherwise be a
  // runtime error at best and a silent no-op at worst).
  getRow<K extends GameKey>(appid: K): Readonly<RowOf<T, K>> | undefined;
  // Mutates the row at `appid` via `produce(fn)` and returns it — `undefined` (mutating nothing)
  // if `appid` isn't one of the currently loaded rows, e.g. a DLC/base-game link or a standalone
  // "look up any game" lookup, which was never added to this store at all. Callers that can be
  // handed such a game check for that and write to wherever it does live instead.
  mutateRow<K extends GameKey>(appid: K, fn: (draft: RowOf<T, K>) => void): Readonly<RowOf<T, K>> | undefined;
  // Clears the index back to empty — a fresh search/tab-switch/bundle-open with nothing loaded
  // (yet).
  reset(): void;
  // Rebuilds the index from a freshly-fetched row list, which must be the same list just handed
  // to the store itself.
  load(rows: readonly T[]): void;
}

export function createRowStore<T extends { appid: GameKey }>(
  // The route's own store array and its setter, as returned by `createStore<T[]>` — the array is
  // read for `getRow`/`mutateRow`'s return value, the setter is called exactly as each route used
  // to call it directly: `setRows(idx, produce(fn))`.
  store: readonly T[],
  setStore: (idx: number, updater: ReturnType<typeof produce<T>>) => void,
): RowStore<T> {
  // Private to this closure: it's replaced on every `reset()`/`load()`, so a caller holding it
  // would keep operating on a stale `Map`.
  let rowIndex = new Map<GameKey, number>();
  // The casts: the row indexed under `appid` has that appid, so it is one of the rows that key can name.
  return {
    getRow<K extends GameKey>(appid: K) {
      const idx = rowIndex.get(appid);
      return idx === undefined ? undefined : (store[idx] as RowOf<T, K>);
    },
    mutateRow<K extends GameKey>(appid: K, fn: (draft: RowOf<T, K>) => void) {
      const idx = rowIndex.get(appid);
      if (idx === undefined) return undefined;
      setStore(idx, produce(fn as (draft: T) => void));
      return store[idx] as RowOf<T, K>;
    },
    reset() {
      rowIndex = new Map();
    },
    load(rows) {
      // A duplicate appid isn't deduped here — that's each caller's own job (e.g. bundleRows.ts's
      // own `seenAppids`, which has the context to pick which duplicate to keep, such as the
      // cheapest tier), and a `Map` built from a list with a repeated key silently keeps only
      // the *last* occurrence anyway, so a caller that got this wrong would otherwise fail
      // silently: the earlier row's array slot is never reachable via `rowIndex` again, so
      // `mutateRow` can never clear whatever `loading`/placeholder state it started in — it just
      // sits in the store forever, filtered out of most callers' own "hide still-loading rows"
      // view with no error anywhere. This warns instead, so a violation is visible rather than
      // quietly masked twice (once by whatever bug produced the duplicate, once by this module
      // silently accepting it).
      const seen = new Set<GameKey>();
      const dupes = new Set<GameKey>();
      for (const r of rows) {
        if (seen.has(r.appid)) dupes.add(r.appid);
        else seen.add(r.appid);
      }
      if (dupes.size > 0) {
        console.warn(
          `[rowStore] load() received duplicate appid(s): ${[...dupes].join(', ')} — only each one's last occurrence will be reachable; dedupe before calling load().`,
        );
      }
      rowIndex = new Map(rows.map((r, i) => [r.appid, i]));
    },
  };
}
