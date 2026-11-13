'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ageCache } = require('./ageCache');
const { levenshtein, stringSimilarity, getHLTB, buildSearchTerms, _resetAuth } = require('../lib/hltb');
const { _reset, getCached, setCache } = require('../lib/cache');
const { db } = require('../lib/db');
const { MISS_CACHE_TTL_MS } = require('../lib/config');
const { _resetCircuitBreakers } = require('../lib/circuitBreaker');

// ── levenshtein ───────────────────────────────────────────────────────────

test('levenshtein: identical strings', () => {
  assert.equal(levenshtein('portal', 'portal'), 0);
});

test('levenshtein: both empty', () => {
  assert.equal(levenshtein('', ''), 0);
});

test('levenshtein: one empty', () => {
  assert.equal(levenshtein('abc', ''), 3);
  assert.equal(levenshtein('', 'abc'), 3);
});

test('levenshtein: one substitution', () => {
  assert.equal(levenshtein('cat', 'bat'), 1);
});

test('levenshtein: one insertion', () => {
  assert.equal(levenshtein('cat', 'cart'), 1);
});

test('levenshtein: one deletion', () => {
  assert.equal(levenshtein('cart', 'cat'), 1);
});

test('levenshtein: classic example', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3);
});

// ── stringSimilarity ──────────────────────────────────────────────────────

test('stringSimilarity: identical strings', () => {
  assert.equal(stringSimilarity('Portal 2', 'Portal 2'), 1);
});

test('stringSimilarity: both empty', () => {
  assert.equal(stringSimilarity('', ''), 1);
});

test('stringSimilarity: case-insensitive', () => {
  assert.equal(stringSimilarity('Portal', 'portal'), 1);
});

test('stringSimilarity: trims whitespace', () => {
  assert.equal(stringSimilarity('  Portal  ', 'Portal'), 1);
});

test('stringSimilarity: completely different strings score low', () => {
  const sim = stringSimilarity('aaa', 'zzz');
  assert.ok(sim < 0.4, `expected < 0.4 but got ${sim}`);
});

test('stringSimilarity: similar game names score above 0.4 threshold', () => {
  // "Portal 2" vs "Portal" — close enough to match
  const sim = stringSimilarity('Portal 2', 'Portal');
  assert.ok(sim >= 0.4, `expected >= 0.4 but got ${sim}`);
});

test('stringSimilarity: uses longer string as denominator', () => {
  // sim('ab', 'abcde') should equal sim('abcde', 'ab') — symmetric via max
  const s1 = stringSimilarity('ab', 'abcde');
  const s2 = stringSimilarity('abcde', 'ab');
  assert.equal(s1, s2);
});

// ── buildSearchTerms ──────────────────────────────────────────────────────

test('buildSearchTerms: strips edition words from terms', () => {
  assert.deepEqual(buildSearchTerms('Portal 2: Definitive Edition'), ['Portal', '2']);
});

test('buildSearchTerms: strips punctuation from individual tokens', () => {
  assert.deepEqual(buildSearchTerms('Batman: Arkham Asylum'), ['Batman', 'Arkham', 'Asylum']);
});

test('buildSearchTerms: falls back to all tokens when every word is an edition word', () => {
  assert.deepEqual(buildSearchTerms('Definitive Edition'), ['Definitive', 'Edition']);
});

test('buildSearchTerms: splits hyphenated tokens so HLTB AND search can match each part', () => {
  assert.deepEqual(buildSearchTerms('Bang-On Balls: Chronicles'), ['Bang', 'On', 'Balls', 'Chronicles']);
});

test('buildSearchTerms: splits dot-separated tokens (e.g. BIT.TRIP)', () => {
  assert.deepEqual(buildSearchTerms('BIT.TRIP RUNNER'), ['BIT', 'TRIP', 'RUNNER']);
});

test('buildSearchTerms: splits comma-separated numbers (e.g. 40,000)', () => {
  assert.deepEqual(buildSearchTerms('Warhammer 40,000: Gladius - Relics of War'), [
    'Warhammer',
    '40',
    '000',
    'Gladius',
    'Relics',
    'of',
    'War',
  ]);
});

// ── getHLTB ───────────────────────────────────────────────────────────────

function makeInitResponse(token = 'tok', hpKey = 'k', hpVal = 'v') {
  return { ok: true, status: 200, json: async () => ({ token, hpKey, hpVal }) };
}

function makeSearchResponse(results) {
  return { ok: true, status: 200, json: async () => ({ data: results }) };
}

// A skipped game is cached as a miss, so its HLTB source has an age and counts as cached.
for (const [label, name, type] of [
  ['no name', undefined, 'game'],
  ['an empty name', '', 'game'],
  ['a name of stripped symbols only', '™', 'game'],
  ['a type HLTB does not time', 'Portal OST', 'music'],
]) {
  test(`getHLTB: caches a short-lived miss without fetching for ${label}`, async (t) => {
    _reset();
    _resetAuth();
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('unexpected fetch');
    });
    assert.equal(await getHLTB(1, name, { type }), null);
    assert.deepEqual(getCached('hltb:1'), []);
    const { expires } = db.prepare('SELECT expires FROM cache_meta WHERE key = ?').get('hltb:1');
    assert.notEqual(expires, null);
    assert.ok(expires - Date.now() <= MISS_CACHE_TTL_MS);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
}

test('getHLTB: a skipped game keeps an existing entry, unless forced', async () => {
  _reset();
  const real = [{ game_id: 42, game_name: 'Portal OST', comp_main: 3600 }];
  setCache('hltb:1', real);
  await getHLTB(1, 'Portal OST', { type: 'music' });
  assert.deepEqual(getCached('hltb:1'), real);
  await getHLTB(1, 'Portal OST', { type: 'music', force: true });
  assert.deepEqual(getCached('hltb:1'), []);
});

test('getHLTB: returns main and extra hours on match', async (t) => {
  _reset();
  _resetAuth();
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('search/site/init')) return makeInitResponse();
    return makeSearchResponse([
      { game_id: 42, game_name: 'Portal 2', comp_main: 25200, comp_plus: 36000 }, // 7h, 10h
    ]);
  });

  const result = await getHLTB(1, 'Portal 2');
  assert.deepEqual(result, { id: 42, main: 7, extra: 10, completionist: null, all: null });
});

test('getHLTB: returns completionist and all-playstyles hours when present', async (t) => {
  _reset();
  _resetAuth();
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('search/site/init')) return makeInitResponse();
    return makeSearchResponse([
      // 8.5h main, 13.7h extra, 22.6h completionist, 10.6h all-playstyles (Portal 2's real HLTB figures)
      { game_id: 7231, game_name: 'Portal 2', comp_main: 30726, comp_plus: 49475, comp_100: 81374, comp_all: 38161 },
    ]);
  });

  const result = await getHLTB(1, 'Portal 2');
  assert.deepEqual(result, { id: 7231, main: 8.5, extra: 13.5, completionist: 22.5, all: 10.5 });
});

test('getHLTB: strips trademark symbols from query', async (t) => {
  _reset();
  _resetAuth();
  let capturedBody;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (url.includes('search/site/init')) return makeInitResponse();
    capturedBody = JSON.parse(opts.body);
    return makeSearchResponse([{ game_name: 'Hades', comp_main: 36000, comp_plus: 72000 }]);
  });

  await getHLTB(1, 'Hades™');
  assert.deepEqual(capturedBody.searchTerms, ['Hades']);
});

test('getHLTB: returns null when best match is below 0.35 similarity', async (t) => {
  _reset();
  _resetAuth();
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('search/site/init')) return makeInitResponse();
    return makeSearchResponse([{ game_name: 'Zzzzz Totally Unrelated Game', comp_main: 3600, comp_plus: 7200 }]);
  });

  const result = await getHLTB(1, 'Portal');
  assert.equal(result, null);
});

for (const [label, body] of [
  ['a non-array `data`', { data: { game_name: 'Portal' } }],
  ['no `data`', {}],
]) {
  test(`getHLTB: ${label} fails the search and is not cached`, async (t) => {
    _reset();
    _resetAuth();
    t.mock.method(console, 'warn', () => {});
    let searches = 0;
    t.mock.method(globalThis, 'fetch', async (url) => {
      if (url.includes('search/site/init')) return makeInitResponse();
      searches++;
      return { ok: true, status: 200, json: async () => body };
    });
    await assert.rejects(() => getHLTB(1, 'Portal'), /HLTB/);
    assert.equal(getCached('hltb:1'), undefined);
    await assert.rejects(() => getHLTB(1, 'Portal', { force: true }), /HLTB/);
    assert.equal(searches, 2);
  });
}

test('getHLTB: a failed lookup holds that game off for 10 minutes, unless forced', async (t) => {
  _reset();
  _resetAuth();
  t.after(_resetAuth);
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let searches = 0;
  let status = 503;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('search/site/init')) return makeInitResponse();
    searches++;
    return status === 200 ? makeSearchResponse([]) : { ok: false, status };
  });
  await assert.rejects(() => getHLTB(1, 'Portal'));
  await assert.rejects(
    () => getHLTB(1, 'Portal'),
    (err) => err.isLogged,
  );
  assert.equal(searches, 1, 'held: no new search');
  await getHLTB(2, 'Half-Life').catch(() => {});
  assert.equal(searches, 2, 'other games still search');

  status = 200;
  t.mock.timers.tick(10 * 60 * 1000 - 1);
  await assert.rejects(() => getHLTB(1, 'Portal'));
  t.mock.timers.tick(1);
  assert.equal(await getHLTB(1, 'Portal'), null);
  assert.equal(searches, 3);
});

test("getHLTB: a client's budget refusal doesn't hold the game off for others", async (t) => {
  _reset();
  _resetAuth();
  t.after(_resetAuth);
  let refuse = true;
  let searches = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('search/site/init')) return makeInitResponse();
    searches++;
    if (refuse) throw Object.assign(new Error('budget'), { isBudgetExhausted: true });
    return makeSearchResponse([]);
  });
  await assert.rejects(() => getHLTB(1, 'Portal'));
  refuse = false;
  assert.equal(await getHLTB(1, 'Portal'), null);
  assert.equal(searches, 2);
});

const badSearchReply = { ok: true, status: 200, json: async () => ({ data: 'blocked' }) };

test('getHLTB: a 200 with a malformed body does not mark the token accepted', async (t) => {
  _reset();
  _resetAuth();
  t.after(_resetAuth);
  t.mock.method(console, 'warn', () => {});
  let initCalls = 0;
  const replies = [badSearchReply, { ok: false, status: 401 }];
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('search/site/init')) {
      initCalls++;
      return makeInitResponse();
    }
    return replies.shift();
  });

  await assert.rejects(() => getHLTB(1, 'Portal'));
  await assert.rejects(() => getHLTB(2, 'Half-Life'), /fresh token/);
  await assert.rejects(() => getHLTB(3, 'Portal 2'), /auth unavailable/);
  assert.equal(initCalls, 1, 'the 401 holds off re-init like a block');
});

test('getHLTB: a 200 with a malformed body does not reset the breaker streak', async (t) => {
  _reset();
  _resetAuth();
  t.after(_resetAuth);
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const replies = [{ ok: false, status: 403 }, badSearchReply, { ok: false, status: 403 }];
  t.mock.method(globalThis, 'fetch', async (url) =>
    url.includes('search/site/init') ? makeInitResponse() : replies.shift(),
  );

  await assert.rejects(() => getHLTB(1, 'Portal'));
  t.mock.timers.tick(31 * 1000);
  await assert.rejects(() => getHLTB(2, 'Half-Life'));
  await assert.rejects(() => getHLTB(3, 'Portal 2'));
  t.mock.timers.tick(31 * 1000);
  await assert.rejects(() => getHLTB(4, 'Left 4 Dead'), /circuit open/);
});

test('getHLTB: returns null when no results', async (t) => {
  _reset();
  _resetAuth();
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('search/site/init')) return makeInitResponse();
    return makeSearchResponse([]);
  });

  const result = await getHLTB(1, 'Portal');
  assert.equal(result, null);
});

test('getHLTB: a 401 on a token searches already accepted (expired) re-inits at once, no cooldown', async (t) => {
  _reset();
  _resetAuth();
  t.after(_resetAuth);
  t.mock.method(console, 'warn', () => {});
  let initCalls = 0;
  let searchStatus = 200;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('search/site/init')) {
      initCalls++;
      return makeInitResponse();
    }
    return searchStatus === 200 ? makeSearchResponse([]) : { ok: false, status: searchStatus };
  });

  await getHLTB(1, 'Portal');
  searchStatus = 401;
  await assert.rejects(() => getHLTB(2, 'Half-Life'));
  assert.equal(initCalls, 1);

  await assert.rejects(() => getHLTB(3, 'Portal 2'));
  assert.equal(initCalls, 2, 'init should be retried immediately after an expired-token 401');
});

test('getHLTB: a 401 on a fresh token (no search accepted it) holds off re-init like a 403', async (t) => {
  _reset();
  _resetAuth();
  t.after(_resetAuth);
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let initCalls = 0;
  let searchCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('search/site/init')) {
      initCalls++;
      return makeInitResponse();
    }
    searchCalls++;
    return { ok: false, status: 401 };
  });

  await assert.rejects(() => getHLTB(1, 'Portal'));
  await assert.rejects(() => getHLTB(2, 'Half-Life'));
  assert.equal(initCalls, 1);
  assert.equal(searchCalls, 1);

  t.mock.timers.tick(31 * 1000);
  await assert.rejects(() => getHLTB(3, 'Portal 2'));
  assert.equal(initCalls, 2, 're-init resumes after the retry window');
});

test('getHLTB: two fresh-token 401s in a row open the circuit like 403s', async (t) => {
  _reset();
  _resetAuth();
  t.after(_resetAuth);
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) =>
    url.includes('search/site/init') ? makeInitResponse() : { ok: false, status: 401 },
  );

  await assert.rejects(() => getHLTB(1, 'Portal'));
  t.mock.timers.tick(31 * 1000);
  await assert.rejects(() => getHLTB(2, 'Half-Life'));
  const calls = fetchMock.mock.callCount();

  t.mock.timers.tick(31 * 1000);
  await assert.rejects(() => getHLTB(3, 'Portal 2'), /circuit open/);
  assert.equal(fetchMock.mock.callCount(), calls, 'no request while the circuit is open');
});

test('getHLTB: a search 403 (a block, unlike an expired-token 401) holds off re-init for the retry window', async (t) => {
  _reset();
  _resetAuth();
  t.after(_resetAuth);
  let initCalls = 0;
  let searchCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('search/site/init')) {
      initCalls++;
      return makeInitResponse();
    }
    searchCalls++;
    return { ok: false, status: 403 };
  });

  await assert.rejects(() => getHLTB(1, 'Portal'));
  await assert.rejects(() => getHLTB(2, 'Half-Life'));
  assert.equal(initCalls, 1);
  assert.equal(searchCalls, 1);
});

test('getHLTB: two search 403s in a row open the circuit for 5 minutes, failing fast without a request', async (t) => {
  _reset();
  _resetAuth();
  t.after(_resetAuth);
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) =>
    url.includes('search/site/init') ? makeInitResponse() : { ok: false, status: 403 },
  );

  await assert.rejects(() => getHLTB(1, 'Portal'));
  t.mock.timers.tick(31 * 1000); // past the init retry window
  await assert.rejects(() => getHLTB(2, 'Half-Life')); // the second 403 trips it
  const calls = fetchMock.mock.callCount();

  t.mock.timers.tick(31 * 1000);
  await assert.rejects(() => getHLTB(3, 'Portal 2'), /circuit open/);
  assert.equal(fetchMock.mock.callCount(), calls, 'no request while the circuit is open');

  t.mock.timers.tick(5 * 60 * 1000);
  await assert.rejects(() => getHLTB(4, 'Left 4 Dead'));
  assert.ok(fetchMock.mock.callCount() > calls, 'requests resume once the block expires');
});

test('getHLTB: searches already queued when the circuit opens never reach HLTB', async (t) => {
  _reset();
  _resetAuth();
  _resetCircuitBreakers();
  t.after(_resetAuth);
  t.after(_resetCircuitBreakers);
  t.mock.method(console, 'warn', () => {});
  let searchCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('search/site/init')) return makeInitResponse();
    searchCalls++;
    return { ok: false, status: 403 };
  });

  // 3 searches run at once; at most one more can start between the first 403 and the second,
  // which opens the circuit. The rest were queued and must fail without a request.
  const names = [
    'Portal',
    'Half-Life',
    'Portal 2',
    'Left 4 Dead',
    'Dota 2',
    'Team Fortress 2',
    'Counter-Strike',
    'Ricochet',
  ];
  const results = await Promise.allSettled(names.map((name, i) => getHLTB(i + 1, name)));
  assert.ok(results.every((r) => r.status === 'rejected'));
  assert.ok(searchCalls <= 4, `${searchCalls} searches`);
});

test('getHLTB: throttles the "[HLTB] search failed" warning to once per 30s window', async (t) => {
  _reset();
  _resetAuth();
  // `now` must be passed explicitly — mock timers otherwise start the mocked clock at epoch 0,
  // which would make _hltbSearchWarnedAt's own "0 means never" sentinel
  // (reset by _resetAuth() above, before the mock takes over) look like "just failed at time
  // 0" instead, spuriously triggering the auth-retry backoff and short-circuiting getHLTB
  // before it ever reaches the search call this test means to exercise.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const warnMock = t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('search/site/init')) return makeInitResponse();
    return { ok: false, status: 500 }; // search endpoint itself rejecting everything
  });

  // A burst of failures across several different games (as a batch load would produce) within
  // the throttle window must only warn once, not once per game.
  await assert.rejects(() => getHLTB(1, 'Portal'));
  await assert.rejects(() => getHLTB(2, 'Half-Life'));
  await assert.rejects(() => getHLTB(3, 'Half-Life 2'));
  assert.equal(warnMock.mock.callCount(), 1);

  // Once the throttle window elapses, the next failure warns again.
  t.mock.timers.tick(31 * 1000);
  await assert.rejects(() => getHLTB(4, 'Portal 2'));
  assert.equal(warnMock.mock.callCount(), 2);
});

test('getHLTB: an error the throttle held back is marked logged only if it repeats the warned one', async (t) => {
  _reset();
  _resetAuth();
  t.after(_resetAuth);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.method(console, 'warn', () => {});
  let malformed = false;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('search/site/init')) return makeInitResponse();
    if (malformed)
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token <');
        },
      };
    return { ok: false, status: 500 };
  });

  const error = (fn) => fn().then(assert.fail, (err) => err);
  assert.equal((await error(() => getHLTB(1, 'Portal'))).isLogged, true);
  assert.equal((await error(() => getHLTB(2, 'Half-Life'))).isLogged, true, 'same failure, already warned');
  malformed = true;
  assert.ok(!(await error(() => getHLTB(3, 'Portal 2'))).isLogged, 'a different failure the throttle held back');
});

test('getHLTB: throws when init fails', async (t) => {
  _reset();
  _resetAuth();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));

  await assert.rejects(
    () => getHLTB(1, 'Portal'),
    (err) => /auth unavailable/i.test(err.message),
  );
});

test('getHLTB: skips init retry within 30s cooldown after failed init', async (t) => {
  _reset();
  _resetAuth();
  let initCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('search/site/init')) {
      initCalls++;
      return { ok: false, status: 503 };
    }
    return makeSearchResponse([]);
  });

  await assert.rejects(() => getHLTB(1, 'Portal'));
  assert.equal(initCalls, 1);

  // Second call is within the 30s window — init must not be retried
  await assert.rejects(() => getHLTB(1, 'Portal'));
  assert.equal(initCalls, 1, 'init should not be retried within cooldown window');
  _resetAuth();
});

test('getHLTB: an init answering without a token also holds off re-init within the cooldown', async (t) => {
  _reset();
  _resetAuth();
  let initCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('search/site/init')) {
      initCalls++;
      return { ok: true, json: async () => ({}) };
    }
    return makeSearchResponse([]);
  });

  await assert.rejects(() => getHLTB(1, 'Portal'));
  await assert.rejects(() => getHLTB(2, 'Portal 2'));
  assert.equal(initCalls, 1, 'init should not be retried within cooldown window');
  _resetAuth();
});

test('getHLTB: picks the best match by similarity, not first result', async (t) => {
  _reset();
  _resetAuth();
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('search/site/init')) return makeInitResponse();
    return makeSearchResponse([
      { game_id: 1, game_name: 'Portal Stories: Mel', comp_main: 18000, comp_plus: 21600 }, // weaker match
      { game_id: 2, game_name: 'Portal', comp_main: 7200, comp_plus: 14400 }, // exact match
    ]);
  });

  const result = await getHLTB(1, 'Portal');
  assert.deepEqual(result, { id: 2, main: 2, extra: 4, completionist: null, all: null }); // Portal's times, not Portal Stories
});

// ── 429 pause ──────────────────────────────────────────────────────────────

function pausedHLTB(t, searchAnswer) {
  _reset();
  _resetAuth();
  _resetCircuitBreakers();
  t.after(_resetAuth);
  t.after(_resetCircuitBreakers);
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const searches = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('search/site/init')) return makeInitResponse();
    searches.push(Date.now());
    return searchAnswer(searches.length);
  });
  return searches;
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};
const too = (retryAfter) => ({
  ok: false,
  status: 429,
  headers: new Headers(retryAfter === undefined ? {} : { 'retry-after': retryAfter }),
});

test('getHLTB: a 429 holds every queued search until Retry-After has passed, and is not retried', async (t) => {
  const searches = pausedHLTB(t, (n) => (n === 1 ? too('2') : makeSearchResponse([])));
  await assert.rejects(() => getHLTB(1, 'Portal'), /429/);
  const next = getHLTB(2, 'Half-Life');
  await flush();
  t.mock.timers.tick(1999);
  await flush();
  assert.equal(searches.length, 1, 'nothing goes out before Retry-After');
  t.mock.timers.tick(1);
  await flush();
  assert.equal(searches.length, 2, 'the next search, not a retry of the refused one');
  await next;
});

test('getHLTB: an HTTP-date Retry-After holds searches until that date', async (t) => {
  const searches = pausedHLTB(t, (n) =>
    n === 1 ? too(new Date(Date.now() + 5000).toUTCString()) : makeSearchResponse([]),
  );
  await assert.rejects(() => getHLTB(1, 'Portal'));
  const next = getHLTB(2, 'Half-Life');
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(searches.length, 1);
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(searches.length, 2);
  await next;
});

test('getHLTB: concurrent searches refused by one 429 burst back off once, not once each', async (t) => {
  const searches = pausedHLTB(t, (n) => (n <= 3 ? too() : makeSearchResponse([])));
  // Three slots, all in flight when HLTB starts refusing: the burst is one 2 s back-off, not 2+4+8.
  await Promise.all([1, 2, 3].map((id) => assert.rejects(() => getHLTB(id, `Game ${id}`))));
  const next = getHLTB(4, 'Portal');
  t.mock.timers.tick(1999);
  await flush();
  assert.equal(searches.length, 3);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(searches.length, 4);
  await next;
});

test("getHLTB: a success sent before a 429 burst doesn't undo its back-off, which grows with the next burst", async (t) => {
  // In flight together: 429, 200, 429 (one burst, 2 s); then the next search's 429 is a new one: 4 s.
  const searches = pausedHLTB(t, (n) => (n === 2 || n >= 5 ? makeSearchResponse([]) : too()));
  await Promise.allSettled([1, 2, 3].map((id) => getHLTB(id, `Game ${id}`)));
  const fourth = getHLTB(4, 'Portal').catch(() => {});
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(searches.length, 4);
  await fourth;
  const fifth = getHLTB(5, 'Half-Life');
  t.mock.timers.tick(3999);
  await flush();
  assert.equal(searches.length, 4, 'the second burst backs off 4 s');
  t.mock.timers.tick(1);
  await flush();
  assert.equal(searches.length, 5);
  await fifth;
});

test('getHLTB: a search already waiting out a pause waits for a longer one that comes in meanwhile', async (t) => {
  let answerSecond;
  const second = new Promise((r) => (answerSecond = r));
  const searches = pausedHLTB(t, (n) => (n === 1 ? too() : n === 2 ? second : makeSearchResponse([])));
  const first = assert.rejects(() => getHLTB(1, 'Portal'));
  const slow = assert.rejects(() => getHLTB(2, 'Half-Life'));
  await first; // 2 s pause
  const waiting = getHLTB(3, 'Portal 2'); // starts waiting it out
  await flush();
  answerSecond(too('10')); // meanwhile, HLTB asks for 10 s
  await slow;
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(searches.length, 2, 'still waiting: Retry-After was 10 s');
  t.mock.timers.tick(8000);
  await flush();
  assert.equal(searches.length, 3);
  await waiting;
});

test('getHLTB: searches queued on a fresh token that 401s count as one block, not a trip', async (t) => {
  _reset();
  _resetAuth();
  _resetCircuitBreakers();
  t.after(_resetAuth);
  t.after(_resetCircuitBreakers);
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) =>
    url.includes('search/site/init') ? makeInitResponse() : { ok: false, status: 401 },
  );

  const batch = ['Portal', 'Half-Life', 'Half-Life 2', 'Portal 2'].map((name, i) => getHLTB(i + 1, name));
  for (const p of batch) await assert.rejects(p, (err) => !/circuit open/.test(err.message));

  t.mock.timers.tick(31 * 1000);
  const calls = fetchMock.mock.callCount();
  await assert.rejects(
    () => getHLTB(5, 'Quake'),
    (err) => !/circuit open/.test(err.message),
  );
  assert.ok(fetchMock.mock.callCount() > calls, 'the circuit stayed closed: a new token is tried');
});

test("getHLTB: the search warning keeps a network failure's cause", async (t) => {
  _reset();
  _resetAuth();
  t.after(_resetAuth);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const warnMock = t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('search/site/init')) return makeInitResponse();
    throw new TypeError('fetch failed', { cause: new Error('ECONNRESET') });
  });

  await assert.rejects(() => getHLTB(1, 'Portal'));
  const warned = warnMock.mock.calls.map((c) => c.arguments.map(String).join(' ')).find((l) => l.startsWith('[HLTB]'));
  assert.match(warned, /ECONNRESET/);
});

test('getHLTB: an expired match is served when its refetch fails, and while that game is held off', async (t) => {
  _reset([
    ['hltb:1', { value: [{ game_id: 42, game_name: 'Portal', comp_main: 3600 }], ts: 0, expires: Date.now() - 1 }],
  ]);
  _resetAuth();
  t.after(_resetAuth);
  t.mock.method(console, 'warn', () => {});
  let searches = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('search/site/init')) return makeInitResponse();
    searches++;
    return { ok: false, status: 503 };
  });
  assert.equal((await getHLTB(1, 'Portal'))?.id, 42);
  assert.equal((await getHLTB(1, 'Portal'))?.id, 42, 'held, still served');
  assert.equal(searches, 1);
});

// "Unreleased" is inferred (a coming-soon browse item and no reviews), so it never hides or wipes times already cached.
test('getHLTB: an unreleased game serves cached times, and a forced one searches instead of wiping them', async (t) => {
  _reset();
  _resetAuth();
  const real = [{ game_id: 42, game_name: 'Portal', comp_main: 3600 }];
  setCache('hltb:1', real);
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) =>
    url.includes('search/site/init') ? makeInitResponse() : makeSearchResponse(real),
  );
  assert.equal((await getHLTB(1, 'Portal', { unreleased: true }))?.id, 42);
  assert.equal(fetchMock.mock.callCount(), 0);
  ageCache();
  assert.equal((await getHLTB(1, 'Portal', { unreleased: true, force: true }))?.id, 42);
  assert.ok(fetchMock.mock.callCount() > 0, 'searched');
  assert.deepEqual(getCached('hltb:1'), real);
});
