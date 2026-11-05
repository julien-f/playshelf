'use strict';

// What production's GET /api/metrics says needs a look, new since the last run; one line each, nothing
// when healthy. Run by session-end.js; logs each run (dev-metrics `prod-check`).
//   node scripts/prod-check.js

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { record, history } = require('./dev-metrics');

const URL = 'https://steam.isonoe.net/api/metrics';
const LOOP_DELAY_MS = 1000; // lib/metrics.js ALERT.loopDelayMs
const STARTUP_MS = 2 * 60 * 1000; // lib/metrics.js ALERT.startupMs: loading the cache blocks the loop
const FIRST_RUN_DAYS = 7;
const OFFLINE = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH']);

// label → statuses its call declares normal (`expected: [...]` in lib/), read from the code so it can't drift.
function expectedStatuses(dir = path.join(__dirname, '..', 'lib')) {
  const out = {};
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = /expected: \[([\d, ]+)\]/.exec(line);
      if (!m) return;
      const label = lines
        .slice(Math.max(0, i - 8), i)
        .reverse()
        .map((l) => /^\s*'(\w+)',$/.exec(l)?.[1])
        .find(Boolean);
      if (label) out[label] = m[1].split(',').map((s) => s.trim());
    });
  }
  return out;
}

// `daily` → `{ [day]: { 'group.label status': count } }` of the statuses nobody expects.
function unexpectedDaily(daily, expected) {
  const out = {};
  for (const [day, groups] of Object.entries(daily ?? {}))
    for (const [group, labels] of Object.entries(groups))
      for (const [label, statuses] of Object.entries(labels))
        for (const [status, n] of Object.entries(statuses)) {
          if (status === '200' || expected[label]?.includes(status)) continue;
          (out[day] ??= {})[`${group}.${label} ${status}`] = n;
        }
  return out;
}

// The lines to print, and what to remember for next time. `last`: the previous run's row, if any.
// `behind`: commits origin/main has past the deployed one, null when that commit is unknown here.
function prodCheck(m, { last, behind, expected, now = Date.now() }) {
  const since = last ? Date.parse(last.at) : now - FIRST_RUN_DAYS * 24 * 60 * 60 * 1000;
  const lines = [];
  for (const a of m.alerts ?? [])
    if (a.level === 'warn' || a.where === 'itad-dates') lines.push(`${a.where}: ${a.message}`);
  const loop = m.sinceRestart?.eventLoop;
  const loopAt = Date.parse(loop?.maxDelayAt);
  const alerted = (m.alerts ?? []).some((a) => a.where === 'eventLoop' && a.lastAt === loop?.maxDelayAt);
  if (loop?.maxDelayMs >= LOOP_DELAY_MS && loopAt > since && loopAt - m.since > STARTUP_MS && !alerted)
    lines.push(`eventLoop: blocked ${loop.maxDelayMs} ms at ${loop.maxDelayAt}`);
  for (const [route, r] of Object.entries(m.sinceRestart?.inbound ?? {}))
    if (r.statusClasses?.['5xx'] && Date.parse(r.lastServerErrorAt) > since)
      lines.push(`${route}: ${r.statusClasses['5xx']} server errors since restart, last at ${r.lastServerErrorAt}`);
  // Counts per day grow during the day: report what grew past the previous run's snapshot.
  const seen = unexpectedDaily(m.daily, expected);
  const sinceDay = new Date(since).toISOString().slice(0, 10);
  for (const [day, counts] of Object.entries(seen).sort(([a], [b]) => a.localeCompare(b))) {
    if (day < sinceDay) continue;
    for (const [key, n] of Object.entries(counts)) {
      const grew = n - (last?.seen?.[day]?.[key] ?? 0);
      if (grew > 0) lines.push(`${key}: ${grew} on ${day}`);
    }
  }
  if (behind === null) lines.push(`deploy: production runs ${m.commit}, unknown here (git fetch?)`);
  else if (behind > 0) lines.push(`deploy: production runs ${m.commit}, ${behind} commit(s) behind origin/main`);
  const today = new Date(now).toISOString().slice(0, 10);
  const keep = Object.fromEntries(Object.entries(seen).filter(([day]) => day >= sinceDay || day === today));
  return { lines: lines.map((l) => `prod ${l}`), seen: keep };
}

function behindOriginMain(commit) {
  try {
    return Number(
      execFileSync('git', ['rev-list', '--count', `${commit}..origin/main`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    );
  } catch {
    return null;
  }
}

// Lines to print; offline → none. Records the run.
async function check() {
  const start = Date.now();
  const runs = history('prod-check').filter((r) => r.reachable);
  let m;
  try {
    const res = await fetch(URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    m = await res.json();
  } catch (err) {
    const code = err.cause?.code;
    record('prod-check', { reachable: false, error: code ?? err.message, ms: Date.now() - start });
    return OFFLINE.has(code) ? [] : [`prod metrics unreachable: ${code ?? err.message}`];
  }
  const { lines, seen } = prodCheck(m, {
    last: runs.at(-1),
    behind: m.commit ? behindOriginMain(m.commit) : null,
    expected: expectedStatuses(),
  });
  record('prod-check', { reachable: true, lines: lines.length, seen, ms: Date.now() - start });
  return lines;
}

if (require.main === module) check().then((lines) => console.log(lines.length ? lines.join('\n') : 'prod: all quiet'));

module.exports = { check, prodCheck, expectedStatuses, unexpectedDaily };
