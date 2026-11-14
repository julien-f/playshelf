// Shared "share/persist/reset a @vates/data-table-solid view via prefs.js + a one-shot URL
// param" logic — extracted verbatim from library.js's and bundles.js's own near-identical
// copies (see docs/dev/game-table.md for the "share on demand, not
// live-synced" reasoning). Both pages call these the same way: a `table` instance and the
// ViewStore that page's view is kept in.
import { createEffect, createRoot, createSignal, untrack } from 'solid-js';
import type { TableViewState, ViewStateApi } from '@vates/data-table-solid';
import { getPref, setPref } from './prefs.ts';
import { diffViewLabels, stripTransientViewFields } from './tableViewSync.ts';
import { urlWithParams } from './urlState.ts';
import { copyWithFeedback } from './clipboard.ts';
import { storageSet } from './safeStorage.ts';

// Where a table's own view is kept: a prefs.ts key, or a user list's own tableView.
export interface ViewStore {
  load(): TableViewState;
  save(view: TableViewState): void;
}

export function prefViewStore(key: string): ViewStore {
  return { load: () => getPref<TableViewState>(key, {}), save: (view) => setPref(key, view) };
}

// The URL param a "🔗 Share layout" link carries the view in — one for every table, since a route
// only ever has one on screen (see urlState.ts's own comment on `tv`).
export const VIEW_PARAM = 'tv';

// The incoming view param, parsed and stripped from the URL (malformed too); null when absent or malformed.
function takeSharedView(): TableViewState | null {
  const params = new URLSearchParams(location.search);
  const raw = params.get(VIEW_PARAM);
  if (!raw) return null;
  params.delete(VIEW_PARAM);
  history.replaceState(null, '', urlWithParams(params));
  let view: unknown;
  try {
    view = JSON.parse(raw);
  } catch {
    return null; // malformed — fall back to the stored default
  }
  // A wrongly typed field inside is data-table's to ignore; the rest of the view still applies.
  return isRecord(view) ? (view as TableViewState) : null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
// Snapshots the table's current view into VIEW_PARAM and copies the resulting link to the
// clipboard — deliberately does NOT write it to the page's own address bar (no
// `history.replaceState`): a param left sitting in the visible URL goes stale the moment the
// user makes one more change to the table, silently showing a snapshot that no longer matches
// what's on screen. The layout draft (layoutDraft's bind) already captures live state on
// every change; this link is only for handing the *current* view to someone else.
// `extraParams` are added only where the URL doesn't already set them; `dropParams` mean nothing to the recipient.
export function shareTableView(
  table: ViewStateApi,
  btn: HTMLElement,
  extraParams: Record<string, string> = {},
  dropParams: string[] = [],
): void {
  const params = new URLSearchParams(location.search);
  for (const key of dropParams) params.delete(key);
  for (const [key, value] of Object.entries(extraParams)) if (!params.has(key)) params.set(key, value);
  const view = table.getViewState();
  // An unchanged view is the defaults: sending `{}` would only show the recipient a "shared layout" banner.
  if (Object.keys(view).length) params.set(VIEW_PARAM, JSON.stringify(view));
  else params.delete(VIEW_PARAM);
  const url = `${location.origin}${urlWithParams(params)}`;
  copyWithFeedback(btn, url);
}

// A blank view state resolves to the table's own `initialViewState` (default sort included), not to nothing.
export function resetTableView(table: ViewStateApi, store: ViewStore): void {
  table.setViewState({});
  store.save({});
}

// ── Layout drafts ─────────────────────────────────────────────────────────────────────────────

const DRAFT_PREFIX = 'steam.isonoe.net:layout-draft:';

function readDraft(id: string): TableViewState | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_PREFIX + id);
    return raw ? (JSON.parse(raw) as TableViewState) : null;
  } catch {
    return null; // unavailable storage, or a corrupted value
  }
}

function writeDraft(id: string, view: TableViewState | null): void {
  storageSet('sessionStorage', DRAFT_PREFIX + id, view && JSON.stringify(view)); // refused: the draft lives on screen
}

// What a route manages itself, kept out of the layout: `cols` entirely (a similarity sort), `ranges`
// only as range filters (a bundle's pressed tier, which means nothing on another bundle).
interface TemporaryKeys {
  cols?: readonly string[];
  ranges?: readonly string[];
}

const withoutRanges = (view: TableViewState, ranges: readonly string[]): TableViewState =>
  view.rangeFilters && ranges.length
    ? {
        ...view,
        rangeFilters: Object.fromEntries(Object.entries(view.rangeFilters).filter(([k]) => !ranges.includes(k))),
      }
    : view;

// What Save stores and the banner compares: no page, search or temporary keys, and a field back to
// the table's default dropped, as getViewState drops it.
function layoutOf(view: TableViewState, temporary: TemporaryKeys, defaults: TableViewState): TableViewState {
  const { cols = [], ranges = [] } = temporary;
  const v = stripTransientViewFields(view);
  if (!cols.length && !ranges.length) return v;
  const keep = (key: string) => !cols.includes(key);
  const keepRange = (key: string) => keep(key) && !ranges.includes(key);
  const fields: Partial<TableViewState> = {
    sorts: v.sorts?.filter((e) => keep(e.key)),
    visibleCols: v.visibleCols?.filter(keep),
    columnOrder: v.columnOrder?.filter(keep),
    rangeFilters: v.rangeFilters && Object.fromEntries(Object.entries(v.rangeFilters).filter(([k]) => keepRange(k))),
  };
  for (const [field, value] of Object.entries(fields) as [keyof TableViewState, unknown][]) {
    if (value === undefined) continue;
    // Emptied by the filter: it held only temporary columns, over the default.
    if (Array.isArray(value) && !value.length && (v[field] as unknown[]).length) {
      delete v[field];
      continue;
    }
    const empty = Array.isArray(value) ? [] : {};
    const isDefault = JSON.stringify(value) === JSON.stringify(defaults[field] ?? empty);
    if (isDefault) delete v[field];
    else (v as Record<string, unknown>)[field] = value;
  }
  return v;
}

export interface LayoutDraft {
  // Applies the stored layout (the baseline), then a shared link's layout or this tab's draft over
  // it; viewingShared when a shared one applied (which pauses persistence).
  restore(): void;
  // Writes every future view change to `store`, the only ongoing side effect table interaction has (the URL stays
  // untouched until explicitly shared); paused while viewingShared. Returns the dispose function.
  bind(): () => void;
  // A 🔗 Share layout link's layout is on screen, not saved (SharedViewBanner); sharedEdited: it now differs from the
  // link's (page/search aside). keepShared saves it, discardShared applies the draft or stored layout instead.
  viewingShared(): boolean;
  sharedEdited(): boolean;
  keepShared(): void;
  discardShared(): void;
  // What bind and resetTableView write through: every change goes to the draft.
  store: ViewStore;
  // The labels of what differs from the stored layout (diffViewLabels'), empty when nothing.
  changes(): string[];
  save(): void;
  discard(): void;
}

// A change stays a draft in this tab (sessionStorage, under `id`) until Save writes `stored` or Discard drops
// it; the baseline is `stored` as this table applies it, so an untouched table reads as unchanged.
export function layoutDraft(
  table: ViewStateApi,
  id: string,
  stored: ViewStore,
  temporary: TemporaryKeys = {},
  defaults: TableViewState = {},
): LayoutDraft {
  const [baseline, setBaseline] = createSignal<TableViewState>({});
  const layout = (view: TableViewState) => layoutOf(view, temporary, defaults);
  // A temporary range saved before it was one (a pressed tier) isn't restored.
  const storedLayout = () => withoutRanges(stored.load(), temporary.ranges ?? []);
  const current = () => layout(table.getViewState());
  const capture = () => setBaseline(untrack(current));
  const [viewingShared, setViewingShared] = createSignal(false);
  const [sharedEdited, setSharedEdited] = createSignal(false);
  const store: ViewStore = {
    load: () => readDraft(id) ?? storedLayout(),
    save: (view) => {
      const { page, searchQuery } = view;
      const changed = diffViewLabels(untrack(baseline), layout(view)).length > 0;
      writeDraft(id, changed || page || searchQuery ? withoutRanges(view, temporary.ranges ?? []) : null);
    },
  };
  const draft: LayoutDraft = {
    restore() {
      table.setViewState(storedLayout());
      capture();
      const shared = takeSharedView();
      const draft = readDraft(id);
      const applied = shared ?? draft;
      if (applied) table.setViewState(applied);
      setViewingShared(shared != null);
    },
    // An effect re-reading getViewState() (tracking every signal it touches), in its own root since a route can bind
    // it from an async load.
    bind: () =>
      createRoot((dispose) => {
        let pausedView: string | undefined;
        createEffect(() => {
          const view = table.getViewState();
          if (!viewingShared()) {
            pausedView = undefined;
            untrack(() => store.save(view)); // a store's save reads its own pref back
            return;
          }
          const shared = JSON.stringify(stripTransientViewFields(view));
          if (pausedView === undefined) pausedView = shared;
          else setSharedEdited(shared !== pausedView);
        });
        return dispose;
      }),
    viewingShared,
    sharedEdited,
    keepShared() {
      setViewingShared(false);
      draft.save();
    },
    discardShared() {
      table.setViewState(store.load());
      setViewingShared(false);
    },
    store,
    changes: () => diffViewLabels(baseline(), current()),
    save() {
      const view = untrack(() => table.getViewState());
      stored.save(layout(view));
      capture();
      store.save(view);
    },
    discard() {
      writeDraft(id, null);
      const { page, searchQuery } = untrack(() => table.getViewState());
      table.setViewState({ ...storedLayout(), ...(page && { page }), ...(searchQuery && { searchQuery }) });
      capture();
    },
  };
  return draft;
}
