import Link from 'next/link';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { playbackSessions, users, watchHistory } from '@/db/schema';
import Beam from '@/components/Beam';
import AutoRefresh from '@/components/AutoRefresh';
import { BarChart, StatCard } from '@/components/Charts';
import TitleLink from '@/components/TitleLink';
import { formatDate, formatDuration } from '@/components/format';
import { getStreak, getTopTitles, getTotals } from '@/server/stats';
import { liveSessionFilter, reportSyncError, syncHistory } from '@/server/sync';
import { requireUser } from '@/server/session';
import { getT } from '@/i18n/server';
import type { Translate } from '@/i18n';

export const dynamic = 'force-dynamic';

/**
 * The personal view: what is playing for you right now, your own numbers, what you last
 * watched. Split off from the dashboard at `/`, which answers the same questions for the
 * whole server rather than for one account.
 */
export default async function SessionsPage() {
  const session = await requireUser();
  const t = await getT();
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
      <p className="eyebrow">{t('nav.sessions')}</p>
      <h1>{greeting(t)}, {session.user.username}</h1>
      <p className="subtitle">
        {mine.length
          ? t('overview.sessionRunning')
          : t('overview.watchedTotal', { duration: formatDuration(Number(allTime?.total ?? 0)) })}
      </p>

      <Beam
        session={mine[0] ?? null}
        serverSlug={session.server.slug}
        emptyLabel={t('activity.nothingPlayingMine')}
      />

      <div className="grid cols-4 section">
        <StatCard
          label={t('common.watchTime')}
          value={formatDuration(totals.watchtimeMs)}
          hint={t('overview.last30Days')}
          href="/stats"
          info={t('overview.watchTimeInfo')}
        />
        <StatCard
          label={t('overview.plays')}
          value={String(totals.plays)}
          hint={t('overview.playsHint', { movies: totals.movies, episodes: totals.episodes })}
        />
        <StatCard label={t('stats.activeDays')} value={`${totals.activeDays} / 30`} />
        <StatCard
          label={t('overview.streak')}
          value={t('stats.daysShort', { count: streak })}
          href="/wrapped"
          info={t('overview.streakInfo')}
        />
      </div>

      {session.user.isAdmin && (
        <section className="section">
          <h2>{t('overview.serverNow')}</h2>
          <div className="grid cols-4">
            <StatCard label={t('overview.activeStreams')} value={String(everyone.length)} href="/admin/activity" />
            <StatCard
              label={t('nav.adminTranscoding')}
              value={String(everyone.filter((row) => row.playMethod === 'transcode').length)}
              href="/admin/transcoding"
            />
            <StatCard label={t('overview.bandwidth')} value={`${(bandwidth / 1000).toFixed(1)} Mbps`} />
            <StatCard label={t('overview.viewers')} value={String(new Set(everyone.map((row) => row.username)).size)} href="/admin/users" />
          </div>
        </section>
      )}

      <div className="grid cols-2 section">
        <section>
          <h2>{t('overview.recentlyWatched')}</h2>
          <div className="card">
            {recent.length === 0 ? (
              <p className="muted">{t('overview.noPlays')}</p>
            ) : (
              <table>
                <tbody>
                  {recent.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <TitleLink
                          itemId={row.itemId}
                          title={row.title}
                          grandparentTitle={row.grandparentTitle}
                        />
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
          <h2>{t('overview.mostPlayed')}</h2>
          <div className="card">
            <BarChart
              data={titles}
              format={(value) => t('common.plays', { count: value })}
              hrefFor={(label) => `/title/${encodeURIComponent(label)}`}
            />
          </div>
        </section>
      </div>
    </>
  );
}

function greeting(t: Translate): string {
  const hour = new Date().getHours();
  if (hour < 5) return t('overview.greeting.stillUp');
  if (hour < 12) return t('overview.greeting.morning');
  if (hour < 18) return t('overview.greeting.afternoon');
  return t('overview.greeting.evening');
}
