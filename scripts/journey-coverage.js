'use strict';

// Derives which journey steps in docs/dev/journeys.md the e2e tests lock (★), from test titles:
// `A1: …` covers A1's built steps, `A1.1,3-4: …` those steps, `A1 edge: …` A1's edges.
// Prints one line per journey; `--check` (run by `npm run check`) fails on a title that maps to
// no journey or step, or to a ◇ step, and on a ◇ naming no U-item open in improvements.md.
// `--targets` lists every ◇ instead. `--results=<file>` (Playwright's JSON report) counts only
// passing tests.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function parseJourneys(md) {
  const journeys = new Map();
  let journey = null;
  let inSteps = false;
  for (const line of md.split('\n')) {
    const heading = /^### ([A-Z]\d+) (.+)$/.exec(line);
    const target = journey && !heading && /◇(?: (U\d+))?/.exec(line);
    if (target) journey.targets.push({ text: line.replace(/^[ -]*/, ''), item: target[1] ?? null });
    if (heading) {
      journey = { id: heading[1], title: heading[2], steps: new Map(), targets: [] };
      journeys.set(journey.id, journey);
      inSteps = false;
    } else if (journey && /^- \*\*(Steps|Or)\*\*:/.test(line)) inSteps = true;
    else if (/^- /.test(line)) inSteps = false;
    else if (journey && inSteps) {
      const step = /^ {2}(\d+)\. (.+)$/.exec(line);
      if (step) journey.steps.set(Number(step[1]), { target: step[2].includes('◇') });
    }
  }
  return journeys;
}

// "1,3-4" → [1, 3, 4]
const expandSteps = (spec) =>
  spec.split(',').flatMap((part) => {
    const [from, to = from] = part.split('-').map(Number);
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  });

function parseTitle(title) {
  const m = /^([A-Z]\d+)(?:\.(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*))?( edge)?: /.exec(title);
  if (!m || (m[2] && m[3])) return null;
  return { id: m[1], steps: m[2] ? expandSteps(m[2]) : null, edge: Boolean(m[3]) };
}

// tests: [{ title, passed }] → { journeys: Map(id → { locked: Set, edges }), problems: [] }
function coverage(journeys, tests) {
  const out = new Map([...journeys.keys()].map((id) => [id, { locked: new Set(), edges: 0 }]));
  const problems = [];
  for (const { title, passed } of tests) {
    const ref = parseTitle(title);
    const journey = ref && journeys.get(ref.id);
    if (!journey) {
      problems.push(`"${title}": no journey (title it "<J-id>[.<steps>][ edge]: …")`);
      continue;
    }
    if (ref.edge) {
      if (passed) out.get(ref.id).edges++;
      continue;
    }
    const steps = ref.steps ?? [...journey.steps].filter(([, s]) => !s.target).map(([n]) => n);
    for (const n of steps) {
      const step = journey.steps.get(n);
      if (!step) problems.push(`"${title}": ${ref.id} has no step ${n}`);
      else if (step.target) problems.push(`"${title}": ${ref.id}.${n} is ◇ — drop the ◇ once it's built`);
      else if (passed) out.get(ref.id).locked.add(n);
    }
  }
  return { journeys: out, problems };
}

function format(journeys, cov) {
  return [...journeys.values()]
    .map((j) => {
      const { locked, edges } = cov.get(j.id);
      const marks = [...j.steps].map(([n, s]) => (s.target ? '◇' : locked.has(n) ? '★' : '·')).join('');
      return `${j.id.padEnd(4)}${marks.padEnd(8)}${(edges ? `+${edges} edge` : '').padEnd(9)}${j.title}`;
    })
    .join('\n');
}

const OPEN_ITEM = /^- \*\*(U\d+) ·/gm;

// A ◇ names the improvements.md item that tracks it, so a closed item's ◇ can't linger.
function targetProblems(journeys, improvementsMd) {
  const open = new Set([...improvementsMd.matchAll(OPEN_ITEM)].map((m) => m[1]));
  return [...journeys.values()].flatMap((j) =>
    j.targets.flatMap(({ item }) =>
      !item
        ? [`${j.id}: ◇ names no U-item (write "◇ U<n>", filed in improvements.md)`]
        : open.has(item)
          ? []
          : [`${j.id}: ◇ ${item} is not open in improvements.md (drop the ◇ or re-point it)`],
    ),
  );
}

const formatTargets = (journeys) =>
  [...journeys.values()]
    .flatMap((j) => j.targets.map((t) => `${j.id.padEnd(4)}${(t.item ?? '?').padEnd(6)}${t.text}`))
    .join('\n');

// Playwright's JSON report → [{ title, passed }], one per title across projects (widths); a test
// passes when no project's last result failed it.
function testsFromReport(report) {
  const specs = (suite) => [...(suite.specs ?? []), ...(suite.suites ?? []).flatMap(specs)];
  const passed = new Map();
  for (const spec of report.suites.flatMap(specs)) {
    const ok = spec.tests.every(
      (t) => t.results.length === 0 || ['passed', 'skipped'].includes(t.results.at(-1).status),
    );
    passed.set(spec.title, (passed.get(spec.title) ?? true) && ok);
  }
  return [...passed].map(([title, ok]) => ({ title, passed: ok }));
}

function main() {
  const args = process.argv.slice(2);
  const results = args.find((a) => a.startsWith('--results='))?.split('=')[1];
  const report = results
    ? JSON.parse(fs.readFileSync(results, 'utf8'))
    : JSON.parse(
        execFileSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--list', '--reporter=json'], {
          cwd: ROOT,
          encoding: 'utf8',
        }),
      );
  const read = (doc) => fs.readFileSync(path.join(ROOT, 'docs/dev', doc), 'utf8');
  const journeys = parseJourneys(read('journeys.md'));
  const { journeys: cov, problems } = coverage(journeys, testsFromReport(report));
  problems.push(...targetProblems(journeys, read('improvements.md')));
  if (args.includes('--targets')) console.log(formatTargets(journeys));
  else if (!args.includes('--check')) console.log(format(journeys, cov));
  if (problems.length) {
    console.error(`journey-coverage:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { parseJourneys, parseTitle, coverage, format, targetProblems, formatTargets, testsFromReport };
