'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { claimPort, inputsHash, listening, passedOn, planRun, recordPass } = require('../scripts/e2e');

test('planRun: records a pass only for the projects a run covers in full', () => {
  const none = new Set();
  assert.deepEqual(planRun([], none, false), { running: ['desktop', 'phone'], runArgs: [] });
  assert.deepEqual(planRun(['--reporter=list,json'], none, false).running, ['desktop', 'phone']);
  assert.deepEqual(planRun(['--project=desktop'], none, false).running, ['desktop']);
  assert.deepEqual(planRun(['--project', 'phone'], none, false).running, ['phone']);
  for (const args of [
    ['-g', 'A1:'],
    ['--grep=A1'],
    ['--project=desktop', '-g', 'A1'],
    ['e2e/scenarios.spec.ts'],
    ['--last-failed'],
  ]) {
    assert.deepEqual(planRun(args, none, true), { running: null, runArgs: args }, args.join(' '));
  }
});

test('planRun: --if-changed runs only the projects not yet passed on this build', () => {
  const desktop = new Set(['desktop']);
  assert.deepEqual(planRun(['--reporter=dot'], desktop, true), {
    running: ['phone'],
    runArgs: ['--reporter=dot', '--project=phone'],
  });
  assert.deepEqual(planRun(['--project=desktop'], desktop, true), { running: [], runArgs: null });
  assert.deepEqual(planRun(['--project=phone'], desktop, true), { running: ['phone'], runArgs: ['--project=phone'] });
  assert.deepEqual(planRun([], new Set(['desktop', 'phone']), true).runArgs, null);
  assert.deepEqual(planRun([], desktop, false).runArgs, []); // without the flag, everything runs
});

const tmpDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('claimPort: skips a port another live run holds or something listens on', async (t) => {
  const lockDir = tmpDir(t);
  fs.writeFileSync(path.join(lockDir, 'e2e-5000.lock'), String(process.pid));
  const { port, file } = await claimPort(5000, { lockDir, isBusy: async (p) => p === 5001 });
  assert.equal(port, 5002);
  assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
  assert.deepEqual(fs.readdirSync(lockDir).sort(), ['e2e-5000.lock', 'e2e-5002.lock']);
});

test("claimPort: takes over a dead run's lock", async (t) => {
  const lockDir = tmpDir(t);
  // Beyond Linux's default pid_max, so no live process has it.
  fs.writeFileSync(path.join(lockDir, 'e2e-5000.lock'), '99999999');
  assert.equal((await claimPort(5000, { lockDir, isBusy: async () => false })).port, 5000);
});

test('claimPort: a fixed port in use fails instead of moving', async (t) => {
  const lockDir = tmpDir(t);
  await assert.rejects(claimPort(5000, { lockDir, fixed: true, isBusy: async () => true }), /port 5000 \(E2E_PORT\)/);
  assert.deepEqual(fs.readdirSync(lockDir), []);
});

test('listening: true while a server accepts on the port, false once it closes', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, 'localhost', resolve));
  const { port } = server.address();
  assert.equal(await listening(port), true);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await listening(port), false);
});

test('inputsHash: the same build hashes the same whatever its port directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-hash-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const builds = ['41234', '41999'].map((port) => {
    const dir = path.join(root, port);
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), '<html>');
    fs.writeFileSync(path.join(dir, 'assets/app.js'), 'x');
    return dir;
  });
  assert.equal(inputsHash(builds[0]), inputsHash(builds[1]));
});

test("recordPass: keeps each build's passed projects apart, so another checkout's pass stays readable", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-pass-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'e2e-pass.json');
  assert.deepEqual([...passedOn('a', file)], []);
  recordPass('a', ['desktop'], file);
  recordPass('b', ['phone'], file);
  recordPass('a', ['phone'], file);
  assert.deepEqual([...passedOn('a', file)].sort(), ['desktop', 'phone']);
  assert.deepEqual([...passedOn('b', file)], ['phone']);
  for (let i = 0; i < 50; i++) recordPass(`h${i}`, ['desktop'], file);
  assert.deepEqual([...passedOn('a', file)], [], 'the oldest builds are dropped');
  assert.deepEqual([...passedOn('h49', file)], ['desktop']);
});
