import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { playbackSessions } from '@/db/schema';
import ActivityTable from '@/components/ActivityTable';
import Beam from '@/components/Beam';
import AutoRefresh from '@/components/AutoRefresh';
import StreamTable from '@/components/StreamTable';
import { listSessionHistory } from '@/server/playback';
import { liveSessionFilter, reportSyncError, syncActivity } from '@/server/sync';
import { requireUser } from '@/server/session';
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

export default async function ActivityPage() {
  const session = await requireUser();
  const t = await getT();
  await syncActivity().catch(reportSyncError('activity sync'));

  const rows = await db
    .select()
    .from(playbackSessions)
    .where(and(eq(playbackSessions.userId, session.user.id), liveSessionFilter()));

  // Without this the page is one beam and a screen of nothing. Past streams answer the
  // question the live view cannot: what was delivered, and how.
  const live = new Set(rows.map((row) => row.sessionKey));
  const past = await listSessionHistory({ scope: { userId: session.user.id }, limit: 20 });
  const recent = past.rows.filter((row) => !live.has(row.sessionKey)).slice(0, 15);

  return (
    <>
      <AutoRefresh seconds={10} />
      <p className="eyebrow">{t('activity.eyebrow')}</p>
      <h1>{t('activity.title')}</h1>
      <p className="subtitle">{t('activity.subtitle')}</p>
      <Beam
        session={rows[0] ?? null}
        serverSlug={session.server.slug}
        emptyLabel={t('activity.nothingPlayingMine')}
      />

      {rows.length > 1 && (
        <div className="card section">
          <ActivityTable rows={rows.slice(1)} />
        </div>
      )}

      <section className="section">
        <h2>{t('users.recentStreams')}</h2>
        <div className="card">
          <StreamTable rows={recent} emptyLabel={t('users.noStreams')} />
        </div>
      </section>
    </>
  );
}
