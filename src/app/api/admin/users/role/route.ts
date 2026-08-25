import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { users } from '@/db/schema';
import { countGlobalAdmins, getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Grants or revokes the deployment-wide admin role. Only a global admin may do this. */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.user.globalAdmin) {
    return NextResponse.json({ error: 'Global admin access required' }, { status: 403 });
  }

  const { userId, globalAdmin } = (await request.json()) as {
    userId?: number;
    globalAdmin?: boolean;
  };
  if (!userId || typeof globalAdmin !== 'boolean') {
    return NextResponse.json({ error: 'userId and globalAdmin are required' }, { status: 400 });
  }

  const [target] = await db.select().from(users).where(eq(users.id, userId));
  if (!target) return NextResponse.json({ error: 'Unknown user' }, { status: 404 });

  // Removing the last global admin would leave nobody able to manage servers or hand the
  // role back out — the deployment would be locked into its current shape.
  if (!globalAdmin && target.globalAdmin && (await countGlobalAdmins()) < 2) {
    return NextResponse.json(
      { error: 'At least one global admin has to remain' },
      { status: 400 },
    );
  }

  await db.update(users).set({ globalAdmin }).where(eq(users.id, userId));
  return NextResponse.json({ ok: true });
}
