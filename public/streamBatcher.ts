// Batches high-frequency row mutations (an SSE detail stream, one event per game) so a page's
// table doesn't fully re-sort/re-filter/re-paginate once per streamed game. Extracted after a
// real regression: `library.tsx`'s own hand-rolled version of this (a `pendingDetailEvents`
// queue + `flushTimer`) was written to fix a confirmed browser-freezing bug — a ~1150-game
// library took up to a minute of unresponsive main-thread work to finish streaming, because
// `@vates/data-table-solid`'s `tableData()` accessor reacts live to the row store, so every
// *unbatched* mutation (one per streamed game) triggered a full table recompute instead of one
// per flush. The pre-Solid `@vates/data-table-vanilla` table got that amortization for free via
// an explicit, timer-gated `table.setData()` call; the Solid conversion dropped it silently
// since there was no more `setData()` call left for the timer to gate — nothing enforced the
// relationship between "a debounce timer exists" and "it's actually gating the expensive part."
//
// Pulling the batching itself into a shared, tested primitive — rather than leaving each page's
// own streaming loop to reinvent (or forget) it — is the structural fix: `bundles.tsx` had the
// identical gap with no batching at all (bundles are usually small enough that nobody noticed),
// and any future streaming consumer gets correct behavior by using this instead of writing its
// own loop.
//
// Deliberately NOT folded into `rowStore.ts`'s `mutateRow` itself — `mutateRow` also backs
// one-off calls (a single achievements load, a DLC toggle, a "↻ Refresh" click) that need to
// apply immediately, not wait out a flush window. Batching only belongs on the specific
// high-frequency path (a streaming loop), which explicitly opts into it via this module instead.
import { batch } from 'solid-js';

export interface StreamBatcher<E> {
  // Queues one event, tagged with the generation (see staleGuard.ts) it belongs to — applied at
  // the next flush, not immediately.
  push(event: E, gen: number): void;
  // Applies everything queued so far in one `batch()`, then calls `onFlush` — clears any pending
  // timer first, so this is safe to call both on the regular cadence and explicitly at stream
  // end (to avoid dropping whatever's queued from since the last flush).
  flushNow(): void;
}

// Matches the debounce this replaced.
export const FLUSH_MS = 150;

export function createStreamBatcher<E>(opts: {
  // Called once per non-stale queued event, inside the one `batch()` a flush wraps every event
  // in — same "which events survive" contract every other generation-tagged checkpoint in this
  // app already uses.
  apply: (event: E) => void;
  isStale: (gen: number) => boolean;
  // Runs once per flush, after the batch — e.g. the page's own status-text/tooltip update,
  // which needs the same amortized cadence but isn't itself a per-event row mutation.
  onFlush?: () => void;
}): StreamBatcher<E> {
  let pending: { event: E; gen: number }[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flushNow(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.length > 0) {
      const events = pending;
      pending = [];
      batch(() => {
        for (const { event, gen } of events) {
          if (opts.isStale(gen)) continue;
          opts.apply(event);
        }
      });
    }
    opts.onFlush?.();
  }

  function push(event: E, gen: number): void {
    pending.push({ event, gen });
    if (timer === null) timer = setTimeout(flushNow, FLUSH_MS);
  }

  return { push, flushNow };
}
