import type { GameMeta } from './types.ts';
import { isIgdbKey, type GameKey } from './gameKey.ts';

export interface MediaItem {
  type: 'image' | 'video';
  main?: string;
  hls?: string | null;
  thumb: string;
  shotId: string;
  name?: string | null; // a trailer's, as Steam titles it
  youtube?: string; // a game outside Steam's video: the lightbox embeds YouTube's player
  contain?: boolean; // a portrait cover standing in for the banner: shown whole, not cropped
}
// A Steam game's meta, or a game outside Steam's (IGDB's banner pick, string screenshot ids, YouTube videos).
export type MediaMeta = Pick<GameMeta, 'banner' | 'movies'> & {
  bannerIsCover?: boolean;
  screenshots?: { id: number | string; thumbnail: string; full: string }[];
};

// youtube-nocookie: no cookies until the viewer plays it (docs/dev/decisions.md).
export const youtubeEmbedUrl = (id: string) =>
  `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1`;

export function buildMediaItems(appid: GameKey, details: MediaMeta | null | undefined): MediaItem[] {
  // `details.banner` (see extractAppDetails in lib/steam.js) is Steam's own header image
  // for this specific game, resolved once store metadata has loaded — before that (the
  // game is still `loading`, so `details` itself is absent), guess the conventional CDN
  // path as a placeholder; it's replaced by the real one as soon as metadata arrives, same
  // as every other placeholder in the panel. Guessing here unconditionally (regardless of
  // whether the real header image happens to exist at that path) used to mean a game
  // without one showed a permanently broken hero image no matter how many times the panel
  // was reopened, since the guessed URL never changes.
  // A game outside Steam has no CDN path to guess: without a banner, no Cover item.
  const bannerUrl =
    details?.banner || (isIgdbKey(appid) ? '' : `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/header.jpg`);
  const movies = details?.movies || [];
  const screenshots = details?.screenshots || [];
  return [
    ...(bannerUrl
      ? [
          {
            type: 'image' as const,
            main: bannerUrl,
            thumb: bannerUrl,
            shotId: 'banner',
            ...(details?.bannerIsCover && { contain: true }),
          },
        ]
      : []),
    ...movies.map((m) => ({
      type: 'video' as const,
      hls: m.hls,
      thumb: m.thumbnail,
      shotId: `v${m.id}`,
      name: m.name,
      ...(m.youtube && { youtube: m.youtube }),
    })),
    ...screenshots.map((s) => ({ type: 'image' as const, main: s.full, thumb: s.thumbnail, shotId: `s${s.id}` })),
  ];
}

export function resolveShotIndex(shots: MediaItem[], idxOrShotId: number | string): number {
  if (typeof idxOrShotId === 'string') {
    const idx = shots.findIndex((s) => s.shotId === idxOrShotId);
    return idx >= 0 ? idx : 0;
  }
  return Math.max(0, Math.min(idxOrShotId, shots.length - 1));
}

// What a game step is leaving, for `preferredShotIndex`: the Cover apart from other images.
export type ShotKind = MediaItem['type'] | 'cover';

// The shot to land on when the lightbox is re-pointed at *another* game (↑/↓, R) rather than
// opened on one the viewer picked out of the hero themselves. Never the banner when there's
// anything else, unless the Cover is what's being left: it's Steam's 460×215 header strip — the
// least rewarding thing to open fullscreen, and the one item with no separate thumbnail to stand in
// while it loads. A return of 0 therefore means "this game has nothing but its banner" (which is
// also how a caller tells that the media simply haven't loaded yet) or "leaving the Cover".
//
// Kind-preserving, so paging on from a trailer keeps landing on trailers, and from the Cover on
// covers — but never from an image to a trailer: the lightbox autoplays video, so promoting an
// image to one would start a trailer unasked on every step through a game that happens to have no
// screenshots.
export function preferredShotIndex(shots: MediaItem[], leaving: ShotKind): number {
  if (leaving === 'cover') return 0;
  const firstOfType = (type: MediaItem['type']) => shots.findIndex((s) => s.type === type && s.shotId !== 'banner');
  const sameKind = leaving === 'video' ? firstOfType('video') : -1;
  if (sameKind >= 0) return sameKind;
  const screenshot = firstOfType('image');
  return screenshot >= 0 ? screenshot : 0;
}

// What the viewer calls an item, numbered within its own kind: the first screenshot is
// "Screenshot 1", not its position behind the banner and the trailers. Shared by the lightbox's
// counter and alt text and the panel's thumbnails.
export function mediaLabel(items: MediaItem[], i: number): string {
  const item = items[i];
  if (item.shotId === 'banner') return 'Cover';
  const sameKind = items.filter((m) => m.type === item.type && m.shotId !== 'banner');
  return `${item.type === 'video' ? 'Trailer' : 'Screenshot'} ${sameKind.indexOf(item) + 1} of ${sameKind.length}`;
}
