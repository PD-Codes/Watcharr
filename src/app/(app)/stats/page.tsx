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
  getTopTitlesByTime,
  getTotals,
  getTrend,
  getWeekdayActivity,
  getWeekHourGrid,
} from '@/server/stats';
import {
  getBitrateBuckets,
  getClientSessions,
  getDeviceSessions,
  getPlaybackTotals,
  getPlayMethods,
  getResolutions,
  getTranscodeReasons,
  getVideoCodecs,
} from '@/server/playback';
import { getLibrary } from '@/server/library';
import { syncHistory } from '@/server/sync';
import { requireUser } from '@/server/session';

export const dynamic = 'force-dynamic';

const titleHref = (label: string) => `/title/${encodeURIComponent(label)}`;
const genreHref = (label: string) => `/history?genre=${encodeURIComponent(label)}`;
const dayHref = (day: string) => `/history?date=${day}`;
const PERIODS: [number, string][] = [
  [7, '7 days'],
  [30, '30 days'],
  [90, '90 days'],
  [365, 'Last year'],
];

export default async function StatsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const session = await requireUser();
  await syncHistory(session.user.id, session.user.serverUserId, session.serverToken).catch(() => {});

  const days = Number((await searchParams).days ?? 30);
  const scope = { userId: session.user.id };
  const year = new Date().getFullYear();

  const [
    totals,
    trend,
    daily,
    monthly,
    weekdays,
    weekGrid,
    genres,
    titles,
    titlesByTime,
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
    getTopGenres(scope),
    getTopTitles(scope),
    getTopTitlesByTime(scope),
    getTopDevices(scope),
    getPeakHours(scope),
    getStreak(scope),
    getHighlights(scope),
    getRecords(scope),
    getRewatchSplit(scope),
    getLibrary().catch(() => []),
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

  const busiestHour = hours.reduce((best, hour) => (hour.value > best.value ? hour : best), hours[0]);
  // The library lists movies and series, so coverage has to compare titles with titles —
  // counting individual episodes against it produced percentages far above 100.
  const coverage = library.length
    ? Math.min(100, Math.round((highlights.distinctTitles / library.length) * 100))
    : null;

  return (
    <>
      <p className="eyebrow">You</p>
      <h1>Statistics</h1>
      <p className="subtitle">
        Your viewing habits. Hover anything for the exact number; a title, a genre, a day or
        an hour opens the plays behind it.
      </p>

      {/* One tap per period instead of select-then-submit, which needed three on a phone. */}
      <div className="seg" style={{ marginBottom: 22 }}>
        {PERIODS.map(([value, label]) => (
          <Link key={value} href={`/stats?days=${value}`} className={days === value ? 'on' : undefined}>
            {label}
          </Link>
        ))}
      </div>

      <div className="grid cols-4">
        <StatCard
          label="Watch time"
          value={formatDuration(totals.watchtimeMs)}
          hint={`last ${days} days`}
          trend={trend}
          spark={daily.map((day) => day.value)}
          info="Sum of the runtime of every play in the period. The arrow compares it with the period before."
        />
        <StatCard
          label="Plays"
          value={String(totals.plays)}
          hint={`${totals.movies} movies · ${totals.episodes} episodes`}
        />
        <StatCard
          label="Active days"
          value={`${totals.activeDays} / ${days}`}
          info="Days in the period with at least one play."
        />
        <StatCard
          label="Current streak"
          value={`${streak} d`}
          hint={`longest: ${highlights.longestStreak} d`}
          info="Consecutive days with at least one play, counting back from today."
        />
      </div>

      <div className="grid cols-4 section">
        <StatCard
          label="Busiest day"
          value={highlights.busiestDay ? formatMinutes(highlights.busiestDay.minutes) : '—'}
          hint={highlights.busiestDay?.day}
          href={highlights.busiestDay ? dayHref(highlights.busiestDay.day) : undefined}
          info="The single day with the most watch time in your whole history. Opens that day."
        />
        <StatCard
          label="Longest play"
          value={formatDuration(records.longestPlayMs)}
          info="Runtime of the longest single thing you watched."
        />
        <StatCard
          label="Binge record"
          value={records.bingeCount ? `${records.bingeCount}×` : '—'}
          hint={records.bingeTitle ? `${records.bingeTitle} · ${records.bingeDay}` : undefined}
          info="Most plays of one title within a single day."
        />
        <StatCard
          label="Library explored"
          value={coverage === null ? '—' : `${coverage}%`}
          hint={
            coverage === null ? undefined : `${highlights.distinctTitles} of ${library.length} titles`
          }
          info="Share of the movies and series in your libraries that you have started at least once."
        />
      </div>

      <section className="section">
        <h2>Daily activity (minutes)</h2>
        <div className="card">
          <AreaChart data={daily} format={formatMinutes} />
        </div>
      </section>

      <section className="section">
        <h2>When you watch</h2>
        <div className="card">
          <p className="muted" style={{ margin: '0 0 14px' }}>
            Minutes per weekday and hour, across your whole history. Click a cell to see what
            was playing in that slot.
          </p>
          <WeekHourGrid
            data={weekGrid}
            format={formatMinutes}
            hrefFor={(dayIndex, hour) => `/history?weekday=${dayIndex}&hour=${hour}`}
          />
          <p className="scroll-hint">Swipe sideways for the rest of the day.</p>
        </div>
      </section>

      <div className="grid cols-2 section">
        <section>
          <h2>Most played titles</h2>
          <div className="card">
            <BarChart data={titles} format={(value) => `${value} plays`} hrefFor={titleHref} />
          </div>
        </section>
        <section>
          <h2>Most watch time</h2>
          <div className="card">
            <BarChart data={titlesByTime} format={formatMinutes} hrefFor={titleHref} />
          </div>
        </section>
      </div>

      <div className="grid cols-2 section">
        <section>
          <h2>Top genres</h2>
          <div className="card">
            <BarChart data={genres} format={(value) => `${value} plays`} hrefFor={genreHref} />
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
          <h2>By weekday (minutes)</h2>
          <div className="card">
            <ColumnChart data={weekdays} format={formatMinutes} />
          </div>
        </section>
        <section>
          <h2>By hour of day</h2>
          <div className="card">
            <ColumnChart data={hours} format={(value) => `${value} plays`} labelEvery={2} />
          </div>
        </section>
      </div>

      <section className="section">
        <h2>{year} by month (minutes)</h2>
        <div className="card">
          <ColumnChart data={monthly} format={formatMinutes} />
        </div>
      </section>

      <section className="section">
        <h2>Your last 365 days</h2>
        <div className="card">
          <Heatmap data={yearDays} format={formatMinutes} hrefFor={dayHref} />
          <p className="scroll-hint">Swipe the strip sideways, tap a frame for that day.</p>
        </div>
      </section>

      <div className="grid cols-2 section">
        <section>
          <h2>Movies vs. episodes</h2>
          <div className="card">
            <DonutChart
              data={[
                { label: 'Movies', value: totals.movies },
                { label: 'Episodes', value: totals.episodes },
              ]}
              format={(value) => `${value} plays`}
            />
          </div>
        </section>
        <section>
          <h2>New vs. rewatched</h2>
          <div className="card">
            <DonutChart
              data={[
                { label: 'First watch', value: rewatch.fresh },
                { label: 'Rewatch', value: rewatch.rewatch },
              ]}
              format={(value) => `${value} plays`}
            />
          </div>
        </section>
      </div>

      <h2 className="section" style={{ marginBottom: 4 }}>
        How your streams were delivered
      </h2>
      <p className="subtitle" style={{ marginTop: 0 }}>
        Recorded from your own sessions since {formatDate(records.lastPlayAt ?? new Date())} —
        {' '}
        {playback.sessions} sessions so far.
      </p>

      <div className="grid cols-2">
        <section>
          <h2>Playback method</h2>
          <div className="card">
            <DonutChart data={methods} format={(value) => `${value} sessions`} />
          </div>
        </section>
        <section>
          <h2>Why content was transcoded</h2>
          <div className="card">
            <BarChart data={reasons} format={(value) => `${value} sessions`} />
          </div>
        </section>
      </div>

      <div className="grid cols-2 section">
        <section>
          <h2>Your clients</h2>
          <div className="card">
            <BarChart data={clients} format={(value) => `${value} sessions`} />
          </div>
        </section>
        <section>
          <h2>Your devices</h2>
          <div className="card">
            <BarChart data={deviceSessions} format={(value) => `${value} sessions`} />
          </div>
        </section>
      </div>

      <div className="grid cols-2 section">
        <section>
          <h2>Resolutions</h2>
          <div className="card">
            <BarChart data={resolutions} format={(value) => `${value} sessions`} />
          </div>
        </section>
        <section>
          <h2>Video codecs</h2>
          <div className="card">
            <BarChart data={codecs} format={(value) => `${value} sessions`} />
          </div>
        </section>
      </div>

      <section className="section">
        <h2>Bitrate distribution</h2>
        <div className="card">
          <BarChart data={bitrates} format={(value) => `${value} sessions`} />
        </div>
      </section>
    </>
  );
}
