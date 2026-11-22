// The rules that tie a local watchlist row to the media server's watchlist (Plex: plex.tv).
// No 'server-only': pure, so the tests import it. sync.ts::pullWatchlist, api/watchlist and
// api/v1/watchlist use it.

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

/** plex.tv names titles by 24 hex digits; a Plex library's own keys are short integers. */
export function isPlexGlobalId(itemId: string): boolean {
  return /^[0-9a-f]{24}$/i.test(itemId);
}

export interface PlexLibraryEntry extends WatchlistRowLike {
  globalId?: string;
}

/**
 * Maps watchlist rows to the id the Plex server itself uses. A row pulled from plex.tv carries
 * the global id, which no tool that works on the server (and lists ratingKeys) can match; to
 * that tool a title on somebody's Plex watchlist would look unclaimed. Rows that already hold a
 * local key come back unchanged, and so does a global id the library does not have.
 *
 * By global id first. By title only for library items without one (legacy agents give no
 * plex:// guid): an item whose global id differs is a different title, whatever its name.
 */
export function plexItemIdResolver(library: PlexLibraryEntry[]): (row: WatchlistRowLike) => string {
  const byGlobalId = new Map<string, string>();
  const byTitle = new Map<string, PlexLibraryEntry[]>();
  for (const item of library) {
    if (item.globalId) {
      byGlobalId.set(item.globalId.toLowerCase(), item.itemId);
      continue;
    }
    const key = item.title.trim().toLowerCase();
    const list = byTitle.get(key);
    if (list) list.push(item);
    else byTitle.set(key, [item]);
  }
  return (row) => {
    if (!isPlexGlobalId(row.itemId)) return row.itemId;
    const exact = byGlobalId.get(row.itemId.toLowerCase());
    if (exact) return exact;
    const named = byTitle.get(row.title.trim().toLowerCase())?.find((item) => sameWatchlistTitle(item, row));
    return named?.itemId ?? row.itemId;
  };
}
