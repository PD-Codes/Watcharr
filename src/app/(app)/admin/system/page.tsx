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
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

export default async function AdminSystemPage() {
  const session = await requireAdmin();
  const t = await getT();
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
      <p className="eyebrow">{t('nav.admin')}</p>
      <h1>{t('nav.adminSystem')}</h1>
      <p className="subtitle">{t('system.subtitle')}</p>

      <div className="grid cols-4">
        <StatCard
          label={t('system.mediaServers')}
          value={t('system.online', {
            ok: health.filter((h) => h.ok).length,
            total: health.length,
          })}
          href="/admin/servers"
          info={t('system.mediaServersInfo')}
        />
        <StatCard
          label={t('system.database')}
          value={database ? t('system.statusOnline') : t('system.statusUnreachable')}
        />
        <StatCard label={t('system.historyEntries')} value={String(counts?.history ?? 0)} />
        <StatCard
          label={t('system.liveSessions')}
          value={String(counts?.activity ?? 0)}
          hint={t('system.recordedTotal', { count: counts?.sessions ?? 0 })}
          info={t('system.liveSessionsInfo')}
        />
      </div>

      <div className="card section">
        <table>
          <tbody>
            <tr>
              <th scope="row">{t('system.version')}</th>
              <td>
                <span className="num">{update.current}</span>
                {' · '}
                {!update.enabled ? (
                  t('system.updateDisabled')
                ) : update.outdated ? (
                  <a href={RELEASES_PAGE} target="_blank" rel="noreferrer noopener">
                    {t('system.updateAvailable', { version: update.latest ?? '' })}
                  </a>
                ) : update.latest ? (
                  t('system.upToDate')
                ) : (
                  t('system.latestUnknown')
                )}
              </td>
            </tr>
            {health.map((entry) => (
              <tr key={entry.server.id}>
                <th scope="row">{entry.server.label}</th>
                <td>
                  {entry.ok ? t('system.statusOnline') : t('system.statusUnreachable')} ·{' '}
                  {entry.server.serverType}
                  {'version' in entry && entry.version ? ` ${entry.version}` : ''}
                  <div className="muted" style={{ fontSize: 12 }}>{entry.server.serverUrl}</div>
                </td>
              </tr>
            ))}
            <tr>
              <th scope="row">{t('system.tmdb')}</th>
              <td>{tmdbConfigured ? t('system.configured') : t('system.notConfigured')}</td>
            </tr>
            <tr>
              <th scope="row">{t('system.lastPlay')}</th>
              <td>
                {counts?.last_play ? formatDate(new Date(counts.last_play)) : t('system.noneYet')}
              </td>
            </tr>
            <tr>
              <th scope="row">{t('system.configuredSince')}</th>
              <td>{servers[0] ? formatDate(servers[0].createdAt) : '—'}</td>
            </tr>
            {session.user.globalAdmin && (
              <tr>
                <th scope="row">{t('system.backup')}</th>
                <td>
                  <a href="/api/admin/backup">{t('system.downloadSnapshot')}</a>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {t('system.restoreNote')}{' '}
                    {settings.backupAutoEnabled
                      ? t('system.autoSnapshotsOn', {
                          hours: settings.backupIntervalHours,
                          count: settings.backupRetention,
                        })
                      : t('system.autoSnapshotsOff')}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {session.user.globalAdmin && autoBackups.length > 0 && (
        <section className="section">
          <h2>{t('system.storedSnapshots')}</h2>
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('system.file')}</th>
                  <th>{t('system.size')}</th>
                  <th>{t('system.created')}</th>
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
