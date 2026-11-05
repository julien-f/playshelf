'use strict';

// The workarounds waiting on an upstream fix — a comment ending "<bug URL> is fixed" (Bugzilla or GitHub
// issue) — and each bug's state, so one whose bug closed gets checked and removed. Logs each run (dev-metrics `upstream-bugs`).
//   node scripts/upstream-bugs.js

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { record } = require('./dev-metrics');

const ROOT = path.join(__dirname, '..');
const URL_RE =
  /https:\/\/(?:bugzilla\.mozilla\.org\/show_bug\.cgi\?id=(\w+)|github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+))\s+is fixed/g;

// `[{ file, line, text }]` (grep output) → `[{ where, url, bugzilla?, github?, filed }]`.
function workarounds(lines) {
  return lines.flatMap(({ file, line, text }) =>
    [...text.matchAll(URL_RE)].map(([match, bz, repo, issue]) => ({
      where: `${file}:${line}`,
      url: match.replace(/\s+is fixed$/, ''),
      ...(bz ? { bugzilla: bz } : { github: `${repo}/issues/${issue}` }),
      filed: !bz || /^\d+$/.test(bz),
    })),
  );
}

// A workaround → what's left about it, or nothing while its bug is open (or its state unknown).
function leftover(w) {
  if (!w.filed) return `${w.where}: upstream bug not filed yet (${w.url})`;
  if (w.state === 'closed') return `${w.where}: ${w.url} is closed: check it was fixed, then remove the workaround`;
  return null;
}

function grep() {
  let out;
  try {
    out = execFileSync('git', ['grep', '-n', '-E', 'is fixed', '--', ':!CHANGELOG.md', ':!docs', ':!test'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
  } catch {
    return []; // no match
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [, file, line, text] = /^([^:]+):(\d+):(.*)$/.exec(l);
      return { file, line: Number(line), text };
    });
}

// 'open' | 'closed' | 'unknown' (unreachable, rate-limited, private).
async function state(w) {
  const url = w.bugzilla
    ? `https://bugzilla.mozilla.org/rest/bug/${w.bugzilla}?include_fields=is_open`
    : `https://api.github.com/repos/${w.github}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { 'user-agent': 'playshelf-dev' } });
    if (!res.ok) return 'unknown';
    const body = await res.json();
    const open = w.bugzilla ? body.bugs?.[0]?.is_open : body.state === 'open';
    return open === undefined ? 'unknown' : open ? 'open' : 'closed';
  } catch {
    return 'unknown';
  }
}

async function check() {
  const start = Date.now();
  const list = workarounds(grep());
  await Promise.all(list.filter((w) => w.filed).map(async (w) => (w.state = await state(w))));
  const left = list.map(leftover).filter(Boolean);
  const count = (s) => list.filter((w) => w.state === s).length;
  record('upstream-bugs', {
    workarounds: list.length,
    closed: count('closed'),
    unknown: count('unknown'),
    unfiled: list.filter((w) => !w.filed).length,
    ms: Date.now() - start,
  });
  return { list, left };
}

if (require.main === module) {
  check().then(({ list }) => {
    for (const w of list) console.log(`${w.where}  ${w.url}  ${w.filed ? w.state : 'not filed'}`);
    if (!list.length) console.log('no workaround waiting on an upstream fix');
  });
}

module.exports = { workarounds, leftover, check };
