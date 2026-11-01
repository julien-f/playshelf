// The side panel's shared contract (docs/dev/panel-and-lightbox.md#the-side-panel), on every page that hosts it:
// one panel, so a behaviour that differs between pages is a bug.
import { test, expect, type Locator, type Page } from '@playwright/test';
import { mockApi } from './mockApi.ts';
import { asPlayer } from './state.ts';
import { row } from './rows.ts';
import { ALICE, BOB, BUNDLE } from './fixtures.ts';

const PICKS = {
  id: 'picks',
  name: 'Picks',
  parentId: null,
  order: 0,
  createdAt: 0,
  updatedAt: 0,
  kind: 'manual',
  appids: [620, 1145360, 105600],
};

interface Host {
  name: string;
  // Lands on the page with the panel closed.
  load: (page: Page) => Promise<void>;
  // What opens the game, and where focus goes back on close.
  opener: (page: Page) => Locator;
  // The game's name on its row, clicked as a pointer user does; a button opener is clicked itself.
  game?: string;
  // The address while the game is open; null where the page keeps no URL state for it.
  openUrl: RegExp | null;
  // The address once it's closed.
  closedUrl: RegExp;
  // ↑/↓/R step through a list.
  hasList: boolean;
  // Opening leaves focus on the opener (Search: arrows keep walking the results, the panel following).
  keepsFocus?: boolean;
}

const listHost = (name: string, path: string, game: string, appid: number, extra = {}): Host => ({
  name,
  load: async (page) => {
    await asPlayer(page, ALICE, extra);
    await page.goto(path);
  },
  opener: (page) => row(page, game),
  game,
  openUrl: new RegExp(`[?&]game=${appid}(&|$)`),
  closedUrl: new RegExp(`${path.replace(/[?]/g, '\\?')}$`),
  hasList: true,
});

const HOSTS: Host[] = [
  listHost('Owned', '/lists/owned', 'Hades', 1145360),
  // Resolved players: the page rewrites a link's names to ids.
  listHost('Compare', `/lists/compare?u=${ALICE.steamid}&u=${BOB.steamid}`, 'Portal 2', 620),
  listHost('Bundle', `/lists/bundle/${BUNDLE.id}`, 'Hades', 1145360),
  listHost('custom list', `/lists/${PICKS.id}`, 'Hades', 1145360, { lists: [PICKS] }),
  {
    name: 'Recently Looked Up',
    load: async (page) => {
      await asPlayer(page, ALICE, { recentGames: [1145360, 620, 105600] });
      await page.goto('/game');
    },
    opener: (page) => row(page, 'Portal 2'),
    game: 'Portal 2',
    openUrl: /\/game\/620$/,
    closedUrl: /\/game$/,
    hasList: true,
  },
  {
    name: 'Search',
    load: async (page) => {
      await asPlayer(page, ALICE);
      await page.goto('/search?q=dead');
      // A `?q=` landing opens its top match by itself: closed, to open one the way a user does.
      await expect(page.locator('#panel-title')).toBeVisible();
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(page.locator('#game-panel')).toBeHidden();
    },
    // A middle row: ↑ from the first one goes back to the search box.
    opener: (page) => row(page, 'Left 4 Dead 2'),
    game: 'Left 4 Dead 2',
    openUrl: /[?&]game=550(&|$)/,
    closedUrl: /\/search\?q=dead$/,
    hasList: true,
    keepsFocus: true,
  },
  {
    name: 'Rank',
    load: async (page) => {
      await asPlayer(page, ALICE);
      await page.goto('/lists/owned');
      for (const name of ['Portal 2', 'Hades']) await row(page, name).getByRole('checkbox').check();
      await page.getByRole('button', { name: 'Rank 2 games' }).click();
      await expect(page).toHaveURL(/\/rank$/);
    },
    opener: (page) => page.getByRole('button', { name: 'Details', exact: true }).first(),
    // A peek at one of the pair: no `?game=` (frontend.md).
    openUrl: null,
    closedUrl: /\/lists\/[^/]+\/rank$/,
    hasList: false,
  },
];

const panel = (page: Page) => page.locator('#game-panel');
const title = (page: Page) => page.locator('#panel-title');
const focusInPanel = (page: Page) =>
  page.evaluate(() => document.getElementById('game-panel')?.contains(document.activeElement) ?? false);

async function open(page: Page, host: Host): Promise<void> {
  const opener = host.opener(page);
  await (host.game ? opener.getByText(host.game).first() : opener).click();
  await expect(panel(page)).toBeVisible();
  await expect(title(page)).not.toBeEmpty();
}

let consoleErrors: string[];
test.beforeEach(async ({ page }) => {
  consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push(err.message));
  page.on('console', (msg) => {
    // mockApi aborts every off-site request (Steam's CDN art): those fail by design.
    if (msg.type() === 'error' && !msg.text().endsWith('net::ERR_FAILED')) consoleErrors.push(msg.text());
  });
  await mockApi(page);
});
test.afterEach(() => {
  expect(consoleErrors, 'console errors').toEqual([]);
});

for (const host of HOSTS) {
  test.describe(`panel on ${host.name}`, () => {
    test('F1 edge: open — focus moves into the panel (or stays on the opener); Esc closes it, focus back on the opener', async ({
      page,
    }) => {
      await host.load(page);
      await open(page, host);
      if (host.keepsFocus) await expect(host.opener(page)).toBeFocused();
      else await expect.poll(() => focusInPanel(page), 'focus in the panel').toBe(true);
      await page.keyboard.press('Escape');
      await expect(panel(page)).toBeHidden();
      await expect(host.opener(page)).toBeFocused();
      await expect(page).toHaveURL(host.closedUrl);
    });

    test('F1 edge: close — × closes it, focus back on the opener', async ({ page }) => {
      await host.load(page);
      await open(page, host);
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(panel(page)).toBeHidden();
      await expect(host.opener(page)).toBeFocused();
      await expect(page).toHaveURL(host.closedUrl);
    });

    test('F1 edge: back — Back closes only the panel, the next Back leaves the page', async ({ page }) => {
      await page.goto('/about');
      await host.load(page);
      await open(page, host);
      await page.goBack();
      await expect(panel(page)).toBeHidden();
      await expect(page).toHaveURL(host.closedUrl);
      await page.goBack();
      await expect(page).not.toHaveURL(host.closedUrl);
      await expect(panel(page)).toBeHidden();
    });

    const openUrl = host.openUrl;
    if (openUrl)
      test('F1 edge: url — the address names the open game, and a reload reopens it', async ({ page }) => {
        await host.load(page);
        await open(page, host);
        await expect(page).toHaveURL(openUrl);
        const name = await title(page).textContent();
        await page.reload();
        await expect(title(page)).toHaveText(name!);
      });

    if (host.hasList)
      test('F1 edge: step — ↑/↓ step through the list, R picks another game', async ({ page }) => {
        await host.load(page);
        await open(page, host);
        const first = (await title(page).textContent())!;
        await page.keyboard.press('ArrowDown');
        await expect(title(page)).not.toHaveText(first);
        await page.keyboard.press('ArrowUp');
        await expect(title(page), '↑ back to the first game').toHaveText(first);
        await page.keyboard.press('r');
        await expect(title(page)).not.toHaveText(first);
        await expect(panel(page)).toBeVisible();
      });

    test('F1 edge: refresh — ↻ re-fetches the details and shows their age', async ({ page }) => {
      await host.load(page);
      await open(page, host);
      const refresh = page.getByRole('button', { name: 'Refresh details' });
      await expect(refresh.locator('.panel-refresh-age'), 'the age of the details').not.toBeEmpty();
      const refetch = page.waitForRequest(/\/api\/game-details\/\d+\?refresh=1$/, { timeout: 3000 });
      await refresh.click();
      await refetch;
      await expect(refresh).toBeEnabled();
    });

    test('F1 edge: leave — leaving the page with the panel open closes it', async ({ page }) => {
      await host.load(page);
      await open(page, host);
      // The footer link, clicked through the DOM: on a phone the panel covers it.
      await page.locator('.app-footer a[href="/about"]').evaluate((a) => (a as HTMLElement).click());
      await expect(page).toHaveURL(/\/about$/);
      await expect(panel(page)).toBeHidden();
    });
  });
}
