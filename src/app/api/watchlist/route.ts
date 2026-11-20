import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { watchlist } from '@/db/schema';
import { supportsWatchlistWrite } from '@/server/adapters';
import { readBody } from '@/server/body';
import { getAdapter, getSettings } from '@/server/config';
import { isEnabled } from '@/server/features';
import { getSession, type Session } from '@/server/session';
import { runInBackground } from '@/server/sync';
import { apiError, badBody, unauthorized } from '@/server/apierror';
import { pushableToServer } from '@/server/watchlistmatch';

export const dynamic = 'force-dynamic';

const STATUSES = ['planned', 'watching', 'done'];

/**
 * Mirrors one change to the media server's own watchlist (Plex: the plex.tv watchlist), so the
 * list a person keeps here and the one their Plex apps show stay the same in both directions;
 * sync.ts::pullWatchlist is the other half. Behind the response, never in it: plex.tv can be slow,
 * and a failed push must not undo or delay what was already saved locally. Not in a preview,
 * which has no token of the viewed person (and proxy.ts refuses its writes anyway), and not
 * without the watchlist sync switched on: then the two lists are deliberately separate.
 */
async function pushToServer(session: Session, action: 'add' | 'remove', itemId: string): Promise<void> {
  if (session.preview || !session.serverToken) return;
  if (!isEnabled((await getSettings()).features, 'watchlistSync')) return;
  const adapter = await getAdapter(session.user.serverId);
  if (!supportsWatchlistWrite(adapter)) return;
  await (action === 'add'
    ? adapter.addToWatchlist(session.serverToken, itemId)
    : adapter.removeFromWatchlist(session.serverToken, itemId));
}

function push(session: Session, action: 'add' | 'remove', itemId: string): void {
  runInBackground(pushToServer(session, action, itemId), `watchlist ${action} on the media server`);
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return unauthorized();

  const body = await readBody(request, {
    itemId: 'string',
    title: 'string',
    mediaType: 'string',
    year: 'number',
  });
  if (!body) return badBody();
  if (!body.itemId || !body.title) {
    return apiError(400, 'missing-fields', 'err.watchlistFieldsRequired');
  }

  const added = await db
    .insert(watchlist)
    .values({
      userId: session.user.id,
      itemId: body.itemId,
      title: body.title,
      mediaType: body.mediaType ?? 'unknown',
      year: body.year ?? undefined,
    })
    .onConflictDoNothing()
    .returning({ id: watchlist.id });
  // Only a row that is new here is news to the server; one already listed came from it or went
  // there before. Movies and shows only: see pushableToServer.
  if (added.length && pushableToServer(body.mediaType)) push(session, 'add', body.itemId);
  return NextResponse.json({ ok: true });
}

export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session) return unauthorized();

  const body = await readBody(request, { itemId: 'string', status: 'string' });
  if (!body) return badBody();
  const { itemId, status } = body;
  if (!itemId || !status || !STATUSES.includes(status)) {
    return apiError(400, 'invalid-status', 'err.invalidStatus');
  }

  await db
    .update(watchlist)
    .set({ status })
    .where(and(eq(watchlist.userId, session.user.id), eq(watchlist.itemId, itemId)));
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session) return unauthorized();

  const itemId = new URL(request.url).searchParams.get('itemId');
  if (!itemId) return apiError(400, 'missing-item-id', 'err.itemIdRequired');

  const removed = await db
    .delete(watchlist)
    .where(and(eq(watchlist.userId, session.user.id), eq(watchlist.itemId, itemId)))
    .returning({ id: watchlist.id, mediaType: watchlist.mediaType });
  // Removed here means removed there too, whichever side the entry came from: otherwise the next
  // pull would bring it straight back. Not for an episode or season, which never went there: as
  // its show it would take the whole show off the person's Plex watchlist.
  if (removed.length && pushableToServer(removed[0].mediaType)) push(session, 'remove', itemId);
  return NextResponse.json({ ok: true });
}
