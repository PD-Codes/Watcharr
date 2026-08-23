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

export const dynamic = 'force-dynamic';

export default async function AdminClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  await requireAdmin();
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
      <p className="eyebrow">Admin</p>
      <h1>Client Statistics</h1>
      <p className="subtitle">Which apps and devices people actually use.</p>

      <form className="filters">
        <label>
          Period
          <select name="days" defaultValue={raw ?? '30'}>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="all">All time</option>
          </select>
        </label>
        <button>Apply</button>
      </form>

      <div className="grid cols-4">
        <StatCard label="Total sessions" value={String(totals.sessions)} />
        <StatCard
          label="Unique clients"
          value={String(totals.uniqueClients)}
          info="Different player applications, e.g. the web app or an Android TV client."
        />
        <StatCard label="Unique users" value={String(totals.uniqueUsers)} />
        <StatCard
          label="Unique devices"
          value={String(totals.uniqueDevices)}
          info="Different browsers, phones or TVs reported by the media server."
        />
      </div>

      <div className="grid cols-2 section">
        <section>
          <h2>Sessions per client</h2>
          <div className="card">
            <DonutChart data={sessions.slice(0, 5)} format={(v) => `${v} sessions`} />
          </div>
        </section>
        <section>
          <h2>Watch time per client</h2>
          <div className="card">
            <BarChart data={watchtime} format={formatMinutes} />
          </div>
        </section>
      </div>

      <section className="section">
        <h2>Clients per user</h2>
        <UsageTable rows={perUser} firstColumn="User" />
      </section>

      <section className="section">
        <h2>Clients per device</h2>
        <UsageTable rows={perDevice} firstColumn="Device" />
      </section>
    </>
  );
}

function UsageTable({
  rows,
  firstColumn,
}: {
  rows: { primary: string; secondary: string; sessions: number; watchtimeMs: number; transcodes: number }[];
  firstColumn: string;
}) {
  if (!rows.length) return <p className="muted">No sessions recorded yet.</p>;

  return (
    <div className="table-wrap card">
      <table>
        <thead>
          <tr>
            <th scope="col">{firstColumn}</th>
            <th scope="col">Client</th>
            <th scope="col">Sessions</th>
            <th scope="col">Watch time</th>
            <th scope="col">Transcoded</th>
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
