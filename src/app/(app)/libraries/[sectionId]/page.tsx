import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Icon } from '@/components/Icons';
import { BarChart, StatCard } from '@/components/Charts';
import Poster from '@/components/Poster';
import { artUrl, formatDate, formatDuration } from '@/components/format';
import { getAdapter } from '@/server/config';
import { getLibrary, getSections } from '@/server/library';
import { cachedPosters } from '@/server/tmdb';
import {
  getLibraryTopTitles,
  getLibraryTotals,
  getLibraryUsers,
} from '@/server/librarystats';
import { adminScope, isAdmin, requireUser } from '@/server/session';
import { getT } from '@/i18n/server';

// No loading.tsx in this segment: it calls notFound(). See the streaming note in CLAUDE.md.
export const dynamic = 'force-dynamic';

const RECENT_LIMIT = 12;
const MEDIA_ROWS = 200;

/** Bytes as GB/MB. A library table full of raw byte counts is unreadable. */
function formatBytes(bytes?: number): string {
  if (!bytes) return '—';
  const mb = bytes / 1_048_576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`;
}

export default async function LibraryDetailPage({
  params,
}: {
  params: Promise<{ sectionId: string }>;
}) {
  const session = await requireUser();
  const t = await getT();
  const { sectionId } = await params;
  const serverId = session.user.serverId;

  const sections = await getSections(serverId).catch(() => []);
  const section = sections.find((s) => s.id === sectionId);
  if (!section) notFound();

  // An admin sees the whole library's usage, everyone else only their own.
  const scope = isAdmin(session.user) ? adminScope(session.user) : { userId: session.user.id };

  const [allTime, day, week, month, users, top, items, recent] = await Promise.all([
    getLibraryTotals(serverId, sectionId, scope),
    getLibraryTotals(serverId, sectionId, scope, 1),
    getLibraryTotals(serverId, sectionId, scope, 7),
    getLibraryTotals(serverId, sectionId, scope, 30),
    getLibraryUsers(serverId, sectionId, scope),
    getLibraryTopTitles(serverId, sectionId, scope),
    getLibrary(serverId).then((all) => all.filter((item) => item.sectionId === sectionId)),
    (await getAdapter(serverId)).getRecentlyAdded(RECENT_LIMIT, sectionId).catch(() => []),
  ]);

  const posters = await cachedPosters(recent);

  return (
    <>
      <p className="eyebrow">
        <Link href="/libraries">{t('nav.libraries')}</Link>
      </p>
      <h1>{section.name}</h1>
      <p className="subtitle">
        {t('library.items', { count: items.length })} ·{' '}
        {section.mediaType === 'movie' ? t('libraries.moviesLower') : t('common.series')}
        {isAdmin(session.user) ? ` · ${t('library.serverWide')}` : ` · ${t('library.yoursOnly')}`}
      </p>

      <div className="grid cols-4">
        <StatCard label={t('library.last24h')} value={String(day.plays)} hint={formatDuration(day.watchtimeMs)} />
        <StatCard label={t('library.last7d')} value={String(week.plays)} hint={formatDuration(week.watchtimeMs)} />
        <StatCard label={t('library.last30d')} value={String(month.plays)} hint={formatDuration(month.watchtimeMs)} />
        <StatCard
          label={t('common.allTime')}
          value={String(allTime.plays)}
          hint={formatDuration(allTime.watchtimeMs)}
          info={t('library.allTimeInfo')}
        />
      </div>

      {allTime.lastTitle && (
        <p className="muted section" style={{ marginTop: 18 }}>
          {t('library.lastPlayed', { title: allTime.lastTitle })}
          {allTime.lastPlayedAt ? ` · ${formatDate(allTime.lastPlayedAt)}` : ''}
        </p>
      )}

      <div className="grid cols-2 section">
        <section>
          <h2>{t('library.mostPlayed')}</h2>
          <div className="card">
            <BarChart
              data={top}
              format={(v) => t('common.plays', { count: v })}
              hrefFor={(label) => `/title/${encodeURIComponent(label)}`}
            />
          </div>
        </section>
        <section>
          <h2>{isAdmin(session.user) ? t('nav.adminUsers') : t('library.yourPlays')}</h2>
          <div className="card">
            <BarChart data={users} format={(v) => t('common.plays', { count: v })} />
          </div>
        </section>
      </div>

      <section className="section">
        <div className="section-head">
          <h2>{t('library.mediaInfo')}</h2>
          <a className="link-out" href={`/api/library/export?sectionId=${encodeURIComponent(sectionId)}`} download>
            <Icon name="download" />
            {t('action.exportCsv')}
          </a>
        </div>
        <p className="muted" style={{ margin: '0 0 14px' }}>
          {t('library.mediaInfoHint')}
        </p>
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('common.title')}</th>
                <th scope="col">{t('common.year')}</th>
                <th scope="col">{t('library.resolution')}</th>
                <th scope="col">{t('library.codec')}</th>
                <th scope="col">{t('library.size')}</th>
                <th scope="col">{t('library.lastPlayedCol')}</th>
              </tr>
            </thead>
            <tbody>
              {items.slice(0, MEDIA_ROWS).map((item) => (
                <tr key={item.itemId}>
                  <td>
                    <Link href={`/title/${encodeURIComponent(item.title)}`}>{item.title}</Link>
                  </td>
                  <td className="num muted">{item.year ?? '—'}</td>
                  <td className="num">{item.height ? `${item.height}p` : '—'}</td>
                  <td className="muted">{item.videoCodec?.toUpperCase() ?? '—'}</td>
                  <td className="num">{formatBytes(item.fileSizeBytes)}</td>
                  <td className="muted">
                    {item.lastPlayedAt ? formatDate(item.lastPlayedAt) : t('common.never')}
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    {t('library.noItems')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {items.length > MEDIA_ROWS && (
          <p className="muted" style={{ marginTop: 12 }}>
            {t('library.showingLimited', { shown: MEDIA_ROWS, total: items.length })}
          </p>
        )}
      </section>

      <section className="section">
        <h2>{t('libraries.recentlyAdded')}</h2>
        {recent.length === 0 ? (
          <p className="muted">{t('library.nothingNew')}</p>
        ) : (
          <div className="poster-grid">
            {recent.map((item) => (
              <div key={item.itemId} className="poster-card">
                <Link href={`/title/${encodeURIComponent(item.title)}`}>
                  <Poster
                    src={artUrl(session.server.slug, item.itemId)}
                    fallback={posters.get(item.itemId)}
                    loading="lazy"
                  />
                  <p className="poster-title">{item.title}</p>
                </Link>
                <p className="poster-meta">{item.year ?? ''}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
