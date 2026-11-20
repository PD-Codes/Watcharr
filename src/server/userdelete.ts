import 'server-only';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import { loginHistory, playbackSessions, users } from '@/db/schema';

/** What a kept failed login of a deleted person is filed under instead of their name. */
export const DELETED_USERNAME = '[deleted]';

export interface DeletedUser {
  plays: number;
  streams: number;
}

/**
 * Removes a person and everything stored about them: history, watchlist, sessions, suggestions
 * and newsletter subscription go with the row (ON DELETE CASCADE); streams and successful
 * logins only lose their link on delete, so they are deleted here, otherwise they would linger
 * as "unknown". Failed logins are kept without the link (see below). One transaction: a half-deleted person would be worse than either state.
 * Notification and alert logs are text events and stay as they were sent.
 */
export function deleteUserWithData(userId: number): DeletedUser | null {
  return db.transaction((tx) => {
    const [row] = tx.select().from(users).where(eq(users.id, userId)).all();
    if (!row) return null;
    const [{ plays }] = tx.all<{ plays: number }>(sql`SELECT count(*) AS plays FROM watch_history WHERE user_id = ${userId}`);
    const streams = tx.delete(playbackSessions).where(eq(playbackSessions.userId, userId)).run().changes;
    // Successful sign-ins are this person's activity and go with them. Failed attempts stay,
    // unlinked: they are the record of somebody guessing at the account (the brute-force and
    // new-address alarms read them), and deleting the target would otherwise erase the trail
    // of an attack along with it.
    // The name goes too: the address and the time are the trail, the name would be what is
    // left of the person. Attempts that were never linked (a wrong password names the account
    // but signs nobody in) carry the same name on the same server and are treated alike.
    tx.delete(loginHistory).where(and(eq(loginHistory.userId, userId), eq(loginHistory.success, true))).run();
    tx.update(loginHistory)
      .set({ userId: null, username: DELETED_USERNAME })
      .where(
        and(
          eq(loginHistory.success, false),
          or(
            eq(loginHistory.userId, userId),
            and(
              isNull(loginHistory.userId),
              eq(loginHistory.serverId, row.serverId),
              sql`lower(${loginHistory.username}) = lower(${row.username})`,
            ),
          ),
        ),
      )
      .run();
    tx.delete(users).where(eq(users.id, userId)).run();
    return { plays: Number(plays), streams };
  });
}
