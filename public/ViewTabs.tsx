// Owned/Wishlist's saved views (listViews.ts) as tabs of one list, with the active one's rename/delete.
import { For, Show, createEffect, onCleanup, onMount, type JSX } from 'solid-js';
import { useLocation, useNavigate } from '@solidjs/router';
import Ellipsis from 'lucide-solid/icons/ellipsis';
import Plus from 'lucide-solid/icons/plus';
import type { TableViewState } from '@vates/data-table-solid';
import {
  createFromTemplate,
  createListView,
  deleteListView,
  getListViews,
  renameListView,
  suggestedTemplates,
  type ViewKind,
} from './listViews.ts';
import { bindNavPopover } from './navPopover.ts';
import { urlWithParams } from './urlState.ts';
import { VIEW_PARAM } from './tableViewPrefs.ts';
import type { SavedView } from './types.ts';

// This page with `view` set (or cleared, for the whole list); a shared layout isn't carried over.
export function viewHref(location: { pathname: string; search: string }, id: string | null): string {
  const params = new URLSearchParams(location.search);
  params.delete(VIEW_PARAM);
  if (id) params.set('view', id);
  else params.delete('view');
  return urlWithParams(params, location.pathname);
}

export function ViewTabs(props: { kind: ViewKind; activeId: string | null }): JSX.Element {
  const location = useLocation();
  const href = (id: string | null) => viewHref(location, id);
  const views = () => getListViews(props.kind);
  let allTab!: HTMLAnchorElement;
  let nav: HTMLElement | undefined;
  // The row scrolls on a phone: keep the active tab (and its ⋯) in it, without scrolling the page.
  createEffect(() => {
    const active = props.activeId && views().length ? nav?.querySelector<HTMLElement>('[aria-current="page"]') : null;
    if (!nav || !active) return;
    const end = active.offsetLeft + active.offsetWidth + 40 - nav.clientWidth;
    nav.scrollLeft = Math.min(Math.max(nav.scrollLeft, end), active.offsetLeft);
  });
  return (
    <Show when={views().length}>
      <nav ref={nav} class="view-tabs" aria-label="Views">
        <a ref={allTab} href={href(null)} class="view-tab" aria-current={props.activeId ? undefined : 'page'}>
          All games
        </a>
        {/* By id: every write to the pref reads back new objects, which would remount the ⋯ that has focus. */}
        <For each={views().map((v) => v.id)}>
          {(id) => (
            <Show when={views().find((v) => v.id === id)}>
              {(view) => (
                <>
                  <a href={href(id)} class="view-tab" aria-current={id === props.activeId ? 'page' : undefined}>
                    {view().name}
                  </a>
                  <Show when={id === props.activeId}>
                    <ManageView
                      kind={props.kind}
                      view={view()}
                      // The last view gone takes the tabs with it.
                      onDeleted={() => (allTab.isConnected ? allTab : document.getElementById(NEW_VIEW_ID))?.focus()}
                    />
                  </Show>
                </>
              )}
            </Show>
          )}
        </For>
      </nav>
    </Show>
  );
}

function ManageView(props: { kind: ViewKind; view: SavedView; onDeleted: () => void }): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  let trigger!: HTMLButtonElement;
  let panel!: HTMLDivElement;
  let name!: HTMLInputElement;
  onMount(() => onCleanup(bindNavPopover(trigger, panel)));
  function rename(): void {
    const value = name.value.trim();
    if (value && value !== props.view.name) renameListView(props.kind, props.view.id, value);
    else name.value = props.view.name;
  }
  function remove(): void {
    if (!window.confirm(`Delete the view "${props.view.name}"? The list itself stays.`)) return;
    panel.hidePopover();
    deleteListView(props.kind, props.view.id);
    navigate(viewHref(location, null));
    queueMicrotask(props.onDeleted);
  }
  return (
    <>
      <button
        ref={trigger}
        type="button"
        class="view-tab-more"
        popovertarget="view-manage-panel"
        aria-label={`Manage ${props.view.name}`}
        aria-haspopup="true"
        title="Rename or delete this view"
      >
        <Ellipsis />
      </button>
      <div ref={panel} id="view-manage-panel" class="site-nav-popover-panel view-menu-panel" popover>
        <form
          class="view-menu-form"
          onSubmit={(e) => {
            e.preventDefault();
            rename();
            panel.hidePopover();
            trigger.focus();
          }}
        >
          <label class="view-menu-label" for="view-manage-name">
            View name
          </label>
          <input ref={name} id="view-manage-name" type="text" value={props.view.name} onChange={rename} />
        </form>
        <button type="button" class="tree-menu-item" onClick={remove}>
          Delete view
        </button>
      </div>
    </>
  );
}

const NEW_VIEW_ID = 'new-view-trigger';

// The hero's New view menu, beside Rank this list: the suggested views not created yet, or the table as it is now.
export function NewViewMenu(props: {
  kind: ViewKind;
  pricesShown: boolean;
  currentView: () => TableViewState;
  onCreated: (view: SavedView) => void;
}): JSX.Element {
  let trigger!: HTMLButtonElement;
  let panel!: HTMLDivElement;
  let name!: HTMLInputElement;
  onMount(() => onCleanup(bindNavPopover(trigger, panel)));
  const suggested = () => suggestedTemplates(props.kind, props.pricesShown);
  function opened(view: SavedView): void {
    panel.hidePopover();
    props.onCreated(view);
    trigger.focus();
  }
  return (
    <>
      <button
        ref={trigger}
        id={NEW_VIEW_ID}
        type="button"
        class="btn"
        popovertarget="new-view-panel"
        aria-label="New view"
        aria-haspopup="true"
        title="Save a named view of this list"
      >
        <Plus />
        <span class="new-view-label"> New view</span>
      </button>
      <div ref={panel} id="new-view-panel" class="site-nav-popover-panel view-menu-panel" popover>
        <Show when={suggested().length}>
          <h2 class="rank-menu-heading">Suggested</h2>
          <For each={suggested()}>
            {(template) => (
              <button type="button" class="tree-menu-item" onClick={() => opened(createFromTemplate(template))}>
                {template.name}
              </button>
            )}
          </For>
        </Show>
        <form
          class="view-menu-form"
          onSubmit={(e) => {
            e.preventDefault();
            const value = name.value.trim();
            if (!value) return name.focus();
            name.value = '';
            opened(createListView(props.kind, value, props.currentView()));
          }}
        >
          <label class="view-menu-label" for="new-view-name">
            Save the table as it is now
          </label>
          <input ref={name} id="new-view-name" type="text" placeholder="View name" />
          <button type="submit" class="btn btn-primary">
            <Plus /> Save as view
          </button>
        </form>
      </div>
    </>
  );
}
