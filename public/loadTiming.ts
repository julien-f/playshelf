// User Timing for a list load: DevTools' Performance panel and Playwright read the measures, each from `list:start`.
export type LoadStep = 'list:rows' | 'list:listed' | 'list:done';
const STEPS: LoadStep[] = ['list:rows', 'list:listed', 'list:done'];

let pending = new Set<LoadStep>();

// Only the latest load's entries are kept, so a long session doesn't accumulate them.
export function startLoadTiming(): void {
  performance.clearMarks('list:start');
  for (const step of STEPS) performance.clearMeasures(step);
  performance.mark('list:start');
  pending = new Set(STEPS);
}

// Once per load: a step reached again (a status update, a kept row) keeps its first time.
export function measureLoadStep(step: LoadStep): void {
  if (pending.delete(step)) performance.measure(step, 'list:start');
}
