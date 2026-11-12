import { NextResponse } from 'next/server';
import { getAdapter } from '@/server/config';
import { getSession } from '@/server/session';
import { ensureUsers } from '@/server/userroster';

export const dynamic = 'force-dynamic';

/** Imports media server accounts that have not signed in to Watcharr yet. */
export async function POST() {
  const session = await getSession();
  if (!session || !(session.user.isAdmin || session.user.globalAdmin)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const adapter = await getAdapter(session.user.serverId);
  const serverUsers = await adapter.listUsers();
  // Through the roster, not a plain insert: a person is the same by id OR name (Plex numbers
  // its owner 1 in sessions but by plex.tv id here), and a second row would split their history.
  const imported = await ensureUsers(session.user.serverId, serverUsers);
  return NextResponse.json({ ok: true, imported });
}
