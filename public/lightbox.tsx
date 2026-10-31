import { pushOverlayEntry, popOverlayEntry } from './overlayHistory.ts';
import { loadHlsModule, playHls, stopHls, trailerStill } from './hlsPlayer.ts';
import {
  control,
  flashCaption,
  onRelayedKey,
  present,
  presented,
  playback,
  privateMode,
  setPrivateMode,
  stopPresenting,
} from './presentation.ts';
import type { HlsVideo } from './hlsPlayer.ts';
import { urlWithoutShot } from './urlState.ts';
import { buildMediaItems, resolveShotIndex, preferredShotIndex, mediaLabel } from './mediaItems.ts';
import type { MediaItem, ShotKind } from './mediaItems.ts';
import type { PanelGame } from './types.ts';
import { isIgdbRow, type GameKey } from './gameKey.ts';
import { detailsPending, fmtTime, MEDIA_FAILED } from './utils.ts';
import { loadedWhen, morph } from './viewTransition.ts';
import { decideSwipeAxis, resolveSwipe, LB_SWIPE_RESISTANCE } from './lightboxSwipe.ts';
import type { SwipeAxis } from './lightboxSwipe.ts';

import { createSignal, createEffect, createMemo, createRoot, batch, untrack, Show } from 'solid-js';
import { render } from 'solid-js/web';
import Cast from 'lucide-solid/icons/cast';
import ChevronDown from 'lucide-solid/icons/chevron-down';
import ChevronLeft from 'lucide-solid/icons/chevron-left';
import ChevronRight from 'lucide-solid/icons/chevron-right';
import ChevronUp from 'lucide-solid/icons/chevron-up';
import FastForward from 'lucide-solid/icons/fast-forward';
import Maximize from 'lucide-solid/icons/maximize';
import Minimize from 'lucide-solid/icons/minimize';
import Pause from 'lucide-solid/icons/pause';
import Play from 'lucide-solid/icons/play';
import Rewind from 'lucide-solid/icons/rewind';
import TriangleAlert from 'lucide-solid/icons/triangle-alert';
import RotateCcw from 'lucide-solid/icons/rotate-ccw';
import Volume2 from 'lucide-solid/icons/volume-2';
import VolumeX from 'lucide-solid/icons/volume-x';
import X from 'lucide-solid/icons/x';
import ZoomIn from 'lucide-solid/icons/zoom-in';

// ── State ──────────────────────────────────────────────────────────────────
// Converted from plain module-level variables to Solid signals for
// the state that actually needs to trigger the (still deliberately imperative — see the
// header comment above `renderLightbox` further down) per-step render: the open game and
// `idx`. Zoom/pan (`lbZoom`/`lbPanX`/`lbPanY`) and the slide-direction flag (`lbLastDir`)
// stay plain variables, unchanged — nothing in JSX ever reads them (they only ever drive a
// direct `img.style.transform`/animation-class write inside already-imperative gesture code),
// so making them signals would add Solid overhead for zero reactive benefit, the same
// reasoning `panel.tsx`'s own hero zoom-equivalent state would have gotten if this file had
// any (it doesn't).
const [lbGame, setLbGame] = createSignal<PanelGame | null>(null);
const [lbIdx, setIdx] = createSignal(0);
// Derived from the open game on each read, not snapshotted at open time — the same shape, for
// the same reason, as `PanelHero`'s own `items()` (panel.tsx): a row opened before its media
// have loaded has nothing but a banner to offer, and gains its screenshots and videos
// asynchronously *without the row object ever being replaced*, so only a read through the store
// proxy sees them arrive. Snapshotting meant such a game showed that lone banner for as long as
// it stayed open. Plain accessors rather than `createMemo`s: a memo at module level would need
// its own `createRoot` (see the effect at the foot of this file) to cache two array spreads.
const shots = () => {
  const g = lbGame();
  return g ? buildMediaItems(g.appid, g.details?.meta) : [];
};
// Clamped on read: a refresh can shrink the list under a valid index (fewer screenshots), and
// every read of `shots()[idx()]` (the render, the caption, the leave-memory) must stay in bounds.
const idx = () => Math.max(0, Math.min(lbIdx(), shots().length - 1));
const gameName = () => lbGame()?.name ?? '';
// While presenting and not set private, the lightbox steers the TV: the item it rests on is presented
// (the effect at the foot of this file), and a trailer plays there only; never a game outside Steam (presentHero).
const linked = createRoot(() =>
  createMemo(() => {
    const g = lbGame();
    return g !== null && !isIgdbRow(g) && !!presented() && !privateMode();
  }),
);
// The game and item `renderLightbox` last drew, so a render can tell a game step from a media step,
// and whether that one was the TV's (poster only), so unlinking on it doesn't start it here by itself.
let lbRenderedAppid: GameKey | undefined;
let lbRenderedShotId: string | undefined;
let lbRenderedOnTv = false;
// A trailer held unstarted (private, or just unlinked): the first play loads it, from `lbHeldAt`.
let lbHeld = false;
let lbHeldAt = 0;
// Its start, once the stream's metadata is in; dropped by the next render (a step before it loads).
let lbHeldStart: (() => void) | null = null;
// A linked trailer on screen: its controls drive the TV and mirror its `playback`.
const [lbTvTrailer, setLbTvTrailer] = createSignal(false);
// The TV's playhead as last reported, run on locally between its 1 s reports.
let lbTvClock = { t: 0, dur: 0, at: 0, playing: false };
let lbTvTick: ReturnType<typeof setInterval> | undefined;
// The scrubber's own value wins while it's dragged, and until the TV reports its seek (1 s at most).
let lbScrubDragged = false;
let lbScrubTarget: number | null = null;
let lbScrubUntil = 0;
let lbScrubTimer: ReturnType<typeof setTimeout> | undefined;
// The present waiting out the settle (`LB_SETTLE_*`), whether the next one goes at once (just linked), and
// until when steps are a burst: its first goes at once, the rest wait for where it stops.
let lbTvTimer: ReturnType<typeof setTimeout> | undefined;
let lbTvSend: (() => void) | null = null;
let lbTvLinked = false;
let lbTvBurstUntil = 0;
// Stop presenting came from the lightbox's own pill: said as a stop, not as a lost window.
let lbStopped = false;
const LB_SETTLE_MEDIA_MS = 200;
// Until when steps are a burst (a held key, quick taps): a trailer one lands on waits to start where it stops.
let lbStepBurstUntil = 0;
let lbSettleTimer: ReturnType<typeof setTimeout> | undefined;
const LB_SETTLE_GAME_MS = 400; // the TV's cross-fade: a held ↓ shouldn't flash half-loaded games at the room
let lbZoom = 1,
  lbPanX = 0,
  lbPanY = 0,
  lbLastDir = 0,
  lbVcTimer: ReturnType<typeof setTimeout> | undefined,
  lbCounterTimer: ReturnType<typeof setTimeout> | undefined;
// Bumped on every renderLightbox() call and loadLbImage(); a detached Image()'s decode checks it's still current
// before touching the shared img element, so a slow load from a shot the viewer already
// navigated away from can't clobber the one currently displayed — img is reused across shots
// same as videoEl's _hlsToken guard above.
let lbImgToken = 0;
// Which axis `lbLastDir` was a step along, so the enter animation comes from the side the
// viewer swiped toward: 'x' for media within a game, 'y' for a game step (↑/↓, the caption
// buttons, a vertical swipe). Reset with `lbLastDir` on every render.
let lbLastAxis: SwipeAxis = 'x';

// The <video> is kept *out* of the DOM unless a video is actually on screen, and held by
// reference instead. It used to sit there from page load, which made every page of this app
// look like a video page to the rest of the browser: media-key routing, Picture-in-Picture
// affordances, and any extension that arms itself on the mere presence of a media element.
// Video Speed Controller is the concrete case — it binds keydown in the *capture* phase on
// `document` and swallows its own shortcuts (`r` among them) as soon as one connected <video>
// exists anywhere on the page, which silently killed this app's own R/↑/↓ before they were ever
// dispatched. Detached, none of that sees it; attached, such an extension is armed exactly while
// a trailer is playing, which is when its owner wants it. Held by reference rather than
// re-queried because `wireVideoControls` binds to it once at mount, while it is detached.
let lbVideoEl!: HlsVideo;
let lbVideoAnchor!: Element;
function attachLbVideo() {
  if (!lbVideoEl.isConnected) lbVideoAnchor.before(lbVideoEl);
}
function detachLbVideo() {
  lbVideoEl.remove();
}
function lbShowingVideo() {
  return lbVideoEl.isConnected;
}
function lbShowingImage() {
  const img = document.querySelector<HTMLElement>('#screenshot-lightbox .lb-img');
  return !!img && img.style.display !== 'none';
}
type LbFlashEl = HTMLElement & { _flashTimer?: ReturnType<typeof setTimeout> };

const LB_SEEK_SECONDS = 5;
const LB_DOUBLE_TAP_MS = 300;
const LB_DOUBLE_TAP_DIST = 30;

// The viewer drives it by keyboard: no chrome then, only brief feedback (`osdLb`); a pointer or a touch ends it.
let lbByKey = false;
let lbChromeTapTimer: ReturnType<typeof setTimeout> | undefined;
const LB_HINT_KEY = 'steam.isonoe.net:lightbox-hint-seen';
// The viewer's own mute choice, kept across trailers and visits (a browser's refused sound isn't one).
const LB_MUTED_KEY = 'steam.isonoe.net:lightbox-muted';
let lbBufferTimer: ReturnType<typeof setTimeout> | undefined;
// Whether the picture was last seen zoomed, so the zoom button resyncs only when that changes.
let lbZoomShown = false;
// Where a committed swipe left the item and its incoming neighbour, so the step carries on from there.
let lbSwipeLeft: DOMRect | null = null;
let lbSwipeEnterFrom: number | null = null;

// No-ops until initLightbox sets them; nothing can open the lightbox before that.
let _onLightboxParamChange: (shotId: string | null) => void = () => {};
let _onGameNav: (dir: number) => void = () => {};
let _onGameRandom: () => void = () => {};
let _getGamePosition: () => { index: number; total: number } | null = () => null;
let _onRejoin: () => Promise<boolean> = async () => false;
// Set when a re-point landed on a banner for want of anything else — see `repointLightboxGame`.
// Holds the *kind* of shot being left, so the screenshot/trailer that eventually arrives is
// picked by the same rule the re-point itself would have used.
const [awaitingMedia, setAwaitingMedia] = createSignal<ShotKind | null>(null);
let _lbPrevFocus: Element | null = null;
// One mount at a time: a second initLightbox (Vite hot-reloading AppShell) tears the first down —
// its DOM and every listener it put on `document` — instead of mounting a duplicate beside it.
let _lbTeardown: (() => void) | null = null;
let _lbSignal: AbortSignal | undefined;
const _lbPrefetchedHls = new Set();

// ── Init ───────────────────────────────────────────────────────────────────

// `onGameNav(dir)`/`onGameRandom()`: the host's own prev/next-game step and random pick (the
// same ones the panel itself offers) — they let ↑/↓ and R page games while the lightbox stays
// open, jumping straight to the new game's own media (see `renderLightbox`'s caption for how
// the switch is made visible), rather than either doing nothing or silently switching games
// behind a fullscreen image that never changed. Both re-point through `repointLightboxGame`.
// `getGamePosition()`: where the open game sits in that list, for the caption — null when there
// is no list to page through at all (a standalone lookup), which is also what hides the caption's
// own ↑/↓ buttons. `onRejoin()`: opens this lightbox, linked, on what the TV shows (AppShell's).
export function initLightbox({
  onParamChange,
  onGameNav,
  onGameRandom,
  getGamePosition,
  onRejoin,
}: {
  onParamChange: (shotId: string | null) => void;
  onGameNav: (dir: number) => void;
  onGameRandom: () => void;
  getGamePosition: () => { index: number; total: number } | null;
  onRejoin: () => Promise<boolean>;
}) {
  _onLightboxParamChange = onParamChange;
  _onGameNav = onGameNav;
  _onGameRandom = onGameRandom;
  _getGamePosition = getGamePosition;
  _onRejoin = onRejoin;
  _lbTeardown?.();
  const abort = new AbortController();
  _lbSignal = abort.signal;
  document.addEventListener('keydown', (e) => e.key !== 'Tab' && (lbByKey = true), {
    capture: true,
    signal: _lbSignal,
  });
  document.addEventListener('pointerdown', () => (lbByKey = false), { capture: true, signal: _lbSignal });
  document.addEventListener('fullscreenchange', syncLightboxFullscreenBtn, { signal: _lbSignal });
  document.addEventListener('webkitfullscreenchange', syncLightboxFullscreenBtn, { signal: _lbSignal });
  document.addEventListener('fullscreenchange', lockLbLandscape, { signal: _lbSignal });
  document.addEventListener('webkitfullscreenchange', lockLbLandscape, { signal: _lbSignal });
  screen.orientation?.addEventListener('change', lockLbLandscape, { signal: _lbSignal });
  const dispose = mountLightboxDom();
  const stopRelay = onRelayedKey(onTvKey);
  _lbTeardown = () => {
    abort.abort();
    stopRelay();
    cancelLbTv();
    clearInterval(lbTvTick);
    clearTimeout(lbScrubTimer);
    dispose();
    _lbTeardown = null;
  };
  return _lbTeardown;
}

export function isLightboxOpen() {
  return lbGame() !== null;
}

// The same, changing only on open and close (not on each game step): for effects that pause behind it.
export const lightboxOpen = createRoot(() => createMemo(() => lbGame() !== null));

// The open game and the shot on screen — reactive, so the panel's hero can follow it.
export function lightboxShot(): { appid: GameKey; shotId: string } | null {
  const game = lbGame();
  const shot = shots()[idx()];
  return game && shot ? { appid: game.appid, shotId: shot.shotId } : null;
}

function flushLbTv() {
  clearTimeout(lbTvTimer);
  const send = lbTvSend;
  lbTvSend = null;
  send?.();
}

function cancelLbTv() {
  clearTimeout(lbTvTimer);
  lbTvSend = null;
}

// P and the pill: not presenting yet → present; linked → private; private → back on the TV, at once.
function toggleTv() {
  const game = lbGame();
  const shot = shots()[idx()];
  if (!game || isIgdbRow(game) || !shot) return;
  if (linked()) return void setPrivateMode(true);
  // A trailer carries on where it was, as a cast does (the TV takes it even on the item it shows); one
  // never started goes out fresh, by the link itself, and only if the TV isn't showing it already.
  const vid = lbShowingVideo() && !lbHeld ? lbVideoEl : null;
  const from = vid ? { startAt: vid.currentTime, paused: vid.paused } : undefined;
  if (!presented() || from) present(game, shot.shotId, from, { silent: true });
  setPrivateMode(false);
}

function stopPresentingFromLb() {
  lbStopped = true;
  stopPresenting();
}

function lbTvTime() {
  const { t, dur, at, playing } = lbTvClock;
  const now = playing ? t + (performance.now() - at) / 1000 : t;
  return dur ? Math.min(now, dur) : now;
}

// Seeking, here or on the TV: Shift+←/→, J/L, a double-tap's third.
function seekLb(delta: number) {
  if (!lbTvTrailer()) return seekVideo(lbVideoEl, delta);
  control({ seekBy: delta });
  // Shown at once (the OSD, the line), the TV's report confirming it.
  lbTvClock = { ...lbTvClock, t: Math.max(0, lbTvTime() + delta), at: performance.now() };
  drawLbTvTime();
}

function lbPausedNow() {
  if (!lbTvTrailer()) return lbVideoEl.paused;
  const pb = playback();
  return !pb || pb.paused || pb.ended;
}

function toggleLbMute() {
  const pb = playback();
  if (!lbTvTrailer()) setLbMuted(!lbVideoEl.muted);
  else if (pb?.needsClick) noteLb(document.getElementById('screenshot-lightbox')!, 'Click the TV for sound');
  else control(pb?.muted ? 'unmute' : 'mute');
}

function drawLbTvTime() {
  const vc = document.querySelector<HTMLElement>('#screenshot-lightbox .lb-vctrls');
  if (!vc || lbScrubDragged || Date.now() < lbScrubUntil) return;
  const { dur } = lbTvClock;
  const t = lbTvTime();
  const scrub = vc.querySelector<HTMLInputElement>('.lb-vc-scrub')!;
  scrub.value = String(dur ? t / dur : 0);
  scrub.style.backgroundImage = lbScrubGradient(dur ? (100 * t) / dur : 0);
  syncLbTime(vc, t, dur);
}

// Mirrors the TV's report on a linked item: its failure (stills too: the TV can fail where this didn't),
// and for a trailer its state, one overlay at a time (CSS): failed, then buffering, paused or ended, playing.
function syncLbTv(lb: HTMLElement, onTv: boolean, trailer: boolean) {
  // The TV's report on the item here only: a step's present goes out after its settle.
  const on = untrack(presented);
  const pb = on && on.appid === lbRenderedAppid && on.item.shotId === lbRenderedShotId ? untrack(playback) : null;
  const failed = onTv && !!pb?.failed;
  if (failed !== lb.classList.contains('lb--tv-failed')) {
    lb.classList.toggle('lb--tv-failed', failed);
    if (failed)
      showLbError("Couldn't load on the TV."); // an alert: said as it shows
    else hideLbError();
  }
  clearInterval(lbTvTick);
  if (!trailer) return;
  const paused = !pb || pb.paused || pb.ended;
  lb.classList.toggle('lb--paused', !!pb && paused);
  lb.classList.toggle('lb--ended', !!pb?.ended);
  lb.classList.toggle('lb--buffering', !!pb?.buffering);
  lb.classList.toggle('lb--tv-playing', !!pb && !paused && !pb.buffering);
  if (!!pb?.needsClick !== lb.classList.contains('lb--automuted') && pb?.needsClick)
    noteLb(lb, 'Click the TV for sound');
  lb.classList.toggle('lb--automuted', !!pb?.needsClick);
  const playBtn = lb.querySelector('.lb-vc-play')!;
  playBtn.classList.toggle('lb-on', !paused);
  playBtn.setAttribute('aria-label', paused ? 'Play on the TV' : 'Pause the TV');
  const bigPlay = lb.querySelector('.lb-bigplay')!;
  bigPlay.classList.toggle('lb-on', !paused);
  bigPlay.setAttribute(
    'aria-label',
    pb?.ended ? 'Replay on the TV' : paused ? 'Play trailer on the TV' : 'Pause the trailer on the TV',
  );
  const muteBtn = lb.querySelector('.lb-vc-mute')!;
  muteBtn.classList.toggle('lb-on', !!pb?.muted);
  // Waiting for a click on the TV, unmuting here can do nothing (`toggleLbMute` says so).
  muteBtn.setAttribute('aria-label', pb?.muted || pb?.needsClick ? 'Unmute the TV' : 'Mute the TV');
  muteBtn.setAttribute('aria-disabled', String(!!pb?.needsClick));
  muteBtn.setAttribute('title', pb?.needsClick ? 'Click the TV for sound' : '');
  if (pb) lbTvClock = { t: pb.t, dur: pb.dur, at: performance.now(), playing: !paused && !pb.buffering };
  // The TV's report of the seek the scrubber asked for ends its hold.
  if (lbScrubTarget !== null && pb && Math.abs(pb.t - lbScrubTarget) < 1) lbScrubUntil = 0;
  drawLbTvTime();
  if (lbTvClock.playing) lbTvTick = setInterval(drawLbTvTime, 250);
}

// Every game step from inside the lightbox (↑/↓, R, the caption's own buttons) goes through
// here. The host's step opens the panel *behind* the overlay, and `panelOpen` focuses that
// panel's hero image — which drops focus straight out of the lightbox's own trap onto an element
// the lightbox is covering. Whatever had focus in here keeps it, so holding ↓ on the caption
// button doesn't walk focus away mid-click; the surface is the fallback, as on a real open.
// `dir` only drives the enter animation's direction — 0 (R, which has no direction) skips it.
// A wrap past either end of the list enters from the other side, the cue that it went back round —
// except after a swipe, where the new game follows the finger.
function stepGameNav(dir: number, swipe = false, relayed = false) {
  const pos = _getGamePosition();
  const wraps = !swipe && pos !== null && pos.index === (dir > 0 ? pos.total - 1 : 0);
  stepGameFromLightbox(() => _onGameNav(dir), wraps ? -dir : dir, relayed);
}

// `relayed`: pressed on the TV, where the keyboard focus is; nothing to keep here.
function stepGameFromLightbox(step: () => void, dir = 0, relayed = false) {
  const lb = document.getElementById('screenshot-lightbox')!;
  const before = document.activeElement;
  if (dir !== 0) {
    lbLastDir = dir;
    lbLastAxis = 'y';
  }
  const game = lbGame();
  step();
  if (lbGame() === game) {
    // No game to step to: no render consumed the direction, which would animate the next one.
    lbLastDir = 0;
    lbLastAxis = 'x';
  }
  if (relayed || lb.contains(document.activeElement)) return;
  ((before && lb.contains(before) ? before : lbSurface(lb)) as HTMLElement).focus();
}

// The stepping keys, pressed here or on the TV (`onTvKey`); false for any other.
function lightboxCommand(key: string, relayed = false): boolean {
  if (key === 'ArrowLeft' || key === 'ArrowRight') stepLightbox(key === 'ArrowRight' ? 1 : -1);
  else if (key === 'Home' || key === 'End') gotoLightbox(key === 'Home' ? 0 : shots().length - 1);
  else if (key === 'ArrowUp' || key === 'ArrowDown') stepGameNav(key === 'ArrowDown' ? 1 : -1, false, relayed);
  else if (key === 'r' || key === 'R') stepGameFromLightbox(_onGameRandom, 0, relayed);
  else return false;
  return true;
}

// A key pressed on the TV: steps the linked lightbox, opening it on what's on the TV first; private, the TV
// only says again what it shows. Hidden (under a fullscreen TV), timers are throttled: a step goes on release.
let lbRejoining = false;
function onTvKey(key: string, up: boolean) {
  if (!presented() || lbRejoining) return;
  if ([...document.querySelectorAll('dialog[open]')].some((d) => d.id !== 'screenshot-lightbox')) return;
  if (privateMode()) return void (up || flashCaption());
  if (up) return void (document.visibilityState === 'hidden' && flushLbTv());
  if (isLightboxOpen()) return void lightboxCommand(key, true);
  lbRejoining = true;
  void _onRejoin().then((ok) => {
    lbRejoining = false;
    if (ok) lightboxCommand(key, true);
  });
}

// ── Fullscreen button sync ─────────────────────────────────────────────────

type WebkitDoc = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
  webkitFullscreenEnabled?: boolean;
};
function webkitDoc(): WebkitDoc {
  return document as WebkitDoc;
}

// An iPhone has no element fullscreen: only a <video>'s own, in the native player.
type WebkitVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };
function canElementFullscreen() {
  return !!(document.fullscreenEnabled || webkitDoc().webkitFullscreenEnabled);
}

// Shown only where it does something: element fullscreen, else a trailer the native player can take.
function syncLbFullscreenShown(lb: HTMLElement) {
  const native = lbShowingVideo() && !!(lbVideoEl as WebkitVideo).webkitEnterFullscreen;
  lb.querySelector<HTMLElement>('.lb-fullscreen')!.style.display = canElementFullscreen() || native ? '' : 'none';
}

function isFullscreen() {
  return !!(document.fullscreenElement || webkitDoc().webkitFullscreenElement);
}

function exitFullscreen() {
  (document.exitFullscreen?.() ?? webkitDoc().webkitExitFullscreen?.())?.catch?.(() => {});
}

function syncLightboxFullscreenBtn() {
  const btn = document.querySelector('#screenshot-lightbox .lb-fullscreen');
  if (!btn) return;
  const isFs = isFullscreen();
  btn.classList.toggle('lb-on', isFs);
  btn.setAttribute('aria-label', isFs ? 'Exit fullscreen' : 'Enter fullscreen');
}

function toggleLbFullscreen(lb: HTMLElement) {
  if (!canElementFullscreen()) {
    if (lbShowingVideo()) (lbVideoEl as WebkitVideo).webkitEnterFullscreen?.();
    return;
  }
  if (isFullscreen()) {
    exitFullscreen();
  } else {
    const wasPlaying = holdLbTrailerForFullscreen();
    const surface = lbSurface(lb);
    (
      surface.requestFullscreen?.() ??
      (surface as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen?.()
    )?.then?.(
      () => wasPlaying && toggleLbPlay(),
      () => {},
    );
  }
}

// Firefox for Android puts the system orientation back over our landscape lock when a trailer loaded
// before fullscreen ends or is stepped off: enter with none, held where it was. Remove once https://bugzilla.mozilla.org/show_bug.cgi?id=2087592 is fixed.
const FIREFOX_ANDROID = /Android.*Firefox\//.test(navigator.userAgent);
function holdLbTrailerForFullscreen() {
  if (!FIREFOX_ANDROID || !lbShowingVideo() || lbHeld || lbTvTrailer() || !lbVideoEl.currentSrc) return false;
  const wasPlaying = !lbVideoEl.paused;
  const at = lbVideoEl.ended ? 0 : lbVideoEl.currentTime;
  stopHls(lbVideoEl);
  lbVideoEl.load(); // removing `src` alone keeps the media loaded, and its session with it
  lbHeld = true;
  lbHeldAt = at;
  lbVideoEl.currentTime = at;
  syncLbPaused();
  return wasPlaying;
}

// Fullscreen media is landscape, so a phone turns to show it, pictures included. Re-asserted on
// any orientation change while fullscreen: Firefox for Android resets the orientation when a
// trailer's media session ends (stepping to the next item), overriding the lock. Rejected where
// unsupported (desktop, iOS) — nothing to do then.
function lockLbLandscape() {
  const o = screen.orientation as ScreenOrientation & { lock?: (type: string) => Promise<void> };
  if (!isFullscreen()) return o?.unlock?.(); // back to the phone's own rotation
  o?.lock?.('landscape').catch(() => {});
}

// ── Load errors (image/video) ──────────────────────────────────────────────

function setLbLoading(lb: HTMLElement, on: boolean) {
  lb.classList.toggle('lb--loading', on);
  lbSurface(lb).ariaBusy = String(on);
}

function showLbError(msg: string) {
  const lb = document.getElementById('screenshot-lightbox');
  if (!lb) return;
  setLbLoading(lb, false);
  const err = lb.querySelector<HTMLElement>('.lb-error')!;
  err.querySelector<HTMLElement>('.lb-error-msg')!.textContent = msg;
  err.style.display = 'flex';
}

// Only while it's on screen: a load failing late, after a step or a handover to the TV, isn't the item shown.
function showLbVideoError() {
  if (lbShowingVideo()) showLbError("Couldn't load this video.");
}

function hideLbError() {
  const lb = document.getElementById('screenshot-lightbox');
  const err = lb?.querySelector<HTMLElement>('.lb-error');
  if (err) err.style.display = 'none';
}

// Re-attempts loading whatever shot is currently shown, from the Retry button.
function retryCurrentShot() {
  hideLbError();
  const lb = document.getElementById('screenshot-lightbox')!;
  if (lb.classList.contains('lb--tv-failed')) return control('retry');
  const shot = shots()[idx()];
  if (!shot) return;
  if (shot.type === 'video') {
    playLbTrailer(document.getElementById('screenshot-lightbox')!, shot);
  } else {
    // Cache-bust: a browser that already recorded this exact URL as failed
    // won't necessarily re-attempt the network request otherwise.
    loadLbImage(shot.main! + (shot.main!.includes('?') ? '&' : '?') + '_retry=' + Date.now());
  }
}

// Swaps `src` in at once if already in memory (a preload), else once loaded and decoded, with `placeholder` (or
// nothing) shown meanwhile, unless a later load started since; opacity 0 on error hides the broken-image icon.
function loadLbImage(src: string, placeholder?: string) {
  const lb = document.getElementById('screenshot-lightbox')!;
  const img = lb.querySelector<HTMLImageElement>('.lb-img')!;
  const token = ++lbImgToken;
  const full = new Image();
  full.src = src;
  const show = () => {
    if (token !== lbImgToken) return;
    img.src = src;
    img.style.opacity = '1';
    setLbLoading(lb, false);
    syncLbZoomBtn(lb);
    preloadLbNeighbours(true);
  };
  if (full.complete && full.naturalWidth) return show();
  img.style.opacity = placeholder ? '1' : '0';
  if (placeholder) img.src = placeholder;
  setLbLoading(lb, true);
  full.decode().then(show, () => {
    if (full.complete && full.naturalWidth) return show(); // loaded, only the early decode failed
    if (token !== lbImgToken) return;
    img.style.opacity = '0';
    setLbLoading(lb, false);
    showLbError("Couldn't load this image.");
    preloadLbNeighbours(true);
  });
}

// ── Zoom / pan ─────────────────────────────────────────────────────────────

function applyLbTransform() {
  const img = document.querySelector<HTMLImageElement>('#screenshot-lightbox .lb-img');
  if (!img) return;
  document.querySelector('#screenshot-lightbox .lb-zoom')?.setAttribute('aria-pressed', String(lbZoom > 1));
  if (lbZoom === 1) {
    lbPanX = 0;
    lbPanY = 0;
    img.style.transform = '';
    img.style.cursor = '';
  } else {
    const maxX = (img.offsetWidth * (lbZoom - 1)) / 2;
    const maxY = (img.offsetHeight * (lbZoom - 1)) / 2;
    lbPanX = Math.max(-maxX, Math.min(maxX, lbPanX));
    lbPanY = Math.max(-maxY, Math.min(maxY, lbPanY));
    img.style.transform = `scale(${lbZoom}) translate(${lbPanX / lbZoom}px, ${lbPanY / lbZoom}px)`;
    img.style.cursor = 'grab';
  }
  // Only when zoom starts or ends: syncing reads layout, and this runs on every pan or pinch move.
  if (lbZoom > 1 !== lbZoomShown) {
    lbZoomShown = lbZoom > 1;
    syncLbZoomBtn(img.closest('#screenshot-lightbox')!);
  }
}

function resetLbZoom() {
  lbZoom = 1;
  applyLbTransform();
}

// Zooms 2x centered on a given viewport point — shared by desktop dblclick
// and touch double-tap.
function lbZoomTowardPoint(clientX: number, clientY: number) {
  const img = document.querySelector<HTMLImageElement>('#screenshot-lightbox .lb-img');
  if (!img) return;
  const rect = img.getBoundingClientRect();
  lbZoom = 2;
  lbPanX = -(clientX - rect.left - rect.width / 2);
  lbPanY = -(clientY - rect.top - rect.height / 2);
  applyLbTransform();
}

// Double-click, double-tap and the zoom button: 2x toward the point, or back.
function toggleLbZoomAt(clientX: number, clientY: number) {
  if (lbZoom > 1) resetLbZoom();
  else lbZoomTowardPoint(clientX, clientY);
}

// Shown only where zooming reveals more: a still drawn below its natural size.
function syncLbZoomBtn(lb: HTMLElement) {
  const img = lb.querySelector<HTMLImageElement>('.lb-img')!;
  const shrunk = lbShowingImage() && img.naturalWidth > img.offsetWidth + 1;
  lb.querySelector<HTMLElement>('.lb-zoom')!.style.display = shrunk || lbZoom > 1 ? '' : 'none';
}

// The visible way to what double-click, double-tap and pinch do: 2x on the image's centre, or back.
function toggleLbZoom() {
  if (!lbShowingImage()) return;
  const r = document.querySelector('#screenshot-lightbox .lb-img')!.getBoundingClientRect();
  toggleLbZoomAt(r.left + r.width / 2, r.top + r.height / 2);
}

// ── Video seeking (keyboard arrows + touch double-tap) ─────────────────────

const LB_LONG_SEEK_SECONDS = 10; // a double-tap's and J/L's, as YouTube's
const LB_PAN_STEP = 80; // px an arrow pans a zoomed picture

function seekVideo(vid: HTMLVideoElement | null, deltaSeconds: number) {
  if (!vid) return;
  vid.currentTime = Math.max(0, Math.min(vid.duration || Infinity, vid.currentTime + deltaSeconds));
}

// Transient "⏪10s" / "10s⏩" flash shown on a touch double-tap seek. Each
// side tracks its own hide timer (rather than one shared timer) so a
// double-tap on one side can't be cut short by one on the other.
function flashSeek(side: 'left' | 'right', seconds: number) {
  const lb = document.getElementById('screenshot-lightbox');
  const el = lb?.querySelector<HTMLElement>(`.lb-seek-flash-${side}`);
  if (!el) return;
  el.querySelector('.lb-seek-flash-n')!.textContent = `${seconds}s`;
  const flash = el as LbFlashEl;
  clearTimeout(flash._flashTimer);
  el.classList.add('lb-seek-flash--show');
  flash._flashTimer = setTimeout(() => el.classList.remove('lb-seek-flash--show'), 500);
}

function lbScrubGradient(pct: number) {
  return `linear-gradient(to right, var(--accent) ${pct}%, rgb(255 255 255 / 0.3) ${pct}%)`;
}

// Zeroes out the scrubber/time labels immediately so a newly-loaded video
// doesn't briefly show the previous video's playhead position — the video
// element's own 'timeupdate'/'durationchange' events lag behind the src swap.
function resetLbVc(vc: HTMLElement) {
  const scrub = vc.querySelector<HTMLInputElement>('.lb-vc-scrub')!;
  scrub.value = String(0);
  scrub.style.backgroundImage = lbScrubGradient(0);
  syncLbTime(vc, 0, 0);
}

// A local trailer's control names (a linked one's say "on TV": `syncLbTv`); its events keep them after.
function resetLbVcLabels(lb: HTMLElement) {
  lb.querySelector('.lb-vc-play')!.setAttribute('aria-label', 'Play');
  lb.querySelector('.lb-bigplay')!.setAttribute('aria-label', 'Play trailer');
  lb.querySelector('.lb-vc-scrub')!.setAttribute('aria-label', 'Seek');
  const mute = lb.querySelector('.lb-vc-mute')!;
  mute.removeAttribute('aria-disabled');
  mute.removeAttribute('title');
  syncLbMuteBtn(lb);
}

// Starts a trailer at the viewer's own mute, falling back to muted (and saying so) where the browser refuses sound.
function playLbTrailer(lb: HTMLElement, shot: MediaItem) {
  lbVideoEl.muted = lbMutedChoice();
  syncLbMuteBtn(lb);
  lb.classList.remove('lb--automuted', 'lb--ended');
  playHls(lbVideoEl, shot.hls, showLbVideoError, () => lb.classList.add('lb--automuted'));
}

function syncLbTime(vc: HTMLElement, at: number, duration: number) {
  vc.querySelector('.lb-vc-time')!.textContent = `${fmtTime(at)} / ${fmtTime(duration)}`;
  vc.querySelector('.lb-vc-scrub')!.setAttribute('aria-valuetext', `${fmtTime(at)} of ${fmtTime(duration)}`);
}

// The viewer's mute (the button, M, the Unmute pill): kept for the next trailers, unlike the browser's.
function setLbMuted(muted: boolean) {
  lbVideoEl.muted = muted;
  document.getElementById('screenshot-lightbox')?.classList.remove('lb--automuted');
  try {
    localStorage.setItem(LB_MUTED_KEY, muted ? '1' : '0');
  } catch {
    // storage refused: the choice lasts this trailer
  }
}

// Also called right after a render sets `muted`: a just-attached <video> may not report it in `volumechange`.
function syncLbMuteBtn(lb: HTMLElement) {
  const btn = lb.querySelector('.lb-vc-mute')!;
  btn.classList.toggle('lb-on', lbVideoEl.muted);
  btn.setAttribute('aria-label', lbVideoEl.muted ? 'Unmute' : 'Mute');
}

function lbMutedChoice(): boolean {
  try {
    return localStorage.getItem(LB_MUTED_KEY) === '1';
  } catch {
    return false;
  }
}

// ── Chrome (toolbar/nav/video-controls) idle-hide ──────────────────────────

// Idle state hides ALL lightbox chrome (video controls, prev/next, toolbar)
// and the mouse cursor while the viewer is inactive — a video playing or
// paused, or a still image. A trailer that isn't playing keeps its large play
// button, which isn't part of the chrome.
function showLbChrome() {
  const lb = document.getElementById('screenshot-lightbox');
  if (!lb) return;
  lb.classList.remove('lb-idle');
  clearTimeout(lbVcTimer);
}

function hideLbChrome() {
  clearTimeout(lbVcTimer);
  document.getElementById('screenshot-lightbox')?.classList.add('lb-idle');
}

function schedHideLbChrome() {
  const lb = document.getElementById('screenshot-lightbox');
  if (!lb) return;
  clearTimeout(lbVcTimer);
  lbVcTimer = setTimeout(() => {
    // A keyboard user's focused control stays in sight (WCAG 2.4.7), as does one under a mouse (touch leaves
    // `:hover` stuck on the last tapped); checked again later.
    const held = matchMedia('(hover: hover)').matches ? ':is(:focus-visible, :hover)' : ':focus-visible';
    if (lb.querySelector(`:is(button, input)${held}`)) schedHideLbChrome();
    else lb.classList.add('lb-idle');
  }, 3000);
}

// Shows the chrome for a while — unless the viewer is on the keyboard, which only gets `osdLb`'s feedback.
function revealLbChrome() {
  if (lbByKey) return;
  showLbChrome();
  schedHideLbChrome();
}

// A keyboard action's feedback, in place of the chrome: play/pause/mute as an icon, a seek as the time and a line.
function osdLb(kind: 'play' | 'pause' | 'mute' | 'unmute' | 'seek') {
  const lb = document.getElementById('screenshot-lightbox');
  const osd = lb?.querySelector<LbFlashEl>('.lb-osd');
  if (!osd) return;
  osd.dataset.kind = kind;
  if (kind === 'seek') {
    const [t, dur] = lbTvTrailer() ? [lbTvTime(), lbTvClock.dur] : [lbVideoEl.currentTime, lbVideoEl.duration || 0];
    osd.querySelector('.lb-osd-time')!.textContent = `${fmtTime(t)} / ${fmtTime(dur)}`;
    osd.style.setProperty('--lb-osd-progress', String(dur ? t / dur : 0));
  }
  osd.classList.add('lb-osd--show');
  clearTimeout(osd._flashTimer);
  osd._flashTimer = setTimeout(() => osd.classList.remove('lb-osd--show'), 1000);
}

// With the chrome idle, a step flashes only the counter, plus the game's name on a game step.
function flashLbCounter(lb: HTMLElement, gameChanged: boolean) {
  if (!lb.classList.contains('lb-idle') || lbRenderedAppid === undefined) return; // a step, not the open
  lb.classList.add('lb--stepped');
  lb.classList.toggle('lb--stepped-game', gameChanged);
  clearTimeout(lbCounterTimer);
  lbCounterTimer = setTimeout(() => lb.classList.remove('lb--stepped', 'lb--stepped-game'), 1500);
}

// ── First-open hint ────────────────────────────────────────────────────────

// The one hint at what the hidden controls do, on this device's first open; any action, or 4 s, ends it.
function showLbHint(lb: HTMLElement) {
  try {
    if (localStorage.getItem(LB_HINT_KEY)) return;
    localStorage.setItem(LB_HINT_KEY, '1');
  } catch {
    return; // storage refused: better no hint than one on every open
  }
  const hint = lb.querySelector<HTMLElement>('.lb-hint')!;
  const touch = matchMedia('(pointer: coarse)').matches;
  const games = untrack(() => _getGamePosition()) ? (touch ? 'swipe ↕ games · ' : '↑↓ games · ') : '';
  hint.textContent = games + (touch ? 'swipe ↔ media' : '←→ media');
  hint.classList.add('lb-hint--show');
  const end = () => {
    hint.classList.remove('lb-hint--show');
    abort.abort();
  };
  const abort = new AbortController();
  for (const type of ['keydown', 'pointerdown']) lb.addEventListener(type, end, { signal: abort.signal });
  setTimeout(end, 4000);
}

// ── Focus helpers ──────────────────────────────────────────────────────────

function lbSurface(lb: HTMLElement): HTMLElement {
  return lb.querySelector<HTMLElement>('.lb-surface')!;
}

// Rendered ones only: the trap's wrap landing on a CSS-hidden button (‹ › with one item) loses focus.
function getFocusable(lb: HTMLElement): HTMLElement[] {
  return [...lb.querySelectorAll<HTMLElement>('button:not([disabled]), input[type="range"]')].filter((el) =>
    el.checkVisibility({ visibilityProperty: true }),
  );
}

// ── DOM creation ───────────────────────────────────────────────────────────
// A real Solid component now (was a hand-built innerHTML template assigned once to a
// lazily-created singleton element). Mounted exactly once via `mountLightboxDom` below
// (called from `initLightbox`, same "once per page" lifetime the old lazy-singleton getter
// amounted to in practice — nothing about creating this ~20-node tree eagerly instead of on
// first open is expensive enough to matter). Every class/id is preserved verbatim, so
// `style.css` and every `document.getElementById('screenshot-lightbox')`/`.lb-*` selector
// used throughout the rest of this file (the wiring functions below, all of which are
// unchanged) keeps working exactly as before — this conversion only touches how the markup
// itself is produced and mounted, not how the rest of the file finds or manipulates it.
function LightboxDom() {
  return (
    // A modal <dialog>: the page behind is inert. Fullscreen goes on `.lb-surface`, as a dialog can't be fullscreen.
    <dialog
      id="screenshot-lightbox"
      classList={{ 'lb--ff-android': FIREFOX_ANDROID }}
      aria-labelledby="lb-caption-text lb-title"
    >
      <div class="lb-surface" tabindex="-1" autofocus>
        <span id="lb-title" hidden>
          media viewer
        </span>
        <div class="lb-backdrop" />
        <button class="lb-btn lb-glass lb-prev" aria-label="Previous screenshot">
          <ChevronLeft />
        </button>
        <img class="lb-img" src="" alt="Screenshot" />
        {/* The neighbour a horizontal swipe drags in beside the item. */}
        <img class="lb-peek" alt="" aria-hidden="true" />
        <video class="lb-video" playsinline />
        <button class="lb-btn lb-glass lb-next" aria-label="Next screenshot">
          <ChevronRight />
        </button>
        <div class="lb-error lb-glass" style={{ display: 'none' }} role="alert">
          <TriangleAlert class="lb-error-icon" />
          <p class="lb-error-msg" />
          <button class="lb-error-retry">Retry</button>
        </div>
        <div class="lb-seek-flash lb-glass lb-seek-flash-left" aria-hidden="true">
          <Rewind /> <span class="lb-seek-flash-n" />
        </div>
        <div class="lb-seek-flash lb-glass lb-seek-flash-right" aria-hidden="true">
          <span class="lb-seek-flash-n" /> <FastForward />
        </div>
        {/* Shown while a trailer isn't playing; under a finger, also with the controls, as their play/pause. */}
        <button class="lb-bigplay lb-glass" aria-label="Play trailer">
          <Play class="lb-icon-off" />
          <Pause class="lb-icon-on" />
          <RotateCcw class="lb-bigplay-replay" />
          <span class="lb-bigplay-replay">Replay</span>
        </button>
        <button class="lb-unmute lb-glass">
          <VolumeX /> {lbTvTrailer() ? 'Click the TV for sound' : 'Unmute'}
        </button>
        {/* A linked trailer plays on the TV only: said over its poster, so it never looks stuck. */}
        <p class="lb-tvplaying lb-glass" aria-hidden="true">
          <Cast /> Playing on TV
        </p>
        {/* The seek line across the top, the buttons and time below it (YouTube's). */}
        <div class="lb-vctrls" style={{ display: 'none' }}>
          <input class="lb-vc-scrub" type="range" min="0" max="1" step="0.001" value="0" aria-label="Seek" />
          <div class="lb-vc-row">
            {/* Two-state controls draw both icons; `lb-on` picks which shows. */}
            <button class="lb-vc-btn lb-glass lb-vc-play" aria-label="Play">
              <Play class="lb-icon-off" />
              <Pause class="lb-icon-on" />
            </button>
            <button class="lb-vc-btn lb-glass lb-vc-mute" aria-label="Mute">
              <Volume2 class="lb-icon-off" />
              <VolumeX class="lb-icon-on" />
            </button>
            <span class="lb-vc-time lb-glass">0:00 / 0:00</span>
          </div>
        </div>
        <div class="lb-toolbar">
          {/* The list stepper, on the thing it changes; ↑/↓ first, so they stay put whatever the name's length. */}
          <div class="lb-caption lb-glass">
            <button class="lb-game-prev" aria-label="Previous game">
              <ChevronUp />
            </button>
            <button class="lb-game-next" aria-label="Next game">
              <ChevronDown />
            </button>
            <span class="lb-caption-text" id="lb-caption-text" />
            <span class="lb-caption-pos" />
          </div>
          {/* Its full wording ("Screenshot 3 of 12") is the status line's, below. */}
          <div class="lb-counter lb-glass" aria-hidden="true">
            <span class="lb-counter-n" />
            {/* Only in the keyboard's step flash (CSS): with the chrome, the pill says it. */}
            <Show when={linked()}>
              <span class="lb-counter-tv">· On TV</span>
            </Show>
          </div>
          <div class="lb-toolbar-right">
            {/* Steering the TV, or private; its × stops presenting (the nav chip is under this modal). */}
            <Show when={presented()}>
              <div class="lb-tv lb-glass" classList={{ 'lb-tv--private': !linked() }}>
                <button class="lb-tv-toggle" aria-keyshortcuts="P" onClick={toggleTv}>
                  <Cast aria-hidden="true" />
                  {linked() ? 'On TV' : 'Private · P to show'}
                </button>
                <button class="lb-tv-stop" aria-label="Stop presenting" onClick={stopPresentingFromLb}>
                  <X />
                </button>
              </div>
            </Show>
            <button class="lb-fullscreen lb-glass" aria-label="Enter fullscreen">
              <Maximize class="lb-icon-off" />
              <Minimize class="lb-icon-on" />
            </button>
            <button class="lb-zoom lb-glass" aria-label="Zoom" aria-pressed="false">
              <ZoomIn />
            </button>
            <button class="lb-close lb-glass" aria-label="Close lightbox">
              <X />
            </button>
          </div>
        </div>
        <p class="lb-status visually-hidden" role="status" />
        <div class="lb-osd lb-glass" aria-hidden="true">
          <Play class="lb-osd-play" />
          <Pause class="lb-osd-pause" />
          <VolumeX class="lb-osd-mute" />
          <Volume2 class="lb-osd-unmute" />
          <span class="lb-osd-time" />
          <span class="lb-osd-bar" />
        </div>
        <p class="lb-hint lb-glass" aria-hidden="true" />
      </div>
    </dialog>
  );
}

// ── Event wiring ───────────────────────────────────────────────────────────
// Unchanged from the original file (still plain imperative addEventListener wiring against
// `lb.querySelector(...)`, not JSX event props) — these bind once, to a singleton element
// that (like the original) never gets torn down/rebuilt, so there's no fine-grained-vs-coarse
// reactivity question to answer here the way panel.tsx had for its own repeatedly-rebuilt
// body: the actual per-shot update logic lives in `renderLightbox` below (now a `createEffect`
// triggered by the `shots`/`idx`/`gameName` signals above), not in these handlers.

function wireButtons(lb: HTMLElement) {
  // Esc, or Android's Back: closed the same way as from ×. `close` covers a dialog the browser
  // closed itself, when it won't let `cancel` be cancelled (no user activation since the last one).
  lb.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeLightbox();
  });
  lb.addEventListener('close', closeLightboxNow); // already closed: nothing left to morph from
  // A click, not a drag that ended there (panning a zoomed picture past its edge).
  const backdrop = lb.querySelector<HTMLElement>('.lb-backdrop')!;
  let downX = 0,
    downY = 0;
  backdrop.addEventListener('pointerdown', (e) => ((downX = e.clientX), (downY = e.clientY)));
  backdrop.addEventListener('click', (e) => {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) < 5) closeLightbox();
  });
  lb.querySelector('.lb-close')!.addEventListener('click', closeLightbox);
  lb.querySelector('.lb-error-retry')!.addEventListener('click', retryCurrentShot);
  lb.querySelector('.lb-prev')!.addEventListener('click', () => stepLightbox(-1));
  lb.querySelector('.lb-next')!.addEventListener('click', () => stepLightbox(1));
  lb.querySelector('.lb-game-prev')!.addEventListener('click', () => stepGameNav(-1));
  lb.querySelector('.lb-game-next')!.addEventListener('click', () => stepGameNav(1));
  lb.querySelector('.lb-fullscreen')!.addEventListener('click', () => toggleLbFullscreen(lb));
  lb.querySelector('.lb-zoom')!.addEventListener('click', toggleLbZoom);
}

function wireKeyboard(lb: HTMLElement) {
  document.addEventListener(
    'keydown',
    (e) => {
      if (!isLightboxOpen()) return;
      // A dialog over this one (the shortcuts) has the keyboard.
      if ([...document.querySelectorAll('dialog[open]')].some((d) => d !== lb)) return;
      // Ctrl/⌘/Alt+key is the browser's (reload, find, print); Shift is part of some bindings.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const onScrub = (e.target as HTMLElement | null)?.classList.contains('lb-vc-scrub');
      // The keyboard gets no chrome; Tab, moving focus onto it, does — and keeps it while focus is on a control.
      if (e.key !== 'Tab' && e.key !== 'Shift' && !(e.target as Element).closest('button, input')) hideLbChrome();

      // Focus trap
      if (e.key === 'Tab') {
        showLbChrome();
        schedHideLbChrome();
        const focusable = getFocusable(lb);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
        return;
      }

      const vid = lbShowingVideo() ? lbVideoEl : null;
      const trailer = !!vid || lbTvTrailer();

      // A zoomed picture: the arrows pan it, and Esc zooms back out before it closes anything.
      if (lbZoom > 1 && e.key.startsWith('Arrow')) {
        e.preventDefault();
        const [dx, dy] = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key]!;
        lbPanX += dx * LB_PAN_STEP;
        lbPanY += dy * LB_PAN_STEP;
        applyLbTransform();
        return;
      }
      if (lbZoom > 1 && e.key === 'Escape') {
        e.preventDefault(); // or the dialog's `cancel` would close it too
        resetLbZoom();
        return;
      }
      // ←/→ always step, a trailer playing or not; seeking is Shift+←/→ and J/L (YouTube's).
      if (!onScrub && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        if (!e.shiftKey) lightboxCommand(e.key);
        else if (trailer) {
          seekLb(dir * LB_SEEK_SECONDS);
          osdLb('seek');
        }
      }
      if (trailer && ['j', 'J', 'l', 'L'].includes(e.key)) {
        seekLb((e.key.toLowerCase() === 'l' ? 1 : -1) * LB_LONG_SEEK_SECONDS);
        osdLb('seek');
      }
      // Home/End, ↑/↓ and R — the same random pick the panel offers: page-level shortcuts are all
      // blocked while the lightbox is open (panelKeyboard.ts hands it the keyboard wholesale).
      if (!onScrub && ['Home', 'End', 'ArrowUp', 'ArrowDown', 'r', 'R'].includes(e.key)) {
        e.preventDefault();
        lightboxCommand(e.key);
      }
      if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        e.stopImmediatePropagation(); // panelKeyboard.ts's P would present the panel's item too
        toggleTv();
        return;
      }
      if (e.key === 'f' || e.key === 'F') toggleLbFullscreen(lb);
      if ((e.key === 'z' || e.key === 'Z') && !trailer) toggleLbZoom();
      if (trailer) {
        // A focused button takes Space as its own press.
        if (e.key === ' ' && !onScrub && !(e.target as HTMLElement).closest('button')) {
          e.preventDefault();
          osdLb(lbPausedNow() ? 'play' : 'pause');
          toggleLbPlay();
        }
        if (e.key === 'm' || e.key === 'M') {
          const muted = lbTvTrailer() ? !!playback()?.muted : lbVideoEl.muted;
          toggleLbMute();
          osdLb(muted ? 'unmute' : 'mute');
        }
      }
    },
    { signal: _lbSignal },
  );
}

function wireMouseHandlers(lb: HTMLElement) {
  const lbImg = lb.querySelector<HTMLImageElement>('.lb-img')!;
  // A trackpad's sideways swipe steps once per gesture: the gesture ends after a pause in its events.
  let swipeDx = 0,
    swiped = false,
    swipeEnd: ReturnType<typeof setTimeout> | undefined;
  lb.addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        clearTimeout(swipeEnd);
        swipeEnd = setTimeout(() => ((swipeDx = 0), (swiped = false)), 300);
        if (lbZoom > 1) {
          lbPanX -= e.deltaX;
          applyLbTransform();
        } else if (!swiped && Math.abs((swipeDx += e.deltaX)) > 40) {
          swiped = true;
          stepLightbox(Math.sign(swipeDx), true);
        }
        return;
      }
      // Over the picture only (a wheel elsewhere is no zoom), toward the cursor: the point under it stays put.
      if (e.target !== lbImg) return;
      e.preventDefault();
      const z0 = lbZoom;
      const z1 = Math.max(1, Math.min(4, z0 * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      const rect = lbImg.getBoundingClientRect();
      const dx = e.clientX - (rect.left + rect.width / 2 - lbPanX);
      const dy = e.clientY - (rect.top + rect.height / 2 - lbPanY);
      lbPanX = dx - (z1 / z0) * (dx - lbPanX);
      lbPanY = dy - (z1 / z0) * (dy - lbPanY);
      lbZoom = z1;
      applyLbTransform();
    },
    { passive: false },
  );

  let lbDragging = false,
    lbDragStartX = 0,
    lbDragStartY = 0,
    lbPanStartX = 0,
    lbPanStartY = 0;
  lbImg.addEventListener('mousedown', (e) => {
    if (lbZoom <= 1) return;
    lbDragging = true;
    lbDragStartX = e.clientX;
    lbDragStartY = e.clientY;
    lbPanStartX = lbPanX;
    lbPanStartY = lbPanY;
    lbImg.style.cursor = 'grabbing';
    e.preventDefault();
  });
  document.addEventListener(
    'mousemove',
    (e) => {
      if (!lbDragging) return;
      lbPanX = lbPanStartX + (e.clientX - lbDragStartX);
      lbPanY = lbPanStartY + (e.clientY - lbDragStartY);
      applyLbTransform();
    },
    { signal: _lbSignal },
  );
  document.addEventListener(
    'mouseup',
    () => {
      if (!lbDragging) return;
      lbDragging = false;
      lbImg.style.cursor = lbZoom > 1 ? 'grab' : '';
    },
    { signal: _lbSignal },
  );
  lbImg.addEventListener('dblclick', (e) => toggleLbZoomAt(e.clientX, e.clientY));
}

// ── Swipe drag ─────────────────────────────────────────────────────────────

// The media element on screen — the one a swipe drags. Zoom/pan owns `.lb-img`'s transform
// too, but a drag only ever runs at zoom 1, so the two never write it at once.
function lbMediaEl(): HTMLElement | null {
  if (lbShowingImage()) return document.querySelector<HTMLElement>('#screenshot-lightbox .lb-img');
  return lbShowingVideo() ? lbVideoEl : null;
}

function setLbDrag(el: HTMLElement, x: number, y: number) {
  el.style.transition = 'none';
  el.style.transform = `translate(${x}px, ${y}px)`;
}

// The neighbour following the finger in from the side it's dragged toward, a screen's width away.
function setLbPeek(x: number) {
  const peek = document.querySelector<HTMLImageElement>('#screenshot-lightbox .lb-peek')!;
  const list = shots();
  const next = list[(idx() + (x < 0 ? 1 : -1) + list.length) % list.length];
  const src = next.type === 'video' ? next.thumb : next.thumb || next.main!;
  if (peek.getAttribute('src') !== src) peek.src = src;
  peek.style.transform = `translateX(${x + (x < 0 ? innerWidth : -innerWidth)}px)`;
  peek.classList.add('lb-peek--on');
}

function clearLbPeek() {
  document.querySelector('#screenshot-lightbox .lb-peek')!.classList.remove('lb-peek--on');
}

// `animate`: a swipe that didn't commit eases back. A committed one clears instantly instead —
// `renderLightbox`'s own enter animation takes the element over from there.
function clearLbDrag(el: HTMLElement, animate: boolean) {
  el.style.transition = animate ? 'transform 0.2s ease, opacity 0.18s' : '';
  el.style.transform = '';
  if (animate)
    setTimeout(() => {
      el.style.transition = '';
    }, 200);
}

function wireTouchHandlers(lb: HTMLElement) {
  let lbX = 0,
    lbY = 0,
    lbActive = false;
  // A pinch keeps the picture's point between the fingers under them: `pinchPoint` is that point,
  // in the unzoomed picture's coordinates from its centre.
  let pinchStartDist = 0,
    pinchStartZoom = 1,
    pinchCenterX = 0,
    pinchCenterY = 0,
    pinchPointX = 0,
    pinchPointY = 0;
  // Each tap past a double-tap seek on the same side seeks again, adding up (10 s, 20 s, 30 s).
  let seekStreak: { side: 'left' | 'right'; total: number; until: number } | null = null;
  let touchPanning = false,
    touchPanStartX = 0,
    touchPanStartY = 0,
    touchPanOriginX = 0,
    touchPanOriginY = 0;
  let lbLastTapTime = 0,
    lbLastTapX = 0,
    lbLastTapY = 0;
  // Swipe drag: the axis locked onto (null until the finger has moved far enough to tell), when
  // it started (for the flick threshold), and what each axis has to step to — the latter read
  // once per gesture rather than per touchmove, `_getGamePosition` reaching the route's own list
  // (see `renderLightbox`'s untracked read of it).
  let dragAxis: SwipeAxis | null = null;
  let dragStart = 0,
    dragMediaCount = 0,
    dragHasGameList = false;

  lb.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length === 2) {
        if (!lbShowingImage()) return;
        pinchStartDist = Math.hypot(
          e.touches[1].clientX - e.touches[0].clientX,
          e.touches[1].clientY - e.touches[0].clientY,
        );
        pinchStartZoom = lbZoom;
        const rect = lb.querySelector('.lb-img')!.getBoundingClientRect();
        pinchCenterX = rect.left + rect.width / 2 - lbPanX;
        pinchCenterY = rect.top + rect.height / 2 - lbPanY;
        pinchPointX = ((e.touches[0].clientX + e.touches[1].clientX) / 2 - pinchCenterX - lbPanX) / lbZoom;
        pinchPointY = ((e.touches[0].clientY + e.touches[1].clientY) / 2 - pinchCenterY - lbPanY) / lbZoom;
        lbActive = false;
        e.preventDefault();
      } else if (e.touches.length === 1) {
        // A touch starting on the chrome is operating it, not swiping the media behind it —
        // dragging the video scrubber sideways otherwise steps to the next shot as well.
        if ((e.target as Element).closest('.lb-vctrls, .lb-toolbar, .lb-btn, .lb-bigplay, .lb-unmute')) {
          lbActive = false;
          return;
        }
        lbX = e.touches[0].clientX;
        lbY = e.touches[0].clientY;
        lbActive = true;
        dragAxis = null;
        dragStart = e.timeStamp;
        dragMediaCount = shots().length;
        dragHasGameList = _getGamePosition() !== null;
        if (lbZoom > 1) {
          touchPanning = true;
          touchPanStartX = e.touches[0].clientX;
          touchPanStartY = e.touches[0].clientY;
          touchPanOriginX = lbPanX;
          touchPanOriginY = lbPanY;
        }
      }
    },
    { passive: false },
  );

  lb.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length === 2) {
        if (!lbShowingImage()) return;
        const dist = Math.hypot(
          e.touches[1].clientX - e.touches[0].clientX,
          e.touches[1].clientY - e.touches[0].clientY,
        );
        lbZoom = Math.max(1, Math.min(4, (pinchStartZoom * dist) / pinchStartDist));
        lbPanX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - pinchCenterX - lbZoom * pinchPointX;
        lbPanY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - pinchCenterY - lbZoom * pinchPointY;
        applyLbTransform();
        e.preventDefault();
      } else if (e.touches.length === 1 && touchPanning) {
        lbPanX = touchPanOriginX + (e.touches[0].clientX - touchPanStartX);
        lbPanY = touchPanOriginY + (e.touches[0].clientY - touchPanStartY);
        applyLbTransform();
        e.preventDefault();
      } else if (e.touches.length === 1 && lbActive && lbZoom === 1) {
        const dx = e.touches[0].clientX - lbX,
          dy = e.touches[0].clientY - lbY;
        dragAxis ??= decideSwipeAxis(dx, dy);
        if (!dragAxis) return;
        const el = lbMediaEl();
        if (!el) return;
        // Nothing to step to on this axis: the media still follows the finger, damped, so the
        // gesture reads as resistance rather than as a step that silently didn't happen.
        const free = dragAxis === 'x' ? dragMediaCount > 1 : dragHasGameList || dy > 0; // down closes
        const slack = free ? 1 : LB_SWIPE_RESISTANCE;
        setLbDrag(el, dragAxis === 'x' ? dx * slack : 0, dragAxis === 'y' ? dy * slack : 0);
        if (dragAxis === 'x' && dragMediaCount > 1) setLbPeek(dx);
        e.preventDefault();
      }
    },
    { passive: false },
  );

  lb.addEventListener(
    'touchend',
    (e) => {
      if (e.touches.length < 2) touchPanning = false;
      if (!lbActive) return;
      lbActive = false;
      const endX = e.changedTouches[0].clientX,
        endY = e.changedTouches[0].clientY;
      const dx = endX - lbX,
        dy = endY - lbY;
      if (dragAxis) {
        const action = resolveSwipe({
          axis: dragAxis,
          dx,
          dy,
          dt: e.timeStamp - dragStart,
          mediaCount: dragMediaCount,
          hasGameList: dragHasGameList,
        });
        dragAxis = null;
        const el = lbMediaEl();
        if (action === 'media-prev' || action === 'media-next') {
          lbSwipeLeft = el?.getBoundingClientRect() ?? null;
          lbSwipeEnterFrom = dx + (dx < 0 ? innerWidth : -innerWidth);
        }
        clearLbPeek();
        if (el) clearLbDrag(el, !action);
        if (action === 'close') closeLightbox();
        else if (action === 'media-prev' || action === 'media-next')
          stepLightbox(action === 'media-next' ? 1 : -1, true);
        else if (action) {
          stepGameNav(action === 'game-next' ? 1 : -1, true);
        }
        return;
      }
      const isTap = Math.abs(dx) < 10 && Math.abs(dy) < 10;
      const showingImg = lbShowingImage() && !lbTvTrailer();
      const showingVid = lbShowingVideo() || lbTvTrailer();
      if (isTap && showingVid && seekStreak && Date.now() < seekStreak.until) {
        const frac = (endX - lb.getBoundingClientRect().left) / lb.getBoundingClientRect().width;
        const side = frac < 1 / 3 ? 'left' : frac > 2 / 3 ? 'right' : null;
        if (side === seekStreak.side) {
          e.preventDefault();
          clearTimeout(lbChromeTapTimer);
          seekLb((side === 'left' ? -1 : 1) * LB_LONG_SEEK_SECONDS);
          seekStreak.total += LB_LONG_SEEK_SECONDS;
          seekStreak.until = Date.now() + 600;
          flashSeek(side, seekStreak.total);
          return;
        }
      }
      seekStreak = null;
      if (isTap && (showingImg || showingVid)) {
        const now = Date.now();
        const tapDist = Math.hypot(endX - lbLastTapX, endY - lbLastTapY);
        if (now - lbLastTapTime < LB_DOUBLE_TAP_MS && tapDist < LB_DOUBLE_TAP_DIST) {
          lbLastTapTime = 0; // consume, so a 3rd quick tap starts a fresh pair rather than re-triggering
          if (showingImg) {
            clearTimeout(lbChromeTapTimer);
            // Or the browser follows up with a dblclick, whose handler would toggle the zoom back.
            e.preventDefault();
            toggleLbZoomAt(endX, endY);
          } else {
            // Video: double-tap the left/right third to seek, YouTube-style; the middle third is left alone.
            const rect = lb.getBoundingClientRect();
            const frac = (endX - rect.left) / rect.width;
            const side = frac < 1 / 3 ? 'left' : frac > 2 / 3 ? 'right' : null;
            if (side) {
              clearTimeout(lbChromeTapTimer); // the first tap's toggle of the controls
              e.preventDefault();
              seekLb((side === 'left' ? -1 : 1) * LB_LONG_SEEK_SECONDS);
              seekStreak = { side, total: LB_LONG_SEEK_SECONDS, until: Date.now() + 600 };
              flashSeek(side, LB_LONG_SEEK_SECONDS);
            }
          }
        } else {
          lbLastTapTime = now;
          lbLastTapX = endX;
          lbLastTapY = endY;
        }
      }
    },
    { passive: false },
  );

  lb.addEventListener(
    'touchcancel',
    () => {
      lbActive = false;
      touchPanning = false;
      if (dragAxis) {
        dragAxis = null;
        clearLbPeek();
        const el = lbMediaEl();
        if (el) clearLbDrag(el, true);
      }
    },
    { passive: true },
  );
}

function wireVideoControls(lb: HTMLElement) {
  const vid2 = lbVideoEl;
  const vc2 = lb.querySelector<HTMLElement>('.lb-vctrls')!;
  const scrub = vc2.querySelector<HTMLInputElement>('.lb-vc-scrub')!;
  const playBtn = vc2.querySelector<HTMLElement>('.lb-vc-play')!;
  const muteBtn = vc2.querySelector<HTMLElement>('.lb-vc-mute')!;

  const updateScrubBg = () => {
    scrub.style.backgroundImage = lbScrubGradient(Number(scrub.value) * 100);
  };

  vid2.addEventListener('timeupdate', () => {
    if (!vid2.duration) return;
    scrub.value = String(vid2.currentTime / vid2.duration);
    syncLbTime(vc2, vid2.currentTime, vid2.duration);
    updateScrubBg();
  });
  vid2.addEventListener('durationchange', () => syncLbTime(vc2, vid2.currentTime, vid2.duration || 0));
  // Stalled: a spinner, after a moment so a brief wait doesn't flash one.
  const buffered = () => {
    clearTimeout(lbBufferTimer);
    lb.classList.remove('lb--buffering');
  };
  vid2.addEventListener('waiting', () => {
    clearTimeout(lbBufferTimer);
    lbBufferTimer = setTimeout(() => lb.classList.add('lb--buffering'), 400);
  });
  for (const type of ['playing', 'pause', 'emptied']) vid2.addEventListener(type, buffered);
  // On the TV it only says a click there gives sound: nothing to do here.
  lb.querySelector('.lb-unmute')!.addEventListener('click', () => !lbTvTrailer() && setLbMuted(false));
  vid2.addEventListener('play', () => {
    playBtn.classList.add('lb-on');
    playBtn.setAttribute('aria-label', 'Pause');
    bigPlay.classList.add('lb-on');
    bigPlay.setAttribute('aria-label', 'Pause trailer');
    lb.classList.remove('lb--ended');
    document.getElementById('screenshot-lightbox')?.classList.remove('lb--unstarted');
    syncLbPaused();
    schedHideLbChrome();
  });
  vid2.addEventListener('pause', () => {
    playBtn.classList.remove('lb-on');
    playBtn.setAttribute('aria-label', 'Play');
    bigPlay.classList.remove('lb-on');
    bigPlay.setAttribute('aria-label', 'Play trailer');
    syncLbPaused();
    if (!lbShowingVideo()) return; // stopHls' own pause, on a close or a step off the trailer
    revealLbChrome();
  });
  // Stays on its last frame, offering a replay: no moving on by itself.
  vid2.addEventListener('ended', () => {
    playBtn.classList.remove('lb-on');
    playBtn.setAttribute('aria-label', 'Play');
    bigPlay.classList.remove('lb-on');
    bigPlay.setAttribute('aria-label', 'Replay trailer');
    lb.classList.add('lb--ended');
    syncLbPaused();
    revealLbChrome();
  });
  vid2.addEventListener('volumechange', () => syncLbMuteBtn(lb));

  scrub.addEventListener('input', () => {
    updateScrubBg();
    if (lbTvTrailer()) return syncLbTime(vc2, Number(scrub.value) * lbTvClock.dur, lbTvClock.dur);
    if (vid2.duration) vid2.currentTime = Number(scrub.value) * vid2.duration;
  });
  // On the TV, one seek where the scrubber is let go; keys held on it settle like steps.
  scrub.addEventListener('pointerdown', () => (lbScrubDragged = true));
  // After the `change` a release fires, if any: a press that moved nothing, or a cancelled one, fires none.
  scrub.addEventListener('pointerup', () => setTimeout(() => (lbScrubDragged = false)));
  scrub.addEventListener('pointercancel', () => (lbScrubDragged = false));
  scrub.addEventListener('change', () => {
    const dragged = lbScrubDragged;
    lbScrubDragged = false;
    if (!lbTvTrailer()) return;
    const t = Number(scrub.value) * lbTvClock.dur;
    const send = () => {
      control({ seekTo: t });
      lbScrubTarget = t;
      lbScrubUntil = Date.now() + 1000;
      lbTvClock = { ...lbTvClock, t, at: performance.now() };
    };
    clearTimeout(lbScrubTimer);
    if (dragged) send();
    else lbScrubTimer = setTimeout(send, LB_SETTLE_MEDIA_MS);
  });
  scrub.addEventListener('mousedown', () => clearTimeout(lbVcTimer));
  scrub.addEventListener('mouseup', () => schedHideLbChrome());

  playBtn.addEventListener('click', toggleLbPlay);
  const bigPlay = lb.querySelector<HTMLElement>('.lb-bigplay')!;
  bigPlay.addEventListener('click', toggleLbPlay);
  // Screen locked, app or tab switched: stop rather than play on unseen. Not resumed on return —
  // the large play button is there, and sound starting by itself on unlock would surprise.
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.visibilityState === 'hidden' && lbShowingVideo()) vid2.pause();
    },
    { signal: _lbSignal },
  );
  muteBtn.addEventListener('click', toggleLbMute);

  // A click plays or pauses; a finger's tap toggles the controls instead (below, which cancels its click).
  vid2.addEventListener('click', toggleLbPlay);

  // Any mouse move brings it all back (as video players do); leaving the window hides it at once.
  lb.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    lbByKey = false;
    revealLbChrome();
  });
  lb.addEventListener('mouseleave', () => isLightboxOpen() && hideLbChrome()); // not the close's own
  // A tap toggles the chrome; a swipe steps media without it.
  let tapRevealedChrome = false;
  let tapX = 0,
    tapY = 0;
  lb.addEventListener(
    'touchstart',
    (e) => {
      tapRevealedChrome = lb.classList.contains('lb-idle');
      tapX = e.touches[0].clientX;
      tapY = e.touches[0].clientY;
    },
    { passive: true },
  );
  lb.addEventListener(
    'touchend',
    (e) => {
      const t = e.changedTouches[0];
      // Already taken by wireTouchHandlers' own touchend: a double-tap's zoom or seek, a seek streak.
      if (e.defaultPrevented) return;
      if (Math.abs(t.clientX - tapX) >= 10 || Math.abs(t.clientY - tapY) >= 10) return;
      if ((e.target as HTMLElement).closest('button, input')) return revealLbChrome();
      if (lbShowingVideo() || lbTvTrailer()) e.preventDefault(); // its click would play or pause: the centre button does
      if (lb.classList.contains('lb--unstarted')) return toggleLbPlay();
      if (tapRevealedChrome) return revealLbChrome();
      clearTimeout(lbChromeTapTimer);
      // A trailer's middle third hides at once; elsewhere a tap waits out a possible second one (a zoom, a seek).
      const rect = lb.getBoundingClientRect();
      const frac = (t.clientX - rect.left) / rect.width;
      if ((lbShowingVideo() || lbTvTrailer()) && frac >= 1 / 3 && frac <= 2 / 3) hideLbChrome();
      else lbChromeTapTimer = setTimeout(hideLbChrome, LB_DOUBLE_TAP_MS);
    },
    { passive: false },
  );
}

// A held trailer (`lbHeld`) loads on its first play.
function toggleLbPlay() {
  if (lbTvTrailer()) {
    const pb = playback();
    return control(pb?.ended ? 'replay' : !pb || pb.paused ? 'play' : 'pause');
  }
  if (!lbVideoEl.paused) return lbVideoEl.pause();
  const shot = shots()[idx()];
  if (lbHeld && shot?.type === 'video') {
    lbHeld = false;
    const at = lbHeldAt;
    // Loading the stream resets the position: set once it's loaded.
    if (at) {
      lbHeldStart = () => (lbVideoEl.currentTime = at);
      lbVideoEl.addEventListener('loadedmetadata', lbHeldStart, { once: true });
    }
    playLbTrailer(document.getElementById('screenshot-lightbox')!, shot);
  } else lbVideoEl.play().catch(() => {});
}

// The large play button shows over a trailer that isn't playing — autoplay refused, paused, ended.
function syncLbPaused() {
  const lb = document.getElementById('screenshot-lightbox');
  lb?.classList.toggle('lb--paused', lbShowingVideo() && lbVideoEl.paused);
}

// ── Mount ────────────────────────────────────────────────────────────────
// Replaces the original lazy-singleton `getLightbox()` — mounted eagerly, once, from
// `initLightbox` (called once for the whole app, from AppShell.tsx's own `onMount` — see
// docs/dev/frontend.md), same "exists exactly once for the app's whole lifetime" shape
// the lazy getter amounted to in practice (nothing else ever unmounts it), just created up front
// instead of on first open — negligible cost for a
// ~20-node static tree, and it means every other function in this file can keep using a bare
// `document.getElementById('screenshot-lightbox')`/`.lb-*` lookup exactly as before, with no
// "has it been created yet" guard needed anywhere.
function mountLightboxDom(): () => void {
  const dispose = render(() => <LightboxDom />, document.body);
  const lb = document.getElementById('screenshot-lightbox')!;
  lbVideoEl = lb.querySelector<HlsVideo>('.lb-video')!;
  lbVideoAnchor = lb.querySelector('.lb-next')!; // re-inserted here, keeping the original order
  detachLbVideo(); // a closed lightbox shows nothing, so it holds no media element
  wireButtons(lb);
  wireKeyboard(lb);
  wireMouseHandlers(lb);
  wireTouchHandlers(lb);
  wireVideoControls(lb);
  window.addEventListener('resize', () => isLightboxOpen() && syncLbZoomBtn(lb), { signal: _lbSignal });
  return dispose;
}

// ── Public API ─────────────────────────────────────────────────────────────

export function openLightbox(game: PanelGame, idxOrShotId: number | string) {
  if (!buildMediaItems(game.appid, game.details?.meta).length) return; // a game outside Steam may have none
  // Only on a real open: this is also how an already-open lightbox is re-pointed at another game
  // (↑/↓ — see AppShell's onGameNav), and capturing focus again there would remember an element
  // inside the lightbox itself, so closing would restore focus to something already hidden.
  if (!isLightboxOpen()) _lbPrevFocus = document.activeElement;
  pushOverlayEntry('lightbox', closeLightbox, urlWithoutShot);
  const newShots = buildMediaItems(game.appid, game.details?.meta);
  // Batched: setLbGame alone would otherwise let the render effect below run once with the new
  // game's (possibly shorter) media list but the previous game's stale idx, indexing past the
  // end of the new list.
  batch(() => {
    setLbGame(game);
    setIdx(resolveShotIndex(newShots, idxOrShotId));
  });
  // A deliberate open supersedes any pending "take the media when it lands" latch.
  setAwaitingMedia(null);
  lbShotChosen = true;
  const lb = document.getElementById('screenshot-lightbox') as HTMLDialogElement;
  // Focuses the surface (`autofocus`): the shortcuts work from there, and nothing shows a ring.
  if (!lb.open) {
    lb.showModal();
    if (lbByKey)
      hideLbChrome(); // opened from the keyboard: nothing on the media
    else revealLbChrome();
    showLbHint(lb);
  }
  document.body.classList.add('lb-open'); // a modal dialog doesn't stop the page scrolling
  _onLightboxParamChange(newShots[idx()].shotId);
}

// The panel hero's picture, clicked, morphs into the lightbox's; the backdrop and the chrome fade in around it.
export function openLightboxFrom(from: HTMLImageElement, game: PanelGame, idxOrShotId: number) {
  const lb = document.getElementById('screenshot-lightbox')!;
  const backdrop = lb.querySelector<HTMLElement>('.lb-backdrop')!;
  morph({
    from,
    update: () => openLightbox(game, idxOrShotId),
    to: () => lb.querySelector<HTMLElement>('.lb-img'),
    ready: (img) => loadedWhen(lb, 'lb--loading', img as HTMLImageElement),
    focus: () => {
      if (isLightboxOpen() && !lb.contains(document.activeElement)) lbSurface(lb).focus();
    },
    start: () => {
      lb.classList.add('lb-morph');
      backdrop.style.viewTransitionName = 'lb-backdrop';
      lb.style.viewTransitionName = 'lb-chrome';
    },
    finish: () => {
      lb.classList.remove('lb-morph');
      backdrop.style.viewTransitionName = '';
      lb.style.viewTransitionName = '';
    },
  });
}

// Re-points an already-open lightbox at another game — ↑/↓ and R, via AppShell's `onGameNav`/
// `onGameRandom`. Separate from `openLightbox` because the shot to land on depends on the one
// being left, which only this module knows: paging through a list is a browse, so it lands on
// real media rather than on the banner `openLightbox(game, 0)` used to pick (see
// `preferredShotIndex`).
// A game paged back to lands on the item the viewer picked there, for the session.
const lbLastShot = new Map<GameKey, string>();
// Whether the item on screen is the viewer's pick (opened on or stepped to), not a game step's landing.
let lbShotChosen = false;

// Where `appid`'s remembered item sits in `list`, else where a game step lands leaving `leaving`.
function landingIndex(appid: GameKey, list: MediaItem[], leaving: ShotKind) {
  const remembered = list.findIndex((s) => s.shotId === lbLastShot.get(appid));
  return remembered >= 0 ? remembered : preferredShotIndex(list, leaving);
}

export function repointLightboxGame(game: PanelGame) {
  const left = shots()[idx()];
  const leavingGame = lbGame();
  // A lone banner is no pick: it stands in while the game's media load.
  if (left && leavingGame && lbShotChosen && shots().length > 1) lbLastShot.set(leavingGame.appid, left.shotId);
  lbShotChosen = false;
  // A pending latch's kind carries on through a game still loading: its lone banner is no Cover.
  const leaving: ShotKind =
    untrack(awaitingMedia) ?? (left?.shotId === 'banner' && shots().length > 1 ? 'cover' : (left?.type ?? 'image'));
  const next = buildMediaItems(game.appid, game.details?.meta);
  const target = landingIndex(game.appid, next, leaving);
  // A lone banner means this row's media are still loading — there is nothing else to show
  // *yet*. Latch the intent so the first real media to arrive is taken (see the effect at the
  // foot of this file); without it the banner would simply stay up, which is the whole reason
  // paging through a list used to be unrewarding.
  batch(() => {
    setAwaitingMedia(next.length === 1 ? leaving : null);
    setLbGame(game);
    setIdx(target);
  });
  _onLightboxParamChange(next[target].shotId);
}

// Shrinks a still back into the panel hero's picture when it's on screen; else the dialog fades (CSS).
export function closeLightbox() {
  if (!isLightboxOpen()) return; // the `close` event that follows our own close()
  document.body.classList.remove('lb-open'); // the panel rendered again, so its hero can be measured
  const lb = document.getElementById('screenshot-lightbox')!;
  const img = lb.querySelector<HTMLImageElement>('.lb-img')!;
  const hero = document.querySelector<HTMLImageElement>('#panel-hero .panel-hero-img');
  const heroShown = hero?.checkVisibility() && hero.getBoundingClientRect().bottom > 0;
  if (!lbShowingImage() || !heroShown || presented()) return closeLightboxNow();
  const backdrop = lb.querySelector<HTMLElement>('.lb-backdrop')!;
  morph({
    from: img,
    update: closeLightboxNow,
    to: () => hero,
    ready: (to) => (to as HTMLImageElement).decode(),
    focus: () => {},
    start: () => {
      backdrop.style.viewTransitionName = 'lb-backdrop';
      lb.style.viewTransitionName = 'lb-chrome';
    },
    finish: () => {
      backdrop.style.viewTransitionName = '';
      lb.style.viewTransitionName = '';
    },
  });
}

function closeLightboxNow() {
  if (!isLightboxOpen()) return;
  flushLbTv(); // a step closed within its settle still reaches the TV
  clearTimeout(lbSettleTimer);
  setLbGame(null);
  setAwaitingMedia(null);
  clearTimeout(lbVcTimer);
  const lb = document.getElementById('screenshot-lightbox') as HTMLDialogElement;
  stopHls(lbVideoEl);
  detachLbVideo();
  lb.close();
  setLbLoading(lb, false);
  lb.classList.remove(
    'lb-idle',
    'lb--paused',
    'lb--unstarted',
    'lb--stepped',
    'lb--stepped-game',
    'lb--automuted',
    'lb--ended',
    'lb--buffering',
    'lb--tv',
    'lb--tv-playing',
    'lb--tv-failed',
  );
  lbRenderedAppid = lbRenderedShotId = undefined;
  lbRenderedOnTv = lbHeld = false;
  setLbTvTrailer(false);
  clearInterval(lbTvTick);
  clearTimeout(lbScrubTimer);
  clearTimeout(lbStatusTimer);
  lbStatusNote = lbStatusMedia = lbStatusGame = '';
  lb.querySelector('.lb-status')!.textContent = '';
  document.body.classList.remove('lb-open');
  if (isFullscreen()) exitFullscreen();
  _onLightboxParamChange(null);
  popOverlayEntry('lightbox');
  if (_lbPrevFocus?.isConnected) (_lbPrevFocus as HTMLElement).focus();
  else document.querySelector<HTMLElement>('#panel-hero .panel-hero-open')?.focus();
  _lbPrevFocus = null;
}

function stepLightbox(dir: number, swipe = false) {
  // A lone Cover (media still loading): no step, so no pick that would cancel the latch.
  if (shots().length <= 1) return;
  // The viewer has taken over: whatever is on screen from here on is their choice, so the latch
  // must never move it under them.
  setAwaitingMedia(null);
  lbShotChosen = true;
  lbLastAxis = 'x';
  const list = shots();
  const next = (idx() + dir + list.length) % list.length;
  // Entering from the side actually moved toward, so a wrap to the Cover slides in from the left —
  // except after a swipe, where it follows the finger.
  lbLastDir = swipe ? dir : Math.sign(next - idx()) || dir;
  setIdx(next);
  _onLightboxParamChange(list[next].shotId);
}

// Absolute jump (Home/End) — still animates in the right direction rather
// than always sliding one way, same as a multi-step stepLightbox would.
function gotoLightbox(target: number) {
  if (target === idx()) return;
  setAwaitingMedia(null); // same reason as stepLightbox's
  lbShotChosen = true;

  lbLastDir = target > idx() ? 1 : -1;
  lbLastAxis = 'x';
  setIdx(target);
  _onLightboxParamChange(shots()[target].shotId);
}

// The caption, rendered on its own rather than as part of `renderLightbox` below. It carries
// the game/shot identity that used to exist only as invisible alt text (see `label` there), so
// switching games while the lightbox stays open (↑/↓, R) is visibly confirmed even when the new
// shot looks much like the old one — plus the position in the *list*, which the `Screenshot 1 of 12` media
// counter says nothing about. Split out because it's the one part reading the host's list
// position: that read must stay tracked for the position to follow a list still streaming in,
// and must not drag a full image reload along with it each time. Two text writes, no media.
// One status line, debounced so holding → doesn't queue every step; it names the game only when it changes.
// While linked it says the item is on the TV; a link change is a note before it.
let lbStatusTimer: ReturnType<typeof setTimeout> | undefined;
let lbStatusGame = '';
let lbStatusMedia = '';
let lbStatusNote = '';
function announceLb(lb: HTMLElement, game: string, media: string) {
  if (game) lbStatusGame = game;
  lbStatusMedia = media;
  sayLbStatus(lb);
}
function noteLb(lb: HTMLElement, note: string) {
  lbStatusNote = note;
  sayLbStatus(lb);
}
function sayLbStatus(lb: HTMLElement) {
  clearTimeout(lbStatusTimer);
  lbStatusTimer = setTimeout(() => {
    const item = lbStatusMedia && (untrack(linked) ? 'On TV: ' : '') + lbStatusGame + lbStatusMedia;
    lb.querySelector('.lb-status')!.textContent = [lbStatusNote, item].filter(Boolean).join('. ');
    lbStatusGame = lbStatusMedia = lbStatusNote = '';
  }, 300);
}

function renderLbCaption() {
  const lb = document.getElementById('screenshot-lightbox');
  if (!lb) return;
  const name = gameName();
  const pos = _getGamePosition();
  const caption = lb.querySelector<HTMLElement>('.lb-caption')!;
  // "game", or it couldn't be told from the media counter beside it.
  const posEl = caption.querySelector<HTMLElement>('.lb-caption-pos')!;
  posEl.textContent = pos ? `game ${pos.index + 1} / ${pos.total}` : '';
  posEl.style.display = pos ? '' : 'none';
  caption.querySelector<HTMLElement>('.lb-caption-text')!.textContent = name;
  caption.style.display = name || pos ? '' : 'none';
  // No list behind the open game (a standalone lookup) means nothing to step to. Hiding them
  // inline also drops them out of the Tab focus trap — see getFocusable.
  for (const sel of ['.lb-game-prev', '.lb-game-next']) {
    caption.querySelector<HTMLElement>(sel)!.style.display = pos ? '' : 'none';
  }
}

// The actual per-shot render — deliberately kept as a plain imperative function (called from
// inside a `createEffect` below, not decomposed into fine-grained JSX bindings) rather than
// converted the way `panel.tsx`'s own body was. Unlike that file, there's no template shape
// to gain from JSX here: every line below is either a targeted, already-hand-optimized DOM
// write (avoiding image flicker, restarting HLS/animation state correctly, preloading
// adjacent shots) or a side effect (network fetches, timers) — the same imperative style the
// original file used, now just re-triggered by a Solid effect instead of being called
// manually after mutating plain module variables.
// The item stepped from fades out where it was (where a swipe left it) while the new one enters.
function fadeOutLbItem(lb: HTMLElement) {
  const img = lb.querySelector<HTMLImageElement>('.lb-img')!;
  const video = lbShowingVideo() ? lbVideoEl : null;
  const rect = lbSwipeLeft ?? (video ?? img).getBoundingClientRect();
  lbSwipeLeft = null;
  if (!rect.width) return;
  let ghost: HTMLImageElement | HTMLCanvasElement | null;
  if (video) {
    // A still of it: the video is detached at once, which would leave a black frame.
    ghost = trailerStill(video);
    if (!ghost) return;
    ghost.style.height = `${rect.height}px`; // letterboxed as the video is
  } else {
    if (!lbShowingImage() || img.style.opacity === '0' || !img.src) return;
    ghost = img.cloneNode() as HTMLImageElement;
    ghost.removeAttribute('style');
  }
  ghost.className = 'lb-ghost';
  ghost.ariaHidden = 'true';
  // Swiped away: it carries on out as far as the next item comes in, so the two move as one.
  if (lbSwipeEnterFrom !== null) ghost.style.setProperty('--lb-exit-to', `${-lbSwipeEnterFrom}px`);
  Object.assign(ghost.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px` });
  ghost.addEventListener('animationend', () => ghost.remove(), { once: true });
  lbSurface(lb).append(ghost);
}

// Named for the side the new item comes in from, the one stepped toward: the next media from the
// right, the next game from the bottom; after a swipe, from where its peek was under the finger.
function enterLbItem(el: HTMLElement, base: string, dir: number, axis: SwipeAxis) {
  el.style.removeProperty('--lb-enter-from');
  if (dir === 0) {
    el.className = base;
    return;
  }
  if (lbSwipeEnterFrom !== null) el.style.setProperty('--lb-enter-from', `${lbSwipeEnterFrom}px`);
  lbSwipeEnterFrom = null;
  const from = axis === 'y' ? (dir > 0 ? 'bottom' : 'top') : dir > 0 ? 'right' : 'left';
  el.className = `${base} lb-anim-${from}`;
  el.addEventListener('animationend', () => (el.className = base), { once: true });
}

function renderLightbox() {
  const list = shots();
  const i = idx();
  const name = gameName();
  const lb = document.getElementById('screenshot-lightbox')!;
  const shot = list[i];
  const img = lb.querySelector<HTMLImageElement>('.lb-img')!;
  const vid = lbVideoEl;
  const vc = lb.querySelector<HTMLElement>('.lb-vctrls')!;
  const dir = lbLastDir;
  const axis = lbLastAxis;
  lbLastDir = 0;
  lbLastAxis = 'x';
  resetLbZoom();
  const appid = lbGame()?.appid;
  const gameChanged = appid !== lbRenderedAppid;
  const sameItem = !gameChanged && shot.shotId === lbRenderedShotId;
  const onTv = untrack(linked);
  if (dir !== 0) fadeOutLbItem(lb);
  flashLbCounter(lb, gameChanged);
  clearTimeout(lbSettleTimer);
  const settling = dir !== 0 && Date.now() < lbStepBurstUntil;
  if (dir !== 0) lbStepBurstUntil = Date.now() + LB_SETTLE_MEDIA_MS;
  // Private, or unlinked on what the TV played: no sound starting here by itself.
  const held = untrack(privateMode) || (sameItem && lbRenderedOnTv);
  lbHeld = shot.type === 'video' && !onTv && (held || settling);
  lbHeldAt = lbHeld && sameItem && lbRenderedOnTv ? lbTvTime() : 0;
  lbRenderedAppid = appid;
  lbRenderedShotId = shot.shotId;
  lbRenderedOnTv = onTv && shot.type === 'video';
  setLbTvTrailer(lbRenderedOnTv);
  lb.classList.toggle('lb--tv', lbRenderedOnTv);
  lb.classList.remove('lb--tv-playing');
  lbTvClock = { t: 0, dur: 0, at: 0, playing: false };
  lbScrubUntil = 0;
  lbScrubTarget = null;
  clearTimeout(lbScrubTimer); // a keyboard scrub of the item left
  if (lbHeldStart) lbVideoEl.removeEventListener('loadedmetadata', lbHeldStart);
  lbHeldStart = null;
  hideLbError();
  // Invalidate any image preload still in flight from a previous render — see lbImgToken decl.
  lbImgToken++;
  // Untracked, and this is load-bearing: `_getGamePosition` reaches the route's list, which on
  // a list route is the table's `processedData()` — a signal recomputed on every batch of
  // streaming rows. Reading it in *this* effect subscribed the whole imperative render below to
  // it, so a list still loading behind the overlay restarted the image load several times a
  // second and the lightbox visibly blinked. The caption keeps it live in its own pass instead
  // (`renderLbCaption`); the alt text here is rebuilt on every step anyway.
  const pos = untrack(() => _getGamePosition());
  const label =
    `${name ? name + ' — ' : ''}${pos ? `game ${pos.index + 1} of ${pos.total} — ` : ''}` + mediaLabel(list, i);
  if (shot.type === 'video' && !onTv) {
    img.style.display = 'none';
    setLbLoading(lb, false);
    attachLbVideo();
    lb.classList.add('lb--unstarted');
    vid.poster = shot.thumb || '';
    enterLbItem(vid, 'lb-video', dir, axis);
    vid.setAttribute('aria-label', shot.name ? `${label}: ${shot.name}` : label);
    vc.style.display = '';
    resetLbVc(vc);
    resetLbVcLabels(lb);
    if (lbHeld) {
      stopHls(vid); // the trailer played here before this step, if any
      lbVideoEl.muted = lbMutedChoice();
      lbVideoEl.currentTime = lbHeldAt; // shown there until played (set again once loaded)
      syncLbMuteBtn(lb);
      lb.classList.remove('lb--automuted', 'lb--ended');
      if (!held) lbSettleTimer = setTimeout(() => lbHeld && toggleLbPlay(), LB_SETTLE_MEDIA_MS);
    } else playLbTrailer(lb, shot);
    syncLbPaused();
    schedHideLbChrome();
  } else {
    stopHls(vid);
    detachLbVideo();
    lb.classList.remove('lb--unstarted', 'lb--automuted', 'lb--ended', 'lb--buffering');
    syncLbPaused();
    vc.style.display = 'none';
    img.style.display = 'block';
    img.alt = label;
    img.onload = null;
    img.onerror = null;
    enterLbItem(img, 'lb-img', dir, axis);
    if (shot.type === 'video') {
      // On the TV: its poster here (the <video> stays detached — see `lbVideoEl`), its controls the TV's.
      img.style.opacity = '1';
      img.src = shot.thumb || '';
      setLbLoading(lb, false);
      vc.style.display = '';
      resetLbVc(vc);
      lb.querySelector('.lb-vc-scrub')!.setAttribute('aria-label', 'Seek on the TV');
      schedHideLbChrome();
    } else {
      // Until the full image loads, its thumbnail (often cached by the panel's filmstrip) rather than the previous shot;
      // the banner has no separate one (thumb === main): blank there.
      loadLbImage(shot.main!, shot.thumb !== shot.main ? shot.thumb : undefined);
      schedHideLbChrome();
    }
  }
  syncLbZoomBtn(lb);
  syncLbFullscreenShown(lb);
  const counter = lb.querySelector<HTMLElement>('.lb-counter')!;
  counter.querySelector('.lb-counter-n')!.textContent = `${i + 1} / ${list.length}`;
  counter.style.display = list.length > 1 ? '' : 'none';
  if (list.length === 1 && untrack(() => lbGame()?.mediaFailed)) lbStatusNote = MEDIA_FAILED;
  announceLb(
    lb,
    gameChanged && name ? `${name}, ${pos ? `game ${pos.index + 1} of ${pos.total}, ` : ''}` : '',
    mediaLabel(list, i),
  );
  lb.querySelector<HTMLButtonElement>('.lb-prev')!.disabled = list.length <= 1;
  lb.querySelector<HTMLButtonElement>('.lb-next')!.disabled = list.length <= 1;
  preloadLbNeighbours(shot.type === 'video');
}

// The shown item's neighbours (images, posters, a trailer's manifest and hls.js), so stepping feels instant: made
// (`create`) once the shown image is in or failed, not competing with it, at once for a trailer; stale ones go.
function preloadLbNeighbours(create: boolean) {
  const lb = document.getElementById('screenshot-lightbox')!;
  const list = untrack(shots);
  const i = untrack(idx);
  const shot = list[i];
  const keep = new Set<string>();
  for (const offset of [-1, 1]) {
    const adjacent = list[(i + offset + list.length) % list.length];
    if (!adjacent) continue;
    const preloadSrc = adjacent.type === 'video' ? adjacent.thumb : adjacent.main;
    if (preloadSrc) keep.add(preloadSrc);
    if (!create) continue;
    if (preloadSrc && preloadSrc !== shot.main) {
      let pre = lb.querySelector<HTMLImageElement>(`.lb-preload[data-src="${CSS.escape(preloadSrc)}"]`);
      if (!pre) {
        pre = document.createElement('img');
        pre.className = 'lb-preload';
        pre.dataset.src = preloadSrc;
        pre.src = preloadSrc;
        pre.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none';
        lb.appendChild(pre);
      }
    }
    if (adjacent.type === 'video' && adjacent.hls && !_lbPrefetchedHls.has(adjacent.hls)) {
      _lbPrefetchedHls.add(adjacent.hls);
      fetch(adjacent.hls).catch(() => {});
      loadHlsModule().catch(() => {}); // warm it ahead of time — see its own comment above
    }
  }
  lb.querySelectorAll<HTMLImageElement>('.lb-preload').forEach((el) => {
    if (!keep.has(el.dataset.src ?? '')) el.remove();
  });
}

// The one Solid-driven trigger for the whole file: re-runs `renderLightbox()` whenever
// `shots`/`idx`/`gameName` change (opening, closing, stepping, or a game switch via
// `onGameNav` all funnel through one of those three signals) — replacing every explicit
// `renderLightbox()` call the original file made right after mutating its own plain
// variables. Created once at module load (outside any component), same as `panel.tsx`'s own
// top-level `createRoot` block of effects — this module has page-lifetime scope, never torn
// down, so it's never explicitly disposed. Guarded on `shots().length` so it doesn't run
// `renderLightbox()` (which indexes into `shots()[idx()]`) while the lightbox is closed and
// empty.
// Wrapped in `createRoot` — like `panel.tsx`'s own top-level effects, this has page-lifetime
// scope (never torn down), so without a root it would warn "created outside a createRoot ...
// will never be disposed" (same fix panel.tsx's own top-level effects needed).
createRoot(() => {
  // Consumes the `awaitingMedia` latch (see `repointLightboxGame`): a game paged onto before
  // its media had loaded has only its banner to offer, so the moment the real media
  // lands, take it. Created *before* the render effect below so it runs first within the same
  // flush — the render then happens once, on the shot actually wanted, rather than painting the
  // banner and immediately replacing it. Deliberately one-shot and cancelled by any viewer
  // input that moves the media (a step `stepLightbox`/`gotoLightbox` takes — not one on a lone
  // Cover, with nothing to step to — or a fresh open/close), so it can never move an image
  // out from under someone who is looking at it.
  createEffect(() => {
    const list = shots();
    const leaving = untrack(awaitingMedia);
    if (!leaving || list.length <= 1) return;
    setAwaitingMedia(null);
    const target = landingIndex(lbGame()!.appid, list, leaving);
    if (target === 0) return; // the Cover wanted, or trailers but no screenshots (not worth autoplaying unasked)
    setIdx(target);
    _onLightboxParamChange(list[target].shotId);
  });
  createEffect(() => {
    const list = shots();
    // A trailer is drawn differently on the TV (its poster) than here: a link change redraws it.
    if (list[idx()]?.type === 'video') linked();
    gameName();
    lbGame()?.mediaFailed; // a failed load on the lone Cover shown: say so
    if (list.length) renderLightbox();
  });
  // Steers the TV: a step is presented at once, then a burst's later steps only where it stops (after the
  // settle); not while a game's media are still loading (the latch above picks what it lands on).
  createEffect(() => {
    const now = linked();
    const fresh = now && !lbTvLinked;
    lbTvLinked = now;
    const game = lbGame();
    const shot = shots()[idx()];
    if (!now || !game || !shot) return cancelLbTv();
    // Media just in with the latch still set: the latch's effect may run after this one, so wait for its pick.
    if (awaitingMedia() && (detailsPending(game) || shots().length > 1)) return cancelLbTv();
    const on = presented();
    if (on?.appid === game.appid && on.item.shotId === shot.shotId) return cancelLbTv();
    clearTimeout(lbTvTimer);
    // What's on screen when it goes: any change since would have rescheduled it.
    // eslint-disable-next-line solid/reactivity -- read once when the settle ends, from a timer: nothing to track
    lbTvSend = () => {
      const g = lbGame();
      const item = shots()[idx()];
      if (g && !isIgdbRow(g) && item) present(g, item.shotId, undefined, { silent: true });
    };
    const settle = on?.appid === game.appid ? LB_SETTLE_MEDIA_MS : LB_SETTLE_GAME_MS;
    const burst = Date.now() < lbTvBurstUntil;
    lbTvBurstUntil = Date.now() + settle;
    if (fresh || !burst) flushLbTv();
    else lbTvTimer = setTimeout(flushLbTv, settle);
  });
  createEffect(() => {
    playback();
    presented();
    const onTv = linked();
    const trailer = lbTvTrailer();
    const lb = document.getElementById('screenshot-lightbox');
    if (lb) syncLbTv(lb, onTv, trailer);
  });
  // Says a link change while open: linked (an open on the TV included), private, or presenting over.
  const tvState = createMemo(() =>
    lbGame() === null ? 'closed' : !presented() ? 'off' : privateMode() ? 'private' : 'on',
  );
  let lastTvState = 'closed';
  createEffect(() => {
    const now = tvState();
    const lb = document.getElementById('screenshot-lightbox');
    if (lb && now !== 'closed' && (lastTvState !== 'closed' || now === 'on')) {
      if (now === 'on') noteLb(lb, 'Linked to the TV');
      if (now === 'private') noteLb(lb, `Private, the TV keeps ${untrack(presented)!.name}`);
      if (now === 'off') noteLb(lb, lbStopped ? 'Stopped presenting' : 'Presentation window closed');
    }
    lbStopped = false;
    lastTvState = now;
  });
  createEffect(() => {
    if (shots().length) renderLbCaption();
  });
});
