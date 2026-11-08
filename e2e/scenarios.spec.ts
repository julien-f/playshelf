// docs/dev/journeys.md's journeys, end to end against mocked data (mockApi.ts).
import { test, expect, type Locator, type Page } from '@playwright/test';
import { DEMO_OF, LIMITED, mockApi, respond } from './mockApi.ts';
import { HEARTBEAT_MS, PRESENTATION_CHANNEL } from '../public/presentationProtocol.ts';
import { hookPresentation, type PresTest } from './presentationHooks.ts';
import { asPlayer, gate, shot, visibleBox } from './state.ts';
import { row, rows } from './rows.ts';
import {
  ALICE,
  BOB,
  BUNDLE,
  CAROL,
  CATALOG,
  DAVE,
  ERIN,
  PICK_BUNDLE,
  SIGNED_IN,
  SYNCED_LIST,
  signedInPrefs,
} from './fixtures.ts';

let pageErrors: string[];
test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await mockApi(page);
});
test.afterEach(() => {
  expect(pageErrors, 'uncaught page errors').toEqual([]);
});

const groupRows = (page: Page) => page.locator('.dt-group-row');
// A Home tree row's ⋯, which holds its Move, Rename and Delete.
const rowMenu = (page: Page, name: string) => page.getByRole('button', { name: `More actions for ${name}` });

test('A1: first visit — resolve my account, then open my library', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder('Steam name, profile URL, or 64-bit ID…').fill('alice');
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(page.getByRole('main')).toContainText('Owned: 6');
  await expect(page.getByText('Friends (private)')).toBeVisible(); // the mock's friends lists are private

  await page.getByRole('main').getByRole('link', { name: 'Owned', exact: true }).click();
  await expect(rows(page)).toHaveCount(6);
  await expect(row(page, 'Hades')).toContainText('44.5');

  await page.reload();
  await expect(page.getByRole('banner')).toContainText('Alice');
  await expect(rows(page)).toHaveCount(6);
});

test('A1 edge: Home, then Owned, then a game download the library and wishlist once', async ({ page }) => {
  await asPlayer(page, ALICE);
  const asked: string[] = [];
  page.on('request', (req) => {
    const path = new URL(req.url()).pathname;
    if (path === '/api/common-games' || path === '/api/wishlist') asked.push(path);
  });
  await page.goto('/');
  await expect(page.locator('.account-counts')).toContainText('Owned: 6');
  await page.getByRole('main').getByRole('link', { name: 'Owned', exact: true }).click();
  await expect(rows(page)).toHaveCount(6);
  await row(page, 'Hades').getByText('Hades').click();
  await expect(page.locator('.panel-ownership-badge.owned')).toBeVisible();
  expect(asked.sort()).toEqual(['/api/common-games', '/api/wishlist']);
});

test('A1 edge: a first visit says what the app does, and the account field looks it up', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.home-intro')).toContainText('ratings, completion times and prices');
  await expect(page.getByRole('button', { name: 'Look up', exact: true })).toBeVisible();
});

test('A1 edge: Look up keeps focus while it resolves', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/common-games', async (route) => {
    await held;
    await route.fallback();
  });
  await page.goto('/');
  await page.getByPlaceholder('Steam name, profile URL, or 64-bit ID…').fill('alice');
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  const busy = page.getByRole('button', { name: 'Looking up…' });
  await expect(busy).toHaveAttribute('aria-disabled', 'true');
  await expect(busy).toBeFocused();
  release();
  await expect(page.getByRole('main')).toContainText('Owned: 6');
});

test('A1 edge: an Explore card opens its list from anywhere on the card', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/');
  const card = page.locator('.explore-card').filter({ has: page.getByRole('link', { name: 'Wishlist', exact: true }) });
  // At the description, which the link's stretched ::after covers.
  const box = await visibleBox(card.getByText("The current account's wishlist"));
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page).toHaveURL(/\/lists\/wishlist$/);
});

test('A1 edge: the Explore cards fill even rows, three wide past phone width', async ({ page }, testInfo) => {
  await asPlayer(page, ALICE);
  await page.goto('/');
  const cards = page.locator('.explore-card');
  await expect(cards).toHaveCount(6);
  const tops = await cards.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
  const perRow = testInfo.project.name === 'phone' ? 1 : 3;
  const rowSizes = [...new Set(tops)].map((top) => tops.filter((t) => t === top).length);
  expect(rowSizes).toEqual(Array(6 / perRow).fill(perRow));
});

test('A1 edge: native controls render dark, like the page around them', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator(':root')).toHaveCSS('color-scheme', 'dark');
});

const heroContrast = (label: Locator) =>
  label.evaluate((el) => {
    const rgb = (c: string) =>
      c
        .match(/\d+(\.\d+)?/g)!
        .slice(0, 3)
        .map(Number);
    const lum = (c: string) => {
      const [r, g, b] = rgb(c).map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    // The hero draws no ground of its own: the first opaque one behind the label.
    let ground: Element = el;
    while (ground.parentElement && Number(getComputedStyle(ground).backgroundColor.match(/[\d.]+/g)![3] ?? 1) < 1)
      ground = ground.parentElement;
    const fg = lum(getComputedStyle(el).color);
    const bg = lum(getComputedStyle(ground).backgroundColor);
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
  });

test("A1 edge: a list's stat labels meet AA contrast on the hero", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  const label = page.locator('.list-stat-label').first();
  await expect(label).toBeVisible();
  expect(await heroContrast(label)).toBeGreaterThanOrEqual(4.5);
});

test("A1 edge: a list load leaves its steps' timings for DevTools, in order", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  const measures = () =>
    page.evaluate(() => Object.fromEntries(performance.getEntriesByType('measure').map((m) => [m.name, m.duration])));
  await expect
    .poll(async () => Object.keys(await measures()).sort())
    .toEqual(['list:done', 'list:listed', 'list:rows']);
  const m = await measures();
  expect(m['list:rows']).toBeLessThanOrEqual(m['list:listed']);
  expect(m['list:listed']).toBeLessThanOrEqual(m['list:done']);
});

test("A1 edge: a pressed stat tile's label still meets AA contrast on the hero", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/bundles');
  const toggle = page.locator('.list-stat-btn[aria-pressed="false"]').first();
  await toggle.click();
  const pressed = page.locator('.list-stat-btn[aria-pressed="true"]').first();
  await expect(pressed).toBeVisible();
  const label = page.locator('.list-stat', { has: pressed }).locator('.list-stat-label');
  // Still hovered after the click: pressed must not look like plain hover, or the click shows no change.
  const hoveredPressed = await label.evaluate((el) => getComputedStyle(el).color);
  await page.mouse.move(0, 0);
  await pressed.evaluate((el) => (el as HTMLElement).blur());
  expect(await heroContrast(label)).toBeGreaterThanOrEqual(4.5);
  // The tile first, then its button: a `has` locator ending in .first() matches every tile holding one.
  const otherTile = page.locator('.list-stat', { has: page.locator('.list-stat-btn[aria-pressed="false"]') }).first();
  await otherTile.locator('.list-stat-btn').hover();
  const otherLabel = otherTile.locator('.list-stat-label');
  expect(await otherLabel.evaluate((el) => getComputedStyle(el).color)).not.toBe(hoveredPressed);
});

test("B1 edge: /bundles' filter tiles look like toggles, unlike the plain figures beside them", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/bundles');
  const chrome = (loc: Locator) =>
    loc.evaluate((el) => {
      const s = getComputedStyle(el);
      return { border: s.borderTopWidth, borderColor: s.borderTopColor, background: s.backgroundColor };
    });
  const toggle = page.locator('.list-stat-btn[aria-pressed="false"]').first();
  await expect(toggle).toBeVisible();
  const plain = await chrome(page.locator('.list-stat', { hasText: 'Updated' }).locator('.list-stat-btn'));
  const off = await chrome(toggle);
  expect(plain.border).toBe('0px');
  expect(off.border).not.toBe('0px');
  await toggle.click();
  await page.mouse.move(0, 0);
  const pressed = page.locator('.list-stat-btn[aria-pressed="true"]').first();
  await expect(pressed).toHaveCSS('border-top-color', 'rgb(76, 194, 255)'); // --accent
  // A thicker edge, not only a colour: forced colors repaint colours and drop shadows.
  expect(Number.parseFloat((await chrome(pressed)).border)).toBeGreaterThan(Number.parseFloat(off.border));
  // Hover shows on a pressed chip too.
  const pressedRest = (await chrome(pressed)).background;
  await pressed.hover();
  await expect.poll(async () => (await chrome(pressed)).background).not.toBe(pressedRest);
});

test('A1 edge: Owned with no account points to Home rather than showing 0 games', async ({ page }) => {
  await page.goto('/lists/owned');
  await expect(page.getByText('No account selected')).toBeVisible();
  await expect(page.locator('.list-hero')).not.toContainText('Games');
  await page.getByRole('link', { name: 'pick one on Home' }).click();
  await expect(page).toHaveURL(/\/$/);
});

test('A1 edge: a fixed list opens with a trailing slash or other letter case', async ({ page }) => {
  await mockApi(page);
  await asPlayer(page, ALICE);
  await page.goto('/lists/game-pass/');
  await expect(rows(page)).toHaveCount(4);
  await page.goto('/Lists/Owned');
  await expect(rows(page).first()).toBeVisible();
  await expect(page.getByText("isn't in this browser")).toHaveCount(0);
});

test("A1 edge: a wishlist that didn't load says so on Home, rather than 0", async ({ page }) => {
  await page.route('**/api/wishlist', (route) =>
    route.fulfill({ status: 502, json: { error: 'Steam request failed' } }),
  );
  await asPlayer(page, ALICE);
  await page.goto('/');
  await expect(page.locator('.account-counts')).toContainText("Owned: 6 · Wishlisted: couldn't load");
});

test('A2.1-2,4: explore a friend, then switch back to my ★ account from the nav chip', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/');
  await page.getByPlaceholder('Steam name, profile URL, or 64-bit ID…').fill('bob');
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(page.getByRole('banner')).toContainText('Bob');

  await page.getByRole('banner').getByText('Bob', { exact: true }).click();
  const back = page.getByRole('button', { name: /Alice/ }).filter({ has: page.getByTitle(/Your account/) });
  await expect(back).toBeVisible();
  await back.click();
  await expect(page.getByRole('banner')).toContainText('Alice');
});

test('A2 edge: the nav chip reads as an account, not as a second selected route', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  const chip = page.locator('.account-chip-btn');
  await expect(chip.locator('.account-chip-initial')).toHaveText('A'); // no avatar in the fixtures
  await chip.hover();
  await expect(chip).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const route = page.locator('.site-nav-link.active');
  await expect(route).toHaveText('Owned');
  expect(await chip.evaluate((el) => getComputedStyle(el).borderColor)).not.toBe('rgba(0, 0, 0, 0)');
});

test("A2 edge: the account card's star names, and says on hover, what clicking it does", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Unstar Alice' })).toHaveAttribute('title', 'Unstar Alice');
  await page.getByPlaceholder('Steam name, profile URL, or 64-bit ID…').fill('bob');
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Star Bob as mine' })).toHaveAttribute('title', 'Star Bob as mine');
});

test('A2 edge: accounts list mine first, then by name; starring moves one first', async ({ page }) => {
  await asPlayer(page, BOB, { otherAccounts: ['dave', 'Carol'] });
  await page.goto('/');
  const tiles = page.locator('.account-tiles .account-tile');
  await expect(tiles).toHaveText([/Bob.*\(yours\)/, /Carol/, /dave/]);
  await expect(tiles.first()).toHaveAttribute('aria-current', 'true');

  await tiles.filter({ hasText: 'dave' }).click();
  await page.getByRole('button', { name: 'Star dave as mine' }).click();
  await expect(tiles).toHaveText([/dave.*\(yours\)/, /Bob/, /Carol/]);
  await expect(tiles.first()).toHaveAttribute('aria-current', 'true');
});

test('A2 edge: many accounts can be filtered by name, and Esc clears the filter', async ({ page }) => {
  const others = ['Bea', 'Cid', 'Dee', 'Eve', 'Fay', 'Gus', 'Hal', 'Ida'];
  await asPlayer(page, ALICE, { otherAccounts: others });
  await page.goto('/');
  const tiles = page.locator('.account-tiles li');
  await expect(tiles).toHaveCount(9);
  const filter = page.getByRole('searchbox', { name: 'Filter accounts' });
  await filter.fill('e');
  await expect(tiles).toHaveText([/Alice/, /Bea/, /Dee/, /Eve/]);
  await filter.fill('zz');
  await expect(page.locator('.home-recents')).toContainText('No account matches “zz”.');
  await page.getByRole('button', { name: 'Clear filter' }).click();
  await expect(tiles).toHaveCount(9);
  await expect(filter).toBeFocused();
  await filter.fill('e');
  await page.keyboard.press('Escape');
  await expect(tiles).toHaveCount(9);
});

test('A2 edge: Edit shows every Remove and Clear all; Esc and Done leave it', async ({ page }) => {
  await asPlayer(page, ALICE, { otherAccounts: ['Bea'] });
  await page.goto('/');
  const remove = page.getByRole('button', { name: 'Remove Bea' });
  await expect(remove).toHaveCSS('opacity', '0');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(remove).toHaveCSS('opacity', '1');
  await expect(page.getByRole('button', { name: 'Clear all' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Clear all' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Clear all' }).click();
  await expect(page.locator('.home-recents')).toContainText('No accounts yet');
  await expect(page.getByRole('button', { name: /^(Edit|Done)$/ })).toHaveCount(0);
});

test('A2 edge: removing a recent account moves focus to the next one, the last to the lookup field', async ({
  page,
}) => {
  await asPlayer(page, ALICE);
  await page.goto('/');
  await page.getByPlaceholder('Steam name, profile URL, or 64-bit ID…').fill('bob');
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(page.locator('.account-tiles li')).toHaveCount(2);
  // Hidden until hovered or focused: keyboard focus reveals it.
  await page.getByRole('button', { name: 'Remove Alice' }).focus();
  await expect(page.getByRole('button', { name: 'Remove Alice' })).toHaveCSS('opacity', '1');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Remove Bob' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.account-tiles li')).toHaveCount(0);
  await expect(page.getByPlaceholder('Steam name, profile URL, or 64-bit ID…')).toBeFocused();
});

test('A2 edge: switching account from the nav chip leaves focus on the chip', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/');
  await page.getByPlaceholder('Steam name, profile URL, or 64-bit ID…').fill('bob');
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(page.getByRole('banner')).toContainText('Bob');

  await page.locator('.account-chip-btn').click();
  await page
    .getByRole('button', { name: /Alice/ })
    .filter({ has: page.getByTitle(/Your account/) })
    .click();
  await expect(page.getByRole('banner')).toContainText('Alice');
  await expect(page.locator('.account-chip-btn')).toBeFocused();
});

test("A2 edge: the nav chip marks my account with Home's filled star", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/');
  const homeFill = await page
    .getByRole('button', { name: 'Unstar Alice' })
    .locator('svg')
    .evaluate((el) => getComputedStyle(el).fill);
  await page.getByPlaceholder('Steam name, profile URL, or 64-bit ID…').fill('bob');
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(page.getByRole('banner')).toContainText('Bob');
  await page.locator('.account-chip-btn').click();
  const mine = page.getByTitle('Your account', { exact: true });
  await expect(mine).toBeVisible();
  expect(await mine.locator('svg').evaluate((el) => getComputedStyle(el).fill)).toBe(homeFill);
  expect(homeFill).not.toBe('none');
});

test('A3 edge: Add Steam Family account focuses the field it adds', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add Steam Family account' }).click();
  const fields = page.getByPlaceholder('Steam name, profile URL, or 64-bit ID…');
  await expect(fields).toHaveCount(2);
  await expect(fields.nth(1)).toBeFocused();
});

test('A2 edge: an account picked mid-refresh does not read "Refreshing…" while it loads', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/');
  await expect(page.locator('.account-counts')).toContainText('Owned: 6');
  // Holds Alice's refresh and Bob's wishlist (his library comes with his resolve), so both are in flight.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/api\/(common-games\?refresh=1|wishlist)$/, async (route) => {
    const body = route.request().postData() ?? '';
    if (body.includes(ALICE.steamid) || body.includes(BOB.steamid)) await held;
    await route.fallback();
  });
  const updated = page.locator('.account-updated-btn');
  await updated.click();
  await expect(updated).toContainText('Refreshing');

  await page.getByPlaceholder('Steam name, profile URL, or 64-bit ID…').fill('bob');
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(page.getByRole('banner')).toContainText('Bob');
  await expect(updated).not.toContainText('Refreshing');
  release();
  await expect(page.locator('.account-counts')).toContainText('Owned: 4');
});

test("A2 edge: a picked account whose library fails doesn't show the previous one's age", async ({ page }) => {
  await mockApi(page, { states: ['stale'] });
  // A stored account, so no resolve brings its library along.
  await asPlayer(page, ALICE, { otherAccounts: ['Bob'] });
  await page.goto('/');
  const updated = page.locator('.account-updated-btn');
  await expect(updated).toContainText('12 days ago');
  await page.route('**/api/common-games', (route) =>
    route.request().postData()?.includes('9000') // otherAccounts' id
      ? route.fulfill({ status: 502, json: { error: 'Steam request failed' } })
      : route.fallback(),
  );

  await page.locator('.account-tiles .account-tile').filter({ hasText: 'Bob' }).click();
  await expect(page.locator('.account-counts')).toContainText("Owned: couldn't load");
  await expect(updated).not.toContainText('12 days ago');
});

test('S3 edge: an unknown path says so and links Home', async ({ page }) => {
  await page.goto('/compare');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await page.getByRole('link', { name: 'Go to Home' }).click();
  await expect(page).toHaveURL('/');
});

test('S3 edge: the page carries its own icon, so the browser asks for no favicon.ico', async ({ page }) => {
  await page.goto('/about');
  await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute('href', '/favicon.svg');
  const icon = await page.request.get('/favicon.svg');
  expect(icon.status()).toBe(200);
  expect(icon.headers()['content-type']).toContain('image/svg+xml');
});

test('S3 edge: About names every data source, ProtonDB included', async ({ page }) => {
  await page.goto('/about');
  const sources = page.locator('section', { hasText: 'Data sources' });
  for (const name of ['Steam Web API', 'Steam Store', 'HowLongToBeat', 'ProtonDB', 'IsThereAnyDeal'])
    await expect(sources.getByText(name, { exact: true })).toBeVisible();
});

test('S3 edge: a first game link in a fresh browser lists that game under Recently Looked Up', async ({ page }) => {
  await page.goto('/game/620');
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, 'Portal 2')).toBeVisible();
  await expect(page.getByText('No games in this list.')).toHaveCount(0);
});

test('S3 edge: a shared layout with a wrongly typed field still applies the rest of it', async ({ page }) => {
  await asPlayer(page, ALICE);
  // An older or hand-edited link: `filters.name` should be a list of values.
  const tv = JSON.stringify({ sorts: [{ key: 'name', dir: 'desc' }], filters: { name: 5 } });
  await page.goto(`/lists/owned?tv=${encodeURIComponent(tv)}`);
  await expect(rows(page)).toHaveCount(6);
  await expect(rows(page).first()).toContainText('Valheim');
});

test("S3 edge: editing a shared layout warns it's lost on reload unless kept", async ({ page }) => {
  const tv = JSON.stringify({ sorts: [{ key: 'name', dir: 'desc' }] });
  await page.goto(`/lists/compare?u=alice&u=bob&tv=${encodeURIComponent(tv)}`);
  const banner = page.getByRole('status').filter({ hasText: 'shared' });
  await expect(banner).toContainText('for this visit only');
  await expect(rows(page).first()).toBeVisible();
  const toggle = page.locator('.dt-group-row').first().locator('.dt-group-colname');
  await toggle.click(); // collapse a group
  await expect(banner).toContainText("You've changed this shared layout — it's lost on reload unless you keep it");
  await expect(banner.getByRole('button', { name: 'Keep as my layout' })).toBeVisible();
  await expect(page.getByText('Unsaved changes to')).toHaveCount(0); // one banner at a time
  // Back to the link's own layout: nothing of the viewer's is left to lose.
  await toggle.click();
  await expect(banner).toContainText('for this visit only');
  await banner.getByRole('button', { name: 'Keep as my layout' }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByText('Unsaved changes to')).toHaveCount(0); // kept is saved
});

test("S3 edge: another browser's list link explains lists are local", async ({ page }) => {
  await page.goto('/lists/not-in-this-browser');
  await expect(page.getByText("This list isn't in this browser")).toBeVisible();
  await expect(page.getByText('Share list')).toBeVisible();
});

test('A1 edge: an account stored without its name picks it up from Home', async ({ page }) => {
  await asPlayer(page, ALICE, { withLabel: false });
  await page.goto('/');
  await expect(page.getByRole('banner')).toContainText('Alice');
  await page.reload();
  await expect(page.getByRole('banner')).toContainText('Alice');
});

test('F3 edge: the Played (h) filter range reads in rounded hours', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.locator('.dt-filter-cols-search').fill('Played');
  await page.locator('[data-filter-col-key="playtime"]').click();
  // Empty until a bound is set; the column's bounds show as placeholders in its own format (0 h is "—").
  const bounds = () =>
    page.locator('.dt-range-input').evaluateAll((inputs) => inputs.map((i) => (i as HTMLInputElement).placeholder));
  await expect.poll(bounds).toEqual(['—', '20.0']);
});

test("F3 edge: the table's digits all have one width, so numbers line up", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await expect(row(page, 'Hades').locator('td', { hasText: '44.5' })).toHaveCSS('font-variant-numeric', 'tabular-nums');
});

test("F3 edge: a game's thumbnail falls back to its smaller capsule, then hides", async ({ page }, testInfo) => {
  await page.route('**/capsule_231x87.jpg', (route) => route.fulfill({ status: 404 }));
  await page.route('**/capsule_184x69.jpg', (route) =>
    route.request().url().includes('/620/')
      ? route.fulfill({ status: 404 })
      : route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="184" height="69"/>',
        }),
  );
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  const thumb = row(page, 'Hades').locator('img.game-thumb');
  await expect(thumb).toHaveAttribute('src', /capsule_184x69/);
  await expect(thumb).toBeVisible();
  // The same box either way, so the row doesn't move as the image loads or fails (2px each side clipped off).
  expect(await visibleBox(thumb)).toMatchObject(
    testInfo.project.name === 'phone' ? { width: 64, height: 26 } : { width: 164, height: 64 },
  );
  await expect(row(page, 'Portal 2').locator('img.game-thumb')).toHaveCSS('visibility', 'hidden');
});

test("F3 edge: the open game's row keeps its bar under forced colors, where a tint or shadow is dropped", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360');
  const current = row(page, 'Hades');
  await expect(current).toHaveAttribute('aria-current', 'true');
  const bar = () =>
    current
      .locator('td')
      .first()
      .evaluate((el) => getComputedStyle(el, '::before').borderLeftWidth);
  expect(await bar()).toBe('3px');
});

test('F3 edge: the Played (h) filter has a "never played" preset', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.locator('.dt-filter-cols-search').fill('Played');
  await page.locator('[data-filter-col-key="playtime"]').click();
  await page.getByRole('button', { name: 'never played' }).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(page.getByRole('button', { name: /Played \(h\): never played/ })).toBeVisible();
});

test('F3.5: the table toolbar picks a random game from the filtered rows', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.locator('.dt-filter-cols-search').fill('Played');
  await page.locator('[data-filter-col-key="playtime"]').click();
  await page.getByRole('button', { name: 'never played' }).click();
  await expect(rows(page)).toHaveCount(3);
  await page.keyboard.press('Escape');
  await page.locator('.dt-toolbar').getByRole('button', { name: 'Pick a random game' }).click();
  await expect(page.locator('#panel-title')).not.toBeEmpty();
  await expect(row(page, await page.locator('#panel-title').innerText())).toHaveCount(1); // one of the 3
});

test("F3 edge: a column header's filter lists values as the cells write them", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  const menuButton = page.getByRole('button', { name: 'Genres options' });
  await menuButton.click();
  await page.getByRole('dialog', { name: 'Genres options' }).getByRole('button', { name: 'Filter' }).click();
  // innerText, unlike textContent, applies CSS text-transform
  const labels = () =>
    page.locator('.dt-th-filter-flyout label').evaluateAll((ls) => ls.map((l) => (l as HTMLElement).innerText));
  await expect.poll(labels).toContain('Action\n5');
});

test('C5 edge: the ProtonDB filter names games with no report apart from Borked ones', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/wishlist');
  await expect(rows(page)).toHaveCount(4);
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.locator('.dt-filter-cols-search').fill('ProtonDB');
  await page.locator('[data-filter-col-key="protondb"]').click();
  const values = page.locator('.dt-dd');
  await expect(values).toContainText('Borked');
  await expect(values).toContainText('No report');
});

test("C4 edge: on a comparison, the panel's Owned by lists every player who owns the game", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/compare?u=alice&u=bob&u=carol');
  await row(page, 'Portal 2').getByText('Portal 2').click();
  const owners = page.locator('#panel-section-owners .panel-owner-name');
  await expect(owners).toHaveCount(3);
  expect((await owners.allInnerTexts()).sort()).toEqual(['Alice', 'Bob', 'Carol']);
});

test('C1 edge: a tag filter ranks games by how strongly they carry the tag, until cleared', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  const names = () =>
    rows(page)
      .getByRole('checkbox')
      .evaluateAll((boxes) => boxes.map((b) => b.getAttribute('aria-label')!.replace('Select row ', '')));
  const byRating = await names();
  await row(page, 'Portal 2').getByText('Portal 2').click();
  const coop = page.locator('.panel-tags').getByRole('button', { name: 'Co-op, tag', exact: true });
  await coop.click();
  await expect(page.getByRole('columnheader', { name: /Tag match/ })).toBeVisible();
  await expect.poll(names).toEqual(['Valheim', 'Terraria', 'Stardew Valley', 'Portal 2']);
  await coop.click();
  await expect(page.getByRole('columnheader', { name: /Tag match/ })).toHaveCount(0);
  await expect.poll(names).toEqual(byRating);
});

test("C1 edge: the panel's Steam tags show how strongly players tagged the game with each", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await row(page, 'Portal 2').getByText('Portal 2').click();
  const coop = page.locator('.panel-tags').getByRole('button', { name: 'Co-op, tag', exact: true });
  await expect(coop).toHaveAttribute('title', "30% of the top tag's votes");
  const ratio = await coop.evaluate(
    (el) => el.querySelector('.tag-weight')!.getBoundingClientRect().width / el.getBoundingClientRect().width,
  );
  expect(ratio).toBeCloseTo(0.3, 1);
});

test("B2 edge: the panel lists the account's owned games closest by Steam tags, each opening its own panel", async ({
  page,
}) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/wishlist');
  await row(page, 'It Takes Two').getByText('It Takes Two').click();
  const similar = page.locator('#panel-section-similar');
  await expect(similar.locator('.panel-section-title')).toHaveText(/^Similar in Alice's library/);
  await expect(similar.getByRole('link', { name: /More like this on Steam/ })).toHaveAttribute(
    'href',
    'https://store.steampowered.com/recommended/morelike/app/1426210/',
  );
  await similar.getByRole('link', { name: "Alice's Owned list" }).click();
  await expect(rows(page)).toHaveCount(6);
  // On Owned itself, a row's closest owned games are the list's own similarity sort.
  await row(page, 'Valheim').getByText('Valheim').click();
  await expect(similar.locator('.panel-similar-item')).toHaveCount(0);
  await expect(similar.getByRole('button', { name: 'Sort list by similarity' })).toBeVisible();

  await page.goto('/lists/wishlist');
  await row(page, 'It Takes Two').getByText('It Takes Two').click();
  await expect(similar.locator('.panel-similar-item').first()).toBeVisible();
  const first = (await similar.locator('.panel-similar-name').first().textContent())!;
  await similar.locator('.panel-similar-item').first().click();
  await expect(page.locator('#panel-title')).toHaveText(first);
});

test('C1 edge: the panel sorts the list by similarity to its game, until stopped', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  const names = () =>
    rows(page)
      .getByRole('checkbox')
      .evaluateAll((boxes) => boxes.map((b) => b.getAttribute('aria-label')!.replace('Select row ', '')));
  const byRating = await names();
  await row(page, 'Valheim').getByText('Valheim').click();
  await page.getByRole('button', { name: 'Sort list by similarity' }).click();
  await expect(page.getByRole('columnheader', { name: /Similarity/ })).toBeVisible();
  await expect(page.locator('.pref-unsaved-banner')).toHaveCount(0); // not a layout change
  // Terraria's tags match Valheim's as closely as Valheim's own, so the two 100% tie.
  await expect
    .poll(async () => (await names()).slice(0, 4))
    .toEqual([...byRating.filter((n) => n === 'Valheim' || n === 'Terraria'), 'Stardew Valley', 'Portal 2']);
  await page.getByRole('button', { name: 'Stop sorting by similarity' }).click();
  await expect(page.getByRole('columnheader', { name: /Similarity/ })).toHaveCount(0);
  await expect.poll(names).toEqual(byRating);
  // Not kept across a reload: its target game was only this visit's.
  await page.getByRole('button', { name: 'Sort list by similarity' }).click();
  await expect(page.getByRole('columnheader', { name: /Similarity/ })).toBeVisible();
  await page.reload();
  await expect(rows(page)).toHaveCount(6);
  await expect(page.getByRole('columnheader', { name: /Similarity/ })).toHaveCount(0);
  await expect.poll(names).toEqual(byRating);
});

test('F3 edge: Owned says which tags the account plays most, each filtering the list', async ({ page }) => {
  await asPlayer(page, ALICE);
  // 10 h on every game: Alice's own fixture has too few played games for a profile.
  await page.route('**/api/common-games', (route) => {
    const req = route.request();
    const body = JSON.parse(respond(req.method(), new URL(req.url()), req.postData()).body);
    for (const perPlayer of Object.values(body.playtime) as Record<string, number>[])
      for (const id of Object.keys(perPlayer)) perPlayer[id] = 600;
    return route.fulfill({ json: body });
  });
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  const note = page.locator('.profile');
  // Singleplayer: on fewer games, so rarer here than Action and Co-op.
  await expect(note.locator('.profile-bar-name')).toHaveText(['Singleplayer', 'Action', 'Co-op']);
  await expect(note.locator('.profile-bar').first()).toHaveAttribute('title', /· the top tag$/);

  const why = note.getByRole('button', { name: 'Why these?' });
  const games = note.locator('.profile-bar-games');
  await expect(games).toHaveCount(0);
  await why.click();
  await expect(why).toHaveAttribute('aria-expanded', 'true');
  // Under each tag, the played games counting most toward it.
  await expect(games.first().getByRole('button').first()).toContainText(/10h$/);
  await why.click();
  await expect(games).toHaveCount(0);

  const coop = note.getByRole('button', { name: /^Co-op \d+%$/ });
  await coop.click();
  await expect(rows(page)).toHaveCount(4);
  await expect(page.getByRole('columnheader', { name: /Tag match/ })).toBeVisible();
  await expect(coop).toHaveAttribute('aria-pressed', 'true');
});

test('A5: Favourite studios names the studios behind 2+ played games, each filtering Owned or opening its list', async ({
  page,
}, testInfo) => {
  await asPlayer(page, ALICE);
  await page.route('**/api/common-games', (route) => {
    const req = route.request();
    const body = JSON.parse(respond(req.method(), new URL(req.url()), req.postData()).body);
    for (const perPlayer of Object.values(body.playtime) as Record<string, number>[])
      for (const id of Object.keys(perPlayer)) perPlayer[id] = 600;
    return route.fulfill({ json: body });
  });
  await page.goto('/lists/owned?u=alice');
  await expect(rows(page)).toHaveCount(6);
  const tile = page.locator('.profile-creators');
  const developers = tile.getByRole('list', { name: 'Developers' });
  const publishers = tile.getByRole('list', { name: 'Publishers' });
  // Supergiant Games publishes its own game: shown once, as a developer; Feral publishes only one.
  if (testInfo.project.name === 'phone') {
    await expect(developers.getByRole('button').filter({ visible: true })).toHaveText(['Test Studio']);
  } else {
    await expect(developers.getByRole('button')).toHaveText(['Test Studio', 'Supergiant Games']);
  }
  await expect(publishers.getByRole('button')).toHaveText(['Test Publisher']);
  await expect(developers.getByRole('listitem').first()).toContainText('3 games');

  await page.locator('.profile').getByRole('button', { name: 'Why these?' }).click();
  const supergiant = developers.getByRole('listitem').nth(1);
  await expect(supergiant.locator('.profile-chip')).toHaveCount(2);

  const filter = supergiant.getByRole('button', { name: 'Supergiant Games', exact: true });
  await filter.click();
  await expect(rows(page)).toHaveCount(2);
  await expect(filter).toHaveAttribute('aria-pressed', 'true');
  await filter.click();
  await expect(rows(page)).toHaveCount(6);

  const link = supergiant.getByRole('link', { name: 'Games by Supergiant Games →' });
  await expect(link).toHaveAttribute('href', /[?&]u=alice/);
  await link.click();
  await expect(page).toHaveURL(/\/lists\/developer\?.*name=Supergiant\+Games/);
  await expect(page.locator('.list-hero-title')).toHaveText('Games by Supergiant Games');
  await page.goBack();
  await expect(page).toHaveURL(/\/lists\/owned/);
  await expect(tile).toBeVisible();
});

test('A5 edge: a profile too thin for an archetype or story tile shows neither, and no empty box', async ({ page }) => {
  await asPlayer(page, ALICE);
  // 10 h on all 6 of Alice's games: enough for Plays mostly and studios, not for a play style or story games.
  await page.route('**/api/common-games', (route) => {
    const req = route.request();
    const body = JSON.parse(respond(req.method(), new URL(req.url()), req.postData()).body);
    for (const perPlayer of Object.values(body.playtime) as Record<string, number>[])
      for (const id of Object.keys(perPlayer)) perPlayer[id] = 600;
    return route.fulfill({ json: body });
  });
  await page.goto('/lists/owned');
  const profile = page.locator('.profile');
  await expect(profile.getByRole('heading')).toHaveText('Plays mostly');
  // Only Favourite studios: Test Studio made 3 of the played games.
  await expect(profile.locator('.profile-tile')).toHaveCount(1);
  await expect(profile.locator('.profile-tile')).toHaveClass(/profile-creators/);
});

test('A5 edge: the profile stays on screen through a refresh that keeps every game', async ({ page }) => {
  await asPlayer(page, ALICE);
  // 10 h on each game: enough for Plays mostly.
  await page.route(/\/api\/common-games(\?refresh=1)?$/, (route) => {
    const req = route.request();
    const body = JSON.parse(respond(req.method(), new URL(req.url()), req.postData()).body);
    for (const perPlayer of Object.values(body.playtime) as Record<string, number>[])
      for (const id of Object.keys(perPlayer)) perPlayer[id] = 600;
    return route.fulfill({ json: body });
  });
  await page.goto('/lists/owned');
  await expect(page.locator('.profile').getByRole('heading')).toHaveText('Plays mostly');
  await page.evaluate(() => {
    const w = window as unknown as { profileGone: boolean };
    w.profileGone = false;
    new MutationObserver(() => {
      if (!document.querySelector('.profile')) w.profileGone = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.getByRole('button', { name: /^Updated\b/ }).click();
  await expect(page.locator('.list-stat', { hasText: 'Updated' })).not.toContainText('Refreshing');
  await expect(page.locator('.profile').getByRole('heading')).toHaveText('Plays mostly');
  expect(await page.evaluate(() => (window as unknown as { profileGone: boolean }).profileGone)).toBe(false);
});

test('A5 edge: the profile stays on screen while a refresh streams in a new game', async ({ page }) => {
  await asPlayer(page, ALICE);
  let refreshed = false;
  // 10 h on each game: enough for Plays mostly; the refresh adds Don't Starve Together (322330).
  await page.route(/\/api\/common-games(\?refresh=1)?$/, (route) => {
    const req = route.request();
    const body = JSON.parse(respond(req.method(), new URL(req.url()), req.postData()).body);
    if (refreshed) {
      body.games.push({ appid: 322330, name: "Don't Starve Together" });
      body.playtime[322330] = { [ALICE.steamid]: 0 };
    }
    for (const perPlayer of Object.values(body.playtime) as Record<string, number>[])
      for (const id of Object.keys(perPlayer)) perPlayer[id] = 600;
    return route.fulfill({ json: body });
  });
  await page.goto('/lists/owned');
  await expect(page.locator('.profile').getByRole('heading')).toHaveText('Plays mostly');
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/game-details/stream', async (route) => {
    await held;
    await route.fallback();
  });
  refreshed = true;
  await page.getByRole('button', { name: /^Updated\b/ }).click();
  await expect(page.locator('.list-status')).toContainText('6 / 7 games loaded');
  await expect(page.locator('.profile').getByRole('heading')).toHaveText('Plays mostly');
  release();
  await expect(rows(page)).toHaveCount(7);
  await expect(page.locator('.list-status')).not.toContainText('games loaded');
  await expect(page.locator('.profile').getByRole('heading')).toHaveText('Plays mostly');
});

test('A5.1-3: Plays mostly says what it is built from, leaving software out, and how the account plays', async ({
  page,
}) => {
  await asPlayer(page, DAVE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(DAVE.owned.length);
  const note = page.locator('.profile');
  // 15 played, minus Wallpaper Engine's 3000 h.
  await expect(note).toContainText('from 14 played games');
  await expect(note.locator('.profile-bar-name')).not.toContainText(['Utilities']);
  await expect(note.getByRole('heading')).toHaveText('Story finisher');
  // Sekiro and Hogwarts Legacy fell short; Dead Cells and Slay the Spire are endless.
  await expect(
    note.getByRole('img', { name: "7 of 9 story games played for their main story's length" }),
  ).toBeVisible();
  await note.getByRole('button', { name: 'Why these?' }).click();
  await note.getByText("How it's counted").click();
  await expect(note.locator('.profile-how')).toContainText('Story games: single-player');
});

test('A5.4: the barely-played count opens Play next, best Taste fit first, on a first visit', async ({ page }) => {
  await asPlayer(page, DAVE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(DAVE.owned.length);
  const backlog = page.getByRole('button', { name: 'Play next: 4 games played 2 h or less' }); // a preorder included
  await backlog.click();
  await expect(page).toHaveURL(/view=/);
  await expect(
    page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: 'Play next' }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(rows(page)).toHaveCount(4);
  await expect(backlog).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('columnheader', { name: /Taste fit/ })).toBeVisible();
  // Scored against the taste this visit just learned: nothing was stored before it.
  await expect(
    rows(page)
      .first()
      .getByRole('cell', { name: /^\d+%$/ }),
  ).toBeVisible();
  await backlog.click(); // back to All games, the view kept
  await expect(rows(page)).toHaveCount(DAVE.owned.length);
  await expect(page.getByRole('navigation', { name: 'Views' }).getByRole('link')).toHaveText([
    'All games',
    'Play next',
  ]);
});

test('A5 edge: Why these? lists the story games with their hours against the main story, each opening its panel', async ({
  page,
}) => {
  await asPlayer(page, DAVE);
  await page.goto('/lists/owned');
  await page.getByRole('button', { name: 'Why these?' }).click();
  const story = page.locator('.profile-story');
  const reached = story.locator('.profile-story-track.reached');
  // Capped, as a library may have hundreds: 5 of Dave's 7, most played first, then how many more.
  await expect(reached).toHaveCount(5);
  await expect(story.locator('.profile-more')).toHaveText('+2 more');
  await expect(story.locator('.profile-story-game').nth(5)).toContainText('Sekiro: Shadows Die Twice12 / 30 h');
  await expect(story.locator('.profile-story-game').nth(6)).toContainText('Hogwarts Legacy');
  await story.getByRole('button', { name: /^Hogwarts Legacy/ }).click();
  await expect(page.locator('#panel-title')).toHaveText('Hogwarts Legacy');
});

test('A5 edge: what to play next counts a preorder, which its Released date shows as upcoming', async ({ page }) => {
  await asPlayer(page, DAVE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(DAVE.owned.length);
  await page.getByRole('button', { name: 'Play next: 4 games played 2 h or less' }).click();
  await expect(rows(page)).toHaveCount(4); // a saved view can't hold "released by today"
  await expect(row(page, 'Someday Saga')).toHaveCount(1);
  await expect(row(page, 'Counter-Strike 2')).toHaveCount(1); // free, but playable now
});

test('F3 edge: a game marked Finished in its panel leaves Play next and its count, and stays marked', async ({
  page,
}) => {
  await asPlayer(page, DAVE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(DAVE.owned.length);
  await page.getByRole('button', { name: 'Play next: 4 games played 2 h or less' }).click();
  await expect(rows(page)).toHaveCount(4);
  await row(page, 'Counter-Strike 2').getByText('Counter-Strike 2').click();
  const status = page.locator('.game-panel').getByRole('combobox', { name: 'Status' });
  await status.selectOption('Finished');
  await expect(rows(page)).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Play next: 3 games played 2 h or less' })).toBeVisible();
  await page.reload();
  await expect(rows(page)).toHaveCount(3);
  await page.keyboard.press('Escape'); // the reload reopened the panel, over the page on a phone
  await page.getByRole('button', { name: 'Play next: 3 games played 2 h or less' }).click(); // back to All games
  await expect(row(page, 'Counter-Strike 2').getByRole('cell', { name: 'Finished' })).toHaveCount(0); // Status is hidden
  await row(page, 'Counter-Strike 2').getByText('Counter-Strike 2').click();
  await expect(status).toHaveValue('finished');
});

test("F3 edge: someone else's library from a link offers no status to set", async ({ page }) => {
  await asPlayer(page, DAVE);
  await page.goto(`/lists/owned?u=${ALICE.steamid}&game=620`);
  const panel = page.locator('.game-panel');
  await expect(panel.getByRole('link', { name: 'In library' })).toBeVisible();
  await expect(panel.getByRole('combobox', { name: 'Status' })).toHaveCount(0);
});

test('A5 edge: an account with no playtime at all says why it has no profile', async ({ page }) => {
  await asPlayer(page, BOB);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(BOB.owned.length);
  await expect(page.locator('.list-hero-note')).toHaveText(
    "No playtime to profile: it's private, or nothing was played yet.",
  );
  await expect(page.locator('.profile')).toHaveCount(0);
});

test("B2 edge: Taste fit scores the wishlist by the account's taste, once Owned has been opened", async ({ page }) => {
  await asPlayer(page, ALICE);
  // 10 h on every game, so Owned has enough played games to learn a taste from.
  await page.route('**/api/common-games', (route) => {
    const req = route.request();
    const body = JSON.parse(respond(req.method(), new URL(req.url()), req.postData()).body);
    for (const perPlayer of Object.values(body.playtime) as Record<string, number>[])
      for (const id of Object.keys(perPlayer)) perPlayer[id] = 600;
    return route.fulfill({ json: body });
  });
  const note = page.locator('.list-score-note');
  await page.goto('/lists/wishlist');
  await expect(rows(page).first()).toBeVisible();
  // No taste on this device yet: no column of "—", and no note about it.
  await expect(page.getByRole('columnheader', { name: /Taste fit/ })).toHaveCount(0);
  await expect(note).toHaveCount(0);

  await page.goto('/lists/owned');
  await expect(page.locator('.profile')).toBeVisible();
  await page.goto('/lists/wishlist');
  await expect(page.getByRole('columnheader', { name: /Taste fit/ })).toBeVisible();
  await expect(note).toHaveText(/^Taste fit: Alice's taste as of \d{4}-\d{2}-\d{2}$/);
  await expect(
    rows(page)
      .first()
      .getByRole('cell', { name: /^\d+%$/ }),
  ).toBeVisible();
});

test('B2 edge: Taste fit says an opened Owned has too few games played, and stays quiet on a link', async ({
  page,
}) => {
  // Alice's own fixture has too few played games for a profile.
  await asPlayer(page, ALICE);
  const note = page.locator('.list-score-note');
  await page.goto('/lists/owned');
  // Learned once every row's details are in.
  await expect
    .poll(() => page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('steam.isonoe.net:taste:'))))
    .toBe(true);
  await page.goto('/lists/wishlist');
  await expect(page.getByRole('columnheader', { name: /Taste fit/ })).toBeVisible();
  await expect(note).toHaveText('Taste fit: Alice has too few games played');
  await page.goto('/lists/wishlist?u=alice');
  await expect(rows(page)).toHaveCount(ALICE.wishlist!.length);
  await expect(note).toHaveText('Taste fit: Alice has too few games played');

  // Someone else's wishlist from a link: nothing for the viewer to open about the sender.
  await page.goto('/lists/wishlist?u=bob');
  await expect(rows(page)).toHaveCount(BOB.wishlist!.length);
  await expect(page.getByRole('columnheader', { name: /Taste fit/ })).toHaveCount(0);
  await expect(note).toHaveCount(0);

  // Once the viewer has opened that account's Owned here, its taste is on this device.
  await page.goto('/lists/owned?u=bob');
  await expect(rows(page)).toHaveCount(BOB.owned.length);
  await expect
    .poll(() => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('steam.isonoe.net:taste:'))))
    .toHaveLength(2);
  await page.goto('/lists/wishlist?u=bob');
  await expect(rows(page)).toHaveCount(BOB.wishlist!.length);
  await expect(note).toHaveText('Taste fit: Bob has too few games played');
});

test("B2 edge: a panel Refresh on Owned doesn't relearn its taste", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  const stored = () =>
    page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) => k.startsWith('steam.isonoe.net:taste:'));
      return key ? localStorage.getItem(key) : null;
    });
  await expect.poll(stored).not.toBeNull();
  const learned = await stored();

  await row(page, 'Hades').getByText('Hades').click();
  const refetch = page.waitForResponse((res) => /\/api\/game-details\/\d+\?refresh=1$/.test(res.url()));
  await page.getByRole('button', { name: 'Refresh details' }).click();
  await refetch;
  await expect(page.getByRole('button', { name: 'Refresh details' })).toBeEnabled();
  expect(await stored()).toBe(learned);
});

test("B2 edge: a link to my own ★ account still says to open its Owned, whoever's current", async ({ page }) => {
  await asPlayer(page, ALICE);
  // No current account: only the ★ one says the link is the viewer's own.
  await page.addInitScript(() => {
    const prefs = JSON.parse(localStorage.getItem('steam.isonoe.net:prefs')!);
    delete prefs.currentAccount;
    localStorage.setItem('steam.isonoe.net:prefs', JSON.stringify(prefs));
  });
  await page.goto('/lists/wishlist?u=alice');
  await expect(rows(page)).toHaveCount(ALICE.wishlist!.length);
  // Hidden with no taste here; shown from Columns, it says what to open.
  await expect(page.getByRole('columnheader', { name: /Taste fit/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Columns', exact: true }).click();
  await page
    .locator('.dt-dd')
    .getByRole('button', { name: /^Classification/ })
    .click();
  await page.locator('.dt-dd').getByRole('button', { name: 'Taste fit' }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.list-score-note')).toHaveText("Taste fit needs Alice's Owned list opened on this device");
});

test('C1 edge: Tag match averages the filtered tags, or with All takes the weakest', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.locator('.dt-filter-cols-search').fill('Tags');
  await page.locator('[data-filter-col-key="tags"]').click();
  await page.getByRole('checkbox', { name: 'Action', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Co-op', exact: true }).click();
  // Portal 2: Action 100%, Co-op 30%.
  await expect(row(page, 'Portal 2').getByRole('cell', { name: '65%' })).toBeVisible();
  const chip = page.locator('.dt-chip--filter', { hasText: 'Tags' });
  await expect(chip).toContainText('Action, Co-op');
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(row(page, 'Portal 2').getByRole('cell', { name: '30%' })).toBeVisible();
  // The chip tells All from Any.
  await expect(chip).toContainText('Action & Co-op');
});

test("C1 edge: a game looked up outside the list can't sort the list by similarity to it", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  await page.getByPlaceholder('Look up any game…').fill('apex');
  await page.getByRole('option', { name: /Apex Legends/ }).click();
  const similar = page.locator('#panel-section-similar');
  await expect(similar.locator('.panel-similar-item').first()).toBeVisible();
  await expect(similar.getByRole('button', { name: /Sort list by similarity/ })).toHaveCount(0);
});

test('C1 edge: a Tag match range keeps the games strongly tagged, and goes with the tag filter', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  const coop = page.locator('.panel-tags').getByRole('button', { name: 'Co-op, tag', exact: true });
  await row(page, 'Portal 2').getByText('Portal 2').click();
  await coop.click();
  await expect(rows(page)).toHaveCount(4);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.locator('.dt-filter-cols-search').fill('Tag match');
  await page.locator('[data-filter-col-key="tagMatch"]').click();
  await page.getByRole('textbox', { name: 'Tag match Min' }).fill('60');
  await expect(rows(page)).toHaveCount(3);
  await expect(row(page, 'Portal 2')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await row(page, 'Valheim').getByText('Valheim').click();
  await coop.click();
  await expect(rows(page)).toHaveCount(6);
});

test("C1 edge: a comparison's Group fit scores games for its least suited player", async ({ page }) => {
  await asPlayer(page, ALICE);
  // 10 h on every game: Alice gets a profile; Bob's 4 games stay too few for one.
  await page.route('**/api/common-games', (route) => {
    const req = route.request();
    const body = JSON.parse(respond(req.method(), new URL(req.url()), req.postData()).body);
    for (const perPlayer of Object.values(body.playtime) as Record<string, number>[])
      for (const id of Object.keys(perPlayer)) perPlayer[id] = 600;
    return route.fulfill({ json: body });
  });
  await page.goto('/lists/compare?u=alice&u=bob');
  await expect(page.getByRole('columnheader', { name: /Group fit/ })).toBeVisible();
  const fit = row(page, 'Valheim').locator('span[title^="Alice "]');
  await expect(fit).toHaveText(/^\d+% · Alice$/);
  await expect(fit).toHaveAttribute('title', /· Bob: too few games played to tell$/);
  // Said once, by Players (the status line says it where Players doesn't show).
  const players = await openPlayers(page);
  await expect(playerLine(players, 'Bob')).toContainText('too few games played here for a profile');
});

test('C6 edge: a comparison has a Played column per player', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/compare?u=alice&u=bob');
  await expect(row(page, 'Portal 2')).toBeVisible();
  const headers = await page.locator('thead th').allInnerTexts();
  const col = (name: string) => headers.findIndex((h) => h.includes(name));
  expect(col('Played (h) · Alice')).toBeGreaterThan(-1);
  expect(col('Played (h) · Bob')).toBeGreaterThan(-1);
  const portal = row(page, 'Portal 2').locator('td');
  await expect(portal.nth(col('Played (h) · Alice'))).toHaveText('10.0');
  await expect(portal.nth(col('Played (h) · Bob'))).toHaveText('—');
});

// A comparison's Players section, opened: it starts folded on a phone.
async function openPlayers(page: Page): Promise<Locator> {
  const players = page.locator('.list-players');
  await expect(players.locator('summary')).toBeVisible();
  if (!(await players.evaluate((d: HTMLDetailsElement) => d.open))) await players.locator('summary').click();
  return players;
}

const playerLine = (players: Locator, name: string) =>
  players.getByRole('listitem').filter({ has: players.page().locator('.list-players-name', { hasText: name }) });

test("C7.2: Players shows each player's top tags and archetype, open on desktop, folded on a phone", async ({
  page,
}, testInfo) => {
  await page.goto('/lists/compare?u=dave&u=erin');
  const players = page.locator('.list-players');
  await expect(players.locator('summary')).toHaveText('Players · Dave & Erin share 2 of their top 10 tags');
  const phone = testInfo.project.name === 'phone';
  await expect(players).toHaveJSProperty('open', !phone);
  if (phone) await players.locator('summary').click();
  const dave = playerLine(players, 'Dave');
  const erin = playerLine(players, 'Erin');
  // Each card names the player's archetype.
  await expect(dave).toContainText('Story finisher');
  await expect(erin).toContainText('Co-op crew');
  const pvp = erin.getByRole('button', { name: 'PvP' });
  await pvp.click();
  await expect(pvp).toHaveAttribute('aria-pressed', 'true');
  await expect(row(page, 'Dead by Daylight')).toBeVisible();
  await expect(row(page, 'The Witcher 3: Wild Hunt')).toHaveCount(0);
});

test('C1 edge: Players says what each player has been playing lately, each game opening its panel', async ({
  page,
}) => {
  await page.goto('/lists/compare?u=dave&u=erin');
  const players = await openPlayers(page);
  const lately = playerLine(players, 'Erin').locator('.players-card-lately');
  await expect(lately.getByRole('button')).toHaveText(["Tom Clancy's Rainbow Six Siege 6h", 'Deep Rock Galactic 1.5h']);
  await expect(playerLine(players, 'Dave').locator('.players-card-lately')).toHaveCount(0); // nothing lately: no line
  await lately.getByRole('button', { name: /^Deep Rock Galactic/ }).click();
  await expect(page.locator('#panel-title')).toHaveText('Deep Rock Galactic');
  // The same hours, per player, as a column to sort by.
  await page.keyboard.press('Escape'); // the panel covers the page on a phone
  await page.getByRole('button', { name: 'Columns', exact: true }).click();
  await page
    .locator('.dt-dd')
    .getByRole('button', { name: /^Play Time & Dates/ })
    .click();
  await page.locator('.dt-dd').getByRole('button', { name: 'Last 2 weeks (h) · Erin' }).click();
  await page.keyboard.press('Escape');
  await expect(row(page, 'Deep Rock Galactic').getByRole('cell', { name: '1.5', exact: true })).toBeVisible();
});

test('C7.3-4: Players says how many top tags each pair shares, which, and the favourites they have in common', async ({
  page,
}) => {
  await page.goto('/lists/compare?u=dave&u=erin');
  const players = await openPlayers(page);
  await expect(players.locator('summary')).toHaveText('Players · Dave & Erin share 2 of their top 10 tags');
  await expect(playerLine(players, 'Dave').getByRole('button')).toHaveText(['Open World', 'Story Rich', 'RPG']);
  const common = players.locator('.players-ground-body').first().locator('.players-card-tags');
  await expect(common.getByRole('button')).toHaveText(['Action', 'FPS']);
  await players.getByRole('button', { name: 'Terraria' }).click();
  await expect(page.locator('#panel-title')).toHaveText('Terraria');
});

test('C7.5-6: Suggest to a player what another played a lot, closest to their taste, then open it', async ({
  page,
}) => {
  await asPlayer(page, DAVE);
  await page.goto('/lists/compare?u=dave&u=erin');
  const players = await openPlayers(page);
  // My account is Dave: the picker starts on Erin.
  const to = players.getByLabel('Suggest to');
  await expect(to).toHaveValue('1');
  const first = players.locator('.list-players-suggestions .players-game').first();
  await expect(first).toHaveText(/^Deep Rock Galactic\s*Dave 120h · owns it$/);
  await to.selectOption({ label: 'Dave' });
  await expect(players.locator('.list-players-suggestions .players-game').first()).toContainText(
    "Erin 90h · doesn't own it",
  );
  await players.getByRole('button', { name: 'Valheim' }).click();
  await expect(page.locator('#panel-title')).toHaveText('Valheim');
});

test("C7 edge: a player's tag filters a table that comes into view, even under an open Players on a phone", async ({
  page,
}) => {
  await page.goto('/lists/compare?u=dave&u=erin');
  const players = await openPlayers(page);
  await playerLine(players, 'Erin').getByRole('button', { name: 'PvP' }).click();
  await expect(row(page, 'Dead by Daylight')).toBeInViewport();
});

test("C7 edge: each player's line names their own tags once, those everyone shares under In common", async ({
  page,
}) => {
  await page.goto('/lists/compare?u=dave&u=erin');
  const players = await openPlayers(page);
  await expect(playerLine(players, 'Erin').locator('.players-card-tags').getByRole('button')).toHaveText([
    'PvP',
    'Horror',
    'Co-op',
  ]);
  await expect(players).not.toContainText('more than');
  const common = players.locator('.players-ground-body').first().locator('.players-card-tags');
  await expect(common.getByRole('button')).toHaveText(['Action', 'FPS']);
});

test('C7 edge: Suggest to starts on a player it can suggest to, not one without a profile', async ({ page }) => {
  await page.goto('/lists/compare?u=alice&u=dave&u=erin');
  const players = await openPlayers(page);
  await expect(players.getByLabel('Suggest to')).toHaveValue('1'); // Dave: Alice has too few games played
  await expect(players.locator('.list-players-suggestions .players-game').first()).toBeVisible();
});

test('C7 edge: a player without a profile is said once, in Players while it is open', async ({ page }) => {
  await page.goto('/lists/compare?u=alice&u=dave&u=erin');
  const players = await openPlayers(page);
  await expect(players).toContainText('too few games played here for a profile');
  await expect(page.locator('.list-score-note')).toHaveCount(0);
  // Folded (a phone's default), the status line says it again.
  await players.locator('summary').click();
  await expect(page.locator('.list-score-note')).toContainText('Group fit leaves out Alice');
  // Intersect has no Players section: the status line says it.
  await page.goto('/lists/compare?u=alice&u=dave&u=erin&op=intersect');
  await expect(page.locator('.list-score-note')).toContainText('Group fit leaves out Alice');
});

test('C7 edge: a player whose top tags are all shared has none of their own, not In common again', async ({ page }) => {
  // Bob, as a copy of Erin's library and hours.
  await page.route('**/api/common-games', async (route) => {
    const req = route.request();
    const post = req.postData() ?? '';
    if (!post.includes(BOB.steamid) && !post.includes('"bob"')) return route.fallback();
    const asErin = post.replaceAll(BOB.steamid, ERIN.steamid).replaceAll('"bob"', '"erin"');
    const body = JSON.parse(
      respond(req.method(), new URL(req.url()), asErin).body.replaceAll(ERIN.steamid, BOB.steamid),
    );
    body.players[0].personaname = 'Bob';
    return route.fulfill({ json: body });
  });
  await page.goto('/lists/compare?u=bob&u=erin');
  const players = await openPlayers(page);
  await expect(playerLine(players, 'Bob').locator('.players-card-tags').getByRole('button')).toHaveCount(0);
  await expect(playerLine(players, 'Bob')).toContainText('no tags of their own');
});

test('C7 edge: Intersect offers to switch back, since tastes need whole libraries', async ({ page }) => {
  await page.goto('/lists/compare?u=dave&u=erin&op=intersect');
  await expect(rows(page)).toHaveCount(3);
  await page.getByRole('button', { name: 'Switch to Grouped by membership' }).click();
  await expect(page.locator('.list-players summary')).toHaveText('Players · Dave & Erin share 2 of their top 10 tags');
});

test('C7 edge: a player with too few games played says so', async ({ page }) => {
  await page.goto('/lists/compare?u=alice&u=dave');
  const players = await openPlayers(page);
  await expect(playerLine(players, 'Alice')).toContainText('too few games played here for a profile');
});

// The presentation window, which P opens.
async function startPresenting(page: Page) {
  const popup = page.waitForEvent('popup');
  await page.keyboard.press('p');
  return popup;
}

// Says something to the TV as the main window would (for what no control sends yet).
async function tellTv(page: Page, body: Record<string, unknown>) {
  await page.evaluate(
    ([name, body]) => {
      const main = sessionStorage.getItem('playshelf-presentation-main');
      const channel = new BroadcastChannel(name as string);
      channel.postMessage({ main, ...(body as object) });
      channel.close();
    },
    [PRESENTATION_CHANNEL, body] as const,
  );
}

// The media main sent the TV, in order (the TV's own log: `hookPresentation`).
async function sentOnAir(shown: Page) {
  return shown.evaluate(() =>
    (window as unknown as { presTest: PresTest }).presTest.heard
      .filter((m) => m.type === 'onAir')
      .map((m) => m.onAir as { appid: number; item: { shotId: string } }),
  );
}
// The lightbox's still drawn among all its game's media: not loading alone holds before they arrive.
async function stillShown(page: Page, status: string) {
  const lb = page.locator('#screenshot-lightbox');
  await expect(lb.locator('.lb-status')).toContainText(status);
  await expect(lb).not.toHaveClass(/lb--loading/);
}

async function sentShots(shown: Page) {
  return (await sentOnAir(shown)).map((m) => m.item.shotId);
}

// Keys pressed in one task, quicker than any settle delay: on the lightbox's surface, as the keyboard would.
async function stepsAtOnce(page: Page, keys: string[]) {
  await page.evaluate((keys) => {
    const surface = document.querySelector('#screenshot-lightbox .lb-surface')!;
    for (const key of keys)
      surface.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  }, keys);
}

async function lightboxShotId(page: Page) {
  return new URL(page.url()).searchParams.get('shot');
}

// What the TV last reported of its trailer.
async function lastPlayback(shown: Page) {
  return shown.evaluate(
    () => (window as unknown as { presTest: PresTest }).presTest.heard.findLast((m) => m.type === 'playback')?.playback,
  );
}

test('C8.1-4,7-8: the presentation window shows only what is presented, stays fullscreen, and stops from the nav', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await page.goto('/game/1145360');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  const shown = await startPresenting(page);
  await expect(shown.locator('.pres-caption-name')).toHaveText('Hades');
  const chip = page.getByRole('banner').locator('.present-chip');
  await expect(chip).toContainText('Hades');
  await shown.keyboard.press('f');
  await expect.poll(() => shown.evaluate(() => !!document.fullscreenElement)).toBe(true);

  await page.getByPlaceholder('Look up any game…').fill('Portal 2');
  await page.locator('.game-search-result', { hasText: 'Portal 2' }).first().click();
  await expect(page.locator('#panel-title')).toHaveText('Portal 2');
  await expect(shown.locator('.pres-caption-name')).toHaveText('Hades');

  await page.getByRole('button', { name: 'Present on second screen' }).click();
  await expect(shown.locator('.pres-caption-name')).toHaveText('Portal 2');
  await expect(chip).toContainText('Portal 2');
  expect(await shown.evaluate(() => !!document.fullscreenElement)).toBe(true);

  const closed = shown.waitForEvent('close');
  await chip.getByRole('button', { name: 'Stop presenting' }).click();
  await closed;
  await expect(chip).toBeHidden();
});

test('C8 edge: a desktop window narrowed while presenting keeps Present and the chip that stops it', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await page.setViewportSize({ width: 700, height: 800 });
  await page.goto('/game/1145360');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  await expect(page.getByRole('button', { name: 'Present on second screen' })).toBeVisible();
  const shown = await startPresenting(page);
  await page.keyboard.press('Escape'); // this narrow, the panel covers the nav, as everywhere in the app
  const chip = page.getByRole('banner').locator('.present-chip');
  await expect(chip).toBeVisible();
  // Compact: the item and the picture go first, Stop always stays.
  await expect(chip.locator('.present-chip-item')).toBeHidden();
  await expect(chip.locator('.present-chip-thumb')).toBeHidden();
  const closed = shown.waitForEvent('close');
  await chip.getByRole('button', { name: 'Stop presenting' }).click();
  await closed;
});

test('C8 edge: the TV survives a reload of the main window, and an occluded TV its throttled silence', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await page.clock.install(); // the main window's: its checks decide whether the TV is forgotten
  await hookPresentation(page, { occludable: true });
  await page.goto('/game/1145360');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  const shown = await startPresenting(page);
  const chip = page.getByRole('banner').locator('.present-chip');
  await expect(chip).toContainText('Hades');
  // The TV up first: one reloaded before it has what to show has nothing to tell the reloaded main window.
  await expect(shown.locator('.pres-caption-name')).toHaveText('Hades');
  // A reload says bye then main again: the TV stays.
  await page.reload();
  await expect(chip).toContainText('Hades');
  // Without the TV's handle (lost in the reload), main goes by its beats: an occluded TV beats about once a minute.
  await shown.evaluate(() => (window as unknown as { presTest: PresTest }).presTest.hide());
  await page.clock.runFor(60_000);
  await expect(chip).toContainText('Hades');
  await page.clock.runFor(120_000); // past 2.5 min of silence: gone after all
  await expect(chip).toBeHidden();
});

test('C8 edge: a blocked pop-up is announced', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await page.addInitScript(() => (window.open = () => null));
  await page.goto('/game/1145360');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  await page.keyboard.press('p');
  await expect(page.locator('[role="status"]', { hasText: 'Allow pop-ups for this site to present.' })).toBeAttached();
  await expect(page.getByRole('banner').locator('.present-chip')).toHaveCount(0);
});

test('C8.5: the nav chip plays, pauses, mutes and replays the TV, and shows how it goes', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await hookPresentation(page, { fakePlayback: true, neverActivated: true });
  await mockApi(page, { states: ['playable-trailers'] });
  await page.goto('/game/1145360');
  await page.getByRole('button', { name: 'Trailer 1 of 1' }).click();
  const shown = await startPresenting(page);
  const tv = shown.locator('video.pres-media');
  const chip = page.getByRole('group', { name: /^Presenting Hades, Trailer 1 of 1/ });
  await expect(chip).toContainText('Trailer 1 / 1');
  await expect(chip.locator('.present-chip-thumb')).toBeVisible();
  const status = page.locator('[role="status"]', { hasText: 'Presenting Hades, Trailer 1 of 1' });
  await expect(status).toBeAttached();

  await chip.getByRole('button', { name: 'Pause the TV' }).click();
  await expect.poll(() => tv.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await chip.getByRole('button', { name: 'Play on the TV' }).click();
  await expect.poll(() => tv.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);

  await chip.getByRole('button', { name: 'Mute the TV' }).click();
  await expect.poll(() => tv.evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
  // Unmuted before a click there, Chrome would pause it: the TV waits, and the chip says why.
  await chip.getByRole('button', { name: 'Unmute the TV' }).click();
  const waiting = chip.getByRole('button', { name: 'Unmute the TV' });
  await expect(waiting).toHaveAttribute('aria-disabled', 'true');
  await expect(waiting).toHaveAttribute('title', 'Click the TV for sound');
  await waiting.dispatchEvent('click'); // says why, sends nothing (Playwright won't press an aria-disabled button)
  await expect(page.locator('[role="status"]', { hasText: 'Click the TV for sound' })).toBeAttached();
  expect(await tv.evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
  await shown.locator('.pres').click();
  await expect(chip.getByRole('button', { name: 'Mute the TV' })).toBeVisible();

  // Ended (pause, then ended, as browsers do): replay from the chip.
  await tv.evaluate(async (v: HTMLVideoElement) => {
    v.pause();
    await new Promise((resolve) => setTimeout(resolve));
    Object.defineProperty(v, 'ended', { configurable: true, get: () => true });
    v.dispatchEvent(new Event('ended'));
  });
  await chip.getByRole('button', { name: 'Replay on the TV' }).click();
  await expect.poll(() => tv.evaluate((v: HTMLVideoElement) => v.currentTime === 0 && !v.paused)).toBe(true);
});

test("C8 edge: the host's mute holds from one media to the next on the TV", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await hookPresentation(page, { fakePlayback: true });
  await mockApi(page, { states: ['playable-trailers'] });
  await page.goto('/game/1145360');
  await page.getByRole('button', { name: 'Trailer 1 of 1' }).click();
  const shown = await startPresenting(page);
  await shown.locator('.pres').click(); // sound and fullscreen
  const chip = page.getByRole('group', { name: /^Presenting Hades/ });
  await chip.getByRole('button', { name: 'Mute the TV' }).click();
  const tv = shown.locator('video.pres-media');
  await expect.poll(() => tv.evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
  // A screenshot, then the trailer again: still muted.
  await page.getByRole('button', { name: 'Screenshot 1 of 3' }).click();
  await page.keyboard.press('p');
  await expect.poll(() => shown.locator('img.pres-media').getAttribute('src')).toContain('Screenshot%201');
  await page.getByRole('button', { name: 'Trailer 1 of 1' }).click();
  await page.keyboard.press('p');
  await expect.poll(() => tv.evaluate((v: HTMLVideoElement) => !v.hidden && !v.paused)).toBe(true);
  expect(await tv.evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
  await expect(chip.getByRole('button', { name: 'Unmute the TV' })).toBeVisible();
  // A click in the room doesn't undo it either.
  await shown.locator('.pres').click();
  expect(await tv.evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
});

test('C8 edge: Space and M on the focused chip pause and mute the TV, without scrolling the page', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await hookPresentation(page, { fakePlayback: true });
  await mockApi(page, { states: ['playable-trailers'] });
  await page.goto('/game/1145360');
  await page.getByRole('button', { name: 'Trailer 1 of 1' }).click();
  const shown = await startPresenting(page);
  const tv = shown.locator('video.pres-media');
  await expect.poll(() => tv.evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
  const chip = page.getByRole('group', { name: /^Presenting Hades/ });
  await chip.focus();
  const scroll = () => page.evaluate(() => [scrollY, document.querySelector('.app-scroll')?.scrollTop ?? 0]);
  const before = await scroll();
  await page.keyboard.press(' ');
  await expect.poll(() => tv.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  expect(await scroll()).toEqual(before);
  await page.keyboard.press('m');
  await expect.poll(() => tv.evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
});

test('C8 edge: P on what failed on the TV tries it again', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await mockApi(page, { states: ['slow-media'] });
  let broken = true;
  await page
    .context()
    .route('**/api/mock-media/**?full', (route) => (broken ? route.fulfill({ status: 500 }) : route.fallback()));
  await page.goto('/game/1145360');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  await page.getByRole('button', { name: 'Screenshot 1 of 3' }).click();
  const shown = await startPresenting(page);
  await expect(shown.getByRole('alert')).toBeVisible();
  broken = false;
  await page.keyboard.press('p');
  await expect(shown.getByRole('alert')).toHaveCount(0);
});

test('C8 edge: a picture the TV failed to load shows on the chip, which retries it', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await mockApi(page, { states: ['slow-media'] }); // media from /api/mock-media, so one can fail
  let broken = true;
  await page
    .context()
    .route('**/api/mock-media/**?full', (route) => (broken ? route.fulfill({ status: 500 }) : route.fallback()));
  await page.goto('/game/1145360');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  await page.getByRole('button', { name: 'Screenshot 1 of 3' }).click();
  const shown = await startPresenting(page);
  const chip = page.getByRole('group', { name: /^Presenting Hades/ });
  await expect(chip.getByRole('img', { name: "Couldn't load on the TV" })).toBeVisible();
  broken = false;
  await chip.getByRole('button', { name: 'Retry' }).click();
  await expect(shown.getByRole('alert')).toHaveCount(0);
  await expect(chip.locator('.present-chip-thumb')).toBeVisible();
});

test('C8 edge: P again on a picture the TV failed to load loads it, the spinner going', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await mockApi(page, { states: ['slow-media'] }); // media from /api/mock-media, so one can fail
  let broken = true;
  await page
    .context()
    .route('**/api/mock-media/**?full', (route) => (broken ? route.fulfill({ status: 500 }) : route.fallback()));
  await page.goto('/game/1145360');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  await page.getByRole('button', { name: 'Screenshot 1 of 3' }).click();
  const shown = await startPresenting(page);
  await expect(shown.getByRole('alert')).toBeVisible();
  broken = false;
  await page.keyboard.press('p');
  await expect(shown.getByRole('alert')).toHaveCount(0);
  await expect.poll(() => shown.locator('img.pres-media').getAttribute('src')).toContain('full');
  await expect(shown.locator('.pres')).not.toHaveClass(/pres--loading/);
});

test('C8 edge: the panel says which of its media is on the TV', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await page.goto('/game/1145360');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  await startPresenting(page);
  const onTv = page.getByRole('button', { name: 'On TV', exact: true });
  await expect(onTv).toHaveClass(/panel-present-btn--on/);
  await expect(page.locator('.panel-hero-present')).toHaveText('On TV');
  await page.getByRole('button', { name: 'Screenshot 1 of 3' }).click(); // another item, not presented
  await expect(page.getByRole('button', { name: 'Present on second screen' })).not.toHaveClass(/panel-present-btn--on/);
  await expect(page.locator('.panel-hero-present')).toHaveText('Present');
});

test("C8 edge: the keyboard's play/pause key pauses the TV's trailer from anywhere, and resumes it", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await hookPresentation(page, { fakePlayback: true, mediaKeys: true });
  await mockApi(page, { states: ['playable-trailers'] });
  await page.goto('/game/1145360');
  await page.getByRole('button', { name: 'Trailer 1 of 1' }).click();
  const shown = await startPresenting(page);
  const tv = shown.locator('video.pres-media');
  await expect.poll(() => tv.evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
  expect(await shown.evaluate(() => navigator.mediaSession.metadata?.title)).toBe('Hades');
  type Keys = { mediaKeys: Record<string, (() => void) | null> };
  const press = (key: string) => shown.evaluate((k) => (window as unknown as Keys).mediaKeys[k]!(), key);
  await press('pause');
  await expect.poll(() => tv.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await press('play'); // still the TV's through the pause
  await expect.poll(() => tv.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  // Ended: the keys go back to whatever else plays.
  await tv.evaluate((v: HTMLVideoElement) => v.dispatchEvent(new Event('ended')));
  await expect.poll(() => shown.evaluate(() => navigator.mediaSession.metadata)).toBeNull();
  expect(await shown.evaluate(() => (window as unknown as Keys).mediaKeys.play)).toBeNull();
  // Replayed: the TV's again.
  await tv.evaluate((v: HTMLVideoElement) => {
    v.currentTime = 90; // ended, for the chip too
    v.pause();
  });
  await page
    .getByRole('group', { name: /^Presenting Hades/ })
    .getByRole('button', { name: 'Replay on the TV' })
    .click();
  await expect.poll(() => shown.evaluate(() => navigator.mediaSession.metadata?.title)).toBe('Hades');
  await press('pause');
  await expect.poll(() => tv.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
});

test("C8 edge: the TV's lower third says the game and media a while, not on a mouse move; its title and labels too", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await page.goto('/game/1145360');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  const shown = await startPresenting(page);
  await page.clock.install(); // after the TV opens: its windows below run on it too
  const caption = shown.locator('.pres-caption');
  await expect(caption).toHaveClass(/pres-caption--on/);
  await expect(caption).toContainText('Cover');
  expect(await shown.title()).toBe('Hades — Playshelf presentation');
  await expect(shown.locator('img.pres-media')).toHaveAttribute('alt', 'Hades, Cover');
  await expect(caption).not.toHaveClass(/pres-caption--on/, { timeout: 7000 }); // a new game: 5 s
  await shown.mouse.move(200, 200);
  await shown.mouse.move(220, 220);
  await expect(shown.locator('.pres')).toHaveClass(/pres--awake/); // the cursor, only
  await page.clock.runFor(600);
  await expect(caption).not.toHaveClass(/pres-caption--on/);
  // Another media of the same game: 2 s.
  await page.getByRole('button', { name: 'Screenshot 1 of 3' }).click();
  await page.keyboard.press('p');
  await expect(caption).toHaveClass(/pres-caption--on/);
  await expect(caption).toContainText('Screenshot 1 / 3');
  await expect(caption).not.toHaveClass(/pres-caption--on/, { timeout: 3500 });
});

test('C8 edge: on the TV, Space and M play and mute a trailer; a stall spins, and stopping fades out', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await hookPresentation(page, { fakePlayback: true });
  await mockApi(page, { states: ['playable-trailers'] });
  await page.goto('/game/1145360');
  await page.getByRole('button', { name: 'Trailer 1 of 1' }).click();
  const shown = await startPresenting(page);
  const tv = shown.locator('video.pres-media');
  await shown.locator('.pres').click(); // the first click: fullscreen and sound
  await expect.poll(() => tv.evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
  await shown.keyboard.press(' ');
  await expect.poll(() => tv.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await shown.keyboard.press('m');
  await expect.poll(() => tv.evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
  await tv.evaluate((v: HTMLVideoElement) => v.dispatchEvent(new Event('waiting')));
  await expect(shown.locator('.pres')).toHaveClass(/pres--loading/);
  // Under reduced motion (the tests' default), the spinner stands still, still after a moment.
  expect(await shown.locator('.pres').evaluate((el) => getComputedStyle(el, '::after').animationName)).toBe(
    'pres-appear',
  );
  await shown.evaluate(() => {
    const w = window as unknown as { faded: boolean };
    new MutationObserver(
      () => (w.faded ||= document.querySelector('.pres')!.classList.contains('pres--closing')),
    ).observe(document.querySelector('.pres')!, { attributeFilter: ['class'] });
  });
  const closed = shown.waitForEvent('close');
  await page.getByRole('button', { name: 'Stop presenting Hades' }).click();
  // Read during its 400 ms fade, before it closes itself.
  expect(await shown.evaluate(() => (window as unknown as { faded: boolean }).faded)).toBe(true);
  await closed;
});

test('C8 edge: in forced colours, the TV keeps its black and its text takes the system colours', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await page.goto('/game/1145360');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  const shown = await startPresenting(page);
  await shown.emulateMedia({ forcedColors: 'active' });
  await expect(shown.locator('.pres')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  await expect(shown.locator('.pres-card')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0.7)');
});

for (const [permission, clicks] of [
  ['granted', 1],
  ['prompt', 2],
] as const) {
  test(`C8 edge: with a second screen and the permission ${permission}, the TV goes fullscreen on it in ${clicks} click(s), remembered`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
    await hookPresentation(page, { screens: { permission, count: 2 } });
    await page.goto('/game/1145360');
    await expect(page.locator('#panel-title')).toHaveText('Hades');
    const shown = await startPresenting(page);
    type Placed = { placed: { fullscreen: string[]; moves: number[][] } };
    const placed = () => shown.evaluate(() => (window as unknown as Placed).placed);
    const place = shown.locator('.pres-place');
    if (clicks === 2) {
      await place.click(); // asks the permission: that click's activation is spent on the prompt
      expect((await placed()).fullscreen).toEqual([]);
    }
    await expect(place).toHaveText('Fullscreen on “LG TV”');
    await place.click();
    expect(await placed()).toEqual({ fullscreen: ['LG TV'], moves: [[1920, 0]] });
    await expect(shown.locator('.pres-card')).toBeHidden();
    // Next time, the main window opens it there.
    await page.evaluate(() => {
      const w = window as unknown as { opens: string[] };
      w.opens = [];
      const open = window.open.bind(window);
      window.open = (url, name, features) => (w.opens.push(String(features)), open(url, name, features));
    });
    const closed = shown.waitForEvent('close');
    await page.getByRole('button', { name: 'Stop presenting Hades' }).click();
    await closed;
    await startPresenting(page);
    expect(await page.evaluate(() => (window as unknown as { opens: string[] }).opens)).toEqual([
      'popup,left=1920,top=0,width=1920,height=1080',
    ]);
  });
}

test("C8 edge: the TV's Place button is reached by Tab, which doesn't go fullscreen here; placing it gives sound", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await hookPresentation(page, {
    screens: { permission: 'granted', count: 2 },
    fakePlayback: true,
    neverActivated: true,
  });
  await mockApi(page, { states: ['playable-trailers'] });
  await page.goto('/game/1145360');
  await page.getByRole('button', { name: 'Trailer 1 of 1' }).click();
  const shown = await startPresenting(page);
  const chip = page.getByRole('group', { name: /^Presenting Hades/ });
  // Unmuted before any click there: the TV waits for one.
  await chip.getByRole('button', { name: 'Mute the TV' }).click();
  await chip.getByRole('button', { name: /Unmute the TV/ }).click();
  await expect(chip.locator('.present-chip-btn[title="Click the TV for sound"]')).toBeVisible();
  const place = shown.getByRole('button', { name: 'Fullscreen on “LG TV”' });
  await expect(place).toBeVisible();
  await shown.keyboard.press('Tab');
  await expect(place).toBeFocused();
  await shown.keyboard.press('Enter');
  expect(
    await shown.evaluate(() => (window as unknown as { placed: { fullscreen: string[] } }).placed.fullscreen),
  ).toEqual(['LG TV']);
  await expect(chip.getByRole('button', { name: 'Mute the TV' })).toBeVisible(); // sound: no click wanted any more
});

for (const [why, screens] of [
  ['the permission refused', { permission: 'denied', count: 2 }],
  ['one screen', { permission: 'granted', count: 1 }],
] as const) {
  test(`C8 edge: with ${why}, the TV offers no placing`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
    await hookPresentation(page, { screens });
    await page.goto('/game/1145360');
    await expect(page.locator('#panel-title')).toHaveText('Hades');
    const shown = await startPresenting(page);
    const place = shown.locator('.pres-place');
    if (screens.count > 1) {
      await expect(place).toHaveText('Place on the other screen');
      await place.click();
    }
    await expect(place).toBeHidden();
    await expect(shown.locator('.pres-card')).toHaveText('Click for fullscreen'); // the drag, then
  });
}

test("C8 edge: Ctrl+P is the browser's print, not P", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await page.goto('/game/1145360');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  const chip = page.getByRole('banner').locator('.present-chip');
  await page.keyboard.press('Control+p');
  expect(await chip.count()).toBe(0); // a snapshot: P would have shown it while handling the key
  const shown = await startPresenting(page);
  await expect(shown.locator('.pres-caption-name')).toHaveText('Hades');
});

test('C8 edge: closing the presentation window drops the nav chip', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await page.goto('/game/1145360');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  const shown = await startPresenting(page);
  await expect(shown.locator('.pres-caption-name')).toHaveText('Hades'); // mounted: its pagehide says bye
  const chip = page.getByRole('banner').locator('.present-chip');
  await expect(chip).toContainText('Hades');
  await shown.close();
  await expect(chip).toBeHidden(); // the 2 s bye grace, within expect's 5 s; heartbeats alone take 20 s
});

test('C8.6: while presenting, a media opened from the panel opens the lightbox on the TV, which follows its steps', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await hookPresentation(page, {});
  await page.goto('/game/1145360');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  const shown = await startPresenting(page);
  await page.clock.install(); // after the TV opens: its windows below run on it too
  await expect(shown.locator('.pres-caption-name')).toHaveText('Hades');
  await page.getByRole('button', { name: 'Screenshot 3 of 3' }).click();
  const picture = () => shown.locator('img.pres-media').getAttribute('src');
  expect(await picture()).toContain('header.jpg'); // browsing the panel moves nothing: still the Cover
  await page.getByRole('button', { name: 'Present this media' }).click();
  const lightbox = page.locator('#screenshot-lightbox');
  await expect(lightbox).toHaveAttribute('open');
  await expect.poll(picture).toContain('Screenshot%203');
  await expect(lightbox.locator('.lb-tv-toggle')).toHaveAccessibleName('On TV');
  await expect(lightbox.locator('.lb-status')).toHaveText(
    'Linked to the TV. On TV: Hades, game 1 of 1, Screenshot 3 of 3',
  );
  await page.keyboard.press('ArrowLeft');
  await expect.poll(picture).toContain('Screenshot%202');
  await expect(lightbox.locator('.lb-status')).toHaveText('On TV: Screenshot 2 of 3');
  // Said once, by the lightbox: the shell's own status line sits in the page the dialog makes inert.
  await expect(page.locator('[role="status"]', { hasText: 'Presenting Hades, Screenshot 2' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(lightbox).not.toHaveAttribute('open');
  await page.clock.runFor(300);
  expect(await picture()).toContain('Screenshot%202'); // the TV keeps it
  await expect(page.locator('.panel-hero-present')).toHaveText('On TV');
});

test('C8 edge: a burst of steps sends the TV its first at once and then only where it stops; Esc sends that at once', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await hookPresentation(page, {});
  await page.goto('/game/1145360?shot=s3');
  await expect(page.locator('#screenshot-lightbox')).toHaveAttribute('open');
  const shown = await startPresenting(page);
  await expect.poll(() => shown.locator('img.pres-media').getAttribute('src')).toContain('Screenshot%203');
  // Frozen, so a slow poll can't miss the burst's first before the settle sends its last.
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 60_000);
  await stepsAtOnce(page, ['ArrowLeft', 'ArrowLeft', 'ArrowLeft']);
  await expect.poll(() => sentShots(shown)).toEqual(['s3', 's2']); // the first, at once
  await page.clock.runFor(250); // past the settle
  await expect.poll(() => sentShots(shown)).toEqual(['s3', 's2', 'v1']);
  await page.clock.runFor(1000); // and nothing after
  expect(await sentShots(shown)).toEqual(['s3', 's2', 'v1']);
  await stepsAtOnce(page, ['ArrowRight', 'ArrowRight']);
  await page.keyboard.press('Escape'); // within the settle: the clock stands still
  await expect.poll(() => sentShots(shown)).toEqual(['s3', 's2', 'v1', 's1', 's2']);
});

test('C8 edge: game steps in the linked lightbox put each game on the TV once its media is in', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await hookPresentation(page, {});
  await asPlayer(page, ALICE, { recentGames: [620, 1145360, 105600] });
  const terrariaMedia = await gate(page, '**/api/game-meta/105600');
  await page.goto('/game/1145360?shot=s1');
  const lightbox = page.locator('#screenshot-lightbox');
  await expect(lightbox.locator('.lb-caption-text')).toHaveText('Hades');
  // P in a lightbox not presenting yet: presents, and the lightbox stays, now on the TV.
  const shown = await startPresenting(page);
  await page.clock.install(); // after the TV opens: its windows below run on it too
  await expect(lightbox).toHaveAttribute('open');
  await expect(shown.locator('.pres-caption-name')).toHaveText('Hades');
  // Every line said, as the TV may say something after (its fixture media doesn't load).
  await lightbox.locator('.lb-status').evaluate((el) => {
    const w = window as unknown as { said: string[] };
    w.said = [];
    new MutationObserver(() => w.said.push(el.textContent ?? '')).observe(el, { childList: true, characterData: true });
  });
  await terrariaMedia.requested; // Hades' neighbour's, held
  await page.keyboard.press('ArrowDown');
  await expect(lightbox.locator('.lb-caption-text')).toHaveText('Terraria');
  const terraria = async () => (await sentOnAir(shown)).filter((m) => m.appid === 105600);
  await page.clock.runFor(600); // past the settle
  expect(await terraria()).toEqual([]);
  terrariaMedia.release();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { said: string[] }).said.join('\n')))
    .toContain('On TV: Terraria, game 3 of 3');
  await page.clock.runFor(600); // and nothing after
  // One send, of what the lightbox landed on once the media came, not the Cover first.
  expect((await terraria()).map((m) => m.item.shotId)).toEqual([await lightboxShotId(page)]);
  expect(terrariaMedia.count).toBe(1);
  await page.keyboard.press('ArrowUp');
  await expect(shown.locator('.pres-caption-name')).toHaveText('Hades');
});

test('C8 edge: P in the linked lightbox keeps what follows private, sticking until P again', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await hookPresentation(page, {});
  await page.goto('/game/1145360?shot=s3');
  const lightbox = page.locator('#screenshot-lightbox');
  await expect(lightbox.locator('.lb-caption-text')).toHaveText('Hades'); // opened: P is now the lightbox's
  const shown = await startPresenting(page);
  await page.clock.install(); // after the TV opens: its windows below run on it too
  await expect.poll(() => sentShots(shown)).toEqual(['s3']);
  await expect(lightbox.locator('.lb-status')).toContainText('Linked to the TV');
  await page.keyboard.press('p');
  const pill = lightbox.locator('.lb-tv-toggle');
  await expect(pill).toHaveAccessibleName('Private · P to show');
  await expect(lightbox.locator('.lb-status')).toHaveText('Private, the TV keeps Hades');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Escape');
  // Reopened from the panel: still private, and nothing sent.
  await page.getByRole('button', { name: 'Open in lightbox' }).click();
  await expect(lightbox).toHaveAttribute('open');
  await expect(page.locator('.panel-hero-present')).toHaveText('Open');
  await page.clock.runFor(500);
  expect(await sentShots(shown)).toEqual(['s3']);
  // Its pill does as P: a click puts it back on the TV.
  await reachForControls(page);
  await pill.click();
  await expect(pill).toHaveAccessibleName('On TV');
  await expect.poll(() => sentShots(shown)).toEqual(['s3', 's2']);
});

test("C8 edge: stopping from the lightbox's pill, or losing the TV, leaves a plain lightbox", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await page.goto('/game/1145360?shot=s3');
  const lightbox = page.locator('#screenshot-lightbox');
  await expect(lightbox.locator('.lb-caption-text')).toHaveText('Hades'); // opened: P is now the lightbox's
  let shown = await startPresenting(page);
  await expect(shown.locator('.pres-caption-name')).toHaveText('Hades');
  await expect(lightbox.locator('.lb-status')).toContainText('Linked to the TV');
  const closed = shown.waitForEvent('close');
  await reachForControls(page);
  await lightbox.getByRole('button', { name: 'Stop presenting' }).click();
  await closed;
  await expect(lightbox).toHaveAttribute('open');
  await expect(lightbox.locator('.lb-tv')).toBeHidden();
  await expect(lightbox.locator('.lb-status')).toHaveText('Stopped presenting');
  shown = await startPresenting(page);
  await expect(shown.locator('.pres-caption-name')).toHaveText('Hades');
  await expect(lightbox.locator('.lb-tv')).toBeVisible();
  await shown.close();
  await expect(lightbox.locator('.lb-tv')).toBeHidden(); // the 2 s bye grace
  await expect(lightbox).toHaveAttribute('open');
  await expect(lightbox.locator('.lb-status')).toHaveText('Presentation window closed');
});

test('C8 edge: a trailer in the linked lightbox plays on the TV only; private, it waits for a press', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await fakePlayback(page);
  await hookPresentation(page, { fakePlayback: true });
  await mockApi(page, { states: ['playable-trailers'] });
  await page.goto('/game/1145360?shot=s1');
  const lightbox = page.locator('#screenshot-lightbox');
  await expect(lightbox.locator('.lb-caption-text')).toHaveText('Hades'); // opened: P is now the lightbox's
  const shown = await startPresenting(page);
  await page.clock.install(); // after the TV opens: its windows below run on it too
  await expect(shown.locator('.pres-caption-name')).toHaveText('Hades');
  await page.keyboard.press('ArrowLeft'); // the trailer
  await expect.poll(() => shown.locator('video.pres-media').evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
  await expect(lightbox.locator('video')).toHaveCount(0); // no second decoder, no second sound
  await expect(lightbox.locator('.lb-img')).toBeVisible();
  await page.keyboard.press('p'); // private: the local trailer is there, but not started
  await expect(lightbox.locator('video')).toHaveCount(1);
  await page.clock.runFor(300);
  expect(await lightbox.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await expect(lightbox.getByRole('button', { name: 'Play trailer' })).toBeVisible();
});

test('C8 edge: closing the main window closes the presentation', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await page.goto('/game/1145360');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  const shown = await startPresenting(page);
  await expect(shown.locator('.pres-caption-name')).toHaveText('Hades');
  const closed = shown.waitForEvent('close', { timeout: HEARTBEAT_MS + 3000 });
  await page.close();
  await closed;
});

test("C8 edge: a linked trailer's controls drive the TV, showing one state at a time", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await fakePlayback(page);
  await hookPresentation(page, { fakePlayback: true, neverActivated: true });
  await mockApi(page, { states: ['playable-trailers'] });
  await page.goto('/game/1145360?shot=v1');
  const lightbox = page.locator('#screenshot-lightbox');
  await expect(lightbox.locator('.lb-caption-text')).toHaveText('Hades'); // opened: P is now the lightbox's
  const shown = await startPresenting(page);
  const tv = shown.locator('video.pres-media');
  await expect.poll(() => tv.evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
  // One overlay at a time: failed > buffering > paused or ended > playing.
  const overlays = () =>
    lightbox.evaluate((lb) =>
      ['.lb-error', '.lb-bigplay', '.lb-tvplaying'].filter((sel) => {
        const el = lb.querySelector<HTMLElement>(sel)!;
        return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
      }),
    );
  await expect.poll(overlays).toEqual(['.lb-tvplaying']);
  await expect(lightbox.locator('.lb-tvplaying')).toHaveText('Playing on TV');

  await reachForControls(page);
  await lightbox.getByRole('button', { name: 'Pause the TV' }).click();
  await expect.poll(() => tv.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await expect.poll(overlays).toEqual(['.lb-bigplay']);
  await lightbox.getByRole('button', { name: 'Play trailer on the TV' }).click();
  await expect.poll(() => tv.evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);

  await reachForControls(page);
  await lightbox.getByRole('button', { name: 'Mute the TV' }).click();
  await expect.poll(() => tv.evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
  // Unmuted before a click there, the TV waits for one, and the lightbox says so.
  await lightbox.getByRole('button', { name: 'Unmute the TV' }).click();
  await expect(lightbox.locator('.lb-vc-mute')).toHaveAttribute('aria-disabled', 'true');
  await expect(lightbox.locator('.lb-unmute')).toHaveText('Click the TV for sound');
  await expect(lightbox.locator('.lb-status')).toContainText('Click the TV for sound');

  // Seeking: Shift+→ and L add up on the TV's own position.
  await tv.evaluate((v: HTMLVideoElement) => (v.currentTime = 30));
  await lightbox.locator('.lb-surface').focus();
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('l');
  await expect.poll(() => tv.evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(45);
  const scrub = lightbox.getByRole('slider', { name: 'Seek on the TV' });
  await scrub.focus();
  await page.keyboard.press('Home');
  await expect.poll(() => tv.evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(0);

  await shown.evaluate(() => (window as unknown as { presTest: PresTest }).presTest.stall());
  await expect(lightbox).toHaveClass(/lb--buffering/);
  await expect.poll(overlays).toEqual([]);
  await shown.evaluate(() => (window as unknown as { presTest: PresTest }).presTest.resume());
  await expect(lightbox).not.toHaveClass(/lb--buffering/);

  await tv.evaluate((v: HTMLVideoElement) => {
    v.currentTime = 90;
    v.pause();
    v.dispatchEvent(new Event('ended'));
  });
  await expect.poll(overlays).toEqual(['.lb-bigplay']);
  await lightbox.getByRole('button', { name: 'Replay on the TV' }).click();
  await expect.poll(() => tv.evaluate((v: HTMLVideoElement) => [v.currentTime, v.paused])).toEqual([0, false]);
});

test('C8 edge: what the TV fails to load the linked lightbox says, and retries', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await mockApi(page, { states: ['broken-trailer'] });
  await page.goto('/game/1145360?shot=s1');
  const lightbox = page.locator('#screenshot-lightbox');
  await expect(lightbox.locator('.lb-caption-text')).toHaveText('Hades'); // opened: P is now the lightbox's
  const shown = await startPresenting(page);
  await expect(shown.locator('.pres-caption-name')).toHaveText('Hades');
  await page.keyboard.press('ArrowLeft'); // the trailer, broken
  await expect(shown.getByRole('alert')).toHaveText("Couldn't load this video.");
  await expect(lightbox.getByRole('alert')).toContainText("Couldn't load on the TV");
  const retried = shown.evaluate(
    (name) =>
      new Promise((resolve) => {
        new BroadcastChannel(name).onmessage = (e) => e.data?.control === 'retry' && resolve(true);
      }),
    PRESENTATION_CHANNEL,
  );
  await lightbox.getByRole('button', { name: 'Retry' }).click();
  expect(await retried).toBe(true);
  // A step away: no failure that isn't this item's.
  await page.keyboard.press('ArrowRight');
  await expect(lightbox.getByRole('alert')).toBeHidden();
});

test('C8 edge: a linked trailer goes back to the lightbox paused where the TV was, and back to the TV where the host was', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await fakePlayback(page);
  await hookPresentation(page, { fakePlayback: true });
  await mockApi(page, { states: ['playable-trailers'] });
  await page.goto('/game/1145360?shot=v1');
  const lightbox = page.locator('#screenshot-lightbox');
  await expect(lightbox.locator('.lb-caption-text')).toHaveText('Hades'); // opened: P is now the lightbox's
  const shown = await startPresenting(page);
  await page.clock.install(); // after the TV opens: its windows below run on it too
  const tv = shown.locator('video.pres-media');
  await expect.poll(() => tv.evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
  await tv.evaluate((v: HTMLVideoElement) => (v.currentTime = 30));
  // Private: the local trailer waits for a press, from where the TV was.
  await page.keyboard.press('p');
  const local = lightbox.locator('video');
  await expect(local).toHaveCount(1);
  expect(await local.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await page.keyboard.press(' ');
  await expect
    .poll(() => local.evaluate((v: HTMLVideoElement) => [Math.round(v.currentTime), v.paused]))
    .toEqual([30, false]);
  // Back on the TV: it moves to where the host got to, the trailer already being on it.
  await local.evaluate((v: HTMLVideoElement) => (v.currentTime = 42));
  await page.keyboard.press('p');
  await expect.poll(() => tv.evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(42);
  await expect(local).toHaveCount(0);
  // The TV gone: no sound starting here by itself.
  await shown.close();
  await expect(lightbox.locator('.lb-tv')).toBeHidden();
  await expect(local).toHaveCount(1);
  await page.clock.runFor(300);
  expect(await local.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
});

test("C8 edge: the chip opens what's on the TV in the lightbox, steering it from that game, without sending it again", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await hookPresentation(page, {});
  await asPlayer(page, ALICE, { recentGames: [620, 1145360, 892970] });
  await page.goto('/game/1145360?shot=s1');
  const lightbox = page.locator('#screenshot-lightbox');
  await expect(lightbox.locator('.lb-caption-text')).toHaveText('Hades'); // opened: P is now the lightbox's
  const shown = await startPresenting(page);
  await page.clock.install(); // after the TV opens: its windows below run on it too
  await expect.poll(() => sentShots(shown)).toEqual(['s1']);
  await page.keyboard.press('Escape');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Home' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole('button', { name: "Open what's on the TV" }).click();
  await expect(lightbox.locator('.lb-caption-text')).toHaveText('Hades');
  await expect(lightbox.locator('.lb-tv-toggle')).toHaveAccessibleName('On TV');
  await page.clock.runFor(500);
  expect(await sentShots(shown)).toEqual(['s1']);
  await page.keyboard.press('ArrowDown');
  await expect(shown.locator('.pres-caption-name')).toHaveText('Valheim');
});

test("C8 edge: after a reload, the chip opens what's on the TV once its game's media are in", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await hookPresentation(page, {});
  await page.goto('/game/1145360?shot=s2');
  const lightbox = page.locator('#screenshot-lightbox');
  await expect(lightbox.locator('.lb-caption-text')).toHaveText('Hades'); // opened: P is now the lightbox's
  const shown = await startPresenting(page);
  await page.clock.install(); // after the TV opens: its windows below run on it too
  await expect.poll(() => sentShots(shown)).toEqual(['s2']);
  await page.keyboard.press('Escape');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Home' }).click();
  await expect(page).toHaveURL(/\/$/);
  const hadesMedia = await gate(page, '**/api/game-meta/1145360');
  await page.reload();
  await expect(page.getByRole('banner').locator('.present-chip')).toContainText('Hades');
  await page.getByRole('button', { name: "Open what's on the TV" }).click();
  await hadesMedia.requested;
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  await expect(lightbox).not.toHaveAttribute('open');
  hadesMedia.release();
  await expect(lightbox.locator('.lb-status')).toContainText('Screenshot 2 of 3');
  await expect(lightbox.locator('.lb-tv-toggle')).toHaveAccessibleName('On TV');
  await page.clock.runFor(500);
  expect(await sentShots(shown)).toEqual(['s2']);
});

test("C8 edge: a game step onto media that don't load puts its Cover on the TV", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await hookPresentation(page, {});
  await asPlayer(page, ALICE, { recentGames: [620, 1145360, 105600] });
  await page.route('**/api/game-meta/105600', (route) =>
    route.fulfill({ status: 502, json: { error: "Steam store didn't answer" } }),
  );
  await page.goto('/game/1145360?shot=s1');
  const lightbox = page.locator('#screenshot-lightbox');
  await expect(lightbox.locator('.lb-caption-text')).toHaveText('Hades');
  const shown = await startPresenting(page);
  await expect.poll(() => sentShots(shown)).toEqual(['s1']);
  await page.keyboard.press('ArrowDown');
  await expect(lightbox.locator('.lb-caption-text')).toHaveText('Terraria');
  await expect(shown.locator('.pres-caption-name')).toHaveText('Terraria');
  expect(await sentShots(shown)).toEqual(['s1', 'banner']);
});

test("C8 edge: keys pressed on the TV step it through the main window's lightbox, opening it if need be; private, they don't", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await hookPresentation(page, {});
  await page.clock.install();
  await page.goto('/game/1145360');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  await page.getByRole('button', { name: 'Screenshot 1 of 3' }).click();
  const shown = await startPresenting(page); // from the panel: no lightbox
  await expect.poll(() => sentShots(shown)).toEqual(['s1']);
  await shown.locator('.pres').click(); // its first click; then keys go on to the main window
  await shown.keyboard.press('ArrowRight');
  const lightbox = page.locator('#screenshot-lightbox');
  await expect(lightbox).toHaveAttribute('open');
  await expect.poll(() => sentShots(shown)).toEqual(['s1', 's2']);
  await page.keyboard.press('p'); // private
  await page.keyboard.press('Escape');
  await expect(lightbox).not.toHaveAttribute('open');
  await shown.keyboard.press('ArrowRight');
  await expect(shown.locator('.pres-caption')).toHaveClass(/pres-caption--on/); // the TV says what it still shows
  await page.clock.runFor(500);
  await expect(lightbox).not.toHaveAttribute('open');
  expect(await sentShots(shown)).toEqual(['s1', 's2']);
});

test('C8 edge: hidden behind a fullscreen TV, the main window sends a key held there once, on its release', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await hookPresentation(page, {});
  await page.goto('/game/1145360?shot=s3');
  const lightbox = page.locator('#screenshot-lightbox');
  await expect(lightbox.locator('.lb-caption-text')).toHaveText('Hades'); // opened: P is now the lightbox's
  const shown = await startPresenting(page);
  await expect.poll(() => sentShots(shown)).toEqual(['s3']);
  await shown.locator('.pres').click();
  // Hidden, its timers throttled: frozen here, so only the release can send it.
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 60_000);
  await page.evaluate(() =>
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }),
  );
  for (let i = 0; i < 3; i++) await shown.keyboard.down('ArrowLeft');
  await shown.keyboard.up('ArrowLeft');
  await expect.poll(() => sentShots(shown)).toEqual(['s3', 's2', 'v1']); // the first at once, then on release
  await page.clock.runFor(300);
  expect(await sentShots(shown)).toEqual(['s3', 's2', 'v1']);
});

test('C8 edge: private, a trailer played here stops when a step lands on another, which waits for its own press', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await fakePlayback(page);
  await hookPresentation(page, { fakePlayback: true });
  await mockApi(page, { states: ['playable-trailers'] });
  await asPlayer(page, ALICE, { recentGames: [1145360, 105600] });
  await page.goto('/game/1145360?shot=v1');
  const lightbox = page.locator('#screenshot-lightbox');
  await expect(lightbox.locator('.lb-caption-text')).toHaveText('Hades'); // opened: P is now the lightbox's
  const shown = await startPresenting(page);
  await expect(shown.locator('.pres-caption-name')).toHaveText('Hades');
  await page.keyboard.press('p'); // private
  const local = lightbox.locator('video');
  await page.keyboard.press(' ');
  await expect.poll(() => local.evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
  await page.keyboard.press('ArrowDown'); // Terraria, landing on its trailer
  await expect(lightbox.locator('.lb-caption-text')).toHaveText('Terraria');
  await expect.poll(() => local.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  expect(await local.evaluate((v: HTMLVideoElement) => v.getAttribute('src'))).toBeNull(); // unloaded
  await page.keyboard.press(' ');
  await expect
    .poll(() => local.evaluate((v: HTMLVideoElement) => v.currentSrc || v.getAttribute('src')))
    .toContain('105600');
});

test("C8 edge: a linked trailer's scrubber seeks the TV once when let go; a cancelled drag sends nothing and lets the TV's time back", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await fakePlayback(page);
  await hookPresentation(page, { fakePlayback: true });
  await mockApi(page, { states: ['playable-trailers'] });
  await page.goto('/game/1145360?shot=v1');
  const lightbox = page.locator('#screenshot-lightbox');
  await expect(lightbox.locator('.lb-caption-text')).toHaveText('Hades'); // opened: P is now the lightbox's
  const shown = await startPresenting(page);
  const tv = shown.locator('video.pres-media');
  await expect.poll(() => tv.evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
  await reachForControls(page);
  const scrub = lightbox.getByRole('slider', { name: 'Seek on the TV' });
  const box = await visibleBox(scrub);
  const seeks = () =>
    shown.evaluate(
      () =>
        (window as unknown as { presTest: PresTest }).presTest.heard.filter(
          (m) => (m.control as { seekTo?: number })?.seekTo != null,
        ).length,
    );
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => tv.evaluate((v: HTMLVideoElement) => Math.round(v.currentTime / 9))).toBe(5); // ≈ 45 s of 90
  expect(await seeks()).toBe(1);
  await scrub.dispatchEvent('pointerdown');
  await scrub.dispatchEvent('pointercancel');
  await tv.evaluate((v: HTMLVideoElement) => (v.currentTime = 72)); // reported at once (seeked)
  await expect.poll(() => scrub.evaluate((el: HTMLInputElement) => Math.round(Number(el.value) * 10))).toBe(8);
  expect(await seeks()).toBe(1);
});

test('C8 edge: P in the lightbox presents its media and keeps the lightbox, now on the TV', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  // A second present() in the same keydown (the panel's own P, once the lightbox closed) would send it the media.
  await page.addInitScript(() => {
    const w = window as unknown as { posts: number; postsAtKey: number[] };
    w.posts = 0;
    w.postsAtKey = [];
    const post = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (this: BroadcastChannel, msg: { type?: string }) {
      if (msg?.type === 'onAir') w.posts++;
      return post.call(this, msg);
    };
    addEventListener('keydown', () => setTimeout(() => w.postsAtKey.push(w.posts)), true); // once dispatched
  });
  await page.goto('/game/1145360');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  await page.getByRole('button', { name: 'Screenshot 3 of 3' }).click();
  await page.getByRole('button', { name: 'Open in lightbox' }).click();
  const lightbox = page.locator('#screenshot-lightbox');
  await expect(lightbox).toHaveAttribute('open');
  let popups = 0;
  page.on('popup', () => popups++);
  const popup = page.waitForEvent('popup', { timeout: 3000 });
  await page.keyboard.press('p');
  const shown = await popup;
  await expect.poll(() => shown.locator('img.pres-media').getAttribute('src')).toContain('Screenshot%203');
  await expect(lightbox).toHaveAttribute('open');
  await expect(lightbox.locator('.lb-tv-toggle')).toHaveAccessibleName('On TV');
  await expect(page.getByRole('banner').locator('.present-chip')).toContainText('Hades');
  expect(popups).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { postsAtKey: number[] }).postsAtKey)).toEqual([0]);
});

test("C8 edge: a trailer the browser won't play with sound there says a click gives it; the next media cross-fades in", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await hookPresentation(page, { fakePlayback: true, refusedSound: true });
  await mockApi(page, { states: ['playable-trailers'] });
  await page.goto('/game/1145360');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  await page.getByRole('button', { name: 'Trailer 1 of 1' }).click();
  const shown = await startPresenting(page);
  const card = shown.locator('.pres-card');
  await expect(card).toHaveText('Click for fullscreen and sound');
  await expect(card).toHaveCSS('background-color', 'rgba(0, 0, 0, 0.7)'); // the TV's glass, darker than the lightbox's
  await shown.locator('.pres').click();
  await expect(card).toBeHidden();
  await expect(shown.getByText('Click for sound')).toBeHidden();
  expect(await shown.locator('video.pres-media').evaluate((v: HTMLVideoElement) => v.muted)).toBe(false);
  // The trailer fades out over the screenshot presented next (1 ms here, under reduced motion).
  await shown.evaluate(() => {
    const w = window as unknown as { ghosts: number };
    w.ghosts = 0;
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes) if ((n as Element).classList?.contains('pres-ghost')) w.ghosts++;
    }).observe(document.querySelector('.pres')!, { childList: true });
  });
  await page.getByRole('button', { name: 'Screenshot 1 of 3' }).click();
  await page.keyboard.press('p');
  await expect.poll(() => shown.evaluate(() => (window as unknown as { ghosts: number }).ghosts)).toBe(1);
  await expect(shown.locator('.pres-ghost')).toHaveCount(0);
  await expect.poll(() => shown.locator('img.pres-media').getAttribute('src')).toContain('Screenshot%201');
});

test('C8 edge: the tokens shared with the TV leave the app as it was', async ({ page }) => {
  await page.goto('/game/1145360?shot=s1');
  await expect(page.locator('#screenshot-lightbox')).toHaveAttribute('open');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(15, 20, 32)'); // --bg
  await expect(page.locator('.lb-close')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0.55)'); // --glass-bg
  await expect(page.locator('.lb-close')).toHaveCSS('backdrop-filter', 'blur(12px) saturate(1.4)');
});

test('C8 edge: before its first click, the TV says what a click does; then never again', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await page.goto('/game/1145360');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  const shown = await startPresenting(page);
  const card = shown.locator('.pres-card');
  await expect(card).toHaveText('Click for fullscreen'); // a screenshot: no sound to give
  await shown.locator('.pres').click();
  await expect(card).toBeHidden();
  await page.getByRole('button', { name: 'Screenshot 1 of 3' }).click();
  await page.keyboard.press('p');
  await expect.poll(() => shown.locator('img.pres-media').getAttribute('src')).toContain('Screenshot%201');
  await expect(card).toBeHidden();
});

test('C8 edge: a trailer the browser lets play with sound starts with it, no pill', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await hookPresentation(page, { fakePlayback: true });
  await mockApi(page, { states: ['playable-trailers'] });
  await page.goto('/game/1145360');
  await page.getByRole('button', { name: 'Trailer 1 of 1' }).click();
  const shown = await startPresenting(page);
  const video = shown.locator('video.pres-media');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
  expect(await video.evaluate((v: HTMLVideoElement) => v.muted)).toBe(false);
  await expect(shown.getByText('Click for sound')).toBeHidden();
});

test('C8 edge: a click on the TV enters fullscreen, and no later click leaves it; F and double-click do', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await page.goto('/game/1145360');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  const shown = await startPresenting(page);
  await page.clock.install(); // after the TV opens: its windows below run on it too
  await expect(shown.locator('.pres-caption-name')).toHaveText('Hades');
  const fullscreen = () => shown.evaluate(() => !!document.fullscreenElement);
  // A double-click as the first: its second half doesn't undo the first's fullscreen.
  await shown.locator('.pres').dblclick();
  await expect.poll(fullscreen).toBe(true);
  await page.clock.runFor(600);
  await shown.locator('.pres').click(); // someone in the room
  await page.clock.runFor(200);
  expect(await fullscreen()).toBe(true);
  await shown.keyboard.press('Control+f'); // the browser's find
  await page.clock.runFor(200);
  expect(await fullscreen()).toBe(true);
  await shown.keyboard.press('f');
  await expect.poll(fullscreen).toBe(false);
  await shown.locator('.pres').dblclick();
  await expect.poll(fullscreen).toBe(true);
});

test("C8 edge: P on what's already up doesn't restart it; on an ended trailer, it does", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await hookPresentation(page, { fakePlayback: true });
  await mockApi(page, { states: ['playable-trailers'] });
  await page.goto('/game/1145360');
  await page.getByRole('button', { name: 'Trailer 1 of 1' }).click();
  const shown = await startPresenting(page);
  await page.clock.install(); // after the TV opens: its windows below run on it too
  const video = shown.locator('video.pres-media');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
  await video.evaluate((v: HTMLVideoElement) => {
    const w = window as unknown as { plays: number; ghosts: number };
    w.plays = w.ghosts = 0;
    v.addEventListener('play', () => w.plays++);
    new MutationObserver(() => w.ghosts++).observe(document.querySelector('.pres')!, { childList: true });
    v.currentTime = 30;
  });
  const seen = () =>
    shown.evaluate(() => {
      const { plays, ghosts } = window as unknown as { plays: number; ghosts: number };
      return { plays, ghosts };
    });
  await page.keyboard.press('p');
  await page.clock.runFor(300);
  expect(await seen()).toEqual({ plays: 0, ghosts: 0 });
  expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(30);
  await video.evaluate((v: HTMLVideoElement) => {
    v.pause();
    Object.defineProperty(v, 'ended', { get: () => true });
  });
  await page.keyboard.press('p');
  await expect.poll(async () => (await seen()).plays).toBe(1);
});

test('C8 edge: P on a lightbox trailer carries on where it was on the TV', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await fakePlayback(page);
  await hookPresentation(page, { fakePlayback: true });
  await mockApi(page, { states: ['playable-trailers'] });
  await page.goto('/game/1145360?shot=v1');
  await expect(page.locator('#screenshot-lightbox')).toHaveAttribute('open');
  // Played to 0:42 (the fake stream errors in the lightbox, whose card would cover its play button).
  await page.locator('#screenshot-lightbox .lb-video').evaluate((v: HTMLVideoElement) => {
    v.currentTime = 42;
    return v.play();
  });
  const shown = await startPresenting(page);
  const video = shown.locator('video.pres-media');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(42);
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
});

test('C8 edge: the TV seeks where it is told and reports seeks and stalls at once', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await hookPresentation(page, { fakePlayback: true });
  await mockApi(page, { states: ['playable-trailers'] });
  await page.goto('/game/1145360');
  await page.getByRole('button', { name: 'Trailer 1 of 1' }).click();
  const shown = await startPresenting(page);
  const video = shown.locator('video.pres-media');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
  await video.evaluate((v: HTMLVideoElement) => (v.currentTime = 30));
  // Presses add up on the TV's own position, not on a report main may not have yet.
  await tellTv(page, { type: 'control', control: { seekBy: 10 } });
  await tellTv(page, { type: 'control', control: { seekBy: 10 } });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(50);
  await tellTv(page, { type: 'control', control: { seekTo: 5 } });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(5);
  // Within the 1 s the time reports wait: the seek's own report.
  await expect.poll(() => lastPlayback(shown)).toMatchObject({ t: 5 });
  await shown.evaluate(() => (window as unknown as { presTest: PresTest }).presTest.stall());
  await expect.poll(() => lastPlayback(shown)).toMatchObject({ buffering: true });
  await shown.evaluate(() => (window as unknown as { presTest: PresTest }).presTest.resume());
  await expect.poll(() => lastPlayback(shown)).toMatchObject({ buffering: false });
});

test('C8 edge: a handover on the trailer already on the TV moves it there', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await hookPresentation(page, { fakePlayback: true });
  await mockApi(page, { states: ['playable-trailers'] });
  await page.goto('/game/1145360');
  await page.getByRole('button', { name: 'Trailer 1 of 1' }).click();
  const shown = await startPresenting(page);
  const video = shown.locator('video.pres-media');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
  const onAir = await shown.evaluate(
    () => (window as unknown as { presTest: PresTest }).presTest.heard.findLast((m) => m.type === 'state')!.onAir,
  );
  await tellTv(page, { type: 'onAir', onAir: { ...(onAir as object), startAt: 42, paused: true } });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => [v.currentTime, v.paused])).toEqual([42, true]);
});

test("C8 edge: a screenshot whose thumbnail is broken but picture loads isn't called broken", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await mockApi(page, { states: ['slow-media'] }); // media served from /api/mock-media, so a thumbnail can fail alone
  await page.context().route('**/api/mock-media/**?thumb', (route) => route.fulfill({ status: 404 }));
  await page.goto('/game/1145360');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  await page.getByRole('button', { name: 'Screenshot 1 of 3' }).click();
  const shown = await startPresenting(page);
  await expect.poll(() => shown.locator('img.pres-media').getAttribute('src')).toContain('full');
  await expect(shown.getByRole('alert')).toHaveCount(0);
});

test('C8 edge: a trailer that fails to load says so on the presentation', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'a second screen is a desktop setup');
  await mockApi(page, { states: ['broken-trailer'] });
  await page.goto('/game/1145360');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  await page.getByRole('button', { name: 'Trailer 1 of 1' }).click();
  const shown = await startPresenting(page);
  const error = shown.getByRole('alert');
  await expect(error).toHaveText("Couldn't load this video.");
  await page.getByRole('button', { name: 'Screenshot 1 of 3' }).click();
  await page.keyboard.press('p');
  await expect.poll(() => shown.locator('img.pres-media').getAttribute('src')).toContain('Screenshot%201');
  await expect(error).toBeHidden();
});

test('C1.4: compare three players — one table grouped from "all" to "only one"', async ({ page }) => {
  await page.goto('/lists/compare?u=alice&u=bob&u=carol');
  await expect(groupRows(page)).toHaveCount(6);
  const labels = await groupRows(page).allInnerTexts();
  expect(labels.map((l) => l.replace(/\s+/g, ' '))).toEqual([
    expect.stringContaining('All 3'),
    expect.stringContaining('Alice + Bob — not Carol'),
    expect.stringContaining('Bob + Carol — not Alice'),
    expect.stringContaining('Only Alice'),
    expect.stringContaining('Only Bob'),
    expect.stringContaining('Only Carol'),
  ]);
  // One toolbar, and the comparison lives in the URL alone (nothing stored as "my" account).
  await expect(page.getByRole('button', { name: 'Columns' })).toHaveCount(1);
  expect(await page.evaluate(() => localStorage.getItem('steam.isonoe.net:prefs') ?? '')).not.toContain(
    'currentAccount',
  );
});

test("C1 edge: the account's ungrouped comparison layout keeps the comparison grouped, unchanged", async ({ page }) => {
  await mockApi(page, { states: ['signed-in'] });
  // The account's saved comparison layout, with the grouping removed: adopted, then reloaded.
  const now = Date.now();
  const compareListView = { value: { groupBy: [], sorts: [{ key: 'name', dir: 'asc' }] }, updatedAt: now };
  const prefs = { ...signedInPrefs(now), compareListView };
  await page.route('**/api/me', (route) => route.fulfill({ json: { steamid: SIGNED_IN.steamid, prefs } }));
  await page.goto('/lists/compare?u=alice&u=bob');
  // The saved name sort applies (the default sorts by rating)…
  await expect(page.getByRole('columnheader', { name: /^Name/ })).toHaveAttribute('aria-sort', 'ascending');
  await expect(groupRows(page)).toHaveCount(3); // …but the comparison stays grouped
  await expect(page.locator('.pref-unsaved-banner')).toHaveCount(0); // and nobody changed anything
});

test('L3 edge: a table change waits for Save, survives a reload in the tab, and Discard drops it', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  const header = page.locator('.dt-th[data-col-key="releaseDate"]');
  await header.locator('.dt-th-sort').click();
  const banner = page.locator('.pref-unsaved-banner');
  await expect(banner).toContainText('Unsaved changes to your Owned layout (Sort)');
  const stored = () => page.evaluate(() => localStorage.getItem('steam.isonoe.net:prefs') ?? '');
  expect(await stored()).not.toContain('releaseDate');
  await page.reload();
  await expect(header).toHaveAttribute('aria-sort', /ascending|descending/);
  await expect(banner).toContainText('Unsaved changes to your Owned layout (Sort)');
  await banner.getByRole('button', { name: 'Discard' }).click();
  await expect(header).not.toHaveAttribute('aria-sort', /ascending|descending/);
  await expect(banner).toHaveCount(0);

  await header.locator('.dt-th-sort').click();
  await banner.getByRole('button', { name: 'Save' }).click();
  await expect(banner).toHaveCount(0);
  expect(await stored()).toContain('releaseDate');
});

test('Y1 edge: signed in, a saved table layout syncs, without page or search, and only on Save', async ({ page }) => {
  await mockApi(page, { states: ['signed-in'] });
  // An account with no prefs: nothing to adopt, so no reload under the typing.
  await page.route('**/api/me', (route) => route.fulfill({ json: { steamid: SIGNED_IN.steamid, prefs: {} } }));
  const pushed: unknown[] = [];
  await page.route('**/api/me/prefs/bundlesBrowseView', async (route) => {
    pushed.push(route.request().postDataJSON().value);
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/bundles');
  await page.locator('.dt-search-input').fill('humble');
  await page.locator('.list-stat-btn[aria-pressed="false"]').first().click();
  const banner = page.locator('.pref-unsaved-banner');
  await expect(banner).toContainText('Unsaved changes to your bundles layout');
  expect(pushed).toEqual([]);
  await banner.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => pushed.length).toBe(1);
  expect(pushed[0]).not.toHaveProperty('searchQuery');
  expect(pushed[0]).not.toHaveProperty('page');
});

test('C1 edge: my account comes first, is prefilled, and only once', async ({ page }) => {
  await asPlayer(page, BOB); // Bob's steamid sorts after Alice's
  await page.goto('/lists/compare?u=alice&u=bob');
  await expect(page.getByRole('heading', { name: 'Bob vs. Alice' })).toBeVisible();

  await page.goto('/lists/compare?u=bob&u=bob');
  await expect(page.getByRole('main')).toContainText('Bob is in two player boxes');

  await page.goto('/lists/compare');
  await expect(page.locator('.compare-form')).toContainText('Bob');
});

test('C1 edge: the comparison states its mode once, in its select', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/compare?u=alice&u=bob');
  await expect(page.getByRole('heading', { name: 'Alice vs. Bob' })).toBeVisible();
  await expect(page.getByLabel("How to combine these players' libraries")).toHaveValue('group-by-membership');
  await expect(page.locator('.list-hero-chip', { hasText: 'Grouped by membership' })).toHaveCount(0);
});

test('C3 edge: a saved comparison keeps the name its page had', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/compare?u=alice&u=bob');
  await expect(page.getByRole('heading', { name: 'Alice vs. Bob' })).toBeVisible();
  const more = page.getByRole('button', { name: 'More actions' }); // a phone folds Save behind More actions
  if (await more.isVisible()) await more.click();
  await page.getByRole('button', { name: 'Save as a list' }).click();
  await expect(page).toHaveURL(/\/lists\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Alice vs. Bob' })).toBeVisible();
});

test('C3 edge: a saved comparison offers Share list only, not a Share view that only opens here', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/compare?u=alice&u=bob');
  await expect(groupRows(page)).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Share view' })).toHaveCount(1);
  const more = page.getByRole('button', { name: 'More actions' }); // a phone folds Save behind More actions
  if (await more.isVisible()) await more.click();
  await page.getByRole('button', { name: 'Save as a list' }).click();
  await expect(page).toHaveURL(/\/lists\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('button', { name: /Share list/ })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Default view' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share view' })).toHaveCount(0);
});

test('C3 edge: Save as a list moves focus into the saved list, not to the page', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/compare?u=alice&u=bob');
  await expect(groupRows(page)).toHaveCount(3);
  const more = page.getByRole('button', { name: 'More actions' }); // a phone folds Save behind More actions
  if (await more.isVisible()) await more.click();
  await page.getByRole('button', { name: 'Save as a list' }).click();
  await expect(page).toHaveURL(/\/lists\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('main')).toBeFocused();
});

test('C1 edge: Add player focuses the player box it adds', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/compare');
  await page.getByRole('button', { name: 'Add player' }).click();
  const boxes = page.locator('.compare-form').getByRole('combobox');
  await expect(boxes).toHaveCount(3);
  await expect(boxes.nth(2)).toBeFocused();
});

test('C1 edge: Enter in an empty player box compares, once two players are in', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/compare');
  const box = page.locator('.compare-form').getByRole('combobox').nth(1);
  await box.fill('bob');
  await box.press('Enter'); // commits Bob's chip
  await expect(page.locator('.compare-form')).toContainText('bob');
  await box.press('Enter');
  await expect(page.getByRole('heading', { name: 'Alice vs. Bob' })).toBeVisible();
});

test('C1 edge: Enter in an empty player box adds the suggestion pointed at, not compares', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/');
  await page.getByPlaceholder('Steam name, profile URL, or 64-bit ID…').fill('bob');
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(page.locator('.account-tiles li')).toHaveCount(2); // Bob is now a known account
  await page.goto('/lists/compare');
  const boxes = page.locator('.compare-form').getByRole('combobox');
  await boxes.nth(1).fill('carol');
  await boxes.nth(1).press('Enter');
  await page.getByRole('button', { name: 'Add player' }).click();
  await page.getByRole('option', { name: /Bob/ }).hover();
  await boxes.nth(2).press('Enter');
  await expect(page.locator('.compare-form')).toContainText('Bob');
  await expect(page).toHaveURL(/\/lists\/compare$/);
});

test('C1 edge: an empty player box highlights no suggestion until one is pointed at, and Enter follows that', async ({
  page,
}) => {
  await asPlayer(page, ALICE);
  await page.goto('/');
  await page.getByPlaceholder('Steam name, profile URL, or 64-bit ID…').fill('bob');
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(page.locator('.account-tiles li')).toHaveCount(2); // Bob is now a known account
  await page.goto('/lists/compare');
  const box = page.locator('.compare-form').getByRole('combobox').nth(1);
  await box.focus();
  const bob = page.getByRole('option', { name: /Bob/ });
  await expect(bob).toHaveAttribute('aria-selected', 'false');
  await expect(box).not.toHaveAttribute('aria-activedescendant');
  const chips = page.locator('.compare-token');
  await box.press('Enter');
  await expect(chips).toHaveCount(1); // Alice only
  await box.press('ArrowDown');
  await expect(bob).toHaveAttribute('aria-selected', 'true');
  await expect(box).toHaveAttribute('aria-activedescendant', (await bob.getAttribute('id'))!);
  await box.press('Enter');
  await expect(chips.filter({ hasText: 'Bob' })).toHaveCount(1);
});

test('C1 edge: ArrowDown steps through every player suggestion', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/');
  for (const [i, name] of ['bob', 'carol'].entries()) {
    await page.getByPlaceholder('Steam name, profile URL, or 64-bit ID…').fill(name);
    await page.getByRole('button', { name: 'Look up', exact: true }).click();
    // A Look up while the previous one resolves is ignored, and its end clears the field.
    await expect(page.locator('.account-tiles li')).toHaveCount(i + 2);
  }
  await page.goto('/lists/compare');
  const box = page.locator('.compare-form').getByRole('combobox').nth(1);
  await box.focus();
  const options = page.getByRole('option');
  await expect(options).toHaveCount(2);
  await box.press('ArrowDown');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await box.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await box.press('ArrowDown');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true'); // wraps
});

test('C1 edge: the players form offers no More actions with nothing to fold', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'phone layout only');
  await asPlayer(page, ALICE);
  await page.goto('/lists/compare');
  await expect(page.locator('.compare-form')).toBeVisible();
  await expect(page.getByRole('button', { name: 'More actions' })).toHaveCount(0);
});

test('C1 edge: a disabled Compare libraries says why', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/compare');
  const submit = page.getByRole('button', { name: 'Compare libraries' });
  // aria-disabled, not disabled: a disabled button is skipped by Tab, so its reason was never announced.
  await expect(submit).toHaveAttribute('aria-disabled', 'true');
  await submit.focus();
  await expect(submit).toBeFocused();
  await expect(submit).toHaveAccessibleDescription('Add a second player');
  await expect(page.locator('.compare-form-actions').getByText('Add a second player')).toBeVisible();
  const box = await visibleBox(submit);
  await page.locator('.compare-form').getByRole('combobox').nth(1).fill('bob');
  await expect(submit).not.toHaveAttribute('aria-disabled');
  await expect(page.locator('.compare-form-actions').getByText('Add a second player')).toBeHidden();
  expect(await visibleBox(submit)).toEqual(box);
});

test('C1 edge: with my account listed first, each group still names the right players', async ({ page }) => {
  await asPlayer(page, BOB); // Bob sorts after Alice in the URL, but reads first
  await page.goto('/lists/compare?u=alice&u=bob');
  const onlyBob = groupRows(page).filter({ hasText: 'Only Bob' });
  await expect(onlyBob).toContainText('2 rows'); // Bob owns 2 games Alice doesn't
  await expect(groupRows(page).filter({ hasText: 'Only Alice' })).toContainText('4 rows');
});

test('C1 edge: an unknown player is named, and the others still compare', async ({ page }) => {
  await page.goto('/lists/compare?u=alice&u=bob&u=nobody-here');
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('nobody-here');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Alice vs. Bob vs. nobody-here');

  await alert.getByRole('button', { name: 'Edit players' }).click();
  await expect(page.locator('.compare-token.is-invalid')).toHaveText(/nobody-here/);
  await page.getByRole('button', { name: 'Cancel' }).first().click();

  await page.getByRole('button', { name: 'Compare the other 2' }).click();
  // Checked by what's gone: the route also rewrites players to canonical steam64 ids.
  await expect(page).not.toHaveURL(/nobody-here/);
  await expect(groupRows(page)).toHaveCount(3);
});

test('C1 edge: the bare Compare link after an unknown player starts clean', async ({ page }) => {
  await page.goto('/lists/compare?u=alice&u=nobody-here');
  await expect(page.getByRole('alert')).toContainText('nobody-here');
  await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name: 'Compare' }).click();
  await expect(page.locator('.compare-form')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.compare-token.is-invalid')).toHaveCount(0);
});

test('L1 edge: following a formula link from Edit sources opens the source closed', async ({ page }) => {
  const list = (id: string, fields: object) => ({
    id,
    parentId: null,
    order: 0,
    createdAt: 0,
    updatedAt: 0,
    ...fields,
  });
  const lists = [
    list('picks', { name: 'Picks', kind: 'manual', appids: [620, 105600] }),
    list('inner', { name: 'Inner', kind: 'dynamic', op: 'union', sources: [{ kind: 'user', listId: 'picks' }] }),
    list('outer', { name: 'Outer', kind: 'dynamic', op: 'union', sources: [{ kind: 'user', listId: 'inner' }] }),
  ];
  await page.addInitScript(
    (blob) => {
      if (!sessionStorage.getItem('e2e-seeded')) localStorage.setItem('steam.isonoe.net:prefs', blob);
      sessionStorage.setItem('e2e-seeded', '1');
    },
    JSON.stringify({ schemaVersion: 2, lists: { value: lists, updatedAt: 0 } }),
  );
  await page.goto('/lists/outer');
  await page.getByRole('button', { name: 'Edit sources' }).click();
  await page.locator('.list-formula').getByRole('link', { name: 'Inner' }).click();
  await expect(page.getByRole('heading', { name: 'Inner' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit sources' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
});

test('L1.1-3: select games, add them to a new list, open it', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await row(page, 'Portal 2').getByRole('checkbox').check();
  await row(page, 'Terraria').getByRole('checkbox').check();

  const toolbar = page.locator('.selection-toolbar');
  await toolbar.getByRole('combobox').selectOption({ label: 'Create new list…' });
  await page.getByRole('textbox', { name: 'New list name' }).fill('To play with Bob');
  await page.keyboard.press('Enter');

  const toast = page.getByRole('status').filter({ hasText: 'Added 2 games to new list "To play with Bob"' });
  await expect(toast).toBeVisible();
  await toast.getByRole('link', { name: 'Open list' }).click();
  await expect(page.getByRole('heading', { name: 'To play with Bob' })).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
});

test('L1 edge: Add hands focus to the row it added as the selection bar goes', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  const added = rows(page).last();
  await added.getByRole('checkbox').check();
  const toolbar = page.locator('.selection-toolbar');
  await toolbar.getByRole('combobox').selectOption({ label: 'Create new list…' });
  await page.getByRole('textbox', { name: 'New list name' }).fill('Later');
  await toolbar.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('status').getByRole('link', { name: 'Open list' })).toBeVisible();
  await expect(added).toBeFocused();
});

test('L1 edge: Add hands focus to an added row still on screen, not back to the first', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 360 });
  await page.goto('/lists/owned');
  await rows(page).first().getByRole('checkbox').check();
  const onScreen = rows(page).last();
  await onScreen.scrollIntoViewIfNeeded();
  await onScreen.getByRole('checkbox').check();
  await expect(rows(page).first()).not.toBeInViewport();
  const toolbar = page.locator('.selection-toolbar');
  await toolbar.getByRole('combobox').selectOption({ label: 'Create new list…' });
  await page.getByRole('textbox', { name: 'New list name' }).fill('Later');
  await toolbar.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(onScreen).toBeFocused();
});

test("L1 edge: the new list's toast stays while pointed at", async ({ page }) => {
  await page.clock.install();
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await row(page, 'Portal 2').getByRole('checkbox').check();
  await page.locator('.selection-toolbar').getByRole('combobox').selectOption({ label: 'Create new list…' });
  await page.getByRole('textbox', { name: 'New list name' }).fill('Later');
  await page.keyboard.press('Enter');

  const toast = page.getByRole('status').filter({ hasText: 'new list "Later"' });
  await toast.hover();
  await page.clock.runFor(10_000);
  await expect(toast).toBeVisible();
  await page.mouse.move(0, 0);
  await page.clock.runFor(7_000);
  await expect(toast).toBeHidden();
});

test('L1.4: a list moves into the only folder', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/');
  await page.getByRole('button', { name: 'New list' }).click();
  await page.getByRole('textbox', { name: 'List name' }).fill('Shortlist');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByRole('textbox', { name: 'Folder name' }).fill('Weekend');
  await page.keyboard.press('Enter');

  await rowMenu(page, 'Shortlist').click();
  const move = page.getByRole('combobox', { name: 'Move Shortlist to…' });
  await expect(move).toHaveValue(''); // showing "Move to…", so picking the folder is a change
  await move.selectOption({ label: 'Weekend' });
  await rowMenu(page, 'Shortlist').click();
  await expect(move.locator('option')).toContainText(['Move to…', 'Top level']); // now inside Weekend
  await expect(move).toHaveValue('');
});

test('L1 edge: folders and lists are named in place, not in a dialog', async ({ page }) => {
  page.on('dialog', (d) => {
    throw new Error(`unexpected ${d.type()} dialog`);
  });
  await asPlayer(page, ALICE);
  await page.goto('/');
  const tree = page.locator('.home-tree');
  const newFolder = page.getByRole('button', { name: 'New folder' });
  await newFolder.click();
  const field = page.getByRole('textbox', { name: 'Folder name' });
  await expect(field).toBeFocused();
  await field.fill('Weekend');
  await page.keyboard.press('Enter');
  await expect(tree.getByText('Weekend', { exact: true })).toBeVisible();
  await expect(newFolder).toBeFocused();

  // Esc cancels, and focus goes back to the row's ⋯.
  const menu = rowMenu(page, 'Weekend');
  await menu.click();
  await page.getByRole('button', { name: 'Rename Weekend' }).click();
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('Weekend');
  await field.fill('Later');
  await page.keyboard.press('Escape');
  await expect(tree.getByText('Weekend', { exact: true })).toBeVisible();
  await expect(menu).toBeFocused();

  // Leaving the field saves it; an empty name cancels.
  await menu.click();
  await page.getByRole('button', { name: 'Rename Weekend' }).click();
  await field.fill('Co-op');
  await page.getByRole('heading', { name: 'Your lists' }).click();
  await expect(tree.getByText('Co-op', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New list' }).click();
  await page.getByRole('textbox', { name: 'List name' }).fill('  ');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'List name' })).toHaveCount(0);
  await expect(tree.locator('.list-tree li')).toHaveCount(1);
});

test("L1 edge: a row's ⋯ menu works from the keyboard and hands focus back", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/');
  for (const [button, label, name] of [
    ['New folder', 'Folder name', 'Weekend'],
    ['New list', 'List name', 'Shortlist'],
    ['New list', 'List name', 'Later'],
  ]) {
    await page.getByRole('button', { name: button }).click();
    await page.getByRole('textbox', { name: label }).fill(name);
    await page.keyboard.press('Enter');
  }
  const menu = rowMenu(page, 'Shortlist');

  // Enter opens it, Tab goes into it, Esc closes it back onto ⋯.
  await menu.focus();
  await page.keyboard.press('Enter');
  const move = page.getByRole('combobox', { name: 'Move Shortlist to…' });
  await expect(move).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(move).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(move).toBeHidden();
  await expect(menu).toBeFocused();

  // Rename closes the menu, then the field takes focus; Enter saves and returns to ⋯.
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Rename Shortlist' }).press('Enter');
  const field = page.getByRole('textbox', { name: 'List name' });
  await expect(field).toBeFocused();
  await expect(page.locator('.tree-menu-panel:popover-open')).toHaveCount(0);
  await field.fill('Picks');
  await page.keyboard.press('Enter');
  await expect(rowMenu(page, 'Picks')).toBeFocused();

  // Move lands on the moved row's ⋯.
  await page.keyboard.press('Enter');
  await page.getByRole('combobox', { name: 'Move Picks to…' }).selectOption({ label: 'Weekend' });
  await expect(rowMenu(page, 'Picks')).toBeFocused();

  // Delete: a cancelled confirm leaves focus on ⋯, an accepted one moves it to the next row's.
  page.once('dialog', (d) => d.dismiss());
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Delete Picks' }).press('Enter');
  await expect(rowMenu(page, 'Picks')).toBeFocused();
  page.once('dialog', (d) => d.accept());
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Delete Picks' }).press('Enter');
  await expect(rowMenu(page, 'Picks')).toHaveCount(0);
  await expect(rowMenu(page, 'Later')).toBeFocused();

  // The last row deleted: focus goes to the section's heading.
  page.once('dialog', (d) => d.accept());
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Delete Later' }).press('Enter');
  await expect(rowMenu(page, 'Weekend')).toBeFocused();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Delete Weekend' }).press('Enter');
  await expect(page.getByRole('heading', { name: 'Your lists' })).toBeFocused();
});

test("L1 edge: a list edit the browser can't store says so", async ({ page }) => {
  await asPlayer(page, ALICE);
  // Refuses the prefs blob once the test sets the flag, as a full storage would.
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if ((window as { storageFull?: boolean }).storageFull && key === 'steam.isonoe.net:prefs')
        throw new DOMException('full', 'QuotaExceededError');
      setItem.call(this, key, value);
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'New list' }).click();
  await page.getByRole('textbox', { name: 'List name' }).fill('Shortlist');
  await page.keyboard.press('Enter');
  const alert = page.getByRole('alert').filter({ hasText: "didn't save" });
  await expect(alert).toHaveCount(0);

  await page.evaluate(() => ((window as { storageFull?: boolean }).storageFull = true));
  await rowMenu(page, 'Shortlist').click();
  await page.getByRole('button', { name: 'Rename Shortlist' }).click();
  await page.getByRole('textbox', { name: 'List name' }).fill('Picks');
  await page.keyboard.press('Enter');
  await expect(alert).toHaveText("This browser didn't save your last change on this device.Dismiss");

  // Dismiss hands focus back to where it was.
  const focused = await page.evaluateHandle(() => document.activeElement);
  expect(await focused.evaluate((el) => el !== document.body)).toBe(true);
  await alert.getByRole('button', { name: 'Dismiss' }).click();
  await expect(alert).toHaveCount(0);
  expect(await focused.evaluate((el) => el === document.activeElement)).toBe(true);
});

test("L1 edge: clearing a ranking's name hands it back its default label", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/wishlist');
  await page.getByRole('button', { name: /Rank this list/ }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Ranking of Alice — Wishlist' })).toBeVisible();
  await page.goto('/');
  await rowMenu(page, 'Ranking of Alice — Wishlist').click();
  await page.getByRole('button', { name: 'Rename Ranking of Alice — Wishlist' }).click();
  await page.getByRole('textbox', { name: 'List name' }).fill('Top picks');
  await page.keyboard.press('Enter');
  await rowMenu(page, 'Top picks').click();
  await page.getByRole('button', { name: 'Rename Top picks' }).click();
  await page.getByRole('textbox', { name: 'List name' }).fill('');
  await page.keyboard.press('Enter');
  await expect(page.locator('.list-tree').getByRole('link', { name: /Ranking of Alice — Wishlist/ })).toBeVisible();
});

test('L1 edge: confirming an IME candidate with Enter keeps the name field open', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/');
  await page.getByRole('button', { name: 'New list' }).click();
  const field = page.getByRole('textbox', { name: 'List name' });
  await field.fill('にほ');
  await field.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await expect(field).toBeVisible();
  await expect(page.locator('.list-tree').getByRole('link', { name: /にほ/ })).toHaveCount(0);
});

test("L1 edge: the name field looks like the app's other text fields", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/');
  await page.getByRole('button', { name: 'New folder' }).click();
  const look = (el: Element) => {
    const s = getComputedStyle(el);
    return [s.backgroundColor, s.borderTopStyle, s.borderTopWidth, s.borderRadius, s.color, s.fontSize];
  };
  const search = await page.locator('.app-search-wrap > input').evaluate(look);
  expect(await page.getByRole('textbox', { name: 'Folder name' }).evaluate(look)).toEqual(search);
});

test('L2 edge: creating a combined list opens it', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/');
  await page.getByRole('button', { name: 'New combined list' }).click();
  const form = page.locator('.combine-form');
  const sources = form.locator('.combine-sources input[type="checkbox"]');
  await sources.nth(0).check();
  await sources.nth(1).check();
  await form.getByRole('button', { name: 'Create combined list' }).click();
  await expect(page).toHaveURL(/\/lists\/[^/?]+$/);
  await expect(page.getByRole('button', { name: 'Edit sources' })).toBeVisible();
});

test("L2 edge: a combined list created under a link's account opens under it", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/?u=bob');
  await page.getByRole('button', { name: 'New combined list' }).click();
  const sources = page.locator('.combine-form .combine-sources input[type="checkbox"]');
  await sources.nth(0).check();
  await sources.nth(1).check();
  await page.getByRole('button', { name: 'Create combined list' }).click();
  await expect(page).toHaveURL(/\/lists\/[^/?]+\?u=bob$/);
});

test('L2 edge: Edit sources has one Cancel, which hands focus back', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/');
  await page.getByRole('button', { name: 'New combined list' }).click();
  const sources = page.locator('.combine-form .combine-sources input[type="checkbox"]');
  await sources.nth(0).check();
  await sources.nth(1).check();
  await page.getByRole('button', { name: 'Create combined list' }).click();
  const edit = page.getByRole('button', { name: 'Edit sources' });
  await edit.click();
  await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.combine-form')).toHaveCount(0);
  await expect(edit).toBeFocused();
});

test('L2 edge: on a phone, the combine form fits the page width', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'phone layout');
  await asPlayer(page, ALICE);
  await page.goto('/');
  const pageWidth = () => page.evaluate(() => document.documentElement.scrollWidth);
  const viewport = page.viewportSize()!;
  await page.getByRole('button', { name: 'New combined list' }).click();
  const sources = page.locator('.combine-form .combine-sources input[type="checkbox"]');
  await expect(sources.first()).toBeVisible();
  expect(await pageWidth()).toBeLessThanOrEqual(viewport.width);
  await sources.nth(0).check();
  await sources.nth(1).check();
  await page.getByRole('button', { name: 'Create combined list' }).click();
  await page.getByRole('button', { name: 'Edit sources' }).click();
  await expect(page.locator('.combine-form')).toBeVisible();
  expect(await pageWidth()).toBeLessThanOrEqual(viewport.width);
});

test('L1 edge: a list under 2 games says ranking needs 2', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/');
  await page.getByRole('button', { name: 'New list' }).click();
  await page.getByRole('textbox', { name: 'List name' }).fill('Empty');
  await page.keyboard.press('Enter');
  await page.locator('.list-tree').getByRole('link', { name: /Empty/ }).click();
  const rank = page.getByRole('button', { name: /Rank this list/ });
  await expect(rank).toHaveAttribute('aria-disabled', 'true');
  await expect(rank).toHaveAccessibleDescription('Ranking needs at least 2 games');
  await expect(page.getByText('Ranking needs at least 2 games')).toBeVisible();
  await rank.click({ force: true }); // aria-disabled reads as disabled to Playwright
  await expect(page).toHaveURL(/\/lists\/[^/]+$/); // stayed: no ranking made
});

test('L1 edge: one selected game is too few to rank, and says so', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/wishlist');
  await row(page, 'It Takes Two').getByRole('checkbox').check();
  const rank = page.getByRole('button', { name: 'Rank 1 game', exact: true });
  await expect(rank).toHaveAttribute('aria-disabled', 'true');
  await expect(rank).toHaveAccessibleDescription('Ranking needs at least 2 games');
  await rank.click({ force: true });
  await expect(page).toHaveURL(/\/lists\/wishlist/);

  // A list already ranked once gates "New ranking" the same way.
  await row(page, 'It Takes Two').getByRole('checkbox').uncheck();
  await page.getByRole('button', { name: /Rank this list/ }).click();
  await page.keyboard.press('Escape');
  await page.goto('/lists/wishlist');
  await row(page, 'It Takes Two').getByRole('checkbox').check();
  await page.getByRole('button', { name: /Rank 1 game/ }).click();
  const create = page.locator('.rank-menu-panel').getByRole('button', { name: 'New ranking' });
  await expect(create).toHaveAttribute('aria-disabled', 'true');
  await expect(create).toHaveAccessibleDescription('Ranking needs at least 2 games');
  await create.click({ force: true });
  await expect(page).toHaveURL(/\/lists\/wishlist/);
});

test("L3 edge: the toolbar's two resets say what they do", async ({ page }) => {
  await asPlayer(page, ALICE);
  for (const route of ['/lists/owned', '/bundles']) {
    await page.goto(route);
    // The library's "× Clear all" (sort, filters, grouping, search) beside ours, which restores the defaults.
    await expect(page.getByRole('button', { name: '× Clear all' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Default view' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reset view' })).toHaveCount(0);
  }
});

test("L3 edge: the toolbar's buttons share one font and one height, the library's and ours", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  const style = (name: string) =>
    page.getByRole('button', { name }).evaluate((el) => ({
      font: getComputedStyle(el).fontFamily,
      height: el.getBoundingClientRect().height,
    }));
  expect(await style('Default view')).toEqual(await style('× Clear all'));
});

test('L3 edge: the column menu undoes the group and filter it set', async ({ page }, testInfo) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  const menu = page.getByRole('button', { name: /^Weighted Rating options/ });
  const dialog = page.getByRole('dialog', { name: /^Weighted Rating options/ });

  await menu.click();
  await dialog.getByRole('button', { name: 'Group by this column' }).click();
  await menu.click();
  await dialog.getByRole('button', { name: 'Remove group' }).click();
  await menu.click();
  await expect(dialog.getByRole('button', { name: 'Group by this column' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Filter ▸' }).click();
  await dialog.getByRole('textbox', { name: 'Weighted Rating Min' }).fill('95');
  await expect(menu).toHaveAccessibleName('Weighted Rating options, filtered');
  // A phone opens the filter as its own page of the menu.
  if (testInfo.project.name === 'phone') await dialog.getByRole('button', { name: '‹ Weighted Rating' }).click();
  await dialog.getByRole('button', { name: 'Clear filter' }).click();
  await expect(menu).toHaveAccessibleName('Weighted Rating options');
});

const SHORT_VIEW = { id: 'short', name: 'Short', tableView: { rangeFilters: { playtime: { min: '', max: '2' } } } };

test('L5.4: a view keeps its edits until Save or Discard', async ({ page }) => {
  await asPlayer(page, ALICE, { listViews: { owned: [SHORT_VIEW] } });
  await page.goto('/lists/owned?view=short');
  await expect(rows(page)).toHaveCount(4); // played 2 h or less
  await expect(page.getByRole('button', { name: 'Default view' })).toHaveCount(0); // Discard does it

  await page.getByRole('button', { name: /Clear all/ }).click();
  await expect(rows(page)).toHaveCount(6);
  const banner = page.locator('.pref-unsaved-banner');
  await expect(banner).toContainText('Unsaved changes to Short (Sort, Filters)'); // Clear all drops the sort too
  await banner.getByRole('button', { name: 'Discard' }).click();
  await expect(rows(page)).toHaveCount(4);
  await expect(banner).toHaveCount(0);

  await page.getByRole('button', { name: /Clear all/ }).click();
  await banner.getByRole('button', { name: 'Save' }).click();
  await expect(banner).toHaveCount(0);
  await page.reload();
  await expect(rows(page)).toHaveCount(6);
});

const LONG_VIEW = { id: 'long', name: 'Long', tableView: { rangeFilters: { playtime: { min: '5', max: '' } } } };

// The hero's New view menu.
async function newView(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'New view' }).click();
  return page.locator('#new-view-panel');
}

test('L5.1-3: a suggested view opens as its own tab, and is suggested once', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  let menu = await newView(page);
  await expect(menu.getByRole('button')).toHaveText(['Recently played', 'Play next', 'Short games', 'Save as view']);
  await menu.getByRole('button', { name: 'Play next' }).click();

  await expect(page).toHaveURL(/view=/);
  const tabs = page.getByRole('navigation', { name: 'Views' });
  await expect(tabs.getByRole('link', { name: 'Play next' })).toHaveAttribute('aria-current', 'page');
  await expect(rows(page)).toHaveCount(4); // played 2 h or less
  await expect(page.getByRole('columnheader', { name: /Taste fit/ })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Saved view Play next' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New view' })).toBeFocused();

  menu = await newView(page);
  await expect(menu.getByRole('button')).toHaveText(['Recently played', 'Short games', 'Save as view']);
  await page.reload();
  await expect(rows(page)).toHaveCount(4);
});

test('L5 edge: Short games keeps barely played games with a short main story, known', async ({ page }) => {
  await asPlayer(page, CAROL);
  await page.goto('/lists/owned');
  const menu = await newView(page);
  await expect(menu.getByRole('button')).toHaveText(['Recently played', 'Play next', 'Short games', 'Save as view']);
  await menu.getByRole('button', { name: 'Short games' }).click();
  await expect(page).toHaveURL(/view=/);
  await expect(rows(page)).toHaveCount(1); // not Portal 2 (6.3 h main), nor Counter-Strike 2 (no HLTB entry)
  await expect(rows(page).first()).toContainText('Quiet Little Game');
  await expect(page.locator('.pref-unsaved-banner')).toBeHidden(); // a fresh view has nothing to save
});

test('L5.2: the table as it is saves as a named view', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  const menu = await newView(page);
  await menu.getByRole('button', { name: 'Save as view' }).click();
  await expect(menu.getByRole('textbox', { name: 'Save the table as it is now' })).toBeFocused(); // a name first
  await menu.getByRole('textbox', { name: 'Save the table as it is now' }).fill('Everything');
  await menu.getByRole('textbox', { name: 'Save the table as it is now' }).press('Enter');
  await expect(page.getByRole('navigation', { name: 'Views' }).getByRole('link')).toHaveText([
    'All games',
    'Everything',
  ]);
});

test('L5 edge: Bargains is suggested on Wishlist, and only with prices', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/wishlist');
  let menu = await newView(page);
  await menu.getByRole('button', { name: 'Bargains' }).click();
  await expect(page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: 'Bargains' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(rows(page).first()).toContainText('1-Year Low');

  // Until prices arrive the view matches nothing, and says why.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/prices**', async (route) => {
    await held;
    await route.fallback();
  });
  await page.reload();
  await expect(page.getByText('Prices are still loading: this view filters on them.')).toBeVisible();
  release();
  await expect(rows(page).first()).toContainText('1-Year Low');
  await expect(page.getByText('Prices are still loading')).toHaveCount(0);
  await page.unroute('**/api/prices**');

  await mockApi(page, { states: ['no-itad'] });
  await page.goto('/lists/wishlist');
  await expect(rows(page)).toHaveCount(4);
  menu = await newView(page);
  await expect(menu.getByRole('button')).toHaveText(['Save as view']);
});

test('L5.3: the tabs switch views in place, each keeping its unsaved edits', async ({ page }) => {
  await asPlayer(page, ALICE, { listViews: { owned: [SHORT_VIEW, LONG_VIEW] } });
  await page.goto('/lists/owned');
  const tabs = page.getByRole('navigation', { name: 'Views' });
  await expect(tabs.getByRole('link', { name: 'All games' })).toHaveAttribute('aria-current', 'page');
  await expect(rows(page)).toHaveCount(6);

  await tabs.getByRole('link', { name: 'Short' }).click();
  await expect(tabs.getByRole('link', { name: 'Short' })).toHaveAttribute('aria-current', 'page');
  await expect(rows(page)).toHaveCount(4);
  await page.getByRole('button', { name: /Clear all/ }).click();
  await expect(page.locator('.pref-unsaved-banner')).toContainText('Unsaved changes to Short');

  await tabs.getByRole('link', { name: 'Long' }).click();
  await expect(rows(page)).toHaveCount(2); // 10 h and 20 h
  await expect(page.locator('.pref-unsaved-banner')).toHaveCount(0);
  await tabs.getByRole('link', { name: 'Short' }).click();
  await expect(rows(page)).toHaveCount(6); // its draft is still there…
  await expect(page.locator('.pref-unsaved-banner')).toContainText('Unsaved changes to Short');
  await tabs.getByRole('link', { name: 'All games' }).click();
  await expect(rows(page)).toHaveCount(6);
  await expect(page.locator('.pref-unsaved-banner')).toHaveCount(0); // …and stayed with its view
});

test('L5 edge: the active view is renamed and deleted from its ⋯', async ({ page }) => {
  await asPlayer(page, ALICE, { listViews: { owned: [SHORT_VIEW, LONG_VIEW] } });
  await page.goto('/lists/owned?view=short');
  const tabs = page.getByRole('navigation', { name: 'Views' });
  await expect(tabs.getByRole('button', { name: /^Manage/ })).toHaveCount(1); // the active view's only

  await tabs.getByRole('button', { name: 'Manage Short' }).click();
  await page.getByRole('textbox', { name: 'View name' }).fill('Quick ones');
  await page.getByRole('textbox', { name: 'View name' }).press('Enter');
  await expect(tabs.getByRole('link', { name: 'Quick ones' })).toHaveAttribute('aria-current', 'page');
  await expect(tabs.getByRole('button', { name: 'Manage Quick ones' })).toBeFocused();

  page.once('dialog', (dialog) => dialog.accept());
  await tabs.getByRole('button', { name: 'Manage Quick ones' }).click();
  await page.getByRole('button', { name: 'Delete view' }).click();
  await expect(page).not.toHaveURL(/view=/);
  await expect(tabs.getByRole('link')).toHaveText(['All games', 'Long']);
  await expect(tabs.getByRole('link', { name: 'All games' })).toBeFocused();
  await expect(rows(page)).toHaveCount(6);
});

test('L5 edge: no tabs until the list has a view', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  await expect(page.getByRole('navigation', { name: 'Views' })).toHaveCount(0);
});

test('L5.5: Home opens a view from its list card, for the account being explored', async ({ page }) => {
  await asPlayer(page, ALICE, { listViews: { owned: [SHORT_VIEW] } });
  await page.goto('/?u=bob');
  await expect(page.getByRole('list', { name: 'Owned views' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Wishlist views' })).toHaveCount(0); // no views, no links
  await page.getByRole('list', { name: 'Owned views' }).getByRole('link', { name: 'Short' }).click();
  await expect(page).toHaveURL(/\/lists\/owned\?.*view=short/);
  await expect(page).toHaveURL(/u=bob/);
  await expect(page.getByRole('heading', { name: "Bob's Library" })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: 'Short' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(rows(page)).toHaveCount(4); // Bob never played his: every game is under 2 h
});

test('L5 edge: a link to a deleted view shows the whole list, and says so', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?view=gone');
  await expect(rows(page)).toHaveCount(6);
  await expect(page.getByText('This view no longer exists')).toBeVisible();
});

test('L4 edge: Recently Looked Up lists the latest lookup first, and says it keeps 500', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  // Portal 2 rates higher than Valheim, so a rating sort would put it first.
  for (const name of ['Portal 2', 'Valheim']) {
    await page.getByPlaceholder('Look up any game…').fill(name);
    await page.locator('.game-search-result', { hasText: name }).first().click();
    await expect(page.locator('#panel-title')).toHaveText(name);
    // A phone's panel covers the search. Closing steps history back over the panel's own entry,
    // asynchronously: a goto issued before that lands is aborted (net::ERR_ABORTED).
    const steppedBack = page.evaluate(() => new Promise((r) => addEventListener('popstate', r, { once: true })));
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await steppedBack;
  }
  await page.goto('/game');
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).first()).toContainText('Valheim');
  await expect(page.locator('.list-hero')).toContainText('last 500');
});

test('L4 edge: Recently Looked Up shows when each game was looked up, undated ones last', async ({ page }) => {
  // Stored out of order (a device that dropped stamps wrote last): the dates decide.
  await asPlayer(page, ALICE, {
    recentGames: [
      620,
      { appid: 105600, lookedUpAt: Date.UTC(2026, 9, 1, 8, 5) },
      { appid: 1145360, lookedUpAt: Date.UTC(2026, 10, 3, 23, 30) }, // already Nov 4 in Paris
    ],
  });
  await page.goto('/game');
  await expect(rows(page)).toHaveCount(3);
  const cells = page.locator('.dt-td[data-col-key="lookedUp"]');
  await expect(cells).toHaveText(['2026-11-0400:30', '2026-10-0110:05', '—']);
  await page.locator('.dt-th[data-col-key="lookedUp"] .dt-th-sort').click();
  await expect(cells).toHaveText(['2026-10-0110:05', '2026-11-0400:30', '—']);
});

test('L4 edge: the search box lists the latest 10 lookups, and links the rest', async ({ page }) => {
  const recents = CATALOG.slice(0, 11).map((g) => g.appid);
  await asPlayer(page, ALICE, { recentGames: recents });
  await page.goto('/game');
  await expect(rows(page)).toHaveCount(11);
  await page.getByPlaceholder('Look up any game…').click();
  await expect(page.locator('.game-search-result')).toHaveCount(10);
  await expect(page.locator('.game-search-result').first()).toContainText(CATALOG[0].name);
});

test("R1 edge: a ranking card's HLTB time is the table's, rounded and labelled", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await expect(page.locator('thead th').filter({ hasText: /^HLTB \(h\)/ })).toHaveCount(1);
  await expect(row(page, 'Hades')).toContainText('44.5');
  for (const name of ['Portal 2', 'Hades']) await row(page, name).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Rank 2 games' }).click();
  await expect(page.locator('.rank-route')).toContainText('44.5 h to beat');
});

test("R1 edge: the ranking's keyboard hints show only with a mouse", async ({ page }, testInfo) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  for (const name of ['Portal 2', 'Hades']) await row(page, name).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Rank 2 games' }).click();
  await expect(page.locator('.rank-question')).toBeVisible();
  await expect(page.locator('.rank-hint')).toBeVisible({ visible: testInfo.project.name !== 'phone' });
});

test("R1 edge: the ranking's side panel offers similar owned games, with no list to sort", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  for (const name of ['Portal 2', 'Hades']) await row(page, name).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Rank 2 games' }).click();
  await page.getByRole('button', { name: 'Details', exact: true }).first().click();
  const similar = page.locator('#panel-section-similar');
  await expect(similar.locator('.panel-section-title')).toHaveText(/^Similar in Alice's library/);
  await expect(similar.locator('.panel-similar-item').first()).toBeVisible();
  await expect(similar.getByRole('button', { name: /Sort list by similarity/ })).toHaveCount(0);
});

test("R1 edge: the ranking's side panel shows tags as plain pills and its Refresh re-fetches", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  for (const name of ['Portal 2', 'Hades']) await row(page, name).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Rank 2 games' }).click();
  await page.getByRole('button', { name: 'Details', exact: true }).first().click();

  const panel = page.locator('.panel-tags');
  await expect(panel.locator('.panel-tag').first()).toBeVisible();
  await expect(panel.getByRole('button')).toHaveCount(0);

  // The refreshed game updates in place: no reopen, so no jump to the top or focus move to the hero.
  const body = page.locator('#panel-body');
  await body.evaluate((el) => (el.scrollTop = 120));
  const scrollTop = await body.evaluate((el) => el.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);
  const refetch = page.waitForResponse((res) => /\/api\/game-details\/\d+\?refresh=1$/.test(res.url()));
  await page.getByRole('button', { name: 'Refresh details' }).click();
  await refetch;
  await expect(page.getByRole('button', { name: 'Refresh details' })).toBeEnabled();
  expect(await body.evaluate((el) => el.scrollTop)).toBe(scrollTop);
  expect(await page.evaluate(() => document.activeElement?.closest('#panel-hero') == null)).toBe(true);
});

test("R1 edge: a failed Refresh on the ranking's side panel says so", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  for (const name of ['Portal 2', 'Hades']) await row(page, name).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Rank 2 games' }).click();
  await page.getByRole('button', { name: 'Details', exact: true }).first().click();
  await page.route(/\/api\/game-details\/\d+\?refresh=1$/, (route) =>
    route.fulfill({ status: 502, json: { error: 'Steam did not answer' } }),
  );
  await page.getByRole('button', { name: 'Refresh details' }).click();
  await expect(page.locator('.rank-route .list-status')).toHaveText('Refresh failed: Steam did not answer');
});

test('I1 edge: on desktop the nav starts on the content edge, close above it', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop app bar');
  await asPlayer(page, ALICE);
  for (const width of [1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/lists/owned');
    const nav = await visibleBox(page.locator('.site-nav'));
    const first = await visibleBox(page.locator('.site-brand'));
    const hero = await visibleBox(page.locator('.list-hero'));
    expect(Math.round(first.x), `at ${width}px`).toBe(Math.round(hero.x));
    expect(hero.y - (nav.y + nav.height), `at ${width}px`).toBeLessThanOrEqual(28);
  }
  // The search fills the middle on a wide screen, and gives way so the bar stays one row on a narrow one.
  await page.setViewportSize({ width: 1440, height: 900 });
  const search = page.locator('.app-search-wrap');
  expect((await visibleBox(search)).width).toBe(
    await search.evaluate((el) => parseFloat(getComputedStyle(el).maxWidth)),
  );
  await page.setViewportSize({ width: 800, height: 900 });
  expect((await visibleBox(page.locator('.site-nav'))).height).toBeLessThan(60);
});

test('I1 edge: on a phone, the ranking shows both cards and its Tie/Skip/Undo without scrolling, inside a gutter, down to 320px wide', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'phone layout');
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  for (const name of ['Portal 2', 'Hades']) await row(page, name).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Rank 2 games' }).click();
  await expect(page.locator('.rank-card-name').nth(1)).not.toHaveText(/^App /);

  const viewport = page.viewportSize()!;
  const actions = await visibleBox(page.locator('.rank-actions'));
  expect(actions.y + actions.height).toBeLessThanOrEqual(viewport.height);
  for (const box of [await visibleBox(page.locator('.rank-pair')), await visibleBox(page.locator('.rank-header'))]) {
    expect(box!.x).toBeGreaterThanOrEqual(12);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width - 12);
  }

  // The narrowest phones: the cards' action buttons wrap rather than push the page sideways.
  await page.setViewportSize({ width: 320, height: viewport.height });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test("I1 edge: on a phone, Home keeps the list pages' 16px gutter and the account tiles inside the card", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'phone layout');
  await asPlayer(page, ALICE);
  await page.goto('/');
  await page.getByPlaceholder('Steam name, profile URL, or 64-bit ID…').fill('bob');
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(page.locator('.account-tiles li')).toHaveCount(2);

  const viewport = page.viewportSize()!;
  expect((await visibleBox(page.locator('.app-search-wrap'))).x).toBe(16);
  const card = await visibleBox(page.locator('.home-account'));
  expect(card.x).toBe(16);
  expect(card.x + card.width).toBe(viewport.width - 16);
  expect((await visibleBox(page.locator('.home-account h3'))).x).toBeLessThanOrEqual(29);

  for (const li of await page.locator('.account-tiles li').all()) {
    const box = await visibleBox(li);
    expect(box.x).toBeGreaterThanOrEqual(card.x);
    expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
  await expect(page.getByRole('button', { name: 'Star Bob as mine' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Remove Bob' }).click();
  await expect(page.locator('.account-tiles li')).toHaveCount(1);
});

test("I1 edge: on a phone with no account yet, the nav's search, account and preferences share one row", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'phone layout');
  await page.goto('/about');
  await expect(page.locator('.site-nav-account')).toContainText('No account');
  const search = await visibleBox(page.locator('.app-search-wrap'));
  const prefs = await visibleBox(page.locator('.site-nav-prefs'));
  expect(prefs.y).toBeLessThan(search.y + search.height);
});

test('R1.1,3-6: rank chosen games, stop, resume on the same ones', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  for (const name of ['Portal 2', 'Terraria', 'Hades']) await row(page, name).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Rank 3 games' }).click();

  await expect(page.getByText('Comparing 3 chosen games.')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Escape');

  const resume = page.getByRole('button', { name: /^Continue: \d+ chosen left$/ });
  await expect(resume).toBeVisible();
  await resume.click();
  await expect(page.getByText('Comparing 3 chosen games.')).toBeVisible();
});

test("R1 edge: closing the ranking's side panel returns focus to its Details button", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  for (const name of ['Portal 2', 'Hades']) await row(page, name).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Rank 2 games' }).click();
  const details = page.getByRole('button', { name: 'Details', exact: true }).first();
  await details.click();
  await expect(page.locator('.game-panel')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.game-panel')).toBeHidden();
  await expect(details).toBeFocused();

  // Opened from the keyboard, with nothing focused: focus lands on the shown game's Details button.
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.keyboard.press('i');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.game-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.game-panel')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Details', exact: true }).nth(1)).toBeFocused();
});

test("R1 edge: the answer keys wait while the ranking's side panel is open", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  for (const name of ['Portal 2', 'Hades']) await row(page, name).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Rank 2 games' }).click();
  const tie = page.getByRole('button', { name: /^Tie/ });
  await expect(tie).toContainText('↓');
  await page.getByRole('button', { name: 'Details', exact: true }).first().click();
  await expect(page.locator('.game-panel')).toBeVisible();
  // Its key hints go too: the keys don't answer now.
  await expect(tie).not.toContainText('↓');
  for (const key of ['ArrowDown', 's', 'z']) await page.keyboard.press(key);
  await expect(page.locator('.game-panel')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Undo/ })).toBeDisabled();
  // Like any other key, a held one cancels an armed X.
  await page.keyboard.press('x');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.game-panel')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Undo/ })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: /^Undo/ })).toBeEnabled();
});

test('R1 edge: Esc closing a nav popover stays on the ranking', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  for (const name of ['Portal 2', 'Terraria', 'Hades']) await row(page, name).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Rank 3 games' }).click();
  await expect(page.getByText('Comparing 3 chosen games.')).toBeVisible();

  await page.getByLabel('Preferences').click();
  await expect(page.locator('.site-nav-prefs-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.site-nav-prefs-panel')).toBeHidden();
  await expect(page.getByText('Comparing 3 chosen games.')).toBeVisible();
});

test("R3 edge: a ranked list's Share view says why it can't be shared", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/wishlist');
  await page.getByRole('button', { name: /Rank this list/ }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: /^Ranking of/ })).toBeVisible();
  // Its /lists/<id> link only opens in this browser.
  const share = page.getByRole('button', { name: 'Share view' });
  await expect(share).toHaveAttribute('aria-disabled', 'true');
  await expect(share).toHaveCSS('opacity', '0.5');
  await expect(share).toHaveCSS('cursor', 'not-allowed');
  await expect(share).toHaveAccessibleDescription(/can't be shared/);
  // Said on press rather than beside it: an always-on note made the toolbar wrap on every saved list.
  const toolbarHeight = (await visibleBox(page.locator('.dt-toolbar'))).height;
  await expect(page.getByRole('status').filter({ hasText: "can't be shared" })).toHaveCount(0);
  // Playwright won't click an aria-disabled button; a key press is what a keyboard user does anyway.
  await share.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: "can't be shared" })).toBeVisible();
  expect((await visibleBox(page.locator('.dt-toolbar'))).height).toBe(toolbarHeight);
});

test("R2 edge: ranking games you don't own offers 'Not interested', not 'Haven't played'", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/wishlist');
  await page.getByRole('button', { name: /Rank this list/ }).click();
  await expect(page.getByRole('button', { name: 'Not interested — exclude' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: "Haven't played — exclude" })).toHaveCount(0);
});

test('R2 edge: ranking a list again offers its rankings, or a new one by a criterion', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/wishlist');
  await page.getByRole('button', { name: /Rank this list/ }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Ranking of Alice — Wishlist' })).toBeVisible();

  await page.goto('/lists/wishlist');
  await page.getByRole('button', { name: /Rank this list/ }).click();
  const menu = page.locator('.rank-menu-panel');
  await expect(menu.getByRole('button', { name: /Ranking of Alice — Wishlist/ })).toBeVisible();
  await menu.getByRole('textbox', { name: 'What are you ranking by?' }).fill('co-op');
  await menu.getByRole('button', { name: 'New ranking' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Ranking of Alice — Wishlist (co-op)' })).toBeVisible();
});

test('R1 edge: a ranked list resumes with "Continue ranking", not the nav\'s Compare', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/wishlist');
  await page.getByRole('button', { name: /Rank this list/ }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Ranking of Alice — Wishlist' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue ranking' })).toBeVisible();
  await expect(page.getByRole('main').getByRole('button', { name: /^Compare/ })).toHaveCount(0);
});

test('R2 edge: a Wishlist ranking keeps its price columns', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/wishlist');
  await page.getByRole('button', { name: /Rank this list/ }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: /^Ranking of/ })).toBeVisible();
  await expect(page.locator('thead th').filter({ hasText: /^Best Deal/ })).toHaveCount(1);
  await expect(page.locator('.list-hero')).toContainText(/Prices/i);
});

test('B1.1,3-4: a bundle, then what it adds to my library', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/bundles');
  await page.getByRole('cell', { name: 'Test Co-op Pack' }).click();
  await expect(page.getByRole('heading', { name: 'Test Co-op Pack' })).toBeVisible();
  await expect(rows(page)).toHaveCount(4);
  // Alice owns two of the four: what the bundle adds, and at what price.
  await expect(page.locator('.list-hero')).toContainText(/New to you\s*2 of 4\s*≈ .+ at best deals/i);
  // A game with no Steam listing is listed apart, not dropped.
  await page.getByRole('button', { name: /1 more in this bundle, not on Steam/ }).click();
  await expect(page.getByText('Test Soundtrack')).toBeVisible();

  // The answer opens right away, unsaved; keeping it is one more click.
  await page.getByRole('link', { name: 'What does this add?' }).click();
  await expect(page).toHaveURL(/\/lists\/shared\?f=/);
  await expect(rows(page)).toHaveCount(2);
  await expect(row(page, 'Overcooked! 2')).toHaveCount(1);
  await expect(row(page, 'It Takes Two')).toHaveCount(1);
  await page.getByRole('button', { name: 'Save as a list' }).click();
  await expect(page.getByRole('heading', { name: 'Test Co-op Pack − Alice — Owned' })).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
});

test('B1.4: a tier shows what paying it gets, and what of that is new to me', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/bundles');
  await page.getByRole('cell', { name: BUNDLE.title }).click();
  await expect(rows(page)).toHaveCount(4);
  const hero = page.locator('.list-hero');
  // The tile names the pricing model and its rule, readable without hovering.
  await expect(hero).toContainText('each includes the cheaper ones');
  // Grouped by tier, each header saying what its step over the one below buys Alice: she owns the €5 games.
  await expect(groupRows(page)).toHaveText([
    /€5\.00 tier · nothing new/,
    /€12\.00 tier · saves €10\.00 · \+€7\.00 for 2 new worth €17\.00/,
  ]);
  // Alice's two new games (€7 + €10 at best deals) are both in the €12 tier.
  await expect(hero.locator('.bundle-tier-saving')).toHaveText('saves €5.00 at €12.00');
  const five = hero.getByRole('button', { name: /5\.00.* tier$/ });
  await five.focus();
  await five.press('Enter');
  // Its own games only: a pricier tier's would include these too. Alice owns both.
  await expect(rows(page)).toHaveCount(2);
  await expect(five).toHaveAttribute('aria-pressed', 'true');
  await expect(five).toBeFocused();
  await expect(hero).toContainText(/New at .*5\.00.*0 of 2/i);
  await expect(hero.locator('.bundle-tier-saving')).toHaveCount(0); // nothing new to save on
  const twelve = hero.getByRole('button', { name: /12\.00.* tier$/ });
  await twelve.click();
  await expect(rows(page)).toHaveCount(4);
  await expect(five).toHaveAttribute('aria-pressed', 'false');
  await expect(hero).toContainText(/New at .*12\.00.*2 of 4\s*≈ .+ at best deals/i);
  await expect(hero.locator('.bundle-tier-saving')).toHaveText('saves €5.00');
  await twelve.click();
  await expect(twelve).toHaveAttribute('aria-pressed', 'false');
  await expect(hero).toContainText(/New to you\s*2 of 4/i);

  // The table's own Clear filters unpresses it.
  await five.click();
  await expect(rows(page)).toHaveCount(2);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(rows(page)).toHaveCount(4);
  await expect(five).toHaveAttribute('aria-pressed', 'false');

  // A tier filter stays with its bundle; a pick-and-mix's tiers aren't filters.
  await five.click();
  await page.getByRole('button', { name: 'Next bundle' }).click();
  await expect(page.getByRole('heading', { name: PICK_BUNDLE.title })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear filters' })).toHaveCount(0);
  await expect(hero.locator('.bundle-tier-chip')).toHaveCount(2);
  await expect(hero.locator('button.bundle-tier-chip')).toHaveCount(0);
  await expect(hero).toContainText('Pick & mix');
  await expect(hero).toContainText('the more you pick, the less each');
});

test('B1 edge: an add-on tier is bought apart: grouped after the tiers, never in what a tier gets', async ({
  page,
}) => {
  await asPlayer(page, ALICE);
  await page.route(`**/api/bundles/${BUNDLE.id}*`, (route) => {
    const req = route.request();
    const body = JSON.parse(respond(req.method(), new URL(req.url()), req.postData()).body);
    // Terraria (a game the mock resolves) as a €2 add-on, cheaper than every tier.
    body.bundle.tiers.push({
      price: { amount: 2, amountInt: 200, currency: 'EUR' },
      addon: true,
      games: [{ id: 'pnm-terraria', slug: 'pnm-terraria', title: 'Terraria', type: 'game', assets: {} }],
    });
    return route.fulfill({ json: body });
  });
  await page.goto(`/lists/bundle/${BUNDLE.id}`);
  await expect(rows(page)).toHaveCount(5);
  await expect(groupRows(page)).toHaveText([/€5\.00 tier\b/, /€12\.00 tier/, /€2\.00 add-on/]);
  await page
    .locator('.list-hero')
    .getByRole('button', { name: /5\.00.* tier$/ })
    .click();
  await expect(rows(page)).toHaveCount(2);
  await expect(row(page, 'Terraria')).toHaveCount(0);
});

test("B1 edge: a pressed tier is this bundle's view, not the layout every bundle shares", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto(`/lists/bundle/${BUNDLE.id}`);
  await expect(rows(page)).toHaveCount(4);
  await page
    .locator('.list-hero')
    .getByRole('button', { name: /5\.00.* tier$/ })
    .click();
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByText(/Unsaved changes/)).toHaveCount(0);
  // Not kept as a draft either: the next bundle, or this one again, opens whole.
  await page.reload();
  await expect(rows(page)).toHaveCount(4);
  await expect(page.locator('.list-hero button.bundle-tier-chip[aria-pressed="true"]')).toHaveCount(0);
});

test("B1 edge: a bundle's hero keeps All bundles by its previous/next buttons, and one primary action among ghost ones", async ({
  page,
}) => {
  await asPlayer(page, ALICE);
  await page.goto(`/lists/bundle/${BUNDLE.id}`);
  await expect(rows(page)).toHaveCount(4);
  const titlebar = page.locator('.list-hero-titlebar');
  await expect(titlebar.getByRole('button', { name: 'Previous bundle' })).toBeVisible();
  await expect(titlebar.getByRole('link', { name: 'All bundles' })).toBeVisible();
  const more = page.getByRole('button', { name: 'More actions' }); // a phone folds the rest behind More actions
  if (await more.isVisible()) await more.click();
  const classes = await page
    .locator('.list-hero-actions')
    .locator(':is(a, button, summary):visible')
    .evaluateAll((els) => els.map((el) => el.className));
  expect(classes.filter((c) => /\bbtn-primary\b/.test(c))).toHaveLength(1);
  expect(classes.filter((c) => !/\bbtn\b/.test(c))).toEqual([]);
});

test("B1 edge: a bundle's All bundles link keeps the account being explored, without reloading", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto(`/lists/bundle/${BUNDLE.id}?u=bob`);
  await expect(rows(page)).toHaveCount(4);
  await page.evaluate(() => ((window as unknown as { e2eSamePage: boolean }).e2eSamePage = true));
  await page.locator('.list-hero-titlebar').getByRole('link', { name: 'All bundles' }).click();
  await expect(page).toHaveURL(/\/bundles\?u=bob$/);
  expect(await page.evaluate(() => (window as unknown as { e2eSamePage?: boolean }).e2eSamePage)).toBe(true);
});

test("B3 edge: a list built from a bundle says how many of its games aren't on Steam", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto(`/lists/bundle/${BUNDLE.id}`);
  await expect(rows(page)).toHaveCount(4);
  const more = page.getByRole('button', { name: 'More actions' }); // a phone folds it behind More actions
  if (await more.isVisible()) await more.click();
  await page.getByRole('link', { name: 'What does this add?' }).click();
  await expect(page.locator('.list-formula')).toContainText('1 not on Steam');
});

test("B3 edge: what a bundle adds keeps the bundle's prices and links back to it", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto(`/lists/bundle/${BUNDLE.id}`);
  await expect(rows(page)).toHaveCount(4);
  const more = page.getByRole('button', { name: 'More actions' }); // a phone folds it behind More actions
  if (await more.isVisible()) await more.click();
  await page.getByRole('link', { name: 'What does this add?' }).click();
  await expect(rows(page)).toHaveCount(2);
  await expect(page.locator('thead th').filter({ hasText: /^Tier Price/ })).toHaveCount(1);
  await expect(page.locator('thead th').filter({ hasText: /^Best Deal/ })).toHaveCount(1);
  await expect(row(page, 'Overcooked! 2')).toContainText('12.00');
  await page.locator('.list-hero-actions').getByRole('link', { name: BUNDLE.title }).click();
  await expect(page).toHaveURL(new RegExp(`/lists/bundle/${BUNDLE.id}`));
  await expect(page.getByRole('heading', { name: BUNDLE.title })).toBeVisible();
});

const sharedUrl = (formula: string) => `/lists/shared?f=${encodeURIComponent(formula)}`;

const saveWhatBundleAdds = async (page: Page) => {
  // The mock only prices in EUR; answer a US request in USD, as ITAD does.
  await page.route(/\/api\/bundles\/\d+\?/, (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const { body } = respond(req.method(), url, req.postData());
    return route.fulfill({
      json: JSON.parse(url.searchParams.get('country') === 'US' ? body.replaceAll('"EUR"', '"USD"') : body),
    });
  });
  await page.goto(sharedUrl(`subtract:(b:${BUNDLE.id};o:${ALICE.steamid})`));
  await expect(rows(page)).toHaveCount(2);
  const more = page.getByRole('button', { name: 'More actions' }); // a phone folds Save behind More actions
  if (await more.isVisible()) await more.click();
  await page.getByRole('button', { name: 'Save as a list' }).click();
  await expect(page).toHaveURL(/\/lists\/(?!shared)/);
  await expect(row(page, 'Overcooked! 2')).toContainText('€12.00');
};

test("B3 edge: what a bundle adds, once saved, keeps the bundle's Tier Price, in a newly picked region too", async ({
  page,
}) => {
  await asPlayer(page, ALICE);
  await saveWhatBundleAdds(page);
  await expect(page.locator('thead th').filter({ hasText: /^Tier Price/ })).toHaveCount(1);
  await page.getByTitle('Preferences').click();
  await page.locator('#nav-region-select').selectOption({ label: 'United States (USD)' });
  await expect(row(page, 'Overcooked! 2')).toContainText('$12.00');
});

test("B3 edge: a region picked while a saved list's bundle is still loading prices its Tier Price there", async ({
  page,
}) => {
  await asPlayer(page, ALICE);
  await saveWhatBundleAdds(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/api\/bundles\/\d+\?(?!.*country=US)/, async (route) => {
    await held;
    await route.fallback();
  });
  const asked = page.waitForRequest(/\/api\/bundles\/\d+\?/);
  await page.reload();
  await asked;
  await page.getByTitle('Preferences').click();
  await page.locator('#nav-region-select').selectOption({ label: 'United States (USD)' });
  release();
  await expect(row(page, 'Overcooked! 2')).toContainText('$12.00');
});

test("B3 edge: a ranking of a list with a bundle source only re-prices on a new region, it doesn't reload", async ({
  page,
}) => {
  await asPlayer(page, ALICE);
  await saveWhatBundleAdds(page);
  await page.getByRole('button', { name: /Rank this list/ }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: /^Ranking of/ })).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
  const bundleAsks: string[] = [];
  page.on('request', (req) => {
    if (/\/api\/bundles\/\d+/.test(req.url())) bundleAsks.push(req.url());
  });
  await page.getByTitle('Preferences').click();
  const repriced = page.waitForResponse(/\/api\/prices\?country=US/);
  await page.locator('#nav-region-select').selectOption({ label: 'United States (USD)' });
  await repriced;
  expect(bundleAsks).toEqual([]);
});

test("B3 edge: a saved list whose bundle didn't answer only re-prices on a new region, it doesn't reload", async ({
  page,
}) => {
  await asPlayer(page, ALICE);
  await saveWhatBundleAdds(page);
  await page.route(/\/api\/bundles\/\d+\?/, (route) => route.fulfill({ status: 502, json: { error: 'Bad gateway' } }));
  await page.reload();
  await expect(rows(page)).toHaveCount(2); // from the bundle's last good load, with no Tier Price
  await expect(page.locator('thead th').filter({ hasText: /^Tier Price/ })).toHaveCount(0);
  const bundleAsks: string[] = [];
  page.on('request', (req) => {
    if (/\/api\/bundles\/\d+/.test(req.url())) bundleAsks.push(req.url());
  });
  await page.getByTitle('Preferences').click();
  const repriced = page.waitForResponse(/\/api\/prices\?country=US/);
  await page.locator('#nav-region-select').selectOption({ label: 'United States (USD)' });
  await repriced;
  expect(bundleAsks).toEqual([]);
});

test("B3 edge: a saved list from a pick-and-mix bundle claims no per-game rate it can't know", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto(sharedUrl(`subtract:(b:90002;o:${BOB.steamid})`));
  await expect(row(page, 'Hades')).toContainText('Varies');
  const more = page.getByRole('button', { name: 'More actions' }); // a phone folds Save behind More actions
  if (await more.isVisible()) await more.click();
  await page.getByRole('button', { name: 'Save as a list' }).click();
  await expect(page).toHaveURL(/\/lists\/(?!shared)/);
  await expect(row(page, 'Hades')).toContainText('Varies');
  await expect(rows(page).filter({ hasText: '/game' })).toHaveCount(0);
});

test("B3 edge: what a bundle adds shows the bundle's prices in a newly picked region", async ({ page }) => {
  await asPlayer(page, ALICE);
  // The mock only prices in EUR; answer a US request in USD, as ITAD does.
  await page.route(/\/api\/bundles\/\d+\?/, (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const { body } = respond(req.method(), url, req.postData());
    return route.fulfill({
      json: JSON.parse(url.searchParams.get('country') === 'US' ? body.replaceAll('"EUR"', '"USD"') : body),
    });
  });
  await page.goto(sharedUrl(`subtract:(b:${BUNDLE.id};o:${ALICE.steamid})`));
  await expect(row(page, 'Overcooked! 2')).toContainText('€12.00');
  await page.getByTitle('Preferences').click();
  await page.locator('#nav-region-select').selectOption({ label: 'United States (USD)' });
  await expect(row(page, 'Overcooked! 2')).toContainText('$12.00');
});

test("B3 edge: a shared list left before its bundle answers doesn't link the next one to it", async ({ page }) => {
  await asPlayer(page, ALICE);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/api\/bundles\/\d+/, async (route) => {
    await held;
    await route.fallback();
  });
  await page.clock.install();
  await page.goto(sharedUrl(`subtract:(o:${ALICE.steamid};w:${ALICE.steamid})`));
  await expect(rows(page)).toHaveCount(6);
  const bundleAsked = page.waitForRequest(/\/api\/bundles\/\d+/);
  await page.evaluate(
    (url) => {
      history.pushState(null, '', url);
      dispatchEvent(new PopStateEvent('popstate'));
    },
    sharedUrl(`subtract:(b:${BUNDLE.id};o:${ALICE.steamid})`),
  );
  await bundleAsked;
  await page.goBack();
  await expect(rows(page)).toHaveCount(6);
  release();
  await page.waitForResponse(/\/api\/bundles\/\d+/);
  await page.clock.runFor(200); // let the late answer land, if it would
  await expect(page.locator('.list-hero-actions').getByRole('link', { name: BUNDLE.title })).toHaveCount(0);
});

test('B3 edge: a list left with none of its bundle source has no Tier Price, but still links back', async ({
  page,
}) => {
  await asPlayer(page, ALICE);
  await page.goto(sharedUrl(`subtract:(o:${ALICE.steamid};b:${BUNDLE.id})`));
  await expect(rows(page)).toHaveCount(4);
  await expect(page.locator('thead th').filter({ hasText: /^Best Deal/ })).toHaveCount(1);
  await expect(page.locator('thead th').filter({ hasText: /^Tier Price/ })).toHaveCount(0);
  await expect(page.locator('.list-hero-actions').getByRole('link', { name: BUNDLE.title })).toBeVisible();
});

test("B3 edge: what a pick-and-mix bundle adds claims no per-game rate it can't know", async ({ page }) => {
  await asPlayer(page, ALICE);
  // Alice owns the package's lead game (Hollow Knight), so its mate is left on its own.
  await page.goto(sharedUrl(`subtract:(b:90002;o:${ALICE.steamid})`));
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, "Don't Starve Together")).not.toContainText('included');
  await expect(row(page, "Don't Starve Together")).toContainText('Varies');
  // Bob owns neither Hades nor Hollow Knight: no entry rate passed off as theirs.
  await page.goto(sharedUrl(`subtract:(b:90002;o:${BOB.steamid})`));
  await expect(row(page, 'Hades')).toContainText('Varies');
  await expect(rows(page).filter({ hasText: '/game' })).toHaveCount(0);
});

test("B3 edge: the link back to a bundle keeps the link's account", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto(`${sharedUrl(`subtract:(b:${BUNDLE.id};o:${BOB.steamid})`)}&u=bob`);
  await expect(page.locator('.list-hero-actions').getByRole('link', { name: BUNDLE.title })).toHaveAttribute(
    'href',
    /[?&]u=bob/,
  );
});

test("B1: /bundles counts each bundle's wishlisted and new games, and filters to the wishlisted ones", async ({
  page,
}) => {
  await asPlayer(page, ALICE);
  const lookup = await gate(page, '**/api/bundles/resolve');
  await page.goto('/bundles');
  await expect(row(page, BUNDLE.title)).toContainText('…');
  lookup.release();
  // Co-op Pack: 4 Steam games, Portal 2 and Hades owned, Overcooked! 2 and It Takes Two wishlisted.
  await expect(row(page, BUNDLE.title).getByTitle('2 of 4 Steam games on the wishlist')).toHaveText('☆ 2');
  await expect(row(page, BUNDLE.title).getByTitle('2 of 4 Steam games not owned')).toHaveText('2');
  // The pick-and-mix's Steam package counts per game in it, as the bundle's own New to you does.
  await expect(row(page, PICK_BUNDLE.title).getByTitle('1 of 5 Steam games not owned')).toBeVisible();
  await page.locator('.list-stat', { hasText: 'Wishlist' }).locator('.list-stat-btn').click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText(BUNDLE.title);
});

test('B1 edge: /bundles without an account says what the counts need instead of showing zeros', async ({ page }) => {
  await page.goto('/bundles');
  await expect(page.getByText('Pick an account on Home to see which bundles hold')).toBeVisible();
  await expect(row(page, BUNDLE.title).getByTitle(/Steam games/)).toHaveCount(0);
  await expect(page.locator('.list-stat', { hasText: 'Wishlist' })).toHaveCount(0);
});

test('B1 edge: on /bundles, a bundle whose game failed to resolve reads — rather than a partial count', async ({
  page,
}) => {
  await asPlayer(page, ALICE);
  await mockApi(page, { states: ['resolve-failed'] }); // registered last, so it answers first
  await page.goto('/bundles');
  await expect(page.getByText("Steam didn't answer for some bundles' games")).toBeVisible();
  await expect(row(page, PICK_BUNDLE.title).getByTitle('1 of 5 Steam games not owned')).toBeVisible();
  await expect(row(page, BUNDLE.title).getByTitle(/Steam games/)).toHaveCount(0);
});

test('B1 edge: a bundle game whose Steam lookup failed says so, rather than reading as not on Steam', async ({
  page,
}) => {
  await asPlayer(page, ALICE);
  await mockApi(page, { states: ['resolve-failed'] }); // registered last, so it answers first
  await page.goto(`/lists/bundle/${BUNDLE.id}`);
  await expect(rows(page)).toHaveCount(3);
  await expect(page.getByText("Steam didn't answer for 1 of this bundle's games")).toBeVisible();
  await expect(page.getByRole('button', { name: /1 more in this bundle, not on Steam/ })).toBeVisible();
});

test("B1 edge: on a phone, a bundle's Best Deal is in view beside the game's name and image", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'phone layout only');
  await asPlayer(page, ALICE);
  for (const id of [BUNDLE.id, PICK_BUNDLE.id]) {
    await page.goto(`/lists/bundle/${id}`);
    await expect(rows(page).first()).toBeVisible();
    const head = page.locator('thead th').filter({ hasText: /^Best Deal/ });
    const box = await visibleBox(head);
    expect(box.x + box.width, String(id)).toBeLessThanOrEqual(page.viewportSize()!.width);
    await expect(page.locator('thead th').filter({ hasText: /^Image/ })).toBeVisible(); // kept, only smaller
  }
});

test("B1 edge: on a phone, every game's name stays in view while the table scrolls sideways", async ({
  page,
}, testInfo) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/bundle/90002'); // owned, wishlisted and unowned games
  await expect(rows(page)).toHaveCount(5);
  if (testInfo.project.name !== 'phone') {
    // A desktop table has room for the figures: the name scrolls with them.
    await expect(row(page, 'Hades').locator('td', { hasText: 'Hades' }).first()).toHaveCSS('position', 'static');
    // Pinned or not, the name cell is unstriped like the rest of its row.
    const backgrounds = await page
      .locator('.dt-td.dt-pinned')
      .evaluateAll((cells) => cells.map((c) => getComputedStyle(c).backgroundColor));
    expect(new Set(backgrounds).size).toBe(1);
    return;
  }
  const wrap = page.locator('.dt-table-wrap');
  await wrap.evaluate((el) => (el.scrollLeft = 400));
  const wrapLeft = (await visibleBox(wrap)).x;
  for (const name of ['Hades', "Don't Starve Together"]) {
    const cell = row(page, name).locator('td', { hasText: name }).first();
    expect(Math.round((await visibleBox(cell)).x), name).toBe(Math.round(wrapLeft));
  }
});

test('B1 edge: figures line up: number columns align to the end, text to the start', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto(`/lists/bundle/${BUNDLE.id}`);
  await expect(rows(page)).toHaveCount(4);
  for (const key of ['bestDealPrice', 'bestDealCut', 'steamdbRating'])
    await expect(page.locator(`.dt-td[data-col-key="${key}"]`).first()).toHaveCSS('text-align', 'end');
  await expect(page.locator('.dt-td[data-col-key="name"]').first()).not.toHaveCSS('text-align', 'end');
});

test('B1 edge: an expired bundle is dimmed as a whole row', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.route('**/api/bundles?*', (route) => {
    const req = route.request();
    const body = JSON.parse(respond(req.method(), new URL(req.url()), req.postData()).body);
    body.bundles[0].expiry = new Date(Date.now() - 86400_000).toISOString();
    return route.fulfill({ json: body });
  });
  await page.goto('/bundles');
  await expect(page.locator('.dt-tr.bundle-row--expired')).toHaveCount(1);
  await expect(page.locator('.dt-tr.bundle-row--expired')).toHaveCSS('opacity', '0.45');
});

test('B1 edge: a pick-and-mix bundle prices the selected games', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/bundles');
  await expect(page.getByRole('cell', { name: '1 for $2.00' })).toBeVisible();
  await page.getByRole('cell', { name: 'Test Build Your Own Bundle' }).click();
  await expect(rows(page)).toHaveCount(5);
  // USD-only on a EUR region, so each price carries its estimate, as in the bundle list.
  await expect(page.locator('.bundle-tier-chip')).toHaveText([/^1 for \$2\.00 \(≈ €[\d.]+\)$/, /^3 for \$3\.50 \(≈ €/]);
  // Grouped by what to pick first, the rate (the same on every row) left to the hero and the selection.
  await expect(page.locator('thead th').filter({ hasText: /^Per pick/ })).toHaveCount(0);
  // Alice owns all but Don't Starve Together (Hades, owned and wishlisted, goes with the owned).
  await expect(groupRows(page)).toHaveText([/Not Owned/, /Owned/]);
  await expect(rows(page).first()).toContainText("Don't Starve Together");

  await row(page, 'Portal 2').getByRole('checkbox').check();
  await expect(page.locator('.selection-pick-total')).toHaveText(/^\$2\.00 \(≈ €[\d.]+\)$/);
  await expect(page.locator('.selection-pick-detail')).toHaveText('1 pick · 1-game tier');
  // Alice owns Portal 2: a pick that saves nothing.
  await expect(page.locator('.selection-pick-savings')).toHaveText(/^.+ more$/);
  await expect(page.locator('.selection-pick-owned')).toHaveText('1 you own · not in the saving');
  // Two picks cost less at the 3-game tier than bought one at a time.
  await row(page, 'Hades').getByRole('checkbox').check();
  await expect(page.locator('.selection-pick-total')).toHaveText(/^\$3\.50 \(≈ €/);
  await expect(page.locator('.selection-pick-detail')).toHaveText('2 picks · 3-game tier · 1 more free');
  await expect(page.locator('.bundle-tier-chip--active')).toHaveText(/^3 for \$3\.50/);
  // The saving, in USD like the rate, carries its estimate too.
  await expect(page.locator('.selection-pick-savings')).toHaveText(/\$[\d.]+ \(≈ €[\d.]+\)/);

  // A package's two rows are one pick, ticked and unticked together.
  const pack = rows(page).filter({ hasText: 'package · 2 games' });
  await expect(pack).toHaveText([/Don't Starve Together/, /Hollow Knight/]);
  await pack.nth(0).getByRole('checkbox').check();
  await expect(pack.nth(1).getByRole('checkbox')).toBeChecked();
  await expect(page.locator('.selection-pick-detail')).toHaveText('3 picks · 3-game tier');
  await shot(page, 'pick-and-mix-package-selected');

  // Buying carries the picks, by Fanatical's names, on ITAD's link.
  const buy = page.getByRole('link', { name: 'Buy 3 on Fanatical ↗' });
  const href = new URL((await buy.getAttribute('href')) ?? '');
  expect(href.origin + href.pathname).toBe('https://example.invalid/bundle');
  expect(JSON.parse(href.searchParams.get('scg') ?? '')).toEqual(['Test Survival Pack', 'Portal 2', 'Hades']); // in table order
  await expect(page.getByRole('link', { name: 'Add to Fanatical' })).toHaveAttribute('href', /^javascript:/);
  await row(page, 'Terraria').getByRole('checkbox').check();
  await expect(page.locator('.selection-fanatical-by-hand')).toHaveText('1 to pick by hand');
  await expect(page.getByRole('link', { name: 'Buy 4 on Fanatical ↗' })).toBeVisible();
  await row(page, 'Terraria').getByRole('checkbox').uncheck();

  await pack.nth(1).getByRole('checkbox').uncheck();
  await expect(pack.nth(0).getByRole('checkbox')).not.toBeChecked();

  // A game's panel gives the bundle's best rate rather than "Varies".
  await page.goto('/lists/owned?game=620');
  await expect(page.locator('.panel-bundle').filter({ hasText: 'Test Build Your Own Bundle' })).toContainText(
    /from \$1\.17\/game \(≈ €[\d.]+\)/,
  );
});

test('B1 edge: picking a region reloads Bundles in it', async ({ page }) => {
  await page.goto('/bundles');
  await expect(rows(page).first()).toBeVisible();
  const asked = page.waitForRequest(/\/api\/bundles\?.*country=US/);
  await page.getByLabel('Preferences').click();
  await page.locator('#nav-region-select').selectOption({ label: 'United States (USD)' });
  await asked;
});

for (const close of ['×', 'Esc', 'Back'] as const)
  test(`F1 edge: a game looked up from a page without a list closes back to that page (${close})`, async ({ page }) => {
    await asPlayer(page, ALICE);
    await page.goto('/about');
    await page.goto('/');
    await page.getByPlaceholder('Look up any game…').fill('Hades');
    await page.locator('.game-search-result', { hasText: 'Hades' }).first().click();
    await expect(page).toHaveURL(/\/game\/1145360$/);
    await expect(page.locator('#panel-title')).toHaveText('Hades');
    if (close === '×') await page.getByRole('button', { name: 'Close', exact: true }).click();
    else if (close === 'Esc') await page.keyboard.press('Escape');
    else await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('.game-panel')).toBeHidden();
    // One step: the next Back leaves Home.
    await page.goBack();
    await expect(page).toHaveURL(/\/about$/);
  });

test("F1 edge: a looked-up game's lightbox closes back to its panel, then to the page", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/');
  await page.getByPlaceholder('Look up any game…').fill('Hades');
  await page.locator('.game-search-result', { hasText: 'Hades' }).first().click();
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  await page.getByRole('button', { name: 'Open in lightbox' }).first().click();
  await expect(page.locator('#screenshot-lightbox')).toHaveAttribute('open');
  await page.goBack();
  await expect(page.locator('#screenshot-lightbox')).not.toHaveAttribute('open');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  await expect(page).toHaveURL(/\/game\/1145360$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
});

test('F1 edge: the panel prices a game, and its bundles, in a newly picked region', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.route('**/api/prices?country=US', async (route) => {
    const req = route.request();
    const json = JSON.parse(respond(req.method(), new URL(req.url()), req.postData()).body);
    for (const info of Object.values<Record<string, { currency: string }>>(json.prices))
      for (const field of Object.values(info)) if (field && typeof field === 'object') field.currency = 'USD';
    await route.fulfill({ json });
  });
  await page.goto('/lists/owned?game=892970');
  const amount = page.locator('#game-panel .panel-price-amount');
  await expect(amount).toContainText('€');
  await page.keyboard.press('Escape');
  await expect(page.locator('#game-panel')).toBeHidden();

  await page.getByLabel('Preferences').click();
  await page.locator('#nav-region-select').selectOption({ label: 'United States (USD)' });
  await page.keyboard.press('Escape');
  const bundlesAsked = page.waitForRequest(/\/api\/game-bundles\/892970\?.*country=US/);
  await row(page, 'Valheim').getByText('Valheim').click();
  await expect(amount).toContainText('$');
  await bundlesAsked;
});

test("A2 edge: a cold link to someone's Owned list loads theirs once it resolves", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?u=bob');
  await expect(rows(page)).toHaveCount(BOB.owned.length);
});

test("A2 edge: sorting someone else's Owned list leaves my own layout as it was", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?u=bob');
  await expect(rows(page)).toHaveCount(BOB.owned.length);
  const header = page.locator('.dt-th[data-col-key="releaseDate"]');
  await header.locator('.dt-th-sort').click();
  await expect(page.locator('.pref-unsaved-banner')).toContainText('Save makes it your Owned layout.');
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(ALICE.owned.length);
  await expect(page.locator('.dt-th[data-col-key="releaseDate"]')).not.toHaveAttribute(
    'aria-sort',
    /ascending|descending/,
  );
  await expect(page.locator('.pref-unsaved-banner')).toHaveCount(0);
});

test("B3 edge: a link's account, resolving after the bundle loaded, re-marks what it owns", async ({ page }) => {
  await asPlayer(page, ALICE);
  // Bob's resolve lands after the bundle has been marked with Alice's library.
  await page.route('**/api/common-games', async (route) => {
    if (route.request().postData()?.includes('bob')) await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fallback();
  });
  await page.goto(`/lists/bundle/${BUNDLE.id}?u=bob&game=728880`);
  await expect(row(page, 'Overcooked! 2').locator('.name-status-badge.owned')).toBeVisible();
  await expect(row(page, 'Hades').locator('.name-status-badge.owned')).toHaveCount(0);
  await expect(page.locator('#game-panel .panel-ownership-badge.owned')).toBeVisible();
  await expect(page.getByRole('link', { name: 'What does this add?' })).toHaveAttribute(
    'href',
    new RegExp(BOB.steamid),
  );
});

test('B1 edge: with no ITAD key, Bundles says why it is empty', async ({ page }) => {
  await mockApi(page, { states: ['no-itad'] }); // registered last, so it answers first
  await asPlayer(page, ALICE);
  await page.goto('/bundles');
  await expect(page.getByRole('main')).toContainText("Bundles and prices aren't available on this instance");
  await expect(page.getByRole('main')).not.toContainText(/ITAD_API_KEY|Error:/);
});

test('O1 edge: with no ITAD key, Bundles is one card saying how to turn it on, not an empty table', async ({
  page,
}) => {
  await mockApi(page, { states: ['no-itad'] }); // registered last, so it answers first
  await asPlayer(page, ALICE);
  await page.goto('/bundles');
  const card = page.locator('.list-hero');
  await expect(card).toContainText('IsThereAnyDeal API key');
  await expect(card.locator('.list-stat')).toHaveCount(0);
  await expect(page.getByLabel('Include expired')).toHaveCount(0);
  await expect(page.locator('.table-container')).toHaveCount(0);
});

test('O1 edge: once the instance is known to have no ITAD key, Bundles opens on its card without asking ITAD', async ({
  page,
}) => {
  await mockApi(page, { states: ['no-itad'] }); // registered last, so it answers first
  await asPlayer(page, ALICE);
  await page.goto('/lists/wishlist');
  await expect(page.getByRole('main')).toContainText("Prices aren't available on this instance");
  await page.route('**/api/bundles?*', () => {}); // never answers: the card can't wait on its 503
  await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name: 'Bundles' }).click();
  await expect(page.locator('.list-hero')).toContainText('IsThereAnyDeal API key');
  await expect(page.getByLabel('Include expired')).toHaveCount(0);
  await expect(page.locator('.table-container')).toHaveCount(0);
});

test('B1 edge: stepping onto the last bundle keeps focus on › Next bundle, marked unavailable', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/bundles');
  await page.getByRole('cell', { name: BUNDLE.title }).click();
  const next = page.getByRole('button', { name: 'Next bundle' });
  await next.focus();
  await next.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/lists/bundle/${PICK_BUNDLE.id}(\\?|$)`));
  await expect(next).toHaveAttribute('aria-disabled', 'true');
  await expect(next).toBeFocused();
  await next.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/lists/bundle/${PICK_BUNDLE.id}(\\?|$)`));
});

test('B1 edge: a deep-linked bundle with no browsed list around it disables ‹/› outright', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto(`/lists/bundle/${BUNDLE.id}`);
  await expect(page.getByRole('heading', { level: 1, name: BUNDLE.title })).toBeVisible();
  // `disabled`, not just aria-disabled: no dead Tab stops.
  await expect(page.getByRole('button', { name: 'Previous bundle' })).toHaveJSProperty('disabled', true);
  await expect(page.getByRole('button', { name: 'Next bundle' })).toHaveJSProperty('disabled', true);
});

test("B1 edge: a failed ‹/› step doesn't pull focus back to it on a later load", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.route(`**/api/bundles/${PICK_BUNDLE.id}*`, (route) =>
    route.fulfill({ status: 502, json: { error: 'ITAD is down' } }),
  );
  await page.goto('/bundles');
  await page.getByRole('cell', { name: BUNDLE.title }).click();
  const hero = page.getByRole('heading', { level: 1, name: BUNDLE.title });
  await expect(hero).toBeVisible();
  const next = page.getByRole('button', { name: 'Next bundle' });
  await next.focus();
  await next.press('Enter');
  await expect(page.getByRole('main')).toContainText('ITAD is down');
  await page.goBack();
  await expect(hero).toBeVisible();
  await expect(next).not.toBeFocused();
});

test('B1 edge: games ITAD lists under the first tier only show the tier range', async ({ page }) => {
  await mockApi(page, { states: ['untiered'] });
  await asPlayer(page, ALICE);
  await page.goto(`/lists/bundle/${BUNDLE.id}`);
  await expect(rows(page)).toHaveCount(4);
  // The pricier tier lists no games, so any of them may sit in it.
  await expect(groupRows(page)).toHaveText([/€5\.00–€12\.00 · which tier isn't listed/]);
  // The side panel's Price card says the same.
  await row(page, 'Overcooked! 2').getByText('Overcooked! 2').click();
  await expect(page.locator('#panel-body').getByTitle(/doesn't say which tier/)).toHaveText('€5.00–€12.00 tier');
});

test("B2 edge: another region's prices state their own age, not the previous region's", async ({ page }) => {
  await asPlayer(page, ALICE);
  const threeDaysAgo = Date.now() - 3 * 86400_000;
  await page.route(/\/api\/prices\?/, (route) => {
    const req = route.request();
    const { body } = respond(req.method(), new URL(req.url()), req.postData());
    return route.fulfill({ json: { ...JSON.parse(body), fetchedAt: threeDaysAgo } });
  });
  await page.goto('/lists/wishlist');
  const prices = page.locator('.list-stat', { hasText: 'Prices' });
  await expect(prices).toContainText('3 days ago');

  await page.unroute(/\/api\/prices\?/);
  await page.getByTitle('Preferences').click();
  await page.locator('#nav-region-select').selectOption({ label: 'United States (USD)' });
  await expect(prices).toContainText('United States');
  await expect(prices).toContainText('just now');
});

test("B2 edge: a long wishlist's Prices age is its stalest chunk's, whatever the order", async ({ page }) => {
  await asPlayer(page, ALICE);
  // 501 games: two price calls of up to 500, the first served from a 3-day-old cache, the second fresh.
  const items = Array.from({ length: 501 }, (_, i) => ({ appid: 900000 + i, priority: 0, dateAdded: '2026-01-01' }));
  await page.route(/\/api\/wishlist/, (route) => route.fulfill({ json: { items, players: [], fetchedAt: null } }));
  await page.route(/\/api\/game-details\/stream/, (route) =>
    route.fulfill({ contentType: 'text/event-stream', body: 'data: {"done":true}\n\n' }),
  );
  const ages = [Date.now() - 3 * 86400_000, null];
  await page.route(/\/api\/prices/, (route) =>
    route.fulfill({ json: { prices: {}, fetchedAt: ages.shift() ?? null } }),
  );
  let priceCalls = 0;
  const secondChunk = page.waitForResponse((res) => /\/api\/prices/.test(res.url()) && ++priceCalls === 2);
  await page.goto('/lists/wishlist');
  // Only the second chunk can get it wrong, so read the readout once it has landed, not before.
  await secondChunk;
  await page.evaluate(() => new Promise(requestAnimationFrame));
  expect(await page.locator('.list-stat', { hasText: 'Prices' }).textContent()).toContain('3 days ago');
});

test("B4 edge: a friend's empty wishlist says it may be private, where the table would be", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/wishlist?u=carol'); // Carol has no wishlist in the fixtures
  const empty = page.getByText("Carol's wishlist is empty, or private on Steam.");
  await expect(empty).toBeVisible();
  await expect(page.locator('.dt-toolbar')).toBeHidden();
});

test('B2 edge: with no ITAD key, the Wishlist hides prices and says why', async ({ page }) => {
  await mockApi(page, { states: ['no-itad'] }); // registered last, so it answers first
  await asPlayer(page, ALICE);
  await page.goto('/lists/wishlist');
  await expect(rows(page)).toHaveCount(4);
  const unavailable = "Prices aren't available on this instance: it isn't connected to IsThereAnyDeal.";
  await expect(page.getByRole('main')).toContainText(unavailable);
  await expect(page.locator('thead th').filter({ hasText: /^Best Deal/ })).toHaveCount(0);
  await expect(page.locator('.list-stat-label').filter({ hasText: 'Prices' })).toHaveCount(0);
  await row(page, 'It Takes Two').getByText('It Takes Two').click();
  await expect(page.locator('#panel-section-price')).toContainText(unavailable);
  await expect(page.locator('.panel-bundles')).toHaveCount(0); // the line above already says why
});

test("B2 edge: a health check that didn't answer doesn't hide the Wishlist's prices", async ({ page }) => {
  await page.route('**/api/health', (route) => route.fulfill({ status: 502, json: { error: 'Bad gateway' } }));
  await asPlayer(page, ALICE);
  await page.goto('/lists/wishlist');
  await expect(rows(page)).toHaveCount(4);
  await expect(page.locator('thead th').filter({ hasText: /^Best Deal/ })).toHaveCount(1);
  await expect(page.getByRole('main')).not.toContainText("Prices aren't available on this instance");
});

test('D1 edge: the Updated tile keeps the rows and the selection while it refreshes', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  await row(page, 'Portal 2').getByRole('checkbox').check();
  // Holds the library refresh, so the table can be checked mid-way.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/api\/common-games\?refresh=1$/, async (route) => {
    await held;
    await route.fallback();
  });
  await page.getByRole('button', { name: /^Updated\b/ }).click();
  await expect(page.locator('.list-stat', { hasText: 'Updated' })).toContainText('Refreshing');
  await expect(rows(page)).toHaveCount(6);
  await expect(row(page, 'Hades')).toContainText('44.5'); // details still on screen
  release();
  await expect(page.locator('.list-stat', { hasText: 'Updated' })).not.toContainText('Refreshing');
  await expect(rows(page)).toHaveCount(6);
  await expect(row(page, 'Portal 2').getByRole('checkbox')).toBeChecked();
});

test('D1 edge: the Updated tile keeps focus while it refreshes', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/api\/common-games\?refresh=1$/, async (route) => {
    await held;
    await route.fallback();
  });
  const tile = page.getByRole('button', { name: /^Updated/ });
  await tile.click();
  await expect(tile).toContainText('Refreshing');
  await expect(tile).toBeFocused();
  release();
  await expect(tile).not.toContainText('Refreshing');
  await expect(tile).toBeFocused();
});

test('D1 edge: a failed Updated refresh leaves the tile there to try again', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/compare?u=alice&u=bob');
  await expect(groupRows(page)).toHaveCount(3);
  await page.route(/\/api\/common-games\?refresh=1$/, (route) =>
    route.fulfill({ status: 502, json: { error: 'Steam request failed' } }),
  );
  const updated = page.locator('.list-stat', { hasText: 'Updated' });
  const updatedBtn = page.getByRole('button', { name: /^Updated\b/ });
  await updatedBtn.click();
  await expect(page.getByRole('main')).toContainText('Steam request failed');
  await expect(updated).not.toContainText('Refreshing');
  await expect(page.locator('.list-formula')).toBeVisible();

  await page.unroute(/\/api\/common-games\?refresh=1$/);
  await updatedBtn.click();
  await expect(page.getByRole('main')).not.toContainText('Steam request failed');
});

test("D1 edge: Home's ↻ updates the ✓ marks shown elsewhere", async ({ page }) => {
  await asPlayer(page, ALICE, { recentGames: [728880] }); // Overcooked! 2: Bob's, not Alice's
  await page.goto('/');
  await expect(page.locator('.account-counts')).toContainText('Owned: 6');
  const box = page.getByPlaceholder('Look up any game…');
  const option = page.getByRole('option', { name: /Overcooked! 2/ });
  await box.focus();
  await expect(option).toBeVisible();
  await expect(option.locator('.game-search-badge.owned')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Bought since: the refreshed library has it.
  await page.route(/\/api\/common-games\?refresh=1$/, (route) => {
    const req = route.request();
    const body = JSON.parse(respond(req.method(), new URL(req.url()), req.postData()).body);
    body.games.push({ appid: 728880, name: 'Overcooked! 2' });
    body.playtime[728880] = { [ALICE.steamid]: 0 };
    return route.fulfill({ json: body });
  });
  await page.locator('.account-updated-btn').click();
  await expect(page.locator('.account-counts')).toContainText('Owned: 7');
  await box.focus();
  await expect(option.locator('.game-search-badge.owned')).toBeVisible();
});

test('D1 edge: an Owned list that failed to load still offers the Updated tile', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.route('**/api/common-games', (route) =>
    route.fulfill({ status: 502, json: { error: 'Steam request failed' } }),
  );
  await page.goto('/lists/owned');
  await expect(page.getByRole('main')).toContainText('Steam request failed');
  await page.unroute('**/api/common-games');
  await page.getByRole('button', { name: /^Updated\b/ }).click();
  await expect(rows(page)).toHaveCount(6);
});

test('D2.1-2: with upstreams down, every game is still listed', async ({ page }) => {
  await mockApi(page, { states: ['upstream-down'] });
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  await expect(row(page, 'Hades')).toContainText('0.8'); // playtime comes from the library, not an upstream
  // A failed source is marked apart from "no data", and counted where the list says how it loaded.
  await expect(row(page, 'Hades').getByTitle(/HowLongToBeat didn't answer/)).toBeVisible();
  await expect(page.locator('.list-status')).toContainText(
    "Steam reviews, HowLongToBeat and ProtonDB didn't answer for 6 games",
  );
  await row(page, 'Hades').getByText('Hades').click();
  await expect(page.locator('.panel-glance-chip').filter({ hasText: 'HLTB' })).toContainText("didn't answer");
});

test("D2 edge: with ITAD down, the Wishlist's price cells and Price card say it didn't answer", async ({ page }) => {
  await mockApi(page, { states: ['upstream-down'] });
  await asPlayer(page, ALICE);
  await page.goto('/lists/wishlist');
  await expect(rows(page)).toHaveCount(4);
  await expect(row(page, 'Overcooked! 2').getByTitle(/IsThereAnyDeal didn't answer/)).not.toHaveCount(0);
  await row(page, 'Overcooked! 2').getByText('Overcooked! 2').click();
  const card = page.locator('#panel-section-price');
  await expect(card).toContainText("IsThereAnyDeal didn't answer");
  await expect(card).not.toContainText('No pricing data available');
});

test('D2 edge: failed prices warn like the other sources, in plain words', async ({ page }) => {
  await mockApi(page, { states: ['upstream-down'] });
  await asPlayer(page, ALICE);
  await page.goto('/lists/wishlist');
  await expect(rows(page)).toHaveCount(4);
  const status = page.locator('.price-status');
  await expect(status).toHaveText("IsThereAnyDeal didn't answer for prices — refresh them on the Prices tile");
  const warnColor = await page.locator('.list-status .list-failed').evaluate((el) => getComputedStyle(el).color);
  await expect(status).toHaveCSS('color', warnColor);
});

test('D2 edge: past its share of lookups, the list says so once, as do the Price and Achievements cards', async ({
  page,
}) => {
  await mockApi(page, { states: ['client-limited'] });
  await asPlayer(page, ALICE);
  await page.goto('/lists/wishlist');
  await expect(rows(page)).toHaveCount(4);
  const status = page.locator('.list-status');
  await expect(status.locator('.list-failed')).toHaveText(LIMITED);
  await expect(status).not.toContainText("didn't answer");
  await expect(page.locator('.price-status')).toHaveText(LIMITED);
  await expect(page.locator('.price-status')).toHaveClass(/list-failed/);
  await page.goto('/lists/owned?game=1145360');
  await expect(page.locator('#panel-section-price')).toContainText(LIMITED);
  await expect(page.locator('#panel-section-achievements')).toContainText(LIMITED);
});

test("D2.3: once the upstream is back, the panel's Refresh details fills in what didn't answer", async ({ page }) => {
  await mockApi(page, { states: ['upstream-down'] });
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await row(page, 'Hades').getByText('Hades').click();
  const hltb = page.locator('.panel-glance-chip').filter({ hasText: 'HLTB' });
  await expect(hltb).toContainText("didn't answer");

  await mockApi(page); // the upstream is back: routes registered last take precedence
  await page.locator('.panel-refresh-btn').click();
  await expect(hltb).not.toContainText("didn't answer");
  await expect(row(page, 'Hades').getByTitle(/HowLongToBeat didn't answer/)).toHaveCount(0);
});

// The /api/game-meta paths the page asks for from now on.
function gameMetaRequests(page: Page): string[] {
  const paths: string[] = [];
  page.on('request', (req) => {
    const { pathname } = new URL(req.url());
    if (pathname.startsWith('/api/game-meta/')) paths.push(pathname);
  });
  return paths;
}

test('D2 edge: a failed Steam store page is marked, not shown as missing data', async ({ page }, testInfo) => {
  await mockApi(page, { states: ['store-down'] });
  await asPlayer(page, ALICE);
  const metaAsked = gameMetaRequests(page);
  await page.clock.install();
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  await expect(page.locator('.list-status')).toContainText("Steam store didn't answer for 6 games");
  // The phone layout hides the store columns; the status line above still says it.
  if (testInfo.project.name === 'desktop')
    await expect(
      row(page, 'Hades')
        .getByTitle(/Steam store didn't answer/)
        .first(),
    ).toBeVisible();
  // Opened, it asks for no media: they come with the store page ↻ retries.
  await row(page, 'Hades').getByText('Hades').click();
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  await page.clock.runFor(300);
  expect(metaAsked).toEqual([]);
});

test('D2 edge: a refused details stream marks every game failed, not loading forever', async ({ page }) => {
  await page.route('**/api/game-details/stream', (route) =>
    route.fulfill({ status: 429, json: { error: 'Too many requests. Please wait a minute and try again.' } }),
  );
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  await expect(page.locator('.list-status')).toContainText('Too many requests');
  await expect(page.locator('.list-status')).toContainText("Steam store and Steam tags didn't answer for 6 games");
  await expect(page.locator('.list-status')).not.toContainText('/ 6 games loaded');
  await expect(row(page, 'Hades').getByTitle(/HowLongToBeat didn't answer/)).toBeVisible();
});

test("D2 edge: a link's screenshot of a game with no store page isn't opened on the next game", async ({ page }) => {
  await page.route('**/api/game-details/stream', (route) => {
    const req = route.request();
    const full = respond(req.method(), new URL(req.url()), req.postData());
    // Hades' store page answers with nothing: no metadata, and no failure to retry.
    const body = full.body
      .split('\n\n')
      .map((line: string) => {
        if (!line.startsWith('data: ')) return line;
        const event = JSON.parse(line.slice(6));
        return event.appid === 1145360 ? `data: ${JSON.stringify({ ...event, meta: null })}` : line;
      })
      .join('\n\n');
    return route.fulfill({ ...full, body });
  });
  await asPlayer(page, ALICE);
  const metaAsked = gameMetaRequests(page);
  await page.clock.install();
  await page.goto('/lists/owned?game=1145360&shot=s1');
  await expect(rows(page)).toHaveCount(6);
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  // No more media will come: the link opens on what there is.
  const lightbox = page.locator('#screenshot-lightbox');
  await expect(lightbox.locator('.lb-status')).toContainText('Cover');
  await page.keyboard.press('Escape');
  await expect(lightbox).not.toHaveAttribute('open');
  // A phone's panel covers the table.
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await row(page, 'Portal 2').getByText('Portal 2').click();
  await expect(page.locator('#panel-title')).toHaveText('Portal 2');
  await page.clock.runFor(300);
  await expect(lightbox).not.toHaveAttribute('open');
  expect(metaAsked).not.toContain('/api/game-meta/1145360'); // no store page, no media to ask for
});

test('D2 edge: a game with no store page keeps its CDN thumbnail and the panel says why it is empty', async ({
  page,
}) => {
  await page.route('**/api/game-details/stream', (route) => {
    const req = route.request();
    const full = respond(req.method(), new URL(req.url()), req.postData());
    const body = full.body
      .split('\n\n')
      .map((line: string) => {
        if (!line.startsWith('data: ')) return line;
        const event = JSON.parse(line.slice(6));
        return event.appid === 1145360 ? `data: ${JSON.stringify({ ...event, meta: null })}` : line;
      })
      .join('\n\n');
    return route.fulfill({ ...full, body });
  });
  // Served, else its load error swaps in the smaller capsule before the check.
  await page.route('**/1145360/capsule_231x87.jpg', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="231" height="87"/>',
    }),
  );
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360');
  await expect(row(page, 'Hades').locator('.game-thumb')).toHaveAttribute(
    'src',
    'https://cdn.akamai.steamstatic.com/steam/apps/1145360/capsule_231x87.jpg',
  );
  await expect(page.locator('.panel-no-data', { hasText: 'No Steam store page' })).toBeVisible();
});

test('D2 edge: a looked-up game with no store page is named from its achievement schema', async ({ page }) => {
  await page.route('**/api/game-details/stream', (route) => {
    const req = route.request();
    const full = respond(req.method(), new URL(req.url()), req.postData());
    const body = full.body
      .split('\n\n')
      .map((line: string) => {
        if (!line.startsWith('data: ')) return line;
        const event = JSON.parse(line.slice(6));
        return event.appid === 1145360
          ? `data: ${JSON.stringify({ ...event, meta: null, name: 'Hades Schema Name' })}`
          : line;
      })
      .join('\n\n');
    return route.fulfill({ ...full, body });
  });
  await page.goto('/game/1145360');
  await expect(page.locator('#panel-title')).toHaveText('Hades Schema Name');
  await expect(page.locator('.panel-no-data', { hasText: 'No Steam store page' })).toBeVisible();
});

test("D2 edge: a game the details stream refused shows no age, and its link's screenshot waits for ↻", async ({
  page,
}) => {
  await page.route('**/api/game-details/stream', (route) =>
    route.fulfill({ status: 429, json: { error: 'Too many requests. Please wait a minute and try again.' } }),
  );
  await asPlayer(page, ALICE);
  const metaAsked = gameMetaRequests(page);
  await page.goto('/lists/owned?game=1145360&shot=s1');
  await expect(page.locator('.list-status')).toContainText('Too many requests');
  await expect(page.locator('.panel-glance')).toContainText("didn't answer");
  // Nothing was fetched, so nothing is "just now".
  await expect(page.locator('.panel-refresh-age')).toHaveCount(0);
  const lightbox = page.locator('#screenshot-lightbox');
  await expect(lightbox).not.toHaveAttribute('open');
  // With no age to show, ↻ still says it's working.
  let land = () => {};
  const landed = new Promise<void>((resolve) => (land = resolve));
  await page.route(/\/api\/game-details\/1145360\?refresh=1$/, async (route) => {
    await landed;
    await route.fallback();
  });
  await page.getByRole('button', { name: 'Refresh details' }).click();
  await expect(page.locator('.panel-refresh-age')).toHaveText('Refreshing…');
  land();
  await expect(lightbox).toHaveAttribute('open');
  await expect(page).toHaveURL(/[?&]shot=s1\b/);
  expect(metaAsked).not.toContain('/api/game-meta/1145360'); // ↻'s details carry the media
});

test('D2 edge: a details stream cut short marks the games it never sent failed', async ({ page }) => {
  await page.route('**/api/game-details/stream', (route) => {
    const req = route.request();
    const full = respond(req.method(), new URL(req.url()), req.postData());
    // The first two games' events only, and no `done`: the connection dropped.
    return route.fulfill({ ...full, body: full.body.split('\n\n').slice(0, 2).join('\n\n') + '\n\n' });
  });
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  await expect(page.locator('.list-status')).toContainText("didn't answer for 4 games");
  await expect(page.locator('.list-status')).not.toContainText('/ 6 games loaded');
});

// The server sends an uncached game as a fast part, then a store part under Steam's store details cap.
test("D2 edge: a game's store part, in either order or cut off, fails only the Steam store", async ({ page }) => {
  const BASICS = ['name', 'type', 'capsule', 'thumb', 'banner', 'description', 'releaseDate', 'comingSoon'] as const;
  await page.route('**/api/game-details/stream', (route) => {
    const req = route.request();
    const full = respond(req.method(), new URL(req.url()), req.postData());
    const lines = full.body.split('\n\n').flatMap((line: string) => {
      if (!line.startsWith('data: ')) return [line];
      const { meta, fetchedAts, failed, ...event } = JSON.parse(line.slice(6));
      if (!event.appid) return [line];
      const basics = meta && Object.fromEntries(BASICS.map((key) => [key, meta[key]]));
      const fast = { ...event, part: 'fast', basics, failed: failed?.filter((s: string) => s !== 'meta') };
      const store = { appid: event.appid, part: 'store', meta };
      // Portal 2's store part first; Hades' never comes: the connection dropped before it.
      const parts = event.appid === 1145360 ? [fast] : event.appid === 620 ? [store, fast] : [fast, store];
      return parts.map((part) => `data: ${JSON.stringify(part)}`);
    });
    return route.fulfill({
      ...full,
      body: lines.filter((line: string) => !line.includes('"done"')).join('\n\n') + '\n\n',
    });
  });
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  await expect(page.locator('.list-status')).toContainText("Steam store didn't answer for 1 game");
  await expect(row(page, 'Hades').getByTitle(/HowLongToBeat didn't answer/)).toHaveCount(0);
  await expect(row(page, 'Portal 2').getByTitle(/didn't answer/)).toHaveCount(0);
  await row(page, 'Portal 2').getByText('Portal 2').click();
  await expect(page.locator('.panel-glance')).not.toContainText('still loading');
});

test("F1 edge: the Price card shows no bundles while the next game's are loading", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=620');
  await expect(page.locator('.panel-bundle').first()).toBeVisible();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/game-bundles/**', async (route) => {
    await held;
    await route.fallback();
  });
  const asked = page.waitForRequest(/\/api\/game-bundles\//);
  await page.getByRole('button', { name: 'Next game' }).click();
  await asked;
  await expect(page.locator('#panel-section-price')).toBeVisible();
  await expect(page.locator('.panel-bundles')).toHaveCount(0);
  release();
  await expect(page.locator('.panel-bundles')).toBeVisible();
});

test("F1 edge: the Price card says when a game is in no bundle, and when ITAD didn't answer", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=892970');
  await expect(page.locator('.panel-bundles')).toHaveText('Not in any current bundle.');

  await mockApi(page, { states: ['upstream-down'] }); // registered last, so it answers first
  await page.goto('/lists/owned?game=1145360');
  await expect(page.locator('.panel-bundles')).toHaveText("Bundles: IsThereAnyDeal didn't answer.");
});

test("B1 edge: a bundle's Add-on and Base pills are outlined alike, a fact rather than a state", async ({ page }) => {
  await page.route(new RegExp(`/api/bundles/${BUNDLE.id}(\\?|$)`), (route) => {
    const req = route.request();
    const body = JSON.parse(respond(req.method(), new URL(req.url()), req.postData()).body);
    body.bundle.tiers.at(-1).addon = true;
    return route.fulfill({ json: body });
  });
  await asPlayer(page, ALICE);
  await page.goto(`/lists/bundle/${BUNDLE.id}`);
  await expect(rows(page)).toHaveCount(4);
  await page.getByRole('button', { name: 'Columns', exact: true }).click();
  await page
    .locator('.dt-dd')
    .getByRole('button', { name: /^Classification/ })
    .click();
  await page.locator('.dt-dd').getByRole('button', { name: 'Add-on' }).click();
  await page.keyboard.press('Escape');
  const pill = (name: string) => row(page, name).locator('.status-badge');
  await expect(pill('Overcooked! 2')).toHaveText('Add-on');
  await expect(pill('Portal 2')).toHaveText('Base');
  for (const name of ['Overcooked! 2', 'Portal 2']) {
    await expect(pill(name)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(pill(name)).toHaveCSS('color', 'rgb(195, 204, 217)'); // --text-body
  }
});

test('F1 edge: a free demo shows as a neutral Demo pill and a Try the Free Demo button', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/wishlist');
  const pill = row(page, 'It Takes Two').locator('.status-badge');
  await expect(pill).toHaveText('Demo');
  await expect(pill).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)'); // outlined, not the accent
  await expect(row(page, 'Overcooked! 2').locator('.status-badge')).toHaveCount(0);
  await row(page, 'It Takes Two').getByText('It Takes Two').click();
  const demo = page.getByRole('link', { name: 'Try the Free Demo' });
  await expect(demo).toHaveAttribute('href', `https://store.steampowered.com/app/${DEMO_OF[1426210]}`);
  await expect(demo).not.toHaveClass(/btn-primary/);
});

test('F1 edge: the Price card names its ★ and 🔥 records in visible text, not only in a tooltip', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=892970');
  await expect(page.locator('.panel-price-line')).toContainText(/★\s*1-year low/);
  await expect(page.locator('.panel-price-low')).toHaveText(/^all-time low €\d+\.\d\d 🔥$/);
});

test("F1 edge: the Achievements card says when Steam didn't answer for rarity", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360');
  const card = page.locator('#panel-section-achievements');
  await card.getByRole('button', { name: /Achievements/ }).click();
  await expect(card).toContainText('71.5%');
  await expect(card).not.toContainText("Rarity: Steam didn't answer.");

  await mockApi(page, { states: ['upstream-down'] }); // registered last, so it answers first
  await page.reload();
  await card.getByRole('button', { name: /Achievements/ }).click();
  await expect(card).toContainText("Rarity: Steam didn't answer.");
});

test("F1 edge: the panel doesn't link an upstream URL that isn't http(s)", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=892970');
  const chip = page.locator('.panel-glance-chip', { hasText: 'Metacritic' });
  await expect(chip).toBeVisible();
  await expect(chip).not.toHaveAttribute('href', /.*/);
});

test("F1 edge: Tags & details names each chip's kind, and draws each kind's dot its own shape", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=620');
  const chips = page.locator('.panel-tags').getByRole('button');
  await expect(chips.first()).toBeVisible();
  for (const name of ['Co-op, tag', 'Co-op, category'])
    await expect(page.locator('.panel-tags').getByRole('button', { name, exact: true })).toBeVisible();
  const names = await chips.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
  expect(new Set(names).size).toBe(names.length);
  const shapes = await page.locator('.panel-tag-legend .panel-tag-dot').evaluateAll((dots) =>
    dots.map((d) => {
      const s = getComputedStyle(d);
      return `${s.borderRadius} ${s.rotate} ${s.clipPath}`;
    }),
  );
  expect(shapes.length).toBeGreaterThanOrEqual(3);
  expect(new Set(shapes).size).toBe(shapes.length);
  const colours = await page
    .locator('.panel-tag-legend .panel-tag-dot')
    .evaluateAll((dots) => dots.map((d) => getComputedStyle(d).backgroundColor));
  expect(colours).not.toContain('rgba(0, 0, 0, 0)');
  expect(new Set(colours).size).toBe(colours.length);
});

// A failed health check stops the panel before its price lookup, so each failure gets its own run.
for (const failing of ['health', 'prices']) {
  test(`F1 edge: the Price card says when ITAD didn't answer its ${failing} call, and the panel's Refresh details retries it`, async ({
    page,
  }) => {
    let down = true;
    await page.route(new RegExp(`/api/${failing}(\\?|$)`), (route) =>
      down ? route.fulfill({ status: 502, json: { error: 'IsThereAnyDeal request failed' } }) : route.fallback(),
    );
    await asPlayer(page, ALICE);
    await page.goto('/lists/owned?game=1145360');
    const card = page.locator('#panel-section-price');
    await expect(card).toContainText("IsThereAnyDeal didn't answer");
    await expect(card).not.toContainText('No pricing data available');

    down = false;
    await page.getByRole('button', { name: 'Refresh details' }).click();
    await expect(card).toContainText('Buy at Test Shop');
  });
}

test("F1 edge: a DLC's capsule that fails to load hides, keeping its box", async ({ page }) => {
  await page.route('**/900001/capsule_231x87.jpg', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="231" height="87"/>',
    }),
  );
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360');
  const card = page.locator('#panel-section-dlc');
  await card.getByRole('button', { name: /DLC · 25 available/ }).click();
  const capsule = (name: string) =>
    card.locator('.panel-dlc-item', { hasText: new RegExp(`^${name}$`) }).locator('img');
  await expect(capsule('Expansion 1')).toHaveCSS('visibility', 'visible');
  await expect(capsule('Expansion 2')).toHaveCSS('visibility', 'hidden');
  expect(await capsule('Expansion 2').boundingBox()).toMatchObject({ width: 80, height: 30 });
});

test("F1 edge: a loading video's ▶ stays put while the hero shimmers", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  // The hero as it stands while a trailer's poster loads.
  const pseudo = await page.locator('#panel-hero .panel-hero-main').evaluate((el) => {
    el.classList.add('is-video', 'panel-hero-main--loading');
    const style = (which: string) => {
      const s = getComputedStyle(el, which);
      return { content: s.content, animation: s.animationName };
    };
    return { before: style('::before'), after: style('::after') };
  });
  expect(pseudo.before).toEqual({ content: '"▶"', animation: 'none' });
  expect(pseudo.after.animation).toBe('shimmer');
});

test('F1 edge: DLC entries streamed in stay put, not redrawn, once the rest arrive', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/game-meta/900020', async (route) => {
    await held;
    await route.fallback();
  });
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360');
  const card = page.locator('#panel-section-dlc');
  await card.getByRole('button', { name: /DLC · 25 available/ }).click();
  await expect(card.getByText('Loading 1 more…')).toBeVisible();
  const order = () => card.locator('.panel-dlc-name').allTextContents();
  const before = await order();
  await card.locator('.panel-dlc-item').evaluateAll((items) => items.forEach((el) => el.setAttribute('data-seen', '')));
  release();
  await expect(card.getByText('Loading 1 more…')).toHaveCount(0);
  await expect(card.locator('.panel-dlc-item')).toHaveCount(20);
  // Every entry already on screen is the same element, in the same order: no remount, no reload of its capsule.
  await expect(card.locator('.panel-dlc-item[data-seen]')).toHaveCount(19);
  expect((await order()).filter((name) => before.includes(name))).toEqual(before);
});

test('F1 edge: the DLC card lists 20 entries from store metadata, then more on request', async ({ page }) => {
  const requested: string[] = [];
  page.on('request', (req) => {
    if (/\/api\/game-(details|meta)\/9000\d\d/.test(req.url())) requested.push(new URL(req.url()).pathname);
  });
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360');
  const card = page.locator('#panel-section-dlc');
  await card.getByRole('button', { name: /DLC · 25 available/ }).click();
  await expect(card.locator('.panel-dlc-item')).toHaveCount(20);
  expect(requested.every((p) => p.startsWith('/api/game-meta/'))).toBe(true);
  expect(requested).toHaveLength(20);

  await card.getByRole('button', { name: 'Show 5 more' }).click();
  await expect(card.locator('.panel-dlc-item')).toHaveCount(25);
  await expect(card.getByRole('button', { name: /Show \d+ more/ })).toHaveCount(0);
  expect(requested).toHaveLength(25);
});

test('F1 edge: the panel section nav highlights the section it jumped to', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await row(page, 'Hades').getByText('Hades').click();
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  const nav = page.locator('.panel-subnav');
  await nav.getByRole('button', { name: 'Achievements' }).click();
  await expect(nav.getByRole('button', { name: 'Achievements' })).toHaveClass(/active/);
  await expect(nav.getByRole('button', { name: 'Overview' })).not.toHaveClass(/active/);
});

test("F1 edge: a section arriving adds its tab to the panel's tabs without rebuilding the others", async ({ page }) => {
  await asPlayer(page, ALICE);
  const achievements = await gate(page, '**/api/achievements/**');
  await page.goto('/lists/owned?game=1145360');
  const list = page.locator('.panel-subnav-list');
  await expect(list.getByRole('button', { name: 'DLC' })).toBeAttached();
  const owners = await list.getByRole('button', { name: 'Owned by' }).elementHandle();
  achievements.release();
  await expect(list.getByRole('button', { name: 'Achievements' })).toBeAttached();
  // Rebuilt, a tab a test or a finger is on would leave the page under it.
  expect(await owners!.evaluate((el) => el.isConnected)).toBe(true);
});

test("F1 edge: on a narrow phone, the panel's tabs stay one row and scroll to the current one", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'phone layout');
  await page.setViewportSize({ width: 320, height: 844 });
  await asPlayer(page, ALICE);
  const achievements = await gate(page, '**/api/achievements/**');
  await page.goto('/lists/owned?game=1145360');
  const list = page.locator('.panel-subnav-list');
  const last = list.getByRole('button', { name: 'DLC' });
  await expect(last).toBeAttached();
  const oneRow = async () =>
    new Set(await list.locator('li').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top))).size;
  expect(await oneRow()).toBe(1);

  await page.locator('#panel-body').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(last).toHaveClass(/active/);
  // A tab arriving before the current one pushes it along: it's brought back into view.
  await expect(list.getByRole('button', { name: 'Achievements' })).toHaveCount(0);
  achievements.release();
  await expect(list.getByRole('button', { name: 'Achievements' })).toBeAttached();
  await page.locator('#panel-body').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(last).toHaveClass(/active/);
  expect(await oneRow()).toBe(1);
  await expect
    .poll(() =>
      last.evaluate((el) => {
        const [b, l] = [el.getBoundingClientRect(), el.closest('ul')!.getBoundingClientRect()];
        return b.left >= l.left && b.right <= l.right + 1;
      }),
    )
    .toBe(true);
});

test('F1 edge: the panel closes from its Close button after scrolling it', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await row(page, 'Hades').getByText('Hades').click();
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  await page.locator('#panel-body').evaluate((el) => el.scrollTo(0, 400));
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('#game-panel')).toBeHidden();
});

test('M3 edge: fullscreen media turns a phone to landscape, and keeps it there', async ({ page }) => {
  // Desktop browsers reject the lock, so record the calls instead.
  await page.addInitScript(() => {
    const w = window as Window & { locks?: string[] };
    w.locks = [];
    screen.orientation.lock = async (type: string) => void w.locks!.push(type);
    screen.orientation.unlock = () => void w.locks!.push('unlock');
  });
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await row(page, 'Hades').getByText('Hades').click();
  await page.getByRole('button', { name: 'Open in lightbox' }).click();
  await page.getByRole('button', { name: 'Enter fullscreen' }).click();
  const locks = () => page.evaluate(() => (window as Window & { locks?: string[] }).locks);
  await expect.poll(locks).toEqual(['landscape']);

  // Firefox for Android drops the lock when a trailer stops; the orientation change re-locks it.
  await page.evaluate(() => screen.orientation.dispatchEvent(new Event('change')));
  await expect.poll(locks).toEqual(['landscape', 'landscape']);
  // Leaving fullscreen hands the rotation back.
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(locks).toEqual(['landscape', 'landscape', 'unlock']);
});

test('M2 edge: a burst of steps over a trailer starts it only once they stop on it', async ({ page }) => {
  // Native HLS, so a start sets the trailer's `src` at once: each set is a stream loading.
  await page.addInitScript(() => {
    const w = window as Window & { starts?: number };
    w.starts = 0;
    HTMLMediaElement.prototype.canPlayType = () => 'maybe';
    const src = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')!;
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      get: src.get,
      set(v: string) {
        if (v.includes('.m3u8')) w.starts!++;
        src.set!.call(this, v);
      },
    });
  });
  await fakePlayback(page);
  await page.clock.install();
  await mockApi(page, { states: ['playable-trailers'] });
  await page.goto('/game/1145360?shot=s2');
  await expect(page.locator('#screenshot-lightbox .lb-img')).toBeVisible();
  await page.clock.pauseAt(Date.now() + 60_000); // the steps below are all at one instant
  const starts = () => page.evaluate(() => (window as Window & { starts?: number }).starts);
  const at = (shot: string) => expect(page).toHaveURL(new RegExp(`shot=${shot}`));

  // Held ←: Screenshot 1 on its own, then the trailer and the Cover within the settle.
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await at('v1');
  await page.keyboard.press('ArrowLeft');
  await at('banner');
  await page.clock.runFor(1000);
  expect(await starts()).toBe(0); // passed over: never loaded

  // A lone step onto it starts it at once, as before; a burst stopping on it, once it has settled.
  await page.keyboard.press('ArrowRight');
  await at('v1');
  expect(await starts()).toBe(1);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');
  await at('v1');
  expect(await starts()).toBe(1);
  await page.clock.runFor(250);
  expect(await starts()).toBe(2);

  // Closed while it waits: nothing starts behind the closed lightbox.
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');
  await at('v1');
  await page.keyboard.press('Escape');
  await expect(page.locator('#screenshot-lightbox')).toBeHidden();
  await page.clock.runFor(1000);
  expect(await starts()).toBe(2);
});

test('M3 edge: on Firefox for Android, a trailer enters fullscreen unloaded, then plays on as it was', async ({
  page,
}) => {
  // Its media session, loaded before fullscreen, would put the system orientation back over the lock.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (Android 12; Mobile) Firefox/159.0' });
    const w = window as Window & { steps?: string[] };
    w.steps = [];
    HTMLMediaElement.prototype.load = function () {
      w.steps!.push('unload');
      this.removeAttribute('src');
    };
    document.addEventListener(
      'play',
      () => w.steps!.push(document.fullscreenElement ? 'play fullscreen' : 'play'),
      true,
    );
  });
  await fakePlayback(page);
  await mockApi(page, { states: ['playable-trailers'] });
  await page.goto('/game/1145360?shot=v1');
  const steps = () => page.evaluate(() => (window as Window & { steps?: string[] }).steps);
  const video = page.locator('#screenshot-lightbox .lb-video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !!v.currentSrc && !v.paused)).toBe(true);
  await page.evaluate(() => ((window as Window & { steps?: string[] }).steps = []));
  await page.getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect.poll(steps).toEqual(['unload', 'play fullscreen']);

  // Paused, it stays paused, and plays from there.
  await page.evaluate(() => document.exitFullscreen());
  await video.evaluate((v: HTMLVideoElement) => v.pause());
  await page.evaluate(() => ((window as Window & { steps?: string[] }).steps = []));
  await page.getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  expect(await steps()).toEqual(['unload']);
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(steps).toEqual(['unload', 'play fullscreen']);
});

test('M3 edge: on Firefox for Android, a trailer’s glass controls have no blur, a screenshot’s keep it', async ({
  page,
}) => {
  // Blur over the video moves it a few pixels each time the controls show or hide.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (Android 12; Mobile) Firefox/159.0' });
  });
  await fakePlayback(page);
  await mockApi(page, { states: ['playable-trailers'] });
  await page.goto('/game/1145360?shot=v1');
  const blur = () =>
    page.locator('#screenshot-lightbox .lb-next').evaluate((el) => getComputedStyle(el).backdropFilter);
  await expect(page.locator('#screenshot-lightbox .lb-video')).toBeAttached();
  expect(await blur()).toBe('none');
  await page.goto('/game/1145360?shot=s1');
  await expect(page.locator('#screenshot-lightbox .lb-img')).toBeVisible();
  expect(await blur()).not.toBe('none');
});

test('M3 edge: without element fullscreen (an iPhone), only a trailer offers it, in the native player', async ({
  page,
}) => {
  await page.addInitScript(() => {
    for (const name of ['fullscreenEnabled', 'webkitFullscreenEnabled'])
      Object.defineProperty(Document.prototype, name, { get: () => false });
    (HTMLVideoElement.prototype as HTMLVideoElement & { webkitEnterFullscreen: () => void }).webkitEnterFullscreen =
      function () {
        (window as unknown as { native: boolean }).native = true;
      };
  });
  await fakePlayback(page);
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=s1');
  const fullscreen = page.locator('.lb-fullscreen');
  await expect(page.locator('#screenshot-lightbox')).toHaveAttribute('open');
  await expect(fullscreen).toBeHidden();
  await page.goto('/lists/owned?game=1145360&shot=v1');
  await page.getByRole('button', { name: 'Play trailer' }).click();
  await reachForControls(page);
  await fullscreen.click();
  expect(await page.evaluate(() => (window as unknown as { native: boolean }).native)).toBe(true);
});

test('M1 edge: on a phone, a double-tap zoom leaves the controls as they were', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'touch only');
  await page.clock.install();
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=s1');
  const lb = page.locator('#screenshot-lightbox');
  await expect(lb).not.toHaveClass(/lb-idle/);
  const box = await visibleBox(page.locator('#screenshot-lightbox .lb-img'));
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  for (let i = 0; i < 2; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  await expect(page.locator('#screenshot-lightbox .lb-img')).toHaveAttribute('style', /scale\(2\)/);
  await page.clock.runFor(500); // past the single tap's wait
  await expect(lb).not.toHaveClass(/lb-idle/);
});

test('I2 edge: a key on a control reached with Tab leaves the controls shown', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'keyboard');
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=s1');
  await expect(page.locator('.lb-surface')).toBeFocused(); // opened: its own focus is placed
  await page.locator('.lb-next').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.lb-status')).toContainText('Screenshot 2 of 3');
  await expect(page.locator('#screenshot-lightbox')).not.toHaveClass(/lb-idle/);
  await expect(page.locator('.lb-next')).toHaveCSS('opacity', '1');
});

test('F1 edge: on a phone, a double-tap zooms a screenshot and another zooms back out', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'touch only');
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=s1');
  const img = page.locator('#screenshot-lightbox .lb-img');
  await expect(img).toBeVisible();
  const box = await visibleBox(img);
  const cdp = await page.context().newCDPSession(page);
  const doubleTap = async () => {
    for (let i = 0; i < 2; i++) {
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
  };
  await doubleTap();
  await expect(img).toHaveAttribute('style', /scale\(2\)/);
  await doubleTap();
  await expect(img).not.toHaveAttribute('style', /scale/);
});

// A key hides the lightbox's controls; moving the mouse, as one reaching for them does (a tap on a phone), brings them back.
async function reachForControls(page: Page) {
  if (await page.evaluate(() => matchMedia('(pointer: coarse)').matches)) {
    // Forced: whatever covers the media (a loading banner's error card) takes the tap the same way.
    await page.locator('#screenshot-lightbox').locator('.lb-img:visible, .lb-video').first().tap({ force: true });
    return;
  }
  await page.mouse.move(700, 440);
  await page.mouse.move(720, 450);
}

// The fixture trailer has no stream: play()/pause() only flip `paused` and fire their events.
async function fakePlayback(page: Page) {
  await page.addInitScript(() => {
    const playing = new WeakSet<HTMLMediaElement>();
    Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
      get(this: HTMLMediaElement) {
        return !playing.has(this);
      },
    });
    HTMLMediaElement.prototype.play = async function (this: HTMLMediaElement) {
      playing.add(this);
      this.dispatchEvent(new Event('play'));
    };
    HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement) {
      if (!playing.delete(this)) return;
      queueMicrotask(() => this.dispatchEvent(new Event('pause'))); // queued, as a real pause event is
    };
  });
}

test('F1 edge: stepping onto a preloaded screenshot shows it at once, not its thumbnail first', async ({ page }) => {
  await mockApi(page, { states: ['slow-media'] }); // a screenshot's thumbnail and full image apart
  await page.goto('/game/1145360?shot=s1');
  const next = page.locator('.lb-preload[data-src*="Screenshot%202.svg?full"]');
  // Its fetch starts once shot 1 has loaded, so two slow-media delays queue behind the page load.
  await expect
    .poll(() => next.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), { timeout: 15_000 })
    .toBe(true);
  await page.locator('#screenshot-lightbox .lb-img').evaluate((img: HTMLImageElement) => {
    const w = window as Window & { srcs?: string[] };
    w.srcs = [];
    const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
    Object.defineProperty(img, 'src', { get: src.get, set: (v: string) => (w.srcs!.push(v), src.set!.call(img, v)) });
  });
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#screenshot-lightbox .lb-img')).toHaveAttribute('src', /Screenshot%202\.svg\?full/);
  expect(await page.evaluate(() => (window as Window & { srcs?: string[] }).srcs)).toEqual([
    expect.stringMatching(/Screenshot%202\.svg\?full/),
  ]);
});

test("F1 edge: a screenshot that loads but won't decode ahead still shows", async ({ page }) => {
  await page.addInitScript(() => {
    HTMLImageElement.prototype.decode = function (this: HTMLImageElement) {
      return new Promise((_, reject) =>
        this.addEventListener('load', () => reject(new DOMException('', 'EncodingError')), { once: true }),
      );
    };
  });
  await mockApi(page, { states: ['slow-media'] }); // not in memory yet: it waits for the decode
  await page.goto('/game/1145360?shot=s1');
  await expect(page.locator('#screenshot-lightbox .lb-img')).toHaveAttribute('src', /Screenshot%201\.svg\?full/);
  await expect(page.locator('#screenshot-lightbox .lb-img')).toHaveCSS('opacity', '1');
  await expect(page.locator('.lb-error')).toBeHidden();
});

test('F1 edge: the panel behind the lightbox follows its steps unrendered, and is scrolled to them on close', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window as Window & { filmScrolls?: number };
    w.filmScrolls = 0;
    const scroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, ...args) {
      if (this.closest('#panel-hero')) w.filmScrolls!++;
      return scroll.apply(this, args);
    };
  });
  await asPlayer(page, ALICE, { recentGames: [620, 1145360, 892970] });
  await page.goto('/game/1145360?shot=s1');
  const panel = page.locator('#game-panel');
  await expect(page.locator('.lb-caption-text')).toHaveText('Hades');
  await expect(panel).toHaveCSS('content-visibility', 'hidden');
  const filmScrolls = () => page.evaluate(() => (window as Window & { filmScrolls?: number }).filmScrolls);
  await page.evaluate(() => ((window as Window & { filmScrolls?: number }).filmScrolls = 0));
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.lb-status')).toContainText('Screenshot 2 of 3');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#panel-title')).toHaveText('Valheim'); // the panel did follow
  await page.keyboard.press('ArrowUp'); // back to a game with a filmstrip
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  expect(await filmScrolls()).toBe(0);

  await page.keyboard.press('Escape');
  await expect(page.locator('#screenshot-lightbox')).toBeHidden();
  await expect(panel).not.toHaveCSS('content-visibility', 'hidden');
  await expect.poll(filmScrolls).toBeGreaterThan(0);
});

test("F1 edge: the lightbox preloads a screenshot's neighbours only once it is in, or has failed", async ({ page }) => {
  await mockApi(page, { states: ['slow-media'] }); // its images by URL, so one can be held
  const shown = await gate(page, '**/Screenshot%201.svg?full**');
  await page.goto('/game/1145360?shot=s1');
  await shown.requested;
  const preloads = page.locator('#screenshot-lightbox .lb-preload');
  await expect(page.locator('.lb-status')).toContainText('Screenshot 1 of 3');
  expect(await preloads.count()).toBe(0); // not competing with the one awaited
  shown.release();
  await expect(page.locator('#screenshot-lightbox .lb-img')).toHaveAttribute('src', /Screenshot%201\.svg\?full/);
  await expect(preloads).toHaveCount(2);

  // A failed one doesn't hold its neighbours back.
  await page.route('**/Screenshot%203.svg?full**', (route) => route.fulfill({ status: 404 }));
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.lb-status')).toContainText('Screenshot 3 of 3');
  await expect(page.locator('.lb-error')).toBeVisible();
  await expect(preloads).toHaveCount(2);
  await expect(page.locator('#screenshot-lightbox .lb-preload[data-src*="Screenshot%202"]')).toHaveCount(1);
});

test('F1 edge: stepping games in the lightbox on Recently Looked Up shows the game stepped to', async ({ page }) => {
  await asPlayer(page, ALICE, { recentGames: [620, 1145360, 892970] });
  await page.goto('/game/1145360?shot=s1');
  await expect(page.locator('.lb-caption-text')).toHaveText('Hades');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.lb-caption-text')).toHaveText('Valheim');
  await expect(page.locator('#panel-title')).toHaveText('Valheim');
  await expect(page).toHaveURL(/\/game\/892970\?shot=banner$/);
  await expect(page.locator('#screenshot-lightbox')).toContainText('game 3 / 3');
  expect(
    await page.evaluate(() => document.getElementById('screenshot-lightbox')!.contains(document.activeElement)),
  ).toBe(true);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.lb-caption-text')).toHaveText('Portal 2');
});

for (const [route, next] of [
  ['/lists/owned?game=1145360', { name: 'Terraria', url: /\/lists\/owned\?game=105600$/ }],
  ['/game/1145360', { name: 'Valheim', url: /\/game\/892970$/ }],
] as const) {
  test(`F1 edge: closing the lightbox after stepping games keeps the game stepped to (${route.split('/')[1]})`, async ({
    page,
  }) => {
    await asPlayer(page, ALICE, { recentGames: [620, 1145360, 892970] });
    await page.goto(route);
    for (const close of ['button', 'back'] as const) {
      await page.getByRole('button', { name: 'Open in lightbox' }).click();
      await page.keyboard.press(close === 'button' ? 'ArrowDown' : 'ArrowUp');
      await expect(page.locator('#panel-title')).toHaveText(close === 'button' ? next.name : 'Hades');
      if (close === 'button') {
        await reachForControls(page);
        await page.getByRole('button', { name: 'Close lightbox' }).click();
      } else await page.goBack();
      await expect(page.locator('#screenshot-lightbox')).not.toHaveAttribute('open');
      await expect(page.locator('#panel-title')).toHaveText(close === 'button' ? next.name : 'Hades');
      if (close === 'button') await expect(page).toHaveURL(next.url);
      else await expect(page).toHaveURL(new RegExp(`${route.replace('?', '\\?')}$`));
    }
  });
}

test('F1 edge: closing the lightbox leaves the panel on the last item looked at', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360');
  await page.getByRole('button', { name: 'Open in lightbox' }).click();
  await page.getByRole('button', { name: 'Next screenshot' }).click();
  await page.getByRole('button', { name: 'Next screenshot' }).click();
  await expect(page.locator('.lb-status')).toContainText('Screenshot 1 of 3');
  await page.getByRole('button', { name: 'Close lightbox' }).click();
  await expect(page.locator('.panel-film-item[aria-current="true"]')).toHaveAccessibleName('Screenshot 1 of 3');
});

test("F1 edge: the panel's thumbnails are named as the lightbox counts them", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360');
  const names = () => page.locator('.panel-film-item').evaluateAll((items) => items.map((e) => e.ariaLabel));
  await expect
    .poll(names)
    .toEqual(['Cover', 'Trailer 1 of 1', 'Screenshot 1 of 3', 'Screenshot 2 of 3', 'Screenshot 3 of 3']);
});

test("F1 edge: the panel's hero never shows the previous item while the next one loads", async ({ page }) => {
  await mockApi(page, { states: ['slow-media'] });
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360');
  const main = page.locator('#panel-hero .panel-hero-main');
  const img = main.locator('.panel-hero-img');
  await expect(img).not.toHaveClass(/loading/); // the cover, loaded
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  // Screenshot 1's full image is on its way: the cover/trailer is hidden, its thumbnail stands in.
  await expect(img).toHaveAttribute('src', /Screenshot%201\.svg\?full/);
  await expect(img).toHaveClass(/loading/);
  await expect(img).toHaveCSS('opacity', '0');
  await expect(main).toHaveAttribute('style', /Screenshot%201\.svg\?thumb/);
  await expect(img).not.toHaveClass(/loading/);

  // Another game: its title doesn't sit over this game's picture.
  await page.getByRole('button', { name: 'Next game' }).click();
  await expect(page.locator('#panel-title')).not.toHaveText('Hades');
  await expect(img).toHaveCSS('opacity', '0');
  await expect(img).not.toHaveClass(/loading/);
  await expect(img).toHaveCSS('opacity', '1');
});

test('F1 edge: a slow screenshot shows its thumbnail and a spinner until it has loaded', async ({ page }) => {
  await mockApi(page, { states: ['slow-media'] });
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360');
  // The panel's filmstrip has the thumbnails by the time the full image is asked for.
  await expect
    .poll(() =>
      page.locator('.panel-film-thumb').evaluateAll((imgs) => imgs.every((i) => (i as HTMLImageElement).complete)),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Open in lightbox' }).click();
  await page.keyboard.press('ArrowRight'); // past the trailer
  await page.keyboard.press('ArrowRight');
  const lb = page.locator('#screenshot-lightbox');
  const img = lb.locator('.lb-img');
  await expect(lb.locator('.lb-status')).toContainText('Screenshot 1 of 3');
  await expect(lb).toHaveClass(/lb--loading/);
  await expect(img).toHaveAttribute('src', /Screenshot%201\.svg\?thumb/);
  await expect(img).toHaveAttribute('src', /Screenshot%201\.svg\?full/);
  await expect(lb).not.toHaveClass(/lb--loading/);
});

test("F1 edge: a lightbox Retry that lands after a step doesn't paint over the shot stepped to", async ({ page }) => {
  await mockApi(page, { states: ['slow-media'] });
  // Screenshot 1's full image fails; its retry answers only after the viewer has moved on.
  let retried!: () => void;
  const retryDone = new Promise<void>((resolve) => (retried = resolve));
  await page.route(/Screenshot%201\.svg\?full/, async (route) => {
    if (!route.request().url().includes('_retry=')) return route.abort();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
    retried();
  });
  await asPlayer(page, ALICE);
  await page.clock.install();
  await page.goto('/lists/owned?game=1145360&shot=s1');
  const lb = page.locator('#screenshot-lightbox');
  const img = lb.locator('.lb-img');
  await page.getByRole('button', { name: 'Retry' }).click();
  await page.getByRole('button', { name: 'Next screenshot' }).click();
  await expect(lb.locator('.lb-status')).toContainText('Screenshot 2 of 3');
  await expect(img).toHaveAttribute('src', /Screenshot%202\.svg\?full/);
  await retryDone;
  await page.clock.runFor(300); // the stale onload's turn
  await expect(img).toHaveAttribute('src', /Screenshot%202\.svg\?full/);
});

test('F1 edge: a screenshot shown below its size zooms from a visible button, or Z', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=s1');
  const zoom = page.getByRole('button', { name: 'Zoom', exact: true });
  const img = page.locator('#screenshot-lightbox .lb-img');
  // The fixture screenshots are 1280×720: at full size on a large screen, zooming would only enlarge pixels.
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(page.locator('#screenshot-lightbox')).not.toHaveClass(/lb--loading/);
  await expect(zoom).toBeHidden();
  await page.setViewportSize({ width: 800, height: 600 });
  await zoom.click();
  await expect(zoom).toHaveAttribute('aria-pressed', 'true');
  await expect(img).toHaveAttribute('style', /scale\(2\)/);
  await page.keyboard.press('z');
  await expect(zoom).toHaveAttribute('aria-pressed', 'false');
  await expect(img).not.toHaveAttribute('style', /scale/);
  // Nothing to zoom on a trailer.
  await reachForControls(page);
  await page.getByRole('button', { name: 'Previous screenshot' }).click();
  await expect(zoom).toBeHidden();
});

test('F1 edge: stepping media leaves hidden controls hidden, flashing only the counter', async ({ page }) => {
  await page.clock.install();
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=s1');
  const lb = page.locator('#screenshot-lightbox');
  await page.clock.runFor(3500);
  await expect(lb).toHaveClass(/lb-idle/);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.lb-status')).toContainText('Screenshot 2 of 3');
  // Read once: a retrying assertion would just wait out the idle timer (the clock keeps running).
  expect(await lb.getAttribute('class')).toMatch(/lb-idle/);
  await expect(page.locator('.lb-counter')).toHaveCSS('opacity', '1');
  await page.clock.runFor(2000);
  await expect(page.locator('.lb-counter')).toHaveCSS('opacity', '0');
  // Tab brings the chrome back, so the focused control is never invisible.
  await page.keyboard.press('Tab');
  await expect(lb).not.toHaveClass(/lb-idle/);
});

test('F1 edge: after ↓ finds no game to step to, → still slides the next screenshot in sideways', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/wishlist?game=1145360&shot=s1'); // Hades: not on the wishlist, so no game to step to
  await expect(page.locator('.lb-status')).toContainText('Screenshot 1 of 3');
  await page.locator('#screenshot-lightbox .lb-img').evaluate((img) => {
    const w = window as unknown as { lbAnims: string[] };
    w.lbAnims = [];
    new MutationObserver(() => w.lbAnims.push(img.className)).observe(img, { attributeFilter: ['class'] });
  });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.lb-status')).toContainText('Screenshot 2 of 3');
  const anims = await page.evaluate(() => (window as unknown as { lbAnims: string[] }).lbAnims);
  expect(anims).toContain('lb-img lb-anim-right');
});

test('F1 edge: the lightbox leaves Ctrl/⌘/Alt shortcuts to the browser', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=s1');
  await expect(page.locator('.lb-status')).toContainText('Screenshot 1 of 3');
  await page.evaluate(() => {
    const w = window as unknown as { taken: string[] };
    w.taken = [];
    addEventListener('keydown', (e) => e.defaultPrevented && w.taken.push(e.key));
  });
  for (const key of ['Control+r', 'Control+f', 'Meta+ArrowRight', 'Alt+ArrowDown', 'Control+z']) {
    await page.keyboard.press(key);
  }
  expect(await page.evaluate(() => (window as unknown as { taken: string[] }).taken)).toEqual([]);
  await expect(page.locator('.lb-caption-text')).toHaveText('Hades');
  await expect(page.locator('.lb-status')).toContainText('Screenshot 1 of 3');
});

test('M2 edge: stepping back to a game just left in the lightbox lands where it was left', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=s1');
  await expect(page.locator('.lb-status')).toContainText('Screenshot 1 of 3');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.lb-status')).toContainText('Screenshot 2 of 3');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.lb-caption-text')).not.toHaveText('Hades');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.lb-caption-text')).toHaveText('Hades');
  await expect(page.locator('.lb-status')).toContainText('Screenshot 2 of 3');
});

// Terraria (Hades' ↓ neighbour on /lists/owned) shows only its banner until its held media are released.
const holdTerrariaMedia = (page: Page) => gate(page, '**/api/game-meta/105600');

// The panel's Refresh details sits behind the lightbox; clicked there, it refreshes the game the lightbox shows.
const refreshBehindLightbox = (page: Page) =>
  page.locator('.panel-refresh-btn').evaluate((b: HTMLElement) => b.click());

test("F1 edge: a banner shown while a game's media streams isn't where paging back to it lands", async ({ page }) => {
  await asPlayer(page, ALICE);
  const terrariaMedia = await holdTerrariaMedia(page);
  await page.goto('/lists/owned?game=1145360&shot=s1');
  const counter = page.locator('.lb-status');
  const name = page.locator('.lb-caption-text');
  await expect(counter).toContainText('Screenshot 1 of 3');
  await page.keyboard.press('ArrowRight');
  await expect(counter).toContainText('Screenshot 2 of 3');
  await page.keyboard.press('ArrowDown');
  await expect(name).toHaveText('Terraria');
  await expect(counter).toContainText('Cover');
  await page.keyboard.press('ArrowRight'); // nothing else to step to yet
  await page.keyboard.press('ArrowDown');
  await expect(name).not.toHaveText('Terraria');
  await page.keyboard.press('ArrowUp');
  await expect(name).toHaveText('Terraria');
  terrariaMedia.release();
  await expect(counter).toContainText('Screenshot 1 of 2');
});

test('F1 edge: paging back to a game whose media is still loading lands where it was left once it loads', async ({
  page,
}) => {
  let media = true;
  await asPlayer(page, ALICE);
  const terrariaMedia = await holdTerrariaMedia(page);
  await page.route('**/api/game-details/105600?refresh=1', (route) => {
    const req = route.request();
    const full = respond(req.method(), new URL(req.url()), req.postData());
    return route.fulfill(media ? full : { ...full, body: JSON.stringify({ ...JSON.parse(full.body), meta: null }) });
  });
  await page.goto('/lists/owned?game=1145360&shot=s1');
  const counter = page.locator('.lb-status');
  const name = page.locator('.lb-caption-text');
  await expect(counter).toContainText('Screenshot 1 of 3');
  await page.keyboard.press('ArrowDown');
  await expect(name).toHaveText('Terraria');
  terrariaMedia.release();
  await expect(counter).toContainText('Screenshot 1 of 2');
  await page.keyboard.press('ArrowRight');
  await expect(counter).toContainText('Screenshot 2 of 2');
  await page.keyboard.press('ArrowDown');
  await expect(name).not.toHaveText('Terraria');
  await page.keyboard.press('ArrowUp');
  await expect(counter).toContainText('Screenshot 2 of 2');
  // Its media goes away (a refresh the store didn't answer), then comes back.
  media = false;
  await refreshBehindLightbox(page);
  await expect(counter).toContainText('Cover');
  await page.keyboard.press('ArrowDown');
  await expect(name).not.toHaveText('Terraria');
  await page.keyboard.press('ArrowUp');
  await expect(name).toHaveText('Terraria');
  media = true;
  await refreshBehindLightbox(page);
  await expect(counter).toContainText('Screenshot 2 of 2');
});

test('F1 edge: ←/→ on a Cover standing in while the media streams still lets the media replace it', async ({
  page,
}) => {
  await asPlayer(page, ALICE);
  const terrariaMedia = await holdTerrariaMedia(page);
  await page.goto('/lists/owned?game=1145360&shot=s1');
  const counter = page.locator('.lb-status');
  await expect(counter).toContainText('Screenshot 1 of 3');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.lb-caption-text')).toHaveText('Terraria');
  await expect(counter).toContainText('Cover');
  await page.keyboard.press('ArrowRight'); // nothing to step to: no pick made
  terrariaMedia.release();
  await expect(counter).toContainText('Screenshot 1 of 2');
});

test('M1 edge: a refresh that shrinks the media on screen still remembers where it was left', async ({ page }) => {
  let shrunk = false;
  await page.route('**/api/game-details/1145360?refresh=1', (route) => {
    const req = route.request();
    const full = respond(req.method(), new URL(req.url()), req.postData());
    const body = JSON.parse(full.body);
    if (shrunk) body.meta.screenshots = body.meta.screenshots.slice(0, 2);
    return route.fulfill({ ...full, body: JSON.stringify(body) });
  });
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=s3');
  const counter = page.locator('.lb-status');
  await expect(counter).toContainText('Screenshot 3 of 3');
  shrunk = true;
  await refreshBehindLightbox(page);
  await expect(counter).toContainText('Screenshot 2 of 2');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.lb-caption-text')).not.toHaveText('Hades');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.lb-caption-text')).toHaveText('Hades');
  await expect(counter).toContainText('Screenshot 2 of 2');
});

test("M1 edge: a link's screenshot opens once its game's media are in", async ({ page }) => {
  await asPlayer(page, ALICE);
  const hadesMedia = await gate(page, '**/api/game-meta/1145360');
  await page.goto('/lists/owned?game=1145360&shot=s2');
  await hadesMedia.requested;
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  const lightbox = page.locator('#screenshot-lightbox');
  await expect(lightbox).not.toHaveAttribute('open');
  hadesMedia.release();
  await expect(lightbox.locator('.lb-status')).toContainText('Screenshot 2 of 3');
  await expect(page).toHaveURL(/[?&]shot=s2\b/);
  expect(hadesMedia.count).toBe(1);
});

const MEDIA_FAILED = /Screenshots and trailers: the Steam store didn't answer/;

test("M1 edge: media that don't load leave the Cover, say so, and opening the game again retries", async ({ page }) => {
  await asPlayer(page, ALICE);
  let fail = true;
  await page.route('**/api/game-meta/1145360', (route) =>
    fail ? route.fulfill({ status: 502, json: { error: "Steam store didn't answer" } }) : route.fallback(),
  );
  await page.goto('/lists/owned?game=1145360&shot=s2');
  // The link opens on what there is, and says why.
  const lightbox = page.locator('#screenshot-lightbox');
  await expect(lightbox.locator('.lb-status')).toContainText('Cover');
  await expect(lightbox.locator('.lb-status')).toContainText(MEDIA_FAILED);
  await page.keyboard.press('Escape');
  await expect(lightbox).not.toHaveAttribute('open');
  await expect(page.getByRole('button', { name: 'Screenshot 1 of 3' })).toHaveCount(0);
  const panelLine = page.locator('#panel-hero').getByText(MEDIA_FAILED);
  await expect(panelLine).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Close', exact: true }).click(); // a phone's panel covers the table
  await row(page, 'Hades').getByText('Hades').click();
  await expect(page.getByRole('button', { name: 'Screenshot 1 of 3' })).toBeVisible();
  await expect(panelLine).toHaveCount(0);
});

test("M1 edge: a game whose media load doesn't say they didn't", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=s2');
  const lightbox = page.locator('#screenshot-lightbox');
  await expect(lightbox.locator('.lb-status')).toContainText('Screenshot 2 of 3');
  await expect(lightbox.locator('.lb-status')).not.toContainText(MEDIA_FAILED);
  await page.keyboard.press('Home');
  await expect(lightbox.locator('.lb-status')).toContainText('Cover');
  await expect(lightbox.locator('.lb-status')).not.toContainText(MEDIA_FAILED);
  await expect(page.locator('#panel-hero').getByText(MEDIA_FAILED)).toHaveCount(0);
});

test('F1 edge: paging back to a game only passed through lands on the kind being left', async ({ page }) => {
  // Hollow Knight (screenshots), Hades, Terraria (a trailer).
  await asPlayer(page, ALICE, { recentGames: [367520, 1145360, 105600] });
  await page.goto('/game/367520?shot=s1');
  const counter = page.locator('.lb-status');
  const name = page.locator('.lb-caption-text');
  await expect(page.locator('.lb-caption-pos')).toHaveText('game 1 / 3');
  await page.keyboard.press('ArrowDown');
  await expect(name).toHaveText('Hades');
  await expect(counter).toContainText('Screenshot 1 of 3');
  await page.keyboard.press('ArrowDown');
  await expect(name).toHaveText('Terraria');
  await expect(counter).toContainText('Screenshot 1 of 2');
  await page.keyboard.press('ArrowLeft');
  await expect(counter).toContainText('Trailer 1 of 1');
  await page.keyboard.press('ArrowUp');
  await expect(name).toHaveText('Hades');
  await expect(counter).toContainText('Trailer 1 of 1');
});

test('F1 edge: paging games from the Cover keeps showing covers', async ({ page }) => {
  await asPlayer(page, ALICE, { recentGames: [1145360, 105600, 367520] });
  await page.goto('/game/1145360?shot=banner');
  const counter = page.locator('.lb-status');
  const name = page.locator('.lb-caption-text');
  await expect(page.locator('.lb-caption-pos')).toHaveText('game 1 / 3');
  await expect(counter).toContainText('Cover');
  for (const next of ['Terraria', 'Hollow Knight']) {
    await page.keyboard.press('ArrowDown');
    await expect(name).toHaveText(next);
    await expect(counter).toContainText('Cover');
  }
  // Onto a game whose media is still loading: its media arriving doesn't move off the Cover.
  const terrariaMedia = await holdTerrariaMedia(page);
  await page.goto('/lists/owned?game=1145360&shot=banner');
  await expect(counter).toContainText('Cover');
  await page.keyboard.press('ArrowDown');
  await expect(name).toHaveText('Terraria');
  terrariaMedia.release();
  await expect(page.locator('#screenshot-lightbox .lb-next')).toBeEnabled();
  await expect(counter).toContainText('Cover');
});

test('F1 edge: stepping past the last media or game slides back in from the other side', async ({ page }) => {
  await asPlayer(page, ALICE, { recentGames: [620, 1145360, 892970] });
  await page.goto('/game/1145360?shot=s1');
  await expect(page.locator('.lb-caption-pos')).toHaveText('game 2 / 3');
  await page.keyboard.press('End');
  await expect(page.locator('.lb-status')).toContainText('Screenshot 3 of 3');
  const anims = async (step: () => Promise<void>) => {
    await page.locator('#screenshot-lightbox .lb-img').evaluate((img) => {
      const w = window as unknown as { lbAnims: string[] };
      w.lbAnims = [];
      new MutationObserver(() => w.lbAnims.push(img.className)).observe(img, { attributeFilter: ['class'] });
    });
    await step();
    return page.evaluate(() => (window as unknown as { lbAnims: string[] }).lbAnims);
  };
  expect(
    await anims(async () => {
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('.lb-status')).toContainText('Cover');
    }),
  ).toContain('lb-img lb-anim-left');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.lb-caption-pos')).toHaveText('game 3 / 3');
  expect(
    await anims(async () => {
      await page.keyboard.press('ArrowDown');
      await expect(page.locator('.lb-caption-pos')).toHaveText('game 1 / 3');
    }),
  ).toContain('lb-img lb-anim-top');
});

test('F1 edge: on a phone, a swipe past the last media or game slides in with the finger', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'touch only');
  await asPlayer(page, ALICE, { recentGames: [620, 1145360, 892970] });
  await page.goto('/game/1145360?shot=s3');
  await expect(page.locator('.lb-status')).toContainText('Screenshot 3 of 3');
  const img = page.locator('#screenshot-lightbox .lb-img');
  const cdp = await page.context().newCDPSession(page);
  const swipe = async (points: [number, number][]) => {
    await img.evaluate((el) => {
      const w = window as unknown as { lbAnims: string[] };
      w.lbAnims = [];
      new MutationObserver(() => w.lbAnims.push(el.className)).observe(el, { attributeFilter: ['class'] });
    });
    const [[x0, y0], ...moves] = points;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
    for (const [x, y] of moves)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const anims = () => page.evaluate(() => (window as unknown as { lbAnims: string[] }).lbAnims);
  const box = await visibleBox(img);
  const cx = box.x + box.width / 2,
    cy = box.y + box.height / 2;
  // Left, past the last screenshot: the Cover comes in from the right, under the finger.
  await swipe([
    [cx + 80, cy],
    [cx + 40, cy],
    [cx - 20, cy],
    [cx - 100, cy],
  ]);
  await expect(page.locator('.lb-status')).toContainText('Cover');
  expect(await anims()).toContain('lb-img lb-anim-right');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.lb-caption-pos')).toHaveText('game 3 / 3');
  // Up, past the last game: game 1 comes in from the bottom.
  await swipe([
    [cx, cy + 60],
    [cx, cy + 30],
    [cx, cy - 20],
    [cx, cy - 100],
  ]);
  await expect(page.locator('.lb-caption-pos')).toHaveText('game 1 / 3');
  expect(await anims()).toContain('lb-img lb-anim-bottom');
});

test('F1 edge: stepping games with hidden controls flashes the game name too', async ({ page }) => {
  await page.clock.install();
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=s1');
  const lb = page.locator('#screenshot-lightbox');
  const caption = page.locator('.lb-caption');
  await page.clock.runFor(3500);
  await expect(lb).toHaveClass(/lb-idle/);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.lb-counter')).toHaveCSS('opacity', '1');
  await expect(caption).toHaveCSS('opacity', '0');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.lb-caption-text')).toHaveText('Terraria');
  expect(await lb.getAttribute('class')).toMatch(/lb-idle/);
  await expect(caption).toHaveCSS('opacity', '1');
  // A media step before the flash ends shows the counter alone again.
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.lb-status')).toContainText(/Screenshot 2 of/);
  // Read once: a retrying assertion would just wait out the flash (the clock keeps running).
  expect(await lb.getAttribute('class')).not.toMatch(/lb--stepped-game/);
  await page.clock.runFor(2000);
  await expect(caption).toHaveCSS('opacity', '0');
});

test('F1 edge: any mouse move brings back all the controls, and a key hides them again', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'mouse only');
  await page.clock.install();
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=s1');
  const lb = page.locator('#screenshot-lightbox');
  await page.clock.runFor(3500);
  await expect(lb).toHaveClass(/lb-idle/);
  await page.mouse.move(700, 440);
  await page.mouse.move(720, 450);
  await expect(lb).not.toHaveClass(/lb-idle/);
  await expect(page.locator('.lb-backdrop')).toHaveCSS('cursor', 'zoom-out');
  await page.clock.runFor(3500);
  await expect(lb).toHaveClass(/lb-idle/);
  // One under the mouse stays.
  await page.mouse.move(700, 440);
  await page.locator('.lb-next').hover();
  await page.clock.runFor(3500);
  await expect(lb).not.toHaveClass(/lb-idle/);
  await page.keyboard.press('ArrowRight');
  await expect(lb).toHaveClass(/lb-idle/);
  await expect(page.locator('.lb-status')).toContainText('Screenshot 2 of 3');
});

test('I2 edge: opened from the keyboard, the lightbox shows only the media; a key shows only its feedback', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'keyboard');
  await fakePlayback(page);
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360');
  await page.getByRole('button', { name: 'Open in lightbox' }).focus();
  await page.keyboard.press('Enter');
  const lb = page.locator('#screenshot-lightbox');
  await expect(lb).toHaveAttribute('open');
  await expect(lb).toHaveClass(/lb-idle/);
  await expect(page.locator('.lb-caption')).toHaveCSS('opacity', '0');
  await page.keyboard.press('ArrowRight'); // the trailer
  await expect(page.locator('.lb-status')).toContainText('Trailer 1 of 1');
  await page.keyboard.press(' ');
  await expect(page.locator('.lb-osd')).toHaveAttribute('data-kind', 'play');
  await expect(page.locator('.lb-osd')).toHaveClass(/lb-osd--show/);
  await page.keyboard.press(' ');
  await expect(page.locator('.lb-osd')).toHaveAttribute('data-kind', 'pause');
  await expect(lb).toHaveClass(/lb-idle/); // the pause shows the large play button, not the controls
  await page.keyboard.press('m');
  await expect(page.locator('.lb-osd')).toHaveAttribute('data-kind', 'mute');
});

test('M1 edge: the first open shows a hint at the hidden controls, once', async ({ page }, testInfo) => {
  await page.clock.install();
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360');
  await expect(rows(page)).toHaveCount(6); // the list's there: ↑↓ have games to step to
  await page.getByRole('button', { name: 'Open in lightbox' }).click();
  const hint = page.locator('.lb-hint');
  await expect(hint).toHaveClass(/lb-hint--show/);
  await expect(hint).toHaveText(
    testInfo.project.name === 'phone' ? 'swipe ↕ games · swipe ↔ media' : '↑↓ games · ←→ media',
  );
  await page.clock.runFor(4500);
  await expect(hint).not.toHaveClass(/lb-hint--show/);
  await page.goto('/lists/owned?game=1145360&shot=s2');
  await expect(page.locator('#screenshot-lightbox')).toHaveAttribute('open');
  await expect(hint).not.toHaveClass(/lb-hint--show/);
});

test('F1 edge: on a phone, a swipe steps without bringing the controls back, and a tap does', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'touch only');
  await page.clock.install();
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=s1');
  const lb = page.locator('#screenshot-lightbox');
  const box = await visibleBox(page.locator('#screenshot-lightbox .lb-img'));
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await page.clock.runFor(3500);
  await expect(lb).toHaveClass(/lb-idle/);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y }] });
  for (const x of [260, 200, 120])
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('.lb-status')).toContainText('Screenshot 2 of 3');
  expect(await lb.getAttribute('class')).toMatch(/lb-idle/); // read once, as above
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(lb).not.toHaveClass(/lb-idle/);
});

test("F1 edge: on a phone, a swipe past the panel's last item stays on it", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'touch only');
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360');
  const current = page.locator('.panel-film-item[aria-current="true"]');
  await page.getByRole('button', { name: 'Screenshot 3 of 3' }).click();
  await expect(current).toHaveAccessibleName('Screenshot 3 of 3');
  const box = await visibleBox(page.locator('#panel-hero .panel-hero-img'));
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y }] });
  for (const x of [260, 200, 120])
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(current).toHaveAccessibleName('Screenshot 3 of 3');
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(current).toHaveAccessibleName('Screenshot 2 of 3');
});

test("F1 edge: on a phone, a slow right swipe on the panel's media steps it, without closing the panel", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'touch only');
  await page.clock.install();
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360');
  const current = page.locator('.panel-film-item[aria-current="true"]');
  await page.getByRole('button', { name: 'Screenshot 2 of 3' }).click();
  // Synthetic events: Chromium holds back real touchmoves within its slop, the ones that matter here.
  await page.locator('#panel-hero .panel-hero-img').evaluate((img) => {
    const y = img.getBoundingClientRect().top + 20;
    const fire = (type: string, x: number) => {
      const touch = new Touch({ identifier: 1, target: img, clientX: x, clientY: y });
      const touches = type === 'touchend' ? [] : [touch];
      img.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches, changedTouches: [touch] }));
    };
    fire('touchstart', 100);
    // 7 px decides the panel's own swipe (6 px) before the hero's (8 px).
    for (const x of [107, 115, 160, 220]) fire('touchmove', x);
    fire('touchend', 220);
  });
  await expect(current).toHaveAccessibleName('Screenshot 1 of 3');
  await page.clock.runFor(500);
  await expect(page.locator('#panel-title')).toBeVisible();
});

test('F1 edge: on a phone, the previous/next media buttons sit clear of the media and its controls', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'phone layout');
  await fakePlayback(page);
  await asPlayer(page, ALICE);
  const overlap = (a: Box, b: Box) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  type Box = { x: number; y: number; width: number; height: number };
  const clear = async (selector: string) => {
    for (const el of await page.locator(selector).all()) {
      const m = await visibleBox(el);
      for (const name of ['Previous screenshot', 'Next screenshot']) {
        const b = await visibleBox(page.getByRole('button', { name }));
        expect(overlap(b, m), `${name} vs ${selector}`).toBe(false);
      }
    }
  };
  await page.goto('/lists/owned?game=1145360&shot=s1');
  await clear('#screenshot-lightbox .lb-img');
  await page.goto('/lists/owned?game=1145360&shot=v1');
  await page.getByRole('button', { name: 'Play trailer' }).click();
  // At the ends of the trailer's control row.
  await clear('#screenshot-lightbox :is(.lb-vc-row > *, .lb-vc-scrub)');
});

test("F1 edge: the viewer's toolbar holds only fullscreen, zoom and close", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=s1');
  // The address bar already holds the media's link (`?shot=`), so there is no copy button.
  const buttons = page.locator('.lb-toolbar-right button');
  await expect(buttons.first()).toBeVisible();
  expect(await buttons.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))).toEqual([
    'Enter fullscreen',
    'Zoom',
    'Close lightbox',
  ]);
});

test('F1 edge: a trailer fills the window, fullscreen or not, its controls over it', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop layout');
  await fakePlayback(page);
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=v1');
  await page.getByRole('button', { name: 'Play trailer' }).click();
  const video = await visibleBox(page.locator('#screenshot-lightbox .lb-video'));
  expect(video).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
});

test('I2 edge: Space on a focused lightbox button presses that button, not play/pause', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'keyboard');
  await fakePlayback(page);
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=v1');
  await page.getByRole('button', { name: 'Play trailer' }).click();
  const mute = page.locator('.lb-vc-mute');
  await mute.focus();
  await page.keyboard.press(' ');
  await expect(mute).toHaveAccessibleName('Unmute');
  await expect(page.locator('.lb-vc-play')).toHaveAccessibleName('Pause');
});

test("F3 edge: the panel's ↑/↓ follow the table's current search, and hide once the game is out of it", async ({
  page,
}) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360');
  const pos = page.locator('.panel-nav-pos');
  await expect(pos).toHaveText(/ \/ 6$/);
  const search = page.locator('.dt-search-input');

  await search.fill('Hollow');
  await expect(pos).toHaveText(''); // Hades isn't in the search any more
  await expect(page.getByRole('button', { name: 'Next game' })).toBeHidden();

  await search.fill('Ha');
  await expect(pos).toHaveText('1 / 1');
  await page.getByRole('button', { name: 'Next game' }).click(); // the search's only game: itself
  await expect(page.locator('#panel-title')).toHaveText('Hades');
});

test("F1 edge: the viewer's game stepper shows with its other controls, not only on hover", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=s1');
  await page.mouse.move(720, 450);
  for (const sel of ['.lb-caption-pos', '.lb-game-prev', '.lb-game-next'])
    await expect(page.locator(`#screenshot-lightbox ${sel}`)).toHaveCSS('opacity', '1');
  // Tab reaches the stepper too.
  const prev = page.locator('#screenshot-lightbox .lb-game-prev');
  for (let i = 0; i < 10 && !(await prev.evaluate((el) => el === document.activeElement)); i++)
    await page.keyboard.press('Tab');
  await expect(prev).toBeFocused();
});

test("F1 edge: the viewer's ↑/↓ game buttons stay put from game to game", async ({ page }) => {
  await asPlayer(page, ALICE);
  await mockApi(page, { states: ['many-shots'] });
  await page.goto('/lists/owned?game=1145360&shot=s1');
  const boxes = () =>
    page.evaluate(() =>
      // Layout offsets: a key hides the controls, drifting them a few pixels as they go.
      ['.lb-game-prev', '.lb-game-next'].map((sel) => {
        const el = document.querySelector<HTMLElement>(`#screenshot-lightbox ${sel}`)!;
        return [el.offsetLeft, el.offsetTop];
      }),
    );
  await expect(page.locator('.lb-caption-pos')).toHaveText(/^game \d+ \/ 6$/);
  const first = await boxes();
  const names = new Set<string>();
  for (let i = 0; i < 6; i++) {
    const name = (await page.locator('.lb-caption-text').textContent())!;
    names.add(name);
    expect(await boxes()).toEqual(first);
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.lb-caption-text')).not.toHaveText(name);
  }
  expect(names.size).toBe(6);
  // Nor from one media counter to the next, short or long.
  for (const [key, label] of [
    ['Home', 'Cover'],
    ['End', 'Screenshot 24 of 24'],
  ]) {
    await page.keyboard.press(key);
    await expect(page.locator('.lb-status')).toContainText(label);
    expect(await boxes()).toEqual(first);
  }
});

test('F1 edge: nothing of the page shows around the media', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=s1');
  await expect(page.locator('#screenshot-lightbox .lb-backdrop')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
});

test("F1 edge: the lightbox's counters say what they count", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=v1');
  // Two fractions side by side: the game's one says so.
  await expect(page.locator('.lb-caption-pos')).toHaveText(/^game \d+ \/ 6$/);
  await expect(page.locator('.lb-counter')).toHaveText('2 / 5');
  // Read out in full, the game named once: each kind numbered on its own (the banner, trailers, screenshots).
  const status = page.locator('#screenshot-lightbox [role="status"]');
  await expect(status).toHaveText(/^Hades, game \d+ of 6, Trailer 1 of 1$/);
  await page.getByRole('button', { name: 'Next screenshot' }).click();
  await expect(status).toHaveText('Screenshot 1 of 3');
  await expect(page.locator('.lb-counter')).toHaveText('3 / 5');
  await page.getByRole('button', { name: 'Previous screenshot' }).click();
  await page.getByRole('button', { name: 'Previous screenshot' }).click();
  await expect(status).toHaveText('Cover');
  await expect(page.getByRole('dialog', { name: 'Hades media viewer' })).toBeVisible();
});

test("M3 edge: a trailer the browser won't play with sound plays muted and says so; a mute is kept", async ({
  page,
}) => {
  await fakePlayback(page);
  // A browser that plays the stream natively (so it autoplays here) and refuses sound before any click.
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.canPlayType = () => 'maybe';
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      return this.muted ? play.call(this) : Promise.reject(new DOMException('No sound yet', 'NotAllowedError'));
    };
  });
  await mockApi(page, { states: ['playable-trailers'] });
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=v1');
  const unmute = page.locator('.lb-unmute');
  await expect(unmute).toBeVisible();
  await expect(page.locator('.lb-vc-play')).toHaveAccessibleName('Pause'); // playing, muted
  await unmute.click();
  await expect(unmute).toBeHidden();
  expect(await page.locator('.lb-video').evaluate((v: HTMLVideoElement) => v.muted)).toBe(false);
  // The viewer's own mute holds for the next trailer, even after a reload.
  await page.locator('.lb-vc-mute').click();
  await page.goto('/lists/owned?game=1145360&shot=v1');
  await expect(page.locator('.lb-vc-mute')).toHaveAccessibleName('Unmute');
  await expect(unmute).toBeHidden(); // muted by choice, not by the browser
  await expect(page.locator('.lb-vc-play')).toHaveAccessibleName('Pause');
});

test('M3 edge: a trailer that ends offers a replay, and its seek line reads out its time', async ({ page }) => {
  await fakePlayback(page);
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=v1');
  await page.getByRole('button', { name: 'Play trailer' }).click();
  await expect(page.getByRole('slider', { name: 'Seek' })).toHaveAttribute('aria-valuetext', '0:00 of 0:00');
  // As a browser does at the end: pause, then ended.
  await page.locator('.lb-video').evaluate(async (v: HTMLVideoElement) => {
    v.pause();
    await new Promise((resolve) => setTimeout(resolve));
    v.dispatchEvent(new Event('ended'));
  });
  const replay = page.getByRole('button', { name: 'Replay trailer' });
  await expect(replay).toBeVisible();
  await expect(replay.locator('.lucide-rotate-ccw')).toBeVisible();
  await expect(replay).toContainText('Replay'); // the arrow alone read as undo or refresh
  await replay.click();
  await expect(page.locator('.lb-vc-play')).toHaveAccessibleName('Pause');
});

test('F1 edge: a paused trailer offers a large play button', async ({ page }) => {
  await fakePlayback(page);
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=v1');
  const bigPlay = page.getByRole('button', { name: 'Play trailer' });
  await expect(bigPlay).toBeVisible();
  await bigPlay.click();
  await expect(bigPlay).toBeHidden();
  await expect(page.locator('.lb-vc-play')).toHaveAccessibleName('Pause');
  // The control draws its state: Pause while playing, not Play.
  await expect(page.locator('.lb-vc-play .lucide-pause')).toBeVisible();
  await expect(page.locator('.lb-vc-play .lucide-play')).toBeHidden();
});

test('F1 edge: a trailer not yet played shows its large play button, not the control bar', async ({ page }) => {
  await fakePlayback(page);
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=v1');
  await expect(page.getByRole('button', { name: 'Play trailer' })).toBeVisible();
  await expect(page.locator('.lb-vctrls')).toBeHidden();
  await page.getByRole('button', { name: 'Play trailer' }).click();
  await expect(page.locator('.lb-vctrls')).toBeVisible();
});

test("F1 edge: a paused trailer's controls idle out, leaving its large play button", async ({ page }) => {
  await page.clock.install();
  await fakePlayback(page);
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=v1');
  await page.getByRole('button', { name: 'Play trailer' }).click();
  await page.locator('.lb-vc-play').click(); // pause
  await page.mouse.move(720, 300); // off the button: a control under the mouse stays in sight
  const lb = page.locator('#screenshot-lightbox');
  await page.clock.runFor(3500);
  await expect(lb).toHaveClass(/lb-idle/);
  await expect(page.getByRole('button', { name: 'Play trailer' })).toBeVisible();
});

test('F1 edge: the viewer reopened after closing a playing trailer shows its controls', async ({ page }) => {
  await page.clock.install();
  await fakePlayback(page);
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=v1');
  await page.getByRole('button', { name: 'Play trailer' }).click();
  await page.getByRole('button', { name: 'Close lightbox' }).click();
  await page.clock.runFor(3500);
  await page.getByRole('button', { name: 'Open in lightbox' }).click();
  const lb = page.locator('#screenshot-lightbox');
  await expect(lb).toHaveAttribute('open');
  expect(await lb.getAttribute('class')).not.toMatch(/lb-idle/); // read once: the idle timer runs again
});

test('F1 edge: on a phone, swiping off a playing trailer leaves hidden controls hidden', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'touch only');
  await page.clock.install();
  await fakePlayback(page);
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=v1');
  await page.getByRole('button', { name: 'Play trailer' }).click();
  const lb = page.locator('#screenshot-lightbox');
  await page.clock.runFor(3500);
  await expect(lb).toHaveClass(/lb-idle/);
  const box = await visibleBox(page.locator('#screenshot-lightbox .lb-video'));
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y }] });
  for (const x of [260, 200, 120])
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('.lb-status')).toContainText('Screenshot 1 of 3');
  expect(await lb.getAttribute('class')).toMatch(/lb-idle/); // read once, as above
});

test('M1 edge: ←/→ step past a playing trailer; Shift+←/→ and J/L seek it', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'keyboard');
  await fakePlayback(page);
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=v1');
  const status = page.locator('.lb-status');
  const time = () => page.locator('.lb-video').evaluate((v: HTMLVideoElement) => v.currentTime);
  await page.getByRole('button', { name: 'Play trailer' }).click();
  await page.keyboard.press('Shift+ArrowRight');
  expect(await time()).toBe(5);
  await page.keyboard.press('l');
  expect(await time()).toBe(15);
  await page.keyboard.press('j');
  await page.keyboard.press('Shift+ArrowLeft');
  expect(await time()).toBe(0);
  await expect(status).toContainText('Trailer 1 of 1');
  await page.keyboard.press('ArrowRight');
  await expect(status).toContainText('Screenshot 1 of 3');
});

test('F1 edge: the wheel zooms toward the cursor over the picture only; a sideways swipe steps once', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'mouse');
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=s1');
  const img = page.locator('#screenshot-lightbox .lb-img');
  await stillShown(page, 'Screenshot 1 of 3');
  const box = await visibleBox(img);
  await page.mouse.move(box.x + 5, 450); // the backdrop, beside the picture
  await page.mouse.move(box.x - 20, 450);
  await page.mouse.wheel(0, -100);
  await expect(img).not.toHaveAttribute('style', /scale/);
  // Over the picture, near its right edge: that edge stays under the cursor.
  const at = { x: box.x + box.width - 40, y: box.y + box.height / 2 };
  await page.mouse.move(at.x, at.y);
  await page.mouse.wheel(0, -100);
  await expect(img).toHaveAttribute('style', /scale\(1\.15\)/);
  const after = await visibleBox(img);
  expect(Math.abs(after.x + after.width - 40 * 1.15 - at.x)).toBeLessThan(1);
  await page.keyboard.press('z'); // back out
  await expect(img).not.toHaveAttribute('style', /scale/);
  // One trackpad gesture, many events: one step. Frozen, so a slow event can't end the gesture early.
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 60_000);
  const counter = page.locator('#screenshot-lightbox .lb-counter-n'); // not the status line: its debounce is frozen too
  for (let i = 0; i < 8; i++) await page.mouse.wheel(30, 0);
  await expect(counter).toHaveText('4 / 5'); // Screenshot 2 of 3
  await page.clock.runFor(400); // the gesture ends
  for (let i = 0; i < 8; i++) await page.mouse.wheel(-30, 0);
  await expect(counter).toHaveText('3 / 5'); // Screenshot 1 of 3
});

test('F1 edge: on a zoomed screenshot the arrows pan it, and Esc zooms back out before closing', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'keyboard');
  await page.setViewportSize({ width: 800, height: 600 });
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=s1');
  const img = page.locator('#screenshot-lightbox .lb-img');
  const lb = page.locator('#screenshot-lightbox');
  // Z acts once the still is drawn below its natural size, as its button shows; "not loading" alone holds before it opens.
  await expect(lb.getByRole('button', { name: 'Zoom' })).toBeVisible();
  await page.keyboard.press('z');
  await expect(img).toHaveAttribute('style', /scale\(2\) translate\(0px, 0px\)/);
  await page.keyboard.press('ArrowRight');
  await expect(img).toHaveAttribute('style', /scale\(2\) translate\(-40px, 0px\)/);
  await expect(page.locator('.lb-status')).toContainText('Screenshot 1 of 3'); // panned, not stepped
  await page.keyboard.press('Escape');
  await expect(img).not.toHaveAttribute('style', /scale/);
  await expect(lb).toHaveAttribute('open');
  await page.keyboard.press('Escape');
  await expect(lb).not.toHaveAttribute('open');
});

test('F1 edge: a trailer pauses when the page is hidden, and stays paused', async ({ page }) => {
  await fakePlayback(page);
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=v1');
  await page.getByRole('button', { name: 'Play trailer' }).click();
  await expect(page.locator('.lb-vc-play')).toHaveAccessibleName('Pause');
  const setHidden = (hidden: boolean) =>
    page.evaluate((h) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
  await setHidden(true);
  await setHidden(false);
  await expect(page.locator('.lb-vc-play')).toHaveAccessibleName('Play');
  await expect(page.getByRole('button', { name: 'Play trailer' })).toBeVisible();
});

test("M3 edge: on a phone, the tap that brings back a trailer's controls leaves it playing", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'touch only');
  await page.clock.install();
  await fakePlayback(page);
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=v1');
  await page.getByRole('button', { name: 'Play trailer' }).tap();
  const lb = page.locator('#screenshot-lightbox');
  await page.clock.runFor(3500);
  await expect(lb).toHaveClass(/lb-idle/);
  await page.locator('.lb-video').tap();
  await expect(lb).not.toHaveClass(/lb-idle/);
  await expect(page.locator('.lb-vc-play')).toHaveAccessibleName('Pause');
  // A tap toggles the controls, as photo and video players do; the centre button plays and pauses.
  const offCentre = { position: { x: 195, y: 250 } };
  await page.locator('.lb-video').tap(offCentre);
  await expect(lb).toHaveClass(/lb-idle/);
  await expect(page.locator('.lb-vc-play')).toHaveAccessibleName('Pause');
  await page.locator('.lb-video').tap(offCentre);
  await page.getByRole('button', { name: 'Pause trailer' }).tap();
  await expect(page.locator('.lb-vc-play')).toHaveAccessibleName('Play');
});

test('M3 edge: on a phone, a double-tap seek leaves the trailer playing', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'touch only');
  await page.clock.install();
  await fakePlayback(page);
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=v1');
  await page.getByRole('button', { name: 'Play trailer' }).tap();
  await page.clock.runFor(3500); // controls idled out: the first tap only brings them back
  await expect(page.locator('#screenshot-lightbox')).toHaveClass(/lb-idle/);
  // Paused, so a slow tap under load still lands within the double-tap's 300 ms.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  const box = await visibleBox(page.locator('.lb-video'));
  const point = { x: box.x + box.width * 0.85, y: box.y + box.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  const tap = async (times: number) => {
    for (let i = 0; i < times; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
  };
  const time = () => page.locator('.lb-video').evaluate((v: HTMLVideoElement) => v.currentTime);
  await tap(2);
  await expect(page.locator('.lb-seek-flash-right')).toHaveClass(/lb-seek-flash--show/);
  expect(await time()).toBe(10);
  // Each further tap on that side adds 10 s more, as YouTube's do.
  await tap(1);
  await expect(page.locator('.lb-seek-flash-right')).toHaveText('20s');
  expect(await time()).toBe(20);
  await page.clock.runFor(1000);
  await expect(page.locator('.lb-vc-play')).toHaveAccessibleName('Pause');
});

test('F1 edge: on a phone, a sideways swipe drags the next media in beside the one leaving', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'touch only');
  await asPlayer(page, ALICE);
  // The panel's settle-delayed loads land right after the media do: a gesture during them loses touches (C224).
  const panelSettled = page.waitForResponse('**/api/game-news/**');
  await page.goto('/lists/owned?game=1145360&shot=s1');
  await stillShown(page, 'Screenshot 1 of 3');
  await panelSettled;
  const peek = page.locator('.lb-peek');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y: 420 }] });
  for (let x = 280; x >= 200; x -= 20)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: 420 }] });
  await expect(peek).toBeVisible();
  await expect(peek).toHaveAttribute('src', /Screenshot%202/);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(peek).toBeHidden();
  await expect(page.locator('.lb-status')).toContainText('Screenshot 2 of 3');
});

test('F1 edge: on a phone, a pinch zooms around the point between the fingers', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'touch only');
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=s1');
  const img = page.locator('#screenshot-lightbox .lb-img');
  await stillShown(page, 'Screenshot 1 of 3');
  const before = await visibleBox(img);
  const mid = { x: before.x + before.width * 0.75, y: before.y + before.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  const fingers = (gap: number) => [
    { x: mid.x - gap, y: mid.y },
    { x: mid.x + gap, y: mid.y },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(20) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: fingers(40) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(img).toHaveAttribute('style', /scale\(2\)/);
  const after = await visibleBox(img);
  // The same spot of the picture is still between the fingers.
  expect(Math.abs((mid.x - after.x) / after.width - 0.75)).toBeLessThan(0.01);
});

test('M1 edge: on a phone, swiping down closes a lightbox with no list of games to page', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'touch only');
  await asPlayer(page, ALICE);
  await page.goto('/lists/wishlist?game=1145360&shot=s1'); // Hades isn't on the wishlist: no game to page to
  const lb = page.locator('#screenshot-lightbox');
  await expect(lb).toHaveAttribute('open');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 350 }] });
  for (let y = 360; y <= 500; y += 20)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(lb).not.toHaveAttribute('open');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
});

test('F1 edge: Back closes the open game, then leaves the list', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/about');
  await page.goto('/lists/owned');
  await row(page, 'Hades').getByText('Hades').click();
  await expect(page).toHaveURL(/\?game=1145360/);
  await page.goBack();
  await expect(page.locator('#game-panel')).toBeHidden();
  await expect(page).toHaveURL(/\/lists\/owned$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/about$/);
});

test("F1 edge: Back closes the lightbox, then the game, in a tab past the browser's 50-entry history cap", async ({
  page,
}) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  // Stamped as the router stamps its pushes; Chromium stops growing `history.length` at 50.
  await page.evaluate(() => {
    for (let i = 0; i < 52; i++) history.pushState({ ...history.state, _depth: history.length - 1 }, '');
  });
  await row(page, 'Hades').getByText('Hades').click();
  await page.getByRole('button', { name: 'Open in lightbox' }).click();
  await expect(page).toHaveURL(/&shot=banner/);
  await page.goBack();
  await expect(page.locator('#screenshot-lightbox')).not.toHaveAttribute('open');
  await expect(page.locator('#game-panel')).toBeVisible();
  await expect(page).toHaveURL(/\?game=1145360$/);
  await page.goBack();
  await expect(page.locator('#game-panel')).toBeHidden();
  await expect(page).toHaveURL(/\/lists\/owned$/);
});

test('F1 edge: Back closes the lightbox before the game behind it', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await row(page, 'Hades').getByText('Hades').click();
  await page.getByRole('button', { name: 'Open in lightbox' }).click();
  await expect(page).toHaveURL(/&shot=banner/);
  await page.goBack();
  await expect(page.locator('#screenshot-lightbox')).not.toHaveAttribute('open');
  await expect(page.locator('#game-panel')).toBeVisible();
  await expect(page).toHaveURL(/\?game=1145360$/);
});

test('F1 edge: after closing the game with its Close button, one Back leaves the list', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/about');
  await page.goto('/lists/owned');
  await row(page, 'Hades').getByText('Hades').click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('#game-panel')).toBeHidden();
  await expect(page).toHaveURL(/\/lists\/owned$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/about$/);
});

test('F1 edge: Back from a page the game panel linked to reopens that game', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/about');
  await page.goto('/lists/owned');
  await row(page, 'Hades').getByText('Hades').click();
  await page.locator('#game-panel').getByText('Test Co-op Pack').click();
  await expect(page).toHaveURL(/\/lists\/bundle\//);
  await page.goBack();
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  await page.goBack();
  await expect(page.locator('#game-panel')).toBeHidden();
  await page.goBack();
  await expect(page).toHaveURL(/\/about$/);
});

test("F2 edge: a failed search says so, rather than 'No games found'", async ({ page }) => {
  await page.route('**/api/search-games?*', (route) =>
    route.fulfill({ status: 502, json: { error: 'Steam store request failed' } }),
  );
  await page.goto('/search?q=hades');
  await expect(page.getByText('Search failed — try again')).toBeVisible();
  await expect(page.getByText('No games found')).toHaveCount(0);
});

test("F2 edge: /search, About and the 404 page title themselves with the list routes' hero", async ({ page }) => {
  for (const [path, title] of [
    ['/search?q=hades', 'Search'],
    ['/about', 'About'],
    ['/compare', 'Page not found'],
  ]) {
    await page.goto(path);
    await expect(page.locator('.list-hero-title')).toHaveText(title);
    await expect(page.locator('h1')).toHaveCount(1);
  }
});

test('F2 edge: on /search, the box keeps a trailing space once the search runs', async ({ page }) => {
  await page.goto('/search?q=hade');
  const box = page.getByPlaceholder('Search for a game…');
  await box.fill('hades ');
  await expect(page).toHaveURL(/\?q=hades(&|$)/);
  await expect(rows(page)).toHaveCount(1);
  await expect(box).toHaveValue('hades ');
});

test('F2 edge: on /search, ↓ moves from the box into the results, and an opened result keeps its row focused', async ({
  page,
}) => {
  await page.goto('/search?q=hades');
  await expect(rows(page)).toHaveCount(1);
  await page.getByPlaceholder('Search for a game…').press('ArrowDown');
  await expect(rows(page).first()).toBeFocused();
  await rows(page).first().press('Enter');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  await expect(rows(page).first()).toBeFocused();
});

test("F2 edge: on /search, a DLC's panel keeps its way back once its details land", async ({ page }) => {
  let landDetails = () => {};
  const landed = new Promise<void>((resolve) => (landDetails = resolve));
  await page.route(/\/api\/game-details\/9000\d\d$/, async (route) => {
    await landed;
    await route.fulfill({ json: { appid: 900001, meta: null, failed: ['meta'] } });
  });
  await page.goto('/search?q=hades');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  const card = page.locator('#panel-section-dlc');
  await card.getByRole('button', { name: /DLC · 25 available/ }).click();
  await card.locator('.panel-dlc-item').first().click();
  const back = page.getByRole('button', { name: 'Back to Hades', exact: true });
  await expect(back).toBeVisible();
  const lookup = page.waitForResponse(/\/api\/game-details\/9000\d\d$/);
  landDetails();
  await lookup;
  // The page applies them right after the body parses: two frames is past that.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await expect(back).toBeVisible();
});

test('F2 edge: on /search, a game outside the results gets no list nav, as on a list page', async ({ page }) => {
  await page.route(/\/api\/game-details\/9000\d\d$/, (route) =>
    route.fulfill({ json: { appid: 900001, meta: null, failed: ['meta'] } }),
  );
  await page.goto('/search?q=hades');
  await expect(page.locator('#panel-reroll')).toBeVisible();
  const card = page.locator('#panel-section-dlc');
  await card.getByRole('button', { name: /DLC · 25 available/ }).click();
  await card.locator('.panel-dlc-item').first().click();
  await expect(page.getByRole('button', { name: 'Back to Hades', exact: true })).toBeVisible();
  await expect(page.locator('#panel-nav button')).toHaveCount(0);
  const dlc = await page.locator('#panel-title').textContent();
  await page.keyboard.press('r');
  await expect(page.locator('#panel-title')).toHaveText(dlc!);

  // A result restored from the address, before the results land, keeps its nav.
  await page.goto('/search?q=dead&game=550');
  await expect(page.locator('#panel-title')).toHaveText('Left 4 Dead 2');
  await expect(page.locator('#panel-reroll')).toBeVisible();
});

test('F2 edge: on /search, a lookup that fails says so', async ({ page }) => {
  await page.route(/\/api\/game-details\/1145360$/, (route) =>
    route.fulfill({ status: 502, json: { error: 'Steam store error 500' } }),
  );
  await page.goto('/search?q=hades');
  await expect(page.getByRole('status').filter({ hasText: 'Lookup failed' })).toContainText('Steam store error 500');
  await expect(page.locator('.panel-glance')).toContainText("didn't answer");
  await page.unrouteAll();
  await page.getByRole('button', { name: 'Refresh details' }).click();
  await expect(page.locator('.panel-glance')).not.toContainText("didn't answer");
  // Looked up after all: it joins Recently Looked Up.
  await page.goto('/game');
  await expect(row(page, 'Hades')).toBeVisible();
});

test('F2 edge: on /search, a failed refresh says so until one succeeds', async ({ page }) => {
  let fail = true;
  await page.route(/\/api\/game-details\/1145360\?refresh=1$/, (route) =>
    fail ? route.fulfill({ status: 502, json: { error: 'Steam store error 500' } }) : route.fallback(),
  );
  await page.goto('/search?q=hades');
  const refresh = page.getByRole('button', { name: 'Refresh details' });
  await refresh.click();
  const status = page.getByRole('status').filter({ hasText: 'Refresh failed' });
  await expect(status).toBeVisible();
  fail = false;
  await refresh.click();
  await expect(status).toHaveCount(0);
});

test('F2 edge: /search shows an image column only when a result has an image', async ({ page }) => {
  await page.route('**/api/search-games?q=portal*', (route) =>
    route.fulfill({ json: { results: [{ appid: 620, name: 'Portal 2', tinyImage: '/favicon.svg' }] } }),
  );
  await page.goto('/search?q=hades');
  await expect(rows(page)).toHaveCount(1);
  const columns = page.locator('.search-table thead th');
  await expect(columns).toHaveCount(1);

  await page.getByPlaceholder('Search for a game…').fill('portal');
  await expect(page.locator('.search-table .game-search-thumb')).toHaveCount(1);
  await expect(columns).toHaveCount(2);
  await expect(columns.last()).toHaveAttribute('data-col-key', 'name');
  // The page's own box is the search: the table shows no toolbar of its own.
  await expect(page.locator('.search-table .dt-toolbar')).toHaveCount(0);
});

test('F2 edge: /search marks an owned result even when the library lands after the results', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.route('**/api/common-games', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.fallback();
  });
  await page.goto('/search?q=hollow');
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, 'Hollow Knight').locator('.game-search-badge.owned')).toBeVisible();
});

test('F1.1-4: look up one game from the nav search, in place', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  await page.keyboard.press('/');
  await page.keyboard.type('hollow');
  await page.getByRole('option', { name: /Hollow Knight/ }).click();
  await expect(page).toHaveURL(/\/lists\/owned\?game=367520/);
  await expect(page.locator('.game-panel')).toContainText('Hollow Knight');

  // Esc hides the dropdown, then leaves the search box, so shortcuts work again.
  await page.keyboard.press('/');
  await page.keyboard.type('zz');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('INPUT');
});

test('F1 edge: a game looked up outside the list comes with its media', async ({ page }) => {
  await asPlayer(page, ALICE);
  const metaAsked = gameMetaRequests(page);
  await page.goto('/lists/wishlist');
  await expect(rows(page)).toHaveCount(4);
  await page.keyboard.press('/');
  await page.keyboard.type('hollow');
  await page.getByRole('option', { name: /Hollow Knight/ }).click();
  await expect(page.getByRole('button', { name: 'Screenshot 2 of 2' })).toBeVisible();
  expect(metaAsked).not.toContain('/api/game-meta/367520');
});

test("F1 edge: the open nav search's ✓ marks follow a link's account resolving", async ({ page }) => {
  await asPlayer(page, ALICE, { recentGames: [728880] }); // Overcooked! 2: Bob's, not Alice's
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/common-games', async (route) => {
    if (route.request().postData()?.includes('bob')) await held;
    await route.fallback();
  });
  await page.goto('/about?u=bob');
  await page.getByPlaceholder('Look up any game…').focus();
  const option = page.getByRole('option', { name: /Overcooked! 2/ });
  await expect(option).toBeVisible();
  await expect(option.locator('.game-search-badge.owned')).toHaveCount(0);
  release();
  await expect(option.locator('.game-search-badge.owned')).toBeVisible();
});

test('F1 edge: the nav search box empties after a pick and on a second Esc', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  const box = page.getByPlaceholder('Look up any game…');
  await box.fill('hollow');
  await page.getByRole('option', { name: /Hollow Knight/ }).click();
  await expect(page.locator('.game-panel')).toContainText('Hollow Knight');
  await expect(box).toHaveValue('');

  await box.fill('zz');
  await page.keyboard.press('Escape');
  await expect(box).toHaveValue('zz');
  await page.keyboard.press('Escape');
  await expect(box).toHaveValue('');
});

test('F1 edge: the nav search box’s Clear search button empties it and keeps it focused, back on the recents', async ({
  page,
}) => {
  await asPlayer(page, ALICE, { recentGames: [728880] });
  await page.goto('/about');
  const box = page.getByPlaceholder('Look up any game…');
  const clear = page.locator('.app-search-wrap').getByRole('button', { name: 'Clear search' });
  await expect(clear).toBeHidden();
  await box.fill('hollow');
  await clear.click();
  await expect(box).toHaveValue('');
  await expect(box).toBeFocused();
  await expect(clear).toBeHidden();
  await expect(page.getByRole('option', { name: /Overcooked! 2/ })).toBeVisible();
});

test('F2 edge: the /search box’s Clear search button empties it, and refocusing it selects its text to type over', async ({
  page,
}) => {
  await page.goto('/search?q=hades');
  await expect(rows(page)).toHaveCount(1);
  await expect(page.locator('.game-panel')).toBeVisible();
  await page.keyboard.press('Escape'); // the closest match's panel covers the box on a phone
  const box = page.getByPlaceholder('Search for a game…');
  await box.click();
  expect(await box.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 5]);
  await box.blur();

  await page.locator('.search-page-input').getByRole('button', { name: 'Clear search' }).click();
  await expect(box).toHaveValue('');
  await expect(box).toBeFocused();
  await expect(page.getByText('Type a game name to search.')).toBeVisible();
});

test('F1 edge: a first Esc with no dropdown to close leaves the nav search box but keeps its text', async ({
  page,
}) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  const box = page.getByPlaceholder('Look up any game…');
  await box.fill('620');
  await page.keyboard.press('Escape');
  await expect(box).not.toBeFocused();
  await expect(box).toHaveValue('620');
});

test('F1 edge: a search still pending when Esc or a pick closes the nav dropdown does not reopen it', async ({
  page,
}) => {
  await asPlayer(page, ALICE);
  await page.clock.install();
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  const box = page.getByPlaceholder('Look up any game…');
  const dropdown = page.locator('#app-search-results');

  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/search-games?q=hades*', async (route) => {
    await held;
    await route.fallback();
  });
  const asked = page.waitForRequest(/search-games\?q=hades/);
  await box.fill('hades');
  await asked;
  await page.keyboard.press('Escape');
  release();
  await page.waitForResponse(/search-games\?q=hades/);
  await page.clock.runFor(200); // let the late answer render, if it would
  await expect(dropdown).toBeHidden();

  await box.fill('hollow');
  await expect(page.getByRole('option', { name: /Hollow Knight/ })).toBeVisible();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  await expect(page.locator('#panel-title')).toHaveText('Hollow Knight');
  await page.clock.runFor(500); // past the search debounce
  await expect(dropdown).toBeHidden();
});

test('F1 edge: tabbing out of the nav search box before its search answers opens no dropdown', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.clock.install();
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  const box = page.getByPlaceholder('Look up any game…');
  await box.fill('hades');
  await page.keyboard.press('Tab');
  await expect(box).not.toBeFocused();
  await page.clock.runFor(500); // past the search debounce
  await expect(page.locator('#app-search-results')).toBeHidden();
});

test('F1 edge: Esc closes a nav popover or the search dropdown, not the open game', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', "a phone's panel covers the nav");
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=620');
  await expect(page.locator('#panel-title')).toHaveText('Portal 2');

  await page.getByLabel('Preferences').click();
  await expect(page.locator('.site-nav-prefs-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.site-nav-prefs-panel')).toBeHidden();
  await expect(page.locator('#panel-title')).toBeVisible();

  await page.getByPlaceholder('Look up any game…').fill('hollow');
  await expect(page.locator('.game-search-result', { hasText: 'Hollow Knight' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#app-search-results')).toBeHidden();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('INPUT');
  await expect(page.locator('#panel-title')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#panel-title')).toBeHidden();
});

test("F1 edge: the panel's More links menu holds only links found nowhere else, and Esc closes it before the game", async ({
  page,
}) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360');
  const more = page.getByRole('button', { name: 'More links' });
  await more.click();
  const menu = page.locator('.panel-icon-more-menu');
  await expect(menu.getByRole('link')).toHaveText(['Official website ↗']);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(page.locator('#panel-title')).toBeVisible();
  await expect(more).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#panel-title')).toBeHidden();
});

test("F1 edge: the panel's More links menu closes once focus leaves it", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360');
  await page.getByRole('button', { name: 'More links' }).click();
  const menu = page.locator('.panel-icon-more-menu');
  await page.keyboard.press('Tab');
  await expect(menu.getByRole('link')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu).toBeHidden();
});

test("F1 edge: Esc goes to what's above the panel's More links menu, and to nothing once the panel is gone", async ({
  page,
}) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await row(page, 'Hades').getByText('Hades').click();
  await page.getByRole('button', { name: 'More links' }).click();
  await page.keyboard.press('?');
  const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(shortcuts).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(shortcuts).toBeHidden();

  await page.getByRole('button', { name: 'More links' }).click();
  await page.goBack();
  await expect(page.locator('#game-panel')).toBeHidden();
  await page.keyboard.press('?');
  await expect(shortcuts).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(shortcuts).toBeHidden();
});

test('C1 edge: a wrapped game name keeps its ✓/☆ badge right after the last word', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'names wrap at phone width');
  await asPlayer(page, ALICE);
  await page.goto('/lists/compare?u=alice&u=bob');
  await expect(rows(page).first()).toBeVisible();
  const gaps = await page.locator('.game-name-cell').evaluateAll((cells) =>
    cells.flatMap((cell) => {
      const text = cell.firstChild!;
      const range = document.createRange();
      range.selectNodeContents(text);
      const lines = [...range.getClientRects()];
      const badge = cell.querySelector('.name-status-badge')?.getBoundingClientRect();
      if (lines.length < 2 || !badge) return [];
      return [Math.round(badge.left - lines.at(-1)!.right)];
    }),
  );
  expect(gaps.length).toBeGreaterThan(0);
  for (const gap of gaps) expect(gap).toBeLessThanOrEqual(8);
});

test('F1 edge: Enter opens the highlighted recently looked-up game', async ({ page }) => {
  await asPlayer(page, ALICE, { recentGames: [620, 1145360] });
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  await page.keyboard.press('/');
  await expect(page.locator('.game-search-result')).toHaveCount(2);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/[?&]game=1145360\b/);
});

test("I1 edge: on a phone, a bundle's table starts high, its other actions behind More actions", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'phone layout only');
  await asPlayer(page, ALICE);
  await page.goto(`/lists/bundle/${BUNDLE.id}`);
  await expect(rows(page)).toHaveCount(4);
  // How many lines a row of controls takes, by the distinct tops of those shown.
  const lines = (selector: string) =>
    page
      .locator(selector)
      .evaluateAll(
        (els) =>
          new Set(els.filter((el) => el.checkVisibility()).map((el) => Math.round(el.getBoundingClientRect().top)))
            .size,
      );
  expect(await lines('.list-hero-stats > .list-stat')).toBe(1);
  expect(await lines('.list-hero-actions > *')).toBe(1);
  expect(await lines('.dt-toolbar-actions > *')).toBeLessThanOrEqual(2);
  // Room to spare: with wider text still, More actions must not drop to a line of its own.
  await page.addStyleTag({ content: '.list-hero-actions { letter-spacing: 1px }' });
  const rowY = (name: string) => page.getByRole('link', { name }).evaluate((el) => el.getBoundingClientRect().top);
  const moreY = await page
    .getByRole('button', { name: 'More actions' })
    .evaluate((el) => el.getBoundingClientRect().top);
  expect(Math.abs(moreY - (await rowY('Get this bundle ↗')))).toBeLessThan(5);
  await expect(page.getByRole('link', { name: 'View on IsThereAnyDeal ↗' })).toBeHidden();
  await page.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('link', { name: 'View on IsThereAnyDeal ↗' })).toBeVisible();
});

test("C3 edge: on a phone, the hero's More actions centres its ⋯", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'phone layout only');
  await asPlayer(page, ALICE);
  await page.goto('/lists/compare?u=alice&u=bob');
  const more = page.getByRole('button', { name: 'More actions' });
  const centre = (box: { x: number; y: number; width: number; height: number } | null) => [
    box!.x + box!.width / 2,
    box!.y + box!.height / 2,
  ];
  const [bx, by] = centre(await visibleBox(more));
  const [ix, iy] = centre(await visibleBox(more.locator('svg')));
  expect(Math.abs(ix - bx)).toBeLessThan(1);
  expect(Math.abs(iy - by)).toBeLessThan(1);
});

test('I1 edge: on a phone, small controls still take a 24px tap', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'phone layout only');
  // True when a tap 12px from the centre, on each side, still lands on the control.
  const takes24pxTap = async (control: Locator) => {
    await control.scrollIntoViewIfNeeded();
    return control.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const [x, y] = [r.left + r.width / 2, r.top + r.height / 2];
      const d = 11.99; // a hit test excludes a box's far edge: exactly 12 would demand 25px
      const points = [
        [x, y - d],
        [x, y + d],
        [x - d, y],
        [x + d, y],
      ];
      return points.every(([px, py]) => el.contains(document.elementFromPoint(px, py)));
    });
  };
  await asPlayer(page, ALICE);
  await page.goto('/');
  await page.getByRole('button', { name: 'New list' }).click();
  await page.getByRole('textbox', { name: 'List name' }).fill('Shortlist');
  await page.keyboard.press('Enter');
  expect(await takes24pxTap(page.locator('.list-tree').getByRole('link', { name: 'Shortlist' }))).toBe(true);
  expect(await takes24pxTap(rowMenu(page, 'Shortlist'))).toBe(true);
  await rowMenu(page, 'Shortlist').click();
  expect(await takes24pxTap(page.getByRole('button', { name: 'Rename Shortlist' }))).toBe(true);
  expect(await takes24pxTap(page.getByRole('button', { name: 'Delete Shortlist' }))).toBe(true);
  await page.keyboard.press('Escape');

  await page.goto('/lists/compare');
  expect(await takes24pxTap(page.getByRole('button', { name: 'Remove Alice' }))).toBe(true);

  await page.goto('/lists/owned');
  // A header sorts from anywhere in its cell, not just its label's button.
  const header = page.locator('.dt-th[data-col-key="releaseDate"]');
  expect(await takes24pxTap(header)).toBe(true);
  const label = await visibleBox(header.locator('.dt-th-sort'));
  const cell = await visibleBox(header);
  await page.mouse.click(label.x + 4, cell.y + cell.height - 3);
  await expect(header).toHaveAttribute('aria-sort', /ascending|descending/);
  expect(await takes24pxTap(page.getByRole('link', { name: 'About' }))).toBe(true);
  await page.locator('.account-chip-btn').click();
  expect(await takes24pxTap(page.locator('.account-chip-panel').getByRole('link', { name: 'Wishlist' }))).toBe(true);
  await page.keyboard.press('Escape');
  await page.keyboard.press('?');
  expect(
    await takes24pxTap(page.getByRole('dialog', { name: 'Keyboard shortcuts' }).getByRole('button', { name: 'Close' })),
  ).toBe(true);

  await page.goto('/');
  const friends = page.locator('.account-friends summary');
  expect(await takes24pxTap(friends)).toBe(true);
  expect(await takes24pxTap(page.getByRole('button', { name: 'Unstar Alice' }))).toBe(true);
  expect(await takes24pxTap(page.getByRole('button', { name: 'Edit', exact: true }))).toBe(true);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  expect(await takes24pxTap(page.getByRole('button', { name: 'Remove Alice' }))).toBe(true);
  await friends.click();
  expect(await takes24pxTap(page.locator('.account-friends-refresh'))).toBe(true);

  await page.getByRole('button', { name: 'Add Steam Family account' }).click();
  const fields = page.getByPlaceholder('Steam name, profile URL, or 64-bit ID…');
  await fields.nth(0).fill('alice');
  await fields.nth(1).fill('bob');
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  expect(await takes24pxTap(page.locator('.account-members').getByRole('link', { name: 'Bob ↗' }))).toBe(true);
});

test('I2 edge: the lightbox opens focused on its media, with no ring; Tab brings one to its controls', async ({
  page,
}, testInfo) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360');
  const hero = page.getByRole('button', { name: 'Open in lightbox' });
  const ring = () => page.evaluate(() => document.activeElement!.matches(':focus-visible'));
  if (testInfo.project.name === 'phone') await hero.tap();
  else {
    await hero.focus();
    await page.keyboard.press('Enter');
  }
  await expect(page.locator('.lb-surface')).toBeFocused();
  // Opaque, so the panel behind doesn't show through around the media.
  await expect(page.locator('.lb-backdrop')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  await expect(page.locator('.lb-surface')).toHaveCSS('outline-style', 'none');
  if (testInfo.project.name === 'phone') return;
  await page.keyboard.press('Tab');
  await expect(page.locator('#screenshot-lightbox button:focus')).toHaveCount(1);
  expect(await ring()).toBe(true);
});

test('I2 edge: Tab cycles the lightbox controls on a game with a single item', async ({ page }, testInfo) => {
  // Serves the cover from localhost, so it loads instead of showing its Retry.
  await mockApi(page, { states: ['slow-media'] });
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=620');
  await page.getByRole('button', { name: 'Open in lightbox' }).focus();
  await page.keyboard.press('Enter');
  const img = page.locator('.lb-img');
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator('.lb-surface')).toBeFocused();
  const focused = () =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      return el.checkVisibility({ visibilityProperty: true }) ? el.ariaLabel : null;
    });
  const seen: (string | null)[] = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    seen.push(await focused());
  }
  // Zoom only where the 1280 px cover is drawn smaller: a phone, not desktop.
  const cycle = ['Previous game', 'Next game', 'Enter fullscreen'];
  if (testInfo.project.name === 'phone') cycle.push('Zoom');
  cycle.push('Close lightbox');
  expect(seen).toEqual([...cycle, ...cycle].slice(0, 6));
});

test('I2 edge: a focused lightbox control stays visible while the controls idle out', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'keyboard');
  await page.clock.install();
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=s1');
  await expect(page.locator('.lb-surface')).toBeFocused();
  await page.keyboard.press('Tab');
  const focused = page.locator('#screenshot-lightbox button:focus-visible');
  await expect(focused).toHaveCount(1);
  await page.clock.runFor(4000);
  await expect(page.locator('#screenshot-lightbox')).not.toHaveClass(/lb-idle/);
  await expect(focused).toHaveCSS('opacity', '1');
});

test('I2 edge: the lightbox is modal; ? opens the shortcuts over it, and Esc closes the innermost', async ({
  page,
}) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360&shot=s1');
  const lb = page.locator('#screenshot-lightbox');
  await expect(page.locator('.lb-status')).toContainText('Screenshot 1 of 3');
  expect(await lb.evaluate((d) => d.matches(':modal'))).toBe(true); // the page behind is inert
  await page.keyboard.press('?');
  const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(shortcuts).toBeVisible();
  await page.keyboard.press('ArrowRight'); // the shortcuts dialog has the keyboard
  await page.keyboard.press('Escape');
  await expect(shortcuts).toBeHidden();
  await expect(lb).toHaveAttribute('open');
  await expect(page.locator('.lb-status')).toContainText('Screenshot 1 of 3');
  await page.keyboard.press('Escape');
  await expect(lb).not.toHaveAttribute('open');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  await expect(page).toHaveURL(/\?game=1145360$/);
});

test('I2 edge: a lightbox the browser closes itself leaves the address and history as a close does', async ({
  page,
}) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await row(page, 'Hades').getByText('Hades').click();
  await page.getByRole('button', { name: 'Open in lightbox' }).click();
  await expect(page).toHaveURL(/&shot=/);
  // As the browser does when it won't let `cancel` be cancelled (no user activation since the last).
  await page.locator('#screenshot-lightbox').evaluate((d) => (d as HTMLDialogElement).close());
  await expect(page).toHaveURL(/\?game=1145360$/);
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  await page.goBack();
  await expect(page.locator('#game-panel')).toBeHidden();
  await expect(page).toHaveURL(/\/lists\/owned$/);
});

test("I2 edge: the panel's current thumbnail is exposed, not only coloured", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360');
  const current = page.locator('.panel-film-item[aria-current="true"]');
  await expect(current).toHaveAccessibleName('Cover');
  await page.getByRole('button', { name: 'Screenshot 2 of 3' }).click();
  await expect(current).toHaveAccessibleName('Screenshot 2 of 3');
  await expect(current).toHaveCount(1);
});

test("I2 edge: the open game's row is exposed as current, not only coloured", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360');
  const current = page.locator('.dt-tr[aria-current="true"]');
  await expect(current).toHaveCount(1);
  await expect(current).toContainText('Hades');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(current).toHaveCount(0);
});

test('I2 edge: Esc closing the panel returns focus to the row it was showing', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360');
  await expect(page.locator('.game-panel')).toBeVisible();
  // The panel can open before the rows land, leaving ↓ nothing to step to.
  await expect(rows(page)).toHaveCount(6);
  await page.keyboard.press('ArrowDown');
  await expect(page).not.toHaveURL(/[?&]game=1145360\b/);
  const shown = new URL(page.url()).searchParams.get('game');
  await page.keyboard.press('Escape');
  await expect(page.locator('.game-panel')).toBeHidden();
  await expect(page.locator(`tr.dt-tr[data-row-key="${shown}"]`)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator(`tr.dt-tr[data-row-key="${shown}"]`)).not.toBeFocused();
  await expect(page.locator('tr.dt-tr:focus')).toHaveCount(1);
});

test('I2 edge: the Close button closing the panel returns focus to the row it was showing', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await row(page, 'Hades').getByText('Hades').click();
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#panel-title')).not.toHaveText('Hades');
  const shown = new URL(page.url()).searchParams.get('game');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.game-panel')).toBeHidden();
  await expect(page.locator(`tr.dt-tr[data-row-key="${shown}"]`)).toBeFocused();
});

test("I2 edge: the panel's ground takes a trace of the game's art, and stays neutral when the art can't be read", async ({
  page,
}) => {
  await asPlayer(page, ALICE);
  const panel = page.locator('.game-panel');
  // The mock's CDN is unreachable: no tint, the plain surface.
  await page.goto('/lists/owned?game=1145360');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  const neutral = await panel.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await panel.evaluate((el) => el.style.getPropertyValue('--panel-tint'))).toBe('');
  // A red capsule: the ground turns faintly red, dark enough to keep its text's contrast.
  await page.route(/steamstatic\.com/, (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="231" height="87"><rect width="231" height="87" fill="#d22"/></svg>',
    }),
  );
  await page.reload();
  await expect(panel).toHaveAttribute('style', /--panel-tint: oklch\(0\.17 0\.040 /);
  await expect(panel).not.toHaveCSS('background-color', neutral);
  await expect(page.locator('.panel-header-sticky')).toHaveCSS(
    'background-color',
    await panel.evaluate((el) => getComputedStyle(el).backgroundColor),
  );
});

test('F1 edge: under reduced motion the lightbox opens and closes without morphing', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360');
  await expect(page.locator('.panel-hero-img')).not.toHaveClass(/loading/);
  await page.evaluate(() => {
    const w = window as unknown as { transitions: number };
    w.transitions = 0;
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = (cb) => (w.transitions++, start(cb));
  });
  await page.getByRole('button', { name: 'Open in lightbox' }).click();
  await expect(page.locator('#screenshot-lightbox')).toHaveAttribute('open');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.lb-status')).toContainText('Trailer 1 of 1');
  await page.keyboard.press('Escape');
  await expect(page.locator('#screenshot-lightbox')).toBeHidden();
  expect(await page.evaluate(() => (window as unknown as { transitions: number }).transitions)).toBe(0);
});

// Counts the panel's sliding-out copies, and the ids they duplicate while there.
async function watchPanelGhosts(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { ghosts: number; dupIds: number };
    w.ghosts = 0;
    w.dupIds = 0;
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes)
          if ((n as Element).classList?.contains('panel-ghost')) {
            w.ghosts++;
            const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
            w.dupIds += ids.length - new Set(ids).size;
          }
    }).observe(document.body, { childList: true, subtree: true });
  });
  return () => page.evaluate(() => (window as unknown as { ghosts: number; dupIds: number }).ghosts);
}

test('I2 edge: under reduced motion, a closed panel leaves no sliding copy', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  const ghosts = await watchPanelGhosts(page);
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('#panel-title')).toBeHidden();
  expect(await ghosts()).toBe(0);
});

// Clicks a section's toggle and reports, in that same task, its body's state.
const toggleSectionNow = (toggle: Locator) =>
  toggle.evaluate((b: HTMLElement) => {
    b.click();
    const body = b.closest('.panel-achievements-card')!.querySelector<HTMLElement>('.panel-collapsible-body');
    return body && { animations: body.getAnimations().length, inert: body.inert };
  });

test('I2 edge: under reduced motion, a section shuts at once', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360');
  const toggle = page.locator('#panel-section-dlc').getByRole('button', { name: /DLC · 25 available/ });
  await toggle.click();
  await expect(page.locator('#panel-section-dlc .panel-collapsible-body')).toBeVisible();
  expect(await toggleSectionNow(toggle)).toBeNull();
});

test.describe('with motion on', () => {
  test.use({ reducedMotion: 'no-preference' });

  test("A1 edge: a list's first rows come in staggered, and a refresh doesn't replay it", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { arrivals: string[] };
      w.arrivals = [];
      new MutationObserver((records) => {
        for (const r of records)
          if ((r.target as Element).classList.contains('dt-tr--arrive'))
            w.arrivals.push((r.target as HTMLElement).dataset.procIdx!);
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ['class'] });
    });
    const arrivals = () => page.evaluate(() => (window as unknown as { arrivals: string[] }).arrivals);
    await asPlayer(page, ALICE);
    await page.goto('/lists/owned');
    await expect(rows(page)).toHaveCount(6);
    await expect.poll(arrivals).toEqual(['0', '1', '2', '3', '4', '5']);
    await expect(page.locator('.dt-tr--arrive')).toHaveCount(0);
    await page.getByRole('button', { name: /^Updated\b/ }).click();
    await expect(page.locator('.list-stat', { hasText: 'Updated' })).not.toContainText('Refreshing');
    await expect(rows(page)).toHaveCount(6);
    expect(await arrivals()).toHaveLength(6);
  });

  test('L3 edge: a sort slides each row to its new place; typing a search moves nothing', async ({ page }) => {
    await asPlayer(page, ALICE);
    await page.goto('/lists/owned');
    await expect(rows(page)).toHaveCount(6);
    await expect(page.locator('.dt-tr--arrive')).toHaveCount(0);
    // Records each row slide's start offset as it begins: a 250 ms slide may be over by the next round trip.
    await page.evaluate(() => {
      const w = window as unknown as { slides: string[] };
      w.slides = [];
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
        const [frames, options] = args as [Keyframe[], KeyframeAnimationOptions];
        if (options?.id === 'row-slide') w.slides.push(String(frames[0].translate ?? 'fade'));
        return animate.apply(this, args);
      };
    });
    const slides = () => page.evaluate(() => (window as unknown as { slides: string[] }).slides.splice(0));
    // Synthetic: the slide's start positions are read on the pointerdown.
    await page.locator('.dt-th-sort', { hasText: 'Name' }).evaluate((b: HTMLElement) => {
      b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      b.click();
    });
    await expect(rows(page).first()).toContainText('Hades');
    const started = await slides();
    expect(started.length).toBeGreaterThan(0);
    for (const offset of started) expect(offset).toMatch(/^0 -?\d+(\.\d+)?px$/);
    await page.evaluate(() => document.getAnimations().forEach((a) => a.id === 'row-slide' && a.finish()));
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll('tr[data-row-key]')].map((r) => {
          const cs = getComputedStyle(r);
          return `${cs.translate} ${cs.opacity}`;
        }),
      ),
    ).toEqual(Array(6).fill('none 1'));
    await page.locator('.dt-toolbar input').first().pressSequentially('hades');
    await expect(rows(page)).toHaveCount(1);
    expect(await slides()).toEqual([]);
  });

  test('L5 edge: a banner comes down into place from its first frame', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { bannerFirstFrame: number | null };
      w.bannerFirstFrame = null;
      new MutationObserver(() => {
        const banner = document.querySelector('.pref-unsaved-banner');
        if (!banner || w.bannerFirstFrame !== null) return;
        w.bannerFirstFrame = -1;
        // Read in the frame it first paints: its transition has only just started there.
        requestAnimationFrame(() => (w.bannerFirstFrame = Number(getComputedStyle(banner).opacity)));
      }).observe(document, { childList: true, subtree: true });
    });
    await asPlayer(page, ALICE);
    const tv = JSON.stringify({ sorts: [{ key: 'name', dir: 'desc' }] });
    await page.goto(`/lists/owned?tv=${encodeURIComponent(tv)}`);
    const banner = page.locator('.pref-unsaved-banner');
    await expect(banner).toHaveCSS('opacity', '1');
    await expect(banner).toHaveCSS('translate', 'none');
    const first = await page.evaluate(() => (window as unknown as { bannerFirstFrame: number }).bannerFirstFrame);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(1);
  });

  test('A1 edge: an Explore card lifts under a mouse and stays up at its bottom edge; not under a finger', async ({
    page,
  }, testInfo) => {
    await asPlayer(page, ALICE);
    await page.goto('/');
    const card = page
      .locator('.explore-card')
      .filter({ has: page.getByRole('link', { name: 'Wishlist', exact: true }) });
    const box = await visibleBox(card);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 1);
    if (testInfo.project.name === 'phone') {
      await expect(card).toHaveCSS('translate', 'none');
      return;
    }
    await expect(card).toHaveCSS('translate', '0px -3px');
    await page.evaluate(() => document.getAnimations().forEach((a) => a.finish()));
    // A move re-tests the hover against the lifted card, at once: without the gap filled, it drops.
    await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height - 1);
    expect(await card.evaluate((c) => c.matches(':hover'))).toBe(true);
  });

  test('B1 edge: a hero count counts to its new value, the final value what is read out throughout', async ({
    page,
  }) => {
    await asPlayer(page, ALICE);
    await page.goto('/bundles');
    const fresh = page.getByRole('button', { name: /^New \d/ });
    await expect(fresh).toHaveAccessibleName(/^New 2\b/);
    // Showing only the bundle ending soon leaves one of the two new ones. Read in the click's own
    // task: the count is over 400 ms later.
    const mid = await page.getByRole('button', { name: /^Ending soon \d/ }).evaluate((b: HTMLElement) => {
      b.click();
      const drawn = document.querySelector('.list-stat-count');
      return { drawn: drawn?.textContent, hidden: drawn?.ariaHidden, read: drawn?.nextElementSibling?.textContent };
    });
    expect(mid).toEqual({ drawn: '2', hidden: 'true', read: '1' });
    await expect(page.locator('.list-stat-count')).toHaveCount(0);
    await expect(fresh).toHaveAccessibleName(/^New 1\b/);
    await expect(fresh.locator('.list-stat-value')).toHaveText('1');
  });

  test('I2 edge: a click slides a section open and shut, its body inert on the way out; a reopened game just shows it', async ({
    page,
  }) => {
    await asPlayer(page, ALICE);
    await page.goto('/lists/owned?game=1145360');
    const card = page.locator('#panel-section-dlc');
    const toggle = card.getByRole('button', { name: /DLC · 25 available/ });
    const body = card.locator('.panel-collapsible-body');
    // Not the loading shimmer's endless loop, which can't be finished.
    const finishAll = () =>
      page.evaluate(() =>
        document.getAnimations().forEach((a) => a.effect?.getComputedTiming().endTime !== Infinity && a.finish()),
      );
    expect(await toggleSectionNow(toggle)).toEqual({ animations: 1, inert: false });
    await finishAll();
    await expect(body).toBeVisible();
    expect(await toggleSectionNow(toggle)).toEqual({ animations: 1, inert: true });
    await finishAll();
    await expect(body).toHaveCount(0);
    await toggle.click();
    await finishAll();
    await page.getByRole('button', { name: 'Next game' }).click();
    await expect(page.locator('#panel-title')).not.toHaveText('Hades');
    await page.getByRole('button', { name: 'Previous game' }).click();
    await expect(page.locator('#panel-title')).toHaveText('Hades');
    await expect(body).toBeVisible();
    expect(await body.evaluate((b) => b.getAnimations().length)).toBe(0);
  });

  test('I2 edge: a closed panel slides out as a copy without ids, which then goes', async ({ page }) => {
    await asPlayer(page, ALICE);
    await page.goto('/lists/owned?game=1145360');
    await expect(page.locator('#panel-title')).toHaveText('Hades');
    const ghosts = await watchPanelGhosts(page);
    await page.getByRole('button', { name: 'Close' }).click();
    await expect.poll(ghosts).toBe(1);
    expect(await page.evaluate(() => (window as unknown as { dupIds: number }).dupIds)).toBe(0);
    await expect(page.locator('.panel-ghost')).toHaveCount(0);
    await expect(page.locator('#panel-title')).toBeHidden();
    await expect(row(page, 'Hades')).toBeFocused();
  });

  test('I2 edge: leaving the route closes the panel without a sliding copy', async ({ page }) => {
    await asPlayer(page, ALICE);
    await page.goto('/lists/owned?game=1145360');
    await expect(page.locator('#panel-title')).toHaveText('Hades');
    const ghosts = await watchPanelGhosts(page);
    // A DOM click: on a phone the panel covers the nav.
    await page.getByRole('link', { name: 'Home', exact: true }).evaluate((a: HTMLElement) => a.click());
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('#panel-title')).toBeHidden();
    expect(await ghosts()).toBe(0);
  });

  test('I2 edge: on a phone, a swiped-away panel leaves no second, sliding copy', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'touch only');
    await page.clock.install();
    await asPlayer(page, ALICE);
    await page.goto('/lists/owned?game=1145360');
    await expect(page.locator('#panel-title')).toHaveText('Hades');
    const ghosts = await watchPanelGhosts(page);
    // Synthetic events: Chromium holds back real touchmoves within its slop.
    await page.locator('#panel-title').evaluate((title) => {
      const y = title.getBoundingClientRect().top + 5;
      const fire = (type: string, x: number) => {
        const touch = new Touch({ identifier: 1, target: title, clientX: x, clientY: y });
        const touches = type === 'touchend' ? [] : [touch];
        title.dispatchEvent(
          new TouchEvent(type, { bubbles: true, cancelable: true, touches, changedTouches: [touch] }),
        );
      };
      fire('touchstart', 40);
      for (const x of [50, 100, 160, 220]) fire('touchmove', x);
      fire('touchend', 220);
    });
    await page.clock.runFor(500);
    await expect(page.locator('#panel-title')).toBeHidden();
    expect(await ghosts()).toBe(0);
  });

  test('I2 edge: the panel slides in to rest, focus on its hero', async ({ page }) => {
    await asPlayer(page, ALICE);
    await page.goto('/lists/owned');
    await row(page, 'Hades').getByText('Hades').click();
    const panel = page.locator('.game-panel');
    await expect(panel).toHaveCSS('opacity', '1');
    await expect(panel).toHaveCSS('translate', 'none');
    await expect(page.locator('#panel-title')).toHaveText('Hades');
    await expect(page.locator('.panel-hero-open')).toBeFocused();
    await expect(page.locator('.panel-hero-img')).toHaveCSS('opacity', '1');
  });

  for (const viewTransitions of [true, false]) {
    test(`I2 edge: a row click opens the panel on its hero, focused, Back closing it (View Transitions ${viewTransitions ? 'on' : 'absent'})`, async ({
      page,
    }) => {
      if (!viewTransitions)
        await page.addInitScript(() => delete (Document.prototype as Partial<Document>).startViewTransition);
      // The morph needs a loaded thumbnail; the CDN is otherwise unreachable here.
      await page.route(/steamstatic\.com/, (route) =>
        route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="231" height="87"><rect width="231" height="87" fill="#468"/></svg>',
        }),
      );
      await asPlayer(page, ALICE);
      await page.goto('/lists/owned');
      await expect(rows(page)).toHaveCount(6);
      await expect(row(page, 'Hades').locator('.game-thumb')).toHaveJSProperty('complete', true);
      const started = page.evaluate(
        () =>
          new Promise<boolean>((resolve) => {
            const start = document.startViewTransition?.bind(document);
            if (!start) return resolve(false);
            document.startViewTransition = (cb) => (resolve(true), start(cb));
          }),
      );
      await row(page, 'Hades').getByText('Hades').click();
      expect(await started).toBe(viewTransitions);
      await expect(page.locator('#panel-title')).toHaveText('Hades');
      await expect(page.locator('.panel-hero-open')).toBeFocused();
      await expect(page.locator('.panel-hero-img')).toHaveCSS('opacity', '1');
      await expect(page.locator('.game-panel')).toHaveCSS('translate', 'none');
      await expect(page.locator('[style*="view-transition-name"]')).toHaveCount(0);
      await page.goBack();
      await expect(page.locator('.game-panel')).toBeHidden();
      await expect(page).not.toHaveURL(/[?&]game=/);
    });
  }

  test("F1 edge: a click on the panel's picture grows it into the lightbox, focused, Back closing only that", async ({
    page,
  }) => {
    await asPlayer(page, ALICE);
    await page.goto('/lists/owned?game=1145360');
    await page.getByRole('button', { name: 'Screenshot 1 of 3' }).click();
    await expect(page.locator('.panel-hero-img')).not.toHaveClass(/loading/);
    const started = page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const start = document.startViewTransition.bind(document);
          document.startViewTransition = (cb) => (resolve(true), start(cb));
        }),
    );
    await page.getByRole('button', { name: 'Open in lightbox' }).click();
    expect(await started).toBe(true);
    await expect(page.locator('.lb-surface')).toBeFocused();
    await expect(page.locator('#screenshot-lightbox')).toHaveCSS('opacity', '1');
    await expect(page.locator('.lb-img')).toHaveAttribute('src', /Screenshot%201%3C/);
    await expect(page.locator('.lb-img')).toHaveCSS('opacity', '1');
    await expect(page.locator('[style*="view-transition-name"]')).toHaveCount(0);
    await page.goBack();
    await expect(page.locator('#screenshot-lightbox')).toBeHidden();
    await expect(page.locator('#panel-title')).toHaveText('Hades');
  });

  test('F1 edge: closing the lightbox shrinks its picture back into the panel; a step fades the old one out', async ({
    page,
  }) => {
    await asPlayer(page, ALICE);
    await page.goto('/lists/owned?game=1145360');
    await page.getByRole('button', { name: 'Screenshot 1 of 3' }).click();
    await expect(page.locator('.panel-hero-img')).not.toHaveClass(/loading/);
    await page.getByRole('button', { name: 'Open in lightbox' }).click();
    await expect(page.locator('#screenshot-lightbox')).toHaveCSS('opacity', '1');
    await expect(page.locator('.lb-img')).not.toHaveClass(/lb-anim/);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.lb-ghost')).toHaveCount(1);
    await expect(page.locator('.lb-img')).toHaveClass(/lb-anim-right/);
    await expect(page.locator('.lb-ghost')).toHaveCount(0); // gone once faded
    await expect(page.locator('.lb-img')).not.toHaveClass(/lb-anim/);
    await page.evaluate(() => {
      const w = window as unknown as { transitions: number };
      w.transitions = 0;
      const start = document.startViewTransition.bind(document);
      document.startViewTransition = (cb) => (w.transitions++, start(cb));
    });
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => (window as unknown as { transitions: number }).transitions)).toBe(1);
    await expect(page.locator('#screenshot-lightbox')).toBeHidden();
    await expect(page.locator('.panel-hero-img')).toHaveAttribute('src', /Screenshot%202/);
    await expect(page.locator('[style*="view-transition-name"]')).toHaveCount(0);
    await expect(page.locator('.panel-hero-open')).toBeFocused();
  });

  test('F1 edge: a swiped-away screenshot carries on out beside the next, not fading where it was let go', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'touch only');
    await page.goto('/game/1145360?shot=s1');
    const img = page.locator('#screenshot-lightbox .lb-img');
    await expect(img).toHaveCSS('opacity', '1');
    // Read as it's added: it lives only for its animation.
    await page.evaluate(() => {
      const w = window as unknown as { ghost: { animation: string; to: string } | null };
      w.ghost = null;
      new MutationObserver((records) => {
        for (const r of records)
          for (const n of r.addedNodes) {
            const el = n as HTMLElement;
            if (!el.classList?.contains('lb-ghost')) continue;
            w.ghost = { animation: getComputedStyle(el).animationName, to: el.style.getPropertyValue('--lb-exit-to') };
          }
      }).observe(document.querySelector('.lb-surface')!, { childList: true });
    });
    const box = await visibleBox(img);
    const y = box.y + box.height / 2;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y }] });
    for (const x of [260, 200, 120])
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.locator('.lb-status')).toContainText('Screenshot 2 of 3');
    const ghost = await page.evaluate(() => (window as unknown as { ghost: { animation: string; to: string } }).ghost);
    const enterFrom = await img.evaluate((el) => el.style.getPropertyValue('--lb-enter-from'));
    // As far as the next one comes in, so the two move as one.
    expect(ghost.animation).toBe('lb-exit-x');
    expect(parseFloat(ghost.to)).toBe(-parseFloat(enterFrom));
  });

  test('F1 edge: stepping off a trailer fades it out too, not through black', async ({ page }) => {
    await fakePlayback(page);
    await mockApi(page, { states: ['playable-trailers'] });
    await page.goto('/game/1145360?shot=v1');
    const video = page.locator('#screenshot-lightbox .lb-video');
    await expect(video).toBeVisible();
    // Counted as added: each lives only for its fade.
    await page.evaluate(() => {
      const w = window as unknown as { ghosts: string[] };
      w.ghosts = [];
      new MutationObserver((records) => {
        for (const r of records)
          for (const n of r.addedNodes) {
            const el = n as HTMLElement;
            if (el.classList?.contains('lb-ghost')) w.ghosts.push(el instanceof HTMLImageElement ? el.src : el.tagName);
          }
      }).observe(document.querySelector('.lb-surface')!, { childList: true });
    });
    const ghosts = () => page.evaluate(() => (window as unknown as { ghosts: string[] }).ghosts);
    // No frame yet (the fixture stream never has one, whatever its readyState says): its poster fades out.
    await video.evaluate((v: HTMLVideoElement) =>
      Object.defineProperty(v, 'readyState', { configurable: true, get: () => 2 }),
    );
    await page.keyboard.press('ArrowRight');
    await expect.poll(ghosts).toEqual([expect.stringMatching(/Trailer/)]);
    // A frame: it does.
    await page.keyboard.press('ArrowLeft');
    await video.evaluate((v: HTMLVideoElement) => {
      for (const [k, n] of [
        ['videoWidth', 320],
        ['videoHeight', 180],
      ] as const)
        Object.defineProperty(v, k, { configurable: true, get: () => n });
    });
    await page.keyboard.press('ArrowRight');
    await expect.poll(ghosts).toEqual([expect.stringMatching(/Trailer/), expect.anything(), 'CANVAS']);
  });

  test('I2 edge: a nav popover rises to rest and Esc hands focus back', async ({ page }) => {
    await asPlayer(page, ALICE);
    await page.goto('/lists/owned');
    const prefs = page.getByLabel('Preferences');
    await prefs.click();
    const panel = page.locator('.site-nav-prefs-panel');
    await expect(panel).toHaveCSS('opacity', '1');
    await expect(panel).toHaveCSS('translate', '0px');
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(prefs).toBeFocused();
  });

  test('L3 edge: a table menu fades in from its first frame to rest', async ({ page }) => {
    await asPlayer(page, ALICE);
    await page.goto('/lists/owned');
    const columns = page.getByRole('button', { name: 'Columns', exact: true });
    await columns.waitFor();
    // Read in the frame the menu first paints: its transition has only just started there.
    const firstFrame = await columns.evaluate(async (b: HTMLElement) => {
      b.click();
      await new Promise(requestAnimationFrame);
      return Number(getComputedStyle(document.querySelector('.dt-dd')!).opacity);
    });
    expect(firstFrame).toBeLessThan(1);
    const menu = page.locator('.dt-dd');
    await expect(menu).toHaveCSS('opacity', '1');
    await expect(menu).toHaveCSS('scale', 'none');
  });
});

test('I2 edge: closing a game with no row returns focus to the row it was opened from', async ({ page }) => {
  await asPlayer(page, ALICE);
  // The DLC hopped to has no fixture details; the store not answering is enough here.
  await page.route(/\/api\/game-details\/9000\d\d$/, (route) =>
    route.fulfill({ json: { appid: 900001, meta: null, failed: ['meta'] } }),
  );
  await page.goto('/lists/owned');
  await row(page, 'Hades').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  const card = page.locator('#panel-section-dlc');
  await card.getByRole('button', { name: /DLC · 25 available/ }).click();
  await card.locator('.panel-dlc-item').first().click();
  await expect(page.locator('#panel-title')).not.toHaveText('Hades');
  await page.keyboard.press('Escape');
  await expect(page.locator('.game-panel')).toBeHidden();
  await expect(row(page, 'Hades')).toBeFocused();
});

test("F1 edge: a lookup that fails says the sources didn't answer, and ↻ retries it", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.route(/\/api\/game-details\/1426210$/, (route) =>
    route.fulfill({ status: 502, json: { error: 'Steam store error 500' } }),
  );
  await page.goto('/lists/owned?game=1426210');
  await expect(page.locator('.panel-glance')).toContainText("didn't answer");
  await page.getByRole('button', { name: 'Refresh details' }).click();
  await expect(page.locator('.panel-glance')).not.toContainText("didn't answer");
  await page.goto('/game');
  await expect(row(page, 'It Takes Two')).toBeVisible();
});

test("F1 edge: a lookup retried by ↻ that still doesn't answer isn't added to Recently Looked Up", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.route(/\/api\/game-details\/1426210(\?refresh=1)?$/, (route) =>
    route.request().url().includes('refresh=1')
      ? route.fulfill({
          json: { rating: null, hltb: null, meta: null, tags: null, protondb: null, demo: null, failed: ['meta'] },
        })
      : route.fulfill({ status: 502, json: { error: 'Steam store error 500' } }),
  );
  await page.goto('/lists/owned?game=1426210');
  await expect(page.locator('.panel-glance')).toContainText("didn't answer");
  const refresh = page.getByRole('button', { name: 'Refresh details' });
  await refresh.click();
  // Disabled from the click until every refetch has settled.
  await expect(refresh).toBeEnabled();
  const recents = await page.evaluate(() => localStorage.getItem('steam.isonoe.net:prefs'));
  expect(JSON.parse(recents!).recentGames?.value ?? []).toEqual([]);
});

test('I2 edge: a game outside the list shows the age of its details', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1426210');
  await expect(page.locator('#panel-title')).not.toBeEmpty();
  await expect(page.locator('.panel-refresh-age')).not.toBeEmpty();
});

test("I3 edge: a DLC's panel names its way back after the game it came from", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.route(/\/api\/game-details\/9000\d\d$/, (route) =>
    route.fulfill({ json: { appid: 900001, meta: null, failed: ['meta'] } }),
  );
  await page.goto('/lists/owned?game=1145360');
  const card = page.locator('#panel-section-dlc');
  await card.getByRole('button', { name: /DLC · 25 available/ }).click();
  await card.locator('.panel-dlc-item').first().click();
  await page.getByRole('button', { name: 'Back to Hades', exact: true }).click();
  await expect(page.locator('#panel-title')).toHaveText('Hades');
});

test('I2 edge: the shortcuts dialog says how to open the lightbox from the panel', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  await page.keyboard.press('?');
  const section = page.locator('.shortcuts-section').filter({ hasText: 'Game panel' });
  await expect(section.locator('.shortcuts-row').filter({ hasText: 'lightbox' })).toContainText('Enter');
});

test('I2 edge: the shortcuts dialog draws all four arrow keys the same size, still read as ← → ↑ ↓', async ({
  page,
}) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  await page.keyboard.press('?');
  const arrows = page.getByRole('dialog', { name: 'Keyboard shortcuts' }).locator('kbd', { hasText: /^[←→↑↓]$/ });
  await expect(arrows.first()).toBeVisible();
  const caps = await arrows.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { key: el.textContent, size: `${r.width.toFixed(1)}×${r.height.toFixed(1)}` };
    }),
  );
  expect(new Set(caps.map((c) => c.key))).toEqual(new Set(['←', '→', '↑', '↓']));
  expect(new Set(caps.map((c) => c.size)).size).toBe(1);
});

test('I2 edge: every shortcut description starts at the same x', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  await page.keyboard.press('?');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  const lefts = await dialog
    .locator('.shortcuts-row > dd')
    .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
  expect(lefts.length).toBeGreaterThan(10);
  expect(new Set(lefts).size).toBe(1);
  const overflowing = await dialog
    .locator('.shortcuts-keys')
    .evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth).map((el) => el.textContent));
  expect(overflowing).toEqual([]);
});

test('I2 edge: the shortcuts dialog takes focus, keeps it, and gives it back on close', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await row(page, 'Hades').focus();
  await page.keyboard.press('?');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
  await page.keyboard.press('Tab');
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Shift+Tab');
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  // A click on its text drops focus to <body>; Tab must still not leave for the page behind.
  await dialog.locator('.shortcuts-row').last().click();
  await page.keyboard.press('Tab');
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(row(page, 'Hades')).toBeFocused();
});

test('I2 edge: controls name what they act on, and only toggles carry a pressed state', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/');
  await expect(page.locator('.account-chip-btn')).toHaveAccessibleName(/Alice/);
  await page.getByRole('button', { name: 'New list' }).click();
  await page.getByRole('textbox', { name: 'List name' }).fill('Shortlist');
  await page.keyboard.press('Enter');
  await rowMenu(page, 'Shortlist').click();
  await expect(page.getByRole('button', { name: 'Rename Shortlist' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete Shortlist' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'New combined list' }).click();
  const form = page.locator('.combine-form');
  await form.getByRole('combobox', { name: 'How to combine the sources' }).selectOption('subtract');
  const sources = form.locator('.combine-sources input[type="checkbox"]');
  await sources.nth(0).check();
  await sources.nth(1).check();
  const ordered = form.locator('.combine-sources-ordered li');
  const first = (await ordered.nth(0).locator('.combine-source-label').innerText()).trim();
  await expect(ordered.nth(0).getByRole('button', { name: `Move ${first} down` })).toBeVisible();

  await page.goto('/lists/compare?u=alice&u=bob');
  await expect(page.getByRole('combobox', { name: "How to combine these players' libraries" })).toHaveValue(
    'group-by-membership',
  );

  await page.goto('/bundles');
  // A tile's button is named by its label and value.
  const updated = page.getByRole('button', { name: /^Updated \S/ });
  await expect(updated).toBeVisible();
  await expect(updated).not.toHaveAttribute('aria-pressed');
  await expect(page.getByRole('button', { name: /^Prices \S/ })).not.toHaveAttribute('aria-pressed');
  const ending = page.getByRole('button', { name: /^Ending soon \d/ });
  if (await ending.count()) await expect(ending).toHaveAttribute('aria-pressed', 'false');
});

test('I2 edge: icon-only controls have names', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto(`/lists/bundle/${BUNDLE.id}`);
  await expect(rows(page)).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Previous bundle' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Next bundle' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Columns', exact: true }).click();
  await expect(page.locator('.dt-dd')).toContainText('Image');
});

test('I2 edge: Esc in the lightbox closes only it, drops its shot from the URL, and one Back closes the game', async ({
  page,
}) => {
  await asPlayer(page, ALICE);
  await page.goto('/about');
  await page.goto('/lists/owned');
  await row(page, 'Hades').getByText('Hades').click();
  await page.getByRole('button', { name: 'Open in lightbox' }).click();
  await expect(page).toHaveURL(/&shot=banner/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#screenshot-lightbox')).not.toHaveAttribute('open');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  await expect(page).toHaveURL(/\?game=1145360$/);
  await page.goBack();
  await expect(page.locator('#game-panel')).toBeHidden();
  await expect(page).toHaveURL(/\/lists\/owned$/);
});

test('I2 edge: a click beside the shortcuts dialog closes it', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);
  await page.keyboard.press('?');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  await page.mouse.click(5, 5); // a corner the dialog never covers
  await expect(dialog).toBeHidden();
});

test('I2 edge: a click outside closes each nav popover, and opening one closes the other', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/wishlist');
  // The rank menu only replaces the Rank button once the list has a ranking.
  await page.getByRole('button', { name: /Rank this list/ }).click();
  await page.keyboard.press('Escape');
  await page.goto('/lists/wishlist');
  await expect(rows(page)).toHaveCount(4);

  const prefs = page.locator('.site-nav-prefs-panel');
  const account = page.locator('.account-chip-panel');
  const rank = page.locator('.rank-menu-panel');
  // In the left gutter, which no popover covers (clampPopoverLeft keeps them 12px in).
  const outside = async () => {
    const title = await visibleBox(page.locator('.list-hero-title'));
    await page.mouse.click(5, title.y + title.height / 2);
  };
  const triggers = [
    [prefs, () => page.getByLabel('Preferences').click()],
    [account, () => page.locator('.account-chip-btn').click()],
    [rank, () => page.getByText(/Rank this list/).click()],
  ] as const;
  for (const [panel, open] of triggers) {
    await open();
    await expect(panel).toBeVisible();
    await outside();
    await expect(panel).toBeHidden();
  }
  // The nav's popovers can cover the rank menu's trigger, so that one only opens first.
  for (const [[panel, open], [next, openNext]] of [
    [triggers[0], triggers[1]],
    [triggers[1], triggers[0]],
    [triggers[2], triggers[0]],
  ]) {
    await open();
    await expect(panel).toBeVisible();
    await openNext();
    await expect(next).toBeVisible();
    await expect(panel).toBeHidden();
    await outside();
  }
});

test('I2 edge: a hidden achievement is revealed by Enter, and by Space', async ({ page }) => {
  await page.route('**/api/achievements/**', (route) => {
    const req = route.request();
    const body = JSON.parse(respond(req.method(), new URL(req.url()), req.postData()).body);
    for (const a of body.achievements) Object.assign(a, { hidden: true, achieved: false, unlocktime: null });
    body.unlocked = 0;
    return route.fulfill({ json: body });
  });
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360');
  const card = page.locator('#panel-section-achievements');
  await card.getByRole('button', { name: /Achievements/ }).click();
  const hidden = card.getByRole('button', { name: /Hidden achievement/ });
  await expect(hidden).toHaveCount(2);
  await hidden.first().focus();
  await page.keyboard.press('Enter');
  await expect(card).toContainText('First steps');
  await expect(hidden).toHaveCount(1);
  await hidden.focus();
  await page.keyboard.press(' ');
  await expect(card).toContainText('Completionist');
  await expect(hidden).toHaveCount(0);
});

test("I2 edge: Enter or Space on the panel's hero opens the lightbox once", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.clock.install();
  await page.goto('/lists/owned?game=1145360');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  const entries = await page.evaluate(() => history.length);
  // A button takes Enter on keydown, Space on keyup: neither may also press the lightbox's Close.
  for (const key of ['Enter', ' ']) {
    await page.getByRole('button', { name: 'Open in lightbox' }).focus();
    await page.keyboard.press(key);
    await expect(page.locator('.lb-surface')).toBeFocused();
    await page.clock.runFor(200); // past a second activation's close
    await expect(page.locator('#screenshot-lightbox')).toHaveAttribute('open');
    expect(await page.evaluate(() => history.length)).toBe(entries + 1);
    await page.goBack();
    await expect(page.locator('#screenshot-lightbox')).not.toHaveAttribute('open');
    await expect(page.locator('#panel-title')).toHaveText('Hades');
  }
});

// Visible headings' levels, and the unnamed navigation/complementary landmarks.
const structure = (page: Page) =>
  page.evaluate(() => {
    const shown = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)].filter((e) => e.checkVisibility());
    const named = (e: Element) => e.hasAttribute('aria-label') || e.hasAttribute('aria-labelledby');
    return {
      levels: shown('h1, h2, h3, h4, h5, h6, [role=heading]').map((h) =>
        Number(h.getAttribute('aria-level') ?? h.tagName[1]),
      ),
      unnamedNavs: shown('nav, [role=navigation]').filter((e) => !named(e)).length,
      unnamedPanels: shown('aside, [role=complementary]').filter((e) => !named(e)).length,
    };
  });

test('I3.1-2,4: each main page and the open game have one h1, first, skip no heading level, and name every landmark', async ({
  page,
}) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/wishlist');
  await page.getByRole('button', { name: /Rank this list/ }).click();
  await expect(page).toHaveURL(/\/rank$/);
  const rank = new URL(page.url()).pathname;
  for (const [path, ready] of [
    ['/', page.getByText('Your lists')],
    ['/lists/owned', rows(page).first()],
    ['/about', page.getByRole('heading', { name: 'Contact' })],
    ['/search?q=hades', rows(page).first()],
    ['/bundles', rows(page).first()],
    [rank, page.getByText('Which do you prefer?')],
    ['/lists/owned?game=1145360', page.getByRole('complementary', { name: 'Hades' })],
  ] as const) {
    await page.goto(path);
    await expect(ready).toBeVisible();
    for (const landmark of [
      page.getByRole('banner'),
      page.getByRole('navigation', { name: 'Main', exact: true }),
      page.getByRole('search'),
      page.getByRole('main'),
    ])
      await expect(landmark, path).toBeVisible();
    const { levels, unnamedNavs, unnamedPanels } = await structure(page);
    expect(levels[0], path).toBe(1);
    expect(levels.filter((l) => l === 1).length, path).toBe(1);
    for (const [i, level] of levels.entries()) if (i) expect(level, path).toBeLessThanOrEqual(levels[i - 1] + 1);
    expect(unnamedNavs, path).toBe(0);
    expect(unnamedPanels, path).toBe(0);
  }
  // The open game's sections are headings under its name.
  const panel = page.getByRole('complementary', { name: 'Hades' });
  await expect(panel.getByRole('heading', { level: 2, name: 'Hades' })).toBeVisible();
  for (const name of ['Price', 'Owned by', /How Long To Beat/, /Achievements/])
    await expect(panel.getByRole('heading', { level: 3, name })).toBeVisible();
});

test('I3.3: each field on Home, the combine form and Compare says what it is for', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/');
  await expect(page.getByRole('search').getByRole('textbox', { name: 'Look up any game' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Steam name, profile URL, or 64-bit ID' })).toBeVisible();
  await page.getByRole('button', { name: 'New combined list' }).click();
  await expect(page.getByRole('textbox', { name: 'Combined list name (optional)' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'How to combine the sources' })).toBeVisible();
  await expect(
    page.getByRole('group', { name: 'Pick at least 2 sources:' }).getByRole('checkbox', { name: 'Alice — Owned' }),
  ).toBeVisible();

  await page.goto('/lists/compare');
  await expect(page.getByRole('combobox', { name: 'Player 1', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Player 2', exact: true })).toBeVisible();
});

test('I2.1: into a list from the keyboard — skip link, and R with no panel open', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await expect(rows(page)).toHaveCount(6);

  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to table' })).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => document.activeElement?.closest('tbody') != null)).toBe(true);

  // The closed shortcuts dialog isn't rendered, so it's no Tab stop; open, it is.
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts', includeHidden: true });
  await expect(dialog).toBeHidden();
  await page.keyboard.press('?');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();

  await page.keyboard.press('r');
  await expect(page).toHaveURL(/[?&]game=\d+/);
  await expect(page.locator('.game-panel')).toBeVisible();
});

test("S1: share my wishlist's view; a fresh browser sees my games with my layout", async ({ page, browser }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/wishlist');
  await expect(rows(page)).toHaveCount(4);
  await page.locator('thead th').filter({ hasText: /^Name/ }).click();
  await page.evaluate(() => {
    (window as unknown as { copied: string[] }).copied = [];
    navigator.clipboard.writeText = async (text) => void (window as unknown as { copied: string[] }).copied.push(text);
  });
  await page.getByRole('button', { name: /Share view/ }).click();
  const link = await page.evaluate(() => (window as unknown as { copied: string[] }).copied[0]);
  expect(new URL(link).searchParams.get('u')).toBe(ALICE.steamid);

  const friend = await (await browser.newContext()).newPage();
  friend.on('pageerror', (err) => pageErrors.push(err.message));
  await mockApi(friend);
  await friend.goto(link);
  await expect(friend.getByRole('heading', { name: "Alice's Wishlist" })).toBeVisible();
  await expect(friend.getByText('This table uses a layout from a shared link')).toBeVisible();
  await expect(rows(friend)).toHaveCount(4);
});

test('S1 edge: sharing an unchanged layout sends no layout, so no shared-layout banner', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/wishlist');
  await expect(rows(page)).toHaveCount(4);
  await page.evaluate(() => {
    (window as unknown as { copied: string[] }).copied = [];
    navigator.clipboard.writeText = async (text) => void (window as unknown as { copied: string[] }).copied.push(text);
  });
  await page.getByRole('button', { name: /Share view/ }).click();
  const link = await page.evaluate(() => (window as unknown as { copied: string[] }).copied[0]);
  expect(new URL(link).searchParams.has('tv')).toBe(false);
});

test("S1 edge: a comparison's shared layout survives the link's rewrite to resolved players", async ({ page }) => {
  const tv = JSON.stringify({ sorts: [{ key: 'name', dir: 'desc' }] });
  await page.goto(`/lists/compare?u=alice&u=bob&tv=${encodeURIComponent(tv)}`);
  await expect(page.getByText('This table uses a layout from a shared link')).toBeVisible();
  await expect(page).not.toHaveURL(/[?&]u=alice/);
});

test("S2 edge: copying a game's link is announced, not only shown as ✓", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=1145360');
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => {};
  });
  await page.getByRole('button', { name: 'Copy link to this game' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Copied to clipboard' })).toHaveCount(1);
});

test("Y1.1,3: signed in on a new device, the account's lists win over this browser's newer ones", async ({ page }) => {
  await asPlayer(page, BOB, { updatedAt: Date.now() }); // newer than the account's prefs, still not trusted
  await mockApi(page, { states: ['signed-in'] });
  const pushed: Record<string, string> = {}; // key → every body pushed for it
  page.on('request', (req) => {
    const key = new URL(req.url()).pathname.split('/').pop()!;
    if (req.method() === 'PUT') pushed[key] = (pushed[key] ?? '') + req.postData();
  });
  await page.goto('/');

  await expect(page.getByRole('main')).toContainText(SYNCED_LIST); // adopted, then reloaded
  await expect(page.getByRole('banner')).toContainText('Alice');
  expect(pushed.recentAccounts).toContain(BOB.steamid); // a key the account lacks still goes up
  // Home may refresh Alice's slot (its vanity) and push that; never this browser's Bob.
  expect(pushed.myAccount ?? '').not.toContain(BOB.steamid);
  expect(pushed.currentAccount ?? '').not.toContain(BOB.steamid);

  await page.getByRole('banner').getByText('Alice', { exact: true }).click();
  await expect(page.getByText('Signed in — your accounts/lists/settings sync')).toBeVisible();
});

test('Y1 edge: signing out switches the account menu back to signing in', async ({ page }) => {
  await mockApi(page, { states: ['signed-in'] });
  await page.route('**/auth/logout', (route) => route.fulfill({ json: { ok: true } }));
  await page.goto('/about');
  await page.getByRole('banner').getByText('Alice', { exact: true }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('link', { name: 'Sign in with Steam' })).toBeVisible();
  await expect(page.getByText('Signed in — your accounts/lists/settings sync')).toHaveCount(0);
});

test('Y1 edge: a Steam sign-in that expired shows on the account chip until signing in again or staying signed out', async ({
  page,
}) => {
  await asPlayer(page, ALICE);
  // Signed in on this browser before: once, so Stay signed out survives the reload below.
  await page.addInitScript((steamid) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('steam.isonoe.net:signed-in-as', steamid);
  }, ALICE.steamid);
  await mockApi(page);
  await page.goto('/about');

  const chip = page.getByRole('button', { name: /^Account: Alice — Steam sign-in expired/ });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.getByText('Your Steam sign-in expired')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in again' })).toHaveAttribute('href', '/auth/steam/login');
  await expect(page.getByRole('link', { name: 'Sign in with Steam' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Stay signed out' }).click();
  await expect(page.getByText('Your Steam sign-in expired')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Sign in with Steam' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Account: Alice', exact: true })).toBeVisible();
});

const moreFrom = (page: Page) => page.locator('#panel-section-similar .panel-similar-more');

test("F4.1-2,5: a game's publisher lists its games, the open game's panel kept, and Back returns", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned');
  await row(page, 'Terraria').getByText('Terraria').click();
  await moreFrom(page).getByRole('link', { name: 'All games by indie.io (publisher)' }).click();

  await expect(page).toHaveURL(
    (url) => url.pathname === '/lists/publisher' && url.searchParams.get('name') === 'indie.io',
  );
  await expect(page.locator('.list-hero-title')).toHaveText('Published by indie.io');
  await expect(page.locator('.list-hero')).toContainText('Every game on Steam whose publisher is exactly "indie.io"');
  await expect(rows(page)).toHaveCount(3);
  await expect(page.locator('#panel-title')).toHaveText('Terraria');
  // The list on screen is named, not linked.
  await expect(moreFrom(page).locator('[aria-current="page"]')).toHaveText('indie.io');

  // The panel is its own history entry, as on every list: Back closes it, then leaves.
  await page.goBack();
  await expect(page.locator('#panel-title')).toBeHidden();
  await page.goBack();
  await expect(page).toHaveURL(/\/lists\/owned/);
});

test('F4 edge: a developer that also publishes is one link, and one developer leads to another', async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/game/1145360');
  await expect(moreFrom(page)).toContainText('Supergiant Games (developer & publisher)');
  await expect(moreFrom(page).getByRole('link')).toHaveCount(1);
  await moreFrom(page)
    .getByRole('link', { name: /Supergiant Games/ })
    .click();
  await expect(page.locator('.list-hero-title')).toHaveText('Games by Supergiant Games');
  await expect(rows(page)).toHaveCount(2);

  await page.goto('/lists/developer?name=Supergiant%20Games&game=367520');
  await expect(page.locator('#panel-title')).toHaveText('Hollow Knight');
  await moreFrom(page).getByRole('link', { name: 'All games by Team Cherry (developer)' }).click();
  await expect(page.locator('.list-hero-title')).toHaveText('Games by Team Cherry');
  await expect(rows(page)).toHaveCount(1);
});

test("F4 edge: on that creator's own list, More from marks it current, whatever the path's case", async ({ page }) => {
  await asPlayer(page, ALICE);
  await page.goto('/Lists/Developer/?name=Supergiant%20Games&game=1145360');
  await expect(page.locator('#panel-title')).toHaveText('Hades');
  await expect(moreFrom(page).locator('[aria-current="page"]')).toHaveText('Supergiant Games');
});

test('S3 edge: a publisher\'s list link opens in a fresh browser, "/" in its name included', async ({ page }) => {
  await page.goto(`/lists/publisher?name=${encodeURIComponent('Feral Interactive (Mac/Linux)')}`);
  await expect(page.locator('.list-hero-title')).toHaveText('Published by Feral Interactive (Mac/Linux)');
  await expect(rows(page)).toHaveCount(1);
});

test("F4 edge: no game under that exact name says so and links Steam's own search", async ({ page }) => {
  await page.goto('/lists/developer?name=Nobody');
  await expect(page.locator('.list-empty')).toHaveText(
    'Steam\'s store has no games under the exact developer name "Nobody".',
  );
  await expect(page.getByRole('link', { name: 'Search the Steam store for "Nobody" ↗' })).toHaveAttribute(
    'href',
    'https://store.steampowered.com/search/?term=Nobody',
  );
});

test("F4 edge: Steam's store search down says so rather than no games, and Updated retries", async ({ page }) => {
  await mockApi(page, { states: ['store-down'] });
  await page.goto('/lists/developer?name=Re-Logic');
  await expect(page.locator('.list-status')).toContainText("Steam's store search didn't answer");
  await expect(page.locator('.list-empty')).toHaveCount(0);
  await mockApi(page);
  await page.getByRole('button', { name: /^Updated\b/ }).click();
  await expect(rows(page)).toHaveCount(1);
});

test("F4 edge: past Steam's first page, the list says only those are ranked", async ({ page }) => {
  await mockApi(page, { states: ['creator-capped'] });
  await page.goto('/lists/publisher?name=indie.io');
  await expect(rows(page)).toHaveCount(3);
  await expect(page.locator('.list-hero')).toContainText("Steam's 3 most relevant of about 523");
  await expect(page.getByRole('link', { name: 'All on Steam ↗' })).toHaveAttribute(
    'href',
    'https://store.steampowered.com/search/?publisher=indie.io',
  );
});

test("F4.3: a publisher's games I don't own open as a shared list, linked back and saved as my own", async ({
  page,
}) => {
  await asPlayer(page, ALICE);
  await page.goto('/lists/publisher?name=indie.io');
  await expect(rows(page)).toHaveCount(3);
  await page.getByRole('link', { name: "What don't I own?" }).click();

  await expect(page).toHaveURL(/\/lists\/shared\?f=/);
  await expect(page.locator('.list-hero-title')).toHaveText('Published by indie.io − Alice — Owned');
  await expect(rows(page)).toHaveCount(2);
  await expect(row(page, 'Terraria')).toHaveCount(0);
  await expect(page.locator('.list-formula').getByRole('link', { name: 'Published by indie.io' })).toHaveAttribute(
    'href',
    /\/lists\/publisher\?name=indie\.io/,
  );

  const more = page.getByRole('button', { name: 'More actions' }); // a phone folds Save behind More actions
  if (await more.isVisible()) await more.click();
  await page.getByRole('button', { name: 'Save as a list' }).click();
  await expect(page).toHaveURL(/\/lists\/(?!shared)/);
  await expect(rows(page)).toHaveCount(2);
});

const FERAL = 'p:Feral%20Interactive%20%28Mac%2FLinux%29'; // as encodeListFormula escapes it

test('S3 edge: a shared list with a publisher\'s name holding parens and "/" opens', async ({ page }) => {
  await page.goto(sharedUrl(`union:(${FERAL};r)`));
  await expect(page.locator('.list-hero-title')).toHaveText(
    'Published by Feral Interactive (Mac/Linux) ∪ Recently Looked Up',
  );
  await expect(rows(page)).toHaveCount(1);
});

test("F4 edge: Steam's store search down in a combined list names the source, and Updated retries it", async ({
  page,
}) => {
  await mockApi(page, { states: ['store-down'] });
  await asPlayer(page, ALICE);
  await page.goto(sharedUrl(`subtract:(p:indie.io;o:${ALICE.steamid})`));
  await expect(page.locator('.list-status')).toContainText('Published by indie.io: Steam store search error');
  await mockApi(page);
  const forced = page.waitForRequest((req) => /\/api\/creator-games\?.*refresh=1/.test(req.url()));
  await page.getByRole('button', { name: /^Updated\b/ }).click();
  await forced;
  await expect(rows(page)).toHaveCount(2);
});

test("F4 edge: past Steam's first page, a combined list's source says only those count", async ({ page }) => {
  await mockApi(page, { states: ['creator-capped'] });
  await asPlayer(page, ALICE);
  await page.goto(sharedUrl(`subtract:(p:indie.io;o:${ALICE.steamid})`));
  await expect(rows(page)).toHaveCount(2);
  await expect(page.locator('.list-formula')).toContainText('(first 3 of about 523)');
});

test('F4 edge: a game with no Steam tags still offers More from', async ({ page }) => {
  await mockApi(page, { states: ['tagless'] });
  await asPlayer(page, ALICE);
  await page.goto('/lists/owned?game=105600');
  await expect(moreFrom(page).getByRole('link', { name: 'All games by Re-Logic (developer)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sort list by similarity' })).toHaveCount(0);
});

test('B5.1-2: PC Game Pass lists its Steam games for the region, and names the ones not on Steam', async ({ page }) => {
  await mockApi(page);
  await asPlayer(page, ALICE);
  await page.goto('/');
  const requested = page.waitForRequest((req) => /\/api\/game-pass\?country=[A-Z]{2}$/.test(req.url()));
  await page.getByRole('link', { name: 'PC Game Pass' }).click();
  await requested;
  await expect(rows(page)).toHaveCount(4);
  await expect(page.getByRole('button', { name: /Rank this list/ })).toBeVisible();
  await expect(page.getByRole('main')).toContainText(
    /PC Game Pass's catalog for .+\. Game Pass plays them through the Xbox app/,
  );
  await page.getByRole('button', { name: /2 more in PC Game Pass, not on Steam/ }).click();
  await expect(page.getByRole('link', { name: 'Xbox Exclusive Quest' })).toHaveAttribute(
    'href',
    'https://www.xbox.com/games/store/_/9NXBOXONLY01',
  );
  await expect(page.getByRole('link', { name: '9NUNNAMED002' })).toBeVisible();
});

test('B5.3: my wishlist ∩ PC Game Pass as a combined list', async ({ page }) => {
  await mockApi(page);
  await asPlayer(page, ALICE);
  await page.goto('/');
  await page.getByRole('button', { name: 'New combined list' }).click();
  const form = page.locator('.combine-form');
  await form.getByRole('combobox', { name: 'How to combine the sources' }).selectOption('intersect');
  await form.getByRole('checkbox', { name: 'Alice — Wishlist' }).check();
  await form.getByRole('checkbox', { name: 'PC Game Pass' }).check();
  await form.getByRole('button', { name: 'Create combined list' }).click();
  await expect(rows(page)).toHaveCount(2);
  await expect(page.locator('.list-formula')).toContainText('PC Game Pass');
  const forced = page.waitForRequest((req) => /\/api\/game-pass\?.*refresh=1/.test(req.url()));
  await page.getByRole('button', { name: /^Updated\b/ }).click();
  await forced;
});

test('B5 edge: the catalog down says so, and Updated retries it', async ({ page }) => {
  await mockApi(page, { states: ['upstream-down'] });
  await asPlayer(page, ALICE);
  await page.goto('/lists/game-pass');
  await expect(page.locator('.list-status')).toContainText("The PC Game Pass catalog didn't answer");
  await mockApi(page);
  const forced = page.waitForRequest((req) => /\/api\/game-pass\?.*refresh=1/.test(req.url()));
  await page.getByRole('button', { name: /^Updated\b/ }).click();
  await forced;
  await expect(rows(page)).toHaveCount(4);
});

test('B5 edge: without an IsThereAnyDeal key, PC Game Pass says why it is unavailable', async ({ page }) => {
  await mockApi(page, { states: ['no-itad'] });
  await asPlayer(page, ALICE);
  await page.goto('/lists/game-pass');
  await expect(page.locator('.list-status')).toContainText(
    "PC Game Pass isn't available on this instance: it isn't connected to IsThereAnyDeal.",
  );
});
