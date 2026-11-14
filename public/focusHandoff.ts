// ui-guidelines.md's Keyboard rule: focus is never dropped to <body> when the element holding it goes.

// A focus candidate: focuses its target and says whether it could.
export type FocusCandidate = () => boolean;

export function focusVisible(el: HTMLElement | null | undefined): boolean {
  if (!el?.isConnected || !el.checkVisibility()) return false;
  el.focus();
  return document.activeElement === el;
}

// At least partly within the window's height.
export function inViewport(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  return rect.bottom > 0 && rect.top < window.innerHeight;
}

// The first visible match of `selector`, for a candidate naming its target by place.
export function focusFirst(selector: string): FocusCandidate {
  return () => [...document.querySelectorAll<HTMLElement>(selector)].some(focusVisible);
}

const focusMain: FocusCandidate = () => focusVisible(document.querySelector<HTMLElement>('main.app-content'));

export const focusLost = () => document.activeElement === document.body || !document.activeElement?.isConnected;

export function handOffFocus(...candidates: FocusCandidate[]): void {
  for (const candidate of [...candidates, focusMain]) if (candidate()) return;
}

// Runs `change`; when focus was inside `from` and the change dropped it, the first candidate
// that can take it gets it. Focus the user moved elsewhere meanwhile is left alone.
export function keepFocus(
  from: Element | null | undefined,
  change: () => void | Promise<void>,
  ...candidates: FocusCandidate[]
): void | Promise<void> {
  const held = !!from?.contains(document.activeElement);
  const after = () => {
    if (held && focusLost()) handOffFocus(...candidates);
  };
  const result = change();
  if (result instanceof Promise) return result.then(after);
  after();
}
