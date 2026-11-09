'use strict';

// `npm run test:e2e`: builds the frontend once, then runs Playwright against it. A full passing run
// records, per project, a hash of everything the suite can see (the build minus its sourcemaps, e2e/, the Playwright
// config, the lockfile, Node's version); with --if-changed (the hooks), projects already passed on that hash are
// skipped, since they would test exactly what passed: a push after the pre-commit desktop run runs only phone. With --since=<ref> (a fix-batch lane), a
// branch whose commits since <ref> touch nothing the suite covers (check.js's UI files) skips it.
// A port another run holds or something listens on is skipped for the next free one, unless E2E_PORT sets it.
// Each --if-changed run logs the projects asked for and those run (dev-metrics `e2e-runs`).
//   node scripts/e2e.js [--if-changed] [--since=<ref>] [playwright args…]

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { touchesUi } = require('./check');
const { portOf } = require('./ports');
const { record } = require('./dev-metrics');
const PROJECTS = Object.keys(require('./e2e-projects'));

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, 'node_modules/.cache');
const PASS_FILE = path.join(CACHE, 'e2e-pass');
// playwright.config.ts keeps the port below Linux's ephemeral range.
const MAX_PORT = 32767;

// Args that run part of the suite: such a pass says nothing about the rest.
const NARROWING = /^(-g|--grep|--grep-invert|--last-failed|--only-changed|--shard)(=|$)/;
const PROJECT_ARG = /^--project(?:=(.*))?$/;

// Names relative to `base`, so a build on another port hashes the same.
const filesUnder = (dir, base) =>
  fs
    .readdirSync(dir, { recursive: true })
    .map((f) => path.join(dir, f))
    // Sourcemaps embed the sources, comments included; only stack traces read them.
    .filter((f) => fs.statSync(f).isFile() && !f.endsWith('.map'))
    .sort()
    .map((f) => [path.relative(base, f), f]);

function inputsHash(outDir) {
  const hash = crypto.createHash('sha256').update(process.version);
  const files = [
    ...filesUnder(outDir, path.dirname(outDir)),
    ...filesUnder(path.join(ROOT, 'e2e'), ROOT),
    ...['playwright.config.ts', 'scripts/e2e-projects.js', 'package-lock.json'].map((f) => [f, path.join(ROOT, f)]),
  ];
  for (const [name, f] of files) hash.update(name).update('\0').update(fs.readFileSync(f)).update('\0');
  return hash.digest('hex');
}

// Whether something accepts connections on localhost:`port` (IPv4 or IPv6, as `vite preview` may bind either).
const listening = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: 'localhost', port });
    const done = (busy) => {
      socket.destroy();
      resolve(busy);
    };
    socket.once('connect', () => done(true)).once('error', () => done(false));
  });

// Claims the lock file `<lockDir>/e2e-<port>.lock` for this process, or returns false while a live one holds it.
function lock(lockDir, port) {
  const file = path.join(lockDir, `e2e-${port}.lock`);
  try {
    fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
    return file;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  try {
    process.kill(Number(fs.readFileSync(file, 'utf8')), 0);
    return false;
  } catch {
    fs.rmSync(file, { force: true }); // its run died without cleaning up
    return lock(lockDir, port);
  }
}

// The first port from `start` that no other run of this checkout holds (it would share the build dir) and nothing
// listens on, with its lock file; only `start` when `fixed`. Throws when none is free.
async function claimPort(start, { fixed = false, lockDir = CACHE, isBusy = listening } = {}) {
  fs.mkdirSync(lockDir, { recursive: true });
  for (let port = start; port <= (fixed ? start : MAX_PORT); port++) {
    const file = lock(lockDir, port);
    if (!file) continue;
    if (!(await isBusy(port))) return { port, file };
    fs.rmSync(file);
  }
  throw new Error(fixed ? `port ${start} (E2E_PORT) is in use` : `no free port from ${start} to ${MAX_PORT}`);
}

// The projects already passed on `hash`.
const passedOn = (hash) => {
  try {
    const [passed, ...projects] = fs.readFileSync(PASS_FILE, 'utf8').trim().split('\n');
    return new Set(passed === hash ? projects : []);
  } catch {
    return new Set();
  }
};

// Splits Playwright args into the projects they run in full (null when they run part of a project's tests,
// so a pass says nothing about the rest) and the other args.
function splitProjects(pwArgs) {
  const projects = [];
  const rest = [];
  for (let i = 0; i < pwArgs.length; i++) {
    const m = PROJECT_ARG.exec(pwArgs[i]);
    if (m) projects.push(m[1] ?? pwArgs[++i]);
    else if (NARROWING.test(pwArgs[i]) || !pwArgs[i].startsWith('-')) return { projects: null, rest: pwArgs };
    else rest.push(pwArgs[i]);
  }
  return { projects: projects.length ? projects : PROJECTS, rest };
}

// What to run given the projects already `passed` on this build: `running` the projects whose pass to record (null:
// none), `runArgs` null to skip.
function planRun(pwArgs, passed, ifChanged) {
  const { projects, rest } = splitProjects(pwArgs);
  if (!ifChanged || !projects) return { running: projects, runArgs: pwArgs };
  const running = projects.filter((p) => !passed.has(p));
  if (!running.length) return { running, runArgs: null };
  if (running.length === projects.length) return { running, runArgs: pwArgs };
  return { running, runArgs: [...rest, ...running.map((p) => `--project=${p}`)] };
}

async function main() {
  const args = process.argv.slice(2);
  const ifChanged = args.includes('--if-changed');
  const since = args.find((a) => a.startsWith('--since='))?.slice(8);
  const pwArgs = args.filter((a) => a !== '--if-changed' && !a.startsWith('--since='));
  if (since) {
    const changed = execFileSync('git', ['diff', '--name-only', `${since}...HEAD`], { cwd: ROOT, encoding: 'utf8' });
    if (!touchesUi(changed.split('\n').filter(Boolean))) {
      console.log(`e2e: nothing the suite covers changed since ${since}, skipped`);
      process.exit(0);
    }
  }

  const start = portOf('e2e');
  let claimed;
  try {
    claimed = await claimPort(start, { fixed: Boolean(process.env.E2E_PORT) });
  } catch (err) {
    console.error(`e2e: ${err.message}`);
    process.exit(1);
  }
  process.on('exit', () => fs.rmSync(claimed.file, { force: true }));
  if (claimed.port !== start) console.log(`e2e: port ${start} is in use (another run?), using ${claimed.port}`);
  // playwright.config.ts reads the port through portOf too.
  process.env.E2E_PORT = String(claimed.port);
  const OUT_DIR = path.join(CACHE, 'e2e-dist', String(claimed.port));

  execFileSync('npx', ['vite', 'build', '--sourcemap', '--outDir', OUT_DIR, '--logLevel', 'error'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  const hash = inputsHash(OUT_DIR);
  const passed = passedOn(hash);
  const { running, runArgs } = planRun(pwArgs, passed, ifChanged);
  const log = (ok, seconds) =>
    ifChanged && running && record('e2e-runs', { asked: splitProjects(pwArgs).projects, ran: running, ok, seconds });
  if (!runArgs) {
    log(true, 0);
    console.log('e2e: same build and tests as the last passing run, skipped');
    process.exit(0);
  }
  if (runArgs !== pwArgs)
    console.log(`e2e: ${[...passed].join(', ')} passed on this build, running ${running.join(', ')}`);

  const started = Date.now();
  const { status } = spawnSync('npx', ['playwright', 'test', ...runArgs], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, E2E_BUILT: OUT_DIR },
  });
  log(status === 0, Math.round((Date.now() - started) / 1000));
  if (status === 0 && running)
    fs.writeFileSync(PASS_FILE, `${[hash, ...new Set([...passed, ...running])].join('\n')}\n`);
  process.exit(status ?? 1);
}

if (require.main === module) main();

module.exports = { claimPort, listening, planRun };
