'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { proseProblems, unindexed } = require('../scripts/doc-lint');

test('proseProblems: history phrases and long paragraphs, outside quotes, code and tables', () => {
  const text = [
    'The panel used to rebuild.',
    'A list reads "no longer listed" and `usedToBe` stays.',
    '| no longer | in a table |',
    '```',
    'previously, in code',
    '```',
    'x'.repeat(1001),
  ].join('\n');
  assert.deepStrictEqual(proseProblems('docs/x.md', text), [
    'docs/x.md:1: "used to" narrates history; state the current behavior (and its why) instead',
    'docs/x.md:7: 1001-character paragraph; split it into bullets',
  ]);
});

test('unindexed: docs CLAUDE.md lacks a link to', () => {
  assert.deepStrictEqual(unindexed(['docs/a.md', 'docs/b.md'], '[a](docs/a.md)'), ['CLAUDE.md: no link to docs/b.md']);
});
