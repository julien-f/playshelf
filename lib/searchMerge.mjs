// An ES module, unlike the rest of lib/, so e2e/mockApi.ts can merge its fixtures the way /api/search-games does.

// Accent-, case- and spacing-insensitive, so "Pokemon" finds "Pokémon".
export const normalizeName = (name) =>
  name
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

// Rows the search box gets beyond Steam's own, at most: IGDB's long tail would bury Steam's results.
const IGDB_ONLY_MAX = 5;

// Steam's results and IGDB's (searchIgdb) as one list: an IGDB hit linked to Steam is that Steam game,
// once; exact-name rows first, Steam's before IGDB's; then Steam's order; then IGDB's other games.
// No dedup by name: two games can share one, and a wrong merge would hide a game.
export function mergeSearchResults(steam, igdb, term) {
  const seen = new Set(steam.map((r) => r.appid));
  const added = [];
  for (const g of igdb) {
    const key = g.steamAppid ?? `igdb:${g.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // A linked hit may be the console original of a Steam remaster: its platforms and year aren't the Steam game's.
    added.push(
      g.steamAppid
        ? { appid: g.steamAppid, name: g.name, tinyImage: g.tinyImage }
        : { appid: key, name: g.name, tinyImage: g.tinyImage, platforms: g.platforms, year: g.year },
    );
  }
  const rows = [...steam, ...added.slice(0, IGDB_ONLY_MAX)];
  const wanted = normalizeName(term);
  const exact = rows.filter((r) => normalizeName(r.name ?? '') === wanted);
  // Stable: Steam's exact rows keep their order ahead of IGDB's.
  exact.sort((a, b) => Number(typeof a.appid === 'string') - Number(typeof b.appid === 'string'));
  return [...exact, ...rows.filter((r) => !exact.includes(r))];
}
