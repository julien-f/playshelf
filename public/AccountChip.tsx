// The nav bar's account chip — who the app is currently showing, and one-click access to that
// account's Owned/Wishlist lists from every route (see docs/dev/frontend.md).
//
// Two problems it exists to fix, both consequences of Home having been the only place any of
// this lived: getting to Owned/Wishlist from anywhere else meant a round trip through Home, and
// — worse — nothing outside Home said *whose* library was on screen, even while a `?u=` link was
// being explored. Both are shell concerns, not route ones, so this mounts once in AppShell.tsx's
// nav bar and survives every navigation.
//
// The two list links render inline next to the chip on a wide viewport and inside the popover on
// a narrow one (`.account-chip-links`/`.account-chip-panel-links`, style.css) — they're the two
// most-visited destinations in the app, so they're worth permanent nav space wherever there's
// room for it, and the popover has to carry them regardless for the case where there isn't.
//
// Deliberately thin next to Home's own account section: current account, switch account, and the
// `?u=` exploring state. Resolving a new identifier, ★ starring, per-account refresh, counts,
// Family member rows and removal all stay on Home — this is a nav affordance, not a second,
// half-implemented copy of that screen, so it links there instead of growing toward it.
import { onCleanup, onMount, For, Match, Show, Switch, type JSX } from 'solid-js';
import Link from 'lucide-solid/icons/link';
import Star from 'lucide-solid/icons/star';
import { A, useLocation, useNavigate } from '@solidjs/router';
import {
  getEffectiveCurrentAccount,
  getAccountOverride,
  getRecentAccounts,
  getMyAccount,
  accountDisplayLabel,
  accountIdentifiers,
} from './accountsStore.ts';
import { getAccountOverrideState, adoptAccount, accountOverrideStatusText } from './accountOverride.ts';
import { withAccountParam } from './urlState.ts';
import { bindNavPopover } from './navPopover.ts';
import { CopyButton } from './CopyButton.tsx';
import {
  getAuthUser,
  signOut,
  isSessionExpired,
  dismissSessionExpired,
  SESSION_EXPIRED_TITLE,
  SESSION_EXPIRED_DETAIL,
} from './authStore.ts';
import type { AccountSlot } from './types.ts';

const EXPIRED_HINT = " — Steam sign-in expired, changes aren't syncing";

export function AccountChip(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  // The button/panel pair are always rendered, even with no account at all — the popover
  // still has recents to switch to and a way to Home, and a ref inside a <Show> wouldn't exist
  // yet at onMount time to bind anything to.
  let btnEl!: HTMLButtonElement;
  let panelEl!: HTMLDivElement;

  const account = getEffectiveCurrentAccount;
  const overrideState = getAccountOverrideState;
  const override = getAccountOverride;
  const recents = () => getRecentAccounts();

  onMount(() => onCleanup(bindNavPopover(btnEl, panelEl)));

  // Every link out of here carries `?u=` along (withAccountParam), or clicking "Owned" while
  // exploring a shared link would quietly show the *stored* account's library instead. Built off
  // the router's own reactive location.search, so each href updates itself the moment an explicit
  // pick strips the param (pick() below).
  function link(path: string): string {
    return withAccountParam(path, location.search);
  }

  function pick(acc: AccountSlot): void {
    adoptAccount(acc, navigate, location);
    panelEl.hidePopover();
    btnEl.focus(); // the clicked button is now hidden in the closed popover
  }

  const otherRecents = () => recents().filter((a) => a.id !== account()?.id);

  // Not `<Show when={account()}>{acc => accountDisplayLabel(acc())}</Show>`: a child function
  // returning a bare string is evaluated once, when `when` first goes truthy, and Solid inserts
  // the resulting text — so switching from one account straight to another (truthy → truthy,
  // exactly what a `?u=` link resolving does) left the name stuck on the previous account while
  // the avatar next to it, a plain JSX expression, updated correctly. Confirmed live: the chip
  // read "Dana" over bob's avatar on `/lists/wishlist?u=bob`. As a plain accessor
  // read inside JSX, this is a reactive insertion like any other.
  const chipLabel = () => {
    const acc = account();
    if (acc) return accountDisplayLabel(acc);
    return overrideState().state === 'resolving' ? 'Resolving link…' : 'No account';
  };

  return (
    <div class="site-nav-account">
      <Show when={account()}>
        <div class="account-chip-links">
          <A href={link('/lists/owned')} class="site-nav-link" activeClass="active">
            Owned
          </A>
          <A href={link('/lists/wishlist')} class="site-nav-link" activeClass="active">
            Wishlist
          </A>
        </div>
      </Show>

      <div class="site-nav-popover">
        <button
          type="button"
          class="site-nav-link account-chip-btn"
          aria-label={(account() ? `Account: ${chipLabel()}` : chipLabel()) + (isSessionExpired() ? EXPIRED_HINT : '')}
          title={isSessionExpired() ? "Steam sign-in expired: changes aren't syncing" : undefined}
          popovertarget="account-chip-panel"
          ref={btnEl}
        >
          <Show
            when={account()?.avatarUrl}
            fallback={
              <Show when={account()}>
                <span class="account-chip-avatar account-chip-initial" aria-hidden="true">
                  {Array.from(chipLabel())[0]?.toUpperCase()}
                </span>
              </Show>
            }
          >
            {(url) => <img class="account-chip-avatar" src={url()} alt="" width="26" height="26" />}
          </Show>
          <span class="account-chip-name">{chipLabel()}</span>
          {/* A link's account is showing, not the stored one — the difference is invisible
              otherwise, and this chip is the one thing on screen from every route that can say so
              (Home says it at length; see its own account-override note). */}
          <Show when={override()}>
            <span class="account-chip-explore" title="Showing an account from a shared link, not your own">
              <Link />
              <span class="visually-hidden">(from a link)</span>
            </span>
          </Show>
          <Show when={isSessionExpired()}>
            <span class="account-chip-alert" aria-hidden="true" />
          </Show>
        </button>

        <div id="account-chip-panel" class="site-nav-popover-panel account-chip-panel" popover ref={panelEl}>
          <Show when={accountOverrideStatusText(overrideState())}>
            {(text) => <p class="account-chip-note">{text()}</p>}
          </Show>
          <Show when={override()}>
            {(acc) => (
              <p class="account-chip-note">
                Exploring <strong>{accountDisplayLabel(acc())}</strong> from a link — your own account is unchanged.
                <button type="button" class="account-chip-action" onClick={() => pick(acc())}>
                  Set as my current account
                </button>
              </p>
            )}
          </Show>

          {/* The same two links as the inline pair above — CSS shows exactly one of the two at a
              given width (style.css's 768px breakpoint), so this isn't a visible duplicate. */}
          <Show when={account()}>
            <div class="account-chip-panel-links">
              <A href={link('/lists/owned')} class="account-chip-panel-link">
                Owned
              </A>
              <A href={link('/lists/wishlist')} class="account-chip-panel-link">
                Wishlist
              </A>
            </div>
          </Show>

          {/* The identifier to hand to someone else so they can look this account up — shown
              from the slot's own stored data (this chip fetches nothing). Single accounts only:
              a Family has one per member, which is Home's account card's job, not a nav
              popover's. */}
          <Show when={account()?.members.length === 1 && account()}>
            {(acc) => (
              <div class="account-chip-id">
                <code>{accountIdentifiers(acc())[0].identifier}</code>
                <CopyButton
                  text={accountIdentifiers(acc())[0].identifier}
                  title="Copy this account's Steam identifier"
                />
              </div>
            )}
          </Show>

          <Show when={otherRecents().length > 0}>
            <h2 class="account-chip-section">Switch account</h2>
            <ul class="account-chip-recents">
              <For each={otherRecents()}>
                {(acc) => (
                  <li>
                    <button type="button" class="account-chip-recent" onClick={() => pick(acc)}>
                      <Show
                        when={acc.avatarUrl}
                        fallback={<span class="account-chip-avatar account-chip-avatar--empty" />}
                      >
                        {(url) => <img class="account-chip-avatar" src={url()} alt="" width="26" height="26" />}
                      </Show>
                      <span class="account-chip-name">{accountDisplayLabel(acc)}</span>
                      <Show when={acc.id === getMyAccount()?.id}>
                        <span class="account-chip-mine" title="Your account">
                          <Star />
                          <span class="visually-hidden">(yours)</span>
                        </span>
                      </Show>
                    </button>
                    {/* Beside the switch button rather than inside it — nesting a button in a
                        button is invalid, and copying an identifier shouldn't also switch account. */}
                    <For each={accountIdentifiers(acc)}>
                      {({ identifier }) => (
                        <CopyButton text={identifier} title={`Copy this account's Steam identifier (${identifier})`} />
                      )}
                    </For>
                  </li>
                )}
              </For>
            </ul>
          </Show>

          {/* Optional — the app works fully anonymously (see docs/dev/lists-and-accounts.md).
              Signing in with Steam additionally syncs prefs (accounts/lists/settings) to the
              server, so they follow you to another browser/device. */}
          <h2 class="account-chip-section">Steam account</h2>
          {/* rel="external" is @solidjs/router's documented escape hatch from its own global
              anchor-click interception — without it, this same-origin link was hijacked into a
              client-side navigation to a path with no matching route (a blank page, no request
              ever reaching the server) instead of the real page load /auth/steam/login needs. */}
          <Switch
            fallback={
              <a href="/auth/steam/login" rel="external" class="account-chip-panel-link">
                Sign in with Steam
              </a>
            }
          >
            <Match when={isSessionExpired()}>
              <div class="account-chip-expired">
                <p class="account-chip-expired-title">{SESSION_EXPIRED_TITLE}</p>
                <p class="account-chip-note">{SESSION_EXPIRED_DETAIL}</p>
                <div class="account-chip-expired-actions">
                  <a href="/auth/steam/login" rel="external" class="btn btn-primary">
                    Sign in again
                  </a>
                  <button type="button" class="account-chip-action" onClick={() => dismissSessionExpired()}>
                    Stay signed out
                  </button>
                </div>
              </div>
            </Match>
            <Match when={getAuthUser()}>
              <p class="account-chip-note">
                Signed in — your accounts/lists/settings sync to your Steam account.
                <button type="button" class="account-chip-action" onClick={() => signOut()}>
                  Sign out
                </button>
              </p>
            </Match>
          </Switch>

          <A
            href={link('/')}
            class="account-chip-panel-link"
            onClick={() => {
              panelEl.hidePopover();
            }}
          >
            {account() ? 'Manage accounts on Home' : 'Pick an account on Home'}
          </A>
        </div>
      </div>
    </div>
  );
}
