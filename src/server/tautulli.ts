import 'server-only';
import { and, eq, gte, lte } from 'drizzle-orm';
import { db } from '@/db';
import { loginHistory, playbackSessions, users } from '@/db/schema';
import { isPrivateAddress } from './net';
import { recordPlays, type PlayInput } from './plays';
import { ensureUsers } from './userroster';

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
 * What comes across: every play (music included), one stream row per play with both sides of
 * a transcode, the people behind them (accounts are created for anyone this deployment does not
 * know yet, so a deleted Plex friend's years are not dropped) and the login/IP history.
 * What does not: libraries, recently-added, notification logs and newsletters have no table
 * here — the media server is the source of truth for the first two, the rest is Tautulli's own
 * bookkeeping.
 *
 * People are matched by Tautulli's user_id first (that is the plex.tv id, which survives a
 * rename), then by any name Tautulli knows them under, then an explicit userMap entry wins over
 * both. Titles are taken as Tautulli recorded them rather than re-resolved against the media
 * server.
 */

/** Tautulli reworks these tables between major versions, so nothing is assumed present. */
const REQUIRED_TABLES = ['session_history', 'session_history_metadata'];

export interface ImportSummary {
  /** Rows Tautulli holds for people this run can file somewhere. */
  candidates: number;
  /** Plays actually written; near-duplicates of existing history are not counted. */
  plays: number;
  /** Stream rows written into playback_sessions. */
  streams: number;
  /** Accounts created for Tautulli users this deployment did not know (would-be, in a preview). */
  createdUsers: number;
  /** Login attempts written into login_history (would-be, in a preview). */
  logins: number;
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
  createdUsers?: number;
  logins?: number;
}

export interface ImportOptions {
  dryRun?: boolean;
  sinceMs?: number;
  /**
   * Tautulli user name (any case) -> local user id, or null to leave that person out.
   * Wins over matching, which is how a renamed account gets its history back.
   */
  userMap?: Record<string, number | null>;
  /**
   * Create an account for every Tautulli user nobody matches. Off by default for callers that
   * want unknown people reported instead; the import page turns it on.
   */
  createUsers?: boolean;
  /** Import user_login into login_history. On unless set to false. */
  logins?: boolean;
  /** Continue an interrupted run. The writers are idempotent, so overlap is harmless. */
  resume?: ImportCheckpoint;
  batchSize?: number;
  /** Called after every batch, with the numbers so far. Awaited, so a slow sink slows the import. */
  onProgress?: (summary: ImportSummary) => void | Promise<void>;
  /** Polled between batches; true ends the run cleanly. */
  shouldStop?: () => boolean;
}

type Cell = string | number | null | undefined;
type Row = Record<string, Cell> & { id: number };

/**
 * Tautulli has stored genres as a semicolon list and, in other versions, as JSON. Both
 * shapes appear in databases people still run, so both are accepted.
 */
function parseGenres(value: Cell): string[] {
  if (typeof value !== 'string' || !value) return [];
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
const mediaType = (value: Cell): string => (typeof value === 'string' ? value : 'unknown').toLowerCase();

/** First usable text: Tautulli writes '' where Plex reported nothing. */
const text = (...values: Cell[]): string | null => {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
};
/** First positive number: 0 means "not reported" for sizes and bitrates alike. */
const positive = (...values: Cell[]): number | null => {
  for (const v of values) {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return null;
};

// A thousand rows is ~14k bound variables in the stream insert, safely under SQLite's
// 32766, and small enough that one batch is a few milliseconds of blocked event loop.
const BATCH_ROWS = 1000;

type Columns = Map<string, Set<string>>;

/**
 * Every column the importer can use, per alias. Selected as NULL where the schema of this
 * Tautulli version lacks it: the tables have grown with every major release, and a missing
 * column must cost the field, not the import.
 */
const WANTED: Record<'h' | 'm' | 'i', string[]> = {
  h: [
    'started', 'stopped', 'paused_counter', 'user_id', 'user', 'rating_key', 'media_type',
    'product', 'platform', 'player', 'ip_address', 'location', 'bandwidth',
  ],
  m: ['title', 'grandparent_title', 'year', 'genres', 'duration'],
  i: [
    'transcode_decision', 'container', 'bitrate', 'width', 'height', 'video_codec', 'audio_codec',
    'audio_channels', 'subtitle_codec', 'transcode_container', 'transcode_video_codec',
    'transcode_audio_codec', 'transcode_height', 'transcode_width', 'transcode_audio_channels',
    'stream_container', 'stream_bitrate', 'stream_video_codec', 'stream_video_height',
    'stream_video_width', 'stream_audio_codec', 'stream_audio_channels', 'stream_subtitle_codec',
  ],
};
const TABLE_OF = { h: 'session_history', m: 'session_history_metadata', i: 'session_history_media_info' } as const;

function selectList(columns: Columns): string {
  const parts = ['h.id AS id'];
  for (const alias of ['h', 'm', 'i'] as const) {
    const have = columns.get(TABLE_OF[alias]) ?? new Set<string>();
    for (const name of WANTED[alias]) {
      // The alias prefix keeps h.user_id and m/i columns of the same name apart.
      parts.push(have.has(name) ? `${alias}.${name} AS ${name}` : `NULL AS ${name}`);
    }
  }
  return parts.join(', ');
}

/** One Tautulli account as the history knows it. Names differ: users get renamed. */
interface Person {
  key: string;
  userId: number | null;
  /** The name shown in the mapping step: the one most history rows carry. */
  display: string;
  names: Set<string>;
  /** Account fields from Tautulli's own users table, where it has the person. */
  username: string | null;
  email: string | null;
  avatar: string | null;
  rows: number;
}

const personKey = (userId: Cell, name: Cell): string | null =>
  typeof userId === 'number' ? `u${userId}` : typeof name === 'string' && name ? `n${name.toLowerCase()}` : null;

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
    const columns: Columns = new Map();
    for (const table of tables) {
      const cols = source.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
      columns.set(table, new Set(cols.map((c) => c.name)));
    }
    const hasMediaInfo = tables.has('session_history_media_info');
    const hasUserId = columns.get('session_history')?.has('user_id') ?? false;

    // Tautulli stores seconds, this app stores milliseconds — the one unit mismatch that
    // would otherwise put every imported play in 1970.
    const sinceSec = Math.floor((options.sinceMs ?? 0) / 1000);
    const { total } = source
      .prepare('SELECT count(*) AS total FROM session_history WHERE started IS NOT NULL AND started >= ?')
      .get(sinceSec) as { total: number };

    // LEFT JOIN throughout: a history row whose metadata Tautulli lost is still a play,
    // and dropping it would quietly shrink the very numbers this import exists to restore.
    const page = source.prepare(
      `SELECT ${selectList(columns)}
         FROM session_history h
         LEFT JOIN session_history_metadata m ON m.id = h.id
         ${hasMediaInfo ? 'LEFT JOIN session_history_media_info i ON i.id = h.id' : ''}
         WHERE h.id > ? AND h.started IS NOT NULL AND h.started >= ?
         ORDER BY h.id ASC
         LIMIT ?`,
    );

    // ---- who is who ------------------------------------------------------------------------
    const people = new Map<string, Person>();
    const accountInfo = new Map<number, { username: string | null; friendly: string | null; email: string | null; thumb: string | null }>();
    const uCols = columns.get('users');
    if (uCols?.has('user_id')) {
      const pick = (c: string) => (uCols.has(c) ? c : 'NULL');
      const rows = source
        .prepare(`SELECT user_id, ${pick('username')} AS username, ${pick('friendly_name')} AS friendly, ${pick('email')} AS email, ${pick('thumb')} AS thumb FROM users`)
        .all() as { user_id: number; username: string | null; friendly: string | null; email: string | null; thumb: string | null }[];
      for (const row of rows) accountInfo.set(row.user_id, row);
    }
    const top = new Map<string, number>();
    const groups = source
      .prepare(
        `SELECT ${hasUserId ? 'user_id' : 'NULL'} AS user_id, user, count(*) AS rows
           FROM session_history WHERE started IS NOT NULL AND started >= ? GROUP BY 1, 2`,
      )
      .all(sinceSec) as { user_id: number | null; user: string | null; rows: number }[];
    for (const g of groups) {
      const key = personKey(g.user_id, g.user);
      if (!key) continue;
      const info = typeof g.user_id === 'number' ? accountInfo.get(g.user_id) : undefined;
      let person = people.get(key);
      if (!person) {
        person = {
          key,
          userId: g.user_id,
          display: g.user ?? info?.username ?? 'unknown',
          names: new Set(),
          username: text(info?.username),
          email: text(info?.email),
          avatar: text(info?.thumb)?.startsWith('http') ? text(info?.thumb) : null,
          rows: 0,
        };
        for (const n of [info?.username, info?.friendly]) if (text(n)) person.names.add(text(n)!.toLowerCase());
        people.set(key, person);
      }
      person.rows += g.rows;
      if (g.user) {
        person.names.add(g.user.toLowerCase());
        if (g.rows > (top.get(key) ?? 0)) {
          top.set(key, g.rows);
          person.display = g.user;
        }
      }
    }

    const loadAccounts = () =>
      db
        .select({ id: users.id, username: users.username, serverUserId: users.serverUserId })
        .from(users)
        .where(eq(users.serverId, serverId));
    let accounts = await loadAccounts();
    let byName = new Map(accounts.map((row) => [row.username.toLowerCase(), row.id]));
    let byServerUserId = new Map(accounts.map((row) => [row.serverUserId, row.id]));
    const accountIds = new Set(accounts.map((row) => row.id));
    const map = new Map<string, number | null>();
    for (const [name, id] of Object.entries(options.userMap ?? {})) {
      // A mapping may only point at an account of the chosen server: the form is untrusted
      // input, and a play filed under somebody on another server is a leak, not a typo.
      if (id === null || accountIds.has(id)) map.set(name.toLowerCase(), id);
    }

    /** null = leave out, undefined = nobody. Mapping first, then the plex.tv id, then any name. */
    const resolve = (person: Person): number | null | undefined => {
      for (const name of person.names) if (map.has(name)) return map.get(name);
      if (map.has(person.display.toLowerCase())) return map.get(person.display.toLowerCase());
      if (person.userId !== null) {
        const hit = byServerUserId.get(String(person.userId));
        if (hit !== undefined) return hit;
      }
      for (const name of person.names) {
        const hit = byName.get(name);
        if (hit !== undefined) return hit;
      }
      return byName.get(person.display.toLowerCase());
    };
    const targets = new Map<string, number | null | undefined>();
    for (const person of people.values()) targets.set(person.key, resolve(person));

    const resume = options.resume;
    let createdUsers = resume?.createdUsers ?? 0;
    if (options.createUsers) {
      const missing = [...people.values()].filter((p) => targets.get(p.key) === undefined);
      if (options.dryRun) {
        // Negative ids stand for accounts that a real run would create: enough to count their
        // rows, and never written anywhere.
        missing.forEach((p, n) => targets.set(p.key, -(n + 1)));
        createdUsers += missing.length;
      } else if (missing.length) {
        await ensureUsers(
          serverId,
          missing.map((p) => ({
            // Tautulli's user_id is the plex.tv id, which is what a later sign-in reports, so
            // the person lands on this row instead of a twin. Without the column the lowercase
            // name is all there is; ensureUsers then matches by name when the roster arrives.
            serverUserId: p.userId !== null ? String(p.userId) : p.display.toLowerCase(),
            username: p.username ?? p.display,
            email: p.email,
            avatarUrl: p.avatar,
          })),
        );
        accounts = await loadAccounts();
        byName = new Map(accounts.map((row) => [row.username.toLowerCase(), row.id]));
        byServerUserId = new Map(accounts.map((row) => [row.serverUserId, row.id]));
        for (const person of missing) {
          const id = resolve(person);
          targets.set(person.key, id);
          if (id !== undefined && id !== null) createdUsers += 1;
        }
      }
    }

    const unmatched = new Map<string, number>(Object.entries(resume?.unmatched ?? {}));
    const summary: ImportSummary = {
      candidates: resume?.candidates ?? 0,
      plays: resume?.plays ?? 0,
      streams: resume?.streams ?? 0,
      createdUsers,
      logins: resume?.logins ?? 0,
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
        const key = personKey(row.user_id, row.user);
        const userId = key === null ? undefined : targets.get(key);
        // null is an explicit "leave this person out"; undefined is "nobody by that name".
        if (userId === null) continue;
        if (userId === undefined || userId < 0) {
          if (typeof row.user === 'string' && row.user) unmatched.set(row.user, (unmatched.get(row.user) ?? 0) + 1);
          // A preview carries on for would-be accounts so their rows are counted.
          if (userId === undefined) continue;
        }
        if (row.rating_key === null || row.rating_key === '') continue;
        const itemId = String(row.rating_key);
        summary.candidates += 1;

        const startedMs = (Number(row.started) || 0) * 1000;
        // Tautulli writes stopped = 0 for a play it never closed; `??` would keep that 0 and
        // turn the row into a 1970 stream with no watch time, so fall back on any falsy value.
        const stoppedMs = (Number(row.stopped) || Number(row.started) || 0) * 1000;
        // What was actually watched, the same figure a finished session contributes today:
        // wall-clock span minus the time spent paused (paused_counter is seconds, like started).
        const watchedMs = Math.max(0, stoppedMs - startedMs - (Number(row.paused_counter) || 0) * 1000);
        const title = text(row.title) ?? 'Unknown';
        const grandparent = text(row.grandparent_title);
        const type = mediaType(row.media_type);

        const plays = playsByUser.get(userId) ?? [];
        plays.push({
          itemId,
          title,
          grandparentTitle: grandparent,
          mediaType: type,
          year: positive(row.year),
          genres: parseGenres(row.genres),
          watchedAt: new Date(startedMs),
          durationMs: watchedMs,
          deviceName: text(row.player),
        });
        playsByUser.set(userId, plays);

        // 'direct play' / 'copy' (direct stream) / 'transcode'. The stream_* columns say what
        // was actually delivered and exist from Tautulli 2.x on; before that, the transcode_*
        // columns are the delivered side of a transcode and the plain ones the file.
        const decision = (text(row.transcode_decision) ?? '').toLowerCase();
        const transcoding = decision === 'transcode';
        const location = (text(row.location) ?? '').toLowerCase();
        const address = text(row.ip_address);
        streams.push({
          // Prefixed like every other row in this table, and marked so an import can be told
          // apart from a stream this app watched itself.
          sessionKey: `${serverId}:tautulli-${row.id}`,
          userId,
          itemId,
          title,
          grandparentTitle: grandparent,
          mediaType: type,
          state: 'ended',
          progressMs: watchedMs,
          // Tautulli's metadata duration is the item's length in milliseconds; the session's
          // own watched time is the column above.
          durationMs: positive(row.duration) ?? watchedMs,
          // The app, then the device — the same split the live Plex sessions use.
          clientName: text(row.product, row.platform),
          deviceName: text(row.player),
          playMethod: transcoding ? 'transcode' : decision === 'copy' ? 'directstream' : 'directplay',
          videoCodec: text(row.stream_video_codec, transcoding ? row.transcode_video_codec : null, row.video_codec),
          audioCodec: text(row.stream_audio_codec, transcoding ? row.transcode_audio_codec : null, row.audio_codec),
          container: text(row.stream_container, transcoding ? row.transcode_container : null, row.container),
          width: positive(row.stream_video_width, transcoding ? row.transcode_width : null),
          height: positive(row.stream_video_height, transcoding ? row.transcode_height : null, row.height),
          audioChannels: positive(row.stream_audio_channels, transcoding ? row.transcode_audio_channels : null, row.audio_channels),
          subtitleCodec: text(row.stream_subtitle_codec, row.subtitle_codec),
          bitrateKbps: positive(row.bandwidth, row.stream_bitrate, row.bitrate),
          sourceVideoCodec: text(row.video_codec),
          sourceAudioCodec: text(row.audio_codec),
          sourceContainer: text(row.container),
          sourceHeight: positive(row.height),
          sourceBitrateKbps: positive(row.bitrate),
          remoteAddress: address,
          // Plex's own verdict beats guessing from the address, which a proxy makes wrong.
          isLocal: location === 'lan' ? true : location === 'wan' ? false : address ? isPrivateAddress(address) : null,
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

    if (!summary.stopped && options.logins !== false && tables.has('user_login')) {
      await importLogins({ source, columns, serverId, sinceSec, options, summary, targets, people, accountInfo, resolve, byName, byServerUserId, map });
    }

    refreshUnmatched();
    return summary;
  } finally {
    source.close();
  }
}

interface LoginContext {
  source: import('better-sqlite3').Database;
  columns: Columns;
  serverId: number;
  sinceSec: number;
  options: ImportOptions;
  summary: ImportSummary;
  targets: Map<string, number | null | undefined>;
  people: Map<string, Person>;
  accountInfo: Map<number, { username: string | null; friendly: string | null }>;
  resolve: (person: Person) => number | null | undefined;
  byName: Map<string, number>;
  byServerUserId: Map<string, number>;
  map: Map<string, number | null>;
}

/**
 * Tautulli's user_login becomes login_history, which is what the security page and the
 * new-address alert read. Same shape of loop as the history: keyset by id, a thousand at a
 * time. There is no unique key on login_history, so idempotence comes from looking up what
 * already sits in the time range of the batch — ids follow time, so the range stays narrow
 * and a resumed or repeated import adds nothing.
 */
async function importLogins(ctx: LoginContext): Promise<void> {
  const { source, columns, serverId, sinceSec, options, summary } = ctx;
  const have = columns.get('user_login') ?? new Set<string>();
  if (!have.has('id') || !have.has('timestamp')) return;
  const pick = (c: string) => (have.has(c) ? c : 'NULL');
  const page = source.prepare(
    `SELECT id, timestamp, ${pick('user_id')} AS user_id, ${pick('user')} AS user,
            ${pick('ip_address')} AS ip, ${pick('user_agent')} AS agent, ${pick('success')} AS success
       FROM user_login WHERE id > ? AND timestamp >= ? ORDER BY id ASC LIMIT ?`,
  );
  let lastId = 0;
  for (;;) {
    if (options.shouldStop?.()) {
      summary.stopped = true;
      return;
    }
    const rows = page.all(lastId, sinceSec, options.batchSize ?? BATCH_ROWS) as {
      id: number; timestamp: number; user_id: number | null; user: string | null;
      ip: string | null; agent: string | null; success: number | null;
    }[];
    if (!rows.length) return;
    lastId = rows[rows.length - 1].id;

    const fresh: (typeof loginHistory.$inferInsert)[] = [];
    for (const row of rows) {
      const name = text(row.user) ?? 'unknown';
      const key = personKey(row.user_id, row.user);
      let target = key === null ? undefined : ctx.targets.get(key);
      if (target === undefined && key !== null) {
        // Somebody who logged in but never played in range: file the login under their
        // account if they have one, otherwise keep it by name alone. Never creates anyone.
        const info = typeof row.user_id === 'number' ? ctx.accountInfo.get(row.user_id) : undefined;
        const names = [name, info?.username, info?.friendly].filter((n): n is string => !!text(n)).map((n) => n.toLowerCase());
        const person: Person = { key, userId: row.user_id, display: name, names: new Set(names), username: null, email: null, avatar: null, rows: 0 };
        target = ctx.resolve(person);
        ctx.targets.set(key, target);
      }
      if (target === null) continue; // explicitly left out
      const ip = text(row.ip);
      fresh.push({
        serverId,
        userId: target !== undefined && target > 0 ? target : null,
        username: name,
        success: row.success === null ? true : Boolean(row.success),
        ip,
        userAgent: text(row.agent),
        createdAt: new Date(row.timestamp * 1000),
      });
    }
    if (fresh.length) {
      const times = fresh.map((r) => r.createdAt!.getTime());
      // reduce, not Math.min(...times): see recordPlays about spreading big arrays.
      const lo = times.reduce((a, b) => Math.min(a, b));
      const hi = times.reduce((a, b) => Math.max(a, b));
      const existing = await db
        .select({ username: loginHistory.username, at: loginHistory.createdAt, ip: loginHistory.ip })
        .from(loginHistory)
        .where(and(eq(loginHistory.serverId, serverId), gte(loginHistory.createdAt, new Date(lo)), lte(loginHistory.createdAt, new Date(hi))));
      const seen = new Set(existing.map((r) => `${r.username.toLowerCase()}|${r.at.getTime()}|${r.ip ?? ''}`));
      const toWrite = fresh.filter((r) => {
        const id = `${r.username.toLowerCase()}|${r.createdAt!.getTime()}|${r.ip ?? ''}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      if (toWrite.length) {
        if (!options.dryRun) await db.insert(loginHistory).values(toWrite);
        summary.logins += toWrite.length;
      }
    }
    await options.onProgress?.(summary);
    await new Promise((resolve) => setImmediate(resolve));
  }
}
