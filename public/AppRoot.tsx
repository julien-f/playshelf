// SPA entry point — mounts @solidjs/router's <Router> (with AppShell as its persistent `root`,
// see AppShell.tsx) into #app, replacing the four separate HTML entries' per-page bootstrap
// (see docs/dev/frontend.md).
//
// Route order matters: /lists/owned, /lists/wishlist, /lists/compare, /lists/shared and
// /lists/bundle/:bundleId are registered before the generic /lists/:listId — @solidjs/router
// ranks routes by segment specificity (a
// static segment always outranks a dynamic `:param` at the same position) regardless of
// declaration order, so this isn't strictly load-bearing the way a first-match-wins router would
// need it to be, but the explicit ordering documents the intent and costs nothing to keep.
//
// /game/:appid? (note the optional param) is the "Recently Looked Up" system list's own
// address, not a separate standalone-lookup page — GameRoute.tsx (which used to back it, no
// table/nav beside the panel at all) is gone; ListRoute renders it as kind 'recent' the same way
// it renders /lists/owned etc., just with `params.appid` acting as an initial focus rather than
// nothing. `/game` bare (no id) is the plain "browse recents" entry point Home links to.
import { lazy } from 'solid-js';
import { render } from 'solid-js/web';
import { Router, Route } from '@solidjs/router';
import { AppShell } from './AppShell.tsx';
import HomeRoute from './HomeRoute.tsx';
import RankRoute from './RankRoute.tsx';
import AboutRoute from './AboutRoute.tsx';
import NotFoundRoute from './NotFoundRoute.tsx';

// The table routes carry the data-table library and the column definitions, about half the app:
// loaded on first use, so Home and About don't wait for them.
const ListRoute = lazy(() => import('./ListRoute.tsx'));
const BundlesBrowseRoute = lazy(() => import('./BundlesBrowseRoute.tsx'));
const SearchRoute = lazy(() => import('./SearchRoute.tsx'));

render(
  () => (
    <Router root={AppShell}>
      <Route path="/" component={HomeRoute} />
      <Route path="/lists/owned" component={ListRoute} info={{ kind: 'owned' }} />
      <Route path="/lists/wishlist" component={ListRoute} info={{ kind: 'wishlist' }} />
      <Route path="/lists/compare" component={ListRoute} info={{ kind: 'compare' }} />
      <Route path="/lists/shared" component={ListRoute} info={{ kind: 'shared' }} />
      <Route path="/lists/developer" component={ListRoute} info={{ kind: 'creator', role: 'developer' }} />
      <Route path="/lists/publisher" component={ListRoute} info={{ kind: 'creator', role: 'publisher' }} />
      <Route path="/lists/game-pass" component={ListRoute} info={{ kind: 'game-pass' }} />
      <Route path="/lists/bundle/:bundleId" component={ListRoute} info={{ kind: 'bundle' }} />
      <Route path="/lists/:listId" component={ListRoute} info={{ kind: 'user' }} />
      <Route path="/lists/:listId/rank" component={RankRoute} />
      <Route path="/bundles" component={BundlesBrowseRoute} />
      <Route path="/search" component={SearchRoute} />
      <Route path="/game/:appid?" component={ListRoute} info={{ kind: 'recent' }} />
      <Route path="/about" component={AboutRoute} />
      <Route path="*" component={NotFoundRoute} />
    </Router>
  ),
  document.getElementById('app')!,
);
