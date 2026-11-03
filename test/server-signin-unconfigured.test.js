'use strict';

// Its own file: PUBLIC_ORIGIN is read once at startup, and server.test.js sets it.
process.env.STEAM_API_KEY = 'test-key';
process.env.NODE_ENV = 'test';
process.env.DB_FILE = '';
// Empty rather than deleted, so a developer's .env can't fill it in (loadEnvFile keeps set keys).
process.env.PUBLIC_ORIGIN = '';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { app } = require('../server');

const api = supertest(app);

for (const path of ['/auth/steam/login', '/auth/steam/callback?state=x']) {
  test(`GET ${path}: 503 without PUBLIC_ORIGIN, rather than trusting the Host header`, async () => {
    const res = await api.get(path).set('Host', 'evil.example').set('Cookie', 'steam_login_state=x').expect(503);
    assert.match(res.text, /Sign-in isn't available/);
  });
}

test('PUBLIC_ORIGIN that is not a URL: startup fails naming the setting', () => {
  const { spawnSync } = require('node:child_process');
  const run = spawnSync(process.execPath, ['-e', "require('./lib/config')"], {
    env: { ...process.env, PUBLIC_ORIGIN: 'steam.isonoe.net' },
    encoding: 'utf8',
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /PUBLIC_ORIGIN/);
});
