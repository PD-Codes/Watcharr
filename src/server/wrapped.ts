import 'server-only';
import { sql } from 'drizzle-orm';
import { readDb as db } from './readcache';
import { scopeFilter, type LabelledValue, type Scope } from './stats';

export interface WrappedTitle {
  label: string;
  itemId: string;
  plays: number;
  minutes: number;
}

export interface WrappedPlay {
  title: string;
  label: string;
  watchedAt: Date;
}

export interface Wrapped {
  year: number;
  plays: number;
  watchtimeMs: number;
  distinctTitles: number;
  activeDays: number;
  longestStreak: number;
  movies: number;
  episodes: number;
  firstPlay: WrappedPlay | null;
  lastPlay: WrappedPlay | null;
  topGenres: LabelledValue[];
  topGenreShare: number;
  topTitles: WrappedTitle[];
  weekdays: LabelledValue[];
  devices: LabelledValue[];
  calendar: LabelledValue[];
  /** Server view only: who watched most (minutes), and how many people watched at all. */
  topViewers: LabelledValue[];
  viewers: number;
}

// A range on the indexed column rather than strftime() on every row: the server view reads the
// whole year of every user, where evaluating the date function per row cost seconds. Local
// midnight comes from the process zone, the same one SQLite's 'localtime' uses.
export const yearFilter = (scope: Scope, year: number) =>
  sql`${scopeFilter(scope)} AND watched_at >= ${new Date(year, 0, 1).getTime()} AND watched_at < ${new Date(year + 1, 0, 1).getTime()}`;

/** Years the user (or the server) has any history in, newest first. */
export async function getWrappedYears(scope: Scope): Promise<number[]> {
  // First and last play only, then the years in between that have rows: DISTINCT over a
  // formatted date read every play of the server just to list a handful of years.
  const [range] = await db.all<{ first: number | null; last: number | null }>(sql`
    SELECT min(watched_at) AS first, max(watched_at) AS last FROM watch_history WHERE ${scopeFilter(scope)}
  `);
  if (!range?.first || !range.last) return [];
  const years: number[] = [];
  for (let year = new Date(Number(range.last)).getFullYear(); year >= new Date(Number(range.first)).getFullYear(); year--) {
    const [hit] = await db.all<{ n: number }>(sql`
      SELECT 1 AS n FROM watch_history WHERE ${yearFilter(scope, year)} LIMIT 1
    `);
    if (hit) years.push(year);
  }
  return years;
}

export async function getWrapped(scope: Scope, year: number): Promise<Wrapped> {
  const where = yearFilter(scope, year);

  const [totals] = await db.all<{
    plays: number;
    watchtime: number;
    titles: number;
    active_days: number;
    movies: number;
    episodes: number;
  }>(sql`
    SELECT count(*) AS plays,
           coalesce(sum(duration_ms), 0) AS watchtime,
           count(DISTINCT coalesce(grandparent_title, title)) AS titles,
           count(DISTINCT date(watched_at / 1000, 'unixepoch', 'localtime')) AS active_days,
           count(*) FILTER (WHERE media_type = 'movie') AS movies,
           count(*) FILTER (WHERE media_type = 'episode') AS episodes
    FROM watch_history
    WHERE ${where}
  `);

  const edges = await db.all<{
    title: string;
    label: string;
    watched_at: number;
    position: string;
  }>(sql`
    SELECT title, coalesce(grandparent_title, title) AS label, watched_at, 'first' AS position
    FROM watch_history WHERE ${where} ORDER BY watched_at ASC LIMIT 1
  `);
  const lastRows = await db.all<{ title: string; label: string; watched_at: number }>(sql`
    SELECT title, coalesce(grandparent_title, title) AS label, watched_at
    FROM watch_history WHERE ${where} ORDER BY watched_at DESC LIMIT 1
  `);

  const genreRows = await db.all<{ label: string; plays: number }>(sql`
    SELECT genre.value AS label, count(*) AS plays
    FROM watch_history, json_each(watch_history.genres) AS genre
    WHERE ${where}
    GROUP BY label
    ORDER BY plays DESC, label ASC
    LIMIT 5
  `);
  const [genreTotal] = await db.all<{ total: number }>(sql`
    SELECT count(*) AS total
    FROM watch_history, json_each(watch_history.genres) AS genre
    WHERE ${where}
  `);

  const titleRows = await db.all<{
    label: string;
    item_id: string;
    plays: number;
    minutes: number;
  }>(sql`
    SELECT coalesce(grandparent_title, title) AS label,
           max(item_id) AS item_id,
           count(*) AS plays,
           sum(duration_ms) / 60000 AS minutes
    FROM watch_history
    WHERE ${where}
    GROUP BY label
    ORDER BY plays DESC, minutes DESC
    LIMIT 10
  `);

  const weekdayRows = await db.all<{ weekday: string; minutes: number }>(sql`
    SELECT strftime('%w', watched_at / 1000, 'unixepoch', 'localtime') AS weekday,
           sum(duration_ms) / 60000 AS minutes
    FROM watch_history
    WHERE ${where}
    GROUP BY weekday
  `);
  const weekdayMap = new Map(weekdayRows.map((r) => [Number(r.weekday), Number(r.minutes)]));
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label, index) => ({
    label,
    value: weekdayMap.get((index + 1) % 7) ?? 0,
  }));

  const deviceRows = await db.all<{ label: string; minutes: number }>(sql`
    SELECT coalesce(device_name, 'Unknown') AS label, sum(duration_ms) / 60000 AS minutes
    FROM watch_history
    WHERE ${where}
    GROUP BY label
    ORDER BY minutes DESC
    LIMIT 6
  `);

  // One entry per day of the year, so the heatmap has a fixed shape.
  const calendarRows = await db.all<{ day: string; minutes: number; plays: number }>(sql`
    WITH RECURSIVE calendar(day) AS (
      SELECT ${`${year}-01-01`}
      UNION ALL
      SELECT date(day, '+1 day') FROM calendar WHERE day < ${`${year}-12-31`}
    ),
    -- Grouped once and joined to the calendar: joining the calendar to the raw rows evaluated
    -- the date expression for every play once per day, seconds for a heavy year. The filter is
    -- already this user and this year.
    played(local_day, minutes, plays) AS (
      SELECT date(watched_at / 1000, 'unixepoch', 'localtime'), sum(duration_ms) / 60000, count(*)
      FROM watch_history
      WHERE ${where}
      GROUP BY 1
    )
    SELECT calendar.day AS day, coalesce(played.minutes, 0) AS minutes, coalesce(played.plays, 0) AS plays
    FROM calendar
    LEFT JOIN played ON played.local_day = calendar.day
    ORDER BY calendar.day
  `);

  // Plays, not minutes: a play under a minute (or an import with no duration) still makes the
  // day active in `active_days` above, so the streak must count it too.
  const activeDays = calendarRows.filter((r) => Number(r.plays) > 0).map((r) => r.day);
  let longestStreak = 0;
  let current = 0;
  let previous: number | null = null;
  for (const day of activeDays) {
    const time = Date.parse(`${day}T00:00:00Z`);
    current = previous !== null && time - previous === 86_400_000 ? current + 1 : 1;
    previous = time;
    if (current > longestStreak) longestStreak = current;
  }

  // Only for a server: on a personal year the list would be one name, the reader's own.
  const viewerRows =
    scope.userId === null
      ? await db.all<{ label: string; minutes: number }>(sql`
          SELECT coalesce(u.username, 'Unknown') AS label, sum(h.duration_ms) / 60000 AS minutes
          FROM watch_history h
          LEFT JOIN users u ON u.id = h.user_id
          WHERE ${scopeFilter(scope, 'h.')} AND h.watched_at >= ${new Date(year, 0, 1).getTime()}
            AND h.watched_at < ${new Date(year + 1, 0, 1).getTime()}
          GROUP BY h.user_id
          ORDER BY minutes DESC
        `)
      : [];

  const topGenrePlays = genreRows[0]?.plays ?? 0;
  const genreTotalCount = Number(genreTotal?.total ?? 0);

  return {
    year,
    plays: Number(totals?.plays ?? 0),
    watchtimeMs: Number(totals?.watchtime ?? 0),
    distinctTitles: Number(totals?.titles ?? 0),
    activeDays: Number(totals?.active_days ?? 0),
    longestStreak,
    movies: Number(totals?.movies ?? 0),
    episodes: Number(totals?.episodes ?? 0),
    firstPlay: edges[0]
      ? { title: edges[0].title, label: edges[0].label, watchedAt: new Date(Number(edges[0].watched_at)) }
      : null,
    lastPlay: lastRows[0]
      ? {
          title: lastRows[0].title,
          label: lastRows[0].label,
          watchedAt: new Date(Number(lastRows[0].watched_at)),
        }
      : null,
    topGenres: genreRows.map((r) => ({ label: r.label, value: Number(r.plays) })),
    topGenreShare: genreTotalCount > 0 ? Math.round((Number(topGenrePlays) / genreTotalCount) * 100) : 0,
    topTitles: titleRows.map((r) => ({
      label: r.label,
      itemId: r.item_id,
      plays: Number(r.plays),
      minutes: Number(r.minutes),
    })),
    weekdays,
    devices: deviceRows.map((r) => ({ label: r.label, value: Number(r.minutes) })),
    calendar: calendarRows.map((r) => ({ label: r.day, value: Number(r.minutes) })),
    topViewers: viewerRows.slice(0, 8).map((r) => ({ label: r.label, value: Number(r.minutes) })),
    viewers: viewerRows.length,
  };
}
