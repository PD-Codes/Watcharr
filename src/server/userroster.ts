import 'server-only';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '@/db';
import { authSessions, users } from '@/db/schema';
import { RECOVERY_SERVER_USER_ID } from './recoveryaccount';
import type { MediaServerAdapter, MediaServerUser } from './adapters/types';

/**
 * The adapter's user list and whether it may drive reconcileRoster(). A Plex list built while
 * plex.tv was unreachable only names people who have streamed; reading it as complete would
 * sign out every shared user who has not.
 */
export async function loadRoster(adapter: MediaServerAdapter): Promise<{ users: MediaServerUser[]; complete: boolean }> {
  if (adapter.listUsersWithCompleteness) return adapter.listUsersWithCompleteness();
  return { users: await adapter.listUsers(), complete: true };
}

export interface RosterPerson {
  serverUserId: string;
  username: string;
  email?: string | null;
  avatarUrl?: string | null;
  /** Set by a media server user list (adapter.listUsers()); absent for people seen in streams or imports. */
  isAdmin?: boolean;
}

/**
 * Creates a row for everybody the media server knows who has none yet, so streams and
 * history of people who never signed in here are attributed instead of showing "unknown".
 *
 * A person is the same if the id OR the name matches: Plex numbers its owner 1 in sessions
 * but by plex.tv id at sign-in, and two rows for one person would split their numbers.
 *
 * Existing rows keep their name, address and avatar — sign-in stays the source of truth for
 * those. Their admin flag and their sessions are reconciled against `people` when it is the
 * server's complete user list (see reconcileRoster). `fullRoster` says so explicitly; left
 * out, a list where every entry carries `isAdmin` counts as one, which is exactly what
 * adapter.listUsers() returns and what the lists built from streams or a Tautulli import
 * (no `isAdmin`) are not.
 */
export async function ensureUsers(
  serverId: number,
  people: RosterPerson[],
  options: { fullRoster?: boolean } = {},
): Promise<number> {
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
      // Known from a user list: set right away rather than "corrected" by the reconcile below.
      ...(typeof person.isAdmin === 'boolean' ? { isAdmin: person.isAdmin } : {}),
    });
  }
  if (fresh.length) await db.insert(users).values(fresh).onConflictDoNothing();

  const fullRoster = options.fullRoster ?? people.every((p) => typeof p.isAdmin === 'boolean');
  if (fullRoster) await reconcileRoster(serverId, people);
  return fresh.length;
}

export interface RosterChanges {
  /** Rows whose admin flag now follows the media server. */
  roleChanged: number;
  /** People with live sessions who are no longer in the list (share removed, account deleted). */
  removed: number;
  /** Sessions ended by either of the above. */
  sessionsRevoked: number;
}

/**
 * Brings existing rows in line with the media server's complete user list. Without it, a
 * demoted admin kept every admin page until they happened to sign in again (sign-in was the
 * only writer of `is_admin`), and somebody whose share was removed kept a working session
 * for up to 30 days.
 *
 * - `is_admin` follows the list for rows matched by id; a change ends that person's sessions,
 *   so the next request goes through a fresh sign-in with fresh rights.
 * - Somebody with live sessions who is in the list neither by id nor by name is signed out.
 * - A list that names no admin is skipped as a whole, roles included: every media server has
 *   one, so such a list is incomplete (Plex falling back to its local account table when
 *   plex.tv does not answer — that fallback has no owner), and acting on it would demote or
 *   sign out people for a gap in the list rather than a change on the server.
 * - Removals are held back when they would hit more than half of the people signed in (and
 *   more than two): a share that really ends affects a person or two, a list that silently
 *   lost most of its entries would sign everybody out at once. Logged instead, so a real mass
 *   removal is still visible and can be handled by hand.
 * - `global_admin` is never touched here — it is Watcharr's own role, and taking it away
 *   automatically could leave the deployment without one. A change is logged instead.
 * - The /adminlogin emergency account is no media server account and is left alone.
 *
 * Callers pass a list that was fetched successfully; an empty one does nothing.
 */
export async function reconcileRoster(serverId: number, people: RosterPerson[]): Promise<RosterChanges> {
  const changes: RosterChanges = { roleChanged: 0, removed: 0, sessionsRevoked: 0 };
  if (!people.length) return changes;
  const byId = new Map(people.filter((p) => p.serverUserId).map((p) => [p.serverUserId, p]));
  const names = new Set(people.map((p) => p.username?.trim().toLowerCase()).filter(Boolean));
  // No admin in the list: incomplete, see above. Nothing is changed, not even roles.
  if (!people.some((p) => p.isAdmin === true)) {
    console.warn(
      `[watcharr] the media server's user list for server ${serverId} names no admin; ` +
        'skipping the role and sign-out check until a complete list arrives',
    );
    return changes;
  }

  const rows = await db
    .select({
      id: users.id,
      serverUserId: users.serverUserId,
      username: users.username,
      isAdmin: users.isAdmin,
      globalAdmin: users.globalAdmin,
    })
    .from(users)
    .where(eq(users.serverId, serverId));
  const live = new Set(
    (
      await db
        .selectDistinct({ userId: authSessions.userId })
        .from(authSessions)
        .innerJoin(users, eq(users.id, authSessions.userId))
        .where(and(eq(users.serverId, serverId), gt(authSessions.expiresAt, new Date())))
    ).map((r) => r.userId),
  );

  const signOut = async (userId: number) =>
    (await db.delete(authSessions).where(eq(authSessions.userId, userId)).returning({ id: authSessions.id }))
      .length;

  const gone: typeof rows = [];
  for (const row of rows) {
    if (row.serverUserId === RECOVERY_SERVER_USER_ID) continue;
    const person = byId.get(row.serverUserId);

    if (person && typeof person.isAdmin === 'boolean' && person.isAdmin !== row.isAdmin) {
      await db.update(users).set({ isAdmin: person.isAdmin }).where(eq(users.id, row.id));
      changes.roleChanged += 1;
      const ended = await signOut(row.id);
      changes.sessionsRevoked += ended;
      console.log(
        `[watcharr] ${row.username} is ${person.isAdmin ? 'now' : 'no longer'} an admin on the media server` +
          (ended ? `; ${ended} session(s) signed out` : ''),
      );
      if (row.globalAdmin && !person.isAdmin) {
        console.warn(
          `[watcharr] ${row.username} keeps the Watcharr global admin role; revoke it under Users if that is intended`,
        );
      }
      continue;
    }

    if (!person && live.has(row.id) && !names.has(row.username.trim().toLowerCase())) gone.push(row);
  }

  // The emergency account is nobody the media server could list, so it does not count either way.
  const signedIn = rows.filter((row) => live.has(row.id) && row.serverUserId !== RECOVERY_SERVER_USER_ID).length;
  if (gone.length > 2 && gone.length > signedIn / 2) {
    console.warn(
      `[watcharr] the media server's user list for server ${serverId} no longer names ${gone.length} of ` +
        `${signedIn} signed-in people (${gone.map((row) => row.username).join(', ')}); ` +
        'nobody is signed out, as this looks like an incomplete list rather than removed shares',
    );
    return changes;
  }

  for (const row of gone) {
    const ended = await signOut(row.id);
    changes.removed += 1;
    changes.sessionsRevoked += ended;
    console.log(
      `[watcharr] ${row.username} is no longer in the media server's user list; ${ended} session(s) signed out`,
    );
    if (row.globalAdmin) {
      console.warn(
        `[watcharr] ${row.username} still holds the Watcharr global admin role; revoke it under Users if that is intended`,
      );
    }
  }
  return changes;
}
