import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { StatCard } from '@/components/Charts';
import AutoRefresh from '@/components/AutoRefresh';
import { formatDate } from '@/components/format';
import { getAdapter, requireConfig } from '@/server/config';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

export default async function AdminSystemPage() {
  await requireAdmin();
  const config = await requireConfig();

  const health = await (await getAdapter()).ping().catch(() => ({ ok: false }));
  // better-sqlite3 is synchronous, so a failing query throws instead of rejecting.
  let database = true;
  try {
    db.all(sql`SELECT 1`);
  } catch {
    database = false;
  }

  const [counts] = await db.all<{
    history: number;
    sessions: number;
    activity: number;
    last_play: number | null;
  }>(sql`
    SELECT (SELECT count(*) FROM watch_history) AS history,
           (SELECT count(*) FROM playback_sessions) AS sessions,
           (SELECT count(*) FROM playback_sessions WHERE state != 'ended') AS activity,
           (SELECT max(watched_at) FROM watch_history) AS last_play
  `);

  return (
    <>
      <AutoRefresh seconds={30} />
      <p className="eyebrow">Admin</p>
      <h1>System Status</h1>
      <p className="subtitle">Connection and sync health for this deployment.</p>

      <div className="grid cols-4">
        <StatCard
          label="Media server"
          value={health.ok ? 'Online' : 'Unreachable'}
          hint={`${config.serverType} · ${config.serverName ?? config.serverUrl}`}
        />
        <StatCard label="Database" value={database ? 'Online' : 'Unreachable'} />
        <StatCard label="History entries" value={String(counts?.history ?? 0)} />
        <StatCard
          label="Live sessions"
          value={String(counts?.activity ?? 0)}
          hint={`${counts?.sessions ?? 0} recorded in total`}
          info="Sessions currently reported by the media server. Recorded sessions feed the transcoding and client statistics."
        />
      </div>

      <div className="card section">
        <table>
          <tbody>
            <tr>
              <th scope="row">Server URL</th>
              <td>{config.serverUrl}</td>
            </tr>
            <tr>
              <th scope="row">Server version</th>
              <td>{'version' in health ? (health.version ?? 'unknown') : 'unknown'}</td>
            </tr>
            <tr>
              <th scope="row">TMDB enrichment</th>
              <td>{config.tmdbApiKey ? 'Configured' : 'Not configured'}</td>
            </tr>
            <tr>
              <th scope="row">Last recorded play</th>
              <td>{counts?.last_play ? formatDate(new Date(counts.last_play)) : 'none yet'}</td>
            </tr>
            <tr>
              <th scope="row">Configured since</th>
              <td>{formatDate(config.createdAt)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
