import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { getLibrary } from './library';
import { scopeFilter, type LabelledValue, type Scope } from './stats';

// Per-library aggregates without a library column on watch_history.
//
// Storing a section id per play would mean a schema change plus a backfill nobody can do
// — the media server's history API does not report which library a past play came from.
// Instead a library is resolved to its item ids and titles, and the history is matched on
// either: a movie play carries the item's own id, while an episode play carries the
// episode id and only the *series title* in grandparent_title. Matching on both is what
// makes shows count at all, and it is the same trick the "never started" list already uses.

export interface LibraryTotals {
  plays: number;
  watchtimeMs: number;
  lastPlayedAt: Date | null;
  lastTitle: string | null;
}

/** Item ids and titles of one library, as JSON arrays for json_each(). */
async function libraryKeys(serverId: number, sectionId: string) {
  const items = (await getLibrary(serverId)).filter((item) => item.sectionId === sectionId);
  return {
    ids: JSON.stringify(items.map((item) => item.itemId)),
    titles: JSON.stringify(items.map((item) => item.title.toLowerCase())),
    count: items.length,
  };
}

/** SQL predicate: this history row belongs to the given library. */
function inLibrary(ids: string, titles: string) {
  return sql`(
    item_id IN (SELECT value FROM json_each(${ids}))
    OR lower(coalesce(grandparent_title, title)) IN (SELECT value FROM json_each(${titles}))
  )`;
}

function windowFilter(days?: number) {
  return days
    ? sql`watched_at >= (unixepoch('now', ${`-${days} days`}) * 1000)`
    : sql`1 = 1`;
}

export async function getLibraryTotals(
  serverId: number,
  sectionId: string,
  scope: Scope,
  days?: number,
): Promise<LibraryTotals> {
  const { ids, titles } = await libraryKeys(serverId, sectionId);
  const [row] = await db.all<{
    plays: number;
    watchtime: number;
    last_played: number | null;
    last_title: string | null;
  }>(sql`
    SELECT count(*) AS plays,
           coalesce(sum(duration_ms), 0) AS watchtime,
           max(watched_at) AS last_played,
           (SELECT coalesce(h2.grandparent_title, h2.title) FROM watch_history h2
             WHERE ${inLibrary(ids, titles)} AND ${scopeFilter(scope, 'h2.')}
             ORDER BY h2.watched_at DESC LIMIT 1) AS last_title
    FROM watch_history
    WHERE ${inLibrary(ids, titles)} AND ${scopeFilter(scope)} AND ${windowFilter(days)}
  `);

  return {
    plays: Number(row?.plays ?? 0),
    watchtimeMs: Number(row?.watchtime ?? 0),
    lastPlayedAt: row?.last_played ? new Date(Number(row.last_played)) : null,
    lastTitle: row?.last_title ?? null,
  };
}

/** Who watches this library, by play count. */
export async function getLibraryUsers(
  serverId: number,
  sectionId: string,
  scope: Scope,
  limit = 20,
): Promise<LabelledValue[]> {
  const { ids, titles } = await libraryKeys(serverId, sectionId);
  const rows = await db.all<{ label: string; total: number }>(sql`
    SELECT u.username AS label, count(*) AS total
    FROM watch_history h
    JOIN users u ON u.id = h.user_id
    WHERE ${inLibrary(ids, titles)} AND ${scopeFilter(scope, 'h.')}
    GROUP BY u.id
    ORDER BY total DESC, label ASC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({ label: r.label, value: Number(r.total) }));
}

/** Most played titles inside one library. */
export async function getLibraryTopTitles(
  serverId: number,
  sectionId: string,
  scope: Scope,
  limit = 10,
): Promise<LabelledValue[]> {
  const { ids, titles } = await libraryKeys(serverId, sectionId);
  const rows = await db.all<{ label: string; total: number }>(sql`
    SELECT coalesce(grandparent_title, title) AS label, count(*) AS total
    FROM watch_history
    WHERE ${inLibrary(ids, titles)} AND ${scopeFilter(scope)}
    GROUP BY label
    ORDER BY total DESC, label ASC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({ label: r.label, value: Number(r.total) }));
}

export async function getLibraryItemCount(serverId: number, sectionId: string): Promise<number> {
  return (await libraryKeys(serverId, sectionId)).count;
}
