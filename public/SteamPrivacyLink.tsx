import type { JSX } from 'solid-js';

// Opens the viewer's own Steam privacy settings: theirs to fix, or the address to send a friend.
export function SteamPrivacyLink(): JSX.Element {
  return (
    <a href="https://steamcommunity.com/my/edit/settings" target="_blank" rel="noopener">
      Steam privacy settings ↗
    </a>
  );
}
