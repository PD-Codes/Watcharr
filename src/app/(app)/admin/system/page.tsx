import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { StatCard } from '@/components/Charts';
import AutoRefresh from '@/components/AutoRefresh';
import { formatDate } from '@/components/format';
import { createAdapter, type ServerType } from '@/server/adapters';
import { listAutoBackups } from '@/server/autobackup';
import { getSettings, listServers } from '@/server/config';
import { requireAdmin } from '@/server/session';
import { getUpdateStatus, RELEASES_PAGE } from '@/server/update';

export const dynamic = 'force-dynamic';

export default async function AdminSystemPage() {
  const session = await requireAdmin();
  const all = await listServers();
  // A server admin only gets to see the server they belong to.
  const servers = session.user.globalAdmin
    ? all
    : all.filter((server) => server.id === session.user.serverId);

  const health = await Promise.all(
    servers.map(async (server) => ({
      server,
      ...(await createAdapter(server.serverType as ServerType, server.serverUrl, server.serverToken)
        .ping()
        .catch(() => ({ ok: false }))),
    })),
  );
  const settings = await getSettings();
  const autoBackups = session.user.globalAdmin ? await listAutoBackups() : [];
  const tmdbConfigured = Boolean(settings.tmdbApiKey);
  const update = await getUpdateStatus(settings);
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
          label="Media servers"
          value={`${health.filter((h) => h.ok).length} / ${health.length} online`}
          href="/admin/servers"
          info="Every connected media server that answered a status request."
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
              <th scope="row">Watcharr version</th>
              <td>
                <span className="num">{update.current}</span>
                {' · '}
                {!update.enabled ? (
                  'update check disabled'
                ) : update.outdated ? (
                  <a href={RELEASES_PAGE} target="_blank" rel="noreferrer noopener">
                    {update.latest} available
                  </a>
                ) : update.latest ? (
                  'up to date'
                ) : (
                  'latest release unknown'
                )}
              </td>
            </tr>
            {health.map((entry) => (
              <tr key={entry.server.id}>
                <th scope="row">{entry.server.label}</th>
                <td>
                  {entry.ok ? 'Online' : 'Unreachable'} · {entry.server.serverType}
                  {'version' in entry && entry.version ? ` ${entry.version}` : ''}
                  <div className="muted" style={{ fontSize: 12 }}>{entry.server.serverUrl}</div>
                </td>
              </tr>
            ))}
            <tr>
              <th scope="row">TMDB enrichment</th>
              <td>{tmdbConfigured ? 'Configured' : 'Not configured'}</td>
            </tr>
            <tr>
              <th scope="row">Last recorded play</th>
              <td>{counts?.last_play ? formatDate(new Date(counts.last_play)) : 'none yet'}</td>
            </tr>
            <tr>
              <th scope="row">Configured since</th>
              <td>{servers[0] ? formatDate(servers[0].createdAt) : '—'}</td>
            </tr>
            {session.user.globalAdmin && (
              <tr>
                <th scope="row">Backup</th>
                <td>
                  <a href="/api/admin/backup">Download a snapshot</a>
                  <div className="muted" style={{ fontSize: 12 }}>
                    Restore by stopping the container and replacing data/watcharr.db —
                    swapping it while the app is running would corrupt the WAL.
                    {settings.backupAutoEnabled
                      ? ` Automatic snapshots every ${settings.backupIntervalHours}h, last ${settings.backupRetention} kept.`
                      : ' Automatic snapshots are off — enable them on Settings.'}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {session.user.globalAdmin && autoBackups.length > 0 && (
        <section className="section">
          <h2>Stored snapshots</h2>
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Size</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {autoBackups.map((file) => (
                  <tr key={file.name}>
                    <td>{file.name}</td>
                    <td>{(file.size / 1024 / 1024).toFixed(1)} MB</td>
                    <td>{formatDate(file.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
