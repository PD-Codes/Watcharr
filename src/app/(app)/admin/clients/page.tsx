import Link from 'next/link';
import { BarChart, DonutChart, StatCard } from '@/components/Charts';
import Pager, { pageOf } from '@/components/Pager';
import Tabs, { activeTab, type TabDef } from '@/components/Tabs';
import { firstParam, formatDuration, formatMinutes } from '@/components/format';
import {
  countClientsPerDevice,
  countClientsPerUser,
  getClientSessions,
  getClientWatchtime,
  getClientsPerDevice,
  getClientsPerUser,
  getPlaybackTotals,
} from '@/server/playback';
import { adminScope, requireAdmin } from '@/server/session';
import { getT } from '@/i18n/server';
import type { Translate } from '@/i18n';

export const dynamic = 'force-dynamic';

const PERIODS = ['7', '30', '90', 'all'] as const;

export default async function AdminClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string | string[]; tab?: string | string[]; page?: string | string[] }>;
}) {
  const session = await requireAdmin();
  const t = await getT();
  const params = await searchParams;
  const requested = firstParam(params.days);
  // Whitelisted against the period bar; `abc` would be NaN, which `since()` reads as all time.
  const raw = PERIODS.find((period) => period === requested) ?? '30';
  const days = raw === 'all' ? undefined : Number(raw);
  // A server admin only sees their own server's streams, like every other admin page.
  const scope = adminScope(session.user);

  // One table at a time behind tabs: two paged tables on one page would need two page
  // parameters and still push the second one below the fold.
  const TABS: TabDef[] = [
    { key: 'user', label: t('clients.perUser') },
    { key: 'device', label: t('clients.perDevice') },
  ];
  const tab = activeTab(TABS, firstParam(params.tab));
  const perDevice = tab === 'device';

  const [totals, sessions, watchtime, total] = await Promise.all([
    getPlaybackTotals(days, scope),
    getClientSessions(days, scope),
    getClientWatchtime(days, scope),
    perDevice ? countClientsPerDevice(days, scope) : countClientsPerUser(days, scope),
  ]);
  const { page, pages, offset, limit } = pageOf(params.page, total);
  const rows = await (perDevice
    ? getClientsPerDevice(days, scope, limit, offset)
    : getClientsPerUser(days, scope, limit, offset));

  return (
    <>
      <p className="eyebrow">{t('nav.admin')}</p>
      <h1>{t('clients.title')}</h1>
      <p className="subtitle">{t('clients.subtitle')}</p>

      <div className="seg" style={{ marginBottom: 22 }}>
        {PERIODS.map((period) => (
          <Link
            key={period}
            href={`/admin/clients?days=${period}&tab=${tab}`}
            className={raw === period ? 'on' : undefined}
            aria-current={raw === period ? 'true' : undefined}
          >
            {period === 'all' ? t('common.allTime') : t('common.days', { count: Number(period) })}
          </Link>
        ))}
      </div>

      <div className="grid cols-4">
        <StatCard label={t('clients.totalSessions')} value={String(totals.sessions)} />
        <StatCard
          label={t('clients.uniqueClients')}
          value={String(totals.uniqueClients)}
          info={t('clients.uniqueClientsInfo')}
        />
        <StatCard label={t('clients.uniqueUsers')} value={String(totals.uniqueUsers)} />
        <StatCard
          label={t('clients.uniqueDevices')}
          value={String(totals.uniqueDevices)}
          info={t('clients.uniqueDevicesInfo')}
        />
      </div>

      <div className="grid cols-2 section">
        <section>
          <h2>{t('clients.sessionsPerClient')}</h2>
          <div className="card">
            <DonutChart
              data={sessions.slice(0, 5)}
              format={(v) => t('common.sessions', { count: v })}
            />
          </div>
        </section>
        <section>
          <h2>{t('clients.watchTimePerClient')}</h2>
          <div className="card">
            <BarChart data={watchtime} format={formatMinutes} />
          </div>
        </section>
      </div>

      <section className="section" id="usage">
        <Tabs
          tabs={TABS}
          current={tab}
          hrefFor={(key) => `/admin/clients?days=${raw}&tab=${key}#usage`}
        />
        <UsageTable
          rows={rows}
          firstColumn={perDevice ? t('common.device') : t('common.user')}
          t={t}
        />
        <Pager page={page} pages={pages} params={{ days: raw, tab }} hash="usage" />
      </section>
    </>
  );
}

function UsageTable({
  rows,
  firstColumn,
  t,
}: {
  rows: { primary: string; secondary: string; sessions: number; watchtimeMs: number; transcodes: number }[];
  firstColumn: string;
  t: Translate;
}) {
  if (!rows.length) return <p className="muted">{t('clients.empty')}</p>;

  return (
    <div className="table-wrap card">
      <table>
        <thead>
          <tr>
            <th scope="col">{firstColumn}</th>
            <th scope="col">{t('activity.client')}</th>
            <th scope="col">{t('clients.colSessions')}</th>
            <th scope="col">{t('common.watchTime')}</th>
            <th scope="col">{t('clients.colTranscoded')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.primary}-${row.secondary}`}>
              <td>{row.primary}</td>
              <td>{row.secondary}</td>
              <td>{row.sessions}</td>
              <td>{formatDuration(row.watchtimeMs)}</td>
              <td>{row.transcodes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
