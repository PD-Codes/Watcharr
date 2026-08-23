import { AreaChart, BarChart, ColumnChart, DonutChart, StatCard, WeekHourGrid } from '@/components/Charts';
import { formatDuration, formatMinutes } from '@/components/format';
import { db } from '@/db';
import { users } from '@/db/schema';
import {
  getDailyActivity,
  getHighlights,
  getPeakHours,
  getTopDevices,
  getTopGenres,
  getTopTitles,
  getTopTitlesByTime,
  getTotals,
  getRecords,
  getTrend,
  getUserLeaderboard,
  getWeekdayActivity,
  getWeekHourGrid,
} from '@/server/stats';
import { notFound } from 'next/navigation';
import { getConfig } from '@/server/config';
import { isEnabled } from '@/server/features';
import { getLibrary } from '@/server/library';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

export default async function AdminStatsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  await requireAdmin();
  const config = await getConfig();
  if (!isEnabled(config?.features ?? null, 'serverWideStats')) notFound();
  const days = Number((await searchParams).days ?? 30);
  const scope = { userId: null as null };

  const [totals, daily, weekdays, genres, titles, titlesByTime, devices, hours, leaderboard, highlights, library, userRows] =
    await Promise.all([
      getTotals(scope, days),
      getDailyActivity(scope, days),
      getWeekdayActivity(scope),
      getTopGenres(scope),
      getTopTitles(scope),
      getTopTitlesByTime(scope),
      getTopDevices(scope),
      getPeakHours(scope),
      getUserLeaderboard(),
      getHighlights(scope),
      getLibrary().catch(() => []),
      db.select({ id: users.id, username: users.username }).from(users),
    ]);

  const [trend, weekGrid, records] = await Promise.all([
    getTrend(scope, days),
    getWeekHourGrid(scope),
    getRecords(scope),
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

      <div className="grid cols-2 section">
        <section>
          <h2>Watch time per user</h2>
          <div className="card">
            <BarChart
              data={leaderboard}
              format={formatMinutes}
              hrefFor={(label) => `/admin/users/${userIdByName.get(label) ?? ''}`}
            />
          </div>
        </section>
        <section>
          <h2>Most played titles</h2>
          <div className="card">
            <BarChart data={titles} format={(v) => `${v} plays`} hrefFor={titleHref} />
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
          <h2>Top genres</h2>
          <div className="card">
            <DonutChart data={genres.slice(0, 5)} format={(v) => `${v} plays`} />
          </div>
        </section>
      </div>

      <div className="grid cols-2 section">
        <section>
          <h2>Most watch time</h2>
          <div className="card">
            <BarChart data={titlesByTime} format={formatMinutes} hrefFor={titleHref} />
          </div>
        </section>
        <section>
          <h2>Devices</h2>
          <div className="card">
            <BarChart data={devices} format={formatMinutes} />
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
