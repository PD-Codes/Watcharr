import Link from 'next/link';
import { desc, sql } from 'drizzle-orm';
import { db } from '@/db';
import { watchHistory } from '@/db/schema';
import { Icon } from '@/components/Icons';
import TitleLink from '@/components/TitleLink';
import { formatDate, formatDuration, isoDay } from '@/components/format';
import { historyFilters } from '@/server/history';
import { reportSyncError, syncHistory } from '@/server/sync';
import { requireUser } from '@/server/session';
import { getT } from '@/i18n/server';
import type { TranslationKey } from '@/i18n';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

interface Params {
  q?: string;
  type?: string;
  days?: string;
  genre?: string;
  date?: string;
  weekday?: string;
  hour?: string;
  page?: string;
}

// Monday first, matching the weekday index the charts link with.
const WEEKDAY_KEYS: TranslationKey[] = [
  'weekday.monday',
  'weekday.tuesday',
  'weekday.wednesday',
  'weekday.thursday',
  'weekday.friday',
  'weekday.saturday',
  'weekday.sunday',
];

/** Keeps every filter when only one of them changes. */
function withParams(params: Params, patch: Record<string, string | undefined>): string {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...params, ...patch })) {
    if (value) next.set(key, value);
  }
  next.delete('page');
  const query = next.toString();
  return query ? `?${query}` : '?';
}

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const session = await requireUser();
  const t = await getT();
  await syncHistory(session.user, session.serverToken).catch(reportSyncError('history sync'));

  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? 1));
  const where = historyFilters(session.user.id, params);

  const [rows, [count]] = await Promise.all([
    db
      .select()
      .from(watchHistory)
      .where(where)
      .orderBy(desc(watchHistory.watchedAt))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
    db.select({ total: sql<number>`count(*)` }).from(watchHistory).where(where),
  ]);

  const pages = Math.max(1, Math.ceil((count?.total ?? 0) / PAGE_SIZE));
  const periods: [string, string][] = [
    ['', t('common.allTime')],
    ['7', t('common.days', { count: 7 })],
    ['30', t('common.days', { count: 30 })],
    ['365', t('common.lastYear')],
  ];
  // The narrowing filters arrive from a click somewhere else, so they need a way back out.
  const pinned = [
    params.genre ? { key: 'genre', text: t('history.chipGenre', { genre: params.genre }) } : null,
    params.date ? { key: 'date', text: t('history.chipDay', { day: params.date }) } : null,
    params.weekday && WEEKDAY_KEYS[Number(params.weekday)]
      ? { key: 'weekday', text: t(WEEKDAY_KEYS[Number(params.weekday)]) }
      : null,
    params.hour ? { key: 'hour', text: `${String(params.hour).padStart(2, '0')}:00` } : null,
  ].filter((chip): chip is { key: string; text: string } => chip !== null);

  const exportHref = `/api/history/export${withParams(params, { page: undefined })}`;

  return (
    <>
      <p className="eyebrow">{t('history.eyebrow')}</p>
      <h1>{t('nav.history')}</h1>
      <p className="subtitle">{t('history.subtitle', { count: count?.total ?? 0 })}</p>

      <div className="section-head" style={{ marginTop: 0 }}>
        <div className="seg">
          {periods.map(([value, label]) => (
            <Link
              key={label}
              href={withParams(params, { days: value || undefined })}
              className={(params.days ?? '') === value ? 'on' : undefined}
            >
              {label}
            </Link>
          ))}
        </div>
        <a className="link-out" href={exportHref} download>
          <Icon name="download" />
          {t('action.exportCsv')}
        </a>
      </div>

      {pinned.length > 0 && (
        <ul className="chips" style={{ marginBottom: 18 }}>
          {pinned.map((chip) => (
            <li key={chip.key}>
              <Link className="badge on" href={withParams(params, { [chip.key]: undefined })}>
                {chip.text} ✕
              </Link>
            </li>
          ))}
        </ul>
      )}

      <form className="filters">
        {/* Carried through the form so a search does not silently drop a pinned filter. */}
        {params.genre && <input type="hidden" name="genre" value={params.genre} />}
        {params.date && <input type="hidden" name="date" value={params.date} />}
        {params.days && <input type="hidden" name="days" value={params.days} />}
        {params.weekday && <input type="hidden" name="weekday" value={params.weekday} />}
        {params.hour && <input type="hidden" name="hour" value={params.hour} />}
        <label>
          {t('action.search')}
          <input name="q" defaultValue={params.q ?? ''} placeholder={t('history.searchPlaceholder')} />
        </label>
        <label>
          {t('common.type')}
          <select name="type" defaultValue={params.type ?? ''}>
            <option value="">{t('common.all')}</option>
            <option value="movie">{t('common.movies')}</option>
            <option value="episode">{t('common.episodes')}</option>
          </select>
        </label>
        <button>{t('action.apply')}</button>
      </form>

      {rows.length === 0 ? (
        <p className="muted">{t('history.noMatch')}</p>
      ) : (
        <div className="table-wrap card">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('common.watched')}</th>
                <th scope="col">{t('common.title')}</th>
                <th scope="col">{t('common.genres')}</th>
                <th scope="col">{t('common.type')}</th>
                <th scope="col">{t('common.year')}</th>
                <th scope="col">{t('common.duration')}</th>
                <th scope="col">{t('common.device')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="num muted" style={{ whiteSpace: 'nowrap' }}>
                    <Link href={`/history?date=${isoDay(row.watchedAt)}`}>
                      {formatDate(row.watchedAt)}
                    </Link>
                  </td>
                  <td>
                    <TitleLink
                      itemId={row.itemId}
                      title={row.title}
                      grandparentTitle={row.grandparentTitle}
                    />
                  </td>
                  <td className="muted">
                    {row.genres.slice(0, 2).map((genre, index) => (
                      <span key={genre}>
                        {index > 0 && ', '}
                        <Link href={`/history?genre=${encodeURIComponent(genre)}`}>{genre}</Link>
                      </span>
                    ))}
                    {row.genres.length === 0 && '—'}
                  </td>
                  <td className="muted">{row.mediaType}</td>
                  <td className="num muted">{row.year ?? '—'}</td>
                  <td className="num">{formatDuration(row.durationMs)}</td>
                  <td className="muted">{row.deviceName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <p className="row section">
          {page > 1 && (
            <a className="badge" href={`?${new URLSearchParams({ ...params, page: String(page - 1) })}`}>
              {t('action.previous')}
            </a>
          )}
          <span className="muted">{t('common.page', { page, pages })}</span>
          {page < pages && (
            <a className="badge" href={`?${new URLSearchParams({ ...params, page: String(page + 1) })}`}>
              {t('action.next')}
            </a>
          )}
        </p>
      )}
    </>
  );
}
