import { NextResponse } from 'next/server';
import { getAdapter } from '@/server/config';
import { getSession } from '@/server/session';
import { ensureUsers, loadRoster } from '@/server/userroster';
import { adminRequired, withApiErrors } from '@/server/apierror';

export const dynamic = 'force-dynamic';

/** Imports media server accounts that have not signed in to Watcharr yet. */
export const POST = withApiErrors(async () => {
  const session = await getSession();
  if (!session || !(session.user.isAdmin || session.user.globalAdmin)) return adminRequired();

  const adapter = await getAdapter(session.user.serverId);
  const roster = await loadRoster(adapter);
  // Through the roster, not a plain insert: a person is the same by id OR name (Plex numbers
  // its owner 1 in sessions but by plex.tv id here), and a second row would split their history.
  const imported = await ensureUsers(session.user.serverId, roster.users, { fullRoster: roster.complete });
  return NextResponse.json({ ok: true, imported });
});
