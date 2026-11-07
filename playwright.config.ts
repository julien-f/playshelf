import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { portOf } from './scripts/ports.js';
import PROJECTS from './scripts/e2e-projects.js';

// End-to-end tests for docs/dev/journeys.md's journeys (`npm run test:e2e`). The app runs on
// its own Vite server; every /api call is answered in the browser by e2e/mockApi.ts, so no
// backend, database or upstream service is involved.
// Below Linux's ephemeral range (32768–60999): the pre-commit hook runs this beside the unit tests,
// whose servers and requests draw random ports from that range and could take a fixed one there.
const PORT = portOf('e2e');
// A production build rather than the dev server: a page load fetches one bundle instead of every
// module, which cuts the suite from about 30 s to 20 s.
const OUT_DIR = path.join(__dirname, 'node_modules/.cache/e2e-dist', String(PORT));

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  reporter: 'dot',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    // region.ts reads the region from the time zone; pinned so a UTC CI runner prices like a EUR region.
    timezoneId: 'Europe/Paris',
    // Transitions and smooth scrolls end at once, so a test never waits on or measures one mid-way.
    reducedMotion: 'reduce',
    // `E2E_SHOTS=1 npm run test:e2e` keeps every test's final screen in test-results/, to look at a UI change under mocks.
    screenshot: process.env.E2E_SHOTS ? 'on' : 'off',
    // The committed DejaVu fonts, not the machine's: layouts measure the same locally and in CI (Linux only: fontconfig).
    launchOptions: { env: { ...process.env, FONTCONFIG_FILE: path.join(__dirname, 'e2e/fonts/fonts.conf') } },
  },
  projects: Object.entries(PROJECTS).map(([name, use]) => ({ name, use })),
  webServer: {
    // E2E_BUILT: scripts/e2e.js (`npm run test:e2e`) already built into that directory.
    command: process.env.E2E_BUILT
      ? `npx vite preview --outDir ${process.env.E2E_BUILT} --port ${PORT} --strictPort`
      : `npx vite build --sourcemap --outDir ${OUT_DIR} && npx vite preview --outDir ${OUT_DIR} --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    // A server already on the port would serve another build: fail on the busy port instead.
    reuseExistingServer: false,
  },
});
