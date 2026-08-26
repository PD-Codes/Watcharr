import { AreaChart, BarChart, ColumnChart, DonutChart, StatCard, WeekHourGrid } from '@/components/Charts';
import { formatDuration, formatMinutes } from '@/components/format';
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
import { getLibrary } from '@/server/library';
import { adminScope, requireAdmin } from '@/server/session';
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

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
  const days = Number(params.days ?? 30);
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
      getWeekdayActivity(scope),
      getTopGenres(scope, 8, by),
      getTopTitles(scope, 8, by),
      getTopDevices(scope, 8, by),
      getPeakHours(scope),
      getUserLeaderboard(onlyServer),
      getHighlights(scope),
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
    getWeekHourGrid(scope),
    getRecords(scope),
    getConcurrencyPeak(days, scope),
  ]);

  const userIdByName = new Map(userRows.map((user) => [user.username, user.id]));
  const titleHref = (label: string) => `/title/${encodeURIComponent(label)}?scope=server`;

  const busiestHour = hours.reduce((best, h) => (h.value > best.value ? h : best), hours[0]);

  return (
    <>
      <p className="eyebrow">{t('nav.admin')}</p>
      <h1>{t('serverstats.title')}</h1>
      <p className="subtitle">{t('serverstats.subtitle')}</p>

      <form className="filters">
        {/* Keeps the ranking metric when only the period is submitted. */}
        <input type="hidden" name="by" value={by} />
        <label>
          {t('serverstats.period')}
          <select name="days" defaultValue={String(days)}>
            <option value="7">{t('serverstats.last7')}</option>
            <option value="30">{t('serverstats.last30')}</option>
            <option value="90">{t('serverstats.last90')}</option>
            <option value="365">{t('common.lastYear')}</option>
          </select>
        </label>
        <button>{t('action.apply')}</button>
      </form>

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
          hint={t('serverstats.playsHint', { movies: totals.movies, episodes: totals.episodes })}
        />
        <StatCard
          label={t('serverstats.libraryItems')}
          value={String(library.length)}
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
            <BarChart data={titles} format={rank} hrefFor={titleHref} />
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
          <ColumnChart data={weekdays} format={formatMinutes} />
        </div>
      </section>
    </>
  );
}
