import { Show, createSignal, onCleanup, type JSX } from 'solid-js';
import Link from 'lucide-solid/icons/link';
import RotateCcw from 'lucide-solid/icons/rotate-ccw';

// Hidden while `changes` is empty.
export function UnsavedChangesBanner(props: {
  name: string;
  changes: string[];
  note: string;
  onSave: () => void;
  onDiscard: () => void;
}): JSX.Element {
  return (
    <Show when={props.changes.length}>
      <div class="pref-unsaved-banner">
        Unsaved changes to {props.name} ({props.changes.join(', ')}) — {props.note}
        <button type="button" class="btn" onClick={() => props.onSave()}>
          Save
        </button>
        <button type="button" class="btn" onClick={() => props.onDiscard()}>
          Discard
        </button>
      </div>
    </Show>
  );
}

// A table's "🔗 Share layout"/"Reset layout" toolbar buttons — see tableViewPrefs.ts.
const REASON_MS = 5000;

export function ViewActions(props: {
  onShare: (btn: HTMLElement) => void;
  onReset: () => void;
  shareDisabledReason?: string | null;
  hideShare?: boolean;
  hideReset?: boolean;
}): JSX.Element {
  const [reasonShown, setReasonShown] = createSignal(false);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(hideTimer));
  function showReason(): void {
    setReasonShown(true);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => setReasonShown(false), REASON_MS);
  }
  return (
    <div class="list-view-actions">
      <Show when={!props.hideShare}>
        {/* aria-disabled, not disabled: a press has to reach us to say why. */}
        <button
          type="button"
          class="btn"
          aria-label="Share layout"
          aria-disabled={props.shareDisabledReason ? 'true' : undefined}
          aria-describedby={props.shareDisabledReason ? 'share-view-reason' : undefined}
          title={props.shareDisabledReason ? undefined : 'Copy a link to this list as you see it'}
          onClick={(e) => (props.shareDisabledReason ? showReason() : props.onShare(e.currentTarget))}
          onBlur={() => setReasonShown(false)}
        >
          <Link />
          <span class="btn-label"> Share layout</span>
        </button>
      </Show>
      <Show when={!props.hideReset}>
        <button
          type="button"
          class="btn"
          aria-label="Reset layout"
          title="Back to the default columns, sort and filters"
          onClick={() => props.onReset()}
        >
          <RotateCcw class="btn-icon" />
          <span class="btn-label">Reset layout</span>
        </button>
      </Show>
      <Show when={props.shareDisabledReason}>
        {(reason) => (
          <>
            <span id="share-view-reason" hidden>
              {reason()}
            </span>
            <Show when={reasonShown()}>
              <p class="list-view-reason" role="status">
                {reason()}
              </p>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
