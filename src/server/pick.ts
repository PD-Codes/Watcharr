import 'server-only';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import { watchlist } from '@/db/schema';
import { artUrl } from '@/components/format';
import { getSettings } from './config';
import { isEnabled } from './features';
import { getLibrary } from './library';
import { buildPool, hasRuntimeData, type PickCandidate, type PoolEntry } from './pick-core';
import type { requireUser } from './session';
import { scopeFilter } from './stats';
import { getSuggestions } from './suggestions';
import { reconcileWatchlistStatus, reportSyncError, syncHistory, syncWatchlist } from './sync';
import { cachedPosters } from './tmdb';
import { getLocale } from '@/i18n/server';

type UserSession = Awaited<ReturnType<typeof requireUser>>;

export interface PickData {
  candidates: PickCandidate[];
  hasRuntime: boolean;
  /** The /suggestions page 404s when the feature is off, so the empty state must not link there. */
  suggestionsOn: boolean;
}

/**
 * The roulette's candidate pool for one user: unfinished watchlist entries plus unwatched
 * library suggestions. Everything is read for `session.user` only; nothing here takes a
 * user id from the request.
 */
export async function getPickData(session: UserSession): Promise<PickData> {
  const { user, server } = session;
  const settings = await getSettings();
  const suggestionsOn = isEnabled(settings.features, 'suggestions');

  // Same preamble as the watchlist page: a stale "planned" row for something already
  // watched would otherwise be offered as tonight's pick.
  await syncWatchlist(session).catch(reportSyncError('watchlist sync'));
  await reconcileWatchlistStatus(user.id);
  await syncHistory(session).catch(reportSyncError('history sync'));

  const rows = await db
    .select()
    .from(watchlist)
    .where(and(eq(watchlist.userId, user.id), inArray(watchlist.status, ['planned', 'watching'])));

  // The library supplies genres and runtime, which the watchlist row does not carry. A
  // media server that is down must not take the page with it.
  const library = new Map((await getLibrary(user.serverId).catch(() => [])).map((i) => [i.itemId, i]));
  const suggested = suggestionsOn
    ? ((await getSuggestions(user.id, user.serverId).catch(() => null))?.fromLibrary ?? [])
    : [];

  const detail = (itemId: string) => {
    const item = library.get(itemId);
    return {
      genres: item?.genres ?? [],
      runtimeMin: item?.durationMs ? Math.round(item.durationMs / 60_000) : null,
    };
  };

  const ids = [...rows.map((r) => r.itemId), ...suggested.map((s) => s.itemId)];
  const titles = [...rows.map((r) => r.title), ...suggested.map((s) => s.title)];
  const played = await playedLookup(user.id, ids, titles);

  const entries: PoolEntry[] = [
    ...rows.map((row): PoolEntry => ({
      itemId: row.itemId,
      title: row.title,
      year: row.year,
      mediaType: row.mediaType,
      source: row.status === 'watching' ? 'watching' : 'planned',
      addedAt: row.addedAt.getTime(),
      ...detail(row.itemId),
    })),
    ...suggested
      // The suggestion cache lives a day; a title watched since is no longer a suggestion.
      .filter((s) => !played.ids.has(s.itemId))
      .map((s): PoolEntry => ({
        itemId: s.itemId,
        title: s.title,
        year: s.year ?? null,
        mediaType: s.mediaType,
        source: 'library',
        score: s.score,
        ...detail(s.itemId),
      })),
  ];

  const locale = await getLocale();
  const dates = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const pool = buildPool(entries, Date.now(), (epochMs) => dates.format(epochMs));

  const posters = await cachedPosters(pool);
  const planned = new Set(rows.filter((r) => r.status === 'planned').map((r) => r.itemId));
  const candidates = pool.map(
    (entry): PickCandidate => ({
      itemId: entry.itemId,
      title: entry.title,
      year: entry.year,
      mediaType: entry.mediaType,
      genres: entry.genres,
      runtimeMin: entry.runtimeMin,
      poster: artUrl(server.slug, entry.itemId),
      fallback: posters.get(entry.itemId) ?? null,
      weight: Math.round(entry.weight * 100) / 100,
      reason: entry.reason,
      canMarkWatching: planned.has(entry.itemId),
      hasPlays: played.ids.has(entry.itemId) || played.titles.has(entry.title),
    }),
  );

  return { candidates, hasRuntime: hasRuntimeData(candidates), suggestionsOn };
}

/**
 * Which of these items the user has played, by item id and by title. A show is matched by
 * its own name because an episode row carries it as grandparent_title, the same rule
 * getTitleDetail() uses to decide whether /title/<name> exists.
 */
async function playedLookup(userId: number, itemIds: string[], titles: string[]) {
  const ids = new Set<string>();
  const labels = new Set<string>();
  if (!itemIds.length) return { ids, titles: labels };

  const list = (values: string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);
  const rows = await db.all<{ item_id: string; label: string }>(sql`
    SELECT DISTINCT item_id, coalesce(grandparent_title, title) AS label
    FROM watch_history
    WHERE ${scopeFilter({ userId })}
      AND (item_id IN (${list(itemIds)}) OR coalesce(grandparent_title, title) IN (${list(titles)}))
  `);
  for (const row of rows) {
    ids.add(row.item_id);
    labels.add(row.label);
  }
  return { ids, titles: labels };
}
