import 'server-only';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { loginHistory, playbackSessions, users } from '@/db/schema';

export interface DeletedUser {
  plays: number;
  streams: number;
}

/**
 * Removes a person and everything stored about them: history, watchlist, sessions, suggestions
 * and newsletter subscription go with the row (ON DELETE CASCADE); streams and logins only
 * lose their link on delete, so they are deleted here, otherwise they would linger as
 * "unknown". One transaction: a half-deleted person would be worse than either state.
 * Notification and alert logs are text events and stay as they were sent.
 */
export function deleteUserWithData(userId: number): DeletedUser | null {
  return db.transaction((tx) => {
    const [row] = tx.select().from(users).where(eq(users.id, userId)).all();
    if (!row) return null;
    const [{ plays }] = tx.all<{ plays: number }>(sql`SELECT count(*) AS plays FROM watch_history WHERE user_id = ${userId}`);
    const streams = tx.delete(playbackSessions).where(eq(playbackSessions.userId, userId)).run().changes;
    tx.delete(loginHistory).where(eq(loginHistory.userId, userId)).run();
    // Failed attempts with this name were never linked to the account.
    tx.delete(loginHistory)
      .where(and(isNull(loginHistory.userId), eq(loginHistory.serverId, row.serverId), eq(loginHistory.username, row.username)))
      .run();
    tx.delete(users).where(eq(users.id, userId)).run();
    return { plays: Number(plays), streams };
  });
}
