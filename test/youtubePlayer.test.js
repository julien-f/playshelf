'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  youtubeEmbedUrl,
  youtubeCommand,
  parseYoutubeMessage,
  YOUTUBE_LISTENING,
} = require('../public/youtubePlayer.ts');

const msg = (o) => JSON.stringify(o);

test('youtubeEmbedUrl: the privacy-enhanced domain, autoplaying (it loads on a click), its API on for this origin', () => {
  assert.equal(
    youtubeEmbedUrl('a-b_C', { origin: 'https://steam.isonoe.net', muted: false }),
    'https://www.youtube-nocookie.com/embed/a-b_C?autoplay=1&enablejsapi=1&origin=https%3A%2F%2Fsteam.isonoe.net',
  );
  assert.match(youtubeEmbedUrl('x', { origin: 'http://localhost:3000', muted: true }), /&mute=1$/);
});

test('youtubeCommand and YOUTUBE_LISTENING: the messages iframe_api posts', () => {
  assert.deepEqual(JSON.parse(youtubeCommand('pauseVideo')), {
    event: 'command',
    func: 'pauseVideo',
    args: [],
    id: 1,
    channel: 'widget',
  });
  assert.equal(JSON.parse(YOUTUBE_LISTENING).event, 'listening');
});

test('parseYoutubeMessage: play and mute state from its reports, as a string or an object', () => {
  assert.deepEqual(parseYoutubeMessage(msg({ event: 'onStateChange', info: 1 })), { playing: true });
  assert.deepEqual(parseYoutubeMessage(msg({ event: 'onStateChange', info: 3 })), { playing: true }); // buffering
  assert.deepEqual(parseYoutubeMessage(msg({ event: 'onStateChange', info: 2 })), { playing: false });
  assert.deepEqual(parseYoutubeMessage(msg({ event: 'onStateChange', info: 0 })), { playing: false });
  assert.deepEqual(parseYoutubeMessage(msg({ event: 'infoDelivery', info: { playerState: -1, muted: true } })), {
    playing: false,
    muted: true,
  });
  assert.deepEqual(parseYoutubeMessage({ event: 'infoDelivery', info: { currentTime: 3 } }), {});
  assert.deepEqual(parseYoutubeMessage(msg({ event: 'initialDelivery', info: { muted: false } })), { muted: false });
});

test('parseYoutubeMessage: anything else is no state', () => {
  for (const data of [
    'not json',
    '"x"',
    'null',
    msg({ event: 'onReady', info: null }),
    42,
    null,
    { event: 'onStateChange' },
  ])
    assert.equal(parseYoutubeMessage(data), null);
});
