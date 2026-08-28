import 'server-only';
import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { db } from '@/db';
import { watchHistory } from '@/db/schema';

/**
 * The one way a row enters watch_history.
 *
 * Three writers reach this table now — the media server's own played list (sync.ts), a
 * playback this app watched from start to finish (sync.ts again) and the Tautulli import
 * — and they describe the same evening from different angles. The unique index only
 * catches an exact repeat of (user, item, timestamp), which none of them produce: the
 * server reports the moment it marked the item played, a session knows when it started,
 * and Tautulli recorded when the stream began. Left alone, one film watched once shows up
 * three times.
 *
 * So the near-duplicate check lives here rather than at each call site: a play of the same
 * item by the same user inside the window is the same play, whichever writer saw it first.
 */

// Wide enough to cover a film plus the delay before the server marks it played, narrow
// enough that tomorrow's rewatch is still its own row. Two plays of one episode inside six
// hours are the same evening in every real case worth counting twice.
const SAME_PLAY_WINDOW_MS = 6 * 3_600_000;

export type PlaySource = 'server' | 'session' | 'tautulli';

export interface PlayInput {
  itemId: string;
  title: string;
  grandparentTitle?: string | null;
  mediaType: string;
  year?: number | null;
  genres?: string[];
  watchedAt: Date;
  durationMs: number;
  deviceName?: string | null;
}

/**
 * Inserts the plays this user does not already have. Returns how many were written, so an
 * import can report a number instead of "done".
 */
export async function recordPlays(
  userId: number,
  entries: PlayInput[],
  source: PlaySource,
): Promise<number> {
  if (!entries.length) return 0;

  const itemIds = [...new Set(entries.map((e) => e.itemId))];
  const oldest = Math.min(...entries.map((e) => e.watchedAt.getTime())) - SAME_PLAY_WINDOW_MS;
  const newest = Math.max(...entries.map((e) => e.watchedAt.getTime())) + SAME_PLAY_WINDOW_MS;

  // One read for the whole batch rather than an EXISTS subquery per row: an import hands
  // over tens of thousands of entries at a time.
  const existing = await db
    .select({
      id: watchHistory.id,
      itemId: watchHistory.itemId,
      watchedAt: watchHistory.watchedAt,
      source: watchHistory.source,
      genres: watchHistory.genres,
      year: watchHistory.year,
    })
    .from(watchHistory)
    .where(
      and(
        eq(watchHistory.userId, userId),
        inArray(watchHistory.itemId, itemIds),
        gte(watchHistory.watchedAt, new Date(oldest)),
        lte(watchHistory.watchedAt, new Date(newest)),
      ),
    );

  type Known = { id: number | null; at: number; source: string; hasGenres: boolean; hasYear: boolean };
  const known = new Map<string, Known[]>();
  for (const row of existing) {
    const list = known.get(row.itemId) ?? [];
    list.push({
      id: row.id,
      at: row.watchedAt.getTime(),
      source: row.source,
      hasGenres: row.genres.length > 0,
      hasYear: row.year != null,
    });
    known.set(row.itemId, list);
  }

  const enrich: { id: number; genres: string[]; year: number | null }[] = [];
  const fresh = entries.filter((entry) => {
    const at = entry.watchedAt.getTime();
    const seen = known.get(entry.itemId) ?? [];
    const duplicate = seen.find((other) => Math.abs(other.at - at) < SAME_PLAY_WINDOW_MS);
    if (duplicate) {
      // A session knows exactly when a stream ran but nothing about its genres; the media
      // server's played list knows the metadata but reports a rounded timestamp. Whichever
      // arrives second would otherwise be dropped whole, and the genre charts would lose
      // every title that Watcharr watched live. So the row is filled in instead.
      if (
        duplicate.id !== null &&
        source === 'server' &&
        duplicate.source !== 'server' &&
        ((entry.genres?.length && !duplicate.hasGenres) || (entry.year != null && !duplicate.hasYear))
      ) {
        enrich.push({ id: duplicate.id, genres: entry.genres ?? [], year: entry.year ?? null });
        duplicate.source = 'server';
        duplicate.hasGenres = Boolean(entry.genres?.length);
        duplicate.hasYear = entry.year != null;
      }
      return false;
    }
    // Also guards the batch against itself: two entries for one item minutes apart would
    // otherwise both pass, because neither is in the table yet.
    seen.push({
      id: null,
      at,
      source,
      hasGenres: Boolean(entry.genres?.length),
      hasYear: entry.year != null,
    });
    known.set(entry.itemId, seen);
    return true;
  });

  for (const row of enrich) {
    // Only ever adds: a null year or an empty genre list from the incoming entry must not
    // erase what the stored row already had.
    const patch: { source: string; genres?: string[]; year?: number } = { source: 'server' };
    if (row.genres.length) patch.genres = row.genres;
    if (row.year != null) patch.year = row.year;
    await db.update(watchHistory).set(patch).where(eq(watchHistory.id, row.id));
  }
  if (!fresh.length) return 0;

  await db
    .insert(watchHistory)
    .values(
      fresh.map((entry) => ({
        userId,
        itemId: entry.itemId,
        title: entry.title,
        grandparentTitle: entry.grandparentTitle ?? null,
        mediaType: entry.mediaType,
        year: entry.year ?? null,
        genres: entry.genres ?? [],
        watchedAt: entry.watchedAt,
        durationMs: entry.durationMs,
        deviceName: entry.deviceName ?? null,
        source,
      })),
    )
    .onConflictDoNothing();
  return fresh.length;
}
