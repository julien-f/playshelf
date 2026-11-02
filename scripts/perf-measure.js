'use strict';

// Measures an Owned list load at the code backlog's phone profile, on the production build with the `big-library`
// mock (docs/dev/testing.md#measuring-performance). On demand only, never in a check, hook or CI: runner noise.
//   node scripts/perf-measure.js [--runs=N]
// Prints each metric's median and range, and the change since the last recorded run (.git/dev-metrics/perf.jsonl).

const { spawn, execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { portOf } = require('./ports');
const { listening } = require('./e2e');
const { record, history } = require('./dev-metrics');

const ROOT = path.join(__dirname, '..');
// The code backlog's baseline profile: a phone, CPU ×4, 1.6 Mbps down / 0.75 Mbps up, 150 ms.
const PROFILE = 'phone-cpu4-1.6mbps-150ms';
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const CPU_SLOWDOWN = 4;
const NETWORK = { offline: false, latency: 150, downloadThroughput: 200_000, uploadThroughput: 93_750 };
const DEFAULT_RUNS = 7;
const DONE_DEADLINE_MS = 120_000; // only bounds a failure
const ALICE = { steamid: '76561198000000001', vanity: 'alice', personaname: 'Alice' }; // e2e/fixtures.ts

// What each metric is; ms unless named otherwise. Cold: a fresh browser opening /lists/owned.
const METRICS = {
  startMs: 'cold: list:start (main.js and the route chunks loaded)',
  rowsMs: 'cold: list:rows (the table built)',
  listedMs: "cold: list:listed (every row's fast part)",
  doneMs: 'cold: list:done',
  tbtMs: 'cold: total blocking time until list:done',
  longestTaskMs: 'cold: longest task until list:done',
  jsKB: 'cold: JavaScript transferred',
  apiKB: 'cold: /api transferred',
  imageRequests: 'cold: image requests (all blocked, off localhost)',
  revisitDoneMs: 'Owned → Home → Owned: the second load, list:start to list:done',
  revisitApiKB: 'Owned → Home → Owned: /api transferred by the second load',
};

// Seeds Alice as the current account, as e2e/state.ts's asPlayer does, and records long tasks from the start.
function initScript(prefs) {
  if (!sessionStorage.getItem('perf-seeded')) {
    localStorage.setItem('steam.isonoe.net:prefs', prefs);
    sessionStorage.setItem('perf-seeded', '1');
  }
  performance.setResourceTimingBufferSize(2000);
  window.perfLongTasks = [];
  new PerformanceObserver((list) => window.perfLongTasks.push(...list.getEntries())).observe({
    type: 'longtask',
    buffered: true,
  });
}

function alicePrefs() {
  const slot = { id: ALICE.steamid, members: [ALICE.steamid], rawInputs: [ALICE.vanity], label: ALICE.personaname };
  const entry = (value) => ({ value, updatedAt: 0 });
  return JSON.stringify({
    schemaVersion: 2,
    myAccount: entry(slot),
    currentAccount: entry(slot),
    recentAccounts: entry([slot]),
  });
}

// Resolves once this load's `list:done` measure exists (loadTiming.ts keeps the latest load's only).
const waitForDone = (page, after) =>
  page.waitForFunction((t) => performance.getEntriesByName('list:done').some((m) => m.startTime >= t), after, {
    timeout: DONE_DEADLINE_MS,
    polling: 100,
  });

// Navigates inside the app, as a link click does: @solidjs/router follows popstate.
const goInApp = (page, url) =>
  page.evaluate((to) => {
    history.pushState(null, '', to);
    dispatchEvent(new PopStateEvent('popstate'));
  }, url);

async function measureRun(browser, base) {
  const context = await browser.newContext(PHONE);
  try {
    await context.addCookies([{ name: 'mock', value: 'big-library', url: base }]);
    await context.addInitScript(initScript, alicePrefs());
    const page = await context.newPage();
    let imageRequests = 0;
    let streamEncoding;
    page.on('request', (req) => req.resourceType() === 'image' && imageRequests++);
    page.on('response', (res) => {
      if (res.url().endsWith('/api/game-details/stream')) streamEncoding = res.headers()['content-encoding'];
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', NETWORK);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN });

    await page.goto(`${base}/lists/owned`);
    await waitForDone(page, 0);
    // The real server gzips the stream: an unzipped one would measure transfer, not the app.
    if (streamEncoding !== 'gzip') throw new Error(`details stream not gzipped (${streamEncoding ?? 'none'})`);
    const cold = await page.evaluate(() => {
      const at = (name) => {
        const m = performance.getEntriesByName(name)[0];
        return m ? m.startTime + m.duration : null;
      };
      const done = at('list:done');
      const tasks = window.perfLongTasks.filter((t) => t.startTime < done);
      const kb = (match) =>
        performance
          .getEntriesByType('resource')
          .filter((r) => match(r.name))
          .reduce((sum, r) => sum + r.transferSize, 0) / 1024;
      return {
        startMs: performance.getEntriesByName('list:start')[0].startTime,
        rowsMs: at('list:rows'),
        listedMs: at('list:listed'),
        doneMs: done,
        tbtMs: tasks.reduce((sum, t) => sum + Math.max(0, t.duration - 50), 0),
        longestTaskMs: Math.max(0, ...tasks.map((t) => t.duration)),
        jsKB: kb((url) => url.endsWith('.js')),
        apiKB: kb((url) => url.includes('/api/')),
      };
    });

    await goInApp(page, '/');
    await page.waitForFunction(() => location.pathname === '/' && !document.querySelector('.dt-table'));
    await page.evaluate(() => performance.clearResourceTimings());
    const revisitAt = await page.evaluate(() => performance.now());
    await goInApp(page, '/lists/owned');
    await waitForDone(page, revisitAt);
    const revisit = await page.evaluate(() => ({
      revisitDoneMs: performance.getEntriesByName('list:done')[0].duration,
      revisitApiKB:
        performance
          .getEntriesByType('resource')
          .filter((r) => r.name.includes('/api/'))
          .reduce((sum, r) => sum + r.transferSize, 0) / 1024,
    }));
    return { ...cold, imageRequests, ...revisit };
  } finally {
    await context.close();
  }
}

const median = (sorted) =>
  sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

// Per metric: median, min and max over the runs.
function summarize(runs) {
  return Object.fromEntries(
    Object.keys(METRICS).map((key) => {
      const values = runs.map((r) => r[key]).sort((a, b) => a - b);
      return [key, { median: median(values), min: values[0], max: values[values.length - 1] }];
    }),
  );
}

// The latest recorded run with the same profile, to compare against.
const previousRun = (rows) => rows.filter((r) => r.profile === PROFILE && r.outcome === 'ok').at(-1);

// A change counts only when the two runs' ranges don't overlap; otherwise it's within the noise.
function compare(current, previous) {
  return Object.keys(METRICS).map((key) => {
    const now = current[key];
    const before = previous?.stats?.[key];
    const changed = before ? now.min > before.max || now.max < before.min : false;
    return { key, ...now, before: before?.median ?? null, changed };
  });
}

const fmt = (n) => (n == null ? '—' : String(Math.round(n)));

function report(rows) {
  const lines = rows.map(
    ({ key, median: m, min, max, before, changed }) =>
      `${key.padEnd(15)} ${fmt(m).padStart(7)} ${`${fmt(min)}–${fmt(max)}`.padStart(13)} ${fmt(before).padStart(7)}${changed ? (m < before ? '  faster' : '  slower') : ''}`,
  );
  return [`${'metric'.padEnd(15)} ${'median'.padStart(7)} ${'min–max'.padStart(13)} ${'last'.padStart(7)}`, ...lines];
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

async function main() {
  const runsArg = process.argv.find((a) => a.startsWith('--runs='));
  const runs = runsArg ? Number(runsArg.slice('--runs='.length)) : DEFAULT_RUNS;
  if (!(runs >= 1)) throw new Error('--runs=N takes a positive number');
  const started = Date.now();
  const port = portOf('perf');
  if (await listening(port)) throw new Error(`port ${port} is busy (node scripts/ports.js perf)`);
  const outDir = path.join(ROOT, 'node_modules/.cache/perf-dist', String(port));
  console.log('Building…');
  execFileSync('npx', ['vite', 'build', '--outDir', outDir, '--emptyOutDir'], { cwd: ROOT, stdio: 'ignore' });
  const preview = spawn('npx', ['vite', 'preview', '--outDir', outDir, '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    env: { ...process.env, MOCK_API: '1' },
    detached: true,
    stdio: 'ignore',
  });
  const base = `http://localhost:${port}`;
  const row = { profile: PROFILE, runs, commit: git('rev-parse', '--short', 'HEAD') };
  try {
    row.branch = git('branch', '--show-current');
    row.dirty = git('status', '--porcelain') !== '';
    while (!(await listening(port))) await new Promise((resolve) => setTimeout(resolve, 100));
    const { chromium } = require('@playwright/test');
    // No request leaves the machine: store art points at Steam's CDN, and the synthetic appids exist nowhere.
    const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'] });
    try {
      console.log('Warm-up run (discarded)…');
      await measureRun(browser, base);
      const results = [];
      for (let i = 1; i <= runs; i++) {
        console.log(`Run ${i}/${runs}…`);
        results.push(await measureRun(browser, base));
      }
      row.stats = summarize(results);
    } finally {
      await browser.close();
    }
    row.loadavg = os.loadavg()[0];
    row.outcome = 'ok';
    console.log(`\n${PROFILE}, ${runs} runs, load ${row.loadavg.toFixed(1)}; ms unless named:\n`);
    console.log(report(compare(row.stats, previousRun(history('perf')))).join('\n'));
    console.log(
      `\n${Object.entries(METRICS)
        .map(([k, d]) => `${k}: ${d}`)
        .join('\n')}`,
    );
  } catch (err) {
    row.outcome = 'failed';
    row.error = err.message;
    throw err;
  } finally {
    process.kill(-preview.pid);
    record('perf', { ...row, durationMs: Date.now() - started });
  }
}

if (require.main === module)
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });

module.exports = { summarize, compare, previousRun, PROFILE };
