// Generic, per-key user-preference store — the single localStorage-backed mechanism every
// global preference (region.js's own region choice, and any future one) and every persisted
// table view (library.js/bundles.js — see their own comments) reads and writes through, so
// there's one place a future Steam-auth-backed server sync attaches to rather than a rewrite at
// every call site. An ES module, importing getPref/setPref directly wherever needed.
//
// One JSON blob under one key (rather than one localStorage key per preference) so the whole
// set can be enumerated at once later (e.g. a settings page, or the initial payload a synced
// account pulls down) without needing to know every individual key up front. This is purely a
// local-storage convenience, though — it does NOT mean sync itself works on the whole blob (see
// setPref below).
import { batch, createSignal } from 'solid-js';
import { TABLE_VIEW_PREF_KEYS } from './tableViewKeys.ts';
import { setItemMakingRoom } from './tasteCache.ts';

export const PREFS_STORAGE_KEY = 'steam.isonoe.net:prefs';

export interface PrefEntry {
  value: unknown;
  updatedAt: number; // ms epoch — this device's clock, used for last-write-wins merges (authStore.ts)
}

// v2: {value, updatedAt} per key, for authStore.ts's per-key merge. v3: a v2 blob's table layouts were
// written on every edit and never pushed, so they read as `updatedAt: 0` and the account's Saved one wins.
const SCHEMA_VERSION = 3;

function readRawBlob(raw: string | null): Record<string, unknown> {
  try {
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  } // a corrupted/foreign value
}

function isPrefEntry(value: unknown): value is PrefEntry {
  return !!value && typeof value === 'object' && 'value' in (value as object) && 'updatedAt' in (value as object);
}

// A v1 blob's values are never {value, updatedAt}-shaped themselves (none of this app's actual
// pref values happen to have both those keys), so schemaVersion alone is enough to tell the two
// formats apart. `updatedAt: 0` for everything migrated this way — v1 never tracked write times,
// so it's treated as older than literally anything with a real one, local or server-side.
function parseEntries(raw: string | null): Record<string, PrefEntry> {
  const { schemaVersion, ...rest } = readRawBlob(raw);
  const entries: Record<string, PrefEntry> = {};
  for (const [key, value] of Object.entries(rest)) {
    const entry = (schemaVersion === 2 || schemaVersion === SCHEMA_VERSION) && isPrefEntry(value);
    entries[key] = !entry
      ? { value, updatedAt: 0 }
      : schemaVersion === 2 && TABLE_VIEW_PREF_KEYS.includes(key)
        ? { value: value.value, updatedAt: 0 }
        : value;
  }
  return entries;
}

// The last parse, reused while storage holds the same string: any write (this tab, another, a seed) changes it.
// Never handed out: readers get a copy (`json`, each key's value serialized once), writers a new map.
let cache: { raw: string | null; entries: Record<string, PrefEntry>; json: Map<string, string> } | null = null;

function readCache(): NonNullable<typeof cache> {
  let raw: string | null;
  try {
    raw = localStorage.getItem(PREFS_STORAGE_KEY);
  } catch {
    return { raw: null, entries: {}, json: new Map() }; // unavailable storage
  }
  if (cache?.raw !== raw) cache = { raw, entries: parseEntries(raw), json: new Map() };
  return cache;
}

// A key's stored value as JSON, serialized once per parse.
function storedJson(c: NonNullable<typeof cache>, key: string): string {
  let json = c.json.get(key);
  if (json === undefined) c.json.set(key, (json = JSON.stringify(c.entries[key].value)));
  return json;
}

function readEntries(): Record<string, PrefEntry> {
  return { ...readCache().entries };
}

// False when not persisted: private browsing, storage unavailable, or full even without the cached tastes.
function writeEntries(entries: Record<string, PrefEntry>): boolean {
  return setItemMakingRoom(PREFS_STORAGE_KEY, JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...entries }));
}

// Per key, not one for the blob: table views and rankings are written on every edit, and would rerun every reader.
const versions = new Map<string, { track: () => void; notify: () => void }>();

function version(key: string): { track: () => void; notify: () => void } {
  let v = versions.get(key);
  if (!v) {
    const [track, notify] = createSignal(undefined, { equals: false });
    versions.set(key, (v = { track, notify: () => notify() }));
  }
  return v;
}

// Another tab wrote the blob: rerun the readers of each key it changed (all of them on a clear).
// Exported for test/prefs.test.js: the module loads once there, before any `window` stub.
export function onStorage(e: Pick<StorageEvent, 'key' | 'oldValue' | 'newValue' | 'storageArea'>): void {
  if (e.storageArea !== localStorage) return;
  if (e.key === null) return batch(() => versions.forEach((v) => v.notify()));
  if (e.key !== PREFS_STORAGE_KEY) return;
  const [before, after] = [parseEntries(e.oldValue), parseEntries(e.newValue)];
  const changed = (key: string) => JSON.stringify(before[key]?.value) !== JSON.stringify(after[key]?.value);
  batch(() => {
    for (const [key, v] of versions) if (changed(key)) v.notify();
  });
}

if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);

// Whether storage refused setPref's last write; AppShell.tsx's banner says so.
const [writeFailing, setWriteFailing] = createSignal(false);
const [dismissed, setDismissed] = createSignal(false);
export const prefsWriteFailed = (): boolean => writeFailing() && !dismissed();
// Until a write succeeds again: the next edits would most likely fail too.
export function dismissPrefsWriteFailure(): void {
  setDismissed(true);
}

// Returns `fallback` when the key was never set, storage is unavailable (private browsing,
// cleared site data), or the stored blob itself is corrupted — never throws.
export function getPref<T = unknown>(key: string): T | undefined;
export function getPref<T>(key: string, fallback: T): T;
export function getPref<T = unknown>(key: string, fallback?: T): T | undefined {
  version(key).track();
  const c = readCache();
  if (!(key in c.entries)) return fallback as T;
  return JSON.parse(storedJson(c, key)) as T;
}

export function setPref(key: string, value: unknown): void {
  // Unchanged: no write, push or restarted debounce. Retried after a refusal, so a success clears the banner.
  const c = readCache();
  if (!writeFailing() && key in c.entries && storedJson(c, key) === JSON.stringify(value)) return;
  const entries = { ...c.entries };
  const updatedAt = Date.now();
  entries[key] = { value, updatedAt };
  const written = writeEntries(entries);
  setWriteFailing(!written);
  if (written) setDismissed(false);
  else console.warn(`[prefs] storage refused "${key}": the change isn't saved on this device`);
  version(key).notify();
  // Not pushed either: the edit snaps back here, and a debounced push would send the stored value.
  if (!written) return;
  // Per-key push to the server once signed in (authStore.ts calls setSignedInSteamid on
  // sign-in/out) — deliberately never a whole-blob PUT, so two preferences changing around the
  // same time (different tabs/devices) can't race each other's writes.
  if (!signedInSteamid) return;
  if (DEBOUNCED_PUSH_PREFIXES.some((p) => key.startsWith(p))) schedulePush(key);
  else pushPrefToServer(key, value, updatedAt);
}

// Written per compare answer, list view change, lookup or status: pushing each would trip PUT /api/me/prefs/:key's per-minute limit.
const DEBOUNCED_PUSH_PREFIXES = ['ranking:', 'lists', 'recentGames', 'gameStatuses'];
const PUSH_DEBOUNCE_MS = 3000;
const pendingPushes = new Map<string, ReturnType<typeof setTimeout>>();

function schedulePush(key: string): void {
  clearTimeout(pendingPushes.get(key));
  pendingPushes.set(
    key,
    setTimeout(() => flushPush(key), PUSH_DEBOUNCE_MS),
  );
}

function flushPush(key: string, keepalive = false): Promise<void> | undefined {
  clearTimeout(pendingPushes.get(key));
  pendingPushes.delete(key);
  const entry = readEntries()[key];
  if (entry && signedInSteamid) return pushPrefToServer(key, entry.value, entry.updatedAt, { keepalive });
}

// keepalive so a push flushed as the tab is hidden/closed still completes.
export function flushPendingPushes(): void {
  for (const key of [...pendingPushes.keys()]) flushPush(key, true);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPendingPushes();
  });
}

// Set by authStore.ts once GET /api/me resolves (and cleared on sign-out) — kept here, rather
// than importing authStore.ts, so this module doesn't need to know about auth beyond "should
// setPref also sync". authStore.ts is the one importing from this file (for the prefs merge),
// not the other way around.
let signedInSteamid: string | null = null;
// Resolves once the pending pushes it sent have answered.
export function setSignedInSteamid(steamid: string | null): Promise<void> {
  // Pending pushes belong to the account they were written under: send them before it changes.
  const flushed = steamid !== signedInSteamid ? [...pendingPushes.keys()].map((key) => flushPush(key)) : [];
  signedInSteamid = steamid;
  return Promise.all(flushed).then(() => undefined);
}

// authStore.ts's, registered rather than imported for the same reason as signedInSteamid above.
let onSessionLost = (): void => {};
export function setOnSessionLost(callback: () => void): void {
  onSessionLost = callback;
}

// A push answered 401: the session ended. Pending pushes are dropped, not sent into more 401s: their
// local `updatedAt` stays newer than the server's, so the next sign-in's merge pushes them.
function sessionLost(): void {
  for (const timer of pendingPushes.values()) clearTimeout(timer);
  pendingPushes.clear();
  signedInSteamid = null;
  onSessionLost();
}

// Test-only (see test/prefs.test.js) — this repo's usual "delete require.cache between tests"
// reset doesn't reach a module-level `let` in a TS-stripped ESM file (confirmed live; same
// caveat myOwnership.ts/accountOverride.ts document for their own module state), and unlike
// those this little state didn't seem worth a whole factory-function rewrite for. Same `_reset`
// naming convention as lib/cache.js/lib/metrics.js's own test-only resets.
export function _resetPrefsState(): void {
  signedInSteamid = null;
  onSessionLost = () => {};
  cache = null;
  setWriteFailing(false);
  setDismissed(false);
}

// Fire-and-forget — a failed sync leaves the change on this device only, in localStorage, exactly
// as it worked before server sync existed at all. Not retried here: authStore.ts's merge, which
// runs on every sign-in check (not just the first), pushes any key whose local `updatedAt` still
// beats the server's, so a failed push is naturally retried the next time this device checks in.
const KEEPALIVE_MAX_BYTES = 60_000;

export function pushPrefToServer(
  key: string,
  value: unknown,
  updatedAt: number,
  { keepalive = false } = {},
): Promise<void> {
  const body = JSON.stringify({ value, updatedAt });
  return fetch(`/api/me/prefs/${encodeURIComponent(key)}`, {
    method: 'PUT',
    // Browsers reject keepalive bodies past 64 KiB (in flight, in total): a big `lists` goes plain.
    keepalive: keepalive && body.length <= KEEPALIVE_MAX_BYTES,
    headers: { 'Content-Type': 'application/json' },
    body,
  })
    .then((res) => {
      if (res.status === 401) sessionLost();
      else if (!res.ok) console.warn(`[prefs] the server refused "${key}" (${res.status}); it stays on this device`);
    })
    .catch((err) => console.error(`[prefs] failed to sync "${key}" to the server`, err));
}

// Every locally stored key, with its value and last-write time — authStore.ts's merge diffs this
// against the server's own per-key map to decide, key by key, which side is newer.
export function getAllPrefEntries(): Record<string, PrefEntry> {
  return structuredClone(readCache().entries);
}

// Writes one key's value locally without pushing it back to the server — used when a merge finds
// the server's copy of that key is newer than this device's own. Bypasses setPref specifically to
// avoid that echo. Returns whether the write was persisted.
export function adoptPrefEntry(key: string, value: unknown, updatedAt: number): boolean {
  const c = readCache();
  const same = key in c.entries && storedJson(c, key) === JSON.stringify(value);
  const written = writeEntries({ ...c.entries, [key]: { value, updatedAt } });
  if (written && !same) version(key).notify();
  return written;
}
