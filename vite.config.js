'use strict';

// Builds public/'s HTML entries (the SPA shell — see public/App.tsx/AppShell.tsx — and present.html,
// the presentation window's own page) into dist/ — a real bundled/hashed production build in place of the hand-rolled import-map
// + /vendor/* static-route resolution this app used before the frontend moved to
// TypeScript/Vite (both retired once nothing resolved through them anymore — see server.js's
// own STATIC_DIR comment). Used to be four separate HTML entry points (one full page reload
// per page navigation); collapsed to one during the list-centric redesign (see
// docs/list-centric-redesign.md) once client-side routing (@solidjs/router) took over
// navigation between what used to be separate pages. publicDir is static/, not Vite's default
// public/: that name is already our whole frontend source directory.
const { defineConfig } = require('vite');
const solidPlugin = require('vite-plugin-solid');
const path = require('node:path');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');
const { backendOrigin } = require('./lib/config'); // loads .env + default.env, as the backend does

const backend = backendOrigin();

// `npm run dev:mock`, and `MOCK_API=1 vite preview` on a production build (scripts/perf-measure.js): answers /api
// from e2e/mockApi.ts's fixtures — no backend, no upstream traffic.
const mock = process.env.MOCK_API === '1';
const MOCK_MODULE = path.join(__dirname, 'e2e/mockApi.ts');
const mockMiddleware = (loadMock) => async (req, res, next) => {
  if (!req.url.startsWith('/api/')) return next();
  // `document.cookie = 'mock=no-itad,slow'` in the page picks mockApi.ts's states.
  const cookie = /(?:^|;\s*)mock=([^;]*)/.exec(req.headers.cookie ?? '');
  const states = new Set(cookie ? decodeURIComponent(cookie[1]).split(',') : []);
  let answer;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { respond } = await loadMock();
    answer = respond(
      req.method,
      new URL(req.url, 'http://localhost'),
      chunks.length ? Buffer.concat(chunks).toString() : null,
      states,
    );
  } catch (err) {
    // A fixture gap or a mock that won't load answers 500, as Express does a route's uncaught error.
    console.warn(`[mock-api] ${req.method} ${req.url}:`, err.message);
    answer = { status: 500, contentType: 'application/json', body: JSON.stringify({ error: err.message }) };
  }
  const { status, contentType, body, delayMs } = answer;
  if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  if (states.has('slow') && contentType === 'text/event-stream') {
    res.writeHead(status, { 'Content-Type': contentType });
    for (const event of body.split(/(?<=\n\n)/)) {
      res.write(event);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return res.end();
  }
  // Gzipped as server.js sends the details stream: preview's own compression runs after this middleware.
  const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
  res.writeHead(status, { 'Content-Type': contentType, ...(gzip && { 'Content-Encoding': 'gzip' }) });
  res.end(gzip ? zlib.gzipSync(body) : body);
};
const mockApiPlugin = {
  name: 'mock-api',
  configureServer(server) {
    server.middlewares.use(mockMiddleware(() => server.ssrLoadModule(MOCK_MODULE)));
  },
  // Node strips mockApi.ts's types itself (Node >= 22.18, or 22.15 with --experimental-strip-types).
  configurePreviewServer(server) {
    server.middlewares.use(mockMiddleware(() => import(pathToFileURL(MOCK_MODULE).href)));
  },
};

module.exports = defineConfig({
  root: 'public',
  plugins: [solidPlugin(), mock && mockApiPlugin],
  publicDir: '../static',
  server: {
    // Local dev: `npm run dev` runs this server (`dev:frontend`), serving public/ (TypeScript,
    // which the plain express.static fallback in server.js can't parse) with HMR on :58991,
    // alongside the backend (`dev:backend`), and proxies the API to it; `npm start` still
    // works on its own against `npm run build`'s dist/.
    // Port is pinned (and strictPort set) rather than left to Vite's default-or-next-free
    // fallback: this machine runs several Vite apps at once, and a plain fallback means the
    // same app can land on a different port between runs — a different origin as far as the
    // browser's concerned, so localStorage/cookies/auth silently reset each time.
    port: 58991,
    strictPort: true,
    proxy: mock
      ? undefined
      : {
          '/api': backend,
          // Steam OpenID sign-in (lib/auth.js) — a real page navigation, not an /api fetch, so it
          // needs its own proxy entry. The trailing slash matters: Vite's proxy keys are plain
          // prefix matches, and '/auth' (no slash) also prefixes '/authStore.ts', this app's own
          // frontend module — every request for it was silently proxied to the backend instead of
          // served by Vite, which fell through to server.js's SPA catch-all and served index.html
          // (text/html) in place of the script, breaking the module load entirely.
          // Keeps the browser's Host: the backend builds Steam's return URL from it, and a
          // rewritten one sent the login back to :3000, where the state cookie isn't sent.
          '/auth/': { target: backend, changeOrigin: false },
        },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // Only chunk over the 500 kB default is hls.js, lazy-imported by hlsPlayer.ts and never
    // in the initial load; 600 keeps a warning on every other chunk (the largest, data-table, is ~120 kB).
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      input: { main: path.join(__dirname, 'public/index.html'), present: path.join(__dirname, 'public/present.html') },
    },
  },
});
