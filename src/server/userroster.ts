import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { users } from '@/db/schema';

export interface RosterPerson {
  serverUserId: string;
  username: string;
  email?: string | null;
  avatarUrl?: string | null;
}

/**
 * Creates a row for everybody the media server knows who has none yet, so streams and
 * history of people who never signed in here are attributed instead of showing "unknown".
 *
 * A person is the same if the id OR the name matches: Plex numbers its owner 1 in sessions
 * but by plex.tv id at sign-in, and two rows for one person would split their numbers.
 * Existing rows are never touched — sign-in stays the source of truth for admin flags.
 */
export async function ensureUsers(serverId: number, people: RosterPerson[]): Promise<number> {
  if (!people.length) return 0;
  const known = await db
    .select({ serverUserId: users.serverUserId, username: users.username })
    .from(users)
    .where(eq(users.serverId, serverId));
  const ids = new Set(known.map((u) => u.serverUserId));
  const names = new Set(known.map((u) => u.username.trim().toLowerCase()));

  const fresh: (typeof users.$inferInsert)[] = [];
  for (const person of people) {
    const name = person.username?.trim();
    if (!person.serverUserId || !name || name.toLowerCase() === 'unknown') continue;
    if (ids.has(person.serverUserId) || names.has(name.toLowerCase())) continue;
    ids.add(person.serverUserId);
    names.add(name.toLowerCase());
    fresh.push({
      serverId,
      serverUserId: person.serverUserId,
      username: name,
      email: person.email ?? null,
      avatarUrl: person.avatarUrl ?? null,
    });
  }
  if (fresh.length) await db.insert(users).values(fresh).onConflictDoNothing();
  return fresh.length;
}
