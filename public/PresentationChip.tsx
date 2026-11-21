// In the site nav while presenting (presentation.ts): what's on the TV, opening it in the lightbox (`onOpen`),
// and the host's remote — play/pause/replay and mute for a trailer, Retry after a failure, × to stop.
import { Show, type JSX } from 'solid-js';
import Pause from 'lucide-solid/icons/pause';
import Play from 'lucide-solid/icons/play';
import RotateCcw from 'lucide-solid/icons/rotate-ccw';
import TriangleAlert from 'lucide-solid/icons/triangle-exclamation-point';
import Volume2 from 'lucide-solid/icons/volume-2';
import VolumeX from 'lucide-solid/icons/volume-x';
import X from 'lucide-solid/icons/x';
import { announce } from './announce.ts';
import { control, playback, presented, stopPresenting } from './presentation.ts';

export function PresentationChip(props: { onOpen: () => void }): JSX.Element {
  const failed = () => !!playback()?.failed;
  const isVideo = () => presented()?.item.type === 'video';
  const ended = () => !!playback()?.ended;
  const paused = () => playback()?.paused ?? false;
  const muted = () => !!playback()?.muted;
  const playPause = () => control(ended() ? 'replay' : paused() ? 'play' : 'pause');
  // Waiting for a click on the TV, unmuting here can do nothing: it says so instead.
  const needsClick = () => !!playback()?.needsClick;
  const muteToggle = () => (needsClick() ? announce('Click the TV for sound') : control(muted() ? 'unmute' : 'mute'));
  // Space and M on the focused chip itself, as on a player; its buttons keep their own Space.
  const onKey = (e: KeyboardEvent & { currentTarget: HTMLElement }) => {
    if (e.target !== e.currentTarget || !isVideo() || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === ' ' || e.key === 'k' || e.key === 'K') {
      e.preventDefault(); // not the page's scroll
      playPause();
    }
    if (e.key === 'm' || e.key === 'M') muteToggle();
  };
  return (
    <Show when={presented()}>
      {(onAir) => (
        <div
          class="present-chip"
          role="group"
          aria-label={`Presenting ${onAir().name}, ${onAir().spoken}`}
          aria-keyshortcuts="Space K M"
          tabindex="0"
          onKeyDown={onKey}
        >
          <button type="button" class="present-chip-open" title="Open what's on the TV" onClick={() => props.onOpen()}>
            <Show
              when={!failed()}
              fallback={<TriangleAlert class="present-chip-alert" role="img" aria-label="Couldn't load on the TV" />}
            >
              <img class="present-chip-thumb" src={onAir().item.thumb} alt="" />
            </Show>
            <span class="present-chip-name">{onAir().name}</span>
            <span class="present-chip-item">{onAir().label}</span>
            <span class="visually-hidden">: open what's on the TV</span>
          </button>
          <Show when={failed()}>
            <button type="button" class="present-chip-btn" onClick={() => control('retry')}>
              Retry
            </button>
          </Show>
          <Show when={isVideo() && !failed()}>
            <button
              type="button"
              class="present-chip-btn"
              aria-label={ended() ? 'Replay on the TV' : paused() ? 'Play on the TV' : 'Pause the TV'}
              title={ended() ? 'Replay' : paused() ? 'Play' : 'Pause'}
              onClick={playPause}
            >
              <Show when={ended()} fallback={paused() ? <Play /> : <Pause />}>
                <RotateCcw />
              </Show>
            </button>
            <button
              type="button"
              class="present-chip-btn"
              aria-label={muted() || needsClick() ? 'Unmute the TV' : 'Mute the TV'}
              aria-disabled={needsClick()}
              title={needsClick() ? 'Click the TV for sound' : muted() ? 'Unmute' : 'Mute'}
              onClick={muteToggle}
            >
              <Show when={muted()} fallback={<Volume2 />}>
                <VolumeX />
              </Show>
            </button>
          </Show>
          <button
            type="button"
            class="present-chip-btn"
            aria-label={`Stop presenting ${onAir().name}`}
            title="Stop presenting"
            onClick={stopPresenting}
          >
            <X />
          </button>
          <Show when={isVideo() && (playback()?.dur ?? 0) > 0}>
            <span
              class="present-chip-progress"
              aria-hidden="true"
              style={{ '--present-progress': `${(100 * (playback()?.t ?? 0)) / (playback()?.dur || 1)}%` }}
            />
          </Show>
        </div>
      )}
    </Show>
  );
}
