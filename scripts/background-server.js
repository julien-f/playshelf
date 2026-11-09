'use strict';

// Runs an npm dev script in the background, for checking UI changes from an agent session —
// shared by mock-server.js and dev-server.js:
//   up     reuse the running server, or start one; returns once the app's modules load (not
//          just its HTML: right after startup Vite can 403 a dependency while it optimizes —
//          pitfalls.md). A server this script started at another git HEAD is restarted first.
//   down   stop the server this script started (its whole process group — never `pkill -f`,
//          whose pattern also matches the shell running it)
// Logs to .playwright-mcp/<name>.log.

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', '.playwright-mcp');
const TIMEOUT_MS = 60_000;
const MAX_MODULES = 400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function status(url) {
  try {
    const res = await fetch(url);
    return { ok: res.ok, text: res.ok ? await res.text() : '' };
  } catch {
    return { ok: false, text: '' };
  }
}

// Fetches the entry module and everything it imports, so every module the first page load
// needs has been served once.
async function warm(base, deadline) {
  const html = await status(base);
  const entry = /<script type="module" src="([^"]+)"/.exec(html.text)?.[1];
  if (!entry) return false;
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length && seen.size <= MAX_MODULES) {
    const url = queue.shift();
    let res = await status(base + url);
    while (!res.ok) {
      if (Date.now() > deadline) throw new Error(`${url} still failing`);
      await sleep(500);
      res = await status(base + url);
    }
    for (const [, dep] of res.text.matchAll(/(?:from|import)\s*["'](\/[^"']+)["']/g)) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return true;
}

const gitHead = () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

// A running server we started at another HEAD can serve stale modules (pitfalls.md); one we didn't start is left alone.
function needsRestart({ running, startedHead, head }) {
  return running && startedHead != null && startedHead !== head;
}

// `env`: added to the server's environment.
function cli({ name, npmScript, port, env = {} }) {
  const BASE = `http://localhost:${port}`;
  const PID_FILE = path.join(DIR, `${name}.pid`);
  const HEAD_FILE = path.join(DIR, `${name}.head`);

  async function up() {
    const deadline = Date.now() + TIMEOUT_MS;
    const head = gitHead();
    const startedHead = fs.existsSync(PID_FILE) && fs.existsSync(HEAD_FILE) ? fs.readFileSync(HEAD_FILE, 'utf8') : null;
    if (needsRestart({ running: (await status(BASE)).ok, startedHead, head })) {
      console.log(`HEAD moved since ${name} started: restarting`);
      down();
      while ((await status(BASE)).ok) {
        if (Date.now() > deadline) throw new Error(`${BASE} still answering after down`);
        await sleep(300);
      }
    }
    if (!(await status(BASE)).ok) {
      fs.mkdirSync(DIR, { recursive: true });
      const log = fs.openSync(path.join(DIR, `${name}.log`), 'w');
      const child = spawn('npm', ['run', npmScript], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, ...env },
        detached: true,
        stdio: ['ignore', log, log],
      });
      fs.writeFileSync(PID_FILE, String(child.pid));
      fs.writeFileSync(HEAD_FILE, head);
      child.unref();
      while (!(await status(BASE)).ok) {
        if (Date.now() > deadline) throw new Error(`no answer on ${BASE}; see .playwright-mcp/${name}.log`);
        await sleep(300);
      }
    }
    if (!(await warm(BASE, deadline))) throw new Error(`no module entry found in ${BASE}`);
    console.log(`${BASE} up`);
  }

  function down() {
    if (!fs.existsSync(PID_FILE)) {
      console.log(`not started by this script; stop the \`npm run ${npmScript}\` running on :${port} by hand`);
      return;
    }
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
    try {
      process.kill(-pid); // the whole group: npm and everything it started
    } catch (err) {
      if (err.code !== 'ESRCH') throw err;
    }
    fs.rmSync(PID_FILE);
    fs.rmSync(HEAD_FILE, { force: true });
    console.log('stopped');
  }

  const cmd = process.argv[2];
  if (cmd === 'up')
    up().catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
  else if (cmd === 'down') down();
  else {
    console.error(`Usage: node scripts/${name}.js up|down`);
    process.exit(1);
  }
}

module.exports = { cli, needsRestart };
