import 'server-only';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import { scopeFilter, type LabelledValue, type Scope } from './stats';

// Statistics derived from playback_sessions: how content was delivered, not what was watched.
// Watch time per session is the last observed playback position.

function since(days?: number, alias = ''): SQL {
  const column = sql.raw(`${alias}started_at`);
  return days ? sql`${column} >= (unixepoch('now', ${`-${days} days`}) * 1000)` : sql`1 = 1`;
}

/** Restricts session statistics to one user, one server, or nothing at all. */
function scoped(scope?: Scope, alias = ''): SQL {
  return scope ? scopeFilter(scope, alias) : sql`1 = 1`;
}

export interface CompletionSplit {
  finished: number;
  abandoned: number;
  /** Percentage of sessions that reached the threshold, or null without any data. */
  rate: number | null;
}

/**
 * How many streams were actually watched through. This is the only place a "watched"
 * threshold can be applied: watch_history is the media server's own played list and holds
 * no progress, while a session records the position the stream reached.
 *
 * Sessions without a duration (live streams, servers that report none) are left out —
 * counting them as abandoned would drag the rate down for something never watchable.
 */
export async function getCompletionSplit(
  threshold: number,
  days?: number,
  scope?: Scope,
): Promise<CompletionSplit> {
  const [row] = await db.all<{ finished: number; total: number }>(sql`
    SELECT count(*) FILTER (WHERE progress_ms * 100 >= duration_ms * ${threshold}) AS finished,
           count(*) AS total
    FROM playback_sessions
    WHERE duration_ms > 0 AND ${since(days)} AND ${scoped(scope)}
  `);
  const finished = Number(row?.finished ?? 0);
  const total = Number(row?.total ?? 0);
  return {
    finished,
    abandoned: Math.max(0, total - finished),
    rate: total > 0 ? Math.round((finished / total) * 100) : null,
  };
}

export interface ConcurrencyPoint {
  label: string;
  /** Sessions overlapping this hour, not a peak within it. */
  streams: number;
  bandwidthKbps: number;
}

/**
 * Streams and delivered bandwidth per bucket, built from the session intervals rather than
 * from snapshots — playback_sessions keeps rows after playback ended, which is what makes
 * this reconstructible at all.
 *
 * Buckets by hour up to a week — enough resolution to see the evening peak — and by day
 * beyond that, so a month is 30 points instead of 720. This used to be hourly no matter
 * the range; the only caller stayed inside a week, which is exactly why nobody noticed
 * until a longer view was actually wanted.
 */
export async function getConcurrencyOverTime(
  days = 7,
  scope?: Scope,
): Promise<ConcurrencyPoint[]> {
  const hourly = days <= 7;
  const stepMs = hourly ? 3_600_000 : 86_400_000;
  const truncFormat = hourly ? '%Y-%m-%d %H:00:00' : '%Y-%m-%d 00:00:00';
  const labelFormat = hourly ? '%m-%d %H:00' : '%m-%d';

  const rows = await db.all<{ slot: string; streams: number; bandwidth: number }>(sql`
    WITH RECURSIVE bucket(ts) AS (
      SELECT unixepoch(strftime(${truncFormat}, 'now', ${`-${days} days`})) * 1000
      UNION ALL
      SELECT ts + ${stepMs} FROM bucket
      WHERE ts + ${stepMs} <= unixepoch(strftime(${truncFormat}, 'now')) * 1000
    )
    SELECT strftime(${labelFormat}, ts / 1000, 'unixepoch') AS slot,
           count(s.session_key) AS streams,
           coalesce(sum(s.bitrate_kbps), 0) AS bandwidth
    FROM bucket
    LEFT JOIN playback_sessions s
      ON s.started_at < ts + ${stepMs}
     AND max(s.last_seen_at, s.started_at) >= ts
     AND ${scoped(scope, 's.')}
    GROUP BY ts
    ORDER BY ts
  `);

  return rows.map((r) => ({
    label: r.slot,
    streams: Number(r.streams ?? 0),
    bandwidthKbps: Number(r.bandwidth ?? 0),
  }));
}

export interface PlaybackTotals {
  sessions: number;
  uniqueClients: number;
  uniqueUsers: number;
  uniqueDevices: number;
  transcodes: number;
  watchtimeMs: number;
  avgBitrateKbps: number;
  minBitrateKbps: number;
  maxBitrateKbps: number;
}

export async function getPlaybackTotals(days?: number, scope?: Scope): Promise<PlaybackTotals> {
  const [row] = await db.all<Record<string, number | null>>(sql`
    SELECT count(*) AS sessions,
           count(DISTINCT client_name) AS clients,
           count(DISTINCT user_id) AS users,
           count(DISTINCT device_name) AS devices,
           count(*) FILTER (WHERE play_method = 'transcode') AS transcodes,
           coalesce(sum(progress_ms), 0) AS watchtime,
           coalesce(avg(bitrate_kbps), 0) AS avg_bitrate,
           coalesce(min(bitrate_kbps), 0) AS min_bitrate,
           coalesce(max(bitrate_kbps), 0) AS max_bitrate
    FROM playback_sessions
    WHERE ${since(days)} AND ${scoped(scope)}
  `);

  return {
    sessions: Number(row?.sessions ?? 0),
    uniqueClients: Number(row?.clients ?? 0),
    uniqueUsers: Number(row?.users ?? 0),
    uniqueDevices: Number(row?.devices ?? 0),
    transcodes: Number(row?.transcodes ?? 0),
    watchtimeMs: Number(row?.watchtime ?? 0),
    avgBitrateKbps: Math.round(Number(row?.avg_bitrate ?? 0)),
    minBitrateKbps: Number(row?.min_bitrate ?? 0),
    maxBitrateKbps: Number(row?.max_bitrate ?? 0),
  };
}

async function grouped(
  expression: SQL,
  days?: number,
  limit = 10,
  scope?: Scope,
): Promise<LabelledValue[]> {
  const rows = await db.all<{ label: string | null; total: number }>(sql`
    SELECT ${expression} AS label, count(*) AS total
    FROM playback_sessions
    WHERE ${since(days)} AND ${scoped(scope)}
    GROUP BY label
    ORDER BY total DESC, label ASC
    LIMIT ${limit}
  `);
  return rows
    .filter((r) => r.label !== null)
    .map((r) => ({ label: String(r.label), value: Number(r.total) }));
}

export const getPlayMethods = (days?: number, scope?: Scope) =>
  grouped(
    sql`CASE play_method
          WHEN 'directplay' THEN 'Direct play'
          WHEN 'directstream' THEN 'Direct stream'
          WHEN 'transcode' THEN 'Transcode'
          ELSE 'Unknown' END`,
    days,
    10,
    scope,
  );

export const getTranscodeReasons = (days?: number, scope?: Scope) =>
  grouped(sql`transcode_reason`, days, 10, scope);

export const getVideoCodecs = (days?: number, scope?: Scope) =>
  grouped(sql`upper(video_codec)`, days, 10, scope);
export const getAudioCodecs = (days?: number, scope?: Scope) =>
  grouped(sql`upper(audio_codec)`, days, 10, scope);
export const getContainers = (days?: number, scope?: Scope) =>
  grouped(sql`upper(container)`, days, 10, scope);

/** Buckets by the classic resolution tiers rather than exact pixel counts. */
export const getResolutions = (days?: number, scope?: Scope) =>
  grouped(
    sql`CASE
          WHEN height >= 2000 THEN '4K'
          WHEN height >= 1080 THEN '1080p'
          WHEN height >= 720 THEN '720p'
          WHEN height >= 480 THEN '480p'
          WHEN height > 0 THEN 'SD'
          ELSE NULL END`,
    days,
    10,
    scope,
  );

export const getBitrateBuckets = (days?: number, scope?: Scope) =>
  grouped(
    sql`CASE
          WHEN bitrate_kbps >= 20000 THEN '20+ Mbps'
          WHEN bitrate_kbps >= 10000 THEN '10-20 Mbps'
          WHEN bitrate_kbps >= 6000 THEN '6-10 Mbps'
          WHEN bitrate_kbps >= 4000 THEN '4-6 Mbps'
          WHEN bitrate_kbps >= 2000 THEN '2-4 Mbps'
          WHEN bitrate_kbps > 0 THEN '< 2 Mbps'
          ELSE NULL END`,
    days,
    10,
    scope,
  );

export const getClientSessions = (days?: number, scope?: Scope) =>
  grouped(sql`coalesce(client_name, 'Unknown')`, days, 10, scope);

export const getDeviceSessions = (days?: number, scope?: Scope) =>
  grouped(sql`coalesce(device_name, 'Unknown')`, days, 10, scope);

/** Watch time per client, in minutes. */
export async function getClientWatchtime(days?: number, scope?: Scope): Promise<LabelledValue[]> {
  const rows = await db.all<{ label: string; minutes: number }>(sql`
    SELECT coalesce(client_name, 'Unknown') AS label, sum(progress_ms) / 60000 AS minutes
    FROM playback_sessions
    WHERE ${since(days)} AND ${scoped(scope)}
    GROUP BY label
    ORDER BY minutes DESC
    LIMIT 10
  `);
  return rows.map((r) => ({ label: r.label, value: Number(r.minutes) }));
}

export interface UsageRow {
  primary: string;
  secondary: string;
  sessions: number;
  watchtimeMs: number;
  transcodes: number;
}

async function usage(primary: SQL, secondary: SQL, days?: number, scope?: Scope): Promise<UsageRow[]> {
  const rows = await db.all<{
    primary_label: string | null;
    secondary_label: string | null;
    sessions: number;
    watchtime: number;
    transcodes: number;
  }>(sql`
    SELECT ${primary} AS primary_label,
           ${secondary} AS secondary_label,
           count(*) AS sessions,
           coalesce(sum(p.progress_ms), 0) AS watchtime,
           count(*) FILTER (WHERE p.play_method = 'transcode') AS transcodes
    FROM playback_sessions p
    LEFT JOIN users u ON u.id = p.user_id
    WHERE ${since(days, 'p.')} AND ${scoped(scope, 'p.')}
    GROUP BY primary_label, secondary_label
    ORDER BY sessions DESC
    LIMIT 30
  `);

  return rows.map((r) => ({
    primary: String(r.primary_label ?? 'Unknown'),
    secondary: String(r.secondary_label ?? 'Unknown'),
    sessions: Number(r.sessions),
    watchtimeMs: Number(r.watchtime),
    transcodes: Number(r.transcodes),
  }));
}

export interface ConcurrencyPeak {
  streams: number;
  transcodes: number;
  directStreams: number;
  directPlays: number;
}

/**
 * The busiest moment on record: the most streams that ever overlapped, plus what they were
 * doing. Every session start is a candidate peak — counting overlaps at those instants is
 * enough, because concurrency can only rise when a session begins.
 */
export async function getConcurrencyPeak(days?: number, scope?: Scope): Promise<ConcurrencyPeak> {
  const [row] = await db.all<{
    streams: number;
    transcodes: number;
    direct_streams: number;
    direct_plays: number;
  }>(sql`
    SELECT max(overlap.streams) AS streams,
           max(overlap.transcodes) AS transcodes,
           max(overlap.direct_streams) AS direct_streams,
           max(overlap.direct_plays) AS direct_plays
    FROM (
      SELECT count(*) AS streams,
             count(*) FILTER (WHERE b.play_method = 'transcode') AS transcodes,
             count(*) FILTER (WHERE b.play_method = 'directstream') AS direct_streams,
             count(*) FILTER (WHERE b.play_method = 'directplay') AS direct_plays
      FROM playback_sessions a
      JOIN playback_sessions b
        ON b.started_at <= a.started_at
       AND max(b.last_seen_at, b.started_at) >= a.started_at
       AND ${scoped(scope, 'b.')}
      WHERE ${since(days, 'a.')} AND ${scoped(scope, 'a.')}
      GROUP BY a.started_at
    ) AS overlap
  `);

  return {
    streams: Number(row?.streams ?? 0),
    transcodes: Number(row?.transcodes ?? 0),
    directStreams: Number(row?.direct_streams ?? 0),
    directPlays: Number(row?.direct_plays ?? 0),
  };
}

export interface AddressRow {
  ip: string;
  firstSeen: Date;
  lastSeen: Date;
  plays: number;
  lastPlayer: string | null;
  lastTitle: string | null;
  isLocal: boolean | null;
}

/**
 * Every address one user has streamed from, newest first. Sessions carry the address, the
 * history does not, so this starts from the day Watcharr was installed like the rest of
 * the playback statistics.
 */
export async function getUserAddresses(userId: number, limit = 50): Promise<AddressRow[]> {
  const rows = await db.all<{
    ip: string;
    first_seen: number;
    last_seen: number;
    plays: number;
    last_player: string | null;
    last_title: string | null;
    is_local: number | null;
  }>(sql`
    SELECT remote_address AS ip,
           min(started_at) AS first_seen,
           max(last_seen_at) AS last_seen,
           count(*) AS plays,
           -- The player and title of the most recent session on this address.
           (SELECT coalesce(p2.device_name, p2.client_name) FROM playback_sessions p2
             WHERE p2.remote_address = p.remote_address AND p2.user_id = p.user_id
             ORDER BY p2.last_seen_at DESC LIMIT 1) AS last_player,
           (SELECT coalesce(p3.grandparent_title, p3.title) FROM playback_sessions p3
             WHERE p3.remote_address = p.remote_address AND p3.user_id = p.user_id
             ORDER BY p3.last_seen_at DESC LIMIT 1) AS last_title,
           max(is_local) AS is_local
    FROM playback_sessions p
    WHERE user_id = ${userId} AND remote_address IS NOT NULL
    GROUP BY remote_address
    ORDER BY last_seen DESC
    LIMIT ${limit}
  `);

  return rows.map((r) => ({
    ip: r.ip,
    firstSeen: new Date(Number(r.first_seen)),
    lastSeen: new Date(Number(r.last_seen)),
    plays: Number(r.plays),
    lastPlayer: r.last_player,
    lastTitle: r.last_title,
    isLocal: r.is_local === null ? null : Boolean(r.is_local),
  }));
}

/** Play counts per player/device for one user — Tautulli's player stats tiles. */
export async function getUserPlayers(userId: number, limit = 20): Promise<LabelledValue[]> {
  const rows = await db.all<{ label: string; total: number }>(sql`
    SELECT coalesce(device_name, client_name, 'Unknown') AS label, count(*) AS total
    FROM playback_sessions
    WHERE user_id = ${userId}
    GROUP BY label
    ORDER BY total DESC, label ASC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({ label: r.label, value: Number(r.total) }));
}

export const getClientsPerUser = (days?: number, scope?: Scope) =>
  usage(sql`coalesce(u.username, 'Unknown')`, sql`coalesce(p.client_name, 'Unknown')`, days, scope);

export const getClientsPerDevice = (days?: number, scope?: Scope) =>
  usage(sql`coalesce(p.device_name, 'Unknown')`, sql`coalesce(p.client_name, 'Unknown')`, days, scope);
