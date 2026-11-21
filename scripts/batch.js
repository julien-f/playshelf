'use strict';

// Parallel fix batches (.claude/skills/fix/BATCH.md): plan lanes, track progress, merge a lane.
//   node scripts/batch.js plan [--lanes=6] <C66 U12 …>   lanes sharing no cited code + estimate; writes the manifest
//   node scripts/batch.js status                         done/total and time left, per lane
//   node scripts/batch.js merge <branch>                 merge --no-ff --no-commit, union CHANGELOG, apply the lane's closed and narrowed items
//   node scripts/batch.js record                         appends the batch's per-item times to the history

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { missingEntry } = require('./changelog-check');

const ROOT = path.join(__dirname, '..');
const BACKLOGS = { C: 'docs/dev/code-backlog.md', U: 'docs/dev/improvements.md' };
const STATE_DIR = path.join(ROOT, '.claude/batch');
const MANIFEST = path.join(STATE_DIR, 'manifest.json');
const HISTORY = path.join(STATE_DIR, 'history.jsonl');
const UNITS = { S: 1, M: 2, L: 4 };
// Fallbacks until the history has data: this repo's first batch (2026-10-11) ran ~2.3 min per unit
// and ~45 min from the last lane to the end of the review (serial items, look, /code-review).
const DEFAULT_MIN_PER_UNIT = 2.3;
const DEFAULT_AFTER_LANES_MIN = 45;

const ITEM_LINE = /^- \*\*([CU]\d+) · (\w+)(?: · ([^*]+?))?\*\* — (.*)$/;
// A file reference with its optional lines (`:12`, `:7-9`, `:5,30`): a path, a bare `name.ext` in
// backticks (audits often drop the directory, resolved against the tracked files), or a lone `:200`
// continuing the previous file.
const REF =
  /\b(server\.js|(?:public|lib|test|e2e|scripts)\/[\w./-]+\.\w+)(?::(\d+(?:[-,]\d+)*))?|`(?!server\.js)([\w-]+\.(?:js|mjs|ts|tsx))(?::(\d+(?:[-,]\d+)*))?`|`:(\d+(?:[-,]\d+)*)`/g;
// Two items citing one file closer than this many lines share a lane: their edits likely overlap.
const LINE_WINDOW = 80;

// `knownFiles`: the repo's tracked paths; a bare name naming exactly one of them counts as that file.
function parseItems(text, knownFiles = []) {
  const byBase = new Map();
  for (const f of knownFiles) {
    const base = path.basename(f);
    byBase.set(base, byBase.has(base) ? null : f);
  }
  const items = new Map();
  for (const line of text.split('\n')) {
    const m = ITEM_LINE.exec(line);
    if (!m) continue;
    const [, id, severity, third, body] = m;
    const effort = id.startsWith('C') && third in UNITS ? third : 'M';
    // file → cited lines, or null when the item never cites a line in it (the whole file); a bare
    // mention beside cited lines is context, not a claim on the whole file.
    const lines = {};
    let last;
    for (const [, full, fullLines, bare, bareLines, more] of body.matchAll(REF)) {
      const file = full ?? (bare ? byBase.get(bare) : last);
      if (!file) continue;
      const cited = (fullLines ?? bareLines ?? more)?.split(/[-,]/).map(Number) ?? [];
      lines[file] = [...(lines[file] ?? []), ...cited];
      last = file;
    }
    for (const file of Object.keys(lines)) if (!lines[file].length) lines[file] = null;
    items.set(id, { id, severity, effort, files: Object.keys(lines), lines });
  }
  return items;
}

// Whether two items' citations of one file may overlap: either cites it whole, or two lines are close.
const overlaps = (a, b) => a === null || b === null || a.some((x) => b.some((y) => Math.abs(x - y) < LINE_WINDOW));

// Items citing nearby code in a file land in the same lane (git merges the rest); components are then
// packed, largest first, into the least-loaded of `maxLanes` lanes. Items naming no file are returned
// apart, to place by hand.
function planLanes(items, maxLanes) {
  const parent = new Map(items.map((it) => [it.id, it.id]));
  const find = (x) => (parent.get(x) === x ? x : find(parent.get(x)));
  for (const [i, a] of items.entries())
    for (const b of items.slice(i + 1))
      if (a.files.some((f) => f in b.lines && overlaps(a.lines[f], b.lines[f]))) parent.set(find(a.id), find(b.id));
  const groups = new Map();
  for (const it of items.filter((i) => i.files.length)) {
    const root = find(it.id);
    groups.set(root, [...(groups.get(root) ?? []), it]);
  }
  const units = (list) => list.reduce((sum, it) => sum + UNITS[it.effort], 0);
  const lanes = Array.from({ length: maxLanes }, () => []);
  for (const group of [...groups.values()].sort((a, b) => units(b) - units(a)))
    lanes.sort((a, b) => units(a) - units(b))[0].push(...group);
  return {
    lanes: lanes.filter((l) => l.length).map((l, i) => ({ name: String.fromCharCode(65 + i), items: l })),
    unplaced: items.filter((i) => !i.files.length),
  };
}

function readHistory() {
  if (!fs.existsSync(HISTORY)) return [];
  return fs
    .readFileSync(HISTORY, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function historyRates(history) {
  return {
    minPerUnit: median(history.filter((h) => h.item).map((h) => h.minutes / UNITS[h.effort])) ?? DEFAULT_MIN_PER_UNIT,
    afterLanesMin:
      median(history.filter((h) => h.afterLanesMin != null).map((h) => h.afterLanesMin)) ?? DEFAULT_AFTER_LANES_MIN,
  };
}

// Item id → epoch seconds of the earliest non-merge commit since `since` naming it (git log lists newest
// first, and a later follow-up can name the item too).
function doneTimes(ids, since, logText) {
  const done = new Map();
  for (const entry of logText.split('\x1e')) {
    const [ct, ...msg] = entry.trim().split('\n');
    if (!ct || Number(ct) < since) continue;
    const text = msg.join('\n');
    for (const id of ids)
      if (new RegExp(`\\b${id}\\b`).test(text)) done.set(id, Math.min(done.get(id) ?? Infinity, Number(ct)));
  }
  return done;
}

// Per lane: done/total, minutes left at the lane's own pace (the history's until its first item), and
// minutes a finished lane has waited on slower lanes — up to the last lane's end once all are done, so
// the merge/review phase doesn't count.
function laneStatus(manifest, done, nowSec, rates) {
  const allDone = manifest.lanes.every((l) => l.items.every((it) => done.has(it.id)));
  const until = allDone ? Math.max(manifest.start, ...[...done.values()]) : nowSec;
  return manifest.lanes.map((lane) => {
    const finished = lane.items.filter((it) => done.has(it.id));
    const unitsDone = finished.reduce((s, it) => s + UNITS[it.effort], 0);
    const unitsLeft = lane.items.reduce((s, it) => s + UNITS[it.effort], 0) - unitsDone;
    const last = Math.max(manifest.start, ...finished.map((it) => done.get(it.id)));
    const pace = unitsDone ? (last - manifest.start) / 60 / unitsDone : rates.minPerUnit;
    return {
      name: lane.name,
      done: finished.length,
      total: lane.items.length,
      minLeft: Math.max(0, unitsLeft * pace - (nowSec - last) / 60),
      idleMin: finished.length === lane.items.length ? (until - last) / 60 : 0,
    };
  });
}

function formatStatus(lanes, rates) {
  const done = lanes.reduce((s, l) => s + l.done, 0);
  const total = lanes.reduce((s, l) => s + l.total, 0);
  const lanesLeft = Math.max(0, ...lanes.map((l) => l.minLeft));
  const idle = lanes.reduce((s, l) => s + l.idleMin, 0);
  const lines = lanes.map(
    (l) =>
      `  lane ${l.name}: ${l.done}/${l.total}${l.done === l.total ? ` done, idle ${Math.round(l.idleMin)} min` : `, ~${Math.ceil(l.minLeft)} min left`}`,
  );
  return [
    `batch ${done}/${total} · ~${Math.ceil(lanesLeft + rates.afterLanesMin)} min left (lanes ~${Math.ceil(lanesLeft)}, then merge/review ~${rates.afterLanesMin})${idle >= 1 ? ` · ${Math.round(idle)} lane-min idle` : ''}`,
    ...lines,
  ].join('\n');
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
const gitLog = (since) => git('log', '--all', '--no-merges', `--since=${since}`, '--format=%x1e%ct%n%B');

function readBacklogs() {
  const tracked = git('ls-files').split('\n').filter(Boolean);
  return new Map(
    Object.values(BACKLOGS).flatMap((f) => [...parseItems(fs.readFileSync(path.join(ROOT, f), 'utf8'), tracked)]),
  );
}

function plan(ids, maxLanes) {
  const all = readBacklogs();
  const missing = ids.filter((id) => !all.has(id));
  if (missing.length) throw new Error(`not in a backlog: ${missing.join(' ')}`);
  const { lanes, unplaced } = planLanes(
    ids.map((id) => all.get(id)),
    maxLanes,
  );
  const rates = historyRates(readHistory());
  const manifest = {
    start: Math.floor(Date.now() / 1000),
    lanes: lanes.map((l) => ({ name: l.name, items: l.items.map(({ id, effort }) => ({ id, effort })) })),
  };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
  for (const l of lanes)
    console.log(
      `lane ${l.name}: ${l.items.map((it) => `${it.id}(${it.effort})`).join(' ')}\n  files: ${[...new Set(l.items.flatMap((it) => it.files))].join(' ')}`,
    );
  if (unplaced.length) console.log(`no file named, place by hand: ${unplaced.map((it) => it.id).join(' ')}`);
  console.log(formatStatus(laneStatus(manifest, new Map(), manifest.start, rates), rates));
}

function readManifest() {
  if (!fs.existsSync(MANIFEST)) throw new Error('no batch: run `node scripts/batch.js plan` first');
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}

function status() {
  const manifest = readManifest();
  const ids = manifest.lanes.flatMap((l) => l.items.map((it) => it.id));
  const rates = historyRates(readHistory());
  const done = doneTimes(ids, manifest.start, gitLog(manifest.start));
  console.log(formatStatus(laneStatus(manifest, done, Date.now() / 1000, rates), rates));
}

// Keeps both sides of each conflict hunk (diff3 base dropped): lanes only add CHANGELOG lines.
function unionConflicts(text) {
  return text.replace(
    /<<<<<<< [^\n]*\n([\s\S]*?)(?:\|\|\|\|\|\|\| [^\n]*\n[\s\S]*?)?=======\n([\s\S]*?)>>>>>>> [^\n]*\n/g,
    '$1$2',
  );
}

// Drops the items' lines; a section left empty reads `None open.`, as the backlogs require.
function closeItems(text, ids) {
  return text
    .split('\n')
    .filter((l) => !ids.some((id) => l.startsWith(`- **${id} ·`)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^(## [^\n]+\n)\n+(?=## |$(?![\s\S]))/gm, '$1\nNone open.\n\n')
    .replace(/\n\n$/, '\n');
}

// A lane's backlog edits against the merge base: lines it deleted (closed) and lines it rewrote (narrowed).
function laneBacklogChanges(baseText, branchText) {
  const items = (text) =>
    new Map(
      text
        .split('\n')
        .map((l) => [/^- \*\*([CU]\d+) ·/.exec(l)?.[1], l])
        .filter(([id]) => id),
    );
  const base = items(baseText);
  const branch = items(branchText);
  const closed = [...base.keys()].filter((id) => !branch.has(id));
  const narrowed = new Map([...branch].filter(([id, line]) => base.has(id) && base.get(id) !== line));
  return { closed, narrowed };
}

function applyLaneChanges(text, { closed, narrowed }) {
  const rewritten = text
    .split('\n')
    .map((l) => narrowed.get(/^- \*\*([CU]\d+) ·/.exec(l)?.[1]) ?? l)
    .join('\n');
  return closeItems(rewritten, closed);
}

// `files`: the merge's staged paths. A lane whose commits needed no entry makes a merge the hook rejects.
const mergeHint = (files) =>
  missingEntry(files) ? 'its commits added no CHANGELOG entry: commit with SKIP_CHANGELOG=1' : '';

function merge(branch) {
  const base = git('merge-base', 'HEAD', branch).trim();
  const changes = Object.values(BACKLOGS).map((file) =>
    laneBacklogChanges(git('show', `${base}:${file}`), git('show', `${branch}:${file}`)),
  );
  try {
    git('merge', '--no-ff', '--no-commit', branch);
  } catch {
    // conflicts: resolved below, or reported
  }
  const conflicted = git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
  const edit = (file, fn) =>
    fs.writeFileSync(path.join(ROOT, file), fn(fs.readFileSync(path.join(ROOT, file), 'utf8')));
  if (conflicted.includes('CHANGELOG.md')) edit('CHANGELOG.md', unionConflicts);
  // Only files the lane changed or that conflict: staging another one would sweep in another session's uncommitted edits.
  const backlogs = Object.values(BACKLOGS)
    .map((file, i) => [file, changes[i]])
    .filter(([file, c]) => c.closed.length || c.narrowed.size || conflicted.includes(file));
  // A backlog conflict is lanes editing their own items side by side: keep main's side, then replay this lane's edits on it.
  for (const [file] of backlogs.filter(([f]) => conflicted.includes(f))) git('checkout', '--ours', '--', file);
  for (const [file, c] of backlogs) edit(file, (t) => applyLaneChanges(t, c));
  const closed = changes.flatMap((c) => c.closed);
  const narrowed = changes.flatMap((c) => [...c.narrowed.keys()]);
  console.log(`closed: ${closed.join(' ') || 'none'} · narrowed: ${narrowed.join(' ') || 'none'}`);
  const resolved = [...(conflicted.includes('CHANGELOG.md') ? ['CHANGELOG.md'] : []), ...backlogs.map(([f]) => f)];
  if (resolved.length) git('add', ...resolved);
  const left = conflicted.filter((f) => !resolved.includes(f));
  console.log(left.length ? `resolve by hand: ${left.join(' ')}` : 'merged, not committed: review, then commit');
  const hint = mergeHint(git('diff', '--cached', '--name-only').split('\n').filter(Boolean));
  if (hint) console.log(hint);
  if (left.length) process.exitCode = 1;
}

function record() {
  const manifest = readManifest();
  const ids = manifest.lanes.flatMap((l) => l.items.map((it) => it.id));
  const done = doneTimes(ids, manifest.start, gitLog(manifest.start));
  const date = new Date(manifest.start * 1000).toISOString().slice(0, 10);
  const rows = [];
  let lanesEnd = manifest.start;
  const laneEnds = [];
  for (const lane of manifest.lanes) {
    let prev = manifest.start;
    for (const it of lane.items.filter((i) => done.has(i.id)).sort((a, b) => done.get(a.id) - done.get(b.id))) {
      rows.push({
        date,
        item: it.id,
        effort: it.effort,
        lane: lane.name,
        minutes: Math.round((done.get(it.id) - prev) / 6) / 10,
      });
      prev = done.get(it.id);
    }
    lanesEnd = Math.max(lanesEnd, prev);
    if (lane.items.every((i) => done.has(i.id))) laneEnds.push(prev); // a lane not finished wasn't waiting
  }
  // lanesMin and laneIdleMin (finished lanes waiting on the slowest) show whether the lanes were balanced.
  rows.push({
    date,
    afterLanesMin: Math.round((Date.now() / 1000 - lanesEnd) / 60),
    lanesMin: Math.round((lanesEnd - manifest.start) / 60),
    laneIdleMin: Math.round(laneEnds.reduce((s, end) => s + (lanesEnd - end), 0) / 60),
  });
  fs.appendFileSync(HISTORY, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.rmSync(MANIFEST);
  console.log(`recorded ${rows.length - 1} items`);
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith('--'));
  const rest = args.filter((a) => !a.startsWith('--'));
  if (cmd === 'plan') return plan(rest, Number(flags.find((f) => f.startsWith('--lanes='))?.slice(8) ?? 6));
  if (cmd === 'status') return status();
  if (cmd === 'merge' && rest.length === 1) return merge(rest[0]);
  if (cmd === 'record') return record();
  console.error('Usage: node scripts/batch.js plan [--lanes=6] <items…> | status | merge <branch> | record');
  process.exit(1);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = {
  parseItems,
  planLanes,
  doneTimes,
  laneStatus,
  unionConflicts,
  closeItems,
  laneBacklogChanges,
  applyLaneChanges,
  historyRates,
  mergeHint,
};
