import type { JSX } from 'solid-js';

// Shown while a table follows the layout of a 🔗 Share layout link: it applies to this visit only,
// and view persistence stays paused until the viewer keeps it or goes back to their own.
export function SharedViewBanner(props: { edited: boolean; onKeep: () => void; onDiscard: () => void }): JSX.Element {
  return (
    <div class="pref-unsaved-banner" role="status">
      {props.edited
        ? "You've changed this shared layout — it's lost on reload unless you keep it."
        : 'This table uses a layout from a shared link — for this visit only.'}
      <button type="button" class="btn" onClick={() => props.onKeep()}>
        Keep as my layout
      </button>
      <button type="button" class="btn" onClick={() => props.onDiscard()}>
        Use my own
      </button>
    </div>
  );
}
