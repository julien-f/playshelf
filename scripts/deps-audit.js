'use strict';

// Read-only checks for the dependency-audit skill: declared packages nothing references, and bare
// imports nothing declares. Exits 1 when either finds something.
//   node scripts/deps-audit.js [--full]
// --full also runs npm's own checks and prints only their problems: vulnerabilities, a lockfile out of
// sync, an invalid tree (exit 1), outdated packages and collapsible duplicates (listed, not failing).

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { builtinModules } = require('node:module');

const ROOT = path.join(__dirname, '..');
const SOURCE_DIRS = ['lib', 'public', 'scripts', 'test', 'e2e'];
const SOURCE_FILES = ['server.js', 'vite.config.js', 'eslint.config.mjs', 'playwright.config.ts'];
// Required peer of @babel/eslint-parser, never imported (architecture.md's eslint.config.mjs bullet).
const NOT_IMPORTED = new Set(['@babel/core']);

// node_modules skipped: a dependency's own imports would count as this repo using a package.
const walk = (dir, keep) =>
  fs
    .readdirSync(dir, { recursive: true })
    .filter((f) => !f.split(path.sep).includes('node_modules'))
    .map((f) => path.join(dir, f))
    .filter(keep);

function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function importedPackages(source) {
  const names = new Set();
  const statements =
    /^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|\b(?:require|import)\(['"]([^'"]+)['"]\)/gm;
  for (const m of source.matchAll(statements)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
    if (builtinModules.includes(spec) || spec.startsWith('virtual:')) continue;
    names.add(packageName(spec));
  }
  return names;
}

function unusedDeps(declared, haystack) {
  const mentioned = (name) =>
    new RegExp(`(?<![\\w@/-])${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?![\\w-])`).test(haystack);
  return declared.filter((name) => !NOT_IMPORTED.has(name) && !mentioned(name));
}

function phantomImports(imported, declared) {
  return [...imported].filter((name) => !declared.includes(name)).sort();
}

const npm = (args) => {
  const r = spawnSync('npm', args, { cwd: ROOT, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

// `run(args)` returns { status, stdout, stderr }; injectable for tests. Each entry: { title, items, fails }.
function npmChecks(run = npm) {
  const audit = JSON.parse(run(['audit', '--json']).stdout || '{}').metadata?.vulnerabilities ?? {};
  const vulns = Object.entries(audit).filter(([level, n]) => level !== 'total' && n > 0);
  const ci = run(['ci', '--dry-run']);
  const ls = run(['ls', '--all']);
  const outdated = Object.entries(JSON.parse(run(['outdated', '--json']).stdout || '{}'));
  // One line per nested copy: the same change repeats.
  const dedupe = [
    ...new Set(
      run(['dedupe', '--dry-run'])
        .stdout.split('\n')
        .filter((l) => /^(add|change|remove) /.test(l)),
    ),
  ];
  const errLines = (r) => (r.stdout + r.stderr).split('\n').filter((l) => /invalid|ERR|ERESOLVE/.test(l));
  return [
    { title: 'Vulnerabilities (npm audit)', items: vulns.map(([level, n]) => `${n} ${level}`), fails: true },
    { title: 'Lockfile out of sync (npm ci --dry-run)', items: ci.status ? errLines(ci) : [], fails: true },
    { title: 'Invalid tree (npm ls --all)', items: ls.status ? errLines(ls) : [], fails: true },
    {
      title: 'Behind its own range: npm update',
      items: outdated.filter(([, v]) => v.current !== v.wanted).map(([n, v]) => `${n} ${v.current} → ${v.wanted}`),
    },
    {
      title: 'Range bump available: npm install <pkg>@latest',
      items: outdated.filter(([, v]) => v.wanted !== v.latest).map(([n, v]) => `${n} ${v.wanted} → ${v.latest}`),
    },
    { title: 'Collapsible duplicates (npm dedupe --dry-run)', items: dedupe },
  ];
}

function main() {
  const usage = 'usage: node scripts/deps-audit.js [--full]';
  const args = process.argv.slice(2);
  if (args.some((a) => a !== '--full')) {
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  const pkg = require(path.join(ROOT, 'package.json'));
  const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const sources = [
    // Its own test's fixtures would count as uses.
    ...SOURCE_DIRS.flatMap((d) =>
      walk(path.join(ROOT, d), (p) => /\.(c?js|mjs|ts|tsx)$/.test(p) && !p.endsWith('depsAudit.test.js')),
    ),
    ...SOURCE_FILES.map((f) => path.join(ROOT, f)),
  ].map((f) => fs.readFileSync(f, 'utf8'));
  const docs = walk(path.join(ROOT, 'docs'), (p) => p.endsWith('.md')).map((f) => fs.readFileSync(f, 'utf8'));
  const imported = new Set(sources.flatMap((s) => [...importedPackages(s)]));

  const report = {
    'Declared but unused': unusedDeps(declared, [...sources, ...docs, JSON.stringify(pkg.scripts)].join('\n')),
    'Imported but undeclared': phantomImports(imported, declared),
  };
  const checks = [
    ...Object.entries(report).map(([title, items]) => ({ title, items, fails: true })),
    ...(args.includes('--full') ? npmChecks() : []),
  ];
  let found = false;
  for (const { title, items, fails } of checks) {
    console.log(`${title}: ${items.length ? '' : 'none'}`);
    for (const item of items) console.log(`  ${item}`);
    found ||= Boolean(fails) && items.length > 0;
  }
  process.exitCode = found ? 1 : 0;
}

if (require.main === module) main();

module.exports = { importedPackages, unusedDeps, phantomImports, walk, npmChecks };
