'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  membersFromAccountId,
  fetchAccountWishlist,
  fetchAccountWishlistData,
  resolveAccountSlot,
  accountSlotFrom,
  fetchAccountOverview,
  toAccountPlayer,
  accountInfoFrom,
  fetchAccountFriends,
} = require('../public/accountData.ts');

function withFetch(t, handler) {
  const restore = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = restore;
  });
}

test('membersFromAccountId: splits the sorted-joined id back into member steam64 ids', () => {
  assert.deepEqual(membersFromAccountId('1+2+3'), ['1', '2', '3']);
});

test('membersFromAccountId: a single-member account round-trips to a one-element array', () => {
  assert.deepEqual(membersFromAccountId('1'), ['1']);
});

test('fetchAccountOverview: sends { members }, sums playtime and maxes lastPlayed across members', async (t) => {
  let seenBody;
  withFetch(t, async (url, opts) => {
    seenBody = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({
        games: [{ appid: 440, name: 'Team Fortress 2' }],
        players: [{ steamid: '1' }, { steamid: '2' }],
        playtime: { 440: { 1: 100, 2: 50 } },
        lastPlayed: { 440: { 1: 1000, 2: 2000 } },
      }),
    };
  });

  const { games } = await fetchAccountOverview(['1', '2']);
  assert.deepEqual(seenBody, { members: ['1', '2'] });
  assert.deepEqual(games, [{ appid: 440, name: 'Team Fortress 2', playtimeMinutes: 150, lastPlayedUnix: 2000 }]);
});

test('fetchAccountOverview: missing playtime/lastPlayed entries default to 0', async (t) => {
  withFetch(t, async () => ({
    ok: true,
    json: async () => ({
      games: [{ appid: 440, name: 'Team Fortress 2' }],
      players: [{ steamid: '1' }],
      playtime: {},
      lastPlayed: {},
    }),
  }));

  const { games } = await fetchAccountOverview(['1']);
  assert.deepEqual(games, [{ appid: 440, name: 'Team Fortress 2', playtimeMinutes: 0, lastPlayedUnix: 0 }]);
});

test('fetchAccountOverview: throws with the server error message on a non-2xx response', async (t) => {
  withFetch(t, async () => ({ ok: false, json: async () => ({ error: 'rate limited' }) }));
  await assert.rejects(() => fetchAccountOverview(['1']), /rate limited/);
});

test('fetchAccountOverview: passes refresh as ?refresh=1', async (t) => {
  let seenUrl;
  withFetch(t, async (url) => {
    seenUrl = url;
    return { ok: true, json: async () => ({ games: [], players: [], playtime: {}, lastPlayed: {} }) };
  });
  await fetchAccountOverview(['1'], { refresh: true });
  assert.equal(seenUrl, '/api/common-games?refresh=1');
});

test('fetchAccountWishlist: sends { members }, returns items as-is', async (t) => {
  let seenBody;
  withFetch(t, async (url, opts) => {
    seenBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ items: [{ appid: 620, priority: 1, dateAdded: '2024-01-01' }] }) };
  });

  const { items } = await fetchAccountWishlist(['1']);
  assert.deepEqual(seenBody, { members: ['1'] });
  assert.deepEqual(items, [{ appid: 620, priority: 1, dateAdded: '2024-01-01' }]);
});

test('fetchAccountWishlist: throws with the server error message on a non-2xx response', async (t) => {
  withFetch(t, async () => ({ ok: false, json: async () => ({ error: 'private profile' }) }));
  await assert.rejects(() => fetchAccountWishlist(['1']), /private profile/);
});

test('fetchAccountWishlistData: resolves an accountId straight to a flat appid Set', async (t) => {
  let seenBody;
  withFetch(t, async (url, opts) => {
    seenBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ items: [{ appid: 620, priority: 1, dateAdded: null }] }) };
  });

  const { appids } = await fetchAccountWishlistData('1+2');
  assert.deepEqual(seenBody.members, ['1', '2']);
  assert.deepEqual(appids, new Set([620]));
});

// ── resolveAccountSlot ────────────────────────────────────────────────────────────────────

test('resolveAccountSlot: a single account resolves members/label/avatar/vanities', async (t) => {
  withFetch(t, async () => ({
    ok: true,
    json: async () => ({
      games: [{ appid: 440, name: 'TF2' }],
      players: [
        {
          steamid: '1',
          personaname: 'Alice',
          avatarmedium: 'https://x/a.jpg',
          profileurl: 'https://steamcommunity.com/id/alice/',
          timecreated: 1433965886,
          loccountrycode: 'US',
          realname: 'Alice Smith',
        },
      ],
      playtime: {},
      lastPlayed: {},
    }),
  }));

  const slot = await resolveAccountSlot(['alice']);
  assert.equal(slot.id, '1');
  assert.deepEqual(slot.members, ['1']);
  assert.deepEqual(slot.rawInputs, ['alice']);
  assert.equal(slot.label, 'Alice');
  assert.equal(slot.avatarUrl, 'https://x/a.jpg');
  assert.deepEqual(slot.vanities, { 1: 'alice' });
});

test('resolveAccountSlot: a multi-member Family sorts members, joins the label, and has no single avatar', async (t) => {
  withFetch(t, async () => ({
    ok: true,
    json: async () => ({
      games: [],
      players: [
        { steamid: '2', personaname: 'Bob', profileurl: 'https://steamcommunity.com/id/bob/' },
        { steamid: '1', personaname: 'Alice', profileurl: 'https://steamcommunity.com/profiles/1' },
      ],
      playtime: {},
      lastPlayed: {},
    }),
  }));

  const slot = await resolveAccountSlot(['bob', 'alice']);
  assert.equal(slot.id, '1+2');
  assert.deepEqual(slot.members, ['1', '2']);
  assert.equal(slot.label, 'Bob + Alice');
  assert.equal(slot.avatarUrl, undefined);
  // Keyed by steamid, not by position: the response is in the API's order, `members` is sorted.
  assert.deepEqual(slot.vanities, { 2: 'bob' });
});

test('resolveAccountSlot: throws with the server error message when the account itself fails to resolve', async (t) => {
  withFetch(t, async () => ({ ok: false, json: async () => ({ error: 'profile not found' }) }));
  await assert.rejects(() => resolveAccountSlot(['ghost']), /profile not found/);
});

test('resolveAccountSlot: resolves with the one /api/common-games request, no wishlist fetch', async (t) => {
  const urls = [];
  withFetch(t, async (url) => {
    urls.push(url);
    return {
      ok: true,
      json: async () => ({
        games: [],
        players: [{ steamid: '1', personaname: 'Alice' }],
        playtime: {},
        lastPlayed: {},
      }),
    };
  });

  const slot = await resolveAccountSlot(['alice']);
  assert.deepEqual(urls, ['/api/common-games']);
  assert.equal(slot.label, 'Alice');
});

test('accountSlotFrom: no label while a member is a placeholder, so it reads as what was typed', () => {
  const slot = accountSlotFrom([toAccountPlayer({ steamid: '1', personaname: '1', placeholder: true })], ['bob']);
  assert.equal(slot.label, undefined);
  assert.deepEqual(slot.rawInputs, ['bob']);
});

test('accountSlotFrom: flags placeholder members as unresolved, and only those', () => {
  const alice = toAccountPlayer({ steamid: '1', personaname: 'Alice' });
  const unknown = toAccountPlayer({ steamid: '2', personaname: '2', placeholder: true });
  assert.deepEqual(accountSlotFrom([alice, unknown], ['1', '2']).unresolved, ['2']);
  assert.equal('unresolved' in accountSlotFrom([alice], ['1']), false);
});

test('accountSlotFrom: a friend makes a single-account slot from its own fields', () => {
  const slot = accountSlotFrom(
    [
      {
        steamid: '1',
        name: 'Alice',
        avatarUrl: '',
        profileUrl: 'https://steamcommunity.com/id/alice/',
      },
    ],
    ['1'],
  );
  assert.equal(slot.label, 'Alice');
  assert.equal(slot.avatarUrl, undefined);
  assert.deepEqual(slot.vanities, { 1: 'alice' });
});

// ── toAccountPlayer / fetchAccountOverview ───────────────────────────────────

test('toAccountPlayer: maps a full player object onto display-ready fields', () => {
  assert.deepEqual(
    toAccountPlayer({
      steamid: '1',
      personaname: 'Alice',
      profileurl: 'https://steamcommunity.com/id/alice/',
      avatarmedium: 'https://cdn/a.jpg',
      communityvisibilitystate: 3,
      personastate: 1,
      gameCount: 42,
      timecreated: 1433965886,
      loccountrycode: 'US',
      realname: 'Alice Smith',
    }),
    {
      steamid: '1',
      name: 'Alice',
      profileUrl: 'https://steamcommunity.com/id/alice/',
      avatarUrl: 'https://cdn/a.jpg',
      isPrivate: false,
      gameCount: 42,
      memberSince: '2015-06-10',
      countryCode: 'US',
      realName: 'Alice Smith',
      placeholder: false,
    },
  );
});

test("accountInfoFrom: no label while a player is only a placeholder, so a stored name isn't overwritten", () => {
  const alice = toAccountPlayer({ steamid: '1', personaname: 'Alice', avatarmedium: 'https://cdn/a.jpg' });
  const unknown = toAccountPlayer({ steamid: '2', personaname: '2', placeholder: true });
  assert.deepEqual(accountInfoFrom([alice]), {
    label: 'Alice',
    avatarUrl: 'https://cdn/a.jpg',
    vanities: undefined,
    memberAvatars: undefined,
  });
  assert.equal(accountInfoFrom([alice, unknown]).label, undefined);
});

test("accountInfoFrom: a Family's faces per member, skipping a placeholder's and a missing one", () => {
  const alice = toAccountPlayer({ steamid: '1', personaname: 'Alice', avatarmedium: 'https://cdn/a.jpg' });
  const bob = toAccountPlayer({ steamid: '2', personaname: 'Bob' });
  const unknown = toAccountPlayer({
    steamid: '3',
    personaname: '3',
    avatarmedium: 'https://cdn/x.jpg',
    placeholder: true,
  });
  const info = accountInfoFrom([alice, bob, unknown]);
  assert.deepEqual(info.memberAvatars, { 1: 'https://cdn/a.jpg' });
  assert.equal(info.avatarUrl, undefined);
  assert.equal(accountInfoFrom([bob, unknown]).memberAvatars, undefined);
});

test('accountSlotFrom: a picked Family stores its faces per member', () => {
  const alice = toAccountPlayer({ steamid: '1', personaname: 'Alice', avatarmedium: 'https://cdn/a.jpg' });
  const bob = toAccountPlayer({ steamid: '2', personaname: 'Bob', avatarmedium: 'https://cdn/b.jpg' });
  assert.deepEqual(accountSlotFrom([alice, bob], ['alice', 'bob']).memberAvatars, {
    1: 'https://cdn/a.jpg',
    2: 'https://cdn/b.jpg',
  });
  assert.equal('memberAvatars' in accountSlotFrom([alice], ['alice']), false);
});

test('toAccountPlayer: memberSince/countryCode/realName are empty strings when Steam did not return them (private profile)', () => {
  const p = toAccountPlayer({ steamid: '1' });
  assert.equal(p.memberSince, '');
  assert.equal(p.countryCode, '');
  assert.equal(p.realName, '');
});

test('toAccountPlayer: presence is deliberately not mapped — see accountData.ts', () => {
  const p = toAccountPlayer({ steamid: '1', personastate: 3, gameextrainfo: 'Team Fortress 2' });
  assert.equal('statusClass' in p, false);
  assert.equal('statusLabel' in p, false);
});

test('toAccountPlayer: communityvisibilitystate other than 3 is private; absent is not', () => {
  assert.equal(toAccountPlayer({ steamid: '1', communityvisibilitystate: 1 }).isPrivate, true);
  assert.equal(toAccountPlayer({ steamid: '1' }).isPrivate, false);
});

test('toAccountPlayer: drops a non-http profile/avatar URL and falls back to the steamid for a name', () => {
  const p = toAccountPlayer({
    steamid: '76561198000000000',
    profileurl: 'javascript:alert(1)',
    avatarmedium: 'data:image/png;base64,x',
  });
  assert.equal(p.profileUrl, '');
  assert.equal(p.avatarUrl, '');
  assert.equal(p.name, '76561198000000000');
});

test('toAccountPlayer: a missing gameCount is null, not 0', () => {
  assert.equal(toAccountPlayer({ steamid: '1' }).gameCount, null);
  assert.equal(toAccountPlayer({ steamid: '1', gameCount: 0 }).gameCount, 0);
});

// ── fetchAccountFriends ───────────────────────────────────────────────────────

test('fetchAccountFriends: maps friends and passes through memberSince/countryCode/realName', async (t) => {
  withFetch(t, async (url, opts) => {
    assert.equal(url, '/api/friends');
    assert.deepEqual(JSON.parse(opts.body), { members: ['1'] });
    return {
      ok: true,
      json: async () => ({
        friends: [
          {
            steamid: '2',
            personaname: 'Bob',
            avatar: 'https://x/b.jpg',
            profileurl: 'https://steamcommunity.com/id/bob/',
            timecreated: 1433965886,
            loccountrycode: 'US',
            realname: 'Bob Smith',
          },
        ],
        unavailable: ['3'],
        fetchedAt: 123,
      }),
    };
  });

  const result = await fetchAccountFriends(['1']);
  assert.deepEqual(result, {
    friends: [
      {
        steamid: '2',
        name: 'Bob',
        avatarUrl: 'https://x/b.jpg',
        profileUrl: 'https://steamcommunity.com/id/bob/',
        memberSince: '2015-06-10',
        countryCode: 'US',
        realName: 'Bob Smith',
      },
    ],
    unavailable: ['3'],
    fetchedAt: 123,
  });
});

test('fetchAccountFriends: a friend Steam returned no name/location for gets empty-string fields, not undefined', async (t) => {
  withFetch(t, async () => ({
    ok: true,
    json: async () => ({ friends: [{ steamid: '2' }], unavailable: [], fetchedAt: null }),
  }));

  const result = await fetchAccountFriends(['1']);
  assert.deepEqual(result.friends[0], {
    steamid: '2',
    name: '2',
    avatarUrl: '',
    profileUrl: '',
    memberSince: '',
    countryCode: '',
    realName: '',
  });
});

test('fetchAccountFriends: a non-http(s) profile URL is dropped, so the friend renders without a link', async (t) => {
  withFetch(t, async () => ({
    ok: true,
    json: async () => ({ friends: [{ steamid: '2', profileurl: 'javascript:alert(1)' }], unavailable: [] }),
  }));
  assert.equal((await fetchAccountFriends(['1'])).friends[0].profileUrl, '');
});

test("fetchAccountOverview: returns the account's library and its member accounts from one call", async (t) => {
  let calls = 0;
  withFetch(t, async () => {
    calls++;
    return {
      ok: true,
      json: async () => ({
        games: [{ appid: 440, name: 'Team Fortress 2' }],
        players: [
          { steamid: '1', personaname: 'Alice', profileurl: 'https://steamcommunity.com/id/alice/', gameCount: 1 },
          { steamid: '2', personaname: 'Bob', gameCount: 0 },
        ],
        playtime: { 440: { 1: 10 } },
        lastPlayed: {},
      }),
    };
  });

  const { games, players } = await fetchAccountOverview(['1', '2']);
  assert.equal(calls, 1);
  assert.deepEqual(games, [{ appid: 440, name: 'Team Fortress 2', playtimeMinutes: 10, lastPlayedUnix: 0 }]);
  assert.deepEqual(
    players.map((p) => p.name),
    ['Alice', 'Bob'],
  );
  assert.equal(players[0].profileUrl, 'https://steamcommunity.com/id/alice/');
  assert.equal(players[1].profileUrl, '');
});

test("fetchAccountOverview/fetchAccountWishlist: surface the server's fetchedAt", async (t) => {
  withFetch(t, async (url) => ({
    ok: true,
    json: async () =>
      String(url).includes('wishlist')
        ? { items: [{ appid: 2, priority: 1, dateAdded: null }], fetchedAt: 5678 }
        : {
            games: [{ appid: 1, name: 'A' }],
            players: [{ steamid: '1' }],
            playtime: {},
            lastPlayed: {},
            fetchedAt: 1234,
          },
  }));
  assert.equal((await fetchAccountOverview(['1'])).fetchedAt, 1234);
  assert.equal((await fetchAccountWishlist(['1'])).fetchedAt, 5678);
});

test('fetchAccountOverview: a response with no fetchedAt (fetched fresh) is null, not undefined', async (t) => {
  withFetch(t, async () => ({
    ok: true,
    json: async () => ({ games: [], players: [], playtime: {}, lastPlayed: {} }),
  }));
  assert.equal((await fetchAccountOverview(['1'])).fetchedAt, null);
});

test('fetchAccountOverview: builds per-member owners from the playtime/lastPlayed maps', async (t) => {
  withFetch(t, async () => ({
    ok: true,
    json: async () => ({
      games: [
        { appid: 440, name: 'TF2' },
        { appid: 570, name: 'Dota' },
      ],
      players: [{ steamid: '1', personaname: 'Alice' }, { steamid: '2' }],
      // 570 is owned by member 2 only — membership comes from these maps, not the players roster.
      playtime: { 440: { 1: 120, 2: 0 }, 570: { 2: 30 } },
      lastPlayed: { 440: { 1: 1000, 2: 0 }, 570: { 2: 2000 } },
      recentPlaytime: { 440: { 1: 45 } },
    }),
  }));

  const { owners } = await fetchAccountOverview(['1', '2']);
  assert.deepEqual(owners.get(440), [
    { name: 'Alice', minutes: 120, lastPlayedSec: 1000, recentMinutes: 45 },
    { name: '2', minutes: 0, lastPlayedSec: 0, recentMinutes: 0 }, // no persona name known → the steamid stands in
  ]);
  assert.deepEqual(owners.get(570), [{ name: '2', minutes: 30, lastPlayedSec: 2000, recentMinutes: 0 }]);
});

test('fetchAccountOverview: a game nobody has an entry for gets no owners entry at all', async (t) => {
  withFetch(t, async () => ({
    ok: true,
    json: async () => ({
      games: [{ appid: 440, name: 'TF2' }],
      players: [{ steamid: '1' }],
      playtime: {},
      lastPlayed: {},
    }),
  }));
  assert.equal((await fetchAccountOverview(['1'])).owners.has(440), false);
});

test("an HTML error page (a proxy's 502) reads as the request failing, not as a JSON parse error", async (t) => {
  withFetch(t, async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }));
  await assert.rejects(fetchAccountWishlist(['1']), { message: 'Failed to fetch wishlist' });
});

test('an API error keeps its own message', async (t) => {
  withFetch(t, async () => Response.json({ error: 'Profile is private' }, { status: 400 }));
  await assert.rejects(fetchAccountWishlist(['1']), { message: 'Profile is private' });
});

test('resolveAccountSlot: an HTML error page reads as the account failing to resolve, not as a JSON parse error', async (t) => {
  withFetch(t, async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }));
  await assert.rejects(resolveAccountSlot(['alice']), { message: 'Failed to resolve account' });
});
