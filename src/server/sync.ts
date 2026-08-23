import 'server-only';
import { and, desc, eq, gte, lt, ne, notInArray, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import { playbackSessions, users, watchHistory, watchlist } from '@/db/schema';
import { getAdapter, getConfig } from './config';
import { isEnabled } from './features';

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
export async function syncHistory(userId: number, serverUserId: string, token: string) {
  if (throttled(`history:${userId}`, 60_000)) return;

  const [latest] = await db
    .select({ watchedAt: watchHistory.watchedAt })
    .from(watchHistory)
    .where(eq(watchHistory.userId, userId))
    .orderBy(desc(watchHistory.watchedAt))
    .limit(1);

  const adapter = await getAdapter();
  const entries = await adapter.getHistory(token, serverUserId, latest?.watchedAt);
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

  const adapter = await getAdapter();
  const sessions = await adapter.getSessions();
  const known = await db.select({ id: users.id, serverUserId: users.serverUserId }).from(users);
  const byServerId = new Map(known.map((u) => [u.serverUserId, u.id]));
  const now = new Date();

  const existing = await db
    .select({ sessionKey: playbackSessions.sessionKey, progressMs: playbackSessions.progressMs })
    .from(playbackSessions)
    .where(ne(playbackSessions.state, 'ended'));
  const previousProgress = new Map(existing.map((row) => [row.sessionKey, row.progressMs]));

  const seen: string[] = [];

  for (const session of sessions) {
    // Drop sessions the server itself has not heard from in a while.
    if (session.lastCheckInAt && now.getTime() - session.lastCheckInAt.getTime() > CHECK_IN_MS) {
      continue;
    }
    seen.push(session.sessionKey);

    const moved = previousProgress.get(session.sessionKey) !== session.progressMs;
    const row = {
      sessionKey: session.sessionKey,
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
          lastSeenAt: now,
          ...(moved ? { progressAt: now } : {}),
        },
      });
  }

  // Anything not reported any more, or frozen for minutes, has stopped playing.
  await db
    .update(playbackSessions)
    .set({ state: 'ended' })
    .where(
      and(
        ne(playbackSessions.state, 'ended'),
        or(
          lt(playbackSessions.lastSeenAt, new Date(now.getTime() - LIVE_WINDOW_MS)),
          and(
            ne(playbackSessions.state, 'paused'),
            lt(playbackSessions.progressAt, new Date(now.getTime() - STALL_MS)),
          ),
          seen.length > 0
            ? notInArray(playbackSessions.sessionKey, seen)
            : sql`1 = 1`,
        ),
      ),
    );
}

/** Mirrors the server-side watchlist (Plex only) into the local watchlist. */
export async function syncWatchlist(userId: number, token: string) {
  const config = await getConfig();
  if (!isEnabled(config?.features ?? null, 'watchlistSync')) return;

  const adapter = await getAdapter();
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
