'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { importedPackages, unusedDeps, phantomImports, walk, npmChecks } = require('../scripts/deps-audit');

test('importedPackages: bare specifiers from import, export, require and import(), reduced to package names', () => {
  const source = `
import { render } from 'solid-js/web';
import {
  Router,
} from '@solidjs/router';
import 'hls.js';
export { x } from 'dotenv';
const express = require('express');
const lazy = await import('@vates/data-table-solid/deep/path');
import fs from 'node:fs';
const path = require('path');
import { y } from './local';
`;
  assert.deepStrictEqual([...importedPackages(source)].sort(), [
    '@solidjs/router',
    '@vates/data-table-solid',
    'dotenv',
    'express',
    'hls.js',
    'solid-js',
  ]);
});

test('importedPackages: ignores "from" in prose and strings', () => {
  const source = `// picks a value from 'nothing' to show\nconst s = 'from "unknown"';\n`;
  assert.deepStrictEqual([...importedPackages(source)], []);
});

test('unusedDeps: a name only inside a longer package name is unused; @babel/core never is', () => {
  const haystack = `import solid from 'vite-plugin-solid';\n"build": "concurrently a b"`;
  assert.deepStrictEqual(unusedDeps(['vite', 'vite-plugin-solid', 'concurrently', '@babel/core'], haystack), ['vite']);
});

test('phantomImports: imported but not declared', () => {
  assert.deepStrictEqual(phantomImports(new Set(['express', 'left-pad']), ['express']), ['left-pad']);
});

test("walk: skips node_modules, whose imports are a dependency's, not this repo's", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-audit-'));
  fs.mkdirSync(path.join(dir, 'node_modules/pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.js'), '');
  fs.writeFileSync(path.join(dir, 'node_modules/pkg/b.js'), '');
  assert.deepStrictEqual(
    walk(dir, (p) => p.endsWith('.js')),
    [path.join(dir, 'a.js')],
  );
  fs.rmSync(dir, { recursive: true });
});

test('every package the server requires at runtime is a production dependency', () => {
  const root = path.join(__dirname, '..');
  const files = ['server.js', ...fs.readdirSync(path.join(root, 'lib')).map((f) => path.join('lib', f))];
  const imported = new Set(files.flatMap((f) => [...importedPackages(fs.readFileSync(path.join(root, f), 'utf8'))]));
  // A dev-only package crashes `npm install --omit=dev` at startup.
  assert.deepStrictEqual(phantomImports(imported, Object.keys(require('../package.json').dependencies)), []);
});

test('npmChecks: failing problems from audit, ci and ls; outdated split by column; dedupe lines once', () => {
  const outputs = {
    audit: { stdout: JSON.stringify({ metadata: { vulnerabilities: { low: 0, moderate: 2, total: 2 } } }) },
    ci: { status: 1, stdout: '', stderr: 'npm error code EUSAGE\nnoise' },
    ls: { status: 1, stdout: '', stderr: 'npm error code ELSPROBLEMS\nnpm error missing: left-pad@1.3.0' },
    outdated: {
      stdout: JSON.stringify({
        a: { current: '1.0.0', wanted: '1.1.0', latest: '1.1.0' },
        b: { current: '2.0.0', wanted: '2.0.0', latest: '3.0.0' },
        c: { wanted: '1.0.0', latest: '1.0.0' },
      }),
    },
    dedupe: { stdout: 'change semver 6.3.1 => 6.3.2\nchange semver 6.3.1 => 6.3.2\nup to date\n' },
  };
  const run = (args) => ({ status: 0, stderr: '', ...outputs[args[0]] });
  assert.deepStrictEqual(
    npmChecks(run).map(({ items, fails }) => [items, Boolean(fails)]),
    [
      [['2 moderate'], true],
      [['npm error code EUSAGE'], true],
      [['npm error code ELSPROBLEMS', 'npm error missing: left-pad@1.3.0'], true],
      [[], false],
      [['a 1.0.0 → 1.1.0', 'c not installed (npm ci)'], false],
      [['b 2.0.0 → 3.0.0'], false],
      [['change semver 6.3.1 => 6.3.2'], false],
    ],
  );
});

test('npmChecks: a failed npm run is a failing item, never "none"', () => {
  const outputs = {
    audit: { status: 1, stdout: JSON.stringify({ error: { summary: 'request to registry failed' } }) },
    ci: { status: 1, stdout: '', stderr: 'npm error code ENOTCACHED' },
    ls: { status: 1, stdout: '', stderr: 'something unexpected' },
    outdated: { stdout: 'npm warn not json' },
    dedupe: { stdout: '' },
  };
  const run = (args) => ({ status: 0, stderr: '', ...outputs[args[0]] });
  const [audit, ci, ls, , behind] = npmChecks(run);
  assert.deepStrictEqual(audit.items, ['npm audit failed: request to registry failed']);
  assert.deepStrictEqual(ci.items, ['failed, not a sync problem: npm error code ENOTCACHED']);
  assert.deepStrictEqual(ls.items, ['exit 1']);
  assert.deepStrictEqual(behind.items, []);
});
