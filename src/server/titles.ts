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
  recent: {
    itemId: string;
    title: string;
    watchedAt: Date;
    durationMs: number;
    deviceName: string | null;
  }[];
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
    item_id: string;
    title: string;
    watched_at: number;
    duration_ms: number;
    device_name: string | null;
  }>(sql`
    SELECT item_id, title, watched_at, duration_ms, device_name
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
      itemId: r.item_id,
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

/**
 * The same view built from playback_sessions instead of the history, for an item the
 * history has never heard of. Every history aggregate comes back at zero, because that is
 * the truth: the media server has not counted this as played yet.
 */
async function liveItemDetail(itemId: string, scope: Scope): Promise<ItemDetail | null> {
  const scoped = scope.userId === null ? sql`1 = 1` : sql`user_id = ${scope.userId}`;
  const [row] = await db.all<{
    title: string;
    show_label: string | null;
    media_type: string;
  }>(sql`
    SELECT title, grandparent_title AS show_label, media_type
    FROM playback_sessions
    WHERE item_id = ${itemId} AND ${scoped}
    ORDER BY started_at DESC
    LIMIT 1
  `);
  if (!row) return null;

  // Devices come from the sessions here, since that is the only record there is.
  const devices = await db.all<{ label: string; minutes: number }>(sql`
    SELECT coalesce(device_name, client_name, 'Unknown') AS label,
           sum(progress_ms) / 60000 AS minutes
    FROM playback_sessions
    WHERE item_id = ${itemId} AND ${scoped}
    GROUP BY label
    ORDER BY minutes DESC
  `);

  const viewers = await db.all<{ label: string; minutes: number }>(sql`
    SELECT u.username AS label, sum(p.progress_ms) / 60000 AS minutes
    FROM playback_sessions p
    JOIN users u ON u.id = p.user_id
    WHERE p.item_id = ${itemId}
    GROUP BY u.id
    ORDER BY minutes DESC
  `);

  return {
    itemId,
    title: row.title,
    showLabel: row.show_label,
    mediaType: row.media_type,
    year: null,
    genres: [],
    plays: 0,
    watchtimeMs: 0,
    firstWatched: null,
    lastWatched: null,
    devices: devices.map((d) => ({ label: d.label, value: Number(d.minutes) })),
    viewers: viewers.map((v) => ({ label: v.label, value: Number(v.minutes) })),
    plays_list: [],
  };
}

export interface ItemMedia {
  fileSizeBytes?: number;
  videoCodec?: string;
  audioCodec?: string;
  container?: string;
  height?: number;
  bitrateKbps?: number;
  /** Where the numbers came from, since the two sources answer slightly different questions. */
  source: 'library' | 'session';
}

/**
 * What the file behind one item looks like. Two sources, because neither alone covers it:
 *
 * - The library listing carries the file size, but only for movies and series — an episode
 *   is not in it, since getLibrary() asks for Movie and Series only.
 * - A past playback session carries the source codec, resolution and bitrate for anything
 *   that was ever played, episodes included, but never a file size.
 *
 * The library wins where it has an entry; otherwise the newest session fills in. Null when
 * neither knows the item, which is the normal case for something never played on a backend
 * that does not list it.
 */
export async function getItemMedia(itemId: string, serverId: number): Promise<ItemMedia | null> {
  const { getLibrary } = await import('./library');
  const entry = await getLibrary(serverId)
    .then((items) => items.find((item) => item.itemId === itemId))
    .catch(() => undefined);

  if (entry && (entry.fileSizeBytes || entry.videoCodec || entry.height)) {
    return {
      fileSizeBytes: entry.fileSizeBytes,
      videoCodec: entry.videoCodec,
      height: entry.height,
      source: 'library',
    };
  }

  const [row] = await db.all<{
    video: string | null;
    audio: string | null;
    container: string | null;
    height: number | null;
    bitrate: number | null;
  }>(sql`
    SELECT coalesce(source_video_codec, video_codec) AS video,
           coalesce(source_audio_codec, audio_codec) AS audio,
           coalesce(source_container, container) AS container,
           coalesce(source_height, height) AS height,
           coalesce(source_bitrate_kbps, bitrate_kbps) AS bitrate
    FROM playback_sessions
    WHERE item_id = ${itemId}
    ORDER BY started_at DESC
    LIMIT 1
  `);
  if (!row || !(row.video || row.height || row.bitrate)) return null;

  return {
    videoCodec: row.video ?? undefined,
    audioCodec: row.audio ?? undefined,
    container: row.container ?? undefined,
    height: row.height ?? undefined,
    bitrateKbps: row.bitrate ?? undefined,
    source: 'session',
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
  // Nothing in the history does not mean the item is unknown. A stream running right now
  // has a playback_sessions row and no history row at all — the history is the media
  // server's own played list and only catches up afterwards — so the episode linked from
  // Now Playing used to 404 on the way in.
  if (!summary || Number(summary.plays) === 0) return liveItemDetail(itemId, scope);

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
