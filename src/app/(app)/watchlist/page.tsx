import { desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { watchlist } from '@/db/schema';
import { reconcileWatchlistStatus, reportSyncError, syncWatchlist } from '@/server/sync';
import { requireUser } from '@/server/session';
import { getT } from '@/i18n/server';
import WatchlistClient from './WatchlistClient';

export const dynamic = 'force-dynamic';

export default async function WatchlistPage() {
  const session = await requireUser();
  const t = await getT();
  await syncWatchlist(session).catch(reportSyncError('watchlist sync'));
  await reconcileWatchlistStatus(session.user.id);

  const items = await db
    .select()
    .from(watchlist)
    .where(eq(watchlist.userId, session.user.id))
    .orderBy(desc(watchlist.addedAt));

  return (
    <>
      <p className="eyebrow">{t('history.eyebrow')}</p>
      <h1>{t('nav.watchlist')}</h1>
      <p className="subtitle">{t('watchlist.subtitle')}</p>
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
