'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ruleMatches, permissionProblems, skillProblems, ledgerProblems } = require('../scripts/setup-lint');

test('ruleMatches follows the Bash rule syntax: bare, exact, legacy prefix, wildcard', () => {
  assert.equal(ruleMatches('Bash', 'rm x'), true);
  assert.equal(ruleMatches('Bash(npm test)', 'npm test'), true);
  assert.equal(ruleMatches('Bash(npm test)', 'npm test x'), false);
  assert.equal(ruleMatches('Bash(npm run check:*)', 'npm run check:setup'), true);
  assert.equal(ruleMatches('Bash(git *)', 'git push origin main'), true);
  assert.equal(ruleMatches('Bash(git status *)', 'git push origin main'), false);
  assert.equal(ruleMatches('Read', 'rm x'), false);
});

test('permissionProblems flags allows that cover an ask-first action, not narrow ones', () => {
  const settings = { permissions: { allow: ['Bash(git add *)', 'Bash(npm run *)', 'Bash(git *)', 'Read'] } };
  const problems = permissionProblems('s.json', settings);
  assert.ok(problems.every((p) => p.includes('"Bash(git *)"')));
  assert.ok(problems.some((p) => p.includes('`git commit -m x`')));
});

test('permissionProblems covers the user-level ask-first list', () => {
  const allow = [
    'Bash(git clean *)',
    'Bash(git restore *)',
    'Bash(git checkout *)',
    'Bash(npm publish*)',
    'Bash(git push origin --delete *)',
  ];
  for (const rule of allow) {
    assert.notDeepEqual(permissionProblems('s.json', { permissions: { allow: [rule] } }), [], rule);
  }
});

test('permissionProblems flags merge.js finish, which lands on main, unless an ask rule covers it', () => {
  const allow = ['Bash(node scripts/*)'];
  assert.deepEqual(permissionProblems('s.json', { permissions: { allow } }), [
    's.json: allow "Bash(node scripts/*)" pre-approves an ask-first action (`node scripts/merge.js finish x`)',
  ]);
  const ask = ['Bash(node scripts/merge.js finish*)'];
  assert.deepEqual(permissionProblems('s.json', { permissions: { allow, ask } }), []);
});

test('skillProblems checks the name, the "Use when" and the description length', () => {
  const skill = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# X`;
  assert.deepEqual(skillProblems('a', skill('a', 'Does x. Use when asked.')), []);
  assert.deepEqual(skillProblems('a', skill('b', 'Does x.')), [
    'a: frontmatter name "b" doesn\'t match its directory',
    'a: description has no "Use when"',
  ]);
  assert.match(skillProblems('a', skill('a', `Use when ${'x'.repeat(1100)}`))[0], /max 1024/);
  assert.deepEqual(skillProblems('a', '# no frontmatter'), ['a: SKILL.md has no frontmatter']);
});

test('ledgerProblems flags an undated header once the ledger holds items', () => {
  const ledger = (dates, items) => `# Setup backlog\n\nLast reviewed: ${dates}.\n\n## Watching\n\n${items}\n`;
  assert.deepEqual(ledgerProblems(ledger('never · Transcripts read up to: never', 'None.')), []);
  assert.equal(ledgerProblems(ledger('never · Transcripts read up to: never', '- **P1 · x · S** — y.')).length, 1);
  assert.deepEqual(
    ledgerProblems(ledger('2026-10-11 · Transcripts read up to: 2026-10-11', '- **P1 · x · S** — y.')),
    [],
  );
});
