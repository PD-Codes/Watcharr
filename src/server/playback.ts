import 'server-only';
import { sql, type SQL } from 'drizzle-orm';
import { readDb as db } from './readcache';
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
 * counting them as abandoned would drag the rate down for something never watchable. So are
 * sessions that are still open: a stream at 20% right now has not been abandoned, it has not
 * finished either, and the next poll moves it.
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
    WHERE duration_ms > 0 AND state = 'ended' AND ${since(days)} AND ${scoped(scope)}
  `);
  const finished = Number(row?.finished ?? 0);
  const total = Number(row?.total ?? 0);
  return {
    finished,
    abandoned: Math.max(0, total - finished),
    rate: total > 0 ? Math.round((finished / total) * 100) : null,
  };
}

/**
 * Time buckets (ts, next_ts in epoch ms, plus a label) for the over-time charts, cut in the
 * configured zone like every other aggregate (see db/index.ts). They used to be cut in UTC,
 * so with a zone set an evening peak was labeled hours early and a day boundary fell in the
 * middle of the evening.
 *
 * Hours are stepped in UTC milliseconds — an hour is an hour whatever the clock says. Days
 * are built as local calendar days and converted: a fixed 24 h step drifts off midnight
 * after every DST change and would file the same evening under the wrong day.
 */
// A stream that overlaps a bucket started at most this long before it. With the lower bound the
// bucket join reads a few days of sessions through playback_sessions_started_idx instead of
// every session ever recorded once per bucket (half a minute on a million rows). Streams
// longer than this are zombies the live check already refuses to believe in.
const LOOKBACK = sql`((SELECT min(ts) FROM bucket) - 172800000)`;

function bucketsCte(days: number): SQL {
  if (days <= 7) {
    return sql`
      WITH RECURSIVE hour(ts) AS (
        SELECT unixepoch(strftime('%Y-%m-%d %H:00:00', 'now', 'localtime', ${`-${days} days`}), 'utc') * 1000
        UNION ALL
        SELECT ts + 3600000 FROM hour
        WHERE ts + 3600000 <= unixepoch(strftime('%Y-%m-%d %H:00:00', 'now', 'localtime'), 'utc') * 1000
      ),
      bucket(ts, next_ts, slot) AS (
        SELECT ts, ts + 3600000, strftime('%m-%d %H:00', ts / 1000, 'unixepoch', 'localtime') FROM hour
      )`;
  }
  return sql`
    WITH RECURSIVE day_list(day) AS (
      SELECT date('now', 'localtime', ${`-${days} days`})
      UNION ALL
      SELECT date(day, '+1 day') FROM day_list WHERE day < date('now', 'localtime')
    ),
    bucket(ts, next_ts, slot) AS (
      SELECT unixepoch(day, 'utc') * 1000,
             unixepoch(date(day, '+1 day'), 'utc') * 1000,
             strftime('%m-%d', day)
      FROM day_list
    )`;
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
  const rows = await db.all<{ slot: string; streams: number; bandwidth: number }>(sql`
    ${bucketsCte(days)}
    SELECT slot,
           count(s.session_key) AS streams,
           coalesce(sum(s.bitrate_kbps), 0) AS bandwidth
    FROM bucket
    LEFT JOIN playback_sessions s
      ON s.started_at < next_ts
     AND max(s.last_seen_at, s.started_at) >= ts
     AND s.started_at >= ${LOOKBACK}
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

export interface BandwidthPoint {
  label: string;
  lanKbps: number;
  wanKbps: number;
}

/**
 * Delivered bandwidth split by where it went. The two are worth separating because only
 * one of them costs an uplink: a 40 Mbps direct play to the living room TV and the same
 * stream to someone's phone on mobile data are the same number and a completely different
 * problem. is_local is derived on write, so this is a filter rather than a re-parse.
 */
export async function getBandwidthOverTime(days = 7, scope?: Scope): Promise<BandwidthPoint[]> {
  const rows = await db.all<{ slot: string; lan: number; wan: number }>(sql`
    ${bucketsCte(days)}
    SELECT slot,
           coalesce(sum(s.bitrate_kbps) FILTER (WHERE s.is_local = 1), 0) AS lan,
           coalesce(sum(s.bitrate_kbps) FILTER (WHERE s.is_local IS NOT 1), 0) AS wan
    FROM bucket
    LEFT JOIN playback_sessions s
      ON s.started_at < next_ts
     AND max(s.last_seen_at, s.started_at) >= ts
     AND s.started_at >= ${LOOKBACK}
     AND ${scoped(scope, 's.')}
    GROUP BY ts
    ORDER BY ts
  `);

  return rows.map((r) => ({
    label: r.slot,
    lanKbps: Number(r.lan ?? 0),
    wanKbps: Number(r.wan ?? 0),
  }));
}

export interface StreamTypeSeries {
  labels: string[];
  series: { label: string; values: number[] }[];
}

/**
 * How streams were delivered, day by day. A single "transcodes" number says nothing about
 * whether the situation is getting worse; the same figure next to direct plays over a
 * month does. Bucketed per day, always — the point is the trend, not the evening peak.
 */
export async function getStreamTypesOverTime(days = 30, scope?: Scope): Promise<StreamTypeSeries> {
  const rows = await db.all<{
    day: string;
    direct_play: number;
    direct_stream: number;
    transcode: number;
  }>(sql`
    WITH RECURSIVE calendar(day) AS (
      SELECT date('now', 'localtime', ${`-${days - 1} days`})
      UNION ALL
      SELECT date(day, '+1 day') FROM calendar WHERE day < date('now', 'localtime')
    ),
    -- One grouped scan, joined to the calendar below. Joining the calendar to the raw sessions
    -- evaluates the date expression for every session once per day (no index can serve it):
    -- a year over 20k sessions took five seconds. The extra day in since() is a prefilter only.
    used(local_day, direct_play, direct_stream, transcode) AS (
      SELECT date(started_at / 1000, 'unixepoch', 'localtime'),
             count(*) FILTER (WHERE play_method = 'directplay'),
             count(*) FILTER (WHERE play_method = 'directstream'),
             count(*) FILTER (WHERE play_method = 'transcode')
      FROM playback_sessions
      WHERE ${scoped(scope)} AND ${since(days + 1)}
      GROUP BY 1
    )
    SELECT calendar.day AS day,
           coalesce(used.direct_play, 0) AS direct_play,
           coalesce(used.direct_stream, 0) AS direct_stream,
           coalesce(used.transcode, 0) AS transcode
    FROM calendar
    LEFT JOIN used ON used.local_day = calendar.day
    ORDER BY calendar.day
  `);

  return {
    labels: rows.map((r) => r.day),
    series: [
      { label: 'Direct play', values: rows.map((r) => Number(r.direct_play)) },
      { label: 'Direct stream', values: rows.map((r) => Number(r.direct_stream)) },
      { label: 'Transcode', values: rows.map((r) => Number(r.transcode)) },
    ],
  };
}

export interface SessionHistoryRow {
  sessionKey: string;
  userId: number | null;
  username: string | null;
  itemId: string;
  title: string;
  grandparentTitle: string | null;
  mediaType: string;
  state: string;
  progressMs: number;
  durationMs: number;
  clientName: string | null;
  deviceName: string | null;
  playMethod: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  audioChannels: number | null;
  subtitleCodec: string | null;
  container: string | null;
  height: number | null;
  bitrateKbps: number | null;
  sourceVideoCodec: string | null;
  sourceAudioCodec: string | null;
  sourceContainer: string | null;
  sourceHeight: number | null;
  sourceBitrateKbps: number | null;
  transcodeReason: string | null;
  remoteAddress: string | null;
  isLocal: boolean | null;
  startedAt: Date;
  lastSeenAt: Date;
}

/**
 * Past streams with every detail the media server reported. playback_sessions keeps its
 * rows after playback ended, which is the only reason this history exists at all — the
 * media server's own history API reports what was watched, never how it was delivered.
 */
export async function listSessionHistory(options: {
  scope?: Scope;
  days?: number;
  limit?: number;
  offset?: number;
  /** Only transcoded streams — the list an admin actually goes looking for. */
  transcodesOnly?: boolean;
}): Promise<{ rows: SessionHistoryRow[]; total: number }> {
  const { scope, days, limit = 50, offset = 0, transcodesOnly = false } = options;
  const filter = sql`${since(days, 'p.')} AND ${scope ? scopeFilter(scope, 'p.', true) : sql`1 = 1`} AND ${
    transcodesOnly ? sql`p.play_method = 'transcode'` : sql`1 = 1`
  }`;

  const [count] = await db.all<{ total: number }>(sql`
    SELECT count(*) AS total FROM playback_sessions p WHERE ${filter}
  `);

  const rows = await db.all<Record<string, unknown>>(sql`
    SELECT p.*, u.username AS username
    FROM playback_sessions p
    LEFT JOIN users u ON u.id = p.user_id
    WHERE ${filter}
    ORDER BY p.started_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
  const str = (value: unknown) => (value === null || value === undefined ? null : String(value));

  return {
    total: Number(count?.total ?? 0),
    rows: rows.map((r) => ({
      sessionKey: String(r.session_key),
      userId: num(r.user_id),
      username: str(r.username),
      itemId: String(r.item_id),
      title: String(r.title),
      grandparentTitle: str(r.grandparent_title),
      mediaType: String(r.media_type),
      state: String(r.state),
      progressMs: Number(r.progress_ms ?? 0),
      durationMs: Number(r.duration_ms ?? 0),
      clientName: str(r.client_name),
      deviceName: str(r.device_name),
      playMethod: str(r.play_method),
      videoCodec: str(r.video_codec),
      audioCodec: str(r.audio_codec),
      audioChannels: num(r.audio_channels),
      subtitleCodec: str(r.subtitle_codec),
      container: str(r.container),
      height: num(r.height),
      bitrateKbps: num(r.bitrate_kbps),
      sourceVideoCodec: str(r.source_video_codec),
      sourceAudioCodec: str(r.source_audio_codec),
      sourceContainer: str(r.source_container),
      sourceHeight: num(r.source_height),
      sourceBitrateKbps: num(r.source_bitrate_kbps),
      transcodeReason: str(r.transcode_reason),
      remoteAddress: str(r.remote_address),
      isLocal: r.is_local === null || r.is_local === undefined ? null : Boolean(r.is_local),
      startedAt: new Date(Number(r.started_at)),
      lastSeenAt: new Date(Number(r.last_seen_at)),
    })),
  };
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
 * doing. Concurrency can only rise when a session begins, so it is enough to walk the starts
 * and ends in time order with a running count — one sort, instead of the self-join this used
 * to be, which compared every session with every other and did not finish on a million rows.
 * A stream that ends at the very instant another starts still counts as overlapping it, so
 * starts sort before ends at the same instant.
 */
export async function getConcurrencyPeak(days?: number, scope?: Scope): Promise<ConcurrencyPeak> {
  const [row] = await db.all<{
    streams: number;
    transcodes: number;
    direct_streams: number;
    direct_plays: number;
  }>(sql`
    WITH ev(t, k, m, d) AS (
      SELECT started_at, 0, play_method, 1 FROM playback_sessions
      WHERE ${since(days)} AND ${scoped(scope)}
      UNION ALL
      SELECT max(last_seen_at, started_at), 1, play_method, -1 FROM playback_sessions
      WHERE ${since(days)} AND ${scoped(scope)}
    ),
    running AS (
      SELECT sum(d) OVER w AS streams,
             sum(CASE WHEN m = 'transcode' THEN d ELSE 0 END) OVER w AS transcodes,
             sum(CASE WHEN m = 'directstream' THEN d ELSE 0 END) OVER w AS direct_streams,
             sum(CASE WHEN m = 'directplay' THEN d ELSE 0 END) OVER w AS direct_plays
      FROM ev
      WINDOW w AS (ORDER BY t, k ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
    )
    SELECT max(streams) AS streams, max(transcodes) AS transcodes,
           max(direct_streams) AS direct_streams, max(direct_plays) AS direct_plays
    FROM running
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
    -- One pass with a window instead of two correlated subqueries per address: those sorted
    -- the user's sessions again for every address (21 s for a heavy user on a large database).
    WITH s AS (
      SELECT remote_address, started_at, last_seen_at, is_local,
             coalesce(device_name, client_name) AS player,
             coalesce(grandparent_title, title) AS shown,
             row_number() OVER (PARTITION BY remote_address ORDER BY last_seen_at DESC) AS rn
      FROM playback_sessions
      WHERE user_id = ${userId} AND remote_address IS NOT NULL
    )
    SELECT remote_address AS ip,
           min(started_at) AS first_seen,
           max(last_seen_at) AS last_seen,
           count(*) AS plays,
           max(CASE WHEN rn = 1 THEN player END) AS last_player,
           max(CASE WHEN rn = 1 THEN shown END) AS last_title,
           max(is_local) AS is_local
    FROM s
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
