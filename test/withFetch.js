'use strict';

// Replaces the global fetch until the test ends.
function withFetch(t, handler) {
  const restore = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = restore;
  });
}

module.exports = { withFetch };
