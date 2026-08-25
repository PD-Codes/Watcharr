import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { playbackSessions } from '@/db/schema';
import ActivityTable from '@/components/ActivityTable';
import Beam from '@/components/Beam';
import AutoRefresh from '@/components/AutoRefresh';
import { liveSessionFilter, reportSyncError, syncActivity } from '@/server/sync';
import { requireUser } from '@/server/session';

export const dynamic = 'force-dynamic';

export default async function ActivityPage() {
  const session = await requireUser();
  await syncActivity().catch(reportSyncError('activity sync'));

  const rows = await db
    .select()
    .from(playbackSessions)
    .where(and(eq(playbackSessions.userId, session.user.id), liveSessionFilter()));

  return (
    <>
      <AutoRefresh seconds={10} />
      <p className="eyebrow">Live</p>
      <h1>Watch Activity</h1>
      <p className="subtitle">Your current playback sessions, refreshed every 10 seconds.</p>
      <Beam
        session={rows[0] ?? null}
        serverSlug={session.server.slug}
        emptyLabel="Nothing is playing. Start something on your server."
      />

      {rows.length > 1 && (
        <div className="card section">
          <ActivityTable rows={rows.slice(1)} />
        </div>
      )}
    </>
  );
}
