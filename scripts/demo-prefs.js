'use strict';

// Seeds (or restores) the demo state in localStorage — the only state allowed on screen in
// screenshots and UX reviews.
//   node scripts/demo-prefs.js seed      back up the real prefs, then write the demo ones
//   node scripts/demo-prefs.js empty     back up the real prefs, then clear them (a first visit)
//   node scripts/demo-prefs.js restore   put the backup back and remove it
// Prints a function for Playwright's browser_evaluate; reload after it, since every store reads
// localStorage once at load. With --file, writes .playwright-mcp/demo-<mode>.js instead: a whole
// browser_run_code_unsafe script (open About, run, reload) to pass as its `filename`.

const PREFS_KEY = 'steam.isonoe.net:prefs'; // public/prefs.ts's PREFS_STORAGE_KEY
const BACKUP_KEY = `${PREFS_KEY}.backup`;
const path = require('node:path');
const fs = require('node:fs');

const DEMO_STEAMID = '76561198070571772';
const BASE_URL = process.env.DEMO_BASE_URL || `http://localhost:${require('./ports').portOf('dev')}`;
const DEMO_LABEL = 'julien-f';
const DEMO_AVATAR = 'https://avatars.steamstatic.com/8cd7f9a9091ff23b8961f1c46ab22f986c271062_medium.jpg';

function demoPrefs(now = Date.now()) {
  // label/avatarUrl: only Home refreshes a stored slot's copy, so a shot of any other page would show a steam64 id.
  const account = {
    id: DEMO_STEAMID,
    members: [DEMO_STEAMID],
    rawInputs: [DEMO_STEAMID],
    label: DEMO_LABEL,
    avatarUrl: DEMO_AVATAR,
  };
  const list = (id, parentId, order, fields) => ({ id, parentId, order, createdAt: now, updatedAt: now, ...fields });
  const values = {
    myAccount: account,
    currentAccount: account,
    recentAccounts: [account],
    folders: [{ id: 'demo-folder-weekend', name: 'Weekend', parentId: null, order: 0 }],
    lists: [
      list('demo-list-couch', null, 1, {
        name: 'Couch co-op picks',
        kind: 'manual',
        // Shares three games with the Friday shortlist, for the group-by-membership shot.
        appids: [620, 105600, 892970, 413150, 1966720, 322330],
      }),
      list('demo-list-friday', 'demo-folder-weekend', 0, {
        name: 'Friday shortlist',
        kind: 'manual',
        appids: [620, 105600, 892970, 1145360, 1426210, 728880],
      }),
      list('demo-list-coop-compared', null, 3, {
        name: 'Co-op lists compared',
        kind: 'dynamic',
        op: 'group-by-membership',
        sources: [
          { kind: 'user', listId: 'demo-list-couch' },
          { kind: 'user', listId: 'demo-list-friday' },
        ],
      }),
      // Unnamed on purpose: shows the formula-derived label.
      list('demo-list-rest', null, 2, {
        kind: 'dynamic',
        op: 'subtract',
        sources: [
          { kind: 'account-owned', accountId: DEMO_STEAMID },
          { kind: 'user', listId: 'demo-list-couch' },
        ],
      }),
    ],
  };
  const entries = Object.fromEntries(Object.entries(values).map(([k, value]) => [k, { value, updatedAt: now }]));
  return { schemaVersion: 2, ...entries };
}

// `prefs` null clears them instead — the `empty` mode.
function seedFn(prefs = demoPrefs()) {
  const write =
    prefs === null
      ? `localStorage.removeItem(${JSON.stringify(PREFS_KEY)});`
      : `localStorage.setItem(${JSON.stringify(PREFS_KEY)}, ${JSON.stringify(JSON.stringify(prefs))});`;
  return `() => {
  if (localStorage.getItem(${JSON.stringify(BACKUP_KEY)}) !== null) throw new Error('A prefs backup already exists — restore it first');
  localStorage.setItem(${JSON.stringify(BACKUP_KEY)}, JSON.stringify({ prefs: localStorage.getItem(${JSON.stringify(PREFS_KEY)}) }));
  ${write}
  return ${JSON.stringify(prefs === null ? 'emptied' : 'seeded')};
}`;
}

function emptyFn() {
  return seedFn(null);
}

function restoreFn() {
  return `() => {
  const raw = localStorage.getItem(${JSON.stringify(BACKUP_KEY)});
  if (raw === null) throw new Error('No prefs backup to restore');
  const { prefs } = JSON.parse(raw);
  if (prefs === null) localStorage.removeItem(${JSON.stringify(PREFS_KEY)});
  else localStorage.setItem(${JSON.stringify(PREFS_KEY)}, prefs);
  localStorage.removeItem(${JSON.stringify(BACKUP_KEY)});
  return 'restored';
}`;
}

// About is a quiet page: no route writes prefs there, so nothing races the seed or the restore.
function runFile(fnSource, baseUrl = BASE_URL) {
  return `async (page) => {
  await page.goto(${JSON.stringify(`${baseUrl}/about`)});
  const result = await page.evaluate(${fnSource});
  await page.reload();
  return result;
}
`;
}

module.exports = { PREFS_KEY, BACKUP_KEY, DEMO_STEAMID, demoPrefs, seedFn, emptyFn, restoreFn, runFile };

if (require.main === module) {
  const [mode, flag] = process.argv.slice(2);
  const fns = { seed: seedFn, empty: emptyFn, restore: restoreFn };
  if (!fns[mode] || (flag && flag !== '--file')) {
    console.error('Usage: node scripts/demo-prefs.js seed|empty|restore [--file]');
    process.exit(1);
  }
  if (!flag) {
    console.log(fns[mode]());
  } else {
    const dir = path.join(__dirname, '..', '.playwright-mcp');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `demo-${mode}.js`);
    fs.writeFileSync(file, runFile(fns[mode]()));
    console.log(path.relative(process.cwd(), file));
  }
}
