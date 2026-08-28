import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { playbackSessions, users } from '@/db/schema';
import { isPrivateAddress } from './net';
import { recordPlays, type PlayInput } from './plays';

/**
 * One-shot import from a Tautulli database.
 *
 * This is the only thing Watcharr cannot reconstruct for a new deployment. watch_history is
 * pulled from the media server and reaches back as far as the server's own played list,
 * but playback_sessions — the transcode decisions, the clients, the addresses, everything
 * that makes the stream statistics worth having — starts empty on the day of installation.
 * Somebody moving over from Tautulli has years of exactly that, in a SQLite file.
 *
 * The file is read by path rather than uploaded: a Tautulli database on a server that has
 * been running for a few years is hundreds of megabytes, which is not a form submission.
 *
 * Read-only throughout, and it never writes back to Tautulli.
 *
 * ponytail: matches users by name and takes titles as Tautulli recorded them, rather than
 * re-resolving anything against the media server. A rename since then lands as its own
 * user; the alternative is asking the operator to map every account by hand.
 */

/** Tautulli reworks these tables between major versions, so nothing is assumed present. */
const REQUIRED_TABLES = ['session_history', 'session_history_metadata'];

export interface ImportSummary {
  /** Rows Tautulli holds for users this deployment knows. */
  candidates: number;
  /** Plays actually written; near-duplicates of existing history are not counted. */
  plays: number;
  /** Stream rows written into playback_sessions. */
  streams: number;
  /** Tautulli user names with no matching account on the chosen server. */
  unmatchedUsers: string[];
}

type Row = {
  id: number;
  started: number | null;
  stopped: number | null;
  user: string | null;
  rating_key: string | null;
  media_type: string | null;
  platform: string | null;
  player: string | null;
  ip_address: string | null;
  title: string | null;
  grandparent_title: string | null;
  year: number | null;
  genres: string | null;
  duration: number | null;
  transcode_decision: string | null;
  container: string | null;
  video_codec: string | null;
  audio_codec: string | null;
  height: number | null;
  bitrate: number | null;
  transcode_container: string | null;
  transcode_video_codec: string | null;
  transcode_audio_codec: string | null;
  transcode_height: number | null;
};

/**
 * Tautulli has stored genres as a semicolon list and, in other versions, as JSON. Both
 * shapes appear in databases people still run, so both are accepted.
 */
function parseGenres(value: string | null): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  }
  return trimmed
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Tautulli's media types line up with the app's except that it says 'episode' too. */
const mediaType = (value: string | null): string => (value ?? 'unknown').toLowerCase();

/**
 * Reads the file and writes what is missing. `dryRun` does everything except the writes,
 * which is what makes it safe to point at a database and find out what would happen.
 */
export async function importFromTautulli(
  path: string,
  serverId: number,
  options: { dryRun?: boolean; sinceMs?: number } = {},
): Promise<ImportSummary> {
  const Database = (await import('better-sqlite3')).default;
  // readonly plus fileMustExist: a typo in the path must fail loudly, not create an empty
  // database and report that it imported nothing.
  const source = new Database(path, { readonly: true, fileMustExist: true });

  try {
    const tables = new Set(
      source
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => (row as { name: string }).name),
    );
    for (const table of REQUIRED_TABLES) {
      if (!tables.has(table)) {
        throw new Error(`${path} does not look like a Tautulli database (no ${table} table)`);
      }
    }
    const hasMediaInfo = tables.has('session_history_media_info');

    // LEFT JOIN throughout: a history row whose metadata Tautulli lost is still a play,
    // and dropping it would quietly shrink the very numbers this import exists to restore.
    const rows = source
      .prepare(
        `SELECT h.id           AS id,
                h.started      AS started,
                h.stopped      AS stopped,
                h.user         AS user,
                h.rating_key   AS rating_key,
                h.media_type   AS media_type,
                h.platform     AS platform,
                h.player       AS player,
                h.ip_address   AS ip_address,
                m.title             AS title,
                m.grandparent_title AS grandparent_title,
                m.year              AS year,
                m.genres            AS genres,
                m.duration          AS duration
                ${
                  hasMediaInfo
                    ? `, i.transcode_decision   AS transcode_decision,
                       i.container             AS container,
                       i.video_codec           AS video_codec,
                       i.audio_codec           AS audio_codec,
                       i.height                AS height,
                       i.bitrate               AS bitrate,
                       i.transcode_container   AS transcode_container,
                       i.transcode_video_codec AS transcode_video_codec,
                       i.transcode_audio_codec AS transcode_audio_codec,
                       i.transcode_height      AS transcode_height`
                    : ''
                }
         FROM session_history h
         LEFT JOIN session_history_metadata m ON m.id = h.id
         ${hasMediaInfo ? 'LEFT JOIN session_history_media_info i ON i.id = h.id' : ''}
         WHERE h.started IS NOT NULL AND h.started >= ?
         ORDER BY h.started ASC`,
      )
      // Tautulli stores seconds, this app stores milliseconds — the one unit mismatch that
      // would otherwise put every imported play in 1970.
      .all(Math.floor((options.sinceMs ?? 0) / 1000)) as Row[];

    const accounts = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.serverId, serverId));
    const byName = new Map(accounts.map((row) => [row.username.toLowerCase(), row.id]));

    const unmatched = new Set<string>();
    const playsByUser = new Map<number, PlayInput[]>();
    const streams: (typeof playbackSessions.$inferInsert)[] = [];
    let candidates = 0;

    for (const row of rows) {
      const userId = row.user ? byName.get(row.user.toLowerCase()) : undefined;
      if (userId === undefined) {
        if (row.user) unmatched.add(row.user);
        continue;
      }
      if (!row.rating_key) continue;
      candidates += 1;

      const startedMs = (row.started ?? 0) * 1000;
      const stoppedMs = (row.stopped ?? row.started ?? 0) * 1000;
      // What was actually watched, the same figure a finished session contributes today.
      const watchedMs = Math.max(0, stoppedMs - startedMs);
      const title = row.title ?? 'Unknown';

      const plays = playsByUser.get(userId) ?? [];
      plays.push({
        itemId: row.rating_key,
        title,
        grandparentTitle: row.grandparent_title,
        mediaType: mediaType(row.media_type),
        year: row.year,
        genres: parseGenres(row.genres),
        watchedAt: new Date(startedMs),
        durationMs: watchedMs,
        deviceName: row.player,
      });
      playsByUser.set(userId, plays);

      if (!hasMediaInfo) continue;
      const transcoding = (row.transcode_decision ?? '').toLowerCase() === 'transcode';
      streams.push({
        // Prefixed like every other row in this table, and marked so an import can be told
        // apart from a stream this app watched itself.
        sessionKey: `${serverId}:tautulli-${row.id}`,
        userId,
        itemId: row.rating_key,
        title,
        grandparentTitle: row.grandparent_title,
        mediaType: mediaType(row.media_type),
        state: 'ended',
        progressMs: watchedMs,
        // Tautulli's metadata duration is the item's length in milliseconds; the session's
        // own watched time is the column above.
        durationMs: row.duration ?? watchedMs,
        clientName: row.platform,
        deviceName: row.player,
        playMethod: transcoding ? 'transcode' : 'directplay',
        videoCodec: (transcoding ? row.transcode_video_codec : row.video_codec) ?? null,
        audioCodec: (transcoding ? row.transcode_audio_codec : row.audio_codec) ?? null,
        container: (transcoding ? row.transcode_container : row.container) ?? null,
        height: (transcoding ? row.transcode_height : row.height) ?? null,
        bitrateKbps: row.bitrate ?? null,
        sourceVideoCodec: row.video_codec,
        sourceAudioCodec: row.audio_codec,
        sourceContainer: row.container,
        sourceHeight: row.height,
        sourceBitrateKbps: row.bitrate ?? null,
        remoteAddress: row.ip_address,
        isLocal: row.ip_address ? isPrivateAddress(row.ip_address) : null,
        startedAt: new Date(startedMs),
        lastSeenAt: new Date(stoppedMs),
        progressAt: new Date(stoppedMs),
      });
    }

    const summary: ImportSummary = {
      candidates,
      plays: 0,
      streams: 0,
      unmatchedUsers: [...unmatched].sort(),
    };
    if (options.dryRun) {
      // Reported as "would be written" rather than run through the duplicate check: that
      // check needs the rows in the table, and a preview must not put them there.
      summary.plays = [...playsByUser.values()].reduce((sum, list) => sum + list.length, 0);
      summary.streams = streams.length;
      return summary;
    }

    for (const [userId, plays] of playsByUser) {
      // Through the shared writer, so an import over a deployment that has already been
      // running does not duplicate everything the sync collected in the meantime.
      summary.plays += await recordPlays(userId, plays, 'tautulli');
    }

    // In batches: SQLite has a limit on bound variables per statement, and these rows are
    // thirty columns wide.
    for (let index = 0; index < streams.length; index += 200) {
      const batch = streams.slice(index, index + 200);
      await db.insert(playbackSessions).values(batch).onConflictDoNothing();
      summary.streams += batch.length;
    }
    return summary;
  } finally {
    source.close();
  }
}
