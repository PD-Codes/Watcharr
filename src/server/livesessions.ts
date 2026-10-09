import 'server-only';
import { and, eq, like } from 'drizzle-orm';
import { db } from '@/db';
import { playbackSessions, users } from '@/db/schema';
import { liveSessionFilter } from './sync';

export type LiveSession = typeof playbackSessions.$inferSelect & { username: string | null };

/**
 * Streams running right now, with who started them. One query for every page that shows
 * live playback in detail (the dashboard hero, the cinema screen), so the visibility rule
 * lives in one place:
 *
 *  - `userId` set: only that person's streams.
 *  - otherwise a global admin sees every server, anyone else their own server's streams
 *    (session keys carry the server id, which is how one server's streams are kept from
 *    another server's admins).
 */
export async function getLiveSessions(options: {
  userId?: number;
  serverId: number;
  globalAdmin: boolean;
}): Promise<LiveSession[]> {
  const scope =
    options.userId !== undefined
      ? eq(playbackSessions.userId, options.userId)
      : options.globalAdmin
        ? undefined
        : like(playbackSessions.sessionKey, `${options.serverId}:%`);

  const rows = await db
    .select({ session: playbackSessions, username: users.username })
    .from(playbackSessions)
    .leftJoin(users, eq(users.id, playbackSessions.userId))
    .where(and(liveSessionFilter(), scope));

  return rows.map((row) => ({ ...row.session, username: row.username }));
}
