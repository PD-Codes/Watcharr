import { count, desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { watchlist } from '@/db/schema';
import { reconcileWatchlistStatus, syncWatchlist, runInBackground } from '@/server/sync';
import { requireUser } from '@/server/session';
import Pager, { pageOf } from '@/components/Pager';
import { getT } from '@/i18n/server';
import WatchlistClient from './WatchlistClient';

export const dynamic = 'force-dynamic';

export default async function WatchlistPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  const session = await requireUser();
  const t = await getT();
  runInBackground(syncWatchlist(session), 'watchlist sync');
  await reconcileWatchlistStatus(session.user.id);

  // Paged on the server: the client component only renders and edits the rows it gets (no
  // filtering or sorting of its own), so a slice changes nothing about how it behaves. After
  // an edit it refreshes, and pageOf() moves back a page if the last row of this one is gone.
  const mine = eq(watchlist.userId, session.user.id);
  const [{ total }] = await db.select({ total: count() }).from(watchlist).where(mine);
  const { page, pages, offset, limit } = pageOf((await searchParams).page, total);
  const items = await db
    .select()
    .from(watchlist)
    .where(mine)
    .orderBy(desc(watchlist.addedAt), desc(watchlist.id))
    .limit(limit)
    .offset(offset);

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
      <Pager page={page} pages={pages} />
    </>
  );
}
