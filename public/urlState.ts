// Canonical query-param order shared by every URL-writing function on both pages. Applying
// this before every pushState/replaceState means the same logical state always serializes to
// the same URL string regardless of the order its pieces happened to be set/mutated in —
// otherwise e.g. opening a game before vs. after adding a tag filter would leave `game` in a
// different position, making two visits to an identical state look like different history
// entries and cluttering the query string with no benefit.
//
// `tv` (table view — a JSON-encoded @vates/data-table-solid view snapshot) is one shared param
// name for every list kind (Owned/Wishlist/Bundle/Recent/a user list), not one per kind — unlike
// the old separate Library/Bundles pages, each `/lists/...` route only ever has one table on
// screen at a time, so there's never a moment where two of these could coexist in the same URL
// the way e.g. `game`/`shot` can. See tableViewPrefs.ts's own layoutDraft/shareTableView
// (VIEW_PARAM). Unlike most other params here, it's not
// written automatically on every table interaction — only by the table's own "🔗 Share layout" button.
const PARAM_ORDER = ['u', 'op', 'q', 'game', 'shot', 'tv'];

export function reorderUrlParams(params: URLSearchParams): URLSearchParams {
  const ordered = new URLSearchParams();
  for (const key of PARAM_ORDER) {
    for (const v of params.getAll(key)) ordered.append(key, v);
  }
  // Anything not in PARAM_ORDER (forward-compat/unknown params) keeps its relative order,
  // appended after every known param.
  for (const [key, value] of params) {
    if (!PARAM_ORDER.includes(key)) ordered.append(key, value);
  }
  return ordered;
}

// A `history.replaceState`-ready URL for `params`: `<path>?a=1` while anything is left, the bare
// path once nothing is. Every URL-writing function here goes through this rather than a plain
// `?${reorderUrlParams(params)}` template, which leaves a bare trailing `?` in the address bar
// the moment the last param is deleted (closing a game panel, consuming a one-shot `?tv=` link)
// — cosmetic in isolation, but it sticks around in whatever the user copies or bookmarks next,
// and it makes two visits to an identical state serialize differently, exactly what
// reorderUrlParams above exists to prevent.
export function urlWithParams(params: URLSearchParams, pathname: string = location.pathname): string {
  const qs = reorderUrlParams(params).toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

// `?game=<appid>` / `&shot=<idx>` — the panel/lightbox deep-link params every page with a side
// panel writes on open/close/step. Extracted once `app.tsx`/`library.tsx`/`bundles.tsx` turned
// out to each carry a near-identical hand-copy (bundles.tsx's own copies had drifted from the
// other two: they skipped `reorderUrlParams` entirely, so `?game=`/`?shot=`'s position in the
// URL could differ from the canonical order the rest of the app enforces). Always
// `history.replaceState`: stepping games or shots isn't its own back/forward step — the one
// entry per open overlay is overlayHistory.ts's.
// Each rewrite below keeps `history.state` — the router's own navigation state (RankRoute.tsx's
// `rankFocus`) would otherwise be dropped by opening a game or a screenshot.
export function setPanelParam(appid: number | string | null): void {
  const params = new URLSearchParams(location.search);
  // A close (appid == null) with neither param already present is a genuine no-op — bail out
  // before touching history at all, rather than always calling replaceState regardless. This
  // matters beyond just avoiding a pointless history entry: AppShell.tsx's shell-level
  // `initPanel({ onClose })` calls this unconditionally on every panel close, including on
  // ListRoute.tsx's 'recent' kind (/game/:appid), which never writes `game` as a query param at
  // all (its own reactive effect strips the appid from the *path* instead, see that file's own
  // comment) — without this check, this would still unconditionally rewrite the URL to
  // whatever `pathname` it read *before* that navigation had actually taken effect, racing that
  // effect's own `navigate()` call and putting the appid straight back (confirmed live: closing
  // the panel on /game/620 briefly produced /game/620 again instead of the intended bare /game;
  // back when this wrote a bare `?${...}` template rather than going through urlWithParams
  // above, it showed up as a pointless `/game/620?` too).
  if (appid == null && !params.has('game') && !params.has('shot')) return;
  params.delete('shot');
  if (appid == null) params.delete('game');
  else params.set('game', String(appid));
  history.replaceState(history.state, '', urlWithParams(params));
}

export function setLightboxParam(idx: number | string | null): void {
  const params = new URLSearchParams(location.search);
  if (idx == null) params.delete('shot');
  else params.set('shot', String(idx));
  history.replaceState(history.state, '', urlWithParams(params));
}

// The addresses Back returns to from the panel's and the lightbox's own history entries
// (overlayHistory.ts): the page with that overlay closed. Recently Looked Up names its game in the
// path (`/game/:appid`) rather than in `?game=`.
export function urlWithoutPanel(url: Location | URL = location): string {
  const params = new URLSearchParams(url.search);
  params.delete('game');
  params.delete('shot');
  return urlWithParams(params, url.pathname.replace(/^\/game\/\d+$/, '/game'));
}

export function urlWithoutShot(url: Location | URL = location): string {
  const params = new URLSearchParams(url.search);
  params.delete('shot');
  return urlWithParams(params, url.pathname);
}

// `/search`'s own live search box writes its term here as the user types (debounced by the
// caller), so the address stays in sync with what's on screen — same shape as setLightboxParam,
// no equivalent to setPanelParam's no-op guard since there's no racing navigation to worry about.
export function setSearchQueryParam(term: string): void {
  const params = new URLSearchParams(location.search);
  if (term) params.set('q', term);
  else params.delete('q');
  history.replaceState(history.state, '', urlWithParams(params));
}

export interface UrlState {
  slots: string[][];
  game: number | null;
}
// One `u=` value per slot, comma-joined identifiers within it (a Steam Family) — see the
// URL & sharing section in docs/dev/frontend.md. Shared by parseUrlState and parseAccountParam below so the
// two can never disagree about what a `u=` value means (whitespace handling, empty entries).
function parseSlots(params: URLSearchParams): string[][] {
  return params
    .getAll('u')
    .map((s) =>
      s
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    )
    .filter((slot) => slot.length > 0);
}

export function parseUrlState(search: string): UrlState {
  const params = new URLSearchParams(search);
  return {
    slots: parseSlots(params),
    game: Number(params.get('game')) || null,
  };
}

// ── `/lists/compare?u=…&u=…` — the comparison address ────────────────────────────────────────

// A comparison is spelled exactly the way the pre-redesign Comparison page spelled it: one `u=`
// per player slot, comma-joined identifiers within a slot for a Steam Family. That's not
// nostalgia — those links are out in the wild (the app is deployed), and this is the one shape
// they can keep working in. `parseUrlState`'s own `slots` is the reader; the functions here are
// the writer.
export const COMPARE_PATH = '/lists/compare';

// Grouping by which exact combination of players owns each game is what the old page did, and
// what a comparison means by default; the other ops are reachable from the same URL.
export const DEFAULT_COMPARE_OP = 'group-by-membership';

// Sorts members within each slot, then slots by their first member — so one comparison always
// serializes to one URL regardless of the order its players happened to be typed in, and two
// visits to "alice vs. bob" are one history entry rather than two. Ported from the old page,
// which normalized for exactly this reason (plus deduping its own recent searches).
export function normalizeSlots(slots: string[][]): string[][] {
  const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  return slots.map((slot) => [...slot].sort(cmp)).sort((a, b) => cmp(a[0], b[0]));
}

// `op` is this app's own addition, not part of the old convention — omitted for the default, so
// a URL from the old page and a URL this app writes for the same comparison are the same string.
// `keep`: a query string whose other params (a shared `tv`, an open `game`) carry over.
export function compareUrl(slots: string[][], op?: string, keep = ''): string {
  const params = new URLSearchParams(keep);
  params.delete('u');
  params.delete('op');
  for (const slot of normalizeSlots(slots)) params.append('u', slot.join(','));
  if (op && op !== DEFAULT_COMPARE_OP) params.set('op', op);
  return urlWithParams(params, COMPARE_PATH);
}

// ── `?u=` — the account-override param ───────────────────────────────────────────────────────

// The raw `u=` values exactly as they sit in a URL, for forwarding across an internal
// navigation (see withAccountParam below). Kept separate from parseAccountParam's resolved
// view: forwarding must pass the identifiers through untouched (they're what the *user* shared),
// not a re-serialized version of whatever this app made of them.
export function accountParamValues(search: string): string[] {
  return new URLSearchParams(search).getAll('u');
}

export interface AccountParam {
  // The identifiers to resolve as the account being explored — one slot's worth (a plain
  // account, or several comma-joined identifiers for a Steam Family).
  identifiers: string[];
}

// **One slot only.** Several slots is a comparison ("alice vs. bob"), not an account to explore
// — `/lists/compare` is its address and `parseUrlState`'s `slots` is how that route reads it.
// Honoring the first slot here as well would have every comparison quietly declare a current
// account on the side, which is what the nav chip would then claim you were browsing.
export function parseAccountParam(search: string): AccountParam {
  const slots = parseSlots(new URLSearchParams(search));
  return { identifiers: slots.length === 1 ? slots[0] : [] };
}

// Carries whatever `u=` the current URL holds onto `path`, so the account being explored via a
// shared link survives clicking around the app instead of evaporating on the first navigation
// (the stored `currentAccount` is sticky by nature; an override has to be made sticky by hand).
// `path` may carry its own query (`/lists/owned?game=440`) — its params win over the ones
// carried over, and the result goes through reorderUrlParams like every other URL this app
// writes. Returns `path` untouched when there's no `u=` to carry, so every call site can use
// this unconditionally rather than branching on whether an override happens to be active.
export function withAccountParam(path: string, search: string = location.search): string {
  const values = accountParamValues(search);
  // Nothing to forward, or a comparison's several slots — which is not an account override at
  // all (see parseAccountParam), so carrying it onto an unrelated route would be noise.
  if (values.length !== 1) return path;
  const [pathname, ownQuery] = path.split('?');
  const params = new URLSearchParams(ownQuery ?? '');
  if (!params.has('u')) values.forEach((v) => params.append('u', v));
  return `${pathname}?${reorderUrlParams(params)}`;
}

// The current URL with `u=` stripped back out — what an explicit account pick navigates to,
// since the override the param carried is redundant once the user has chosen (see
// accountsStore.ts's `?u=` section and docs/dev/lists-and-accounts.md).
//
// Returns a URL for the *caller* to navigate to (replacing, never pushing — consuming the param
// isn't its own back/forward-navigable step) rather than calling history.replaceState itself
// like setPanelParam above does. That's deliberate: a raw replaceState is invisible to
// @solidjs/router's own location signal, so every href built with withAccountParam would keep
// showing the stripped param until something unrelated re-rendered it (confirmed live — Home's
// Owned/Wishlist links stayed pointed at the old `?u=` after adopting the account). Going
// through the router's navigate() instead updates that signal, and every such href with it.
export function urlWithoutAccountParam(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete('u');
  return urlWithParams(params, pathname);
}
