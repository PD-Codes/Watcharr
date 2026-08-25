import Link from 'next/link';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { playbackSessions, users, watchHistory } from '@/db/schema';
import Beam from '@/components/Beam';
import AutoRefresh from '@/components/AutoRefresh';
import { BarChart, StatCard } from '@/components/Charts';
import { formatDate, formatDuration } from '@/components/format';
import { getStreak, getTopTitles, getTotals } from '@/server/stats';
import { liveSessionFilter, reportSyncError, syncHistory } from '@/server/sync';
import { requireUser } from '@/server/session';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const session = await requireUser();
  // syncActivity already ran in the layout.
  await syncHistory(session.user, session.serverToken).catch(reportSyncError('history sync'));

  const scope = { userId: session.user.id };
  const [mine, everyone, totals, streak, titles, recent] = await Promise.all([
    db
      .select()
      .from(playbackSessions)
      .where(and(eq(playbackSessions.userId, session.user.id), liveSessionFilter()))
      .limit(1),
    session.user.isAdmin
      ? db
          .select({
            sessionKey: playbackSessions.sessionKey,
            playMethod: playbackSessions.playMethod,
            bitrateKbps: playbackSessions.bitrateKbps,
            username: users.username,
          })
          .from(playbackSessions)
          .leftJoin(users, eq(users.id, playbackSessions.userId))
          .where(liveSessionFilter())
      : Promise.resolve([]),
    getTotals(scope, 30),
    getStreak(scope),
    getTopTitles(scope, 5),
    db
      .select()
      .from(watchHistory)
      .where(eq(watchHistory.userId, session.user.id))
      .orderBy(desc(watchHistory.watchedAt))
      .limit(6),
  ]);

  const [allTime] = await db
    .select({ total: sql<number>`coalesce(sum(${watchHistory.durationMs}), 0)` })
    .from(watchHistory)
    .where(eq(watchHistory.userId, session.user.id));

  const bandwidth = everyone.reduce((sum, row) => sum + (row.bitrateKbps ?? 0), 0);

  return (
    <>
      <AutoRefresh seconds={15} />
      <p className="eyebrow">Overview</p>
      <h1>{greeting()}, {session.user.username}</h1>
      <p className="subtitle">
        {mine.length
          ? 'Your session is running below.'
          : `You have watched ${formatDuration(Number(allTime?.total ?? 0))} on this server.`}
      </p>

      <Beam
        session={mine[0] ?? null}
        serverSlug={session.server.slug}
        emptyLabel="Nothing is playing. Start something on your server."
      />

      <div className="grid cols-4 section">
        <StatCard
          label="Watch time"
          value={formatDuration(totals.watchtimeMs)}
          hint="last 30 days"
          href="/stats"
          info="Sum of the runtime of everything you played in the last 30 days."
        />
        <StatCard label="Plays" value={String(totals.plays)} hint={`${totals.movies} movies · ${totals.episodes} episodes`} />
        <StatCard label="Active days" value={`${totals.activeDays} / 30`} />
        <StatCard
          label="Streak"
          value={`${streak} d`}
          href="/wrapped"
          info="Consecutive days with at least one play. Opens your year in review."
        />
      </div>

      {session.user.isAdmin && (
        <section className="section">
          <h2>Server right now</h2>
          <div className="grid cols-4">
            <StatCard label="Active streams" value={String(everyone.length)} href="/admin/activity" />
            <StatCard
              label="Transcoding"
              value={String(everyone.filter((row) => row.playMethod === 'transcode').length)}
              href="/admin/transcoding"
            />
            <StatCard label="Bandwidth" value={`${(bandwidth / 1000).toFixed(1)} Mbps`} />
            <StatCard label="Viewers" value={String(new Set(everyone.map((row) => row.username)).size)} href="/admin/users" />
          </div>
        </section>
      )}

      <div className="grid cols-2 section">
        <section>
          <h2>Recently watched</h2>
          <div className="card">
            {recent.length === 0 ? (
              <p className="muted">No plays recorded yet.</p>
            ) : (
              <table>
                <tbody>
                  {recent.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <Link href={`/title/${encodeURIComponent(row.grandparentTitle ?? row.title)}`}>
                          {row.grandparentTitle ? `${row.grandparentTitle} — ${row.title}` : row.title}
                        </Link>
                      </td>
                      <td className="num muted" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {formatDate(row.watchedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
        <section>
          <h2>Your most played</h2>
          <div className="card">
            <BarChart
              data={titles}
              format={(value) => `${value} plays`}
              hrefFor={(label) => `/title/${encodeURIComponent(label)}`}
            />
          </div>
        </section>
      </div>
    </>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
