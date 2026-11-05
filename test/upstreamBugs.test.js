'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { workarounds, leftover } = require('../scripts/upstream-bugs');

test('workarounds: a Bugzilla or GitHub issue URL followed by "is fixed", with where it is', () => {
  assert.deepEqual(
    workarounds([
      { file: 'a.ts', line: 3, text: '// Remove once https://bugzilla.mozilla.org/show_bug.cgi?id=123 is fixed.' },
      { file: 'b.ts', line: 7, text: '// until https://github.com/o/r.js/issues/47 is fixed.' },
      { file: 'c.css', line: 1, text: 'Remove once https://bugzilla.mozilla.org/show_bug.cgi?id=TODO is fixed. */' },
      { file: 'd.ts', line: 2, text: '// See https://github.com/o/r/issues/9 for why.' },
    ]),
    [
      { where: 'a.ts:3', url: 'https://bugzilla.mozilla.org/show_bug.cgi?id=123', bugzilla: '123', filed: true },
      { where: 'b.ts:7', url: 'https://github.com/o/r.js/issues/47', github: 'o/r.js/issues/47', filed: true },
      { where: 'c.css:1', url: 'https://bugzilla.mozilla.org/show_bug.cgi?id=TODO', bugzilla: 'TODO', filed: false },
    ],
  );
});

test('leftover: a closed bug or an unfiled one; nothing while open or unknown', () => {
  const w = { where: 'a.ts:3', url: 'U', filed: true };
  assert.equal(
    leftover({ ...w, state: 'closed' }),
    'a.ts:3: U is closed: check it was fixed, then remove the workaround',
  );
  assert.equal(leftover({ ...w, filed: false }), 'a.ts:3: upstream bug not filed yet (U)');
  assert.equal(leftover({ ...w, state: 'open' }), null);
  assert.equal(leftover({ ...w, state: 'unknown' }), null);
});
