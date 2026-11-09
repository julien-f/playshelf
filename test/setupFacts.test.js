'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  callers,
  argsWithoutUsage,
  commandKey,
  costDelta,
  costLine,
  checkStats,
  e2eRunStats,
  parseSession,
  commitCalls,
  linesSince,
  tokens,
  skillRuns,
  skillReads,
  answerOutcome,
  sessionEvents,
  digest,
  answerStats,
  summarize,
  agentSummary,
  docReads,
  docReadStats,
} = require('../scripts/setup-facts');

test('callers matches script paths and relative requires, not substrings', () => {
  const files = [
    ['package.json', '"check": "node scripts/check.js"'],
    ['scripts/other.js', "require('./journey-coverage')"],
    ['docs/a.md', 'run `scripts/changelog-check.js` and the check step'],
    ['scripts/check.js', 'scripts/check.js itself'],
    ['test/check.test.js', "require('../scripts/check')"],
  ];
  assert.deepEqual(callers('check', files), ['package.json']);
  assert.deepEqual(callers('journey-coverage', files), ['scripts/other.js']);
  assert.deepEqual(callers('changelog-check', files), ['docs/a.md']);
});

test('argsWithoutUsage flags argument parsing with no usage line', () => {
  assert.equal(argsWithoutUsage('const [a] = process.argv.slice(2);'), true);
  assert.equal(argsWithoutUsage("process.argv; console.error('Usage: x');"), false);
  assert.equal(argsWithoutUsage('console.log(1);'), false);
});

test('commandKey keeps the command and subcommand, never arguments', () => {
  assert.equal(commandKey('cd /repo && FOO=1 npm run test:one test/a.test.js | tail'), 'npm run test:one');
  assert.equal(commandKey('git diff --stat'), 'git diff');
  assert.equal(commandKey('node scripts/x.js up'), 'node scripts/x.js');
  assert.equal(commandKey('grep -rn secret .'), 'grep');
  assert.equal(commandKey('E2E_PORT=1 git -C /wt commit -F m'), 'git commit');
  assert.equal(commandKey('npm --prefix /wt run test:one a.js'), 'npm run test:one');
});

test('commandKey keys a chain by its gate, so a commit is not filed under git add', () => {
  assert.equal(commandKey('git add a.js && git commit -m x && git log --oneline -1'), 'git commit');
  assert.equal(commandKey('npm run format && npm run test:one a.js | tail'), 'npm run test:one');
  assert.equal(commandKey('sed -n 1,5p a && grep x b'), 'sed');
  assert.equal(commandKey('time npm run -s test:e2e'), 'npm run test:e2e');
});

test('parseSession pairs each call with its result: output size, elapsed time, classifier denial, user rejection', () => {
  const line = (timestamp, content) => JSON.stringify({ timestamp, message: { content } });
  const calls = parseSession([
    line('2026-01-01T00:00:00Z', [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'npm test' } }]),
    line('2026-01-01T00:00:03Z', [{ type: 'tool_result', tool_use_id: 'a', content: 'abcd' }]),
    line('2026-01-01T00:00:04Z', [{ type: 'tool_use', id: 'b', name: 'Read', input: {} }]),
    line('2026-01-01T00:00:05Z', [
      {
        type: 'tool_result',
        tool_use_id: 'b',
        is_error: true,
        content: [{ type: 'text', text: 'Permission for this action was denied' }],
      },
    ]),
    line('2026-01-01T00:00:06Z', [{ type: 'tool_use', id: 'c', name: 'Read', input: {} }]),
    line('2026-01-01T00:00:07Z', [{ type: 'tool_use', id: 'd', name: 'Edit', input: {} }]),
    line('2026-01-01T00:00:08Z', [
      { type: 'tool_result', tool_use_id: 'd', is_error: true, content: "The user doesn't want to proceed…" },
    ]),
  ]);
  assert.deepEqual(calls, [
    { key: 'npm test', bytes: 4, ms: 3000, error: false, denied: false, rejected: false },
    { key: 'Read', bytes: 37, ms: 1000, error: true, denied: true, rejected: false },
    { key: 'Edit', bytes: 33, ms: 1000, error: true, denied: false, rejected: true },
  ]);
});

test('parseSession skips api-request-blob lines, which replay earlier calls and results', () => {
  const content = (part) => ({ message: { content: [part] } });
  const use = { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'npm test' } };
  const result = { type: 'tool_result', tool_use_id: 'a', content: 'ok' };
  const calls = parseSession(
    [
      { timestamp: '2026-01-01T00:00:00Z', ...content(use) },
      { timestamp: '2026-01-01T00:00:03Z', ...content(result) },
      { type: 'api-request-blob', ...content(use) },
      { type: 'api-request-blob', ...content(result) },
    ].map((l) => JSON.stringify(l)),
  );
  assert.deepEqual(calls, [{ key: 'npm test', bytes: 2, ms: 3000, error: false, denied: false, rejected: false }]);
});

test('commitCalls counts the git commit calls that succeeded', () => {
  const call = (key, error = false) => ({ key, bytes: 0, ms: 0, error, denied: false, rejected: false });
  assert.equal(
    commitCalls([
      [call('git commit'), call('git log')],
      [call('git commit', true), call('git commit')],
    ]),
    2,
  );
});

test('linesSince keeps entries after the date, and the untimed ones', () => {
  const lines = [
    { timestamp: '2026-01-01T00:00:00Z', n: 1 },
    { n: 2 },
    { timestamp: '2026-01-02T00:00:00Z', n: 3 },
  ].map((l) => JSON.stringify(l));
  assert.deepEqual(
    linesSince(lines, Date.parse('2026-01-01T00:00:00Z')).map((l) => JSON.parse(l).n),
    [2, 3],
  );
});

test('agentSummary: wall time, turns and cache reads per response, failed calls, gate and tool time', () => {
  const usage = (id, cache) => ({ id, usage: { cache_read_input_tokens: cache } });
  const lines = [
    { type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { ...usage('m1', 10), content: [] } },
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        ...usage('m1', 100),
        content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'E2E_PORT=1 git commit -F m' } }],
      },
    },
    {
      type: 'user',
      timestamp: '2026-01-01T00:00:30Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
    },
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:30Z',
      message: {
        ...usage('m2', 200),
        content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'ls' } }],
      },
    },
    {
      type: 'user',
      timestamp: '2026-01-01T00:01:00Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'b', is_error: true, content: 'x' }] },
    },
  ].map((l) => JSON.stringify(l));
  assert.deepEqual(agentSummary(lines), {
    minutes: 1,
    turns: 2,
    cacheRead: 300,
    calls: 2,
    errors: 1,
    gateSec: 30,
    toolSec: 60,
    topTools: [
      ['git commit', 30],
      ['ls', 30],
    ],
  });
});

test('summarize ranks by output and time, and keeps only pairs seen in two sessions', () => {
  const call = (key, bytes = 1, ms = 1) => ({ key, bytes, ms, denied: false, rejected: false });
  const { output, slow, pairs, denied } = summarize([
    [call('a', 100), call('b', 1, 9000)],
    [call('a'), call('b'), call('c')],
  ]);
  assert.deepEqual(
    output.map((k) => k.key),
    ['a', 'b', 'c'],
  );
  assert.equal(slow[0].key, 'b');
  assert.deepEqual(pairs, [{ pair: 'a → b', count: 2, sessions: 2 }]);
  assert.deepEqual(denied, []);
});

test('summarize lists classifier denials and user rejections per call', () => {
  const call = (key, denied, rejected) => ({ key, bytes: 1, ms: 1, denied, rejected });
  const { denied } = summarize([[call('Edit', false, true), call('Read', true, false), call('Edit', false, true)]]);
  assert.deepEqual(denied, [
    { key: 'Edit', denied: 0, rejected: 2 },
    { key: 'Read', denied: 1, rejected: 0 },
  ]);
});

test('skillRuns counts slash commands and Skill calls of known skills, each running to the next prompt', () => {
  const line = (timestamp, type, content, extra) => JSON.stringify({ timestamp, type, message: { content }, ...extra });
  const runs = skillRuns(
    [
      line('2026-01-01T00:00:00Z', 'user', '<command-name>/ux-review</command-name>'),
      line('2026-01-01T00:00:01Z', 'user', [{ type: 'text', text: 'Base directory for this skill: x' }]),
      line('2026-01-01T00:00:02Z', 'user', [{ type: 'tool_result', tool_use_id: 'a', content: '' }]),
      line('2026-01-01T00:01:00Z', 'user', 'fix U3'),
      line('2026-01-01T00:01:01Z', 'assistant', [{ type: 'tool_use', name: 'Skill', input: { skill: 'ux-fix' } }]),
      line('2026-01-01T00:01:02Z', 'user', '<command-name>/clear</command-name>'),
      line('2026-01-01T00:03:01Z', 'assistant', []),
    ],
    ['ux-review', 'ux-fix'],
  );
  assert.deepEqual(
    runs.map(({ skill, ms }) => ({ skill, ms })),
    [
      { skill: 'ux-review', ms: 60_000 },
      { skill: 'ux-fix', ms: 120_000 },
    ],
  );
});

test('skillRuns ignores a Skill call replayed in an untimestamped api-request-blob', () => {
  const lines = [
    JSON.stringify({
      type: 'api-request-blob',
      message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'ux-fix' } }] },
    }),
    JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', type: 'user', message: { content: 'thanks' } }),
  ];
  assert.deepEqual(skillRuns(lines, ['ux-fix']), []);
});

test('a background task notification is not a prompt: it neither ends a skill run nor shows in the digest', () => {
  const line = (timestamp, type, content) => JSON.stringify({ timestamp, type, message: { content } });
  const lines = [
    line('2026-01-01T00:00:00Z', 'user', '<command-name>/code-audit</command-name>'),
    line('2026-01-01T00:01:00Z', 'user', '<task-notification> <task-id>a1</task-id> <status>completed</status>'),
    line('2026-01-01T00:05:00Z', 'user', 'thanks'),
  ];
  assert.deepEqual(
    skillRuns(lines, ['code-audit']).map((r) => r.ms),
    [300_000],
  );
  assert.deepEqual(
    sessionEvents(lines, ['code-audit']).map((e) => e.kind),
    ['skill', 'prompt'],
  );
});

test('skillReads: skills whose SKILL.md a Read call or a shell read opened', () => {
  const use = (name, input) =>
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
  assert.deepEqual(
    skillReads(
      [
        use('Read', { file_path: '/repo/.claude/skills/code-fix/SKILL.md' }),
        use('Bash', { command: 'sed -n 1,40p .claude/skills/ux-fix/SKILL.md' }),
        use('Bash', { command: 'grep -n x .claude/skills/release/SKILL.md' }),
        use('Edit', { file_path: '/repo/.claude/skills/screenshots/SKILL.md' }),
        use('Read', { file_path: '/repo/.claude/skills/unknown/SKILL.md' }),
      ],
      ['code-fix', 'ux-fix', 'release', 'screenshots'],
    ),
    new Set(['code-fix', 'ux-fix']),
  );
});

test('summarize leaves out pairs involving a tool or a read-only command', () => {
  const call = (key) => ({ key, bytes: 1, ms: 1, denied: false, rejected: false });
  const session = [call('Read'), call('grep'), call('Edit'), call('npm test'), call('git commit')];
  assert.deepEqual(
    summarize([session, session]).pairs.map((p) => p.pair),
    ['npm test → git commit'],
  );
});

test('answerOutcome: recommended (marked, else first), another option, free text, clarify or dismiss', () => {
  const q = { options: [{ label: 'A' }, { label: 'B (Recommended)' }, { label: 'C' }] };
  assert.equal(answerOutcome(q, 'B (Recommended)'), 'recommended');
  assert.equal(answerOutcome({ options: [{ label: 'A' }, { label: 'C' }] }, 'A'), 'recommended');
  assert.equal(answerOutcome(q, 'A, C'), 'other');
  assert.equal(answerOutcome(q, 'B, then C28'), 'own');
  assert.equal(answerOutcome(q, '', 'The user wants to clarify these questions.'), 'clarify');
  assert.equal(answerOutcome(q, '', ''), 'dismissed');
});

test('sessionEvents: prompts with the reply before, skill runs, answers, rejections, interrupts (with the running skill) and errors', () => {
  const entry = (type, content, extra) => JSON.stringify({ type, message: { content }, ...extra });
  const use = (id, name, input) => entry('assistant', [{ type: 'tool_use', id, name, input }]);
  const result = (id, content, extra) =>
    entry('user', [{ type: 'tool_result', tool_use_id: id, content, is_error: extra?.error }], extra?.entry);
  const question = { question: 'Apply the skill change?', options: [{ label: 'Apply' }, { label: 'Skip' }] };
  const events = sessionEvents(
    [
      entry('user', '<command-name>/setup-review</command-name>'),
      use('q', 'AskUserQuestion', { questions: [question] }),
      result('q', 'answered', { entry: { toolUseResult: { answers: { [question.question]: 'Skip' } } } }),
      entry('assistant', [{ type: 'text', text: 'Earlier paragraph.\n\nDone. Key sk_' + 'x'.repeat(30) }]),
      entry('user', [{ type: 'text', text: '[Request interrupted by user]' }]),
      entry('user', 'no, keep the old one'),
      use('b', 'Bash', { command: 'npm run lint -- --fix' }),
      result('b', 'lint broke\nmore', { error: true }),
      use('e', 'Edit', {}),
      result(
        'e',
        "The user doesn't want to proceed with this tool use. To tell you how to proceed, the user said:\nnot this file\n\nNote: x",
        { error: true },
      ),
      entry('user', [{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
    ],
    ['setup-review'],
  );
  assert.deepEqual(events, [
    { kind: 'skill', skill: 'setup-review' },
    {
      kind: 'answer',
      skill: 'setup-review',
      question: 'Apply the skill change?',
      answer: 'Skip',
      outcome: 'other',
      setup: true,
    },
    { kind: 'interrupt', key: 'AskUserQuestion', skill: 'setup-review' },
    { kind: 'prompt', text: 'no, keep the old one', reply: 'Done. Key […]' },
    { kind: 'error', key: 'npm run lint', text: 'lint broke' },
    { kind: 'rejected', key: 'Edit', reason: 'not this file' },
    { kind: 'interrupt', key: 'Edit', skill: undefined },
  ]);
  assert.match(digest(events), /^== skill setup-review\n {2}\? \[other, setup\] Apply the skill change\? → Skip\n/);
});

test('answerStats counts outcomes per running skill, setup proposals apart', () => {
  const answer = (skill, outcome, setup = false) => ({ kind: 'answer', skill, outcome, setup });
  assert.deepEqual(
    answerStats([[answer('ux-fix', 'recommended'), answer('ux-fix', 'own')], [answer(undefined, 'other', true)]]),
    [
      { name: '- (setup proposals)', recommended: 0, other: 1, own: 0, clarify: 0, dismissed: 0 },
      { name: 'ux-fix', recommended: 1, other: 0, own: 1, clarify: 0, dismissed: 0 },
    ],
  );
});

test('docReads: Read calls and shell reads of repo docs, whole unless narrowed', () => {
  const use = (name, input) => JSON.stringify({ message: { content: [{ type: 'tool_use', name, input }] } });
  const lines = [
    use('Read', { file_path: '/repo/docs/dev/frontend.md' }),
    use('Read', { file_path: '/repo/docs/dev/frontend.md', offset: 40, limit: 20 }),
    use('Read', { file_path: '/repo/public/panel.tsx' }),
    use('Bash', { command: 'cat CLAUDE.md' }),
    use('Bash', { command: 'grep x docs/dev/data.md' }),
    use('Bash', { command: 'for f in README.md docs/dev/data.md; do sed -n 1,9p "$f"; done' }),
    use('Read', { file_path: '/home/u/.claude/CLAUDE.md' }),
    use('Bash', { command: "git commit -F - <<'EOF' | tail -1\nFollow CLAUDE.md\nEOF" }),
    use('Bash', { command: "python3 - <<'EOF'\nopen('docs/dev/data.md')\nEOF\ncat README.md" }),
    use('Bash', { command: 'grep -n x CLAUDE.md docs/dev/data.md | head -20 && sed -n 1,5p README.md' }),
  ];
  assert.deepEqual(docReads(lines), [
    { doc: 'docs/dev/frontend.md', whole: true },
    { doc: 'docs/dev/frontend.md', whole: false },
    { doc: 'CLAUDE.md', whole: true },
    { doc: 'README.md', whole: false },
    { doc: 'docs/dev/data.md', whole: false },
    { doc: 'README.md', whole: true },
    { doc: 'README.md', whole: false },
  ]);
});

test('docReadStats: reads, whole reads and sessions per doc, most read first', () => {
  const stats = docReadStats([
    [
      { doc: 'docs/a.md', whole: true },
      { doc: 'docs/b.md', whole: false },
    ],
    [{ doc: 'docs/b.md', whole: true }],
  ]);
  assert.deepEqual(stats, [
    { doc: 'docs/b.md', reads: 2, whole: 1, sessions: 2 },
    { doc: 'docs/a.md', reads: 1, whole: 1, sessions: 1 },
  ]);
});

test('costDelta: the change since the last run, flagged past 25% slower; nothing without a last run', () => {
  assert.equal(costDelta(undefined, 10, undefined), '');
  assert.equal(costDelta(20, 22, '2026-10-12T08:00:00Z'), ' (+10% since 2026-10-12)');
  assert.equal(costDelta(20, 40, '2026-10-12T08:00:00Z'), ' (+100% since 2026-10-12) ⚠');
  assert.equal(costDelta(20, 15, '2026-10-12T08:00:00Z'), ' (-25% since 2026-10-12)');
});

test('costLine: size and change since the last run; a failed run is marked not recorded, with no change', () => {
  const last = { at: '2026-10-12T08:00:00Z', seconds: { 'test:e2e': 50 } };
  assert.equal(
    costLine('test:e2e', { seconds: 60, out: 'a\nb', status: 0 }, last),
    'npm run test:e2e: 60 s, 0.0 KB, 2 lines (+20% since 2026-10-12)',
  );
  assert.equal(
    costLine('test:e2e', { seconds: 9.9, out: 'x', status: 1 }, last),
    'npm run test:e2e: 9.9 s, 0.0 KB, 1 lines, exit 1, not recorded',
  );
});

test('tokens: input with cache writes and reads, and output, the max per response id', () => {
  const response = (id, usage) => ({ type: 'assistant', message: { id, usage } });
  const used = tokens([
    response('m1', {
      input_tokens: 1,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 100,
      output_tokens: 5,
    }),
    response('m1', {
      input_tokens: 1,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 100,
      output_tokens: 20,
    }),
    response('m2', { input_tokens: 2, output_tokens: 3 }),
    { type: 'user', message: { content: 'hi' } },
  ]);
  assert.deepEqual(used, { input: 113, output: 23 });
});

test('skillRuns counts the tokens of each run', () => {
  const runs = skillRuns(
    [
      JSON.stringify({
        timestamp: '2026-01-01T00:00:00Z',
        type: 'user',
        message: { content: '<command-name>/ux-fix</command-name>' },
      }),
      JSON.stringify({
        timestamp: '2026-01-01T00:00:01Z',
        type: 'assistant',
        message: { id: 'a', usage: { input_tokens: 7, output_tokens: 2 } },
      }),
      JSON.stringify({ timestamp: '2026-01-01T00:00:02Z', type: 'user', message: { content: 'next' } }),
      JSON.stringify({
        timestamp: '2026-01-01T00:00:03Z',
        type: 'assistant',
        message: { id: 'b', usage: { input_tokens: 99, output_tokens: 9 } },
      }),
    ],
    ['ux-fix'],
  );
  assert.deepEqual(runs[0].tokens, { input: 7, output: 2 });
});

test('checkStats: commits blocked and by which step, median run, slowest step; full runs apart', () => {
  const rows = [
    { run: 'commit', seconds: { test: 3, e2e: 18 }, failed: [] },
    { run: 'commit', seconds: { test: 3, lint: 2 }, failed: ['lint'] },
    { run: 'commit', seconds: { test: 4 }, failed: [] },
    { run: 'full', seconds: { test: 6 }, failed: [] },
  ];
  assert.equal(
    checkStats(rows),
    '3 commits (1 blocked: lint ×1), median 4 s, slowest step e2e 18 s · 1 full runs (0 failed), median 6 s, slowest step test 6 s',
  );
  assert.equal(checkStats([]), '0 commits (0 blocked) · 0 full runs (0 failed)');
});

test('e2eRunStats: hook e2e runs grouped by the projects asked, then by those run', () => {
  const row = (asked, ran) => ({ asked, ran, ok: true });
  const rows = [
    row(['desktop', 'phone'], ['phone']),
    row(['desktop', 'phone'], []),
    row(['desktop', 'phone'], ['phone']),
    row(['desktop'], ['desktop']),
  ];
  assert.equal(e2eRunStats(rows), 'desktop+phone ×3: phone 2, skipped 1 · desktop ×1: desktop 1');
  assert.equal(e2eRunStats([]), 'none');
});
