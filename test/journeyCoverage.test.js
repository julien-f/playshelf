'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  parseJourneys,
  parseTitle,
  coverage,
  format,
  targetProblems,
  formatTargets,
  testsFromReport,
} = require('../scripts/journey-coverage');

const MD = `### A1 First visit

- **Steps**:
  1. open \`/\`
  2. it becomes my account ◇
  3. open **Owned**
- **Done when**: rows.

### C1 Compare

- **Steps**:
  1. **Compare**
- **Or**:
  2. **Compare with me** ◇
`;

test('parseJourneys: numbered steps, Or steps included, ◇ marks a target', () => {
  const j = parseJourneys(MD);
  assert.deepStrictEqual([...j.keys()], ['A1', 'C1']);
  assert.deepStrictEqual(
    [...j.get('A1').steps],
    [
      [1, { target: false }],
      [2, { target: true }],
      [3, { target: false }],
    ],
  );
  assert.deepStrictEqual([...j.get('C1').steps.keys()], [1, 2]);
});

test('parseTitle: whole journey, step lists and ranges, edges; anything else maps to nothing', () => {
  assert.deepStrictEqual(parseTitle('A1: first visit'), { id: 'A1', steps: null, edge: false });
  assert.deepStrictEqual(parseTitle('R1.1,3-5: rank'), { id: 'R1', steps: [1, 3, 4, 5], edge: false });
  assert.deepStrictEqual(parseTitle('A1 edge: no account'), { id: 'A1', steps: null, edge: true });
  assert.strictEqual(parseTitle('first visit'), null);
  assert.strictEqual(parseTitle('A1.2 edge: both'), null);
});

test("coverage: a whole-journey test locks the built steps; failures and ◇ or missing steps don't", () => {
  const journeys = parseJourneys(MD);
  const { journeys: cov, problems } = coverage(journeys, [
    { title: 'A1: all', passed: true },
    { title: 'A1 edge: x', passed: true },
    { title: 'C1.1: failing', passed: false },
    { title: 'C1.2: target', passed: true },
    { title: 'A1.4: missing', passed: true },
    { title: 'Z9: nowhere', passed: true },
  ]);
  assert.deepStrictEqual([...cov.get('A1').locked], [1, 3]);
  assert.strictEqual(cov.get('A1').edges, 1);
  assert.deepStrictEqual([...cov.get('C1').locked], []);
  assert.strictEqual(problems.length, 3);
  assert.strictEqual(format(journeys, cov), 'A1  ★◇★     +1 edge  First visit\nC1  ·◇               Compare');
});

test("testsFromReport: one entry per title across projects, failed if any project's last result failed", () => {
  const report = {
    suites: [
      {
        specs: [
          { title: 'A1: x', tests: [{ results: [{ status: 'passed' }] }, { results: [{ status: 'skipped' }] }] },
          { title: 'A2: y', tests: [{ results: [{ status: 'passed' }] }, { results: [{ status: 'failed' }] }] },
        ],
        suites: [
          { specs: [{ title: 'A3: z', tests: [{ results: [] }] }] },
          { specs: [{ title: 'A1: x', tests: [{ results: [{ status: 'failed' }] }] }] },
        ],
      },
    ],
  };
  assert.deepStrictEqual(testsFromReport(report), [
    { title: 'A1: x', passed: false },
    { title: 'A2: y', passed: false },
    { title: 'A3: z', passed: true },
  ]);
});

const TARGETS_MD = `# Journeys

◇ marks a target, named by its U-item.

### A1 First visit

- **Steps**:
  1. it becomes my account ◇ U1
- **Or**: 2. **Compare with me** ◇
- **Done when**: an old age is highlighted ◇ U2.
- **Edges**: a ranked list says why ◇ U3
`;

const IMPROVEMENTS_MD = `- **U1 · minor · A1** — open.
- **U2 · polish · A1** — also open; U3 closed long ago.
`;

test('parseJourneys: a ◇ on any line of a journey is a target, with its U-item; the intro is not', () => {
  const targets = parseJourneys(TARGETS_MD).get('A1').targets;
  assert.deepStrictEqual(
    targets.map((t) => t.item),
    ['U1', null, 'U2', 'U3'],
  );
});

test('targetProblems: a ◇ needs a U-item still open in improvements.md', () => {
  const problems = targetProblems(parseJourneys(TARGETS_MD), IMPROVEMENTS_MD);
  assert.strictEqual(problems.length, 2);
  assert.match(problems[0], /A1: ◇ names no U-item/);
  assert.match(problems[1], /A1: ◇ U3 is not open/);
});

test('formatTargets: one line per ◇, journey and item first', () => {
  assert.strictEqual(
    formatTargets(parseJourneys(TARGETS_MD)).split('\n')[0],
    'A1  U1    1. it becomes my account ◇ U1',
  );
});
