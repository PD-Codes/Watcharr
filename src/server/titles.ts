import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from '@/db';
import type { LabelledValue, Scope } from './stats';

export interface TitleDetail {
  label: string;
  itemId: string | null;
  mediaType: string;
  year: number | null;
  genres: string[];
  plays: number;
  watchtimeMs: number;
  firstWatched: Date | null;
  lastWatched: Date | null;
  distinctItems: number;
  devices: LabelledValue[];
  viewers: LabelledValue[];
  daily: LabelledValue[];
  recent: { title: string; watchedAt: Date; durationMs: number; deviceName: string | null }[];
  /** Distinct items under this label — the episode list for a show, one row for a movie. */
  episodes: { itemId: string; title: string; plays: number; watchtimeMs: number; lastWatched: Date }[];
}

/**
 * Everything about one title. Episodes are grouped under their show, which is why the
 * lookup key is the display label rather than an item id.
 */
export async function getTitleDetail(label: string, scope: Scope): Promise<TitleDetail | null> {
  const matches = sql`coalesce(grandparent_title, title) = ${label}`;
  const scoped =
    scope.userId === null ? sql`1 = 1` : sql`user_id = ${scope.userId}`;
  const where = sql`${matches} AND ${scoped}`;

  const [summary] = await db.all<{
    item_id: string | null;
    media_type: string;
    year: number | null;
    plays: number;
    watchtime: number;
    first_watched: number | null;
    last_watched: number | null;
    distinct_items: number;
  }>(sql`
    SELECT max(item_id) AS item_id,
           max(media_type) AS media_type,
           max(year) AS year,
           count(*) AS plays,
           coalesce(sum(duration_ms), 0) AS watchtime,
           min(watched_at) AS first_watched,
           max(watched_at) AS last_watched,
           count(DISTINCT item_id) AS distinct_items
    FROM watch_history
    WHERE ${where}
  `);
  if (!summary || Number(summary.plays) === 0) return null;

  const genres = await db.all<{ genre: string }>(sql`
    SELECT DISTINCT genre.value AS genre
    FROM watch_history, json_each(watch_history.genres) AS genre
    WHERE ${where}
    ORDER BY genre
  `);

  const devices = await db.all<{ label: string; minutes: number }>(sql`
    SELECT coalesce(device_name, 'Unknown') AS label, sum(duration_ms) / 60000 AS minutes
    FROM watch_history
    WHERE ${where}
    GROUP BY label
    ORDER BY minutes DESC
  `);

  // Only meaningful server-wide; for a single user this is always just that user.
  const viewers = await db.all<{ label: string; minutes: number }>(sql`
    SELECT u.username AS label, sum(h.duration_ms) / 60000 AS minutes
    FROM watch_history h
    JOIN users u ON u.id = h.user_id
    WHERE coalesce(h.grandparent_title, h.title) = ${label}
    GROUP BY u.id
    ORDER BY minutes DESC
  `);

  const daily = await db.all<{ day: string; minutes: number }>(sql`
    WITH RECURSIVE calendar(day) AS (
      SELECT date('now', 'localtime', '-29 days')
      UNION ALL
      SELECT date(day, '+1 day') FROM calendar WHERE day < date('now', 'localtime')
    )
    SELECT calendar.day AS day, coalesce(sum(h.duration_ms), 0) / 60000 AS minutes
    FROM calendar
    LEFT JOIN watch_history h
      ON date(h.watched_at / 1000, 'unixepoch', 'localtime') = calendar.day
     AND coalesce(h.grandparent_title, h.title) = ${label}
     AND ${scope.userId === null ? sql`1 = 1` : sql`h.user_id = ${scope.userId}`}
    GROUP BY calendar.day
    ORDER BY calendar.day
  `);

  const recent = await db.all<{
    title: string;
    watched_at: number;
    duration_ms: number;
    device_name: string | null;
  }>(sql`
    SELECT title, watched_at, duration_ms, device_name
    FROM watch_history
    WHERE ${where}
    ORDER BY watched_at DESC
    LIMIT 25
  `);

  const episodes = await db.all<{
    item_id: string;
    episode_title: string;
    plays: number;
    watchtime: number;
    last_watched: number;
  }>(sql`
    SELECT item_id,
           max(title) AS episode_title,
           count(*) AS plays,
           coalesce(sum(duration_ms), 0) AS watchtime,
           max(watched_at) AS last_watched
    FROM watch_history
    WHERE ${where}
    GROUP BY item_id
    ORDER BY last_watched DESC
    LIMIT 200
  `);

  return {
    label,
    itemId: summary.item_id,
    mediaType: summary.media_type,
    year: summary.year,
    genres: genres.map((g) => g.genre),
    plays: Number(summary.plays),
    watchtimeMs: Number(summary.watchtime),
    firstWatched: summary.first_watched ? new Date(Number(summary.first_watched)) : null,
    lastWatched: summary.last_watched ? new Date(Number(summary.last_watched)) : null,
    distinctItems: Number(summary.distinct_items),
    devices: devices.map((d) => ({ label: d.label, value: Number(d.minutes) })),
    viewers: viewers.map((v) => ({ label: v.label, value: Number(v.minutes) })),
    daily: daily.map((d) => ({ label: d.day, value: Number(d.minutes) })),
    recent: recent.map((r) => ({
      title: r.title,
      watchedAt: new Date(Number(r.watched_at)),
      durationMs: Number(r.duration_ms),
      deviceName: r.device_name,
    })),
    episodes: episodes.map((e) => ({
      itemId: e.item_id,
      title: e.episode_title,
      plays: Number(e.plays),
      watchtimeMs: Number(e.watchtime),
      lastWatched: new Date(Number(e.last_watched)),
    })),
  };
}

export interface ItemDetail {
  itemId: string;
  title: string;
  showLabel: string | null;
  mediaType: string;
  year: number | null;
  genres: string[];
  plays: number;
  watchtimeMs: number;
  firstWatched: Date | null;
  lastWatched: Date | null;
  devices: LabelledValue[];
  viewers: LabelledValue[];
  plays_list: { watchedAt: Date; durationMs: number; deviceName: string | null }[];
}

/** Same view as getTitleDetail, but for a single item (one episode or one movie). */
export async function getItemDetail(itemId: string, scope: Scope): Promise<ItemDetail | null> {
  const scoped = scope.userId === null ? sql`1 = 1` : sql`user_id = ${scope.userId}`;
  const where = sql`item_id = ${itemId} AND ${scoped}`;

  const [summary] = await db.all<{
    item_title: string | null;
    show_label: string | null;
    media_type: string;
    year: number | null;
    plays: number;
    watchtime: number;
    first_watched: number | null;
    last_watched: number | null;
  }>(sql`
    SELECT max(title) AS item_title,
           max(grandparent_title) AS show_label,
           max(media_type) AS media_type,
           max(year) AS year,
           count(*) AS plays,
           coalesce(sum(duration_ms), 0) AS watchtime,
           min(watched_at) AS first_watched,
           max(watched_at) AS last_watched
    FROM watch_history
    WHERE ${where}
  `);
  if (!summary || Number(summary.plays) === 0) return null;

  const genres = await db.all<{ genre: string }>(sql`
    SELECT DISTINCT genre.value AS genre
    FROM watch_history, json_each(watch_history.genres) AS genre
    WHERE ${where}
    ORDER BY genre
  `);

  const devices = await db.all<{ label: string; minutes: number }>(sql`
    SELECT coalesce(device_name, 'Unknown') AS label, sum(duration_ms) / 60000 AS minutes
    FROM watch_history
    WHERE ${where}
    GROUP BY label
    ORDER BY minutes DESC
  `);

  const viewers = await db.all<{ label: string; minutes: number }>(sql`
    SELECT u.username AS label, sum(h.duration_ms) / 60000 AS minutes
    FROM watch_history h
    JOIN users u ON u.id = h.user_id
    WHERE h.item_id = ${itemId}
    GROUP BY u.id
    ORDER BY minutes DESC
  `);

  const playsList = await db.all<{
    watched_at: number;
    duration_ms: number;
    device_name: string | null;
  }>(sql`
    SELECT watched_at, duration_ms, device_name
    FROM watch_history
    WHERE ${where}
    ORDER BY watched_at DESC
    LIMIT 25
  `);

  return {
    itemId,
    title: summary.item_title ?? itemId,
    showLabel: summary.show_label,
    mediaType: summary.media_type,
    year: summary.year,
    genres: genres.map((g) => g.genre),
    plays: Number(summary.plays),
    watchtimeMs: Number(summary.watchtime),
    firstWatched: summary.first_watched ? new Date(Number(summary.first_watched)) : null,
    lastWatched: summary.last_watched ? new Date(Number(summary.last_watched)) : null,
    devices: devices.map((d) => ({ label: d.label, value: Number(d.minutes) })),
    viewers: viewers.map((v) => ({ label: v.label, value: Number(v.minutes) })),
    plays_list: playsList.map((p) => ({
      watchedAt: new Date(Number(p.watched_at)),
      durationMs: Number(p.duration_ms),
      deviceName: p.device_name,
    })),
  };
}
