// An ES module, unlike the rest of lib/, so e2e/mockApi.ts can import it under Vite's dev:mock too.

/**
 * One game's details as POST /api/game-details/stream sends them: without the screenshots and trailers
 * only an opened game shows (the client fills them from GET /api/game-meta). Never mutates `details`: it may be
 * shared with a GET /api/game-details answer through the details dedup.
 * @template {{ meta?: object | null }} T
 * @param {T} details
 * @returns {T}
 */
export function streamEvent(details) {
  if (!details.meta) return details;
  const { screenshots, movies, ...meta } = /** @type {Record<string, unknown>} */ (details.meta);
  return { ...details, meta };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Steam's "6 Sep, 2024": an ISO date parses as UTC midnight, so the tables would show the day before west of UTC.
const steamDate = (iso) => {
  const [year, month, day] = iso.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]}, ${year}`;
};

/**
 * A game outside Steam (server.js's fetchIgdbGame reply) as a stream event: Steam-shaped, so a client that
 * predates it still fills name, image, HLTB and dates. `appid` echoes the requested `igdb:N` key.
 * @param {string} appid
 * @param {{ game: any, hltb: object | null, fetchedAt: number | null, fetchedAts: object, failed?: string[] }} details
 */
export function igdbStreamEvent(appid, { game, hltb, fetchedAt, fetchedAts, failed }) {
  return {
    appid,
    source: 'igdb',
    steamAppid: game?.steamAppid ?? null,
    igdbRating: game?.rating ?? null,
    rating: null,
    hltb,
    meta: game && {
      name: game.name,
      capsule: game.cover,
      thumb: game.thumb,
      releaseDate: game.releaseDate && steamDate(game.releaseDate),
      genres: game.genres,
      developers: game.developers,
      publishers: game.publishers,
      platforms: game.platforms,
    },
    tags: null,
    tagWeights: null,
    demo: null,
    protondb: null,
    fetchedAt,
    fetchedAts,
    ...(failed && { failed }),
  };
}
