import Link from 'next/link';
import {
  AreaChart,
  BarChart,
  ColumnChart,
  DonutChart,
  Heatmap,
  StatCard,
  WeekHourGrid,
} from '@/components/Charts';
import { formatDate, formatDuration, formatMinutes } from '@/components/format';
import {
  getDailyActivity,
  getHighlights,
  getMonthlyActivity,
  getPeakHours,
  getRecords,
  getRewatchSplit,
  getStreak,
  getTopDevices,
  getTopGenres,
  getTopTitles,
  getTotals,
  getTrend,
  getWeekdayActivity,
  getWeekHourGrid,
  type RankBy,
} from '@/server/stats';
import RankToggle from '@/components/RankToggle';
import {
  getBitrateBuckets,
  getClientSessions,
  getCompletionSplit,
  getDeviceSessions,
  getPlaybackTotals,
  getPlayMethods,
  getResolutions,
  getTranscodeReasons,
  getVideoCodecs,
} from '@/server/playback';
import { getLibrary } from '@/server/library';
import { getTopCast } from '@/server/tmdb';
import { CastStrip } from '@/components/TitleMeta';
import { getSettings } from '@/server/config';
import { reportSyncError, syncHistory } from '@/server/sync';
import { requireUser } from '@/server/session';
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

const titleHref = (label: string) => `/title/${encodeURIComponent(label)}`;
const genreHref = (label: string) => `/history?genre=${encodeURIComponent(label)}`;
const dayHref = (day: string) => `/history?date=${day}`;
const PERIOD_DAYS = [7, 30, 90, 365];

export default async function StatsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; by?: string }>;
}) {
  const session = await requireUser();
  const t = await getT();
  await syncHistory(session).catch(reportSyncError('history sync'));

  const params = await searchParams;
  const days = Number(params.days ?? 30);
  const by: RankBy = params.by === 'time' ? 'time' : 'count';
  const rank =
    by === 'time' ? formatMinutes : (value: number) => t('common.plays', { count: value });
  const sessionCount = (value: number) => t('common.sessions', { count: value });
  const scope = { userId: session.user.id };
  const year = new Date().getFullYear();
  const { watchedThreshold } = await getSettings();

  const [
    totals,
    trend,
    daily,
    monthly,
    weekdays,
    weekGrid,
    genres,
    titles,
    devices,
    hours,
    streak,
    highlights,
    records,
    rewatch,
    library,
    yearDays,
  ] = await Promise.all([
    getTotals(scope, days),
    getTrend(scope, days),
    getDailyActivity(scope, days),
    getMonthlyActivity(scope, year),
    getWeekdayActivity(scope),
    getWeekHourGrid(scope),
    getTopGenres(scope, 8, by),
    getTopTitles(scope, 8, by),
    getTopDevices(scope, 8, by),
    getPeakHours(scope),
    getStreak(scope),
    getHighlights(scope),
    getRecords(scope),
    getRewatchSplit(scope),
    getLibrary(session.user.serverId).catch(() => []),
    getDailyActivity(scope, 365),
  ]);

  // Delivery statistics, scoped to this user's own sessions.
  const [playback, methods, reasons, codecs, resolutions, bitrates, clients, deviceSessions] =
    await Promise.all([
      getPlaybackTotals(undefined, scope),
      getPlayMethods(undefined, scope),
      getTranscodeReasons(undefined, scope),
      getVideoCodecs(undefined, scope),
      getResolutions(undefined, scope),
      getBitrateBuckets(undefined, scope),
      getClientSessions(undefined, scope),
      getDeviceSessions(undefined, scope),
    ]);

  const completion = await getCompletionSplit(watchedThreshold, undefined, scope);
  // Cache-only, so this costs one query and never a TMDB request in the render path.
  const topCast = await getTopCast(scope).catch(() => []);

  const busiestHour = hours.reduce((best, hour) => (hour.value > best.value ? hour : best), hours[0]);
  // The library lists movies and series, so coverage has to compare titles with titles —
  // counting individual episodes against it produced percentages far above 100.
  const coverage = library.length
    ? Math.min(100, Math.round((highlights.distinctTitles / library.length) * 100))
    : null;

  return (
    <>
      <p className="eyebrow">{t('stats.eyebrow')}</p>
      <h1>{t('nav.stats')}</h1>
      <p className="subtitle">{t('stats.subtitle')}</p>

      {/* One tap per period instead of select-then-submit, which needed three on a phone. */}
      <div className="seg" style={{ marginBottom: 22 }}>
        {PERIOD_DAYS.map((value) => (
          <Link
            key={value}
            href={`/stats?days=${value}&by=${by}`}
            className={days === value ? 'on' : undefined}
          >
            {value === 365 ? t('common.lastYear') : t('common.days', { count: value })}
          </Link>
        ))}
      </div>

      <div className="grid cols-4">
        <StatCard
          label={t('common.watchTime')}
          value={formatDuration(totals.watchtimeMs)}
          hint={t('stats.lastNDays', { days })}
          trend={trend}
          spark={daily.map((day) => day.value)}
          info={t('stats.watchTimeInfo')}
        />
        <StatCard
          label={t('overview.plays')}
          value={String(totals.plays)}
          hint={t('overview.playsHint', { movies: totals.movies, episodes: totals.episodes })}
        />
        <StatCard
          label={t('stats.activeDays')}
          value={`${totals.activeDays} / ${days}`}
          info={t('stats.activeDaysInfo')}
        />
        <StatCard
          label={t('stats.currentStreak')}
          value={t('stats.daysShort', { count: streak })}
          hint={t('stats.longestStreakHint', { count: highlights.longestStreak })}
          info={t('stats.streakInfo')}
        />
      </div>

      <div className="grid cols-4 section">
        <StatCard
          label={t('stats.busiestDay')}
          value={highlights.busiestDay ? formatMinutes(highlights.busiestDay.minutes) : '—'}
          hint={highlights.busiestDay?.day}
          href={highlights.busiestDay ? dayHref(highlights.busiestDay.day) : undefined}
          info={t('stats.busiestDayInfo')}
        />
        <StatCard
          label={t('stats.longestPlay')}
          value={formatDuration(records.longestPlayMs)}
          info={t('stats.longestPlayInfo')}
        />
        <StatCard
          label={t('stats.bingeRecord')}
          value={records.bingeCount ? `${records.bingeCount}×` : '—'}
          hint={records.bingeTitle ? `${records.bingeTitle} · ${records.bingeDay}` : undefined}
          info={t('stats.bingeRecordInfo')}
        />
        <StatCard
          label={t('stats.libraryExplored')}
          value={coverage === null ? '—' : `${coverage}%`}
          hint={
            coverage === null
              ? undefined
              : t('stats.libraryExploredHint', {
                  watched: highlights.distinctTitles,
                  total: library.length,
                })
          }
          info={t('stats.libraryExploredInfo')}
        />
      </div>

      <section className="section">
        <h2>{t('stats.dailyActivity')}</h2>
        <div className="card">
          <AreaChart data={daily} format={formatMinutes} />
        </div>
      </section>

      <section className="section">
        <h2>{t('stats.whenYouWatch')}</h2>
        <div className="card">
          <p className="muted" style={{ margin: '0 0 14px' }}>
            {t('stats.whenYouWatchHint')}
          </p>
          <WeekHourGrid
            data={weekGrid}
            format={formatMinutes}
            hrefFor={(dayIndex, hour) => `/history?weekday=${dayIndex}&hour=${hour}`}
          />
          <p className="scroll-hint">{t('stats.swipeDay')}</p>
        </div>
      </section>

      <div className="section toolbar">
        <h2 style={{ margin: 0 }}>{t('stats.topLists')}</h2>
        <RankToggle base="/stats" by={by} days={days} />
      </div>

      <div className="grid cols-2">
        <section>
          <h2>{t('stats.titles')}</h2>
          <div className="card">
            <BarChart data={titles} format={rank} hrefFor={titleHref} />
          </div>
        </section>
        <section>
          <h2>{t('common.genres')}</h2>
          <div className="card">
            <BarChart data={genres} format={rank} hrefFor={genreHref} />
          </div>
        </section>
      </div>

      <div className="grid cols-2 section">
        <section>
          <h2>{t('stats.devices')}</h2>
          <div className="card">
            <BarChart data={devices} format={rank} />
          </div>
        </section>
        <section>
          <h2>{t('stats.byWeekday')}</h2>
          <div className="card">
            <ColumnChart data={weekdays} format={formatMinutes} />
          </div>
        </section>
      </div>

      <section className="section">
        <h2>{t('stats.byHour')}</h2>
        <div className="card">
          <ColumnChart
            data={hours}
            format={(value) => t('common.plays', { count: value })}
            labelEvery={2}
          />
        </div>
      </section>

      <section className="section">
        <h2>{t('stats.byMonth', { year })}</h2>
        <div className="card">
          <ColumnChart data={monthly} format={formatMinutes} />
        </div>
      </section>

      <section className="section">
        <h2>{t('stats.last365')}</h2>
        <div className="card">
          <Heatmap data={yearDays} format={formatMinutes} hrefFor={dayHref} />
          <p className="scroll-hint">{t('stats.swipeStrip')}</p>
        </div>
      </section>

      <div className="grid cols-2 section">
        <section>
          <h2>{t('stats.moviesVsEpisodes')}</h2>
          <div className="card">
            <DonutChart
              data={[
                { label: t('common.movies'), value: totals.movies },
                { label: t('common.episodes'), value: totals.episodes },
              ]}
              format={(value) => t('common.plays', { count: value })}
            />
          </div>
        </section>
        <section>
          <h2>{t('stats.newVsRewatched')}</h2>
          <div className="card">
            <DonutChart
              data={[
                { label: t('stats.firstWatch'), value: rewatch.fresh },
                { label: t('stats.rewatch'), value: rewatch.rewatch },
              ]}
              format={(value) => t('common.plays', { count: value })}
            />
          </div>
        </section>
      </div>

      <h2 className="section" style={{ marginBottom: 4 }}>
        {t('stats.delivery')}
      </h2>
      <p className="subtitle" style={{ marginTop: 0 }}>
        {t('stats.deliverySubtitle', {
          date: formatDate(records.lastPlayAt ?? new Date()),
          count: playback.sessions,
        })}
      </p>

      <div className="grid cols-2">
        <section>
          <h2>{t('stats.finishedVsAbandoned')}</h2>
          <div className="card">
            <DonutChart
              data={[
                { label: t('stats.finished'), value: completion.finished },
                { label: t('stats.abandoned'), value: completion.abandoned },
              ]}
              format={sessionCount}
            />
            <p className="muted" style={{ margin: '12px 0 0' }}>
              {t('stats.finishedFrom', { percent: watchedThreshold })}
            </p>
          </div>
        </section>
        <section>
          <h2>{t('stats.playbackMethod')}</h2>
          <div className="card">
            <DonutChart data={methods} format={sessionCount} />
          </div>
        </section>
        <section>
          <h2>{t('stats.transcodeReasons')}</h2>
          <div className="card">
            <BarChart data={reasons} format={sessionCount} />
          </div>
        </section>
      </div>

      <div className="grid cols-2 section">
        <section>
          <h2>{t('stats.yourClients')}</h2>
          <div className="card">
            <BarChart data={clients} format={sessionCount} />
          </div>
        </section>
        <section>
          <h2>{t('stats.yourDevices')}</h2>
          <div className="card">
            <BarChart data={deviceSessions} format={sessionCount} />
          </div>
        </section>
      </div>

      <div className="grid cols-2 section">
        <section>
          <h2>{t('stats.resolutions')}</h2>
          <div className="card">
            <BarChart data={resolutions} format={sessionCount} />
          </div>
        </section>
        <section>
          <h2>{t('stats.videoCodecs')}</h2>
          <div className="card">
            <BarChart data={codecs} format={sessionCount} />
          </div>
        </section>
      </div>

      <section className="section">
        <h2>{t('stats.bitrate')}</h2>
        <div className="card">
          <BarChart data={bitrates} format={sessionCount} />
        </div>
      </section>

      {/* Renders nothing until TMDB has been asked about the titles behind it — the
          prefetch in the sync tick fills that in over time, see prefetchArtwork(). */}
      <CastStrip
        heading={t('cast.topHeading')}
        cast={topCast.map((person) => ({
          ...person,
          // The strip's second line is whatever describes the person here; for one title
          // that is the role, for a ranking it is how often they turned up.
          character: t('cast.inTitles', { titles: person.titles, plays: person.plays }),
        }))}
      />
    </>
  );
}
