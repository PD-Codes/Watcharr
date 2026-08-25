import { NextResponse } from 'next/server';
import { db } from '@/db';
import { users } from '@/db/schema';
import { getAdapter } from '@/server/config';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Imports media server accounts that have not signed in to Watcharr yet. */
export async function POST() {
  const session = await getSession();
  if (!session || !(session.user.isAdmin || session.user.globalAdmin)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const adapter = await getAdapter(session.user.serverId);
  const serverUsers = await adapter.listUsers();
  if (!serverUsers.length) return NextResponse.json({ ok: true, imported: 0 });

  await db
    .insert(users)
    .values(
      serverUsers.map((u) => ({
        serverId: session.user.serverId,
        serverUserId: u.serverUserId,
        username: u.username,
        email: u.email,
        avatarUrl: u.avatarUrl,
        isAdmin: u.isAdmin,
      })),
    )
    .onConflictDoNothing();
  return NextResponse.json({ ok: true, imported: serverUsers.length });
}
