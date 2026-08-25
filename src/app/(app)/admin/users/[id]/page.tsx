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
import IpLink from '@/components/IpLink';
import RevokeSessionButton from '@/components/RevokeSessionButton';
import { getUserAddresses, getUserPlayers } from '@/server/playback';
import { canSee, listUserSessions, requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireAdmin();
  const userId = Number((await params).id);
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  // 404 rather than 403: a server admin should not learn that an account exists on another
  // server just because the page refuses to show it.
  if (!user || !canSee(session.user, user)) notFound();

  const scope = { userId };
  const [totals, daily, weekdays, genres, titles, devices, highlights, recent, sessions, addresses, players] = await Promise.all([
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
    listUserSessions(userId),
    getUserAddresses(userId),
    getUserPlayers(userId),
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

      <div className="grid cols-2 section">
        <section>
          <h2>Players</h2>
          <div className="card">
            <BarChart data={players} format={(v) => `${v} sessions`} />
          </div>
        </section>
        <section>
          <h2>Addresses</h2>
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Address</th>
                  <th scope="col">Last streamed</th>
                  <th scope="col">Plays</th>
                </tr>
              </thead>
              <tbody>
                {addresses.map((row) => (
                  <tr key={row.ip}>
                    <td>
                      <IpLink ip={row.ip} />
                      <div className="muted" style={{ fontSize: 12 }}>
                        {row.isLocal ? 'LAN' : 'WAN'}
                        {row.lastPlayer ? ` · ${row.lastPlayer}` : ''}
                      </div>
                    </td>
                    <td className="muted">{formatDate(row.lastSeen)}</td>
                    <td className="num">{row.plays}</td>
                  </tr>
                ))}
                {addresses.length === 0 && (
                  <tr>
                    <td colSpan={3} className="muted">
                      No streams recorded yet. Addresses come from playback sessions, which
                      start collecting from the day Watcharr was installed.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="section">
        <h2>Active sessions</h2>
        <div className="table-wrap card">
          <table>
            <thead>
              <tr>
                <th scope="col">Signed in</th>
                <th scope="col">Expires</th>
                <th scope="col"></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>{formatDate(s.createdAt)}</td>
                  <td>{formatDate(s.expiresAt)}</td>
                  <td>
                    <RevokeSessionButton id={s.id} />
                  </td>
                </tr>
              ))}
              {sessions.length === 0 && (
                <tr>
                  <td colSpan={3} className="muted">
                    No active sessions.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

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
