'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { copyText, copyWithFeedback, COPIED_MS } = require('../public/clipboard.ts');

// Just enough DOM for the copy announcement's live region.
const appended = [];
globalThis.document = {
  createElement: () => ({ setAttribute() {}, style: {}, textContent: '' }),
  body: { append: (el) => appended.push(el) },
};

// The copy settles in microtasks; the timers it then arms run on the mocked clock, never a real sleep.
const settled = () => new Promise((r) => setImmediate(r));
function fakeTimers(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return (ms) => t.mock.timers.tick(ms);
}

// Same navigator-stubbing shape tableViewPrefs.test.js already uses for its own share button.
function withNavigator(t, clipboard) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard }, configurable: true });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  });
}

// A button flat enough to assert against, its children `{ text }` nodes — an icon's SVG being one
// with no text — and .classList only touched when copiedClass is given.
const icon = () => ({ nodeName: 'svg', text: '' });
function fakeBtn(...children) {
  const classes = new Set();
  let nodes = children.length ? children : [icon()];
  return {
    get childNodes() {
      return nodes;
    },
    get textContent() {
      return nodes.map((n) => n.text).join('');
    },
    // Like the DOM's: a string becomes a text node.
    replaceChildren: (...next) => {
      nodes = next.map((n) => (typeof n === 'string' ? { text: n } : n));
    },
    title: 'Copy link',
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), has: (c) => classes.has(c) },
  };
}

test('copyText: writes to the clipboard and reports success', async (t) => {
  const tick = fakeTimers(t);
  let copied = null;
  withNavigator(t, {
    writeText: async (text) => {
      copied = text;
    },
  });
  assert.equal(await copyText('gaben'), true);
  assert.equal(copied, 'gaben');
  tick(150);
  assert.equal(appended[0].textContent, 'Copied to clipboard');
});

test('copyText: reports failure (prompt fallback) when the Clipboard API is unavailable', async (t) => {
  withNavigator(t, undefined);
  assert.equal(await copyText('gaben'), false);
});

test('copyText: reports failure when writeText rejects (permission denied)', async (t) => {
  withNavigator(t, {
    writeText: async () => {
      throw new Error('denied');
    },
  });
  assert.equal(await copyText('gaben'), false);
});

test('copyWithFeedback: swaps label/title/class, then restores them', async (t) => {
  const tick = fakeTimers(t);
  withNavigator(t, { writeText: async () => {} });
  const btn = fakeBtn();
  const before = [...btn.childNodes];
  const check = icon();
  copyWithFeedback(btn, 'https://example.test/game/400', { copied: check, copiedClass: 'x--copied' });
  await settled();
  assert.deepEqual(btn.childNodes, [check]);
  assert.equal(btn.childNodes[0], check);
  assert.equal(btn.title, 'Copied!');
  assert.equal(btn.classList.has('x--copied'), true);

  tick(COPIED_MS);
  assert.equal(btn.childNodes[0], before[0]);
  assert.equal(btn.title, 'Copy link');
  assert.equal(btn.classList.has('x--copied'), false);
});

test('copyWithFeedback: restores a label made of several nodes as they were', async (t) => {
  const tick = fakeTimers(t);
  withNavigator(t, { writeText: async () => {} });
  const btn = fakeBtn(icon(), { text: ' Share layout' });
  const before = [...btn.childNodes];
  copyWithFeedback(btn, 'https://example.test/?tv=x');
  await settled();
  tick(COPIED_MS);
  assert.deepEqual(btn.childNodes, before);
  assert.equal(btn.childNodes[1], before[1]);
});

test('copyWithFeedback: leaves the button alone when the copy failed', async (t) => {
  withNavigator(t, undefined);
  const btn = fakeBtn();
  const before = [...btn.childNodes];
  copyWithFeedback(btn, 'whatever');
  await settled();
  assert.equal(btn.childNodes[0], before[0]);
});

test('copyWithFeedback: a second copy while confirming still restores the original label', async (t) => {
  const tick = fakeTimers(t);
  withNavigator(t, { writeText: async () => {} });
  const btn = fakeBtn();
  const before = [...btn.childNodes];
  copyWithFeedback(btn, 'a');
  await settled();
  tick(COPIED_MS / 2);
  copyWithFeedback(btn, 'b');
  await settled();
  tick(COPIED_MS / 2 + 10);
  assert.equal(btn.textContent, 'Copied!'); // the first timer no longer cuts the second short
  tick(COPIED_MS / 2);
  assert.equal(btn.childNodes[0], before[0]);
  assert.equal(btn.title, 'Copy link');
});
