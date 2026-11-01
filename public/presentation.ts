// The main window's side of the presentation window (PresentationView.tsx): opens it and sends it what to
// show, over a BroadcastChannel tagged with this window's id (docs/dev/panel-and-lightbox.md#the-presentation-window).
import { createSignal } from 'solid-js';
import { buildMediaItems, mediaLabel } from './mediaItems.ts';
import type { ReadonlyGame } from './types.ts';
import { PRESENTATION_CHANNEL, HEARTBEAT_MS } from './presentationProtocol.ts';
import type { Control, FromPresentation, OnAir, Playback, ToPresentation } from './presentationProtocol.ts';
import { announce } from './announce.ts';
import { remembered } from './presentationScreen.ts';

const MISSED_BEATS = 3;
// A hidden window's throttled timers beat about once a minute: its silence means less.
const HIDDEN_SILENCE_MS = 150_000;
const ID_KEY = 'playshelf-presentation-main';
// Kept beside the id: a reloaded main window mustn't push to the room what the host was browsing privately.
const PRIVATE_KEY = 'playshelf-presentation-private';
// How long after a bye-loss the window's hello still gets its media back: a slow reload (its own `main` grace).
const RELOAD_GRACE_MS = 10_000;

// What the presentation window shows; null while not presenting.
const [presented, setPresented] = createSignal<OnAir | null>(null);
// How the presented trailer (or picture) is doing, as the window last reported; null until it does.
const [playback, setPlayback] = createSignal<Playback | null>(null);
// The host's "private": the lightbox no longer steers the TV, on every open, until P relinks it or presenting stops.
const [privateMode, setPrivate] = createSignal(false);
export { presented, playback, privateMode };

export function setPrivateMode(on: boolean): void {
  setPrivate(on);
  try {
    if (on) sessionStorage.setItem(PRIVATE_KEY, '1');
    else sessionStorage.removeItem(PRIVATE_KEY);
  } catch {
    // Private browsing: it just won't survive a reload.
  }
}

let mainId: string | null = null;
let channel: BroadcastChannel | null = null;
let win: Window | null = null;
let lastSeen = 0;
let lastHidden = false;
// A lightbox trailer's playhead for the window's first sight of it (sent, or answered on its hello),
// never kept in `presented()`: a reload or a retry would replay it.
let handover: Pick<OnAir, 'startAt' | 'paused'> | undefined;
// Whether the window has said hello (or its state): until then a post goes unheard, the handover kept for its hello.
let helloed = false;
// What a bye-loss forgot, for a hello within `RELOAD_GRACE_MS` (a reload slower than the bye grace).
let recentlyLost: { onAir: OnAir; privately: boolean; at: number } | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let relayedKey: ((key: string, up: boolean) => void) | undefined;
let byeTimer: ReturnType<typeof setTimeout> | undefined;

function storedId(): string | null {
  try {
    return sessionStorage.getItem(ID_KEY);
  } catch {
    return null;
  }
}

function post(msg: ToPresentation) {
  channel?.postMessage(msg);
}

// Starts or keeps the watch on the window: its handle when this window opened it, else its heartbeat
// (`bye` misses a crash), judged by whether it last said it was hidden.
function seen() {
  lastSeen = Date.now();
  heartbeatTimer ??= setInterval(() => {
    if (win?.closed) return lost();
    // Beats too, handle or not: a crashed TV ("Aw, Snap") stays open but goes silent.
    const silence = lastHidden ? HIDDEN_SILENCE_MS : HEARTBEAT_MS * MISSED_BEATS;
    // Judged only while this window is visible: a hidden tab's own timers are throttled and would misjudge.
    if (document.visibilityState === 'visible' && Date.now() - lastSeen > silence) lost();
  }, HEARTBEAT_MS);
}

// The window went without being stopped from here: the nav chip goes too, which only sight tells.
function lost() {
  forget();
  announce('Presentation window closed');
}

function forget() {
  clearTimeout(byeTimer);
  lastHidden = false;
  handover = undefined;
  helloed = false;
  setPresented(null);
  setPlayback(null);
  setPrivateMode(false);
  clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
}

function onMessage(e: MessageEvent<FromPresentation>) {
  const msg = e.data;
  if (msg?.main !== mainId) return;
  // A reload also says bye, then hello: only a bye that stays one forgets the window.
  clearTimeout(byeTimer);
  if (msg.type === 'bye') {
    byeTimer = setTimeout(() => {
      const onAir = presented();
      recentlyLost = onAir && { onAir, privately: privateMode(), at: Date.now() };
      lost();
    }, 2000);
    return;
  }
  // Back from a slow reload: what it showed, as it was.
  if (msg.type === 'hello' && !presented() && recentlyLost && Date.now() - recentlyLost.at < RELOAD_GRACE_MS) {
    setPresented(recentlyLost.onAir);
    setPrivateMode(recentlyLost.privately);
    announce(`Presenting ${recentlyLost.onAir.name} again`);
  }
  recentlyLost = null;
  seen();
  helloed = true;
  if (msg.type === 'state') lastHidden = !!msg.hidden;
  if (msg.type === 'playback') {
    // The nav chip's warning sign, said: the shell's status line (the lightbox's error card is its own alert).
    const on = presented();
    if (msg.playback.failed && !playback()?.failed && on) announce(`Couldn't load ${on.name}, ${on.spoken} on the TV`);
    setPlayback(msg.playback);
  }
  if (msg.type === 'key') relayedKey?.(msg.key, msg.up);
  const current = presented();
  // A reloaded window asks again; a reloaded main window learns what's shown from the window's state.
  if (msg.type === 'hello') setPlayback(null); // a reloaded window: its report follows
  if (msg.type === 'hello' && current) post({ main: mainId, type: 'onAir', onAir: { ...current, ...handover } });
  if (msg.type === 'hello') handover = undefined;
  if (msg.type === 'state' && !current && msg.onAir) {
    const { startAt, paused, ...kept } = msg.onAir; // a handover is never kept
    setPresented(kept);
  }
}

function connect(id: string) {
  mainId = id;
  if (!channel) {
    channel = new BroadcastChannel(PRESENTATION_CHANNEL);
    channel.addEventListener('message', onMessage);
  }
  // Tells a window left from before a reload that this one is back; it answers with its state at once.
  post({ main: id, type: 'main' });
}

// A tab that presented before a reload keeps driving the same window, privately if it was.
const resumedId = storedId();
if (resumedId) {
  connect(resumedId);
  try {
    setPrivate(sessionStorage.getItem(PRIVATE_KEY) === '1');
  } catch {
    // Private browsing: nothing kept.
  }
}
// Going: the window closes unless `main` follows (a reload), or this page comes back from the bfcache.
addEventListener('pagehide', () => mainId && post({ main: mainId, type: 'bye' }));
addEventListener('pageshow', (e) => e.persisted && mainId && post({ main: mainId, type: 'main' }));

// Shows one media of `game` in the presentation window, opening it first if needed (it then asks for
// the media on hello). A plain object: store rows are proxies, which postMessage can't clone.
export function present(
  game: ReadonlyGame,
  shotId: string,
  from?: Pick<OnAir, 'startAt' | 'paused'>,
  // The linked lightbox says it on its own status line (the shell's is inert under its modal).
  { silent = false } = {},
): void {
  const items = buildMediaItems(game.appid, game.details?.meta);
  const i = items.findIndex((s) => s.shotId === shotId);
  if (i < 0) return;
  const wasPresenting = presented() != null;
  const spoken = mediaLabel(items, i);
  const name = game.name || `App ${game.appid}`;
  const onAir = { appid: game.appid, name, item: items[i], label: spoken.replace(' of ', ' / '), spoken };
  handover = from;
  if (presented()?.item.shotId !== shotId || presented()?.appid !== game.appid) setPlayback(null);
  if (!silent) announce(`Presenting ${name}, ${spoken}`);
  setPresented(onAir);
  seen();
  // An open window main forgot (missed beats) is sent to, not reopened: that would reload it out of fullscreen.
  if (win ? !win.closed : wasPresenting) {
    post({ main: mainId!, type: 'onAir', onAir: { ...onAir, ...handover } });
    if (helloed) handover = undefined;
    return;
  }
  const id = storedId() ?? crypto.randomUUID();
  try {
    sessionStorage.setItem(ID_KEY, id);
  } catch {
    // Private mode: presenting still works, it just won't survive a reload of this window.
  }
  connect(id);
  const url = `/present.html?main=${encodeURIComponent(id)}`;
  // Blocked: P or a click is a user gesture, so browsers seldom do.
  // Straight onto the screen it was placed on last time (the browser keeps it on this one without the permission).
  const at = remembered();
  const where = at
    ? `left=${at.availLeft},top=${at.availTop},width=${at.availWidth},height=${at.availHeight}`
    : 'width=960,height=540';
  win = window.open(url, `playshelf-presentation-${id}`, `popup,${where}`);
  if (win) return;
  forget();
  announce('Allow pop-ups for this site to present.'); // the browser's own blocked-pop-up icon is visual only
}

// The stepping keys pressed in the window (one subscriber: the lightbox); returns the unsubscribe.
export function onRelayedKey(fn: (key: string, up: boolean) => void): () => void {
  relayedKey = fn;
  return () => {
    if (relayedKey === fn) relayedKey = undefined;
  };
}

export function flashCaption(): void {
  if (mainId && presented()) post({ main: mainId, type: 'caption' });
}

// The host's remote control: the window answers with `playback`.
export function control(c: Control): void {
  if (mainId && presented()) post({ main: mainId, type: 'control', control: c });
}

// A new id for the next window: the closing one's last bye and heartbeat then go unheard.
export function stopPresenting(): void {
  if (mainId) post({ main: mainId, type: 'close' });
  // It fades out, then closes itself; a window still loading can't hear `close` yet, so it's closed here after the fade.
  const opened = win;
  setTimeout(() => opened?.close(), 600);
  win = null;
  forget();
  recentlyLost = null;
  mainId = null;
  try {
    sessionStorage.removeItem(ID_KEY);
  } catch {
    // Private mode: nothing was stored.
  }
}
