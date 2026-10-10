import Link from 'next/link';
import AutoRefresh from '@/components/AutoRefresh';
import Beam from '@/components/Beam';
import { BarChart, StatCard } from '@/components/Charts';
import { InsightsStrip } from '@/components/Insights';
import Poster from '@/components/Poster';
import RankToggle from '@/components/RankToggle';
import TitleLink from '@/components/TitleLink';
import YearCalendar from '@/components/YearCalendar';
import {
  artUrl,
  formatDuration,
  formatMinutes,
  formatTimeAgo,
} from '@/components/format';
import { getAdapter } from '@/server/config';
import { getSections } from '@/server/library';
import { getLibraryTotals } from '@/server/librarystats';
import { getLiveSessions } from '@/server/livesessions';
import { getConcurrencyPeak, getClientSessions } from '@/server/playback';
import {
  getDailyActivity,
  getDailyPlays,
  getPeriodComparison,
  getPlaysByUser,
  getPopularTitlesByType,
  getRecentPlays,
  getStreak,
  getLongestStreak,
  getTopTitlesByType,
  type RankBy,
} from '@/server/stats';
import { adminScope, isAdmin, requireUser } from '@/server/session';
import { syncHistory, runInBackground } from '@/server/sync';
import { cachedPosters } from '@/server/tmdb';
import { getLocale, getT } from '@/i18n/server';
import './dashboard.css';

export const dynamic = 'force-dynamic';

const PERIODS = [7, 30, 90, 365];
const RECENT_ADDED = 12;
const RECENT_RAIL = 12;
const TOP_LIBRARIES = 5;
/** The sparkline under a headline number: long enough for a shape, short enough to read. */
const SPARK_DAYS = 60;

/** Seven-day rolling mean: daily counts zig-zag, and a trend line should show the trend. */
function smooth(series: { value: number }[], window = 7): number[] {
  return series.map((_, index) => {
    const slice = series.slice(Math.max(0, index - window + 1), index + 1);
    return slice.reduce((sum, point) => sum + point.value, 0) / slice.length;
  });
}

/** Change in percent, or null when there was nothing before to compare against. */
function change(current: number, previous: number): number | null {
  return previous > 0 ? Math.round(((current - previous) / previous) * 100) : null;
}

/**
 * The server at a glance: what is playing, how the period compares to the one before, what
 * got watched, how big the libraries are and what arrived lately. The personal counterpart
 * lives at /sessions — this page answers the same questions for everyone at once.
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
  const locale = await getLocale();
  // syncActivity already ran in the layout.
  runInBackground(syncHistory(session), 'history sync');

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

  const [
    liveSessions,
    topMovies,
    popularMovies,
    topShows,
    popularShows,
    recentPlays,
    platforms,
    peak,
    users,
    comparison,
    sparkPlays,
    sparkTime,
    yearDays,
    streak,
    bestStreak,
  ] = await Promise.all([
    // Admins see every stream they may see; everyone else only their own. The hero, its count
    // and its light all come from this one list, so they cannot disagree.
    getLiveSessions({
      userId: admin ? undefined : session.user.id,
      serverId,
      globalAdmin: session.user.globalAdmin,
    }),
    getTopTitlesByType(scope, 'movie', 5, by, days),
    getPopularTitlesByType(scope, 'movie', 5, days),
    getTopTitlesByType(scope, 'episode', 5, by, days),
    getPopularTitlesByType(scope, 'episode', 5, days),
    getRecentPlays(scope, RECENT_RAIL * 3),
    getClientSessions(days, scope),
    getConcurrencyPeak(days, scope),
    admin ? getPlaysByUser(onlyServer, days) : Promise.resolve([]),
    getPeriodComparison(scope, days),
    getDailyPlays(scope, Math.min(days, SPARK_DAYS)),
    getDailyActivity(scope, Math.min(days, SPARK_DAYS)),
    getDailyActivity(scope, 365),
    getStreak(scope),
    getLongestStreak(scope),
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

  // A paused stream is live but not playing: only a running one earns the amber light.
  const playingNow = liveSessions.filter((live) => live.state !== 'paused').length;
  const pausedNow = liveSessions.length - playingNow;
  const movieSections = sections.filter((section) => section.mediaType === 'movie');
  const showSections = sections.filter((section) => section.mediaType === 'show');
  const audioSections = sections.filter((section) => section.mediaType === 'audio');

  // A show watched five times in a row is one tile on the rail, not five.
  const seen = new Set<string>();
  const rail = recentPlays
    .filter((play) => {
      const key = play.grandparentTitle ?? play.title;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, RECENT_RAIL);
  const lastPlayed = rail[0];

  const hour = new Date().getHours();
  const greetingKey =
    hour < 5 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';

  const activeDaysInYear = yearDays.filter((day) => day.value > 0).length;
  const busiest = yearDays.reduce((best, day) => (day.value > best.value ? day : best), {
    label: '',
    value: 0,
  });
  const dayHref = (day: string) => `/history?date=${day}`;

  const vs = t('dash.vsPrevious', { days });
  const busiestLabel =
    busiest.value > 0
      ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
          new Date(`${busiest.label}T00:00:00Z`),
        )
      : '—';
  // The last two weeks as lit/unlit days, for the streak tile.
  const lastTwoWeeks = yearDays.slice(-14).map((day) => day.value > 0);

  return (
    <>
      <AutoRefresh seconds={10} />

      <header className="dash-head">
        <div>
          <p className="eyebrow">{t('dashboard.title')}</p>
          <h1>{t(`dash.greeting.${greetingKey}`, { name: session.user.username })}</h1>
        </div>
        <div className="dash-controls">
          <div className="seg">
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
          <RankToggle base="/" by={by} days={days} />
        </div>
      </header>

      <div className="dash-top">
        <section className={`hero ${playingNow > 0 ? 'live' : ''}`} aria-labelledby="hero-title">
          <p className="hero-kicker">
            <span className={`bulb ${playingNow > 0 ? 'on' : ''}`} />
            {playingNow > 0
              ? t('dashboard.playingNow', { count: playingNow })
              : pausedNow > 0
                ? t('dash.pausedNow', { count: pausedNow })
                : t('dashboard.nothingPlaying')}
          </p>

          {liveSessions.length > 0 ? (
            <>
              <h2 id="hero-title">{playingNow > 0 ? t('dash.heroLive') : t('dash.heroPaused')}</h2>
              <div className="hero-beams">
                {liveSessions.slice(0, 2).map((live) => (
                  <Beam key={live.sessionKey} session={live} serverSlug={session.server.slug} showUser={admin} />
                ))}
              </div>
              {liveSessions.length > 2 && (
                <Link className="hero-more" href={admin ? '/admin/activity' : '/activity'}>
                  {t('dash.heroMore', { count: liveSessions.length - 2 })} →
                </Link>
              )}
            </>
          ) : (
            <>
              <h2 id="hero-title">{t('dash.heroIdle')}</h2>
              {lastPlayed ? (
                <>
                  <p className="muted hero-body">{t('dash.heroIdleBody')}</p>
                  <div className="hero-last">
                    <Poster
                      src={artUrl(session.server.slug, lastPlayed.itemId)}
                      label={lastPlayed.grandparentTitle ?? lastPlayed.title}
                      loading="lazy"
                    />
                    <div>
                      <p className="hero-last-title">
                        <TitleLink
                          itemId={lastPlayed.itemId}
                          title={lastPlayed.title}
                          grandparentTitle={lastPlayed.grandparentTitle}
                          serverWide={admin}
                        />
                      </p>
                      <p className="muted">
                        {formatTimeAgo(t, lastPlayed.watchedAt)}
                        {admin && lastPlayed.username ? ` · ${lastPlayed.username}` : ''}
                      </p>
                      <div className="hero-actions">
                        <Link className="btn" href="/pick">
                          {t('dash.pickForMe')}
                        </Link>
                        <Link className="btn ghost" href="/history">
                          {t('dash.openHistory')}
                        </Link>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <p className="muted hero-body">{t('dash.heroNeverPlayed')}</p>
              )}
            </>
          )}
        </section>

        <div className="kpi-grid">
          <StatCard
            label={t('dash.kpiPlays')}
            value={String(comparison.plays.current)}
            trend={change(comparison.plays.current, comparison.plays.previous)}
            hint={vs}
            spark={smooth(sparkPlays)}
          />
          <StatCard
            label={t('dash.kpiTime')}
            value={formatDuration(comparison.watchtimeMs.current)}
            trend={change(comparison.watchtimeMs.current, comparison.watchtimeMs.previous)}
            hint={vs}
            spark={smooth(sparkTime)}
          />
          <StatCard
            label={t('dash.kpiDays')}
            value={`${comparison.activeDays.current} / ${days}`}
            trend={change(comparison.activeDays.current, comparison.activeDays.previous)}
            hint={vs}
            meter={comparison.activeDays.current / days}
          />
          <StatCard
            label={t('dash.kpiStreak')}
            value={String(streak)}
            hint={t('dash.streakBest', { days: bestStreak })}
            dots={lastTwoWeeks}
          />
        </div>
      </div>

      <section className="section">
        <div className="section-head">
          <h2>{admin ? t('dash.calendarServer') : t('dash.calendar')}</h2>
          <p className="muted section-aside">
            {t('dash.calendarSummary', {
              days: activeDaysInYear,
              day: busiestLabel,
            })}
          </p>
        </div>
        <div className="card calendar-card">
          <YearCalendar data={yearDays} format={formatMinutes} hrefFor={dayHref} />
          <p className="scroll-hint">{t('dash.swipeCalendar')}</p>
        </div>
      </section>

      <InsightsStrip scope={scope} />

      {rail.length > 0 && (
        <section className="section">
          <h2>{t('dash.recentRail')}</h2>
          <div className="added-strip">
            {rail.map((play) => (
              <div key={`${play.itemId}-${play.watchedAt.getTime()}`} className="added-card">
                <Link href={`/title/${encodeURIComponent(play.grandparentTitle ?? play.title)}`}>
                  <Poster
                    src={artUrl(session.server.slug, play.itemId)}
                    label={play.grandparentTitle ?? play.title}
                    loading="lazy"
                  />
                  <p className="poster-title">{play.grandparentTitle ?? play.title}</p>
                </Link>
                <p className="poster-meta">
                  {formatTimeAgo(t, play.watchedAt)}
                  {admin && play.username ? ` · ${play.username}` : ''}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="grid cols-2 section">
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
          <h2>{t('dashboard.mostWatchedShows')}</h2>
          <div className="card">
            <BarChart
              data={topShows}
              format={rank}
              hrefFor={(label) => `/title/${encodeURIComponent(label)}`}
            />
          </div>
        </section>
      </div>

      <div className="grid cols-2 section">
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
        {admin ? (
          <section>
            <h2>{t('dashboard.activeUsers')}</h2>
            <div className="card">
              <BarChart data={users} format={(value) => t('common.plays', { count: value })} />
            </div>
          </section>
        ) : null}
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
            {[...movieSections, ...showSections, ...audioSections].map((section) => (
              <StatCard
                key={section.id}
                label={section.name}
                value={String(section.itemCount)}
                hint={
                  section.mediaType === 'movie'
                    ? t('common.movies')
                    : section.mediaType === 'audio'
                      ? t('libraries.typeAudio')
                      : t('common.series')
                }
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
                    label={item.title}
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
