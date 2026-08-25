import 'server-only';
import { and, desc, eq, gte, like, lt, ne, notInArray, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import { appConfig, playbackSessions, users, watchHistory, watchlist } from '@/db/schema';
import { createAdapter, type ServerType } from './adapters';
import { getAdapter, getSettings, listServers, type ServerRow } from './config';
import { isEnabled } from './features';
import { isPrivateAddress } from './net';
import { checkAutoBackup } from './autobackup';
import { checkDigest } from './digest';
import { checkThresholds } from './monitor';
import { checkNewsletter } from './newsletter';
import type { SessionUser } from './session';
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
    console.warn(`[watcharr] ${what} failed: ${message}`);
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
export async function syncHistory(user: SessionUser, token: string) {
  const userId = user.id;
  if (throttled(`history:${userId}`, 60_000)) return;

  const [latest] = await db
    .select({ watchedAt: watchHistory.watchedAt })
    .from(watchHistory)
    .where(eq(watchHistory.userId, userId))
    .orderBy(desc(watchHistory.watchedAt))
    .limit(1);

  const adapter = await getAdapter(user.serverId);
  const entries = await adapter.getHistory(token, user.serverUserId, latest?.watchedAt);
  if (!entries.length) return;

  await db
    .insert(watchHistory)
    .values(
      entries.map((e) => ({
        userId,
        itemId: e.itemId,
        title: e.title,
        grandparentTitle: e.grandparentTitle,
        mediaType: e.mediaType,
        year: e.year,
        genres: e.genres,
        watchedAt: e.watchedAt,
        durationMs: e.durationMs,
        deviceName: e.deviceName,
      })),
    )
    .onConflictDoNothing();
}

/**
 * Liveness rules. A media server keeps reporting a session long after the client is gone,
 * which is why presence in the API is not enough — the playback position has to be moving,
 * or the session has to be explicitly paused.
 */
export const LIVE_WINDOW_MS = 45_000; // must have been seen in the last poll or two
const STALL_MS = 4 * 60_000; // position frozen this long means the client left
const CHECK_IN_MS = 3 * 60_000; // server reported check-in older than this is stale

export function liveSessionFilter() {
  const now = Date.now();
  return and(
    ne(playbackSessions.state, 'ended'),
    gte(playbackSessions.lastSeenAt, new Date(now - LIVE_WINDOW_MS)),
    // Paused sessions legitimately stand still, playing ones must not.
    or(
      eq(playbackSessions.state, 'paused'),
      gte(playbackSessions.progressAt, new Date(now - STALL_MS)),
    ),
  );
}

/**
 * Records what the server is currently playing. Rows are kept after playback ends so the
 * client, codec and transcoding statistics have something to aggregate over.
 */
export async function syncActivity() {
  if (throttled('activity', 5_000)) return;
  for (const server of await listServers()) {
    // A server that just failed is skipped for a while. The sync runs in the app layout,
    // so without this every page load would pay the connection timeout again.
    if ((downUntil.get(server.id) ?? 0) > Date.now()) continue;

    // Cheap enough to sit in the same loop, but on its own, much slower clock.
    if (!throttled(`added:${server.id}`, 10 * 60_000)) {
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
  await checkThresholds().catch(reportSyncError('threshold check'));
  await checkDigest().catch(reportSyncError('digest'));
  await checkNewsletter().catch(reportSyncError('newsletter'));
  await checkAutoBackup().catch(reportSyncError('automatic backup'));
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
        // startedAt is deliberately not updated, so the original start time survives.
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
          remoteAddress: row.remoteAddress,
          isLocal: row.isLocal,
          lastSeenAt: now,
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
      username: users.username,
    })
    .from(playbackSessions)
    .leftJoin(users, eq(users.id, playbackSessions.userId))
    .where(stopped);

  await db.update(playbackSessions).set({ state: 'ended' }).where(stopped);

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
    });
  }
}

/** Mirrors the server-side watchlist (Plex only) into the local watchlist. */
export async function syncWatchlist(user: SessionUser, token: string) {
  const userId = user.id;
  const settings = await getSettings();
  if (!isEnabled(settings.features, 'watchlistSync')) return;

  const adapter = await getAdapter(user.serverId);
  if (!adapter.getWatchlist) return;
  if (throttled(`watchlist:${userId}`, 300_000)) return;

  const entries = await adapter.getWatchlist(token).catch(() => []);
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
