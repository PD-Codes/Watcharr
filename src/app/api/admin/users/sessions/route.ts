import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '@/db';
import { authSessions, users } from '@/db/schema';
import { readBody } from '@/server/body';
import { canSee, getSession, revokeSession, upgradeLegacySessionIds } from '@/server/session';
import { apiError, badBody, unauthorized } from '@/server/apierror';

export const dynamic = 'force-dynamic';

/**
 * Revokes one session: an admin's "sign this device out" button, and the same control on
 * a user's own profile page. Signing yourself out of your own session needs no admin role
 * — it is the one case where the target is unambiguously yours.
 */
export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session) return unauthorized();

  const body = await readBody(request, { id: 'string' });
  if (!body) return badBody();
  const id = body.id;
  if (!id) return apiError(400, 'id-required', 'err.idRequired');

  // `id` is a handle (sha256 of a cookie id). Rows from before hashing are rewritten first,
  // so a raw cookie id can never be used here to find, or sign out, anybody's session.
  await upgradeLegacySessionIds();

  const [row] = await db
    .select({ user: users })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(eq(authSessions.id, id));
  if (!row) return apiError(404, 'unknown-session', 'err.unknownSession');

  const own = row.user.id === session.user.id;
  // A server admin does not sign a global admin out, the same line delete and view-as draw.
  const outranked = row.user.globalAdmin && !session.user.globalAdmin;
  const allowed =
    own || (!outranked && (session.user.isAdmin || session.user.globalAdmin) && canSee(session.user, row.user));
  // 404 rather than 403, so this cannot be used to probe which session ids exist.
  if (!allowed) return apiError(404, 'unknown-session', 'err.unknownSession');

  await revokeSession(id);
  return NextResponse.json({ ok: true });
}
