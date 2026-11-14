// Which screen the presentation window goes to, where the browser can tell (the Window Management API,
// Chromium only): remembered here, read by the main window to open it straight there next time.
import { storageSet } from './safeStorage.ts';

// The parts of the API used, declared here: not every TypeScript DOM library has them.
export interface ScreenDetailed {
  label: string;
  left: number;
  top: number;
  availLeft: number;
  availTop: number;
  availWidth: number;
  availHeight: number;
}
interface ScreenDetails {
  screens: ScreenDetailed[];
  currentScreen: ScreenDetailed;
}
type Placing = Window & { getScreenDetails?: () => Promise<ScreenDetails> };
type Screened = Screen & { isExtended?: boolean };

const KEY = 'steam.isonoe.net:presentation-screen';

// Whether placing can be offered at all: another screen, and the API to reach it.
export function canPlace(): boolean {
  return !!(screen as Screened).isExtended && typeof (window as Placing).getScreenDetails === 'function';
}

// Whether the permission was already given (no prompt), so one click both places and goes fullscreen.
export async function placementGranted(): Promise<boolean> {
  try {
    return (await navigator.permissions.query({ name: 'window-management' as PermissionName })).state === 'granted';
  } catch {
    return false;
  }
}

// Asks the permission if needed. The remembered screen when it's still there (no stable id: matched by
// label and position), else the first one this window isn't on.
export async function targetScreen(): Promise<ScreenDetailed | null> {
  const details = await (window as Placing).getScreenDetails!();
  const kept = remembered();
  const others = details.screens.filter((s) => s !== details.currentScreen);
  return (
    details.screens.find((s) => kept && s.label === kept.label && s.left === kept.left && s.top === kept.top) ??
    others[0] ??
    null
  );
}

export function remember(s: ScreenDetailed): void {
  const { label, left, top, availLeft, availTop, availWidth, availHeight } = s;
  // Refused: placed this once, not remembered.
  storageSet('localStorage', KEY, JSON.stringify({ label, left, top, availLeft, availTop, availWidth, availHeight }));
}

export function remembered(): ScreenDetailed | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
}
