import Link from 'next/link';
import { notFound } from 'next/navigation';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { users, watchHistory } from '@/db/schema';
import { BarChart, ColumnChart, StatCard } from '@/components/Charts';
import { formatDate, formatDuration, formatMinutes } from '@/components/format';
import {
  getDailyActivity,
  getHighlights,
  getTopDevices,
  getTopGenres,
  getTopTitles,
  getTotals,
  getWeekdayActivity,
} from '@/server/stats';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdmin();
  const userId = Number((await params).id);
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) notFound();

  const scope = { userId };
  const [totals, daily, weekdays, genres, titles, devices, highlights, recent] = await Promise.all([
    getTotals(scope),
    getDailyActivity(scope, 30),
    getWeekdayActivity(scope),
    getTopGenres(scope),
    getTopTitles(scope),
    getTopDevices(scope),
    getHighlights(scope),
    db
      .select()
      .from(watchHistory)
      .where(eq(watchHistory.userId, userId))
      .orderBy(desc(watchHistory.watchedAt))
      .limit(25),
  ]);

  return (
    <>
      <h1>{user.username}</h1>
      <p className="subtitle">
        {user.isAdmin ? 'Administrator' : 'User'} ·{' '}
        {user.lastSeenAt ? `last seen ${formatDate(user.lastSeenAt)}` : 'never signed in'}
      </p>

      <div className="grid cols-4">
        <StatCard
          label="Watch time"
          value={formatDuration(totals.watchtimeMs)}
          info="Sum of the runtime of every recorded play."
        />
        <StatCard label="Plays" value={String(totals.plays)} hint={`${totals.activeDays} active days`} />
        <StatCard label="Movies" value={String(totals.movies)} />
        <StatCard label="Episodes" value={String(totals.episodes)} />
        <StatCard
          label="Distinct titles"
          value={String(highlights.distinctTitles)}
          info="Different movies and shows, episodes grouped under their show."
        />
        <StatCard
          label="Longest streak"
          value={`${highlights.longestStreak} d`}
          info="Longest run of consecutive days with at least one play."
        />
        <StatCard label="Average play" value={formatDuration(highlights.averagePlayMs)} />
        <StatCard
          label="Busiest day"
          value={highlights.busiestDay ? formatMinutes(highlights.busiestDay.minutes) : '—'}
          hint={highlights.busiestDay?.day}
        />
      </div>

      <section className="section">
        <h2>Last 30 days (minutes)</h2>
        <div className="card">
          <ColumnChart data={daily} format={formatMinutes} labelEvery={3} />
        </div>
      </section>

      <div className="grid cols-2 section">
        <section>
          <h2>Top genres</h2>
          <div className="card">
            <BarChart data={genres} format={(v) => `${v} plays`} />
          </div>
        </section>
        <section>
          <h2>Top titles</h2>
          <div className="card">
            <BarChart
              data={titles}
              format={(v) => `${v} plays`}
              hrefFor={(label) => `/title/${encodeURIComponent(label)}?scope=server`}
            />
          </div>
        </section>
      </div>

      <div className="grid cols-2 section">
        <section>
          <h2>By weekday (minutes)</h2>
          <div className="card">
            <ColumnChart data={weekdays} format={formatMinutes} />
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
        <h2>Recent history</h2>
        <div className="table-wrap card">
          <table>
            <thead>
              <tr>
                <th scope="col">Watched</th>
                <th scope="col">Title</th>
                <th scope="col">Duration</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((row) => (
                <tr key={row.id}>
                  <td>{formatDate(row.watchedAt)}</td>
                  <td>
                    <Link href={`/title/${encodeURIComponent(row.grandparentTitle ?? row.title)}?scope=server`}>
                      {row.grandparentTitle ? `${row.grandparentTitle} — ${row.title}` : row.title}
                    </Link>
                  </td>
                  <td>{formatDuration(row.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
