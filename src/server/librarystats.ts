import 'server-only';
import { sql } from 'drizzle-orm';
import { readDb as db } from './readcache';
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
//
// The matching runs in JS on one grouped scan (per item and series title) instead of in SQL
// per library: `lower(coalesce(...)) IN json_each(...)` can use no index, so each library
// used to read the whole history again — seconds per library on a million plays, every
// dashboard refresh. Now every library of a page shares one scan, which the read cache keeps.

export interface LibraryTotals {
  plays: number;
  watchtimeMs: number;
  lastPlayedAt: Date | null;
  lastTitle: string | null;
}

interface PlayGroup {
  item_id: string;
  k: string; // lower(series title or title)
  label: string;
  user_id: number;
  plays: number;
  ms: number;
  last: number;
}

/**
 * Plays of one server's users grouped by item, series title and (optionally) user. Item ids
 * are only unique per server and the same title exists on several, so the server filter
 * stays — otherwise one library's numbers would include other servers' plays of the same name.
 */
async function groups(serverId: number, scope: Scope, days: number | undefined, byUser: boolean) {
  const key = `${serverId}|${JSON.stringify(scope)}|${days ?? ''}|${byUser}`;
  let running = inflight.get(key) as Promise<PlayGroup[]> | undefined;
  if (!running) {
    running = db
      .all<PlayGroup>(sql`
        SELECT item_id, lower(coalesce(grandparent_title, title)) AS k,
               min(coalesce(grandparent_title, title)) AS label,
               ${byUser ? sql`user_id` : sql`0`} AS user_id,
               count(*) AS plays, coalesce(sum(duration_ms), 0) AS ms, max(watched_at) AS last
        FROM watch_history
        WHERE ${scopeFilter({ userId: null, serverId })} AND ${scopeFilter(scope)}
          AND ${days ? sql`watched_at >= (unixepoch('now', ${`-${days} days`}) * 1000)` : sql`1 = 1`}
        GROUP BY item_id, k${byUser ? sql`, user_id` : sql``}
      `)
      .finally(() => inflight.delete(key));
    inflight.set(key, running);
  }
  return running;
}
// Parallel calls for several libraries of one page share one scan instead of starting one each.
const inflight = new Map<string, Promise<unknown>>();

/** The groups that belong to one library: by item id (movies) or series title (episodes). */
async function inSection(serverId: number, sectionId: string, rows: PlayGroup[]): Promise<PlayGroup[]> {
  const items = (await getLibrary(serverId)).filter((item) => item.sectionId === sectionId);
  const ids = new Set(items.map((item) => item.itemId));
  const titles = new Set(items.map((item) => item.title.toLowerCase()));
  return rows.filter((row) => ids.has(row.item_id) || titles.has(row.k));
}

/** Pure, for the test: sums groups into a library's totals. */
export function totalsOf(rows: Pick<PlayGroup, 'label' | 'plays' | 'ms' | 'last'>[]): LibraryTotals {
  let plays = 0;
  let ms = 0;
  let last: { at: number; label: string } | null = null;
  for (const row of rows) {
    plays += Number(row.plays);
    ms += Number(row.ms);
    if (!last || Number(row.last) > last.at) last = { at: Number(row.last), label: row.label };
  }
  return { plays, watchtimeMs: ms, lastPlayedAt: last ? new Date(last.at) : null, lastTitle: last?.label ?? null };
}

export async function getLibraryTotals(
  serverId: number,
  sectionId: string,
  scope: Scope,
  days?: number,
): Promise<LibraryTotals> {
  return totalsOf(await inSection(serverId, sectionId, await groups(serverId, scope, days, false)));
}

/** Who watches this library, by play count. */
export async function getLibraryUsers(
  serverId: number,
  sectionId: string,
  scope: Scope,
  limit = 20,
): Promise<LabelledValue[]> {
  const rows = await inSection(serverId, sectionId, await groups(serverId, scope, undefined, true));
  const perUser = new Map<number, number>();
  for (const row of rows) perUser.set(row.user_id, (perUser.get(row.user_id) ?? 0) + Number(row.plays));
  if (perUser.size === 0) return [];
  const names = await db.all<{ id: number; username: string }>(
    sql`SELECT id, username FROM users WHERE server_id = ${serverId}`,
  );
  const nameOf = new Map(names.map((u) => [Number(u.id), u.username]));
  return [...perUser]
    .map(([id, value]) => ({ label: nameOf.get(id) ?? '?', value }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
    .slice(0, limit);
}

/** Most played titles inside one library. */
export async function getLibraryTopTitles(
  serverId: number,
  sectionId: string,
  scope: Scope,
  limit = 10,
): Promise<LabelledValue[]> {
  const rows = await inSection(serverId, sectionId, await groups(serverId, scope, undefined, false));
  const perTitle = new Map<string, { label: string; value: number }>();
  for (const row of rows) {
    const entry = perTitle.get(row.k) ?? { label: row.label, value: 0 };
    entry.value += Number(row.plays);
    perTitle.set(row.k, entry);
  }
  return [...perTitle.values()]
    .sort((a, b) => b.value - a.value || (a.label < b.label ? -1 : 1))
    .slice(0, limit);
}

export async function getLibraryItemCount(serverId: number, sectionId: string): Promise<number> {
  return (await getLibrary(serverId)).filter((item) => item.sectionId === sectionId).length;
}
