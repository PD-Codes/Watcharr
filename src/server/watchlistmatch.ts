// The rules that tie a local watchlist row to the media server's watchlist (Plex: plex.tv).
// No 'server-only': pure, so the tests import it. sync.ts::pullWatchlist and api/watchlist use it.

/** Movie, series, or something else (an episode, a season, unknown). */
export function watchlistKind(mediaType: string | null | undefined): 'movie' | 'show' | null {
  const value = (mediaType ?? '').toLowerCase();
  if (value === 'movie') return 'movie';
  if (value === 'show' || value === 'series') return 'show';
  return null;
}

/**
 * Whether an add or remove goes to the server. plex.tv lists movies and shows only; an episode
 * or a season used to be sent as its show, so adding one episode here put the whole show on
 * the person's Plex watchlist, and removing it took the show off again. Unknown kinds (an
 * older client sends none) stay local for the same reason.
 */
export function pushableToServer(mediaType: string | null | undefined): boolean {
  return watchlistKind(mediaType) !== null;
}

export interface WatchlistRowLike {
  itemId: string;
  title: string;
  year?: number | null;
  mediaType?: string | null;
}

/**
 * Whether a row pulled from the server stands for one already kept here under another id (a
 * title added here goes to plex.tv under its local id and comes back under the global one).
 * Same title, and:
 * - both know a year: the same year, and the same kind where both know one;
 * - a year is missing on either side: the same kind, known on both. A title without a year is
 *   too weak alone — "The Office" the series and a film of that name would swallow each other.
 */
export function sameWatchlistTitle(row: WatchlistRowLike, entry: WatchlistRowLike): boolean {
  if (row.title.trim().toLowerCase() !== entry.title.trim().toLowerCase()) return false;
  const a = watchlistKind(row.mediaType);
  const b = watchlistKind(entry.mediaType);
  if (row.year && entry.year) return row.year === entry.year && (!a || !b || a === b);
  return a !== null && a === b;
}
