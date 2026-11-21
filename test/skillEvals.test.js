'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { routedTo, dryRunSummary, pool } = require('../scripts/skill-evals');

const assistant = (...content) => ({ type: 'assistant', message: { content } });
const use = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
const result = (id, content, isError) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
});

test('routedTo: the skill the first tool call loads, past ToolSearch; else none, naming the tool', () => {
  assert.equal(
    routedTo([assistant(use('a', 'ToolSearch')), assistant(use('b', 'Skill', { skill: 'release' }))]),
    'release',
  );
  assert.equal(routedTo([assistant({ type: 'text', text: 'hm' }), assistant(use('a', 'Read'))]), '- (Read)');
  assert.equal(routedTo([{ type: 'result' }]), '-');
});

// How calls are classified (denied, failed) is callSummary's, tested in template-CLAUDE.md's test/transcripts.test.js.
test('dryRunSummary: cost and turns from the result, the calls counted from the other entries', () => {
  const callSummary = (lines, names) => ({ calls: lines.length, denied: names.length, errors: [] });
  const s = dryRunSummary(
    [
      assistant(use('a', 'Read')),
      result('a', 'ok'),
      { type: 'result', total_cost_usd: 0.5, num_turns: 4, duration_ms: 90000 },
    ],
    ['x'],
    callSummary,
  );
  assert.deepEqual(s, { cost: 0.5, turns: 4, minutes: 1.5, calls: 2, denied: 1, errors: [] });
});

test('pool runs every job, at most `limit` at once, results in order', async () => {
  let running = 0;
  let peak = 0;
  const job = (n) => async () => {
    peak = Math.max(peak, ++running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return n;
  };
  assert.deepEqual(await pool([1, 2, 3, 4, 5].map(job), 2), [1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
});
