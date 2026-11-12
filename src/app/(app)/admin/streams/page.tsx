import Link from 'next/link';
import { Icon } from '@/components/Icons';
import { StatCard } from '@/components/Charts';
import StreamTable from '@/components/StreamTable';
import { firstParam, formatDuration, intParam } from '@/components/format';
import { getPlaybackTotals, listSessionHistory } from '@/server/playback';
import { adminScope, requireAdmin } from '@/server/session';
import { getT } from '@/i18n/server';
import type { Translate } from '@/i18n';
import { PAGE_SIZE } from '@/components/Pager';

export const dynamic = 'force-dynamic';

// Period filters, labelled at render time so the labels follow the request's locale.
const PERIODS: [string, (t: Translate) => string][] = [
  ['all', (t) => t('common.allTime')],
  ['7', (t) => t('common.days', { count: 7 })],
  ['30', (t) => t('common.days', { count: 30 })],
  ['365', (t) => t('common.lastYear')],
];

/**
 * Every stream the server has delivered since Watcharr was installed, with what it was
 * delivered as. The live view answers "what is happening"; this answers "what happened",
 * which is the question a transcode complaint always arrives as.
 */
export default async function AdminStreamsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string | string[]; page?: string | string[]; transcodes?: string }>;
}) {
  const session = await requireAdmin();
  const t = await getT();
  const params = await searchParams;
  // Whitelisted against the period links: a free number would reach the SQL window and the export link.
  // 30 days by default: "all time" counts every stream ever recorded, seconds on a large server.
  const requested = firstParam(params.days) ?? '30';
  const daysValue = PERIODS.some(([value]) => value === requested) ? requested : '30';
  const days = daysValue === 'all' ? undefined : Number(daysValue);
  let page = intParam(params.page, 1);
  const transcodesOnly = params.transcodes === '1';
  const scope = adminScope(session.user);

  const list = (at: number) =>
    listSessionHistory({ scope, days, limit: PAGE_SIZE, offset: (at - 1) * PAGE_SIZE, transcodesOnly });
  const [first, totals] = await Promise.all([list(page), getPlaybackTotals(days, scope)]);

  const pages = Math.max(1, Math.ceil(first.total / PAGE_SIZE));
  // A page past the end (an old link, a narrowed filter) shows the last page, not an empty table.
  let history = first;
  if (page > pages) {
    page = pages;
    history = await list(page);
  }
  const query = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries({
      days: daysValue === '30' ? undefined : daysValue,
      transcodes: transcodesOnly ? '1' : undefined,
      page: undefined as string | undefined,
      ...patch,
    })) {
      if (value) next.set(key, value);
    }
    const search = next.toString();
    return `/admin/streams${search ? `?${search}` : ''}`;
  };

  const exportSearch = new URLSearchParams();
  if (days) exportSearch.set('days', String(days));
  if (transcodesOnly) exportSearch.set('transcodes', '1');

  return (
    <>
      <p className="eyebrow">{t('nav.admin')}</p>
      <h1>{t('nav.adminStreams')}</h1>
      <p className="subtitle">{t('streams.subtitle', { count: history.total })}</p>

      <div className="section-head" style={{ marginTop: 0 }}>
        <div className="seg">
          {PERIODS.map(([value, label]) => (
            <Link
              key={value}
              href={query({ days: value === '30' ? undefined : value })}
              className={daysValue === value ? 'on' : undefined}
            >
              {label(t)}
            </Link>
          ))}
        </div>
        <a
          className="link-out"
          href={`/api/admin/streams/export${exportSearch.toString() ? `?${exportSearch}` : ''}`}
          download
        >
          <Icon name="download" />
          {t('action.exportCsv')}
        </a>
      </div>

      <p className="chips" style={{ marginBottom: 18 }}>
        <Link
          className={`badge ${transcodesOnly ? 'on' : ''}`}
          href={query({ transcodes: transcodesOnly ? undefined : '1' })}
        >
          {t('streams.transcodesOnly')}
        </Link>
      </p>

      <div className="grid cols-4">
        <StatCard label={t('nav.adminStreams')} value={String(totals.sessions)} />
        <StatCard
          label={t('streams.transcodes')}
          value={String(totals.transcodes)}
          hint={totals.sessions ? `${Math.round((totals.transcodes / totals.sessions) * 100)}%` : undefined}
        />
        <StatCard label={t('common.watchTime')} value={formatDuration(totals.watchtimeMs)} />
        <StatCard
          label={t('transcoding.averageBitrate')}
          value={`${(totals.avgBitrateKbps / 1000).toFixed(1)} Mbps`}
          hint={t('streams.peakHint', { value: (totals.maxBitrateKbps / 1000).toFixed(1) })}
        />
      </div>

      <section className="section">
        <div className="card">
          <StreamTable
            rows={history.rows}
            showUser
            showAddress
            emptyLabel={t('streams.empty')}
          />
        </div>
      </section>

      {pages > 1 && (
        <p className="row section">
          {page > 1 && (
            <Link className="badge" href={query({ page: String(page - 1) })}>
              {t('action.previous')}
            </Link>
          )}
          <span className="muted">{t('common.page', { page, pages })}</span>
          {page < pages && (
            <Link className="badge" href={query({ page: String(page + 1) })}>
              {t('action.next')}
            </Link>
          )}
        </p>
      )}
    </>
  );
}
