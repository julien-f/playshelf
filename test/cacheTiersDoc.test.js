'use strict';

// data.md's cache tier table restates lib/cache.js's GROUPS, and once drifted from it in ~12 places (C310).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'dev', 'data.md'), 'utf8');
const section = doc.split('\n## Cache tiers\n')[1].split('\n## ')[0];
const rows = section
  .split('\n')
  .filter((line) => line.startsWith('| `'))
  .map((line) => {
    const [prefixes, env] = line.split('|').slice(1, 3);
    return { prefixes: [...prefixes.matchAll(/`([^`]+)`/g)].map((m) => m[1]).sort(), env: env.trim().slice(1, -1) };
  });

// A distinct TTL per documented env var, set before lib/config.js reads them, tells each group's var apart.
rows.forEach(({ env }, i) => (process.env[env] = String(i + 1)));
const { GROUPS } = require('../lib/cache');

test("data.md's cache tier table lists each GROUPS entry's prefixes and TTL env var", () => {
  assert.ok(rows.length > 0, 'no table rows found under ## Cache tiers');
  const documented = rows.map(({ prefixes, env }, i) => ({ prefixes, env, ttl: (i + 1) * 60 * 1000 }));
  const actual = GROUPS.map((g) => ({
    prefixes: [...g.prefixes].sort(),
    env: documented.find((d) => d.ttl === g.ttl)?.env ?? `none (ttl ${g.ttl})`,
    ttl: g.ttl,
  }));
  const byPrefixes = (a, b) => a.prefixes[0].localeCompare(b.prefixes[0]);
  assert.deepEqual(actual.sort(byPrefixes), documented.sort(byPrefixes));
});
