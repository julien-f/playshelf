export type ListKind =
  'owned' | 'wishlist' | 'bundle' | 'recent' | 'user' | 'compare' | 'shared' | 'creator' | 'game-pass';

// Each kind's own layout when it has no saved view or list of its own: its pref key, and what Save calls it.
export const KIND_LAYOUTS: Record<ListKind, { prefKey: string; name: string }> = {
  owned: { prefKey: 'ownedListView', name: 'Owned' },
  wishlist: { prefKey: 'wishlistListView', name: 'Wishlist' },
  bundle: { prefKey: 'bundleListView', name: 'bundle' },
  recent: { prefKey: 'recentListView', name: 'Recently Looked Up' },
  // One for every comparison and every shared link: neither has a stored list to hang a view on (a
  // comparison's draft is per comparison, storedLayout; a shared link's own view is what Share layout is for).
  compare: { prefKey: 'compareListView', name: 'comparison' },
  shared: { prefKey: 'sharedListView', name: 'shared list' },
  creator: { prefKey: 'creatorListView', name: 'developer and publisher list' },
  'game-pass': { prefKey: 'gamePassListView', name: 'Game Pass' },
  user: { prefKey: 'ownedListView', name: 'list' }, // unreached: a user list's layout lives on the list
};
// Pick-and-mix bundles share their own layout: grouped and sorted for picking, not by tier.
export const PICK_BUNDLE_LAYOUT = { prefKey: 'pickBundleListView', name: 'pick & mix bundle' };

// Every list kind's layout key plus the /bundles picker's (BundlesBrowseRoute.tsx's VIEW_PREF_KEY); synced
// (syncedPrefKeys.ts), written only on Save (tableViewPrefs.ts's layoutDraft).
export const TABLE_VIEW_PREF_KEYS: readonly string[] = [
  ...new Set(Object.values(KIND_LAYOUTS).map((layout) => layout.prefKey)),
  PICK_BUNDLE_LAYOUT.prefKey,
  'bundlesBrowseView',
];
