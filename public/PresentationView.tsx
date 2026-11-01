// The presentation window (present.html): a lightbox on another screen, showing the one media its main window sends
// (presentation.ts). Its DOM is never rebuilt, so fullscreen holds across sends (docs/dev/panel-and-lightbox.md#the-presentation-window).
import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { render } from 'solid-js/web';
import Cast from 'lucide-solid/icons/cast';
import TriangleAlert from 'lucide-solid/icons/triangle-alert';
import VolumeX from 'lucide-solid/icons/volume-x';
import { playHls, stopHls, trailerStill } from './hlsPlayer.ts';
import type { HlsVideo } from './hlsPlayer.ts';
import { canPlace, placementGranted, remember, targetScreen } from './presentationScreen.ts';
import type { ScreenDetailed } from './presentationScreen.ts';
import { PRESENTATION_CHANNEL, HEARTBEAT_MS } from './presentationProtocol.ts';
import type { Control, FromPresentationBody, OnAir, ToPresentation } from './presentationProtocol.ts';

const IDLE_MS = 3000;
// The lower third's time on screen: long enough to read from a sofa when the game changes.
const CAPTION_GAME_MS = 5000;
const CAPTION_MEDIA_MS = 2000;
const FADE_MS = 400; // --dur-4
// Relayed to the main window, whose lightbox steps with them (`key` in presentationProtocol.ts).
const RELAYED_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'r', 'R']);

function PresentationView() {
  const main = new URLSearchParams(location.search).get('main');
  const [onAir, setOnAir] = createSignal<OnAir | null>(null);
  // The cursor, on a mouse move; the caption has its own times (`showCaption`).
  const [awake, setAwake] = createSignal(true);
  const [captioned, setCaptioned] = createSignal(false);
  let captionTimer: ReturnType<typeof setTimeout> | undefined;
  const [failed, setFailed] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  // A trailer muted for want of a first click in this window: the pill says a click gives it sound.
  const [silenced, setSilenced] = createSignal(false);
  let root!: HTMLDivElement;
  let img!: HTMLImageElement;
  let video!: HlsVideo;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const channel = new BroadcastChannel(PRESENTATION_CHANNEL);

  const post = (msg: FromPresentationBody) => main && channel.postMessage({ main, ...msg });
  // Nothing after `bye`: a closing window's last visibilitychange would otherwise cancel it.
  let closing = false;
  const report = () =>
    !closing && post({ type: 'state', onAir: onAir(), hidden: document.visibilityState === 'hidden' });
  // The main window said it's going: closed unless it says `main` again (a reload) within this.
  let mainGone: ReturnType<typeof setTimeout> | undefined;
  // The host's unmute this window refused: no click here yet (see `Playback.needsClick`).
  let needsClick = false;
  // The host's mute (chip, M), kept from one media to the next; the browser's own (no click here yet) isn't.
  let hostMuted = false;
  let lastTimeReport = 0;
  const reportPlayback = () =>
    !closing &&
    post({
      type: 'playback',
      playback: {
        paused: video.paused,
        muted: video.muted,
        t: video.currentTime,
        dur: video.duration || 0,
        ended: video.ended,
        failed: failed(),
        needsClick,
        buffering: !video.hidden && loading(),
      },
    });

  function wake() {
    setAwake(true);
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => setAwake(false), IDLE_MS);
  }

  // After the cross-fade, so the two don't move at once.
  function showCaption(ms: number) {
    clearTimeout(captionTimer);
    setCaptioned(false);
    captionTimer = setTimeout(() => {
      setCaptioned(true);
      captionTimer = setTimeout(() => setCaptioned(false), ms);
    }, FADE_MS);
  }

  // What was on screen fades out over the new media, copied (the DOM is never rebuilt).
  function fadeOut() {
    let ghost: HTMLImageElement | HTMLCanvasElement | null = null;
    if (!video.hidden) ghost = trailerStill(video);
    else if (!img.hidden && img.currentSrc) {
      ghost = document.createElement('img');
      ghost.src = img.currentSrc;
    }
    if (!ghost) return;
    ghost.className = 'pres-ghost';
    ghost.addEventListener('animationend', () => ghost.remove(), { once: true });
    root.append(ghost);
  }

  // The OS media keys reach the TV's trailer: the host's "wait!" from anywhere. Kept through a pause, or
  // the key couldn't resume it; dropped when it ends or something else is shown.
  function claimMediaKeys(name?: string, poster?: string) {
    const session = navigator.mediaSession;
    if (!session) return;
    session.metadata = name ? new MediaMetadata({ title: name, artwork: poster ? [{ src: poster }] : [] }) : null;
    session.setActionHandler('play', name ? () => void video.play().catch(() => {}) : null);
    session.setActionHandler('pause', name ? () => video.pause() : null);
  }

  let showAbort: AbortController | undefined;
  // A lightbox handover (`startAt`, `paused`) is applied once, never kept in `onAir()`: a retry or reload starts afresh.
  function show({ name, item, spoken }: OnAir, { startAt, paused }: Pick<OnAir, 'startAt' | 'paused'> = {}) {
    setFailed(false);
    fadeOut();
    document.title = `${name} — Playshelf presentation`;
    img.alt = `${name}, ${spoken}`;
    video.setAttribute('aria-label', `${name}, ${spoken}`);
    claimMediaKeys(item.type === 'video' ? name : undefined, item.thumb);
    // A late error or load from the previous media is dropped.
    const current = () => onAir()?.item === item;
    const fail = () => current() && (setLoading(false), setFailed(true), reportPlayback());
    if (item.type === 'video') {
      img.hidden = true;
      video.hidden = false;
      video.poster = item.thumb;
      setLoading(false);
      // With sound when the browser allows it, unless the host muted it; muted, and saying so, when the
      // browser wants a click here first.
      video.muted = hostMuted;
      setSilenced(false);
      // A lightbox handover: loading the stream resets the position, so it's set once loaded; listeners
      // tied to this show only (a trailer that never starts mustn't pause the next one).
      showAbort?.abort();
      showAbort = new AbortController();
      const signal = showAbort.signal;
      if (startAt)
        video.addEventListener('loadedmetadata', () => (video.currentTime = startAt), { once: true, signal });
      if (paused) video.addEventListener('play', () => video.pause(), { once: true, signal });
      playHls(video, item.hls, fail, () => setSilenced(true));
    } else {
      stopHls(video);
      setSilenced(false);
      video.hidden = true;
      img.hidden = false;
      img.onerror = null; // a broken thumbnail isn't the picture failing: `full` says that
      // The thumbnail stands in until the full picture has loaded.
      img.src = item.thumb;
      setLoading(true);
      const full = new Image();
      full.onload = () => current() && ((img.src = item.main!), setLoading(false));
      full.onerror = fail;
      full.src = item.main!;
    }
    reportPlayback();
  }

  function obey(c: Control) {
    if (c === 'retry') {
      const shown = onAir();
      if (shown) show(shown); // nothing yet: a window just reloaded, before its onAir
      return;
    }
    if (video.hidden) return;
    if (typeof c === 'object') {
      const t = 'seekBy' in c ? video.currentTime + c.seekBy : c.seekTo;
      video.currentTime = Math.max(0, Math.min(t, video.duration || t));
    }
    if (c === 'play') video.play().catch(() => {});
    if (c === 'pause') video.pause();
    if (c === 'replay') {
      video.currentTime = 0;
      video.play().catch(() => {});
    }
    if (c === 'mute') {
      video.muted = hostMuted = true;
      needsClick = false;
    }
    // Unmuted before a click here, Chrome would pause it: it waits for that click instead.
    if (c === 'unmute') {
      hostMuted = false;
      if (activatedAt || navigator.userActivation?.hasBeenActive) {
        video.muted = false;
        setSilenced(false);
      } else needsClick = true;
    }
    reportPlayback();
  }

  function receive(e: MessageEvent<ToPresentation>) {
    const msg = e.data;
    if (msg?.main !== main) return;
    // Stopped: the TV fades to black rather than snapping to the desktop.
    if (msg.type === 'close') {
      closing = true;
      root.classList.add('pres--closing');
      setTimeout(() => window.close(), FADE_MS);
    }
    if (msg.type === 'control') obey(msg.control);
    if (msg.type === 'caption') showCaption(CAPTION_MEDIA_MS);
    // 10 s: a slow reload of the main window must have time to say `main` again.
    if (msg.type === 'bye') {
      clearTimeout(mainGone);
      mainGone = setTimeout(() => window.close(), 10_000);
    }
    // The main window is back from a reload: tell it at once, before it opens a second window.
    if (msg.type === 'main') {
      clearTimeout(mainGone);
      report();
    }
    if (msg.type === 'onAir') {
      const shown = onAir();
      const same = shown?.appid === msg.onAir.appid && shown.item.shotId === msg.onAir.item.shotId;
      // P again on what's up: the caption says what it is; only an ended trailer starts over.
      const { startAt, paused, ...kept } = msg.onAir;
      if (same && failed()) {
        // P again on what failed: another try, on the item stored (`show` checks it's still current).
        setOnAir(kept);
        show(kept, { startAt, paused });
      } else if (same && !video.hidden && startAt != null) {
        // A lightbox handover on the trailer already up: the room follows the host's playhead.
        video.currentTime = startAt;
        void (paused ? video.pause() : video.play().catch(() => {}));
      } else if (same && !video.hidden && video.ended) video.play().catch(() => {});
      else if (!same) {
        const gameChanged = shown?.appid !== msg.onAir.appid;
        setOnAir(kept);
        show(kept, { startAt, paused });
        showCaption(gameChanged ? CAPTION_GAME_MS : CAPTION_MEDIA_MS);
      }
      if (same) showCaption(CAPTION_MEDIA_MS);
      report();
    }
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else root.requestFullscreen?.().catch(() => {});
  }

  // The first click (or key) here enters fullscreen and gives sound — the card says so until then;
  // later ones never leave fullscreen (someone in the room clicking), double-click or F does.
  let activatedAt = 0;
  const [activated, setActivated] = createSignal(false);
  // A gesture here: the browser's mute lifts (the host's stays), and the chip's mute is a mute again.
  function giveSound() {
    if (!hostMuted) video.muted = false;
    setSilenced(false);
    needsClick = false;
    reportPlayback();
  }
  function activate() {
    giveSound();
    if (!activatedAt) {
      activatedAt = Date.now();
      setActivated(true);
      if (!document.fullscreenElement) toggleFullscreen();
    }
  }
  // Placing it on the TV (Chromium): the card's button. Granted already, one click puts it there in
  // fullscreen; a first grant outlasts that click's activation, so the button then asks for another.
  const [placing, setPlacing] = createSignal<'no' | 'ask' | 'ready'>('no');
  const [targetLabel, setTargetLabel] = createSignal('');
  let target: ScreenDetailed | null = null;
  function aim(s: ScreenDetailed | null) {
    target = s;
    setTargetLabel(s?.label ?? '');
    setPlacing(s ? 'ready' : 'ask');
  }
  async function place(e: MouseEvent) {
    e.stopPropagation(); // not also fullscreen on this screen
    if (!target) {
      const s = await targetScreen().catch(() => null);
      if (s) aim(s);
      else setPlacing('no'); // refused, or no other screen after all
      return;
    }
    remember(target);
    activatedAt = Date.now();
    setActivated(true);
    giveSound();
    root.requestFullscreen?.({ screen: target } as FullscreenOptions).catch(() => {});
    // Leaving fullscreen puts the window back where it was: on the TV, then.
    window.moveTo(target.availLeft, target.availTop);
    window.resizeTo(target.availWidth, target.availHeight);
  }

  function onDoubleClick() {
    if (Date.now() - activatedAt > 500) toggleFullscreen(); // not the activating click's second half
  }

  let wakeLock: WakeLockSentinel | null = null;
  async function keepScreenOn() {
    if (document.visibilityState !== 'visible' || (wakeLock && !wakeLock.released)) return;
    try {
      wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
      wakeLock?.addEventListener('release', () => void keepScreenOn()); // the system took it back
    } catch {
      // Refused (power saving, no HTTPS): the screen may dim, nothing else changes.
    }
  }

  onMount(() => {
    channel.addEventListener('message', receive);
    // Chromium nulls `opener` when the main window closes, others keep it `closed`; a reload keeps it.
    const hadOpener = !!window.opener;
    const heartbeat = setInterval(
      () => (hadOpener && (!window.opener || window.opener.closed) ? window.close() : report()),
      HEARTBEAT_MS,
    );
    // For a host who clicked into the TV: the lightbox's keys, no more (it has no other controls).
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return; // the browser's
      // Tab and Escape aren't a gesture for fullscreen, and the card's own button keeps its keys.
      if (!activatedAt && !['Tab', 'Escape'].includes(e.key) && !(e.target as Element).closest?.('.pres-card'))
        return activate();
      if (!activatedAt) return;
      if (RELAYED_KEYS.has(e.key)) {
        e.preventDefault(); // not the page's scroll
        post({ type: 'key', key: e.key, up: false });
        return;
      }
      if (e.key === 'f' || e.key === 'F') toggleFullscreen();
      if (video.hidden) return;
      if (e.key === ' ' || e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        void (video.paused ? video.play().catch(() => {}) : video.pause());
      }
      if (e.key === 'm' || e.key === 'M') obey(video.muted ? 'unmute' : 'mute');
    };
    const bye = () => {
      post({ type: 'bye' });
      closing = true;
    };
    // Its release too: a hidden main window (this one fullscreen over it) settles a held key on it, its timers throttled.
    const onKeyUp = (e: KeyboardEvent) =>
      activatedAt &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      RELAYED_KEYS.has(e.key) &&
      post({ type: 'key', key: e.key, up: true });
    document.addEventListener('keydown', onKey);
    document.addEventListener('keyup', onKeyUp);
    // Stalled: the spinner (after a moment, by its own CSS delay).
    video.addEventListener('waiting', () => setLoading(true));
    // A trailer's: not the picture that replaced it, whose own load set it.
    for (const type of ['playing', 'pause', 'emptied'])
      video.addEventListener(type, () => !video.hidden && setLoading(false));
    // At once, unlike the time (below): the host's lightbox mirrors them.
    for (const type of ['play', 'pause', 'ended', 'volumechange', 'durationchange', 'seeked', 'waiting', 'playing'])
      video.addEventListener(type, reportPlayback);
    // Played again (a replay, a seek back): the keys are the TV's again.
    video.addEventListener('play', () => {
      const shown = onAir();
      if (!video.hidden && shown?.item.type === 'video') claimMediaKeys(shown.name, shown.item.thumb);
    });
    video.addEventListener('ended', () => {
      claimMediaKeys();
      showCaption(CAPTION_GAME_MS); // so the room knows what they just watched
    });
    document.addEventListener('fullscreenchange', keepScreenOn);
    // The chip's progress line: once a second is plenty.
    video.addEventListener('timeupdate', () => {
      if (Date.now() - lastTimeReport < 1000) return;
      lastTimeReport = Date.now();
      reportPlayback();
    });
    document.addEventListener('visibilitychange', keepScreenOn);
    document.addEventListener('visibilitychange', report); // hidden: main allows for throttled beats
    addEventListener('pagehide', bye);
    keepScreenOn();
    wake();
    post({ type: 'hello' });
    if (canPlace())
      void placementGranted().then(async (granted) => aim(granted ? await targetScreen().catch(() => null) : null));
    onCleanup(() => {
      clearInterval(heartbeat);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('visibilitychange', keepScreenOn);
      document.removeEventListener('visibilitychange', report);
      document.removeEventListener('fullscreenchange', keepScreenOn);
      removeEventListener('pagehide', bye);
      channel.close();
    });
  });

  return (
    <div
      class="pres"
      classList={{ 'pres--awake': awake(), 'pres--loading': loading(), 'pres--failed': failed() }}
      ref={root}
      onPointerMove={wake}
      onClick={activate}
      onDblClick={onDoubleClick}
    >
      <img class="pres-media" ref={img} alt="" hidden />
      <video class="pres-media" ref={video} playsinline hidden />
      {/* A TV channel's lower third: the game, and which of its media. */}
      <Show when={onAir()}>
        {(shown) => (
          <p class="pres-caption pres-glass" classList={{ 'pres-caption--on': captioned() }}>
            <span class="pres-caption-name">{shown().name}</span>
            <span class="pres-caption-media">{shown().label}</span>
          </p>
        )}
      </Show>
      <Show when={!activated()}>
        <div class="pres-card pres-glass">
          <Cast aria-hidden="true" />
          <p>{silenced() ? 'Click for fullscreen and sound' : 'Click for fullscreen'}</p>
          <Show when={placing() !== 'no'}>
            <button type="button" class="pres-place" onClick={place}>
              {placing() === 'ready' ? `Fullscreen on “${targetLabel()}”` : 'Place on the other screen'}
            </button>
          </Show>
        </div>
      </Show>
      <Show when={activated() && silenced()}>
        <p class="pres-sound pres-glass">
          <VolumeX aria-hidden="true" />
          Click for sound
        </p>
      </Show>
      <Show when={failed() && onAir()}>
        {(game) => (
          <p class="pres-error pres-glass" role="alert">
            <TriangleAlert aria-hidden="true" />
            Couldn't load this {game().item.type === 'video' ? 'video' : 'image'}.
          </p>
        )}
      </Show>
    </div>
  );
}

render(() => <PresentationView />, document.getElementById('presentation')!);
