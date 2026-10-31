'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildMediaItems, resolveShotIndex, preferredShotIndex, mediaLabel } = require('../public/mediaItems.ts');

// ── buildMediaItems ───────────────────────────────────────────────────────────

test('buildMediaItems: banner only when details is null', () => {
  const items = buildMediaItems(570, null);
  assert.equal(items.length, 1);
  assert.equal(items[0].shotId, 'banner');
  assert.equal(items[0].type, 'image');
  assert.ok(items[0].main.includes('/570/'));
  assert.equal(items[0].main, items[0].thumb);
});

test('buildMediaItems: banner only when details has no movies or screenshots', () => {
  const items = buildMediaItems(570, {});
  assert.equal(items.length, 1);
  assert.equal(items[0].shotId, 'banner');
});

test('buildMediaItems: uses details.banner when present instead of guessing the CDN path', () => {
  const items = buildMediaItems(570, { banner: 'https://cdn.akamai.steamstatic.com/steam/apps/570/real_header.jpg' });
  assert.equal(items[0].main, 'https://cdn.akamai.steamstatic.com/steam/apps/570/real_header.jpg');
  assert.equal(items[0].thumb, items[0].main);
});

test('buildMediaItems: includes movies with v<id> shotId', () => {
  const details = {
    movies: [{ id: 256810, thumbnail: 'thumb.jpg', hls: 'video.m3u8' }],
    screenshots: [],
  };
  const items = buildMediaItems(570, details);
  assert.equal(items.length, 2);
  assert.equal(items[1].shotId, 'v256810');
  assert.equal(items[1].type, 'video');
  assert.equal(items[1].hls, 'video.m3u8');
  assert.equal(items[1].thumb, 'thumb.jpg');
});

test('buildMediaItems: includes screenshots with s<id> shotId', () => {
  const details = {
    movies: [],
    screenshots: [
      { id: 0, thumbnail: 'thumb0.jpg', full: 'full0.jpg' },
      { id: 1, thumbnail: 'thumb1.jpg', full: 'full1.jpg' },
    ],
  };
  const items = buildMediaItems(570, details);
  assert.equal(items.length, 3);
  assert.equal(items[1].shotId, 's0');
  assert.equal(items[1].main, 'full0.jpg');
  assert.equal(items[1].thumb, 'thumb0.jpg');
  assert.equal(items[2].shotId, 's1');
});

test('buildMediaItems: movies come before screenshots', () => {
  const details = {
    movies: [{ id: 1, thumbnail: '', hls: '' }],
    screenshots: [{ id: 0, thumbnail: '', full: '' }],
  };
  const items = buildMediaItems(570, details);
  assert.equal(items[0].shotId, 'banner');
  assert.equal(items[1].shotId, 'v1');
  assert.equal(items[2].shotId, 's0');
});

// ── resolveShotIndex ──────────────────────────────────────────────────────────

test('resolveShotIndex: numeric 0 returns 0', () => {
  const shots = [{ shotId: 'banner' }, { shotId: 's0' }];
  assert.equal(resolveShotIndex(shots, 0), 0);
});

test('resolveShotIndex: numeric index within range is returned as-is', () => {
  const shots = [{ shotId: 'banner' }, { shotId: 'v1' }, { shotId: 's0' }];
  assert.equal(resolveShotIndex(shots, 2), 2);
});

test('resolveShotIndex: numeric index beyond end is clamped to last', () => {
  const shots = [{ shotId: 'banner' }, { shotId: 's0' }];
  assert.equal(resolveShotIndex(shots, 99), 1);
});

test('resolveShotIndex: negative numeric index is clamped to 0', () => {
  const shots = [{ shotId: 'banner' }, { shotId: 's0' }];
  assert.equal(resolveShotIndex(shots, -1), 0);
});

test('resolveShotIndex: string shotId resolves to correct index', () => {
  const shots = [{ shotId: 'banner' }, { shotId: 'v256810' }, { shotId: 's0' }];
  assert.equal(resolveShotIndex(shots, 'banner'), 0);
  assert.equal(resolveShotIndex(shots, 'v256810'), 1);
  assert.equal(resolveShotIndex(shots, 's0'), 2);
});

test('resolveShotIndex: unknown string shotId falls back to 0', () => {
  const shots = [{ shotId: 'banner' }, { shotId: 's0' }];
  assert.equal(resolveShotIndex(shots, 'nonexistent'), 0);
});

// ── preferredShotIndex ────────────────────────────────────────────────────────

const BANNER = { type: 'image', shotId: 'banner' };

test('preferredShotIndex: leaving an image lands on the first screenshot, not the banner', () => {
  const shots = [
    BANNER,
    { type: 'video', shotId: 'v1' },
    { type: 'image', shotId: 's0' },
    { type: 'image', shotId: 's1' },
  ];
  assert.equal(preferredShotIndex(shots, 'image'), 2);
});

test('preferredShotIndex: leaving a video lands on the first video', () => {
  const shots = [BANNER, { type: 'video', shotId: 'v1' }, { type: 'image', shotId: 's0' }];
  assert.equal(preferredShotIndex(shots, 'video'), 1);
});

test('preferredShotIndex: leaving a video falls back to a screenshot when the game has no trailer', () => {
  const shots = [BANNER, { type: 'image', shotId: 's0' }];
  assert.equal(preferredShotIndex(shots, 'image'), 1);
  assert.equal(preferredShotIndex(shots, 'video'), 1);
});

// The lightbox autoplays video, so an image must never be promoted to one — a game with a
// trailer but no screenshots stays on its banner rather than starting a trailer unasked.
test('preferredShotIndex: leaving an image never lands on a video', () => {
  const shots = [BANNER, { type: 'video', shotId: 'v1' }];
  assert.equal(preferredShotIndex(shots, 'image'), 0);
  assert.equal(preferredShotIndex(shots, 'video'), 1);
});

test('preferredShotIndex: leaving the cover lands on the cover', () => {
  const shots = [BANNER, { type: 'video', shotId: 'v1' }, { type: 'image', shotId: 's0' }];
  assert.equal(preferredShotIndex(shots, 'cover'), 0);
});

// 0 is how the caller tells the details haven't streamed in yet — see the latch in lightbox.tsx.
test('preferredShotIndex: a banner-only game yields 0 whichever kind is being left', () => {
  assert.equal(preferredShotIndex([BANNER], 'image'), 0);
  assert.equal(preferredShotIndex([BANNER], 'video'), 0);
});

// ── mediaLabel ────────────────────────────────────────────────────────────────

test('mediaLabel: the banner is the cover, and each kind is numbered on its own', () => {
  const items = buildMediaItems(570, {
    movies: [
      { id: 1, thumbnail: 't1', hls: null },
      { id: 2, thumbnail: 't2', hls: null },
    ],
    screenshots: [{ id: 7, thumbnail: 's', full: 'S' }],
  });
  assert.deepEqual(
    items.map((_, i) => mediaLabel(items, i)),
    ['Cover', 'Trailer 1 of 2', 'Trailer 2 of 2', 'Screenshot 1 of 1'],
  );
});

test('buildMediaItems: a game outside Steam gets no Steam CDN guess, and no Cover without one', () => {
  assert.deepEqual(buildMediaItems('igdb:9001', null), []);
  const shots = [{ id: 'abc', thumbnail: 't', full: 'f' }];
  assert.deepEqual(
    buildMediaItems('igdb:9001', { banner: '', screenshots: shots, movies: [] }).map((m) => m.shotId),
    ['sabc'],
  );
  assert.equal(buildMediaItems('igdb:9001', { banner: 'c.jpg', screenshots: shots, movies: [] })[0].main, 'c.jpg');
});

test('buildMediaItems: a game outside Steam has its YouTube videos as video items, its cover banner contained', () => {
  const movies = [
    { id: 7, name: 'Launch Trailer', thumbnail: 'https://i.ytimg.com/vi/abc/hqdefault.jpg', hls: null, youtube: 'abc' },
  ];
  const items = buildMediaItems('igdb:9001', { banner: 'cov.jpg', bannerIsCover: true, screenshots: [], movies });
  assert.deepEqual(items, [
    { type: 'image', main: 'cov.jpg', thumb: 'cov.jpg', shotId: 'banner', contain: true },
    {
      type: 'video',
      hls: null,
      thumb: 'https://i.ytimg.com/vi/abc/hqdefault.jpg',
      shotId: 'v7',
      name: 'Launch Trailer',
      youtube: 'abc',
    },
  ]);
  assert.equal(mediaLabel(items, 1), 'Trailer 1 of 1');
  assert.equal(preferredShotIndex(items, 'video'), 1);
  // Landscape art is cropped like Steam's header.
  assert.equal(buildMediaItems('igdb:9001', { banner: 'art.jpg', bannerIsCover: false })[0].contain, undefined);
});
