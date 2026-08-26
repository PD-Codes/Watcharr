import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { playbackSessions } from '@/db/schema';
import AutoRefresh from '@/components/AutoRefresh';
import { BarChart, StatCard } from '@/components/Charts';
import Poster from '@/components/Poster';
import RankToggle from '@/components/RankToggle';
import TitleLink from '@/components/TitleLink';
import { artUrl, formatDate, formatMinutes, formatTimeAgo } from '@/components/format';
import { getAdapter } from '@/server/config';
import { getSections } from '@/server/library';
import { getLibraryTotals } from '@/server/librarystats';
import { getConcurrencyPeak, getClientSessions } from '@/server/playback';
import {
  getPlaysByUser,
  getPopularTitlesByType,
  getRecentPlays,
  getTopTitlesByType,
  type RankBy,
} from '@/server/stats';
import { adminScope, isAdmin, requireUser } from '@/server/session';
import { liveSessionFilter, reportSyncError, syncHistory } from '@/server/sync';
import { cachedPosters } from '@/server/tmdb';
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

const PERIODS = [7, 30, 90, 365];
const RECENT_ADDED = 12;
const TOP_LIBRARIES = 5;

/**
 * The server at a glance: what is playing, what gets watched most, how big the libraries
 * are and what arrived lately. The personal counterpart lives at /sessions — this page
 * answers the same questions for everyone at once.
 *
 * Figures are server-wide for an admin and personal for everyone else, the same rule the
 * per-library pages already follow. A non-admin therefore never sees a tile ranking other
 * accounts.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; by?: string }>;
}) {
  const session = await requireUser();
  const t = await getT();
  // syncActivity already ran in the layout.
  await syncHistory(session.user, session.serverToken).catch(reportSyncError('history sync'));

  const params = await searchParams;
  const requested = Number(params.days ?? 30);
  const days = PERIODS.includes(requested) ? requested : 30;
  const by: RankBy = params.by === 'time' ? 'time' : 'count';

  const admin = isAdmin(session.user);
  const scope = admin ? adminScope(session.user) : { userId: session.user.id };
  const onlyServer = session.user.globalAdmin ? undefined : session.user.serverId;
  const serverId = session.user.serverId;

  const rank = (value: number) =>
    by === 'time' ? formatMinutes(value) : t('common.plays', { count: value });
  const viewers = (value: number) => t('dashboard.viewers', { count: value });

  const adapter = await getAdapter(serverId).catch(() => null);
  const sections = await getSections(serverId).catch(() => []);

  const [live, topMovies, popularMovies, topShows, popularShows, recentPlays, platforms, peak, users] =
    await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(playbackSessions)
        .where(liveSessionFilter()),
      getTopTitlesByType(scope, 'movie', 5, by, days),
      getPopularTitlesByType(scope, 'movie', 5, days),
      getTopTitlesByType(scope, 'episode', 5, by, days),
      getPopularTitlesByType(scope, 'episode', 5, days),
      getRecentPlays(scope, 5),
      getClientSessions(days, scope),
      getConcurrencyPeak(days, scope),
      admin ? getPlaysByUser(onlyServer, days) : Promise.resolve([]),
    ]);

  // One aggregate per library rather than one query for all of them: watch_history has no
  // library column, so each has to be resolved through its own item ids and titles.
  const libraryPlays = await Promise.all(
    sections.map(async (section) => ({
      label: section.name,
      value: (await getLibraryTotals(serverId, section.id, scope, days).catch(() => null))?.plays ?? 0,
    })),
  );
  const activeLibraries = libraryPlays
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, TOP_LIBRARIES);

  const added = (await adapter?.getRecentlyAdded(RECENT_ADDED).catch(() => [])) ?? [];
  const posters = await cachedPosters(added);

  const liveCount = Number(live[0]?.count ?? 0);
  const movieSections = sections.filter((section) => section.mediaType === 'movie');
  const showSections = sections.filter((section) => section.mediaType !== 'movie');

  return (
    <>
      <AutoRefresh seconds={30} />
      <p className="eyebrow">{t('nav.overview')}</p>
      <h1>{t('dashboard.title')}</h1>
      <p className="subtitle">
        {liveCount > 0 ? (
          <Link href={admin ? '/admin/activity' : '/activity'}>
            {t('dashboard.playingNow', { count: liveCount })}
          </Link>
        ) : (
          t('dashboard.nothingPlaying')
        )}
      </p>

      <div className="section-head" style={{ marginTop: 0 }}>
        <h2>{t('dashboard.watchStatistics')}</h2>
        <RankToggle base="/" by={by} days={days} />
      </div>
      <div className="seg" style={{ marginBottom: 18 }}>
        {PERIODS.map((period) => (
          <Link
            key={period}
            href={`/?days=${period}&by=${by}`}
            className={period === days ? 'on' : undefined}
          >
            {period === 365 ? t('common.lastYear') : t('common.days', { count: period })}
          </Link>
        ))}
      </div>

      <div className="grid cols-2">
        <section>
          <h2>{t('dashboard.mostWatchedMovies')}</h2>
          <div className="card">
            <BarChart
              data={topMovies}
              format={rank}
              hrefFor={(label) => `/title/${encodeURIComponent(label)}`}
            />
          </div>
        </section>
        <section>
          <h2>{t('dashboard.mostPopularMovies')}</h2>
          <div className="card">
            <BarChart
              data={popularMovies}
              format={viewers}
              hrefFor={(label) => `/title/${encodeURIComponent(label)}`}
            />
          </div>
        </section>
      </div>

      <div className="grid cols-2 section">
        <section>
          <h2>{t('dashboard.mostWatchedShows')}</h2>
          <div className="card">
            <BarChart
              data={topShows}
              format={rank}
              hrefFor={(label) => `/title/${encodeURIComponent(label)}`}
            />
          </div>
        </section>
        <section>
          <h2>{t('dashboard.mostPopularShows')}</h2>
          <div className="card">
            <BarChart
              data={popularShows}
              format={viewers}
              hrefFor={(label) => `/title/${encodeURIComponent(label)}`}
            />
          </div>
        </section>
      </div>

      <div className="grid cols-2 section">
        <section>
          <h2>{t('dashboard.recentlyWatched')}</h2>
          <div className="card">
            {recentPlays.length === 0 ? (
              <p className="muted">{t('overview.noPlays')}</p>
            ) : (
              <table>
                <tbody>
                  {recentPlays.map((play) => (
                    <tr key={`${play.itemId}-${play.watchedAt.getTime()}`}>
                      <td>
                        <TitleLink
                          itemId={play.itemId}
                          title={play.title}
                          grandparentTitle={play.grandparentTitle}
                          serverWide={admin}
                        />
                        {admin && play.username && (
                          <div className="muted" style={{ fontSize: 12 }}>
                            {play.username}
                          </div>
                        )}
                      </td>
                      <td className="num muted" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {formatDate(play.watchedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
        <section>
          <h2>{t('dashboard.activeLibraries')}</h2>
          <div className="card">
            <BarChart
              data={activeLibraries}
              format={(value) => t('common.plays', { count: value })}
              hrefFor={(label) => {
                const match = sections.find((section) => section.name === label);
                return match ? `/libraries/${encodeURIComponent(match.id)}` : '/libraries';
              }}
            />
          </div>
        </section>
      </div>

      <div className="grid cols-2 section">
        {admin && (
          <section>
            <h2>{t('dashboard.activeUsers')}</h2>
            <div className="card">
              <BarChart data={users} format={(value) => t('common.plays', { count: value })} />
            </div>
          </section>
        )}
        <section>
          <h2>{t('dashboard.activePlatforms')}</h2>
          <div className="card">
            <BarChart data={platforms} format={(value) => t('common.streams', { count: value })} />
          </div>
        </section>
      </div>

      <section className="section">
        <h2>{t('dashboard.concurrentStreams')}</h2>
        <div className="grid cols-4">
          <StatCard
            label={t('dashboard.peakStreams')}
            value={String(peak.streams)}
            info={t('dashboard.peakInfo')}
          />
          <StatCard label={t('stream.transcode')} value={String(peak.transcodes)} />
          <StatCard label={t('stream.directStream')} value={String(peak.directStreams)} />
          <StatCard label={t('stream.directPlay')} value={String(peak.directPlays)} />
        </div>
      </section>

      <section className="section">
        <h2>{t('dashboard.libraryStatistics')}</h2>
        {sections.length === 0 ? (
          <p className="muted">{t('libraries.none')}</p>
        ) : (
          <div className="grid cols-4">
            {[...movieSections, ...showSections].map((section) => (
              <StatCard
                key={section.id}
                label={section.name}
                value={String(section.itemCount)}
                hint={section.mediaType === 'movie' ? t('common.movies') : t('common.series')}
                href={`/libraries/${encodeURIComponent(section.id)}`}
              />
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <h2>{t('dashboard.recentlyAdded')}</h2>
        {added.length === 0 ? (
          <p className="muted">{t('libraries.nothingNew')}</p>
        ) : (
          /* Horizontally scrollable rather than wrapped: this is a filmstrip of the newest
             arrivals, not a full grid of the library. */
          <div className="added-strip">
            {added.map((item) => (
              <div key={item.itemId} className="added-card">
                <Link href={`/title/${encodeURIComponent(item.title)}`}>
                  <Poster
                    src={artUrl(session.server.slug, item.itemId)}
                    fallback={posters.get(item.itemId)}
                    loading="lazy"
                  />
                  <p className="poster-title">{item.title}</p>
                </Link>
                <p className="poster-meta">
                  {item.addedAt ? formatTimeAgo(t, item.addedAt) : (item.year ?? '')}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
