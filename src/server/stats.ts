import 'server-only';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';

export interface Totals {
  plays: number;
  watchtimeMs: number;
  movies: number;
  episodes: number;
  activeDays: number;
}

export interface LabelledValue {
  label: string;
  value: number;
}

/**
 * One user, or every user — optionally narrowed to a single media server. This and
 * scoped() in playback.ts are the only two places that translate a scope into SQL, which
 * is what keeps the server dimension out of every individual aggregate.
 */
export type Scope = { userId: number } | { userId: null; serverId?: number };

// Timestamps are stored as epoch milliseconds, so every date function converts first.
const localDay = (column: string) => sql.raw(`date(${column} / 1000, 'unixepoch', 'localtime')`);

/** Restricts an aggregate to one user, one server, or nothing at all. */
export function scopeFilter(scope: Scope, alias = ''): SQL {
  const column = sql.raw(`${alias}user_id`);
  if (scope.userId !== null) return sql`${column} = ${scope.userId}`;
  // Rows carry no server_id of their own; the server is reached through the user.
  if (scope.serverId !== undefined) {
    return sql`${column} IN (SELECT id FROM users WHERE server_id = ${scope.serverId})`;
  }
  return sql`1 = 1`;
}

function sinceFilter(days?: number, alias = ''): SQL {
  const column = sql.raw(`${alias}watched_at`);
  return days ? sql`${column} >= (unixepoch('now', ${`-${days} days`}) * 1000)` : sql`1 = 1`;
}

export async function getTotals(scope: Scope, days?: number): Promise<Totals> {
  const [row] = await db.all<{
    plays: number;
    watchtime: number;
    movies: number;
    episodes: number;
    active_days: number;
  }>(sql`
    SELECT count(*) AS plays,
           coalesce(sum(duration_ms), 0) AS watchtime,
           count(*) FILTER (WHERE media_type = 'movie') AS movies,
           count(*) FILTER (WHERE media_type = 'episode') AS episodes,
           count(DISTINCT ${localDay('watched_at')}) AS active_days
    FROM watch_history
    WHERE ${scopeFilter(scope)} AND ${sinceFilter(days)}
  `);
  return {
    plays: Number(row?.plays ?? 0),
    watchtimeMs: Number(row?.watchtime ?? 0),
    movies: Number(row?.movies ?? 0),
    episodes: Number(row?.episodes ?? 0),
    activeDays: Number(row?.active_days ?? 0),
  };
}

/** One bucket per day for the last `days` days, including days without any play. */
export async function getDailyActivity(scope: Scope, days = 30): Promise<LabelledValue[]> {
  const rows = await db.all<{ day: string; minutes: number }>(sql`
    WITH RECURSIVE calendar(day) AS (
      SELECT date('now', 'localtime', ${`-${days - 1} days`})
      UNION ALL
      SELECT date(day, '+1 day') FROM calendar WHERE day < date('now', 'localtime')
    )
    SELECT calendar.day AS day,
           coalesce(sum(h.duration_ms), 0) / 60000 AS minutes
    FROM calendar
    LEFT JOIN watch_history h
      ON ${localDay('h.watched_at')} = calendar.day AND ${scopeFilter(scope, 'h.')}
    GROUP BY calendar.day
    ORDER BY calendar.day
  `);
  return rows.map((r) => ({ label: r.day, value: Number(r.minutes) }));
}

/**
 * Ranking metric shared by the top lists. "How often" and "how long" produce very
 * different leaderboards — a daily sitcom wins on plays, a film trilogy wins on time.
 */
export type RankBy = 'count' | 'time';

/** Plays, or watch time in whole minutes. */
function metric(by: RankBy): SQL {
  return by === 'time' ? sql`sum(duration_ms) / 60000` : sql`count(*)`;
}

export async function getTopGenres(
  scope: Scope,
  limit = 8,
  by: RankBy = 'count',
): Promise<LabelledValue[]> {
  // genres is a JSON array column; json_each expands it into one row per genre.
  const rows = await db.all<{ genre: string; total: number }>(sql`
    SELECT genre.value AS genre, ${metric(by)} AS total
    FROM watch_history, json_each(watch_history.genres) AS genre
    WHERE ${scopeFilter(scope, 'watch_history.')}
    GROUP BY genre.value
    ORDER BY total DESC, genre ASC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({ label: r.genre, value: Number(r.total) }));
}

/**
 * Episodes are grouped under their show. The alias must not be called `title`: SQLite
 * resolves a GROUP BY name to the real column first, which would group by episode title
 * and list the same show once per episode.
 */
export async function getTopTitles(
  scope: Scope,
  limit = 8,
  by: RankBy = 'count',
): Promise<LabelledValue[]> {
  const rows = await db.all<{ label: string; total: number }>(sql`
    SELECT coalesce(grandparent_title, title) AS label, ${metric(by)} AS total
    FROM watch_history
    WHERE ${scopeFilter(scope)}
    GROUP BY label
    ORDER BY total DESC, label ASC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({ label: r.label, value: Number(r.total) }));
}

/** Same grouping as getTopTitles, but ranked by watch time instead of play count. */
export function getTopTitlesByTime(scope: Scope, limit = 8): Promise<LabelledValue[]> {
  return getTopTitles(scope, limit, 'time');
}

/** Watch time per weekday, Monday first. */
export async function getWeekdayActivity(scope: Scope): Promise<LabelledValue[]> {
  const rows = await db.all<{ weekday: string; minutes: number }>(sql`
    SELECT strftime('%w', watched_at / 1000, 'unixepoch', 'localtime') AS weekday,
           sum(duration_ms) / 60000 AS minutes
    FROM watch_history
    WHERE ${scopeFilter(scope)}
    GROUP BY weekday
  `);
  // strftime('%w') is 0 = Sunday, so the labels are rotated to start on Monday.
  const found = new Map(rows.map((r) => [Number(r.weekday), Number(r.minutes)]));
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return names.map((label, index) => ({ label, value: found.get((index + 1) % 7) ?? 0 }));
}

/** Devices the user played on. */
export async function getTopDevices(
  scope: Scope,
  limit = 8,
  by: RankBy = 'time',
): Promise<LabelledValue[]> {
  const rows = await db.all<{ label: string; total: number }>(sql`
    SELECT coalesce(device_name, 'Unknown') AS label, ${metric(by)} AS total
    FROM watch_history
    WHERE ${scopeFilter(scope)}
    GROUP BY label
    ORDER BY total DESC, label ASC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({ label: r.label, value: Number(r.total) }));
}

export interface Highlights {
  busiestDay: { day: string; minutes: number } | null;
  averagePlayMs: number;
  longestStreak: number;
  distinctTitles: number;
}

export async function getHighlights(scope: Scope): Promise<Highlights> {
  const [busiest] = await db.all<{ day: string; minutes: number }>(sql`
    SELECT ${localDay('watched_at')} AS day, sum(duration_ms) / 60000 AS minutes
    FROM watch_history
    WHERE ${scopeFilter(scope)}
    GROUP BY day
    ORDER BY minutes DESC
    LIMIT 1
  `);

  const [aggregate] = await db.all<{ average: number; titles: number }>(sql`
    SELECT coalesce(avg(duration_ms), 0) AS average,
           count(DISTINCT coalesce(grandparent_title, title)) AS titles
    FROM watch_history
    WHERE ${scopeFilter(scope)}
  `);

  return {
    busiestDay: busiest ? { day: busiest.day, minutes: Number(busiest.minutes) } : null,
    averagePlayMs: Math.round(Number(aggregate?.average ?? 0)),
    longestStreak: await getLongestStreak(scope),
    distinctTitles: Number(aggregate?.titles ?? 0),
  };
}

/** Longest run of consecutive days with at least one play, anywhere in the history. */
export async function getLongestStreak(scope: Scope): Promise<number> {
  const days = await db.all<{ day: string }>(sql`
    SELECT DISTINCT ${localDay('watched_at')} AS day
    FROM watch_history
    WHERE ${scopeFilter(scope)}
    ORDER BY day ASC
  `);

  let longest = 0;
  let current = 0;
  let previous: number | null = null;
  for (const { day } of days) {
    const time = Date.parse(`${day}T00:00:00Z`);
    current = previous !== null && time - previous === 86_400_000 ? current + 1 : 1;
    previous = time;
    if (current > longest) longest = current;
  }
  return longest;
}

/** Plays per hour of day (0-23), used to spot peak times. */
export async function getPeakHours(scope: Scope): Promise<LabelledValue[]> {
  const rows = await db.all<{ hour: number; plays: number }>(sql`
    SELECT cast(strftime('%H', watched_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
           count(*) AS plays
    FROM watch_history
    WHERE ${scopeFilter(scope)}
    GROUP BY hour
  `);
  const found = new Map(rows.map((r) => [Number(r.hour), Number(r.plays)]));
  return Array.from({ length: 24 }, (_, hour) => ({
    label: String(hour).padStart(2, '0'),
    value: found.get(hour) ?? 0,
  }));
}

/** Consecutive days with at least one play, counting back from today. */
export async function getStreak(scope: Scope): Promise<number> {
  const rows = await db.all<{ day: string }>(sql`
    SELECT DISTINCT ${localDay('watched_at')} AS day
    FROM watch_history
    WHERE ${scopeFilter(scope)}
    ORDER BY day DESC
    LIMIT 400
  `);

  // 'en-CA' formats as YYYY-MM-DD in the local time zone, matching SQLite's date().
  const asDay = (date: Date) => date.toLocaleDateString('en-CA');
  const seen = new Set(rows.map((r) => r.day));
  const cursor = new Date();
  let streak = 0;
  // Today not being watched yet must not break yesterday's streak.
  if (!seen.has(asDay(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (seen.has(asDay(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export async function getUserLeaderboard(
  serverId?: number,
  limit = 10,
): Promise<LabelledValue[]> {
  const onServer = serverId === undefined ? sql`1 = 1` : sql`u.server_id = ${serverId}`;
  const rows = await db.all<{ username: string; minutes: number }>(sql`
    SELECT u.username AS username, coalesce(sum(h.duration_ms), 0) / 60000 AS minutes
    FROM users u
    LEFT JOIN watch_history h ON h.user_id = u.id
    WHERE ${onServer}
    GROUP BY u.id
    ORDER BY minutes DESC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({ label: r.username, value: Number(r.minutes) }));
}

/** Watch time per calendar month of a year, always twelve buckets. */
export async function getMonthlyActivity(scope: Scope, year?: number): Promise<LabelledValue[]> {
  const target = String(year ?? new Date().getFullYear());
  const rows = await db.all<{ month: string; minutes: number }>(sql`
    SELECT strftime('%m', watched_at / 1000, 'unixepoch', 'localtime') AS month,
           sum(duration_ms) / 60000 AS minutes
    FROM watch_history
    WHERE ${scopeFilter(scope)}
      AND strftime('%Y', watched_at / 1000, 'unixepoch', 'localtime') = ${target}
    GROUP BY month
  `);
  const found = new Map(rows.map((r) => [Number(r.month), Number(r.minutes)]));
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return names.map((label, index) => ({ label, value: found.get(index + 1) ?? 0 }));
}

/** Minutes watched per weekday and hour — 7 rows, 24 columns, Monday first. */
export async function getWeekHourGrid(scope: Scope): Promise<number[][]> {
  const rows = await db.all<{ weekday: string; hour: string; minutes: number }>(sql`
    SELECT strftime('%w', watched_at / 1000, 'unixepoch', 'localtime') AS weekday,
           strftime('%H', watched_at / 1000, 'unixepoch', 'localtime') AS hour,
           sum(duration_ms) / 60000 AS minutes
    FROM watch_history
    WHERE ${scopeFilter(scope)}
    GROUP BY weekday, hour
  `);

  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const row of rows) {
    // strftime is 0 = Sunday; the grid starts on Monday.
    const day = (Number(row.weekday) + 6) % 7;
    grid[day][Number(row.hour)] = Number(row.minutes);
  }
  return grid;
}

export interface RewatchSplit {
  fresh: number;
  rewatch: number;
}

/** How much of the watching is new material versus something seen before. */
export async function getRewatchSplit(scope: Scope): Promise<RewatchSplit> {
  const [row] = await db.all<{ total: number; distinct_items: number }>(sql`
    SELECT count(*) AS total, count(DISTINCT item_id) AS distinct_items
    FROM watch_history
    WHERE ${scopeFilter(scope)}
  `);
  const total = Number(row?.total ?? 0);
  const fresh = Number(row?.distinct_items ?? 0);
  return { fresh, rewatch: Math.max(0, total - fresh) };
}

export interface Records {
  longestPlayMs: number;
  bingeCount: number;
  bingeTitle: string | null;
  bingeDay: string | null;
  watchedItems: number;
  lastPlayAt: Date | null;
}

/** Superlatives: the numbers people actually enjoy looking at. */
export async function getRecords(scope: Scope): Promise<Records> {
  const [longest] = await db.all<{ duration_ms: number }>(sql`
    SELECT max(duration_ms) AS duration_ms FROM watch_history WHERE ${scopeFilter(scope)}
  `);

  const [binge] = await db.all<{ label: string; day: string; plays: number }>(sql`
    SELECT coalesce(grandparent_title, title) AS label,
           ${localDay('watched_at')} AS day,
           count(*) AS plays
    FROM watch_history
    WHERE ${scopeFilter(scope)}
    GROUP BY label, day
    ORDER BY plays DESC
    LIMIT 1
  `);

  const [totals] = await db.all<{ items: number; last_play: number | null }>(sql`
    SELECT count(DISTINCT item_id) AS items, max(watched_at) AS last_play
    FROM watch_history
    WHERE ${scopeFilter(scope)}
  `);

  return {
    longestPlayMs: Number(longest?.duration_ms ?? 0),
    bingeCount: Number(binge?.plays ?? 0),
    bingeTitle: binge?.label ?? null,
    bingeDay: binge?.day ?? null,
    watchedItems: Number(totals?.items ?? 0),
    lastPlayAt: totals?.last_play ? new Date(Number(totals.last_play)) : null,
  };
}

/**
 * Change in watch time against the immediately preceding window of the same length.
 * Returns null when there is no previous data to compare against.
 */
export async function getTrend(scope: Scope, days: number): Promise<number | null> {
  const [row] = await db.all<{ current: number; previous: number }>(sql`
    SELECT
      coalesce(sum(duration_ms) FILTER (
        WHERE watched_at >= (unixepoch('now', ${`-${days} days`}) * 1000)
      ), 0) AS current,
      coalesce(sum(duration_ms) FILTER (
        WHERE watched_at >= (unixepoch('now', ${`-${days * 2} days`}) * 1000)
          AND watched_at < (unixepoch('now', ${`-${days} days`}) * 1000)
      ), 0) AS previous
    FROM watch_history
    WHERE ${scopeFilter(scope)}
  `);

  const previous = Number(row?.previous ?? 0);
  if (previous === 0) return null;
  return Math.round(((Number(row?.current ?? 0) - previous) / previous) * 100);
}
