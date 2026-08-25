import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '@/db';
import { authSessions, users } from '@/db/schema';
import { canSee, getSession, revokeSession } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * Revokes one session: an admin's "sign this device out" button, and the same control on
 * a user's own profile page. Signing yourself out of your own session needs no admin role
 * — it is the one case where the target is unambiguously yours.
 */
export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Sign in first' }, { status: 401 });

  const { id } = (await request.json()) as { id?: string };
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  const [row] = await db
    .select({ user: users })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(eq(authSessions.id, id));
  if (!row) return NextResponse.json({ error: 'Unknown session' }, { status: 404 });

  const own = row.user.id === session.user.id;
  const allowed = own || ((session.user.isAdmin || session.user.globalAdmin) && canSee(session.user, row.user));
  // 404 rather than 403, so this cannot be used to probe which session ids exist.
  if (!allowed) return NextResponse.json({ error: 'Unknown session' }, { status: 404 });

  await revokeSession(id);
  return NextResponse.json({ ok: true });
}
