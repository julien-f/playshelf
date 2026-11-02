'use strict';

// Each client's share of the outbound budgets (lib/metrics.js's chargeBudget). Its own file: the
// budgets are read from the env at load time. 8 calls an hour per group, 25% → 2 per client.
process.env.STEAM_API_KEY = 'test-key';
process.env.NODE_ENV = 'test';
process.env.DB_FILE = '';
process.env.RATE_LIMIT_ENABLED = 'true';
process.env.TRUST_PROXY = '1';
process.env.OUTBOUND_HOURLY_MAX = '8';
process.env.OUTBOUND_CLIENT_SHARE_PERCENT = '25';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { until } = require('./until');
const { app } = require('../server');
const { _reset, getCached, setCache } = require('../lib/cache');
const { createTrackedFetch, getMetrics, runAsClient, _reset: _resetMetrics } = require('../lib/metrics');
const { createSemaphore } = require('../lib/upstream');
const { createDedup } = require('../lib/dedup');
const { getHLTB, _resetAuth } = require('../lib/hltb');
const { getPickAndMix } = require('../lib/fanatical');
const { getPlayerSummaries } = require('../lib/steam');

const api = supertest(app);
const testFetch = createTrackedFetch('test-group');
const spend = () => testFetch('spend', 'https://example.com/');

function setup(t, fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) })) {
  _reset();
  _resetMetrics();
  _resetAuth();
  t.mock.method(globalThis, 'fetch', fetchImpl);
  const warn = t.mock.method(console, 'warn', () => {});
  const error = t.mock.method(console, 'error', () => {});
  return { warn, error };
}

// Settles `fn()` and returns the error it threw, or null.
const refusal = (fn) =>
  fn().then(
    () => null,
    (err) => err,
  );

test('a client is refused past its share, other clients are not', async (t) => {
  setup(t);
  await runAsClient('a', async () => {
    await spend();
    await spend();
    const err = await refusal(spend);
    assert.equal(err?.isClientBudgetExhausted, true);
    assert.equal(err.isBudgetExhausted, true);
  });
  await runAsClient('b', () => spend());
  const budget = getMetrics().budgets['test-group'];
  assert.equal(budget.hourUsed, 3);
  assert.equal(budget.hourTopClient, 2);
});

test('a call outside any request counts only against the global budget', async (t) => {
  setup(t);
  await runAsClient('a', async () => {
    await spend();
    await spend();
  });
  for (let i = 0; i < 4; i++) await spend();
  await runAsClient('b', () => spend());
  assert.equal((await runAsClient('a', () => refusal(spend)))?.isClientBudgetExhausted, true);
});

test('the global ceiling still refuses every client, as a global refusal', async (t) => {
  setup(t);
  for (let i = 0; i < 8; i++) await spend();
  const err = await runAsClient('fresh', () => refusal(spend));
  assert.equal(err?.isBudgetExhausted, true);
  assert.equal(err.isClientBudgetExhausted, undefined);
});

test('a client past its share is warned about once per window', async (t) => {
  const { warn } = setup(t);
  for (const client of ['a', 'b']) {
    await runAsClient(client, async () => {
      await spend();
      await spend();
      for (let i = 0; i < 3; i++) await refusal(spend);
    });
  }
  const lines = warn.mock.calls.map((c) => c.arguments[0]).filter((l) => /\[budget:test-group\]/.test(l));
  assert.equal(lines.length, 2);
});

test('a job queued behind another client’s is charged to its own client', async (t) => {
  setup(t);
  await runAsClient('b', async () => {
    await spend();
    await spend();
  });
  const sem = createSemaphore(1, 0, 'test-client-sem');
  let releaseA;
  const a = runAsClient('a', () => sem(() => new Promise((r) => (releaseA = r))));
  const b = runAsClient('b', () => sem(() => refusal(spend)));
  releaseA();
  await a;
  assert.equal((await b)?.isClientBudgetExhausted, true);
});

test('a job refused by a budget frees its semaphore slot at once', async (t) => {
  setup(t);
  const sem = createSemaphore(1, 60_000, 'test-refused-sem');
  await refusal(() => sem(async () => Promise.reject(Object.assign(new Error('x'), { isBudgetExhausted: true }))));
  assert.equal(sem.getStats().active, 0);
});

test('a client coalescing onto another client’s refused call still gets its answer', async (t) => {
  setup(t);
  await runAsClient('a', async () => {
    await spend();
    await spend();
  });
  const withDedup = createDedup();
  const load = () => spend().then(() => 'answer');
  const a = runAsClient('a', () => refusal(() => withDedup('k', load)));
  const b = runAsClient('b', () => withDedup('k', load));
  assert.equal((await a)?.isClientBudgetExhausted, true);
  assert.equal(await b, 'answer');
});

test('clients coalescing onto another client’s refused call retry it once between them', async (t) => {
  setup(t);
  await runAsClient('a', async () => {
    await spend();
    await spend();
  });
  const withDedup = createDedup();
  let loads = 0;
  const load = () => {
    loads++;
    return spend().then(() => 'answer');
  };
  const a = runAsClient('a', () => refusal(() => withDedup('k', load)));
  const others = ['b', 'c', 'd'].map((client) => runAsClient(client, () => withDedup('k', load)));
  await a;
  assert.deepEqual(await Promise.all(others), ['answer', 'answer', 'answer']);
  assert.equal(loads, 2);
});

test('a client coalescing onto another client’s upstream failure gets that failure, not a retry', async (t) => {
  setup(t);
  const withDedup = createDedup();
  let loads = 0;
  const load = () => {
    loads++;
    return Promise.reject(Object.assign(new Error('upstream down'), { isUpstream: true }));
  };
  const a = runAsClient('a', () => refusal(() => withDedup('k', load)));
  const b = runAsClient('b', () => refusal(() => withDedup('k', load)));
  assert.equal((await a)?.message, 'upstream down');
  assert.equal((await b)?.message, 'upstream down');
  assert.equal(loads, 1);
});

test('one client’s refused HLTB login doesn’t hold off another client’s', async (t) => {
  setup(t, async (url) => {
    if (url.includes('search/site/init'))
      return { ok: true, json: async () => ({ token: 't', hpKey: 'k', hpVal: 'v' }) };
    return { ok: true, json: async () => ({ data: [{ game_id: 1, game_name: 'Portal', comp_main: 3600 }] }) };
  });
  const hltb = createTrackedFetch('hltb');
  await runAsClient('a', async () => {
    await hltb('spend', 'https://example.com/');
    await hltb('spend', 'https://example.com/');
    assert.equal((await refusal(() => getHLTB(1, 'Portal')))?.isClientBudgetExhausted, true);
  });
  assert.equal((await runAsClient('b', () => getHLTB(1, 'Portal')))?.id, 1);
});

test('a client waiting on another client’s refused HLTB login logs in on its own', async (t) => {
  setup(t, async (url) => {
    if (url.includes('search/site/init'))
      return { ok: true, json: async () => ({ token: 't', hpKey: 'k', hpVal: 'v' }) };
    return { ok: true, json: async () => ({ data: [{ game_id: 1, game_name: 'Portal', comp_main: 3600 }] }) };
  });
  const hltb = createTrackedFetch('hltb');
  await runAsClient('a', async () => {
    await hltb('spend', 'https://example.com/');
    await hltb('spend', 'https://example.com/');
  });
  const a = runAsClient('a', () => refusal(() => getHLTB(1, 'Portal')));
  const b = runAsClient('b', () => getHLTB(1, 'Portal'));
  assert.equal((await a)?.isClientBudgetExhausted, true);
  assert.equal((await b)?.id, 1);
});

test('one client’s refused HLTB search doesn’t hold back the warning for an HLTB failure', async (t) => {
  let searchStatus = 200;
  const { warn } = setup(t, async (url) => {
    if (url.includes('search/site/init'))
      return { ok: true, json: async () => ({ token: 't', hpKey: 'k', hpVal: 'v' }) };
    return { ok: false, status: searchStatus };
  });
  const hltb = createTrackedFetch('hltb');
  await runAsClient('a', async () => {
    await hltb('spend', 'https://example.com/');
    assert.equal((await refusal(() => getHLTB(1, 'Portal')))?.isClientBudgetExhausted, true);
  });
  searchStatus = 500;
  await runAsClient('b', () => refusal(() => getHLTB(2, 'Half-Life')));
  assert.deepEqual(
    warn.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.startsWith('[HLTB]')),
    ['[HLTB] search failed for "Half-Life":'],
  );
});

test('one client’s refused Fanatical call isn’t cached as a failure for everyone', async (t) => {
  setup(t, async () => ({ ok: true, json: async () => ({ pickandmix: [] }) }));
  const fanatical = createTrackedFetch('fanatical');
  await runAsClient('a', async () => {
    await fanatical('spend', 'https://example.com/');
    await fanatical('spend', 'https://example.com/');
    assert.deepEqual(await getPickAndMix(), {});
  });
  assert.equal(getCached('fanatical-pnm:v3'), undefined);
});

test('a client waiting on another client’s refused Fanatical call gets the feed', async (t) => {
  const feed = { pickandmix: [{ slug: 'pick', tiers: [{ quantity: 2, price: { USD: 500 } }], products: [] }] };
  setup(t, async () => ({ ok: true, json: async () => feed }));
  const fanatical = createTrackedFetch('fanatical');
  await runAsClient('a', async () => {
    await fanatical('spend', 'https://example.com/');
    await fanatical('spend', 'https://example.com/');
  });
  const a = runAsClient('a', () => getPickAndMix());
  const b = runAsClient('b', () => getPickAndMix());
  assert.deepEqual(await a, {});
  assert.deepEqual(Object.keys(await b), ['pick']);
});

test('player names refused by a budget log no line per batch', async (t) => {
  const { warn } = setup(t);
  for (let i = 0; i < 8; i++) await createTrackedFetch('steam-api')('spend', 'https://example.com/');
  const ids = Array.from({ length: 250 }, (_, i) => String(76561198000000000n + BigInt(i)));
  const players = await getPlayerSummaries(ids);
  assert.equal(players.length, 250);
  assert.deepEqual(
    warn.mock.calls.map((c) => c.arguments[0]).filter((l) => /\[steam\]/.test(l)),
    [],
  );
});

// Answers the Steam Web API calls the achievements and friends routes make.
const steamApi = async (url) => {
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  if (String(url).includes('GetPlayerAchievements')) return json({ playerstats: { success: true, achievements: [] } });
  if (String(url).includes('GetFriendList')) return json({ friendslist: { friends: [] } });
  if (String(url).includes('GetGlobalAchievementPercentages'))
    return json({ achievementpercentages: { achievements: [] } });
  if (String(url) === 'https://example.com/') return json({});
  throw new Error(`Unexpected fetch: ${url}`);
};

const playerIds = (from, n) => Array.from({ length: n }, (_, i) => String(76561198000001000n + BigInt(from + i)));

function cacheAchievementGame(appid) {
  setCache(`meta:${appid}`, { name: 'Game' });
  setCache(`schema:${appid}`, [{ apiname: 'A', name: 'A' }]);
  setCache(`achrarity:${appid}`, {});
}

test('a route answers 429 to the client past its share, and 200 to another', async (t) => {
  const { error } = setup(t, steamApi);
  cacheAchievementGame(10);
  const over = await api
    .get(`/api/achievements/10?steamids=${playerIds(0, 3).join(',')}`)
    .set('X-Forwarded-For', '203.0.113.1');
  assert.equal(over.status, 429);
  assert.match(over.body.error, /your network/);
  const other = await api
    .get(`/api/achievements/10?steamids=${playerIds(10, 1).join(',')}`)
    .set('X-Forwarded-For', '203.0.113.2');
  assert.equal(other.status, 200);
  assert.deepEqual(
    error.mock.calls.map((c) => c.arguments[0]),
    [],
  );
});

test('a route with a JSON body is charged to its client', async (t) => {
  setup(t, steamApi);
  const res = await api
    .post('/api/friends')
    .set('X-Forwarded-For', '203.0.113.3')
    .send({ members: playerIds(20, 3) });
  assert.equal(res.status, 429);
});

test('a refused rarity lookup logs no [achievements] line', async (t) => {
  const { warn } = setup(t, steamApi);
  setCache('meta:11', { name: 'Game' });
  setCache('schema:11', [{ apiname: 'A', name: 'A' }]);
  for (let i = 0; i < 8; i++) await createTrackedFetch('steam-api')('spend', 'https://example.com/');
  const res = await api.get('/api/achievements/11').set('X-Forwarded-For', '203.0.113.4');
  assert.equal(res.status, 200);
  assert.equal(res.body.rarityFailed, true);
  assert.deepEqual(
    warn.mock.calls.map((c) => c.arguments[0]).filter((l) => /\[achievements\]/.test(l)),
    [],
  );
});

// Answers every upstream a game's details reach; `gate`, when given, holds ProtonDB until it resolves.
function detailsFetch(gate) {
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  return async (url) => {
    url = String(url);
    const appid = url.match(/appids=(\d+)/)?.[1];
    if (url === 'https://example.com/') return json({});
    if (url.includes('GetAppReviews'))
      return json({
        response: { query_summary: { total_reviews: 10, total_positive: 9, review_score_desc: 'Positive' } },
      });
    if (url.includes('appdetails')) return json({ [appid]: { success: true, data: { name: 'Portal' } } });
    if (url.includes('IStoreBrowseService')) return json({ response: { store_items: [{ success: 1, tagids: [1] }] } });
    if (url.includes('ajaxgetstoretags')) return json({ tags: [{ tagid: 1, name: 'Action' }] });
    if (url.includes('protondb.com')) {
      await gate;
      return json({ tier: 'gold', confidence: 'strong', total: 5 });
    }
    if (url.includes('search/site/init')) return json({ token: 't', hpKey: 'k', hpVal: 'v' });
    if (url.includes('search/site')) return json({ data: [] });
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

const spendStore = (client) =>
  runAsClient(client, async () => {
    for (let i = 0; i < 2; i++) await createTrackedFetch('steam-store')('spend', 'https://example.com/');
  });

const sseEvents = (res) =>
  res.text
    .split('\n\n')
    .filter((c) => c.startsWith('data: '))
    .map((c) => JSON.parse(c.slice(6)));

test('the stream says once that this client is past its share, and still ends', async (t) => {
  const { warn } = setup(t, detailsFetch());
  await spendStore('203.0.113.5');
  const res = await api
    .post('/api/game-details/stream')
    .set('X-Forwarded-For', '203.0.113.5')
    .send({ games: [{ appid: 30 }, { appid: 31 }, { appid: 32 }] })
    .buffer(true)
    .parse((r, done) => {
      let text = '';
      r.on('data', (c) => (text += c));
      r.on('end', () => done(null, text));
    });
  const events = sseEvents({ text: res.body });
  const limited = events.filter((e) => e.limited);
  assert.equal(limited.length, 1);
  assert.match(limited[0].limited, /your network/);
  const stores = events.filter((e) => e.part === 'store');
  assert.deepEqual(stores.map((e) => e.appid).sort(), [30, 31, 32]);
  assert.equal(events.filter((e) => e.part === 'fast').length, 3);
  assert.ok(events.filter((e) => e.appid).every((e) => !('limited' in e)));
  assert.ok(stores.every((e) => e.failed.includes('meta')));
  assert.equal(events.at(-1).done, true);
  assert.deepEqual(
    warn.mock.calls.map((c) => c.arguments[0]).filter((l) => /\[game-details\]/.test(l)),
    [],
  );
});

test('a client coalescing onto another client’s refused game details gets its own', async (t) => {
  let open;
  const gate = new Promise((r) => (open = r));
  let protonAsked;
  const asked = new Promise((r) => (protonAsked = r));
  const answer = detailsFetch(gate);
  setup(t, (url) => {
    if (String(url).includes('protondb.com')) protonAsked();
    return answer(url);
  });
  setCache('tagnames:all', { 1: 'Action' }); // so b's share covers the store calls it makes
  await spendStore('203.0.113.6');
  const a = api
    .get('/api/game-details/40')
    .set('X-Forwarded-For', '203.0.113.6')
    .then((r) => r);
  await asked;
  const b = api
    .get('/api/game-details/40')
    .set('X-Forwarded-For', '203.0.113.7')
    .then((r) => r);
  await until(() => getMetrics().sinceRestart.dedupHits.details === 1, 'b joining a’s lookup');
  open();
  assert.ok((await a).body.failed.includes('meta'));
  const other = await b;
  assert.equal(other.body.meta?.name, 'Portal');
  assert.equal(other.body.failed, undefined);
});
