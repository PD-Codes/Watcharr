import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { users } from '@/db/schema';
import { badBody, readBody } from '@/server/body';
import { canSee, getRealSession, isAdmin, setViewAs } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Starts the read-only preview of another user's pages. */
export async function POST(request: Request) {
  const session = await getRealSession();
  if (!session || !isAdmin(session.user)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }
  const body = await readBody(request, { userId: 'number' });
  if (!body || body.userId == null) return badBody();

  const [target] = await db.select().from(users).where(eq(users.id, body.userId));
  // 404 for both "no such user" and "not yours to see": no hint that an account exists.
  if (!target || target.id === session.user.id || !canSee(session.user, target)) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }
  await setViewAs(session.id, target.id);
  return NextResponse.json({ ok: true });
}

/** Ends the preview. */
export async function DELETE() {
  await setViewAs('', null);
  return NextResponse.json({ ok: true });
}
