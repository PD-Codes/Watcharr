import Link from 'next/link';
import { BarChart, ColumnChart, DonutChart, Heatmap, StatCard } from '@/components/Charts';
import {
  formatDate,
  formatDuration,
  formatMinutes,
  localizeWeekdays,
  weekdayName,
} from '@/components/format';
import { CastStrip } from '@/components/TitleMeta';
import { Icon } from '@/components/Icons';
import { getTopCast } from '@/server/tmdb';
import { getWrapped, getWrappedYears } from '@/server/wrapped';
import { syncHistory, runInBackground } from '@/server/sync';
import { requireUser } from '@/server/session';
import { resolveView, viewQuery } from '@/server/viewscope';
import ViewSwitch from '@/components/ViewSwitch';
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

export default async function WrappedPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; view?: string; server?: string }>;
}) {
  const session = await requireUser();
  const t = await getT();
  runInBackground(syncHistory(session), 'history sync');

  const params = await searchParams;
  const view = await resolveView(session, params);
  const serverView = view.kind === 'server';
  const years = await getWrappedYears(view.scope);
  const requested = Number(params.year);
  const year = years.includes(requested) ? requested : (years[0] ?? new Date().getFullYear());
  const wrapped = await getWrapped(view.scope, year);
  // Cache-only, like on the statistics page: nothing here waits on TMDB.
  const topCast = await getTopCast(view.scope).catch(() => []);
  // Keeps the chosen view on every link that leads back into this report.
  const here = (extra: Record<string, string | number>) =>
    viewQuery({ kind: view.kind, server: view.servers.length > 1 ? view.server.slug : undefined }, extra);
  // The history and title pages are personal unless told otherwise; the server view links to
  // the server-wide variant where one exists and not at all where none does.
  const titleHref = (label: string) => `/title/${encodeURIComponent(label)}${serverView ? '?scope=server' : ''}`;

  // Index, not label: the server's labels are English, the names shown are translated.
  const topWeekday = wrapped.weekdays.reduce(
    (best, day, index) => (day.value > wrapped.weekdays[best].value ? index : best),
    0,
  );

  return (
    <>
      <div className="wrapped-hero">
        <p className="year">{year}</p>
        <h1>{serverView ? t('wrapped.serverTitle', { server: view.server.label }) : t('wrapped.title')}</h1>
        <p className="subtitle">{serverView ? t('wrapped.serverSubtitle') : t('wrapped.subtitle')}</p>
        {view.canServer && (
          <div className="row" style={{ justifyContent: 'center', marginTop: 20 }}>
            <ViewSwitch view={view} base="/wrapped" extra={{ year }} />
          </div>
        )}
        {years.length > 1 && (
          <div className="row" style={{ justifyContent: 'center', marginTop: 20 }}>
            <div className="seg">
              {years.map((option) => (
                <Link
                  key={option}
                  href={`/wrapped${here({ year: option })}`}
                  className={option === year ? 'on' : undefined}
                >
                  {option}
                </Link>
              ))}
            </div>
          </div>
        )}
        {wrapped.plays > 0 && (
          <div className="row" style={{ justifyContent: 'center', marginTop: 20 }}>
            <Link className="btn" href={`/wrapped/story${here({ year })}`}>
              <Icon name="sparkles" />
              {t('story.playAsStory')}
            </Link>
            <a
              className="btn ghost"
              href={`/api/wrapped/card${here({ year })}`}
              target="_blank"
              rel="noopener"
            >
              <Icon name="share" />
              {t('story.shareCard')}
            </a>
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
              href={serverView ? '/admin/stats?days=365' : '/stats?days=365'}
              info={t('wrapped.watchTimeInfo')}
            />
            <StatCard
              label={t('overview.plays')}
              value={String(wrapped.plays)}
              href={serverView ? undefined : '/history'}
            />
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
                    <Link href={titleHref(wrapped.firstPlay.label)}>
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
                    <Link href={titleHref(wrapped.lastPlay.label)}>
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
                  hrefFor={serverView ? undefined : (label) => `/history?genre=${encodeURIComponent(label)}`}
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
                  href={titleHref(title.label)}
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
                hrefFor={serverView ? undefined : (day) => `/history?date=${day}`}
              />
              <p className="scroll-hint">{t('wrapped.swipe')}</p>
            </div>
          </section>

          <div className="grid cols-2 section">
            <section>
              <h2>{t('wrapped.weekdayCrown', { weekday: weekdayName(topWeekday, t) })}</h2>
              <div className="card">
                <ColumnChart data={localizeWeekdays(wrapped.weekdays, t)} format={formatMinutes} />
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

          {serverView && wrapped.topViewers.length > 0 && (
            <section className="section">
              <h2>{t('wrapped.topViewers', { count: wrapped.viewers })}</h2>
              <div className="card">
                <BarChart data={wrapped.topViewers} format={formatMinutes} />
              </div>
            </section>
          )}

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
