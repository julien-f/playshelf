import type { JSX } from 'solid-js';
import { focusVisible, keepFocus } from './focusHandoff.ts';
import { dismissPrefsWriteFailure } from './prefs.ts';

// Shown while setPref's writes fail (prefs.ts): the edit would otherwise look kept, then snap back.
export function StorageFullBanner(): JSX.Element {
  // Where focus was before it came into the banner, to hand it back on Dismiss.
  let returnTo: Element | null = null;
  return (
    <div
      class="storage-full-banner"
      role="alert"
      onFocusIn={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) returnTo = e.relatedTarget as Element | null;
      }}
    >
      This browser didn't save your last change on this device.
      <button
        type="button"
        class="btn"
        onClick={(e) => {
          void keepFocus(e.currentTarget, dismissPrefsWriteFailure, () =>
            focusVisible(returnTo instanceof HTMLElement ? returnTo : null),
          );
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
