import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { artUrl } from '@/components/format';
import { scopeFilter } from './stats';
import { getWrapped } from './wrapped';
import type { StoryInput, StoryTitle } from './wrapped-story-core';

interface TitleRow {
  label: string;
  item_id: string;
  plays: number;
  minutes: number;
}

const toTitle = (row: TitleRow | undefined, slug: string): StoryTitle | null =>
  row
    ? {
        label: row.label,
        plays: Number(row.plays),
        minutes: Number(row.minutes),
        poster: row.item_id ? artUrl(slug, row.item_id) : null,
      }
    : null;

/**
 * The signed-in user's own year as story input. `getWrapped` already holds most of it; the
 * show-versus-movie split and the hour histogram are the two things it does not compute.
 */
export async function getStoryInput(
  userId: number,
  year: number,
  name: string,
  serverSlug: string,
): Promise<StoryInput> {
  const own = scopeFilter({ userId });
  // Same local-time year bucket as getWrapped, so both pages agree on what "2026" means.
  const inYear = sql`strftime('%Y', watched_at / 1000, 'unixepoch', 'localtime') = ${String(year)}`;

  const topBy = (kind: 'show' | 'movie') => {
    const [column, type] =
      kind === 'show' ? ['grandparent_title', 'episode'] : ['title', 'movie'];
    return db.all<TitleRow>(sql`
      SELECT ${sql.raw(column)} AS label, max(item_id) AS item_id, count(*) AS plays,
             coalesce(sum(duration_ms), 0) / 60000 AS minutes
      FROM watch_history
      WHERE ${own} AND ${inYear} AND media_type = ${type} AND ${sql.raw(column)} IS NOT NULL
      GROUP BY label
      ORDER BY plays DESC, minutes DESC
      LIMIT 1
    `);
  };

  const [wrapped, shows, movies, hourRows] = await Promise.all([
    getWrapped(userId, year),
    topBy('show'),
    topBy('movie'),
    db.all<{ hour: number; plays: number }>(sql`
      SELECT CAST(strftime('%H', watched_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
             count(*) AS plays
      FROM watch_history
      WHERE ${own} AND ${inYear}
      GROUP BY hour
    `),
  ]);

  const hourPlays = Array.from({ length: 24 }, () => 0);
  for (const row of hourRows) hourPlays[Number(row.hour)] = Number(row.plays);

  const busiest = wrapped.calendar.reduce<{ label: string; value: number } | null>(
    (best, day) => (day.value > (best?.value ?? 0) ? day : best),
    null,
  );
  const top = wrapped.topTitles[0];

  return {
    year,
    name,
    plays: wrapped.plays,
    watchtimeMs: wrapped.watchtimeMs,
    distinctTitles: wrapped.distinctTitles,
    longestStreak: wrapped.longestStreak,
    topTitle: top
      ? toTitle({ label: top.label, item_id: top.itemId, plays: top.plays, minutes: top.minutes }, serverSlug)
      : null,
    topShow: toTitle(shows[0], serverSlug),
    topMovie: toTitle(movies[0], serverSlug),
    topGenre: wrapped.topGenres[0]
      ? { label: wrapped.topGenres[0].label, share: wrapped.topGenreShare }
      : null,
    busiestDay: busiest ? { day: busiest.label, minutes: busiest.value } : null,
    weekdayMinutes: wrapped.weekdays.map((day) => day.value),
    hourPlays,
  };
}
