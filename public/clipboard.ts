// One "copy this text, then say so" helper, shared by every copy button in the app — the panel's
// 🔗, the tables' "🔗 Share layout", and the account-identifier buttons on Home and the nav chip.
// Each of the first two grew its own writeText-then-swap-the-label-for-1.5s pair, and they had
// already drifted: both silently did nothing when the Clipboard API was unavailable (it needs a
// secure context, and can be permission-denied), leaving a button that looks broken, while the
// lightbox's third copy fell back to a `window.prompt` the user could copy out of by hand.
import { announce } from './announce.ts';

export const COPIED_MS = 1500;

// Resolves true if the text reached the clipboard, false if the user was given the prompt
// fallback instead — callers that show a "Copied!" state should only show it on true.
export function copyText(text: string): Promise<boolean> {
  const clipboard = navigator.clipboard;
  if (!clipboard?.writeText) return Promise.resolve(promptFallback(text));
  return clipboard.writeText(text).then(
    () => {
      announce('Copied to clipboard'); // the buttons' ✓ is visual only
      return true;
    },
    () => promptFallback(text),
  );
}

function promptFallback(text: string): boolean {
  try {
    window.prompt('Copy this:', text);
  } catch {
    /* no window (tests) */
  }
  return false;
}

export interface CopyFeedback {
  copied?: string | Node; // label shown while confirming (default 'Copied!')
  copiedClass?: string; // class added for the same window, for a distinct confirmation color
}

// The imperative half, for the two call sites that already hold a plain DOM button rather than
// rendering one (panel.tsx's header buttons, tableViewPrefs.ts's table actions). JSX call sites
// use CopyButton.tsx instead, which drives the same state through a signal rather than by
// writing to the DOM behind Solid's back.
export function copyWithFeedback(btn: HTMLElement, text: string, opts: CopyFeedback = {}): void {
  copyText(text).then((ok) => {
    if (ok) flash(btn, opts);
  });
}

// Per button, the label to restore and the pending restore: a re-flash keeps the original label.
const flashing = new WeakMap<
  HTMLElement,
  { nodes: ChildNode[]; title: string; timer: ReturnType<typeof setTimeout> }
>();

function flash(btn: HTMLElement, { copied = 'Copied!', copiedClass }: CopyFeedback): void {
  const pending = flashing.get(btn);
  if (pending) clearTimeout(pending.timer);
  // Nodes, not text: a label may carry markup (an icon and a label hidden on a phone).
  const nodes = pending?.nodes ?? [...btn.childNodes];
  const title = pending?.title ?? btn.title;
  btn.replaceChildren(copied);
  btn.title = 'Copied!';
  if (copiedClass) btn.classList.add(copiedClass);
  const timer = setTimeout(() => {
    flashing.delete(btn);
    btn.replaceChildren(...nodes);
    btn.title = title;
    if (copiedClass) btn.classList.remove(copiedClass);
  }, COPIED_MS);
  flashing.set(btn, { nodes, title, timer });
}
