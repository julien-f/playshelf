'use strict';

// PC Game Pass as a list of Steam appids. Microsoft's catalog feed and its product catalog are
// undocumented and key-less (untrusted tier, see docs/dev/integrations.md; feed rules in docs/dev/bundles-and-prices.md); the ids are matched
// to Steam through ITAD (sanctioned). Volume: one catalog call per market per cache period, plus
// the titles of the entries not on Steam, cached per product.

const { MISS_CACHE_TTL_MS } = require('./config');
const { createCachedFetch, getCached, isCached, partitionCached, setCache } = require('./cache');
const { createDedup } = require('./dedup');
const { lookupShopGids, resolveSteamAppIds, steamAppIdCacheKey } = require('./itad');
const { createTrackedFetch } = require('./metrics');
const { upstreamError } = require('./upstream');

const withDedup = createDedup('gamepass');
const cachedFetch = createCachedFetch(withDedup);
const gamePassFetch = createTrackedFetch('gamepass');

// "All PC Games", the collection xbox.com's PC Game Pass page lists.
const PC_SIGL_ID = 'fdd9e2a7-0fee-49f6-ad69-4354098401ff';
// Product ids per displaycatalog request: 100 answered in one call when checked live.
const TITLES_BATCH_MAX = 100;

const catalogCacheKey = (market) => `gamepass:pc:${market}`;
const titleCacheKey = (id) => `msstore-title:${id}`;

// The feed's first entry describes the collection (`siglId`, `title`); the rest are `{ id }`.
function parseCatalog(feed) {
  const ids = Array.isArray(feed) ? feed.filter((e) => typeof e?.id === 'string' && e.id).map((e) => e.id) : [];
  return [...new Set(ids)];
}

// Microsoft Store product ids in PC Game Pass for `market`, each with its ITAD gid (null when
// ITAD doesn't know it). An empty catalog throws rather than caching "Game Pass is empty".
function getCatalog(market, { force = false } = {}) {
  return cachedFetch(catalogCacheKey(market), { force }, async () => {
    const res = await gamePassFetch(
      'getCatalog',
      `https://catalog.gamepass.com/sigls/v2?id=${PC_SIGL_ID}&language=en-us&market=${market}`,
    );
    if (!res.ok) throw upstreamError(`Game Pass catalog error ${res.status}`);
    const ids = parseCatalog(await res.json());
    if (ids.length === 0) throw upstreamError('Game Pass catalog is empty');
    const gids = await lookupShopGids('Microsoft Store', ids);
    return { value: ids.map((id) => ({ id, gid: gids.get(id) })) };
  });
}

// Product titles, cached per product id. A failure degrades to no title (the UI shows the id).
async function getProductTitles(ids, market) {
  const { hits, uncached } = partitionCached(ids, titleCacheKey);
  for (let i = 0; i < uncached.length; i += TITLES_BATCH_MAX) {
    const chunk = uncached.slice(i, i + TITLES_BATCH_MAX);
    try {
      // `browse` is the smallest template that still has titles (~13 KB per product vs ~55 KB).
      const res = await gamePassFetch(
        'getProductTitles',
        `https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=${chunk.join(',')}&market=${market}&languages=en-us&fieldsTemplate=browse`,
      );
      if (!res.ok) throw upstreamError(`Microsoft Store catalog error ${res.status}`);
      const { Products } = await res.json();
      for (const p of Array.isArray(Products) ? Products : []) {
        const title = p?.LocalizedProperties?.[0]?.ProductTitle;
        if (typeof p?.ProductId !== 'string' || typeof title !== 'string') continue;
        hits.set(p.ProductId, title);
        setCache(titleCacheKey(p.ProductId), title);
      }
      // Left out of a successful reply: a confirmed miss, cached on the miss TTL so reloads don't ask again.
      for (const id of chunk) {
        if (!hits.has(id)) setCache(titleCacheKey(id), null, { ttlMs: MISS_CACHE_TTL_MS });
      }
    } catch (err) {
      console.warn(`[gamepass] product titles: ${err.message}`);
    }
  }
  return hits;
}

const catalogGids = (entries) => [...new Set(entries.map((e) => e.gid).filter(Boolean))];

// Splits catalog entries by their gid's Steam match (`resolved`: gid -> appid(s) or null).
// Several product ids (editions) can share one game: each game counts once.
function splitEntries(entries, resolved) {
  const appids = new Set();
  const notOnSteamIds = [];
  const seenGids = new Set();
  let failed = 0;
  for (const { id, gid } of entries) {
    if (gid) {
      if (seenGids.has(gid)) continue;
      seenGids.add(gid);
      if (!resolved.has(gid)) {
        failed++;
        continue;
      }
      const appid = resolved.get(gid);
      if (appid !== null) {
        for (const a of [appid].flat()) appids.add(a);
        continue;
      }
    }
    notOnSteamIds.push(id);
  }
  return { appids, notOnSteamIds, failed };
}

// { appids, notOnSteam: [{ id, title }], failed }: `failed` counts games whose Steam lookup
// errored (retried next time), so they aren't reported as not on Steam.
async function getGamePass(market, { force = false } = {}) {
  const entries = await getCatalog(market, { force });
  const resolved = await resolveSteamAppIds(catalogGids(entries));
  const { appids, notOnSteamIds, failed } = splitEntries(entries, resolved);
  const titles = await getProductTitles(notOnSteamIds, market);
  const notOnSteam = notOnSteamIds.map((id) => ({ id, title: titles.get(id) ?? null }));
  return { appids: [...appids], notOnSteam, failed };
}

// Whether getGamePass(market) would make no upstream call: catalog, Steam matches and titles all
// cached (resolution errors and failed title batches aren't cached, so those keep counting).
function isGamePassCached(market) {
  const entries = getCached(catalogCacheKey(market), { record: false });
  if (entries === undefined) return false;
  const { hits, uncached } = partitionCached(catalogGids(entries), steamAppIdCacheKey, { record: false });
  if (uncached.length) return false;
  return splitEntries(entries, hits).notOnSteamIds.every((id) => isCached(titleCacheKey(id)));
}

module.exports = { catalogCacheKey, parseCatalog, getGamePass, isGamePassCached };
