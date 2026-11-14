'use strict';

// An in-memory stand-in for the browser's localStorage, fresh per call.
function makeMemoryLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

module.exports = { makeMemoryLocalStorage };
