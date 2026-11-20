import Link from 'next/link';
import { AreaChart, BarChart, ColumnChart, DonutChart, StatCard, WeekHourGrid } from '@/components/Charts';
import { formatDuration, formatMinutes, localizeWeekdays, mediaSplit, titleHref } from '@/components/format';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { users } from '@/db/schema';
import {
  getDailyActivity,
  getHighlights,
  getPeakHours,
  getTopDevices,
  getTopGenres,
  getTopTitles,
  getTotals,
  getRecords,
  getTrend,
  getUserLeaderboard,
  getWeekdayActivity,
  getWeekHourGrid,
  type RankBy,
} from '@/server/stats';
import {
  getClientSessions,
  getClientWatchtime,
  getCompletionSplit,
  getConcurrencyPeak,
} from '@/server/playback';
import RankToggle from '@/components/RankToggle';
import { notFound } from 'next/navigation';
import { getSettings } from '@/server/config';
import { isEnabled } from '@/server/features';
import { getLibrary, getSections } from '@/server/library';
import { adminScope, requireAdmin } from '@/server/session';
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

const PERIODS = [7, 30, 90, 365];

export default async function AdminStatsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; by?: string }>;
}) {
  const session = await requireAdmin();
  const t = await getT();
  const settings = await getSettings();
  if (!isEnabled(settings.features, 'serverWideStats')) notFound();
  const params = await searchParams;
  const requested = Number(params.days ?? 30);
  // Whitelisted: the period bar is the only producer, and any other number would size the calendar CTE.
  const days = PERIODS.includes(requested) ? requested : 30;
  const by: RankBy = params.by === 'time' ? 'time' : 'count';
  const rank =
    by === 'time' ? formatMinutes : (value: number) => t('common.plays', { count: value });
  const scope = adminScope(session.user);
  // A server admin sees their own server only; a global admin sees everything.
  const onlyServer = session.user.globalAdmin ? undefined : session.user.serverId;

  const [totals, daily, weekdays, genres, titles, devices, hours, leaderboard, highlights, library, userRows] =
    await Promise.all([
      getTotals(scope, days),
      getDailyActivity(scope, days),
      getWeekdayActivity(scope, days),
      getTopGenres(scope, 8, by, days),
      getTopTitles(scope, 8, by, days),
      getTopDevices(scope, 8, by, days),
      getPeakHours(scope, days),
      getUserLeaderboard(onlyServer, 10, days),
      getHighlights(scope, days),
      getLibrary(session.user.serverId).catch(() => []),
      onlyServer === undefined
        ? db.select({ id: users.id, username: users.username }).from(users)
        : db
            .select({ id: users.id, username: users.username })
            .from(users)
            .where(eq(users.serverId, onlyServer)),
    ]);

  // Clients are recorded per session, so they come from playback_sessions rather than
  // from the history — same toggle, different table.
  const completion = await getCompletionSplit(settings.watchedThreshold, days, scope);
  const clients = await (by === 'time'
    ? getClientWatchtime(days, scope)
    : getClientSessions(days, scope));

  const [trend, weekGrid, records, peak] = await Promise.all([
    getTrend(scope, days),
    getWeekHourGrid(scope, days),
    getRecords(scope, days),
    getConcurrencyPeak(days, scope),
  ]);

  // Library items hold films and series only; music and audiobooks come as track counts per library.
  const audioTracks = (await getSections(session.user.serverId).catch(() => []))
    .filter((section) => section.mediaType === 'audio')
    .reduce((sum, section) => sum + section.itemCount, 0);
  const libraryMovies = library.filter((item) => item.mediaType === 'movie').length;

  const userIdByName = new Map(userRows.map((user) => [user.username, user.id]));

  const busiestHour = hours.reduce((best, h) => (h.value > best.value ? h : best), hours[0]);

  return (
    <>
      <p className="eyebrow">{t('nav.admin')}</p>
      <h1>{t('serverstats.title')}</h1>
      <p className="subtitle">{t('serverstats.subtitle')}</p>

      {/* One tap per period instead of select-then-apply; the ranking metric comes along. */}
      <div className="seg" style={{ marginBottom: 22 }}>
        {PERIODS.map((period) => (
          <Link
            key={period}
            href={`/admin/stats?days=${period}&by=${by}`}
            className={days === period ? 'on' : undefined}
            aria-current={days === period ? 'true' : undefined}
          >
            {period === 365 ? t('common.lastYear') : t('common.days', { count: period })}
          </Link>
        ))}
      </div>

      <div className="grid cols-4">
        <StatCard
          label={t('common.watchTime')}
          value={formatDuration(totals.watchtimeMs)}
          hint={t('serverstats.watchTimeHint', { days })}
          trend={trend}
          spark={daily.map((day) => day.value)}
          info={t('serverstats.watchTimeInfo')}
        />
        <StatCard
          label={t('serverstats.plays')}
          value={String(totals.plays)}
          hint={mediaSplit(t, {
            movies: totals.movies,
            episodes: totals.episodes,
            audio: totals.audio,
            total: totals.plays,
          })}
        />
        <StatCard
          label={t('serverstats.libraryItems')}
          value={String(library.length + audioTracks)}
          hint={mediaSplit(t, {
            movies: libraryMovies,
            shows: library.length - libraryMovies,
            audio: audioTracks,
          })}
          info={t('serverstats.libraryItemsInfo')}
        />
        <StatCard
          label={t('serverstats.peakHour')}
          value={busiestHour ? `${busiestHour.label}:00` : '—'}
          info={t('serverstats.peakHourInfo')}
        />
        <StatCard
          label={t('serverstats.usersWithPlays')}
          value={String(leaderboard.filter((entry) => entry.value > 0).length)}
          href="/admin/users"
          info={t('serverstats.usersWithPlaysInfo')}
        />
        <StatCard
          label={t('serverstats.distinctTitles')}
          value={String(highlights.distinctTitles)}
          info={t('serverstats.distinctTitlesInfo')}
        />
        <StatCard
          label={t('serverstats.averagePlay')}
          value={formatDuration(highlights.averagePlayMs)}
        />
        <StatCard
          label={t('stats.bingeRecord')}
          value={records.bingeCount ? `${records.bingeCount}×` : '—'}
          hint={records.bingeTitle ?? undefined}
          info={t('serverstats.bingeInfo')}
        />
        <StatCard
          label={t('stats.busiestDay')}
          value={highlights.busiestDay ? formatMinutes(highlights.busiestDay.minutes) : '—'}
          hint={highlights.busiestDay?.day}
        />
        <StatCard
          label={t('serverstats.peakConcurrent')}
          value={String(peak.streams)}
          hint={
            peak.streams
              ? t('serverstats.peakConcurrentHint', {
                  transcodes: peak.transcodes,
                  direct: peak.directPlays,
                })
              : undefined
          }
          info={t('serverstats.peakConcurrentInfo')}
        />
        <StatCard
          label={t('serverstats.completionRate')}
          value={completion.rate === null ? '—' : `${completion.rate}%`}
          hint={t('serverstats.completionHint', {
            finished: completion.finished,
            total: completion.finished + completion.abandoned,
          })}
          info={t('serverstats.completionInfo', { percent: settings.watchedThreshold })}
        />
      </div>

      <section className="section">
        <h2>{t('stats.dailyActivity')}</h2>
        <div className="card">
          <AreaChart data={daily} format={formatMinutes} />
        </div>
      </section>

      <section className="section">
        <h2>{t('serverstats.serverBusy')}</h2>
        <div className="card">
          <WeekHourGrid data={weekGrid} format={formatMinutes} />
        </div>
      </section>

      <section className="section">
        <h2>{t('serverstats.watchTimePerUser')}</h2>
        <div className="card">
          <BarChart
            data={leaderboard}
            format={formatMinutes}
            hrefFor={(label) => `/admin/users/${userIdByName.get(label) ?? ''}`}
          />
        </div>
      </section>

      <div className="section toolbar">
        <h2 style={{ margin: 0 }}>{t('stats.topLists')}</h2>
        <RankToggle base="/admin/stats" by={by} days={days} />
      </div>

      <div className="grid cols-2">
        <section>
          <h2>{t('stats.titles')}</h2>
          <div className="card">
            <BarChart data={titles} format={rank} hrefFor={(label) => titleHref(label, true)} />
          </div>
        </section>
        <section>
          <h2>{t('common.genres')}</h2>
          <div className="card">
            <BarChart data={genres} format={rank} />
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
          <h2>{t('serverstats.clients')}</h2>
          <div className="card">
            <BarChart
              data={clients}
              format={
                by === 'time' ? formatMinutes : (v) => t('common.sessions', { count: v })
              }
            />
          </div>
        </section>
      </div>

      <div className="grid cols-2 section">
        <section>
          <h2>{t('serverstats.peakHours')}</h2>
          <div className="card">
            <ColumnChart
              data={hours}
              format={(v) => t('common.plays', { count: v })}
              labelEvery={2}
            />
          </div>
        </section>
        <section>
          <h2>{t('serverstats.genreShare')}</h2>
          <div className="card">
            <DonutChart data={genres.slice(0, 5)} format={rank} />
          </div>
        </section>
      </div>

      <section className="section">
        <h2>{t('stats.byWeekday')}</h2>
        <div className="card">
          <ColumnChart data={localizeWeekdays(weekdays, t)} format={formatMinutes} />
        </div>
      </section>
    </>
  );
}
