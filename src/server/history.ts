import { and, eq, gte, like, sql, type SQL } from 'drizzle-orm';
import { watchHistory } from '@/db/schema';

// Shared by the history page and the CSV export so both show exactly the same rows.
// No 'server-only' import — this is pure query building and stays testable.

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface HistoryFilterParams {
  q?: string;
  type?: string;
  days?: string;
  genre?: string;
  date?: string;
  /** Monday = 0, matching the week × hour grid on the statistics page. */
  weekday?: string;
  hour?: string;
}

const WEEKDAY = /^[0-6]$/;
const HOUR = /^([01]?\d|2[0-3])$/;
const LOCAL_TS = sql`${watchHistory.watchedAt} / 1000, 'unixepoch', 'localtime'`;

/**
 * Shared between the history page and this export so both show exactly the same rows.
 * No 'server-only' import — it is pure query building.
 */
export function historyFilters(userId: number, params: HistoryFilterParams): SQL | undefined {
  const filters: SQL[] = [eq(watchHistory.userId, userId)];
  // SQLite's LIKE is already case-insensitive for ASCII, so no ILIKE is needed.
  if (params.q) filters.push(like(watchHistory.title, `%${params.q}%`));
  if (params.type) filters.push(eq(watchHistory.mediaType, params.type));
  if (params.days) {
    filters.push(gte(watchHistory.watchedAt, new Date(Date.now() - Number(params.days) * 86400000)));
  }
  if (params.genre) {
    filters.push(
      sql`exists (select 1 from json_each(${watchHistory.genres}) where value = ${params.genre})`,
    );
  }
  // Rejected rather than coerced: the value goes into a date() comparison.
  if (params.date && ISO_DAY.test(params.date)) {
    filters.push(sql`date(${LOCAL_TS}) = ${params.date}`);
  }
  // strftime('%w') counts from Sunday; the grid counts from Monday, hence the shift.
  if (params.weekday && WEEKDAY.test(params.weekday)) {
    filters.push(sql`strftime('%w', ${LOCAL_TS}) = ${String((Number(params.weekday) + 1) % 7)}`);
  }
  if (params.hour && HOUR.test(params.hour)) {
    filters.push(sql`cast(strftime('%H', ${LOCAL_TS}) as integer) = ${Number(params.hour)}`);
  }
  return and(...filters);
}

