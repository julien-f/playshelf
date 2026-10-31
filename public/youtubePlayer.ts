// YouTube's IFrame Player API spoken over postMessage, without loading its iframe_api script.
export const YOUTUBE_ORIGIN = 'https://www.youtube-nocookie.com';

// youtube-nocookie: no cookies until the viewer plays it (docs/dev/decisions.md). `origin` lets the player post back.
export const youtubeEmbedUrl = (id: string, { origin, muted }: { origin: string; muted: boolean }) =>
  `${YOUTUBE_ORIGIN}/embed/${encodeURIComponent(id)}?autoplay=1&enablejsapi=1&origin=${encodeURIComponent(origin)}` +
  (muted ? '&mute=1' : '');

export type YoutubeCommand = 'playVideo' | 'pauseVideo' | 'mute' | 'unMute';

// `id` and `channel` as iframe_api's own messages carry them.
export const youtubeCommand = (func: YoutubeCommand) =>
  JSON.stringify({ event: 'command', func, args: [], id: 1, channel: 'widget' });

// Asks the player to report its state (`infoDelivery`, `onStateChange`) to this window.
export const YOUTUBE_LISTENING = JSON.stringify({ event: 'listening', id: 1, channel: 'widget' });

export interface YoutubeState {
  playing?: boolean;
  muted?: boolean;
}

// Player states: 1 playing, 3 buffering (still meant to play); -1 unstarted, 0 ended, 2 paused, 5 cued.
const isPlaying = (state: number) => state === 1 || state === 3;

// What a message from the player says of its state; null when it isn't one of its state reports.
export function parseYoutubeMessage(data: unknown): YoutubeState | null {
  let msg: unknown = data;
  if (typeof data === 'string') {
    try {
      msg = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!msg || typeof msg !== 'object') return null;
  const { event, info } = msg as { event?: unknown; info?: unknown };
  if (event === 'onStateChange') return typeof info === 'number' ? { playing: isPlaying(info) } : null;
  if ((event !== 'infoDelivery' && event !== 'initialDelivery') || !info || typeof info !== 'object') return null;
  const { playerState, muted } = info as { playerState?: unknown; muted?: unknown };
  const state: YoutubeState = {};
  if (typeof playerState === 'number') state.playing = isPlaying(playerState);
  if (typeof muted === 'boolean') state.muted = muted;
  return state;
}
