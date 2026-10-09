import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { users } from '@/db/schema';
import { badBody, readBody } from '@/server/body';
import { canSee, getRealSession, isAdmin } from '@/server/session';
import { deleteUserWithData } from '@/server/userdelete';

export const dynamic = 'force-dynamic';

/** Deletes a person and all their data, e.g. when they are gone from the media server. */
export async function POST(request: Request) {
  const session = await getRealSession();
  if (!session || !isAdmin(session.user)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }
  const body = await readBody(request, { userId: 'number' });
  if (!body || typeof body.userId !== 'number') return badBody();

  const [target] = await db.select().from(users).where(eq(users.id, body.userId));
  // 404 for "no such user" and "not yours": no hint that an account exists elsewhere.
  if (!target || !canSee(session.user, target)) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }
  if (target.id === session.user.id) {
    return NextResponse.json({ error: 'You cannot delete your own account' }, { status: 400 });
  }
  // A global admin first has to lose the role (which keeps at least one around).
  if (target.globalAdmin) {
    return NextResponse.json({ error: 'Revoke the global admin role first' }, { status: 400 });
  }
  const removed = deleteUserWithData(target.id);
  return NextResponse.json({ ok: true, ...removed });
}
