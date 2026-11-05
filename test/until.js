'use strict';

// Waits for the state the code under test produces instead of sleeping across a window load can close
// (docs/dev/testing.md#writing-reliable-tests). The deadline only bounds a failure; it is no timing window.
// Polls with setTimeout: under `mock.timers` faking it, it never wakes and hangs — await the code's own promise instead.
async function until(condition, what, deadlineMs = 10_000) {
  const end = Date.now() + deadlineMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`until: ${what} never happened`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

module.exports = { until };
