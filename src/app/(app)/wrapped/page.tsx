import Link from 'next/link';
import { BarChart, ColumnChart, DonutChart, Heatmap, StatCard } from '@/components/Charts';
import { formatDate, formatDuration, formatMinutes } from '@/components/format';
import { getWrapped, getWrappedYears } from '@/server/wrapped';
import { syncHistory } from '@/server/sync';
import { requireUser } from '@/server/session';

export const dynamic = 'force-dynamic';

export default async function WrappedPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>;
}) {
  const session = await requireUser();
  await syncHistory(session.user.id, session.user.serverUserId, session.serverToken).catch(() => {});

  const years = await getWrappedYears(session.user.id);
  const requested = Number((await searchParams).year);
  const year = years.includes(requested) ? requested : (years[0] ?? new Date().getFullYear());
  const wrapped = await getWrapped(session.user.id, year);

  const topWeekday = wrapped.weekdays.reduce(
    (best, day) => (day.value > best.value ? day : best),
    wrapped.weekdays[0],
  );

  return (
    <>
      <div className="wrapped-hero">
        <p className="year">{year}</p>
        <h1>Your Year in Review</h1>
        <p className="subtitle">Everything you watched, counted.</p>
        {years.length > 1 && (
          <div className="row" style={{ justifyContent: 'center', marginTop: 20 }}>
            <div className="seg">
              {years.map((option) => (
                <Link
                  key={option}
                  href={`/wrapped?year=${option}`}
                  className={option === year ? 'on' : undefined}
                >
                  {option}
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>

      {wrapped.plays === 0 ? (
        <p className="muted">Nothing was watched in {year}.</p>
      ) : (
        <>
          <div className="grid cols-4">
            <StatCard
              label="Watch time"
              value={formatDuration(wrapped.watchtimeMs)}
              href={`/stats?days=365`}
              info="Sum of the runtime of everything you played this year. Opens the statistics."
            />
            <StatCard label="Plays" value={String(wrapped.plays)} href="/history" />
            <StatCard
              label="Titles"
              value={String(wrapped.distinctTitles)}
              info="Different movies and shows, episodes grouped under their show."
            />
            <StatCard
              label="Active days"
              value={String(wrapped.activeDays)}
              hint={`longest streak: ${wrapped.longestStreak} days`}
            />
          </div>

          <div className="grid cols-2 section">
            <section>
              <h2>First play of the year</h2>
              <div className="card">
                {wrapped.firstPlay ? (
                  <>
                    <Link href={`/title/${encodeURIComponent(wrapped.firstPlay.label)}`}>
                      {wrapped.firstPlay.label}
                    </Link>
                    {wrapped.firstPlay.title !== wrapped.firstPlay.label && (
                      <p className="muted" style={{ margin: '2px 0 0' }}>{wrapped.firstPlay.title}</p>
                    )}
                    <p className="muted">{formatDate(wrapped.firstPlay.watchedAt)}</p>
                  </>
                ) : (
                  <p className="muted">No plays.</p>
                )}
              </div>
            </section>
            <section>
              <h2>Last play of the year</h2>
              <div className="card">
                {wrapped.lastPlay ? (
                  <>
                    <Link href={`/title/${encodeURIComponent(wrapped.lastPlay.label)}`}>
                      {wrapped.lastPlay.label}
                    </Link>
                    {wrapped.lastPlay.title !== wrapped.lastPlay.label && (
                      <p className="muted" style={{ margin: '2px 0 0' }}>{wrapped.lastPlay.title}</p>
                    )}
                    <p className="muted">{formatDate(wrapped.lastPlay.watchedAt)}</p>
                  </>
                ) : (
                  <p className="muted">No plays.</p>
                )}
              </div>
            </section>
          </div>

          {wrapped.topGenres[0] && (
            <section className="section">
              <h2>
                You are a {wrapped.topGenres[0].label} fan — {wrapped.topGenreShare}% of everything
                you watched
              </h2>
              <div className="card">
                <BarChart
                  data={wrapped.topGenres}
                  format={(value) => `${value} plays`}
                  hrefFor={(label) => `/history?genre=${encodeURIComponent(label)}`}
                />
              </div>
            </section>
          )}

          <section className="section">
            <h2>Most plays of the year</h2>
            <div className="card">
              {wrapped.topTitles.map((title, index) => (
                <Link
                  key={title.label}
                  className="wrapped-rank"
                  href={`/title/${encodeURIComponent(title.label)}`}
                >
                  <span className="rank">{String(index + 1).padStart(2, '0')}</span>
                  <span>
                    {title.label}
                    <br />
                    <span className="muted">{formatMinutes(title.minutes)}</span>
                  </span>
                  <span className="muted">{title.plays} plays</span>
                </Link>
              ))}
            </div>
          </section>

          <section className="section">
            <h2>Your year in days</h2>
            <div className="card">
              <p className="muted" style={{ marginTop: 0 }}>
                {wrapped.activeDays} days with activity. Tap a frame to see what ran that day.
              </p>
              <Heatmap
                data={wrapped.calendar}
                format={formatMinutes}
                hrefFor={(day) => `/history?date=${day}`}
              />
              <p className="scroll-hint">Swipe the strip sideways.</p>
            </div>
          </section>

          <div className="grid cols-2 section">
            <section>
              <h2>{topWeekday?.label} took the crown</h2>
              <div className="card">
                <ColumnChart data={wrapped.weekdays} format={formatMinutes} />
              </div>
            </section>
            <section>
              <h2>Movies vs. episodes</h2>
              <div className="card">
                <DonutChart
                  data={[
                    { label: 'Movies', value: wrapped.movies },
                    { label: 'Episodes', value: wrapped.episodes },
                  ]}
                  format={(value) => `${value} plays`}
                />
              </div>
            </section>
          </div>

          {wrapped.devices.length > 0 && (
            <section className="section">
              <h2>Where you watched</h2>
              <div className="card">
                <BarChart data={wrapped.devices} format={formatMinutes} />
              </div>
            </section>
          )}
        </>
      )}
    </>
  );
}
