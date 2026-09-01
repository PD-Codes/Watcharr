import 'server-only';
import { and, desc, eq, gte, like, lt, ne, notInArray, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import { appConfig, playbackSessions, users, watchHistory, watchlist } from '@/db/schema';
import { createAdapter, type ServerType } from './adapters';
import { isUnauthorized } from './adapters/http';
import { getAdapter, getSettings, listServers, type ServerRow } from './config';
import { isEnabled } from './features';
import { isPrivateAddress } from './net';
import { checkAutoBackup } from './autobackup';
import { checkDigest } from './digest';
import { checkThresholds } from './monitor';
import { checkNewsletter } from './newsletter';
import { checkRetention } from './retention';
import { recordPlays, type PlayInput } from './plays';
import { cachedSectionName, getLibrary, resolveSectionKey, warmLibraryCache } from './library';
import { prefetchTitleMeta } from './tmdb';
import { revokeSession, type Session } from './session';
import { notify } from './notifications';

/**
 * A sync failure must never take a page down with it — but swallowing it whole means the
 * only trace left is a line in the media server's own log, which is a terrible place to
 * have to go looking. Repeats are collapsed so one broken token cannot fill the log.
 */
const reported = new Map<string, number>();

export function reportSyncError(what: string) {
  return (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const key = `${what}:${message}`;
    if (Date.now() - (reported.get(key) ?? 0) < 5 * 60_000) return;
    reported.set(key, Date.now());
    // A 401 is the one failure with an obvious fix, and the raw line does not say so: the
    // stored media server token was revoked or expired. The session carrying it has just
    // been dropped, so the hint says what already happened rather than asking for it.
    const hint = isUnauthorized(error)
      ? ' — the media server rejected the stored token; the session was signed out and the next sign-in replaces it'
      : '';
    console.warn(`[watcharr] ${what} failed: ${message}${hint}`);
  };
}

// ponytail: in-process throttle instead of a job scheduler. One app container is the
// documented deployment; move to a queue if the app is ever scaled out.
const lastRun = new Map<string, number>();

function throttled(key: string, everyMs: number): boolean {
  const previous = lastRun.get(key) ?? 0;
  if (Date.now() - previous < everyMs) return true;
  lastRun.set(key, Date.now());
  return false;
}

/** Pulls new history entries for one user. Duplicates are dropped by the unique index. */
export async function syncHistory(session: Session) {
  const user = session.user;
  const userId = user.id;
  if (throttled(`history:${userId}`, 60_000)) return;

  const [latest] = await db
    .select({ watchedAt: watchHistory.watchedAt })
    .from(watchHistory)
    .where(eq(watchHistory.userId, userId))
    .orderBy(desc(watchHistory.watchedAt))
    .limit(1);

  const adapter = await getAdapter(user.serverId);
  const entries = await adapter
    .getHistory(session.serverToken, user.serverUserId, latest?.watchedAt)
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

  // Through recordPlays() rather than a direct insert: sessions that finished here write
  // to the same table, and the unique index cannot tell two views of one play apart.
  await recordPlays(userId, entries, 'server');
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
export async function syncActivity(force = false) {
  // The live socket calls this the moment a server reports a change, which is the one
  // caller allowed past the poll interval — otherwise the socket would only ever shorten
  // the wait to whatever is left of the five seconds.
  if (!force && throttled('activity', 5_000)) return;
  for (const server of await listServers()) {
    // A server that just failed is skipped for a while. The sync runs in the app layout,
    // so without this every page load would pay the connection timeout again.
    if ((downUntil.get(server.id) ?? 0) > Date.now()) continue;

    // Cheap enough to sit in the same loop, but on its own, much slower clock.
    if (!throttled(`added:${server.id}`, 10 * 60_000)) {
      // Before the recently-added check, so a new arrival can already be matched to its
      // library. Warmed here rather than left to the poster prefetch, which only runs with
      // a TMDB key — the library filter must not depend on an unrelated setting.
      await warmLibraryCache(server.id).catch(reportSyncError(`library cache for ${server.label}`));
      await syncRecentlyAdded(server).catch(reportSyncError(`recently added on ${server.label}`));
    }
    // One unreachable server must not stop the others from being polled.
    await syncServerActivity(server).catch(() => {
      downUntil.set(server.id, Date.now() + DOWN_BACKOFF_MS);
      // ponytail: reachability is remembered in process memory, so a restart can repeat a
      // server.down notification. A column would survive restarts; not worth one yet.
      if (reachable.get(server.id) !== false) {
        reachable.set(server.id, false);
        notify('server.down', { server: { id: server.id, label: server.label, slug: server.slug } });
      }
    });
  }
  // Artwork for the poster grids is filled here rather than while a page renders: a grid
  // of two dozen tiles would otherwise fire two dozen TMDB searches on its first view.
  if (!throttled('tmdb', 10 * 60_000)) {
    await prefetchArtwork().catch(reportSyncError('TMDB prefetch'));
  }
  await checkThresholds().catch(reportSyncError('threshold check'));
  await checkDigest().catch(reportSyncError('digest'));
  await checkNewsletter().catch(reportSyncError('newsletter'));
  await checkAutoBackup().catch(reportSyncError('automatic backup'));
  await checkRetention().catch(reportSyncError('retention'));
}

/**
 * Looks up a batch of library titles TMDB has not been asked about yet. Only the library
 * is used as the source: history titles already get looked up when their detail page is
 * opened, while a never-started film has no other occasion to be fetched — and that is
 * exactly the grid that looks emptiest without a poster.
 */
async function prefetchArtwork() {
  const { tmdbApiKey } = await getSettings();
  if (!tmdbApiKey) return;

  for (const server of await listServers()) {
    const items = await getLibrary(server.id).catch(() => []);
    if (items.length) await prefetchTitleMeta(tmdbApiKey, items);
  }
}

/** Last known reachability per server, so server.down fires on the edge, not every poll. */
const reachable = new Map<number, boolean>();

const DOWN_BACKOFF_MS = 60_000;
const downUntil = new Map<number, number>();

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

  const newest = items[0].itemId;
  if (newest === server.lastAddedItemId) return;

  if (server.lastAddedItemId) {
    const marker = items.findIndex((item) => item.itemId === server.lastAddedItemId);
    // Marker gone from the window means more arrived than fit; report what is visible.
    const fresh = marker === -1 ? items : items.slice(0, marker);
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
    .set({ lastAddedItemId: newest })
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

async function syncServerActivity(server: ServerRow) {
  const adapter = createAdapter(
    server.serverType as ServerType,
    server.serverUrl,
    server.serverToken,
  );
  const sessions = await adapter.getSessions();
  reachable.set(server.id, true);
  downUntil.delete(server.id);
  const known = await db
    .select({ id: users.id, serverUserId: users.serverUserId })
    .from(users)
    .where(eq(users.serverId, server.id));
  const byServerId = new Map(known.map((u) => [u.serverUserId, u.id]));
  const now = new Date();

  const ownRows = like(playbackSessions.sessionKey, `${server.id}:%`);
  const existing = await db
    .select({ sessionKey: playbackSessions.sessionKey, progressMs: playbackSessions.progressMs })
    .from(playbackSessions)
    .where(and(ne(playbackSessions.state, 'ended'), ownRows));
  const previousProgress = new Map(existing.map((row) => [row.sessionKey, row.progressMs]));

  const seen: string[] = [];

  for (const session of sessions) {
    // Drop sessions the server itself has not heard from in a while.
    if (session.lastCheckInAt && now.getTime() - session.lastCheckInAt.getTime() > CHECK_IN_MS) {
      continue;
    }
    const rowKey = sessionRowKey(server.id, session.sessionKey);
    seen.push(rowKey);
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
      userId: byServerId.get(session.serverUserId) ?? null,
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
    .select({
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
    })
    .from(playbackSessions)
    .leftJoin(users, eq(users.id, playbackSessions.userId))
    .where(stopped);

  await db.update(playbackSessions).set({ state: 'ended' }).where(stopped);

  await recordFinishedPlays(ending);

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

  for (const [userId, plays] of byUser) {
    await recordPlays(userId, plays, 'session').catch(reportSyncError('recording a finished play'));
  }
}

/** Mirrors the server-side watchlist (Plex only) into the local watchlist. */
export async function syncWatchlist(session: Session) {
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
