import { expect, test, type Locator, type Page } from '@playwright/test';
import { game, type Player } from './fixtures.ts';

// Seeds `player` as both my ★ account and the current one, once per tab: later reloads keep
// whatever the test did since. `withLabel: false` stores it the way an old slot was: id only.
// `recentGames`: Recently Looked Up's appids newest first, or `{ appid, lookedUpAt }` to stamp one. `updatedAt`: every key's last-write time.
// `otherAccounts`: names of extra known accounts (display only: they resolve to nothing).
// `listViews`: the listViews.ts pref, saved views per kind. `lists`: the user's lists (listsStore.ts).
// `openCards`: the panel cards open (panelOpenCards.ts), for a test that reads one rather than opening it.
export async function asPlayer(
  page: Page,
  player: Player,
  {
    withLabel = true,
    recentGames = [] as (number | { appid: number; lookedUpAt?: number })[],
    updatedAt = 0,
    otherAccounts = [] as string[],
    listViews = undefined as object | undefined,
    lists = undefined as object[] | undefined,
    openCards = undefined as string[] | undefined,
  } = {},
): Promise<void> {
  const slot = {
    id: player.steamid,
    members: [player.steamid],
    rawInputs: [player.vanity],
    ...(withLabel ? { label: player.personaname } : {}),
  };
  const entry = (value: unknown) => ({ value, updatedAt });
  const prefs = {
    schemaVersion: 2,
    myAccount: entry(slot),
    currentAccount: entry(slot),
    recentAccounts: entry([
      slot,
      ...otherAccounts.map((label, i) => ({ id: `${9000 + i}`, members: [`${9000 + i}`], rawInputs: [label], label })),
    ]),
    ...(recentGames.length
      ? {
          recentGames: entry(
            recentGames.map((g) => {
              const { appid, lookedUpAt } = typeof g === 'number' ? { appid: g, lookedUpAt: undefined } : g;
              return { appid, name: game(appid).name, tinyImage: null, lookedUpAt };
            }),
          ),
        }
      : {}),
    ...(listViews ? { listViews: entry(listViews) } : {}),
    ...(lists ? { lists: entry(lists) } : {}),
    ...(openCards ? { panelOpenCards: entry(openCards) } : {}),
  };
  await page.addInitScript((blob) => {
    if (sessionStorage.getItem('e2e-seeded')) return;
    localStorage.setItem('steam.isonoe.net:prefs', blob);
    sessionStorage.setItem('e2e-seeded', '1');
  }, JSON.stringify(prefs));
}

// Holds every request to `url` until `release()`, then lets the mock answer it: register before the
// page asks. `requested` settles on the first; `count` says how many came. The page closing releases it.
export async function gate(page: Page, url: string | RegExp) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let hit!: () => void;
  const held = { requested: new Promise<void>((resolve) => (hit = resolve)), count: 0, release };
  await page.route(url, async (route) => {
    held.count++;
    hit();
    await released;
    await route.fallback().catch(() => {}); // the page may be gone by then
  });
  page.once('close', release);
  return held;
}

// A named mid-test screenshot, kept only on an `E2E_SHOTS=1` run (see playwright.config.ts).
export async function shot(page: Page, name: string): Promise<void> {
  if (test.info().project.use.screenshot !== 'on') return;
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

// The panel card titled `title`: its one button, named "<title>, <summary>".
export function cardButton(page: Page, title: string): Locator {
  const name = new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')},`);
  return page.locator('#game-panel').getByRole('heading', { level: 3 }).getByRole('button', { name });
}

// Opens a folded panel card and returns its body: a wide card's, or the tile's part of its row's drawer.
export async function openCard(page: Page, title: string): Promise<Locator> {
  const button = cardButton(page, title);
  await expect(button).toHaveAttribute('aria-expanded', /true|false/);
  if ((await button.getAttribute('aria-expanded')) === 'false') await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  return page.locator(`[id="${await button.getAttribute('aria-controls')}"]`);
}

// `boundingBox()` doesn't wait: it's null while the element isn't shown yet.
export async function visibleBox(locator: Locator) {
  await expect(locator).toBeVisible();
  return (await locator.boundingBox())!;
}
