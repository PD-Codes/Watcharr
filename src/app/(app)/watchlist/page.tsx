import { desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { watchlist } from '@/db/schema';
import { reconcileWatchlistStatus, syncWatchlist } from '@/server/sync';
import { requireUser } from '@/server/session';
import WatchlistClient from './WatchlistClient';

export const dynamic = 'force-dynamic';

export default async function WatchlistPage() {
  const session = await requireUser();
  await syncWatchlist(session.user.id, session.serverToken).catch(() => {});
  await reconcileWatchlistStatus(session.user.id);

  const items = await db
    .select()
    .from(watchlist)
    .where(eq(watchlist.userId, session.user.id))
    .orderBy(desc(watchlist.addedAt));

  return (
    <>
      <p className="eyebrow">Library</p>
      <h1>Watchlist</h1>
      <p className="subtitle">Titles you plan to watch. Plex watchlists are synced automatically.</p>
      <WatchlistClient
        items={items.map((i) => ({
          itemId: i.itemId,
          title: i.title,
          mediaType: i.mediaType,
          year: i.year,
          status: i.status,
          source: i.source,
        }))}
      />
    </>
  );
}
