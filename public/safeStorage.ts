// Web storage that may be unavailable (private browsing, blocked site data): even reaching it can throw.
type Area = 'localStorage' | 'sessionStorage';

// null when storage is unavailable, as when the key is unset.
export function storageGet(area: Area, key: string): string | null {
  try {
    return globalThis[area].getItem(key);
  } catch {
    return null;
  }
}

// A null `value` removes the key; false when storage refused the write.
export function storageSet(area: Area, key: string, value: string | null): boolean {
  try {
    if (value === null) globalThis[area].removeItem(key);
    else globalThis[area].setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
