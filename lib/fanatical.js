'use strict';

// Fanatical's own storefront feed — only for the quantity-priced tiers of its "Build your own"
// (pick-and-mix) bundles, which ITAD lists with a null tier price. Undocumented and key-less (same
// trust tier as HLTB/the Steam store endpoints, see docs/dev/integrations.md): one cached call to
// /api/all/en serves every bundle, so volume stays flat however many people browse.

const { getCached, getCachedAt, setCache } = require('./cache');
const { createDedup } = require('./dedup');
const { createTrackedFetch } = require('./metrics');
const { createHoldOff } = require('./upstream');
const { overrideExpiry } = require('./itadDates');

const withDedup = createDedup('fanatical');
const fanaticalFetch = createTrackedFetch('fanatical');

const FEED_URL = 'https://www.fanatical.com/api/all/en';
// v3: entries gained type and dates; an older map is simply never read again.
const CACHE_KEY = 'fanatical-pnm:v3';
// Short: the bundle list waits on this call when it isn't cached, and the feed normally answers in ~150ms.
const TIMEOUT_MS = 3000;
// A blocked or broken feed only means "Varies" stays, so it's asked again after this rather than per request.
const failureHoldOff = createHoldOff(60 * 60 * 1000);
// The last map fetched or read: kept through a failure, even once its row expired (getCached deletes it).
let lastMap;
// A slug missing from a cached map this old is worth one re-fetch: the bundle likely went live after it.
const REFETCH_FOR_MISSING_MS = 60 * 60 * 1000;

// ITAD's purchase link for a Fanatical bundle is an affiliate redirect wrapping the store URL
// (`…cread.php?…&ued=https%3A%2F%2Fwww.fanatical.com%2Fen%2Fpick-and-mix%2F<slug>`).
function pickAndMixSlug(url) {
  if (typeof url !== 'string') return null;
  let decoded;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    return null;
  }
  const m = /fanatical\.com\/[a-z]{2}(?:-[a-z]{2})?\/pick-and-mix\/([a-z0-9-]+)/i.exec(decoded);
  return m ? m[1].toLowerCase() : null;
}

const isoOrNull = (v) => (typeof v === 'string' && !isNaN(Date.parse(v)) ? v : null);

// slug -> { tiers: [{ quantity, prices: { CUR: amount } }] quantity-ascending, products: [{ name, slug }],
// type ('bundle' for games), validFrom, validUntil (ISO or null) }.
// Fanatical prices in minor units, with float noise (CAD 1789.9999999999998).
function parsePickAndMix(feed) {
  const out = {};
  for (const b of Array.isArray(feed?.pickandmix) ? feed.pickandmix : []) {
    if (typeof b?.slug !== 'string' || !Array.isArray(b.tiers)) continue;
    const tiers = b.tiers
      .filter((t) => Number.isInteger(t?.quantity) && t.quantity > 0 && t.price && typeof t.price === 'object')
      .map((t) => ({
        quantity: t.quantity,
        prices: Object.fromEntries(
          Object.entries(t.price)
            .filter(([, v]) => typeof v === 'number' && v >= 0)
            .map(([cur, v]) => [cur, Math.round(v) / 100]),
        ),
      }))
      .sort((a, b) => a.quantity - b.quantity);
    const products = (Array.isArray(b.products) ? b.products : [])
      .filter((p) => typeof p?.name === 'string' && p.name)
      .map((p) => ({ name: p.name, slug: typeof p.slug === 'string' ? p.slug : null }));
    if (tiers.length)
      out[b.slug.toLowerCase()] = {
        tiers,
        products,
        type: typeof b.type === 'string' ? b.type : null,
        validFrom: isoOrNull(b.valid_from),
        validUntil: isoOrNull(b.valid_until),
      };
  }
  return out;
}

const normName = (s) =>
  s
    .replace(/[™®©]/g, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// The title before an edition/subtitle separator: "Insurmountable - Supporter Bundle" and
// "Insurmountable + Supporter Pack" both give "insurmountable".
const baseName = (s) => normName(s.split(/\s[-–—+:]\s|:\s/)[0]);

// ITAD gid -> the Fanatical product name its pick-and-mix page shows: by slug, then normalised title;
// among what's left, a title Fanatical extends with a subtitle, then a shared base title, each only
// when exactly one unclaimed product fits; last, one game and one product left over in a bundle
// whose counts agree are the same pick under two names ("The Pixel Pulps Collection" is Fanatical's
// "Classic Adventure Triple Pack"). Anything else is left out — the UI says so.
function matchPickAndMix(bundle, products) {
  const bySlug = new Map(products.filter((p) => p.slug).map((p) => [p.slug, p.name]));
  const byName = new Map(products.map((p) => [normName(p.name), p.name]));
  const out = {};
  const games = [];
  let unmatched = [];
  for (const tier of bundle.tiers || [])
    for (const g of tier.games || []) {
      if (!g?.id || games.some((x) => x.id === g.id)) continue;
      games.push(g);
      const name = bySlug.get(g.slug) ?? (typeof g.title === 'string' ? byName.get(normName(g.title)) : undefined);
      if (name) out[g.id] = name;
      else if (typeof g.title === 'string' && normName(g.title)) unmatched.push(g);
    }
  const claimed = new Set(Object.values(out));
  const claimUnique = (fits) => {
    unmatched = unmatched.filter((g) => {
      const found = products.filter((p) => !claimed.has(p.name) && fits(g, p));
      if (found.length !== 1) return true;
      out[g.id] = found[0].name;
      claimed.add(found[0].name);
      return false;
    });
  };
  claimUnique((g, p) => normName(p.name).startsWith(`${normName(g.title)} `));
  claimUnique((g, p) => baseName(p.name) === baseName(g.title));
  const left = products.filter((p) => !claimed.has(p.name));
  if (games.length === products.length && unmatched.length === 1 && left.length === 1)
    out[unmatched[0].id] = left[0].name;
  return out;
}

// A failure, or a client past its share (dedup lets other clients fetch the feed), gets the last map.
async function fetchPickAndMix() {
  const fetched = withDedup(CACHE_KEY, async () => {
    try {
      const res = await fanaticalFetch('getPickAndMix', FEED_URL, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`Fanatical feed error ${res.status}`);
      const map = parsePickAndMix(await res.json());
      setCache(CACHE_KEY, map);
      failureHoldOff.clear();
      lastMap = map;
      return map;
    } catch (err) {
      if (err.isClientBudgetExhausted) throw err;
      console.warn(`[fanatical] ${err.message}`);
      failureHoldOff.fail(err);
      return lastMap ?? {};
    }
  });
  return fetched.catch((err) => {
    if (err.isClientBudgetExhausted) return lastMap ?? {};
    throw err;
  });
}

async function getPickAndMix(slugs = []) {
  const hit = getCached(CACHE_KEY);
  if (hit !== undefined) lastMap = hit;
  if (failureHoldOff.isHeld()) return lastMap ?? {};
  if (hit === undefined) return fetchPickAndMix();
  const age = Date.now() - (getCachedAt(CACHE_KEY) ?? 0);
  if (age > REFETCH_FOR_MISSING_MS && slugs.some((s) => !hit[s])) return fetchPickAndMix();
  return hit;
}

function _resetPickAndMix() {
  lastMap = undefined;
  failureHoldOff.clear();
}

// The pick-and-mix slug of a Fanatical bundle ITAD gives no tier price for, else null.
const enrichableSlug = (b) =>
  b?.page?.name === 'Fanatical' && (b.tiers || []).some((t) => !t.price) ? pickAndMixSlug(b.url) : null;

// Fanatical's end date wins over ITAD's, which runs early or is a placeholder (integrations.md).
function enrich(b, entry, names) {
  const out = { ...(entry.validUntil ? overrideExpiry(b, entry.validUntil, 'Fanatical') : b), pickAndMix: entry.tiers };
  if (names) out.pickAndMixNames = matchPickAndMix(b, entry.products);
  return out;
}

// Adds `pickAndMix` tiers to each Fanatical bundle ITAD gives no tier price for; others pass through untouched.
// `names` also adds `pickAndMixNames` (matchPickAndMix), which only an opened bundle needs.
async function withPickAndMix(bundles, { names = false } = {}) {
  const wanted = new Map();
  for (const b of bundles) {
    const slug = enrichableSlug(b);
    if (slug) wanted.set(b, slug);
  }
  if (!wanted.size) return bundles;
  const map = await getPickAndMix([...wanted.values()]);
  return bundles.map((b) => {
    const entry = wanted.has(b) && map[wanted.get(b)];
    return entry ? enrich(b, entry, names) : b;
  });
}

// withPickAndMix from the cached feed only, for a link preview that mustn't cost an upstream request.
function withCachedPickAndMix(bundle) {
  const slug = enrichableSlug(bundle);
  const entry = slug && (getCached(CACHE_KEY, { record: false }) ?? lastMap)?.[slug];
  return entry ? enrich(bundle, entry, false) : bundle;
}

module.exports = {
  pickAndMixSlug,
  parsePickAndMix,
  matchPickAndMix,
  getPickAndMix,
  withPickAndMix,
  withCachedPickAndMix,
  _resetPickAndMix,
};
