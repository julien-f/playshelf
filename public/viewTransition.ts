import { prefersReducedMotion } from './motion.ts';

// Shared-element morphs (frontend.md's Motion). Not with the top layer in use: it paints over
// every snapshot, so the morph would run under it.

let updating = false;
// True while a morph's `update` runs: an open it makes leaves focus to the morph's `focus`.
export const isMorphUpdating = (): boolean => updating;

export interface Morph {
  from: HTMLElement;
  update: () => void;
  // The element `from` turns into, looked up once `update` has run.
  to: () => HTMLElement | null;
  // Settles once `to` shows its picture; waited for at most MORPH_WAIT_MS.
  ready: (to: HTMLElement) => Promise<unknown>;
  focus: () => void;
  // Around the transition only: e.g. a class turning the destination's own enter motion off.
  start?: () => void;
  finish?: () => void;
}

const NAME = 'game-art';
const MORPH_WAIT_MS = 150;

export function canMorph(): boolean {
  return (
    'startViewTransition' in document &&
    !prefersReducedMotion() &&
    // The lightbox's own dialog aside: it morphs open and closed (the snapshots paint above it).
    !document.querySelector(':popover-open, dialog[open]:not(#screenshot-lightbox)')
  );
}

export function morph(m: Morph): void {
  if (!canMorph()) return m.update();
  let to: HTMLElement | null = null;
  m.from.style.viewTransitionName = NAME;
  m.start?.();
  const transition = document.startViewTransition(async () => {
    m.from.style.viewTransitionName = '';
    updating = true;
    try {
      m.update();
    } finally {
      updating = false;
    }
    to = m.to();
    if (!to) return;
    to.style.viewTransitionName = NAME;
    await Promise.race([m.ready(to).catch(() => {}), new Promise((resolve) => setTimeout(resolve, MORPH_WAIT_MS))]);
  });
  void transition.updateCallbackDone.finally(m.focus);
  void transition.finished.finally(() => {
    m.from.style.viewTransitionName = '';
    if (to) to.style.viewTransitionName = '';
    m.finish?.();
  });
}

// Resolves once `el` has lost `cls` (a loading marker), then `img` is decoded.
export function loadedWhen(el: HTMLElement, cls: string, img: HTMLImageElement): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!el.classList.contains(cls)) return resolve();
    const observer = new MutationObserver(() => {
      if (el.classList.contains(cls)) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(el, { attributes: true, attributeFilter: ['class'] });
  }).then(() => img.decode());
}
