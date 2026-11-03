'use strict';

// Its own file: PUBLIC_ORIGIN is read once at startup, and server.test.js uses an http one so
// supertest (plain http) sends the sign-in cookies back.
process.env.STEAM_API_KEY = 'test-key';
process.env.NODE_ENV = 'test';
process.env.DB_FILE = '';
process.env.PUBLIC_ORIGIN = 'https://app.example';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { app } = require('../server');

test("GET /auth/steam/login: the state cookie is Secure on an https PUBLIC_ORIGIN, whatever the request's protocol", async () => {
  const res = await supertest(app).get('/auth/steam/login').set('Host', 'app.example').expect(302);
  assert.match(res.headers['set-cookie'][0], /; Secure/);
});
