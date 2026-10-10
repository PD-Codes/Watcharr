import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BarChart, ColumnChart, StatCard } from '@/components/Charts';
import { Icon } from '@/components/Icons';
import OpenInServer from '@/components/OpenInServer';
import Poster from '@/components/Poster';
import { Backdrop, CastStrip, Overview, TmdbFacts } from '@/components/TitleMeta';
import { artUrl, formatDate, formatDuration, formatMinutes } from '@/components/format';
import { getSettings } from '@/server/config';
import { getLibrary } from '@/server/library';
import { getTitleDetail } from '@/server/titles';
import type { LibraryItem } from '@/server/adapters/types';
import { getTitleMeta } from '@/server/tmdb';
import { adminScope, isAdmin, requireUser } from '@/server/session';
import { getLocale, getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

export default async function TitlePage({
  params,
  searchParams,
}: {
  params: Promise<{ label: string }>;
  searchParams: Promise<{ scope?: string }>;
}) {
  const session = await requireUser();
  const t = await getT();
  const label = decodeURIComponent((await params).label);

  // Admins can look at a title across the whole server; everyone else sees their own plays.
  const serverWide = (await searchParams).scope === 'server' && isAdmin(session.user);
  const detail = await getTitleDetail(label, serverWide ? adminScope(session.user) : { userId: session.user.id });
  if (!detail) {
    // Not watched yet, but in the library (the ⌘K palette lists library hits): a page about
    // the title instead of a 404. Only from the cached library — an unknown label stays a 404.
    const wanted = label.trim().toLowerCase();
    const item = (await getLibrary(session.user.serverId).catch(() => [])).find(
      (entry) => entry.title.trim().toLowerCase() === wanted,
    );
    if (!item) notFound();
    return <UnwatchedTitle item={item} slug={session.server.slug} serverId={session.user.serverId} />;
  }

  const isShow = detail.distinctItems > 1;
  // Episodes are grouped under their show here, so the lookup is always for the show or the
  // movie — never for a single episode, which TMDB indexes under a different endpoint.
  const settings = await getSettings();
  const meta = await getTitleMeta(
    settings.tmdbApiKey,
    detail.label,
    detail.mediaType === 'episode' ? 'show' : detail.mediaType,
    detail.year,
    await getLocale(),
  );

  return (
    <>
      <Backdrop url={meta?.backdropUrl} />
      <Link className="back-link" href="/stats">
        <Icon name="back" />
        {t('title.backToStats')}
      </Link>

      <div className="title-head">
        <Poster
          src={detail.itemId ? artUrl(session.server.slug, detail.itemId) : undefined}
          fallback={meta?.posterUrl}
        />
        <div>
          <h1>{detail.label}</h1>
          <p className="subtitle">
            {[
              detail.year,
              isShow ? t('title.episodesWatched', { count: detail.distinctItems }) : detail.mediaType,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <TmdbFacts meta={meta} />
          {/* Genres are drill-downs, not decoration: each one filters the history. */}
          <ul className="chips">
            {detail.genres.map((genre) => (
              <li key={genre}>
                <Link className="badge" href={`/history?genre=${encodeURIComponent(genre)}`}>
                  {genre}
                </Link>
              </li>
            ))}
          </ul>
          <p className="chips">
            <OpenInServer itemId={detail.itemId} serverId={session.user.serverId} />
            {isAdmin(session.user) && (
              <Link
                className="badge"
                href={`/title/${encodeURIComponent(detail.label)}${serverWide ? '' : '?scope=server'}`}
              >
                {serverWide ? t('title.showMine') : t('title.showServerWide')}
              </Link>
            )}
          </p>
          <Overview meta={meta} />
        </div>
      </div>

      <div className="grid cols-4">
        <StatCard
          label={t('title.plays')}
          value={String(detail.plays)}
          info={t('title.playsInfo')}
        />
        <StatCard
          label={t('common.watchTime')}
          value={formatDuration(detail.watchtimeMs)}
          info={t('title.watchTimeInfo')}
        />
        <StatCard
          label={t('title.firstWatched')}
          value={detail.firstWatched ? formatDate(detail.firstWatched) : '—'}
        />
        <StatCard
          label={t('title.lastWatched')}
          value={detail.lastWatched ? formatDate(detail.lastWatched) : '—'}
        />
      </div>

      <CastStrip cast={meta?.cast ?? []} heading={t('title.cast')} />

      <section className="section">
        <h2>{t('title.last30Days')}</h2>
        <div className="card">
          <ColumnChart data={detail.daily} format={formatMinutes} labelEvery={3} />
        </div>
      </section>

      <div className="grid cols-2 section">
        <section>
          <h2>{t('title.devices')}</h2>
          <div className="card">
            <BarChart data={detail.devices} format={formatMinutes} />
          </div>
        </section>
        {serverWide && (
          <section>
            <h2>{t('title.viewers')}</h2>
            <div className="card">
              <BarChart data={detail.viewers} format={formatMinutes} />
            </div>
          </section>
        )}
      </div>

      {/* For a show this is the episode list; for a movie it is a single row, so it is
          only worth its own section once there is more than one item. */}
      {detail.episodes.length > 1 && (
        <section className="section">
          <h2>{isShow ? t('title.episodesSection') : t('title.versionsSection')}</h2>
          <div className="card">
            {detail.episodes.map((episode) => (
              <Link
                key={episode.itemId}
                className="episode-row"
                href={`/item/${encodeURIComponent(episode.itemId)}${serverWide ? '?scope=server' : ''}`}
              >
                <span className="ep-title">{episode.title}</span>
                <span className="ep-meta">
                  {episode.plays}× · {formatDuration(episode.watchtimeMs)}
                </span>
                <span className="ep-meta">{formatDate(episode.lastWatched)}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="section">
        <h2>{t('title.recentPlays')}</h2>
        <div className="table-wrap card">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('common.watched')}</th>
                <th scope="col">{t('title.item')}</th>
                <th scope="col">{t('common.duration')}</th>
                <th scope="col">{t('common.device')}</th>
              </tr>
            </thead>
            <tbody>
              {detail.recent.map((row, index) => (
                <tr key={`${row.title}-${index}`}>
                  <td>{formatDate(row.watchedAt)}</td>
                  <td>
                    {/* The single play is a page of its own, so the row leads there
                        instead of repeating the title as plain text. */}
                    <Link
                      href={`/item/${encodeURIComponent(row.itemId)}${serverWide ? '?scope=server' : ''}`}
                    >
                      {row.title}
                    </Link>
                  </td>
                  <td>{formatDuration(row.durationMs)}</td>
                  <td>{row.deviceName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

/** A library title nobody here has played yet: what it is, and where to start it. */
async function UnwatchedTitle({ item, slug, serverId }: { item: LibraryItem; slug: string; serverId: number }) {
  const t = await getT();
  const settings = await getSettings();
  const meta = await getTitleMeta(settings.tmdbApiKey, item.title, item.mediaType, item.year, await getLocale());
  return (
    <>
      <Backdrop url={meta?.backdropUrl} />
      <Link className="back-link" href="/stats">
        <Icon name="back" />
        {t('title.backToStats')}
      </Link>
      <div className="title-head">
        <Poster src={artUrl(slug, item.itemId)} fallback={meta?.posterUrl} />
        <div>
          <h1>{item.title}</h1>
          <p className="subtitle">{[item.year, t('title.notWatchedYet')].filter(Boolean).join(' · ')}</p>
          <TmdbFacts meta={meta} />
          <ul className="chips">
            {item.genres.map((genre) => (
              <li key={genre}>
                <span className="badge">{genre}</span>
              </li>
            ))}
          </ul>
          <p className="chips">
            <OpenInServer itemId={item.itemId} serverId={serverId} />
          </p>
          <Overview meta={meta} />
        </div>
      </div>
      <CastStrip cast={meta?.cast ?? []} heading={t('title.cast')} />
    </>
  );
}
