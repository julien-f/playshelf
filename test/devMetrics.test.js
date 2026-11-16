'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('record appends time-stamped rows that history reads back, oldest first; none yet reads as empty', () => {
  process.env.METRICS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-'));
  const { record, history } = require('../scripts/dev-metrics');
  assert.deepEqual(history('x'), []);
  record('x', { a: 1 });
  record('x', { a: 2 });
  const rows = history('x');
  assert.deepEqual(
    rows.map((r) => r.a),
    [1, 2],
  );
  assert.ok(!Number.isNaN(Date.parse(rows[0].at)));
  fs.rmSync(process.env.METRICS_DIR, { recursive: true });
  delete process.env.METRICS_DIR;
});
