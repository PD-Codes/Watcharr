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
 * The file arrives by path or by the chunked upload in importupload.ts: a Tautulli database on
 * a server that has been running for a few years is hundreds of megabytes, which is not a
 * form submission. Either way it is read in keyset batches (see below), never as one array —
 * a few million history rows held at once is gigabytes of heap.
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
  /** The same people with how many history rows each — what the mapping step needs. */
  unmatched: { name: string; rows: number }[];
  /** Rows read so far, out of `total` — the source rows that pass the time filter. */
  scanned: number;
  total: number;
  /** Highest session_history id handled: the cursor a resumed import continues after. */
  lastId: number;
  /** True when `shouldStop` ended the run early; everything before `lastId` is written. */
  stopped: boolean;
}

/** What a run needs to continue where an interrupted one stopped. */
export interface ImportCheckpoint {
  lastId: number;
  scanned: number;
  candidates: number;
  plays: number;
  streams: number;
  unmatched: Record<string, number>;
}

export interface ImportOptions {
  dryRun?: boolean;
  sinceMs?: number;
  /**
   * Tautulli user name (any case) -> local user id, or null to leave that person out.
   * Wins over matching by name, which is how a renamed account gets its history back.
   */
  userMap?: Record<string, number | null>;
  /** Continue an interrupted run. The writers are idempotent, so overlap is harmless. */
  resume?: ImportCheckpoint;
  batchSize?: number;
  /** Called after every batch, with the numbers so far. Awaited, so a slow sink slows the import. */
  onProgress?: (summary: ImportSummary) => void | Promise<void>;
  /** Polled between batches; true ends the run cleanly. */
  shouldStop?: () => boolean;
}

type Row = {
  id: number;
  started: number | null;
  stopped: number | null;
  paused_counter: number | null;
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

// A thousand rows is ~11k bound variables in the history insert, safely under SQLite's
// 32766, and small enough that one batch is a few milliseconds of blocked event loop.
const BATCH_ROWS = 1000;

const SELECT_COLUMNS = (hasPaused: boolean, hasMediaInfo: boolean) => `
  h.id           AS id,
  h.started      AS started,
  h.stopped      AS stopped,
  ${hasPaused ? 'h.paused_counter' : 'NULL'} AS paused_counter,
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
  }`;

/**
 * Reads the file and writes what is missing. `dryRun` does everything except the writes,
 * which is what makes it safe to point at a database and find out what would happen.
 *
 * Memory stays flat: rows come out in id order, a thousand at a time (keyset paging, so the
 * cost of a batch does not grow with how far in it is), and each batch is written before the
 * next is read. That also makes the run resumable — `lastId` in the summary is all a second
 * run needs, and the duplicate checks in the writers make any overlap harmless.
 */
export async function importFromTautulli(
  path: string,
  serverId: number,
  options: ImportOptions = {},
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
    // Older Tautulli schemas lack paused_counter; select NULL there instead of failing.
    const hasPaused = source
      .prepare('PRAGMA table_info(session_history)')
      .all()
      .some((col) => (col as { name: string }).name === 'paused_counter');

    // Tautulli stores seconds, this app stores milliseconds — the one unit mismatch that
    // would otherwise put every imported play in 1970.
    const sinceSec = Math.floor((options.sinceMs ?? 0) / 1000);
    const { total } = source
      .prepare('SELECT count(*) AS total FROM session_history WHERE started IS NOT NULL AND started >= ?')
      .get(sinceSec) as { total: number };

    // LEFT JOIN throughout: a history row whose metadata Tautulli lost is still a play,
    // and dropping it would quietly shrink the very numbers this import exists to restore.
    const page = source.prepare(
      `SELECT ${SELECT_COLUMNS(hasPaused, hasMediaInfo)}
         FROM session_history h
         LEFT JOIN session_history_metadata m ON m.id = h.id
         ${hasMediaInfo ? 'LEFT JOIN session_history_media_info i ON i.id = h.id' : ''}
         WHERE h.id > ? AND h.started IS NOT NULL AND h.started >= ?
         ORDER BY h.id ASC
         LIMIT ?`,
    );

    const accounts = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.serverId, serverId));
    const byName = new Map(accounts.map((row) => [row.username.toLowerCase(), row.id]));
    const accountIds = new Set(accounts.map((row) => row.id));
    const map = new Map<string, number | null>();
    for (const [name, id] of Object.entries(options.userMap ?? {})) {
      // A mapping may only point at an account of the chosen server: the form is untrusted
      // input, and a play filed under somebody on another server is a leak, not a typo.
      if (id === null || accountIds.has(id)) map.set(name.toLowerCase(), id);
    }

    const resume = options.resume;
    const unmatched = new Map<string, number>(Object.entries(resume?.unmatched ?? {}));
    const summary: ImportSummary = {
      candidates: resume?.candidates ?? 0,
      plays: resume?.plays ?? 0,
      streams: resume?.streams ?? 0,
      unmatchedUsers: [],
      unmatched: [],
      scanned: resume?.scanned ?? 0,
      total,
      lastId: resume?.lastId ?? 0,
      stopped: false,
    };
    const refreshUnmatched = () => {
      summary.unmatched = [...unmatched]
        .map(([name, rows]) => ({ name, rows }))
        .sort((a, b) => b.rows - a.rows || a.name.localeCompare(b.name));
      summary.unmatchedUsers = summary.unmatched.map((u) => u.name).sort();
    };

    for (;;) {
      if (options.shouldStop?.()) {
        summary.stopped = true;
        break;
      }
      const rows = page.all(summary.lastId, sinceSec, options.batchSize ?? BATCH_ROWS) as Row[];
      if (!rows.length) break;

      const playsByUser = new Map<number, PlayInput[]>();
      const streams: (typeof playbackSessions.$inferInsert)[] = [];

      for (const row of rows) {
        const key = row.user?.toLowerCase();
        const userId = key === undefined ? undefined : map.has(key) ? map.get(key) : byName.get(key);
        // null is an explicit "leave this person out"; undefined is "nobody by that name".
        if (userId === null) continue;
        if (userId === undefined) {
          if (row.user) unmatched.set(row.user, (unmatched.get(row.user) ?? 0) + 1);
          continue;
        }
        if (!row.rating_key) continue;
        summary.candidates += 1;

        const startedMs = (row.started ?? 0) * 1000;
        // Tautulli writes stopped = 0 for a play it never closed; `??` would keep that 0 and
        // turn the row into a 1970 stream with no watch time, so fall back on any falsy value.
        const stoppedMs = (row.stopped || row.started || 0) * 1000;
        // What was actually watched, the same figure a finished session contributes today:
        // wall-clock span minus the time spent paused (paused_counter is seconds, like started).
        const watchedMs = Math.max(0, stoppedMs - startedMs - (row.paused_counter ?? 0) * 1000);
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

      if (options.dryRun) {
        // Reported as "would be written" rather than run through the duplicate check: that
        // check needs the rows in the table, and a preview must not put them there.
        for (const list of playsByUser.values()) summary.plays += list.length;
        summary.streams += streams.length;
      } else {
        for (const [userId, plays] of playsByUser) {
          // Through the shared writer, so an import over a deployment that has already been
          // running does not duplicate everything the sync collected in the meantime.
          summary.plays += await recordPlays(userId, plays, 'tautulli');
        }
        if (streams.length) {
          const result = await db.insert(playbackSessions).values(streams).onConflictDoNothing().run();
          summary.streams += result.changes;
        }
      }

      summary.lastId = rows[rows.length - 1].id;
      summary.scanned += rows.length;
      refreshUnmatched();
      await options.onProgress?.(summary);
      // Hands the event loop back between batches: pages and the sync tick keep being served
      // while a multi-million-row import grinds on.
      await new Promise((resolve) => setImmediate(resolve));
    }

    refreshUnmatched();
    return summary;
  } finally {
    source.close();
  }
}
