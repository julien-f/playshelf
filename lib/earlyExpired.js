'use strict';

// Bundles still on sale that ITAD already moved to its expired list (bundles-and-prices.md): Fanatical
// pick-and-mixes live by its feed's dates, and the Humble Choice month on sale now.

const { getPickAndMix, pickAndMixSlug } = require('./fanatical');
const { choiceMonth, currentChoice } = require('./humbleChoice');

const EXPIRED_PAGE_SIZE = 50; // ITAD's max, as findBundleById and "Include expired" page, so the cached pages are shared
const EXPIRED_MAX_PAGES = 6; // findBundleById's BUNDLE_SEARCH_MAX_PAGES
// ITAD may list a bundle before it goes on sale, so the walk goes this much further back.
const PUBLISH_MARGIN_MS = 7 * 24 * 60 * 60 * 1000;

// One key space for both sources, so a bundle is looked for once.
function keyOf(b) {
  const slug = b?.page?.name === 'Fanatical' && pickAndMixSlug(b.url);
  if (slug) return `fanatical:${slug}`;
  const choice = choiceMonth(b);
  return choice ? `humble:${choice.key}` : null;
}

// Found on ITAD's expired pages, newest first, through `load` (getBundles' params minus country;
// undefined ends the walk). Stops once all are found or a page predates the oldest one's start.
async function findEarlyExpired(active, load, now = Date.now()) {
  const listed = new Set(active.map(keyOf));
  const missing = new Map(); // key -> when it went on sale (ms), -Infinity when unknown
  for (const [slug, e] of Object.entries(await getPickAndMix())) {
    if (e.type !== 'bundle') continue;
    if ((e.validFrom && Date.parse(e.validFrom) > now) || (e.validUntil && Date.parse(e.validUntil) <= now)) continue;
    missing.set(`fanatical:${slug}`, e.validFrom ? Date.parse(e.validFrom) : -Infinity);
  }
  const choice = currentChoice(now);
  missing.set(`humble:${choice.key}`, choice.startMs);
  for (const key of listed) missing.delete(key);
  const oldest = Math.min(...missing.values()) - PUBLISH_MARGIN_MS;
  const found = [];
  for (let page = 0; missing.size && page < EXPIRED_MAX_PAGES; page++) {
    const params = { offset: page * EXPIRED_PAGE_SIZE, limit: EXPIRED_PAGE_SIZE, sort: '-publish', expired: true };
    const bundles = await load(params);
    if (!Array.isArray(bundles)) break;
    for (const b of bundles) if (missing.delete(keyOf(b))) found.push(b);
    if (bundles.length < EXPIRED_PAGE_SIZE || Date.parse(bundles.at(-1)?.publish) < oldest) break;
  }
  return found;
}

module.exports = { findEarlyExpired };
