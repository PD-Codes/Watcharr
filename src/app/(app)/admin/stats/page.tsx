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

export const dynamic = 'force-dynamic';

export default async function AdminStatsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; by?: string }>;
}) {
  const session = await requireAdmin();
  const settings = await getSettings();
  if (!isEnabled(settings.features, 'serverWideStats')) notFound();
  const params = await searchParams;
  const days = Number(params.days ?? 30);
  const by: RankBy = params.by === 'time' ? 'time' : 'count';
  const rank = by === 'time' ? formatMinutes : (value: number) => `${value} plays`;
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
      <p className="eyebrow">Admin</p>
      <h1>Server Statistics</h1>
      <p className="subtitle">Usage across all users.</p>

      <form className="filters">
        {/* Keeps the ranking metric when only the period is submitted. */}
        <input type="hidden" name="by" value={by} />
        <label>
          Period
          <select name="days" defaultValue={String(days)}>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="365">Last year</option>
          </select>
        </label>
        <button>Apply</button>
      </form>

      <div className="grid cols-4">
        <StatCard
          label="Watch time"
          value={formatDuration(totals.watchtimeMs)}
          hint={`in the last ${days} days`}
          trend={trend}
          spark={daily.map((day) => day.value)}
          info="Sum of the runtime of every play by every user in the period. The arrow compares it with the period before."
        />
        <StatCard
          label="Plays"
          value={String(totals.plays)}
          hint={`${totals.movies} movies · ${totals.episodes} episodes`}
        />
        <StatCard
          label="Library items"
          value={String(library.length)}
          info="Movies and series reported by the media server, cached for five minutes."
        />
        <StatCard
          label="Peak hour"
          value={busiestHour ? `${busiestHour.label}:00` : '—'}
          info="Hour of the day with the most playback starts."
        />
        <StatCard
          label="Users with plays"
          value={String(leaderboard.filter((entry) => entry.value > 0).length)}
          href="/admin/users"
          info="Users that have at least one recorded playback. Opens the user list."
        />
        <StatCard
          label="Distinct titles"
          value={String(highlights.distinctTitles)}
          info="Different movies and shows watched server-wide."
        />
        <StatCard label="Average play" value={formatDuration(highlights.averagePlayMs)} />
        <StatCard
          label="Binge record"
          value={records.bingeCount ? `${records.bingeCount}×` : '—'}
          hint={records.bingeTitle ?? undefined}
          info="Most plays of one title by anyone within a single day."
        />
        <StatCard
          label="Busiest day"
          value={highlights.busiestDay ? formatMinutes(highlights.busiestDay.minutes) : '—'}
          hint={highlights.busiestDay?.day}
        />
        <StatCard
          label="Peak concurrent"
          value={String(peak.streams)}
          hint={
            peak.streams
              ? `${peak.transcodes} transcode · ${peak.directPlays} direct play`
              : undefined
          }
          info="The most streams that ever overlapped in this period, and how they were being delivered at that moment."
        />
        <StatCard
          label="Completion rate"
          value={completion.rate === null ? '—' : `${completion.rate}%`}
          hint={`${completion.finished} of ${completion.finished + completion.abandoned} sessions`}
          info={`Streams that reached ${settings.watchedThreshold}% of the runtime. Recorded sessions only, so it starts from the day Watcharr was installed.`}
        />
      </div>

      <section className="section">
        <h2>Daily activity (minutes)</h2>
        <div className="card">
          <AreaChart data={daily} format={formatMinutes} />
        </div>
      </section>

      <section className="section">
        <h2>When the server is busy</h2>
        <div className="card">
          <WeekHourGrid data={weekGrid} format={formatMinutes} />
        </div>
      </section>

      <section className="section">
        <h2>Watch time per user</h2>
        <div className="card">
          <BarChart
            data={leaderboard}
            format={formatMinutes}
            hrefFor={(label) => `/admin/users/${userIdByName.get(label) ?? ''}`}
          />
        </div>
      </section>

      <div className="section toolbar">
        <h2 style={{ margin: 0 }}>Top lists</h2>
        <RankToggle base="/admin/stats" by={by} days={days} />
      </div>

      <div className="grid cols-2">
        <section>
          <h2>Titles</h2>
          <div className="card">
            <BarChart data={titles} format={rank} hrefFor={titleHref} />
          </div>
        </section>
        <section>
          <h2>Genres</h2>
          <div className="card">
            <BarChart data={genres} format={rank} />
          </div>
        </section>
      </div>

      <div className="grid cols-2 section">
        <section>
          <h2>Devices</h2>
          <div className="card">
            <BarChart data={devices} format={rank} />
          </div>
        </section>
        <section>
          <h2>Clients</h2>
          <div className="card">
            <BarChart
              data={clients}
              format={by === 'time' ? formatMinutes : (v) => `${v} sessions`}
            />
          </div>
        </section>
      </div>

      <div className="grid cols-2 section">
        <section>
          <h2>Peak hours</h2>
          <div className="card">
            <ColumnChart data={hours} format={(v) => `${v} plays`} labelEvery={2} />
          </div>
        </section>
        <section>
          <h2>Genre share</h2>
          <div className="card">
            <DonutChart data={genres.slice(0, 5)} format={rank} />
          </div>
        </section>
      </div>

      <section className="section">
        <h2>By weekday (minutes)</h2>
        <div className="card">
          <ColumnChart data={weekdays} format={formatMinutes} />
        </div>
      </section>
    </>
  );
}
