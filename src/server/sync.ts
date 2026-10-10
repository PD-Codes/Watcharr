import 'server-only';
import { and, eq, gte, inArray, like, lt, ne, notInArray, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import { appConfig, playbackSessions, users, watchHistory, watchlist } from '@/db/schema';
import { createAdapter, type ServerType } from './adapters';
import { isUnauthorized } from './adapters/http';
import { getAdapter, getServer, getSettings, listServers, type ServerRow } from './config';
import { isEnabled } from './features';
import { isPrivateAddress } from './net';
import { checkAutoBackup } from './autobackup';
import { checkDigest } from './digest';
import { checkThresholds } from './monitor';
import { checkNewsletter } from './newsletter';
import { checkRetention } from './retention';
import { lastServerPlayAt, recordPlays, type PlayInput } from './plays';
import { cachedLibrary, cachedSectionName, getLibrary, resolveSectionKey, warmLibraryCache } from './library';
import { artworkCoverage, prefetchTitleMeta } from './tmdb';
import { revokeSession, type Session } from './session';
import { notify } from './notifications';
import { ensureUsers } from './userroster';
import { globalState } from './state';
import { singleFlight, timed } from './jobs';
import { isStrained } from './strain';

/** TMDB is throttled like a media server when it answers 429. */
const TMDB_URL = 'https://api.themoviedb.org';
/** How often a strained server is still asked what is playing. */
const STRAINED_POLL_MS = 30_000;

// Shared across Next's module graphs (see state.ts): the throttles and the failed-server memory
// below used to exist once for the background tick and once for page renders, and one server
// going down was announced once per graph.
interface SyncState {
  reported: Map<string, number>;
  lastRun: Map<string, number>;
  reachable: Map<number, boolean>;
  downUntil: Map<number, number>;
  artwork?: { at: number; value: { cached: number; total: number } | null };
}
const state = globalState<SyncState>('sync', () => ({
  reported: new Map(),
  lastRun: new Map(),
  reachable: new Map(),
  downUntil: new Map(),
}));

/**
 * A sync failure must never take a page down with it — but swallowing it whole means the
 * only trace left is a line in the media server's own log, which is a terrible place to
 * have to go looking. Repeats are collapsed so one broken token cannot fill the log.
 */
const reported = state.reported;

export function reportSyncError(what: string) {
  return (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const key = `${what}:${message}`;
    if (Date.now() - (reported.get(key) ?? 0) < 5 * 60_000) return;
    reported.set(key, Date.now());
    // A 401 is the one failure with an obvious fix, and the raw line does not say so: the
    // stored media server token was revoked or expired. The session carrying it has just
    // been dropped, so the hint says what already happened rather than asking for it.
    const code = (error as { code?: unknown } | null)?.code;
    const hint = isUnauthorized(error)
      ? ' — the media server rejected the stored token; the session was signed out and the next sign-in replaces it'
      : typeof (error as { status?: unknown } | null)?.status === 'number' && /database is locked/i.test(message)
        ? // An HTTP answer, so it came from the media server: its database, not ours.
          ' — the media server\'s own database is locked (not Watcharr\'s); requests to it are paused for a few minutes'
        : typeof code === 'string' && code.startsWith('SQLITE_BUSY')
        ? // This process has one writing connection, so a lock it cannot get is held by someone else.
          ' — Watcharr\'s own database is locked by another process: a second Watcharr container or instance on the same ' +
          'data folder, or a network share (see the system check; WATCHARR_DB_LOCKING=exclusive)'
        : '';
    console.warn(`[watcharr] ${what} failed: ${message}${hint}`);
  };
}

// ponytail: in-process throttle instead of a job scheduler. One app container is the
// documented deployment; move to a queue if the app is ever scaled out.
const lastRun = state.lastRun;

function throttled(key: string, everyMs: number): boolean {
  const previous = lastRun.get(key) ?? 0;
  if (Date.now() - previous < everyMs) return true;
  lastRun.set(key, Date.now());
  return false;
}

/**
 * Starts a sync from a page without waiting for it: the page renders what is already stored,
 * and whatever the sync brings in shows on the next reload (most pages refresh themselves).
 *
 * Pages used to await the whole thing. The activity sync in the layout carries the ten-minute
 * jobs (the full media-server library, up to 25 sequential TMDB lookups, the automatic backup,
 * retention), and whoever opened a page at that moment waited for all of it — on a slow or busy
 * Plex half a minute. The background tick (instrumentation.ts) does the same work anyway, and
 * singleFlight() makes a page's call join a run in flight rather than start a second one.
 */
export function runInBackground(task: Promise<unknown>, what: string): void {
  void task.catch(reportSyncError(what));
}

/** Pulls new history entries for one user. Duplicates are dropped by the unique index. */
export async function syncHistory(session: Session) {
  if (session.preview) return; // an admin's preview never pulls on the viewed user's behalf
  const user = session.user;
  const userId = user.id;
  const server = await getServer(user.serverId);
  // While the server is paused for load the history waits; the throttle is not consumed, so
  // the first page after the pause pulls it.
  if (!server || isStrained(server.serverUrl)) return;
  if (throttled(`history:${userId}`, 60_000)) return;
  return singleFlight(`history:${userId}`, () => timed(`history sync for ${user.username}`, () => pullHistory(session)));
}

async function pullHistory(session: Session) {
  const user = session.user;
  const userId = user.id;

  const adapter = await getAdapter(user.serverId);
  const entries = await adapter
    .getHistory(session.serverToken, user.serverUserId, await lastServerPlayAt(userId), user.username)
    .catch(async (error: unknown) => {
      // A 401 for a user token is not transient: the media server dropped it (a restart,
      // a password change, a purged device) and it will never work again. The token lives
      // in this auth session, so the session is what has to go — the next request lands on
      // the sign-in page and comes back with a fresh one. Deleting the row rather than
      // remembering the failure in memory is what makes the recovery survive a restart of
      // either side; the alternative was a log line repeating every minute forever.
      if (isUnauthorized(error)) await revokeSession(session.id).catch(() => {});
      throw error;
    });
  if (!entries.length) return;

  // Plays older than the history retention would only be deleted again at the next prune:
  // once a user's last kept play is gone, the media server hands back its whole recent list,
  // and without this every prune was followed by the same plays coming back.
  const { retentionHistoryDays } = await getSettings();
  const keepFrom = retentionHistoryDays ? Date.now() - retentionHistoryDays * 86_400_000 : 0;
  const kept = keepFrom ? entries.filter((entry) => entry.watchedAt.getTime() >= keepFrom) : entries;
  if (!kept.length) return;

  // Through recordPlays() rather than a direct insert: sessions that finished here write
  // to the same table, and the unique index cannot tell two views of one play apart.
  await recordPlays(userId, kept, 'server');
}

/**
 * Liveness rules. A media server keeps reporting a session long after the client is gone,
 * which is why presence in the API is not enough — the playback position has to be moving,
 * or the session has to be explicitly paused.
 */
export const LIVE_WINDOW_MS = 45_000; // must have been seen in the last poll or two
const STALL_MS = 4 * 60_000; // position frozen this long means the client left
const CHECK_IN_MS = 3 * 60_000; // server reported check-in older than this is stale
// A pause is allowed to stand still, but not forever: a browser tab left open on a paused
// title keeps the session in the server's list for days, and it showed up as "now playing"
// with a start time from last week. Beyond this the pause is treated as abandoned.
const PAUSE_STALL_MS = 2 * 60 * 60_000;

export function liveSessionFilter() {
  const now = Date.now();
  return and(
    ne(playbackSessions.state, 'ended'),
    gte(playbackSessions.lastSeenAt, new Date(now - LIVE_WINDOW_MS)),
    // Paused sessions legitimately stand still, playing ones must not.
    or(
      and(
        eq(playbackSessions.state, 'paused'),
        gte(playbackSessions.progressAt, new Date(now - PAUSE_STALL_MS)),
      ),
      gte(playbackSessions.progressAt, new Date(now - STALL_MS)),
    ),
  );
}

/**
 * Records what the server is currently playing. Rows are kept after playback ends so the
 * client, codec and transcoding statistics have something to aggregate over.
 */
export function syncActivity(force = false): Promise<void> {
  // The live socket calls this the moment a server reports a change, which is the one
  // caller allowed past the poll interval — otherwise the socket would only ever shorten
  // the wait to whatever is left of the five seconds.
  if (!force && throttled('activity', 5_000)) return Promise.resolve();
  // Ticks, socket frames and page renders all land here; while one pass runs, the others
  // join it instead of asking the media server the same questions a second time.
  return singleFlight('activity', () => timed('activity sync', runActivity));
}

async function runActivity() {
  for (const server of await listServers()) {
    // A server that just failed is skipped for a while. The sync runs in the app layout,
    // so without this every page load would pay the connection timeout again.
    if ((downUntil.get(server.id) ?? 0) > Date.now()) continue;
    // Overloaded (Plex's own "database is locked", 5xx, timeouts): what is playing is asked
    // twice a minute instead of every five seconds.
    const strained = isStrained(server.serverUrl);
    if (strained && throttled(`strained-poll:${server.id}`, STRAINED_POLL_MS)) continue;
    // One unreachable server must not stop the others from being polled.
    await syncServerActivity(server).catch((error: unknown) => {
      downUntil.set(server.id, Date.now() + DOWN_BACKOFF_MS);
      // ponytail: reachability is remembered in process memory, so a restart can repeat a
      // server.down notification. A column would survive restarts; not worth one yet.
      if (reachable.get(server.id) !== false) {
        reachable.set(server.id, false);
        console.warn(
          `[watcharr] ${server.label} is not reachable (${error instanceof Error ? error.message : String(error)}); retrying every minute`,
        );
        notify('server.down', { server: { id: server.id, label: server.label, slug: server.slug } });
      }
    });
  }
  await checkThresholds().catch(reportSyncError('threshold check'));
  // Everything slow runs beside the live poll, not inside it: the library listing, TMDB (25
  // lookups in a row), backup, retention and the newsletter used to sit in this pass, so a
  // socket frame that arrived meanwhile joined a pass that had read the sessions long before,
  // and a new stream waited for the next tick — or for the backup to finish.
  runInBackground(singleFlight('housekeeping', () => timed('housekeeping', housekeeping)), 'housekeeping');
}

async function housekeeping() {
  for (const server of await listServers()) {
    if ((downUntil.get(server.id) ?? 0) > Date.now() || isStrained(server.serverUrl)) continue;
    // Not consumed while strained or down, so it runs as soon as the server is back.
    if (!throttled(`added:${server.id}`, 10 * 60_000)) {
      // Before the recently-added check, so a new arrival can already be matched to its
      // library. Warmed here rather than left to the poster prefetch, which only runs with
      // a TMDB key — the library filter must not depend on an unrelated setting.
      await warmLibraryCache(server.id).catch(reportSyncError(`library cache for ${server.label}`));
      await syncRecentlyAdded(server).catch(reportSyncError(`recently added on ${server.label}`));
    }
    // The roster rarely changes; every few hours is plenty, and the first pass fills a fresh
    // install. Streams add anybody missed in between (see syncServerActivity).
    if (!throttled(`roster:${server.id}`, 6 * 3_600_000)) {
      await syncRoster(server).catch(reportSyncError(`user list of ${server.label}`));
    }
  }
  // Artwork for the poster grids is filled here rather than while a page renders: a grid
  // of two dozen tiles would otherwise fire two dozen TMDB searches on its first view.
  if (!isStrained(TMDB_URL) && !throttled('tmdb', 10 * 60_000)) {
    const looked = await prefetchArtwork().catch((e: unknown) => (reportSyncError('TMDB prefetch')(e), 0));
    // While there is a backlog (a fresh install has the whole library to fetch), come back in
    // a minute instead of ten: 25 titles per ten minutes would take a day for a large library.
    if (looked > 0) lastRun.set('tmdb', Date.now() - 9 * 60_000);
  }
  // The planner's statistics follow the tables as they grow. Without them it plans for a small
  // database: one title page went from 5 ms to 450 ms on a million plays. Cheap when current.
  if (!throttled('optimize', 6 * 3_600_000)) {
    try {
      db.run(sql`PRAGMA optimize(0x10002)`);
    } catch (e: unknown) {
      reportSyncError('database optimize')(e);
    }
  }
  await checkDigest().catch(reportSyncError('digest'));
  await checkNewsletter().catch(reportSyncError('newsletter'));
  await checkAutoBackup().catch(reportSyncError('automatic backup'));
  await checkRetention().catch(reportSyncError('retention'));
}

/** Pulls the media server's user list and creates the accounts that are missing. */
async function syncRoster(server: ServerRow) {
  const adapter = createAdapter(server.serverType as ServerType, server.serverUrl, server.serverToken);
  await ensureUsers(server.id, await adapter.listUsers());
}

/**
 * Looks up a batch of library titles TMDB has not been asked about yet (or whose answer has
 * expired; the caches page runs it with a bigger `limit`). Only the library
 * is used as the source: history titles already get looked up when their detail page is
 * opened, while a never-started film has no other occasion to be fetched — and that is
 * exactly the grid that looks emptiest without a poster.
 */
export async function prefetchArtwork(limit?: number): Promise<number> {
  const { tmdbApiKey } = await getSettings();
  if (!tmdbApiKey) return 0;

  let done = 0;
  for (const server of await listServers()) {
    const items = await getLibrary(server.id).catch(() => []);
    if (items.length) {
      done += await prefetchTitleMeta(tmdbApiKey, items, limit === undefined ? undefined : limit - done);
    }
    if (limit !== undefined && done >= limit) break;
  }
  return done;
}

/** Library titles with a TMDB answer vs. all of them, or null when nothing is being fetched. */
export async function artworkProgress(): Promise<{ cached: number; total: number } | null> {
  if (!(await getSettings()).tmdbApiKey) return null;
  const memo = state.artwork;
  if (memo && Date.now() - memo.at < 10_000) return memo.value;
  const items = (await listServers()).flatMap((s) => cachedLibrary(s.id) ?? []);
  const value = items.length ? await artworkCoverage(items) : null;
  state.artwork = { at: Date.now(), value };
  return value;
}

/** Last known reachability per server, so server.down fires on the edge, not every poll. */
const reachable = state.reachable;

const DOWN_BACKOFF_MS = 60_000;
const downUntil = state.downUntil;

const RECENT_WINDOW = 20;

/**
 * Notifies about new arrivals. The marker is the newest item id from the previous check:
 * the feed is ordered newest first, so everything above it is new. On the very first run
 * the marker is only recorded — otherwise every existing title would fire an event.
 */
async function syncRecentlyAdded(server: ServerRow) {
  const adapter = createAdapter(
    server.serverType as ServerType,
    server.serverUrl,
    server.serverToken,
  );
  const items = await adapter.getRecentlyAdded(RECENT_WINDOW);
  if (!items.length) return;

  // The marker is "<item id>@<added at ms>"; older installs stored the bare id.
  const [markerId, markerAt] = (server.lastAddedItemId ?? '').split('@');
  const newest = items[0].itemId;
  if (newest === markerId) return;

  if (markerId) {
    const marker = items.findIndex((item) => item.itemId === markerId);
    // Marker gone from the window: either more arrived than fit, or the marker item itself was
    // deleted. With its time known only what was added after it is new — otherwise deleting the
    // newest title announced the whole window again.
    const since = Number(markerAt);
    const fresh =
      marker !== -1
        ? items.slice(0, marker)
        : since
          ? items.filter((item) => (item.addedAt?.getTime() ?? 0) > since)
          : items;
    for (const item of fresh) {
      notify('media.added', {
        server: { id: server.id, label: server.label, slug: server.slug },
        title: item.title,
        itemId: item.itemId,
        mediaType: item.mediaType,
        year: item.year,
        // A title added in the last few minutes may not be in the cached listing yet, so
        // this is the one event where the library is genuinely often unknown. It resolves
        // on the next refresh; until then a library condition simply does not apply.
        ...libraryOf(server.id, item),
      });
    }
  }

  await db
    .update(appConfig)
    .set({ lastAddedItemId: items[0].addedAt ? `${newest}@${items[0].addedAt.getTime()}` : newest })
    .where(eq(appConfig.id, server.id));
}

/**
 * Session keys are prefixed with the server id. Two Plex servers can hand out the same
 * native key — it is derived from a per-server rating key — and playback_sessions is keyed
 * by it, so without the prefix two people's streams would collapse into one row.
 */
export const sessionRowKey = (serverId: number, sessionKey: string) => `${serverId}:${sessionKey}`;

/**
 * Which library an event belongs to, for the notification conditions.
 *
 * Read straight out of the in-memory library listing — no request, which is the whole
 * reason this is possible at all. Both fields are absent rather than guessed when the
 * cache cannot answer; a condition on an absent library does not filter.
 */
function libraryOf(
  serverId: number,
  item: { itemId?: string; title?: string; grandparentTitle?: string | null },
): { sectionKey?: string; library?: string } {
  const key = resolveSectionKey(serverId, item);
  if (!key) return {};
  return { sectionKey: key, library: cachedSectionName(key) ?? undefined };
}

export async function syncServerActivity(server: ServerRow) {
  const adapter = createAdapter(
    server.serverType as ServerType,
    server.serverUrl,
    server.serverToken,
  );
  const sessions = await adapter.getSessions();
  if (reachable.get(server.id) === false) console.log(`[watcharr] ${server.label} is reachable again`);
  reachable.set(server.id, true);
  downUntil.delete(server.id);
  // Somebody streaming who never signed in here still gets an account row, or the stream
  // would be listed under "unknown" and missing from their own pages.
  await ensureUsers(
    server.id,
    sessions.map((s) => ({ serverUserId: s.serverUserId, username: s.username })),
  );
  const known = await db
    .select({ id: users.id, serverUserId: users.serverUserId, username: users.username })
    .from(users)
    .where(eq(users.serverId, server.id));
  const byServerId = new Map(known.map((u) => [u.serverUserId, u.id]));
  // Plex reports the owner under a local id (1) that never matches the plex.tv id they signed
  // in with, so a stream would stay unattributed and vanish from "my sessions". The name is
  // the fallback; ids stay authoritative.
  const byName = new Map(known.map((u) => [u.username.trim().toLowerCase(), u.id]));
  const now = new Date();

  const ownRows = like(playbackSessions.sessionKey, `${server.id}:%`);
  const existing = await db
    .select({ ...endingFields, progressMs: playbackSessions.progressMs })
    .from(playbackSessions)
    .leftJoin(users, eq(users.id, playbackSessions.userId))
    .where(and(ne(playbackSessions.state, 'ended'), ownRows));
  const previousProgress = new Map(existing.map((row) => [row.sessionKey, row.progressMs]));
  const openRows = new Map(existing.map((row) => [row.sessionKey, row]));

  // Rows this app already closed that the server still lists with the same item at the same
  // position: a client that vanished, or a pause nobody came back to. Treating them as new
  // reopened the stale stream every few minutes with a fresh start time and another
  // playback.start / playback.stop pair. They come back as soon as the position moves.
  const reportedKeys = sessions.map((session) => sessionRowKey(server.id, session.sessionKey));
  const closed = new Map(
    (reportedKeys.length
      ? await db
          .select({
            sessionKey: playbackSessions.sessionKey,
            itemId: playbackSessions.itemId,
            progressMs: playbackSessions.progressMs,
          })
          .from(playbackSessions)
          .where(and(eq(playbackSessions.state, 'ended'), inArray(playbackSessions.sessionKey, reportedKeys)))
      : []
    ).map((row) => [row.sessionKey, row] as const),
  );

  const seen: string[] = [];

  for (const session of sessions) {
    // Drop sessions the server itself has not heard from in a while.
    if (session.lastCheckInAt && now.getTime() - session.lastCheckInAt.getTime() > CHECK_IN_MS) {
      continue;
    }
    const rowKey = sessionRowKey(server.id, session.sessionKey);
    const before = closed.get(rowKey);
    if (before && before.itemId === session.itemId && before.progressMs === session.progressMs) continue;
    seen.push(rowKey);

    // The same key now reports another item: Jellyfin/Emby key a session by device, so
    // autoplay moves a TV from episode 1 to 2 under one key. Episode 1 ends here, properly
    // (history row, playback.stop), and keeps its own row; episode 2 starts a new one.
    const open = openRows.get(rowKey);
    if (open && open.itemId !== session.itemId) {
      if (!(await finishRows(server, [open]))) continue; // retried next pass; nothing overwritten
      archiveRow(rowKey, true);
      previousProgress.delete(rowKey);
    } else if (!open && before) {
      // An ended row under this key (the same item watched again, or the same device a day
      // later) is history: it moves aside instead of being overwritten by the new play.
      archiveRow(rowKey, false);
    }

    if (!previousProgress.has(rowKey)) {
      notify('playback.start', {
        server: { id: server.id, label: server.label, slug: server.slug },
        user: session.username,
        title: session.grandparentTitle
          ? `${session.grandparentTitle} — ${session.title}`
          : session.title,
        itemId: session.itemId,
        mediaType: session.mediaType,
        client: session.clientName,
        device: session.deviceName,
        transcoding: session.isTranscoding,
        ...libraryOf(server.id, session),
      });
    }

    const moved = previousProgress.get(rowKey) !== session.progressMs;
    const row = {
      sessionKey: rowKey,
      userId: byServerId.get(session.serverUserId) ?? byName.get(session.username.trim().toLowerCase()) ?? null,
      itemId: session.itemId,
      title: session.title,
      grandparentTitle: session.grandparentTitle,
      mediaType: session.mediaType,
      state: session.state,
      progressMs: session.progressMs,
      durationMs: session.durationMs,
      clientName: session.clientName,
      deviceName: session.deviceName,
      playMethod: session.playMethod,
      videoCodec: session.videoCodec,
      audioCodec: session.audioCodec,
      container: session.container,
      width: session.width,
      height: session.height,
      bitrateKbps: session.bandwidthKbps,
      transcodeReason: session.transcodeReason,
      audioChannels: session.audioChannels,
      subtitleCodec: session.subtitleCodec,
      sourceVideoCodec: session.sourceVideoCodec,
      sourceAudioCodec: session.sourceAudioCodec,
      sourceContainer: session.sourceContainer,
      sourceHeight: session.sourceHeight,
      sourceBitrateKbps: session.sourceBitrateKbps,
      remoteAddress: session.remoteAddress ?? null,
      isLocal: session.remoteAddress ? isPrivateAddress(session.remoteAddress) : null,
      startedAt: now,
      lastSeenAt: now,
      progressAt: now,
    };

    await db
      .insert(playbackSessions)
      .values(row)
      .onConflictDoUpdate({
        target: playbackSessions.sessionKey,
        // startedAt only moves when this row was not already an open session: the key is
        // stable per item and user, so watching the same episode again reuses the ended
        // row — without the reset, Now Playing would report a start time days old.
        // progressAt only moves when the position actually changed.
        set: {
          itemId: row.itemId,
          title: row.title,
          grandparentTitle: row.grandparentTitle,
          mediaType: row.mediaType,
          state: row.state,
          progressMs: row.progressMs,
          durationMs: row.durationMs,
          clientName: row.clientName,
          deviceName: row.deviceName,
          playMethod: row.playMethod,
          videoCodec: row.videoCodec,
          audioCodec: row.audioCodec,
          container: row.container,
          width: row.width,
          height: row.height,
          bitrateKbps: row.bitrateKbps,
          transcodeReason: row.transcodeReason,
          audioChannels: row.audioChannels,
          subtitleCodec: row.subtitleCodec,
          sourceVideoCodec: row.sourceVideoCodec,
          sourceAudioCodec: row.sourceAudioCodec,
          sourceContainer: row.sourceContainer,
          sourceHeight: row.sourceHeight,
          sourceBitrateKbps: row.sourceBitrateKbps,
          remoteAddress: row.remoteAddress,
          isLocal: row.isLocal,
          // An open row created before the person had an account gets claimed on the next pass.
          ...(row.userId !== null ? { userId: row.userId } : {}),
          lastSeenAt: now,
          ...(previousProgress.has(rowKey) ? {} : { startedAt: now, progressAt: now }),
          ...(moved ? { progressAt: now } : {}),
        },
      });
  }

  // Anything not reported any more, or frozen for minutes, has stopped playing. Scoped to
  // this server: an unreachable one keeps its rows instead of having them all ended.
  const stopped = and(
    ne(playbackSessions.state, 'ended'),
    ownRows,
    or(
      lt(playbackSessions.lastSeenAt, new Date(now.getTime() - LIVE_WINDOW_MS)),
      and(
        ne(playbackSessions.state, 'paused'),
        lt(playbackSessions.progressAt, new Date(now.getTime() - STALL_MS)),
      ),
      // A pause the client never came back from. Without this the row stays open forever.
      lt(playbackSessions.progressAt, new Date(now.getTime() - PAUSE_STALL_MS)),
      seen.length > 0 ? notInArray(playbackSessions.sessionKey, seen) : sql`1 = 1`,
    ),
  );

  // Read the rows before ending them: afterwards there is no way to tell which ones this
  // pass closed and which had been ended for days.
  const ending = await db
    .select(endingFields)
    .from(playbackSessions)
    .leftJoin(users, eq(users.id, playbackSessions.userId))
    .where(stopped);

  // History first, then "ended": the other way round, a failed write (full disk, a locked
  // file) lost the play for good, since the next pass no longer sees the row as open.
  if (await finishRows(server, ending)) {
    await db.update(playbackSessions).set({ state: 'ended' }).where(stopped);
  }
}

const endingFields = {
  sessionKey: playbackSessions.sessionKey,
  title: playbackSessions.title,
  grandparentTitle: playbackSessions.grandparentTitle,
  itemId: playbackSessions.itemId,
  mediaType: playbackSessions.mediaType,
  progressMs: playbackSessions.progressMs,
  durationMs: playbackSessions.durationMs,
  startedAt: playbackSessions.startedAt,
  deviceName: playbackSessions.deviceName,
  userId: playbackSessions.userId,
  username: users.username,
};

/** Writes finished streams to the history and announces them; false when the write failed. */
async function finishRows(
  server: ServerRow,
  ending: (Parameters<typeof recordFinishedPlays>[0][number] & { username: string | null; sessionKey: string })[],
): Promise<boolean> {
  try {
    await recordFinishedPlays(ending);
  } catch (error) {
    reportSyncError('recording a finished play')(error);
    return false;
  }
  for (const row of ending) {
    notify('playback.stop', {
      server: { id: server.id, label: server.label, slug: server.slug },
      user: row.username,
      title: row.grandparentTitle ? `${row.grandparentTitle} — ${row.title}` : row.title,
      itemId: row.itemId,
      mediaType: row.mediaType,
      progressMs: row.progressMs,
      durationMs: row.durationMs,
      percent: row.durationMs > 0 ? Math.round((row.progressMs / row.durationMs) * 100) : null,
      ...libraryOf(server.id, row),
    });
  }
  return true;
}

/**
 * Moves a stream row off its live key (`1:abc` → `1:abc#<rowid>`, unique by construction and
 * still under the server prefix), so the key is free for the next play and the old row stays
 * for the statistics. `end` also closes it, for a row that was still open.
 */
function archiveRow(sessionKey: string, end: boolean) {
  db.run(sql`
    UPDATE playback_sessions
    SET session_key = session_key || '#' || rowid${end ? sql`, state = 'ended'` : sql``}
    WHERE session_key = ${sessionKey}
  `);
}

/**
 * Writes a finished stream into the history.
 *
 * Two datasets described the same viewing and never met: watch_history came from the media
 * server and carries no progress, no device and no address, while playback_sessions knows
 * all three but only starts at installation. Every aggregate had to pick one. A session
 * that ran past the watched threshold is a play by any definition, so it becomes a history
 * row too — and the two grow together instead of apart.
 *
 * Genres are left empty on purpose: a session does not carry them. recordPlays() fills
 * them in when the media server's own played list catches up with the same play.
 */
async function recordFinishedPlays(
  ending: {
    itemId: string;
    title: string;
    grandparentTitle: string | null;
    mediaType: string;
    progressMs: number;
    durationMs: number;
    startedAt: Date;
    deviceName: string | null;
    userId: number | null;
  }[],
) {
  if (!ending.length) return;
  const { watchedThreshold } = await getSettings();

  const byUser = new Map<number, PlayInput[]>();
  for (const row of ending) {
    // No user means the stream belonged to an account this app has never seen sign in;
    // there is nobody to file the play under.
    if (row.userId === null || row.durationMs <= 0) continue;
    if ((row.progressMs / row.durationMs) * 100 < watchedThreshold) continue;
    const list = byUser.get(row.userId) ?? [];
    list.push({
      itemId: row.itemId,
      title: row.title,
      grandparentTitle: row.grandparentTitle,
      mediaType: row.mediaType,
      // What was actually watched, not what the file is long — the whole reason a session
      // is worth more than the server's played flag.
      watchedAt: row.startedAt,
      durationMs: row.progressMs,
      deviceName: row.deviceName,
    });
    byUser.set(row.userId, list);
  }

  // Throws on failure: the caller keeps the rows open and the next pass tries again; the
  // near-duplicate check in recordPlays makes a repeat harmless.
  for (const [userId, plays] of byUser) {
    await recordPlays(userId, plays, 'session');
  }
}

/** Mirrors the server-side watchlist (Plex only) into the local watchlist. */
export function syncWatchlist(session: Session): Promise<void> {
  return singleFlight(`watchlist:${session.user.id}`, () => pullWatchlist(session));
}

async function pullWatchlist(session: Session) {
  if (session.preview) return;
  const user = session.user;
  const userId = user.id;
  const settings = await getSettings();
  if (!isEnabled(settings.features, 'watchlistSync')) return;

  const adapter = await getAdapter(user.serverId);
  if (!adapter.getWatchlist) return;
  if (throttled(`watchlist:${userId}`, 300_000)) return;

  // Same dead-token rule as syncHistory: the session holding it is the thing to drop.
  const entries = await adapter.getWatchlist(session.serverToken).catch(async (error: unknown) => {
    if (isUnauthorized(error)) await revokeSession(session.id).catch(() => {});
    return [];
  });
  if (!entries.length) return;

  await db
    .insert(watchlist)
    .values(
      entries.map((e) => ({
        userId,
        itemId: e.itemId,
        title: e.title,
        mediaType: e.mediaType,
        year: e.year,
        posterUrl: e.posterUrl,
        source: 'plex' as const,
      })),
    )
    .onConflictDoNothing();
}

/** Marks watchlist rows as done once a matching history entry exists. */
export async function reconcileWatchlistStatus(userId: number) {
  await db
    .update(watchlist)
    .set({ status: 'done' })
    .where(
      and(
        eq(watchlist.userId, userId),
        eq(watchlist.status, 'planned'),
        sql`EXISTS (SELECT 1 FROM ${watchHistory} h WHERE h.user_id = ${userId} AND h.item_id = ${watchlist.itemId})`,
      ),
    );
}
