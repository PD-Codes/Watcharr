import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { users } from '@/db/schema';
import { readBody } from '@/server/body';
import { canSee, getRealSession, isAdmin } from '@/server/session';
import { deleteUserWithData } from '@/server/userdelete';
import { adminRequired, apiError, badBody } from '@/server/apierror';

export const dynamic = 'force-dynamic';

/** Deletes a person and all their data, e.g. when they are gone from the media server. */
export async function POST(request: Request) {
  const session = await getRealSession();
  if (!session || !isAdmin(session.user)) return adminRequired();
  const body = await readBody(request, { userId: 'number' });
  if (!body || typeof body.userId !== 'number') return badBody();

  const [target] = await db.select().from(users).where(eq(users.id, body.userId));
  // 404 for "no such user" and "not yours": no hint that an account exists elsewhere.
  if (!target || !canSee(session.user, target)) {
    return apiError(404, 'user-not-found', 'err.userNotFound');
  }
  if (target.id === session.user.id) {
    return apiError(400, 'own-account', 'err.ownAccount');
  }
  // A global admin first has to lose the role (which keeps at least one around).
  if (target.globalAdmin) {
    return apiError(400, 'global-admin', 'err.revokeRoleFirst');
  }
  const removed = deleteUserWithData(target.id);
  return NextResponse.json({ ok: true, ...removed });
}
