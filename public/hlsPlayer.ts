// Steam trailer playback (HLS) into a reused <video>, shared by the lightbox and the presentation window.

export type HlsVideo = HTMLVideoElement & { _hls?: { destroy: () => void } | null; _hlsToken?: number };

// hls.js is ~130KB gzipped and only needed once a non-Safari browser plays a trailer: loaded then,
// memoized, so the lightbox's prefetch can warm it ahead of a video shot.
let _hlsModulePromise: Promise<typeof import('hls.js').default> | null = null;
export function loadHlsModule(): Promise<typeof import('hls.js').default> {
  return (_hlsModulePromise ??= import('hls.js').then((m) => m.default));
}

// `onMutedFallback`: when the browser refuses autoplay with sound, play muted and say so (the lightbox's
// Unmute pill); without it a refused autoplay just doesn't start.
function start(videoEl: HlsVideo, onMutedFallback?: () => void) {
  // A refusal landing after a step off the trailer (stopHls bumps the token) is no longer this trailer's.
  const token = videoEl._hlsToken;
  const current = () => videoEl._hlsToken === token;
  videoEl.play().catch((e: unknown) => {
    if (!onMutedFallback || videoEl.muted || (e as Error)?.name !== 'NotAllowedError' || !current()) return;
    videoEl.muted = true;
    videoEl.play().then(
      () => current() && onMutedFallback(),
      () => {},
    );
  });
}

export async function playHls(
  videoEl: HlsVideo,
  src: string | null | undefined,
  onError: () => void,
  onMutedFallback?: () => void,
) {
  if (!src) return;
  if (videoEl._hls) {
    videoEl._hls.destroy();
    videoEl._hls = null;
  }
  if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    // Assigned as a property (not addEventListener) since videoEl is reused
    // across shots — a property assignment overwrites rather than stacking.
    videoEl.onerror = onError;
    videoEl.src = src;
    start(videoEl, onMutedFallback);
    return;
  }
  // videoEl is reused across shots, and loading hls.js is async — guard against a stale
  // load resolving after the user already stepped to a different shot (stopHls bumps this
  // same token) or reopened this same videoEl with a newer playHls call in the meantime.
  const token = (videoEl._hlsToken = (videoEl._hlsToken || 0) + 1);
  const Hls = await loadHlsModule();
  if (videoEl._hlsToken !== token) return;
  if (!Hls.isSupported()) return;
  const hls = new Hls({ autoStartLoad: true, startLevel: -1 });
  hls.on(Hls.Events.ERROR, (_event: unknown, data: { fatal?: boolean }) => {
    if (data?.fatal) onError();
  });
  hls.loadSource(src);
  hls.attachMedia(videoEl);
  hls.on(Hls.Events.MANIFEST_PARSED, () => start(videoEl, onMutedFallback));
  videoEl._hls = hls;
}

export function stopHls(videoEl: HlsVideo | null) {
  if (!videoEl) return;
  videoEl.pause();
  videoEl._hlsToken = (videoEl._hlsToken || 0) + 1; // invalidate any in-flight playHls() load
  if (videoEl._hls) {
    videoEl._hls.destroy();
    videoEl._hls = null;
  }
  videoEl.removeAttribute('src');
}

// What a trailer shows, for a fade over the next media: its current frame (a cross-origin one taints the canvas,
// which still draws), else its poster before it has one.
export function trailerStill(video: HTMLVideoElement): HTMLCanvasElement | HTMLImageElement | null {
  if (video.readyState >= 2 && video.videoWidth) {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    return canvas;
  }
  if (!video.poster) return null;
  const img = document.createElement('img');
  img.src = video.poster;
  return img;
}
