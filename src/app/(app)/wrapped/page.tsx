import Link from 'next/link';
import { BarChart, ColumnChart, DonutChart, Heatmap, StatCard } from '@/components/Charts';
import { formatDate, formatDuration, formatMinutes } from '@/components/format';
import { CastStrip } from '@/components/TitleMeta';
import { getTopCast } from '@/server/tmdb';
import { getWrapped, getWrappedYears } from '@/server/wrapped';
import { reportSyncError, syncHistory } from '@/server/sync';
import { requireUser } from '@/server/session';
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

export default async function WrappedPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>;
}) {
  const session = await requireUser();
  const t = await getT();
  await syncHistory(session.user, session.serverToken).catch(reportSyncError('history sync'));

  const years = await getWrappedYears(session.user.id);
  const requested = Number((await searchParams).year);
  const year = years.includes(requested) ? requested : (years[0] ?? new Date().getFullYear());
  const wrapped = await getWrapped(session.user.id, year);
  // Cache-only, like on the statistics page: nothing here waits on TMDB.
  const topCast = await getTopCast({ userId: session.user.id }).catch(() => []);

  const topWeekday = wrapped.weekdays.reduce(
    (best, day) => (day.value > best.value ? day : best),
    wrapped.weekdays[0],
  );

  return (
    <>
      <div className="wrapped-hero">
        <p className="year">{year}</p>
        <h1>{t('wrapped.title')}</h1>
        <p className="subtitle">{t('wrapped.subtitle')}</p>
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
        <p className="muted">{t('wrapped.nothing', { year })}</p>
      ) : (
        <>
          <div className="grid cols-4">
            <StatCard
              label={t('common.watchTime')}
              value={formatDuration(wrapped.watchtimeMs)}
              href={`/stats?days=365`}
              info={t('wrapped.watchTimeInfo')}
            />
            <StatCard label={t('overview.plays')} value={String(wrapped.plays)} href="/history" />
            <StatCard
              label={t('wrapped.titles')}
              value={String(wrapped.distinctTitles)}
              info={t('wrapped.titlesInfo')}
            />
            <StatCard
              label={t('stats.activeDays')}
              value={String(wrapped.activeDays)}
              hint={t('wrapped.longestStreakHint', { count: wrapped.longestStreak })}
            />
          </div>

          <div className="grid cols-2 section">
            <section>
              <h2>{t('wrapped.firstPlay')}</h2>
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
                  <p className="muted">{t('wrapped.noPlays')}</p>
                )}
              </div>
            </section>
            <section>
              <h2>{t('wrapped.lastPlay')}</h2>
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
                  <p className="muted">{t('wrapped.noPlays')}</p>
                )}
              </div>
            </section>
          </div>

          {wrapped.topGenres[0] && (
            <section className="section">
              <h2>
                {t('wrapped.genreFan', {
                  genre: wrapped.topGenres[0].label,
                  share: wrapped.topGenreShare,
                })}
              </h2>
              <div className="card">
                <BarChart
                  data={wrapped.topGenres}
                  format={(value) => t('common.plays', { count: value })}
                  hrefFor={(label) => `/history?genre=${encodeURIComponent(label)}`}
                />
              </div>
            </section>
          )}

          <section className="section">
            <h2>{t('wrapped.mostPlays')}</h2>
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
                  <span className="muted">{t('common.plays', { count: title.plays })}</span>
                </Link>
              ))}
            </div>
          </section>

          <section className="section">
            <h2>{t('wrapped.yearInDays')}</h2>
            <div className="card">
              <p className="muted" style={{ marginTop: 0 }}>
                {t('wrapped.yearInDaysHint', { count: wrapped.activeDays })}
              </p>
              <Heatmap
                data={wrapped.calendar}
                format={formatMinutes}
                hrefFor={(day) => `/history?date=${day}`}
              />
              <p className="scroll-hint">{t('wrapped.swipe')}</p>
            </div>
          </section>

          <div className="grid cols-2 section">
            <section>
              <h2>{t('wrapped.weekdayCrown', { weekday: topWeekday?.label ?? '' })}</h2>
              <div className="card">
                <ColumnChart data={wrapped.weekdays} format={formatMinutes} />
              </div>
            </section>
            <section>
              <h2>{t('stats.moviesVsEpisodes')}</h2>
              <div className="card">
                <DonutChart
                  data={[
                    { label: t('common.movies'), value: wrapped.movies },
                    { label: t('common.episodes'), value: wrapped.episodes },
                  ]}
                  format={(value) => t('common.plays', { count: value })}
                />
              </div>
            </section>
          </div>

          <CastStrip
            heading={t('cast.topHeading')}
            cast={topCast.map((person) => ({
              ...person,
              character: t('cast.inTitles', { titles: person.titles, plays: person.plays }),
            }))}
          />

          {wrapped.devices.length > 0 && (
            <section className="section">
              <h2>{t('wrapped.whereYouWatched')}</h2>
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
