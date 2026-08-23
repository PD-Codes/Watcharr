import 'server-only';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import type { LabelledValue, Scope } from './stats';

// Statistics derived from playback_sessions: how content was delivered, not what was watched.
// Watch time per session is the last observed playback position.

function since(days?: number, alias = ''): SQL {
  const column = sql.raw(`${alias}started_at`);
  return days ? sql`${column} >= (unixepoch('now', ${`-${days} days`}) * 1000)` : sql`1 = 1`;
}

/** Restricts session statistics to one user, or to the whole server. */
function scoped(scope?: Scope, alias = ''): SQL {
  const column = sql.raw(`${alias}user_id`);
  return !scope || scope.userId === null ? sql`1 = 1` : sql`${column} = ${scope.userId}`;
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

export const getClientsPerUser = (days?: number, scope?: Scope) =>
  usage(sql`coalesce(u.username, 'Unknown')`, sql`coalesce(p.client_name, 'Unknown')`, days, scope);

export const getClientsPerDevice = (days?: number, scope?: Scope) =>
  usage(sql`coalesce(p.device_name, 'Unknown')`, sql`coalesce(p.client_name, 'Unknown')`, days, scope);
