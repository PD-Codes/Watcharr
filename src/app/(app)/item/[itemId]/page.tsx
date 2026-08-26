import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BarChart, StatCard } from '@/components/Charts';
import { Icon } from '@/components/Icons';
import OpenInServer from '@/components/OpenInServer';
import Poster from '@/components/Poster';
import { Backdrop, CastStrip, Overview, TmdbFacts } from '@/components/TitleMeta';
import { artUrl, formatDate, formatDuration, formatMinutes } from '@/components/format';
import { getSettings } from '@/server/config';
import { getItemDetail, getItemMedia } from '@/server/titles';
import { getTitleMeta } from '@/server/tmdb';
import { adminScope, isAdmin, requireUser } from '@/server/session';
import { getT } from '@/i18n/server';

// No loading.tsx in this segment: streaming pins the status at 200 and this route has to
// be able to answer 404. See the note in CLAUDE.md.
export const dynamic = 'force-dynamic';

/** Bytes as GB/MB — a raw byte count next to a resolution reads as noise. */
function formatBytes(bytes: number): string {
  const mb = bytes / 1_048_576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`;
}

/** One episode or one movie — the level below /title/[label]. */
export default async function ItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ itemId: string }>;
  searchParams: Promise<{ scope?: string }>;
}) {
  const session = await requireUser();
  const t = await getT();
  const itemId = decodeURIComponent((await params).itemId);

  const serverWide = (await searchParams).scope === 'server' && isAdmin(session.user);
  const detail = await getItemDetail(itemId, serverWide ? adminScope(session.user) : { userId: session.user.id });
  if (!detail) notFound();

  // An episode is looked up under its show: TMDB indexes episodes below a series id, which
  // the media server never hands out, and the series artwork is what belongs behind the
  // header anyway.
  const settings = await getSettings();
  const media = await getItemMedia(detail.itemId, session.user.serverId).catch(() => null);
  const meta = await getTitleMeta(
    settings.tmdbApiKey,
    detail.showLabel ?? detail.title,
    detail.showLabel ? 'show' : detail.mediaType,
    detail.year,
  );

  return (
    <>
      <Backdrop url={meta?.backdropUrl} />
      <Link
        className="back-link"
        href={detail.showLabel ? `/title/${encodeURIComponent(detail.showLabel)}` : '/history'}
      >
        <Icon name="back" />
        {detail.showLabel
          ? t('item.backToShow', { label: detail.showLabel })
          : t('item.backToHistory')}
      </Link>

      <div className="title-head">
        <Poster src={artUrl(session.server.slug, detail.itemId)} fallback={meta?.posterUrl} />
        <div>
          {detail.showLabel && <p className="eyebrow">{detail.showLabel}</p>}
          <h1>{detail.title}</h1>
          <p className="subtitle">
            {[detail.year, detail.mediaType].filter(Boolean).join(' · ')}
          </p>
          <TmdbFacts meta={meta} />
          <ul className="chips">
            {detail.genres.map((genre) => (
              <li key={genre}>
                <Link className="badge" href={`/history?genre=${encodeURIComponent(genre)}`}>
                  {genre}
                </Link>
              </li>
            ))}
          </ul>
          {media && (
            /* File facts, not playback facts — the plays below already cover the latter. */
            <ul className="chips">
              {[
                media.height ? `${media.height}p` : null,
                media.videoCodec?.toUpperCase(),
                media.audioCodec?.toUpperCase(),
                media.container?.toUpperCase(),
                media.bitrateKbps ? `${(media.bitrateKbps / 1000).toFixed(1)} Mbps` : null,
                media.fileSizeBytes ? formatBytes(media.fileSizeBytes) : null,
              ]
                .filter((fact): fact is string => Boolean(fact))
                .map((fact) => (
                  <li key={fact}>
                    <span className="badge num">{fact}</span>
                  </li>
                ))}
            </ul>
          )}
          <p className="poster-actions">
            <OpenInServer itemId={detail.itemId} serverId={session.user.serverId} />
          </p>
          <Overview meta={meta} />
        </div>
      </div>

      <div className="grid cols-4">
        <StatCard label={t('title.plays')} value={String(detail.plays)} info={t('item.playsInfo')} />
        <StatCard label={t('common.watchTime')} value={formatDuration(detail.watchtimeMs)} />
        <StatCard label={t('title.firstWatched')} value={detail.firstWatched ? formatDate(detail.firstWatched) : '—'} />
        <StatCard label={t('title.lastWatched')} value={detail.lastWatched ? formatDate(detail.lastWatched) : '—'} />
      </div>

      <CastStrip cast={meta?.cast ?? []} heading={t('title.cast')} />

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

      <section className="section">
        <h2>{t('item.everyPlay')}</h2>
        <div className="table-wrap card">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('common.watched')}</th>
                <th scope="col">{t('common.duration')}</th>
                <th scope="col">{t('common.device')}</th>
              </tr>
            </thead>
            <tbody>
              {detail.plays_list.map((row, index) => (
                <tr key={`${row.watchedAt.getTime()}-${index}`}>
                  <td className="num muted">{formatDate(row.watchedAt)}</td>
                  <td className="num">{formatDuration(row.durationMs)}</td>
                  <td className="muted">{row.deviceName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
