import { BarChart, DonutChart, StatCard } from '@/components/Charts';
import { formatDuration, formatMinutes } from '@/components/format';
import {
  getClientSessions,
  getClientWatchtime,
  getClientsPerDevice,
  getClientsPerUser,
  getPlaybackTotals,
} from '@/server/playback';
import { requireAdmin } from '@/server/session';
import { getT } from '@/i18n/server';
import type { Translate } from '@/i18n';

export const dynamic = 'force-dynamic';

export default async function AdminClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  await requireAdmin();
  const t = await getT();
  const raw = (await searchParams).days;
  const days = raw === 'all' ? undefined : Number(raw ?? 30);

  const [totals, sessions, watchtime, perUser, perDevice] = await Promise.all([
    getPlaybackTotals(days),
    getClientSessions(days),
    getClientWatchtime(days),
    getClientsPerUser(days),
    getClientsPerDevice(days),
  ]);

  return (
    <>
      <p className="eyebrow">{t('nav.admin')}</p>
      <h1>{t('clients.title')}</h1>
      <p className="subtitle">{t('clients.subtitle')}</p>

      <form className="filters">
        <label>
          {t('serverstats.period')}
          <select name="days" defaultValue={raw ?? '30'}>
            <option value="7">{t('serverstats.last7')}</option>
            <option value="30">{t('serverstats.last30')}</option>
            <option value="90">{t('serverstats.last90')}</option>
            <option value="all">{t('common.allTime')}</option>
          </select>
        </label>
        <button>{t('action.apply')}</button>
      </form>

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

      <section className="section">
        <h2>{t('clients.perUser')}</h2>
        <UsageTable rows={perUser} firstColumn={t('common.user')} t={t} />
      </section>

      <section className="section">
        <h2>{t('clients.perDevice')}</h2>
        <UsageTable rows={perDevice} firstColumn={t('common.device')} t={t} />
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
